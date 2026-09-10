import { describe, expect, it } from "vitest";
// @ts-expect-error - node:sqlite runtime types ship with Node 22.13+, not @types/node
import { DatabaseSync } from "node:sqlite";
import type { DrivePayloadPart, DriveRequestRow } from "@eliotr/contracts";
import { parseRequestCells } from "./contribution.js";
import { contributionFixture, exchangeFixture } from "./drive-test-fixture.js";
import { DriveReconcileError } from "./cursor.js";
import { createD1DriveCursorRepository, createD1DriveObservationRepository, type DriveReconcilerD1 } from "./reconciler-store.js";
import { createDriveReconciler, type ContributionIntentPort, type FrozenTransportEnvelopePort } from "./reconciler.js";
import type { DriveChangePage, GoogleDrivePort } from "./port.js";
import { serializeAtomicContribution } from "./serializer.js";

declare global {
  interface ImportMeta {
    glob(pattern: string, options: { eager: true; query: string; import: string }): Record<string, string>;
  }
}

// Committed Core migration stream is the only schema authority; no in-test DDL.
const CORE_MIGRATIONS = import.meta.glob("../../../infra/d1/core/migrations/*.sql", {
  eager: true, query: "?raw", import: "default",
});

interface RawStatement {
  get(...args: unknown[]): unknown;
  all(...args: unknown[]): unknown[];
  run(...args: unknown[]): { changes?: unknown };
}
interface RawDatabase {
  prepare(sql: string): RawStatement;
  exec(sql: string): void;
}
function spread(params: readonly unknown[]): never[] {
  return params as never[];
}
function makeD1(database: RawDatabase): DriveReconcilerD1 {
  return {
    prepare: (sql: string) => ({
      bind: (...params: unknown[]) => ({
        async first<T>() {
          const row = (params.length === 0 ? database.prepare(sql).get() : database.prepare(sql).get(...spread(params))) as T | undefined;
          return (row ?? null) as T | null;
        },
        async all<T>() {
          const rows = (params.length === 0 ? database.prepare(sql).all() : database.prepare(sql).all(...spread(params))) as unknown as T[];
          return { results: rows };
        },
        async run() {
          if (params.length === 0) database.prepare(sql).run();
          else database.prepare(sql).run(...spread(params));
          return {};
        },
      }),
    }),
  };
}

async function shaHex(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text);
  const copy = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(copy).set(bytes);
  const digest = await crypto.subtle.digest("SHA-256", copy);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

const NOW = Date.parse("2026-09-05T12:00:00Z");
const ISO_NOW = new Date(NOW).toISOString();
const GENERATION = exchangeFixture();

function setupDatabase(): RawDatabase {
  const database = new DatabaseSync(":memory:") as RawDatabase;
  for (const key of Object.keys(CORE_MIGRATIONS).sort()) {
    database.exec(CORE_MIGRATIONS[key] as string);
  }
  const blob = new Uint8Array([9, 9, 9]);
  database.prepare(`INSERT INTO google_exchange_connection
    (connection_id, google_subject, google_email, scopes_json, encrypted_refresh_token, token_nonce,
      token_key_version, state, created_at, updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?)`).run(GENERATION.connection_id, "google-subject-1", "exchange@example.com",
    `["https://www.googleapis.com/auth/drive.file"]`, blob, new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]),
    1, "ACTIVE", ISO_NOW, ISO_NOW);
  database.prepare(`INSERT INTO exchange_generation
    (generation_id, connection_id, folder_id, spreadsheet_id, sheet_ids_json, protocol_version, state, created_at, retired_at)
    VALUES (?,?,?,?,?,?,?,?,?)`).run(GENERATION.generation_id, GENERATION.connection_id, GENERATION.folder_id,
    GENERATION.spreadsheet_id, JSON.stringify(GENERATION.sheet_ids), GENERATION.protocol_version, "active", ISO_NOW, null);
  return database;
}

function seedCursor(database: RawDatabase, token: string, extents: Record<string, number>,
  lease: { owner: string; until: number } | null = null): void {
  database.prepare(`INSERT INTO drive_cursor
    (connection_id, start_page_token, last_grid_extent_json, consecutive_failures, lease_owner, lease_until, updated_at)
    VALUES (?,?,?,?,?,?,?)`).run(GENERATION.connection_id, token, JSON.stringify(extents), 0,
    lease?.owner ?? null, lease?.until ?? null, ISO_NOW);
}

interface CursorReadback {
  start_page_token: string;
  last_grid_extent_json: string;
  consecutive_failures: number;
  lease_owner: string | null;
  lease_until: number | null;
}
function readCursor(database: RawDatabase): CursorReadback {
  return database.prepare(`SELECT start_page_token, last_grid_extent_json, consecutive_failures,
    lease_owner, lease_until FROM drive_cursor WHERE connection_id=?`)
    .get(GENERATION.connection_id) as CursorReadback;
}
function countObservations(database: RawDatabase, disposition?: string): number {
  const row = (disposition === undefined
    ? database.prepare(`SELECT COUNT(*) AS n FROM drive_observation`).get()
    : database.prepare(`SELECT COUNT(*) AS n FROM drive_observation WHERE disposition=?`).get(disposition)) as { n: number };
  return row.n;
}

/** Raw cell matrix per tab, header included at index 0. Row numbers are 1-indexed positions. */
interface SheetData {
  REQUESTS: unknown[][];
  PAYLOAD_PARTS: unknown[][];
}
function headerSheets(): SheetData {
  return { REQUESTS: [Array(16).fill("")], PAYLOAD_PARTS: [Array(5).fill("")] };
}

class FakeDrive implements GoogleDrivePort {
  listChangesCalls = 0;
  readRangesCalls = 0;
  constructor(
    public sheets: SheetData,
    public pages: DriveChangePage[],
    public fallbackToken: string,
  ) {}
  async getStartPageToken(): Promise<string> { throw new Error("unused"); }
  async listChanges(_pageToken: string): Promise<DriveChangePage> {
    this.listChangesCalls += 1;
    return this.pages.shift() ?? { changes: [], newStartPageToken: this.fallbackToken };
  }
  async readSheetRanges(_spreadsheetId: string, ranges: string[]): Promise<{ range: string; values: readonly (readonly unknown[])[] }[]> {
    this.readRangesCalls += 1;
    return ranges.map((range) => {
      const match = /^'([A-Z_]+)'!A(\d+):[A-Z](\d+)$/u.exec(range);
      if (!match) throw new Error(`unexpected range ${range}`);
      const tab = (match[1] === "REQUESTS" ? "REQUESTS" : "PAYLOAD_PARTS") as keyof SheetData;
      const from = Number(match[2]);
      const end = Number(match[3]);
      return { range, values: this.sheets[tab].slice(from - 1, end - 1) };
    });
  }
  async batchUpdateSheet(): Promise<never> { throw new Error("unused"); }
  async createResultDocument(): Promise<never> { throw new Error("unused"); }
  async exportDocument(): Promise<never> { throw new Error("unused"); }
  async getFileMetadata(): Promise<never> { throw new Error("unused"); }
}

class FakeFrozen implements FrozenTransportEnvelopePort {
  freezeCalls = 0;
  readonly objects = new Map<string, { sha256: string; canonical_utf8: string }>();
  async freeze(input: { generation_id: string; object_kind: "request" | "payload"; object_id: string; canonical_utf8: string }): Promise<{ object_ref: string; sha256: string }> {
    this.freezeCalls += 1;
    const sha256 = await shaHex(input.canonical_utf8);
    const object_ref = `r2://frozen/${input.generation_id}/${input.object_kind}/${input.object_id}`;
    this.objects.set(object_ref, { sha256, canonical_utf8: input.canonical_utf8 });
    return { object_ref, sha256 };
  }
  async readFrozen(objectRef: string): Promise<{ sha256: string; canonical_utf8: string } | null> {
    return this.objects.get(objectRef) ?? null;
  }
}

class FakeIntents implements ContributionIntentPort {
  admitCalls = 0;
  private readonly admitted = new Map<string, string>();
  seedAdmitted(idempotencyKey: string, requestId: string): void {
    this.admitted.set(idempotencyKey, requestId);
  }
  async admitFrozenEnvelope(input: { generation_id: string; request_id: string; idempotency_key: string; frozen_object_ref: string; sha256: string }): Promise<"ADMITTED" | "DUPLICATE" | "REJECTED"> {
    this.admitCalls += 1;
    if (this.admitted.has(input.idempotency_key)) return "DUPLICATE";
    this.admitted.set(input.idempotency_key, input.request_id);
    return "ADMITTED";
  }
}

function requestCells(request: DriveRequestRow, parts: DrivePayloadPart[] = []): { request: unknown[]; parts: unknown[][] } {
  const batch = serializeAtomicContribution(GENERATION, request, parts);
  const cells = (index: number): unknown[] => batch[index]?.appendCells.rows[0]?.values
    .map(({ userEnteredValue: value }) => value.stringValue ?? value.numberValue) ?? [];
  return { request: cells(0), parts: batch.slice(1).map((_, slot) => cells(slot + 1)) };
}

function chunkedRequest(requestId: string, intentId: string, payloadId: string, partCount: number): DriveRequestRow {
  return { ...contributionFixture(), request_id: requestId, idempotency_key: intentId,
    body_encoding: "chunked_utf8", inline_body: "", payload_id: payloadId, part_count: partCount };
}
function partCells(payloadId: string, index: number, count: number, text: string): DrivePayloadPart {
  return { payload_id: payloadId, part_index: index, part_count: count, utf8_text: text, created_at: ISO_NOW };
}

async function expectCode(promise: Promise<unknown>, code: string): Promise<void> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(DriveReconcileError);
    expect((error as DriveReconcileError).code).toBe(code);
    return;
  }
  throw new Error(`expected rejection with ${code}`);
}

describe("ER-19 durable Drive cursor reconciliation over real D1", () => {
  it("imports a new contribution and advances the durable cursor", async () => {
    const database = setupDatabase();
    seedCursor(database, "token-0", { requests: 2, payload_parts: 2 });
    const { request } = requestCells(contributionFixture());
    const drive = new FakeDrive({ ...headerSheets(), REQUESTS: [Array(16).fill(""), request] },
      [{ changes: [{ fileId: GENERATION.spreadsheet_id, removed: false, modifiedTime: ISO_NOW }], newStartPageToken: "token-1" }], "token-1");
    const frozen = new FakeFrozen();
    const intents = new FakeIntents();
    const now = NOW;
    const reconciler = createDriveReconciler({ drive,
      cursors: createD1DriveCursorRepository(makeD1(database)),
      observations: createD1DriveObservationRepository(makeD1(database)),
      frozenEnvelopes: frozen, contributionIntents: intents }, () => now);

    expect(await reconciler.poll(GENERATION, "poller-1", NOW)).toEqual({ imported: 1, duplicates: 0, tampered: 0, incomplete: 0 });
    expect(frozen.freezeCalls).toBe(1);
    expect(intents.admitCalls).toBe(1);
    expect(countObservations(database, "IMPORTED")).toBe(1);
    const cursor = readCursor(database);
    expect(cursor.start_page_token).toBe("token-1");
    expect(JSON.parse(cursor.last_grid_extent_json)).toEqual({ requests: 3, payload_parts: 2 });
    expect(cursor.consecutive_failures).toBe(0);
    expect(cursor.lease_owner).toBeNull();
  });

  it("recognises a resumed poll as duplicate without re-freezing or re-admitting", async () => {
    const database = setupDatabase();
    seedCursor(database, "token-0", { requests: 2, payload_parts: 2 });
    const { request } = requestCells(contributionFixture());
    const canonical = JSON.stringify(parseRequestCells(request));
    const digest = await shaHex(canonical);
    const observations = createD1DriveObservationRepository(makeD1(database));
    // A previous poll admitted and recorded, but its cursor commit was lost.
    expect(await observations.insertFrozenObservation({ generation_id: GENERATION.generation_id,
      object_kind: "request", object_id: "request-1", idempotency_key: "intent-1",
      content_sha256: digest, observed_row: 2, drive_modified_time: ISO_NOW,
      actor_claim: "chatgpt-web", frozen_r2_key: "r2://frozen/exchange-1/request/request-1",
      imported_at: ISO_NOW })).toBe("IMPORTED");
    const drive = new FakeDrive({ ...headerSheets(), REQUESTS: [Array(16).fill(""), request] },
      [{ changes: [{ fileId: GENERATION.spreadsheet_id, removed: false, modifiedTime: ISO_NOW }], newStartPageToken: "token-1" }], "token-1");
    const frozen = new FakeFrozen();
    const intents = new FakeIntents();
    const reconciler = createDriveReconciler({ drive,
      cursors: createD1DriveCursorRepository(makeD1(database)), observations,
      frozenEnvelopes: frozen, contributionIntents: intents }, () => NOW);

    expect(await reconciler.poll(GENERATION, "poller-1", NOW)).toEqual({ imported: 0, duplicates: 1, tampered: 0, incomplete: 0 });
    expect(frozen.freezeCalls).toBe(0);
    expect(intents.admitCalls).toBe(0);
    expect(countObservations(database)).toBe(1);
    expect(readCursor(database).start_page_token).toBe("token-1");
  });

  it("reconciles an admitted-but-unrecorded contribution as duplicate after an interrupted poll", async () => {
    const database = setupDatabase();
    seedCursor(database, "token-0", { requests: 2, payload_parts: 2 });
    const { request } = requestCells(contributionFixture());
    const drive = new FakeDrive({ ...headerSheets(), REQUESTS: [Array(16).fill(""), request] },
      [{ changes: [{ fileId: GENERATION.spreadsheet_id, removed: false, modifiedTime: ISO_NOW }], newStartPageToken: "token-1" }], "token-1");
    const frozen = new FakeFrozen();
    const intents = new FakeIntents();
    // Previous poll admitted, then crashed before recording the observation.
    intents.seedAdmitted("intent-1", "request-1");
    const reconciler = createDriveReconciler({ drive,
      cursors: createD1DriveCursorRepository(makeD1(database)),
      observations: createD1DriveObservationRepository(makeD1(database)),
      frozenEnvelopes: frozen, contributionIntents: intents }, () => NOW);

    expect(await reconciler.poll(GENERATION, "poller-1", NOW)).toEqual({ imported: 0, duplicates: 1, tampered: 0, incomplete: 0 });
    expect(intents.admitCalls).toBe(1);
    expect(countObservations(database, "IMPORTED")).toBe(1);
    expect(readCursor(database).start_page_token).toBe("token-1");
  });

  it("does not advance the cursor past a contribution with missing payload parts", async () => {
    const database = setupDatabase();
    seedCursor(database, "token-0", { requests: 2, payload_parts: 2 });
    const request = chunkedRequest("request-9", "intent-9", "payload-9", 2);
    const full = requestCells(request, [partCells("payload-9", 0, 2, "half-a"), partCells("payload-9", 1, 2, "half-b")]);
    // The second part row never arrived: the sheet holds the request plus one part.
    const drive = new FakeDrive(
      { REQUESTS: [Array(16).fill(""), full.request], PAYLOAD_PARTS: [Array(5).fill(""), full.parts[0] as unknown[]] },
      [{ changes: [{ fileId: GENERATION.spreadsheet_id, removed: false, modifiedTime: ISO_NOW }], newStartPageToken: "token-1" }], "token-1");
    const frozen = new FakeFrozen();
    const intents = new FakeIntents();
    const reconciler = createDriveReconciler({ drive,
      cursors: createD1DriveCursorRepository(makeD1(database)),
      observations: createD1DriveObservationRepository(makeD1(database)),
      frozenEnvelopes: frozen, contributionIntents: intents }, () => NOW);

    expect(await reconciler.poll(GENERATION, "poller-1", NOW)).toEqual({ imported: 0, duplicates: 0, tampered: 0, incomplete: 1 });
    expect(intents.admitCalls).toBe(0);
    expect(countObservations(database)).toBe(0);
    const cursor = readCursor(database);
    expect(cursor.start_page_token).toBe("token-0");
    expect(JSON.parse(cursor.last_grid_extent_json)).toEqual({ requests: 2, payload_parts: 2 });
    expect(cursor.consecutive_failures).toBe(1);
    expect(cursor.lease_owner).toBeNull();
  });

  it("refuses a held lease before any Drive read and rejects bad poll input", async () => {
    const database = setupDatabase();
    seedCursor(database, "token-0", { requests: 2, payload_parts: 2 }, { owner: "poller-other", until: NOW + 60000 });
    const drive = new FakeDrive(headerSheets(), [], "token-0");
    const reconciler = createDriveReconciler({ drive,
      cursors: createD1DriveCursorRepository(makeD1(database)),
      observations: createD1DriveObservationRepository(makeD1(database)),
      frozenEnvelopes: new FakeFrozen(), contributionIntents: new FakeIntents() }, () => NOW);

    await expectCode(reconciler.poll(GENERATION, "poller-1", NOW), "DRIVE_LEASE_HELD");
    expect(drive.listChangesCalls).toBe(0);
    expect(readCursor(database).start_page_token).toBe("token-0");
    await expectCode(reconciler.poll(GENERATION, "", NOW), "DRIVE_OWNER_INVALID");
    await expectCode(reconciler.poll({ ...GENERATION, status: "retired" }, "poller-1", NOW), "EXCHANGE_GENERATION_NOT_ACTIVE");
    // The store guard rejects a commit from a poller that no longer holds the lease.
    const cursors = createD1DriveCursorRepository(makeD1(database));
    await expectCode(cursors.persistAfterCommit(GENERATION.connection_id, "token-9", { requests: 2, payload_parts: 2 }, "poller-1", NOW),
      "DRIVE_LEASE_EXPIRED");
    expect(readCursor(database).start_page_token).toBe("token-0");
  });

  it("cannot commit after the lease TTL outruns the poll", async () => {
    const database = setupDatabase();
    seedCursor(database, "token-0", { requests: 2, payload_parts: 2 });
    const { request } = requestCells(contributionFixture());
    const drive = new FakeDrive({ ...headerSheets(), REQUESTS: [Array(16).fill(""), request] },
      [{ changes: [{ fileId: GENERATION.spreadsheet_id, removed: false, modifiedTime: ISO_NOW }], newStartPageToken: "token-1" }], "token-1");
    let now = NOW;
    const reconciler = createDriveReconciler({ drive,
      cursors: createD1DriveCursorRepository(makeD1(database)),
      observations: createD1DriveObservationRepository(makeD1(database)),
      frozenEnvelopes: new FakeFrozen(), contributionIntents: new FakeIntents() }, () => now);

    now = NOW + 120_000;
    await expectCode(reconciler.poll(GENERATION, "poller-1", NOW), "DRIVE_LEASE_EXPIRED");
    const cursor = readCursor(database);
    expect(cursor.start_page_token).toBe("token-0");
    expect(JSON.parse(cursor.last_grid_extent_json)).toEqual({ requests: 2, payload_parts: 2 });
  });

  it("marks an edited replay as tampered without re-freezing, keeping the frozen authority", async () => {
    const database = setupDatabase();
    seedCursor(database, "token-1", { requests: 2, payload_parts: 2 });
    const original = requestCells(contributionFixture());
    const canonical = JSON.stringify(parseRequestCells(original.request));
    const digest = await shaHex(canonical);
    const frozenRef = "r2://frozen/exchange-1/request/request-1";
    const observations = createD1DriveObservationRepository(makeD1(database));
    expect(await observations.insertFrozenObservation({ generation_id: GENERATION.generation_id,
      object_kind: "request", object_id: "request-1", idempotency_key: "intent-1",
      content_sha256: digest, observed_row: 2, drive_modified_time: ISO_NOW,
      actor_claim: "chatgpt-web", frozen_r2_key: frozenRef, imported_at: ISO_NOW })).toBe("IMPORTED");
    const edited = [...original.request];
    edited[9] = `{"question":"edited after admission"}`;
    const drive = new FakeDrive({ ...headerSheets(), REQUESTS: [Array(16).fill(""), edited] },
      [{ changes: [{ fileId: GENERATION.spreadsheet_id, removed: false, modifiedTime: ISO_NOW }], newStartPageToken: "token-2" }], "token-2");
    const frozen = new FakeFrozen();
    frozen.objects.set(frozenRef, { sha256: digest, canonical_utf8: canonical });
    const intents = new FakeIntents();
    const reconciler = createDriveReconciler({ drive,
      cursors: createD1DriveCursorRepository(makeD1(database)), observations,
      frozenEnvelopes: frozen, contributionIntents: intents }, () => NOW);

    expect(await reconciler.poll(GENERATION, "poller-1", NOW)).toEqual({ imported: 0, duplicates: 0, tampered: 1, incomplete: 0 });
    expect(frozen.freezeCalls).toBe(0);
    expect(intents.admitCalls).toBe(0);
    expect(frozen.objects.get(frozenRef)).toEqual({ sha256: digest, canonical_utf8: canonical });
    expect(countObservations(database, "TRANSPORT_TAMPERED")).toBe(1);
    expect(countObservations(database, "IMPORTED")).toBe(1);
  });

  it("audits an edited row as tampered by digest against the frozen envelope", async () => {
    const database = setupDatabase();
    seedCursor(database, "token-1", { requests: 3, payload_parts: 2 });
    const original = requestCells(contributionFixture());
    const canonical = JSON.stringify(parseRequestCells(original.request));
    const digest = await shaHex(canonical);
    const frozenRef = "r2://frozen/exchange-1/request/request-1";
    const observations = createD1DriveObservationRepository(makeD1(database));
    await observations.insertFrozenObservation({ generation_id: GENERATION.generation_id,
      object_kind: "request", object_id: "request-1", idempotency_key: "intent-1",
      content_sha256: digest, observed_row: 2, drive_modified_time: ISO_NOW,
      actor_claim: "chatgpt-web", frozen_r2_key: frozenRef, imported_at: ISO_NOW });
    const edited = [...original.request];
    edited[9] = `{"question":"edited after admission"}`;
    const drive = new FakeDrive({ ...headerSheets(), REQUESTS: [Array(16).fill(""), edited] }, [], "token-1");
    const frozen = new FakeFrozen();
    frozen.objects.set(frozenRef, { sha256: digest, canonical_utf8: canonical });
    const reconciler = createDriveReconciler({ drive,
      cursors: createD1DriveCursorRepository(makeD1(database)), observations,
      frozenEnvelopes: frozen, contributionIntents: new FakeIntents() }, () => NOW);

    expect(await reconciler.auditHistoricalRows(GENERATION)).toEqual({ checked: 1, tampered: 1, missing: 0 });
    expect(countObservations(database)).toBe(1);
  });

  it("reports a deleted row as missing rather than tampered", async () => {
    const database = setupDatabase();
    seedCursor(database, "token-1", { requests: 3, payload_parts: 2 });
    const original = requestCells(contributionFixture());
    const canonical = JSON.stringify(parseRequestCells(original.request));
    const digest = await shaHex(canonical);
    const frozenRef = "r2://frozen/exchange-1/request/request-1";
    const observations = createD1DriveObservationRepository(makeD1(database));
    await observations.insertFrozenObservation({ generation_id: GENERATION.generation_id,
      object_kind: "request", object_id: "request-1", idempotency_key: "intent-1",
      content_sha256: digest, observed_row: 2, drive_modified_time: ISO_NOW,
      actor_claim: "chatgpt-web", frozen_r2_key: frozenRef, imported_at: ISO_NOW });
    const drive = new FakeDrive(headerSheets(), [], "token-1");
    const frozen = new FakeFrozen();
    frozen.objects.set(frozenRef, { sha256: digest, canonical_utf8: canonical });
    const reconciler = createDriveReconciler({ drive,
      cursors: createD1DriveCursorRepository(makeD1(database)), observations,
      frozenEnvelopes: frozen, contributionIntents: new FakeIntents() }, () => NOW);

    expect(await reconciler.auditHistoricalRows(GENERATION)).toEqual({ checked: 1, tampered: 0, missing: 1 });
  });

  it("detects a lost notification plus an edited row with no duplicate work", async () => {
    const database = setupDatabase();
    seedCursor(database, "token-0", { requests: 2, payload_parts: 2 });
    const built = requestCells(contributionFixture());
    const sheets: SheetData = { ...headerSheets(), REQUESTS: [Array(16).fill(""), built.request] };
    const drive = new FakeDrive(sheets,
      [{ changes: [{ fileId: GENERATION.spreadsheet_id, removed: false, modifiedTime: ISO_NOW }], newStartPageToken: "token-1" }], "token-1");
    const frozen = new FakeFrozen();
    const intents = new FakeIntents();
    const d1 = makeD1(database);
    const reconciler = createDriveReconciler({ drive,
      cursors: createD1DriveCursorRepository(d1),
      observations: createD1DriveObservationRepository(d1),
      frozenEnvelopes: frozen, contributionIntents: intents }, () => NOW);

    expect(await reconciler.poll(GENERATION, "poller-1", NOW)).toEqual({ imported: 1, duplicates: 0, tampered: 0, incomplete: 0 });
    expect(readCursor(database).start_page_token).toBe("token-1");

    // The notification for the next change is lost and the admitted row is edited.
    const edited = [...built.request];
    edited[9] = `{"question":"edited while the notification was lost"}`;
    sheets.REQUESTS = [Array(16).fill(""), edited];
    drive.pages.length = 0;
    drive.fallbackToken = "token-1";
    const freezeCalls = frozen.freezeCalls;
    const admitCalls = intents.admitCalls;

    // Replay from the committed cursor sees an unchanged token with no relevant
    // change: zero counts and no re-admission effect.
    expect(await reconciler.poll(GENERATION, "poller-1", NOW)).toEqual({ imported: 0, duplicates: 0, tampered: 0, incomplete: 0 });
    expect(frozen.freezeCalls).toBe(freezeCalls);
    expect(intents.admitCalls).toBe(admitCalls);

    // The daily audit still detects the edit by digest against the frozen envelope.
    expect(await reconciler.auditHistoricalRows(GENERATION)).toEqual({ checked: 1, tampered: 1, missing: 0 });
  });
});
