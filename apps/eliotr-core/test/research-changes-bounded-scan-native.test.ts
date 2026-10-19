import { beforeEach, describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { reset } from "cloudflare:test";
import { createResearchChangesService } from "@eliotr/cloudflare-research-runtime/research-changes.js";
import { CatalogInputError } from "@eliotr/cloudflare-navigation";
import type {
  AuthenticatedRequestContext,
  ResearchChangeItem,
  ResearchChangeKind,
  ResearchChangesRequest,
} from "@eliotr/interfaces";

// ER-45 / issue #301: actual-D1 regressions for the bounded raw-candidate scan
// and the confidential v2 continuation. Every table below is synthetic and is
// created by this file inside the isolated test D1 storage, so no production
// schema, migration, authority or deployed database is read or modified.
//
// Hidden raw candidates are produced without caller-authored authority: an
// ERASURE_COMPLETED row is never returned while this file supplies no erasure
// authorizer port, and a scope-visible row is hidden by the controlled
// historical-scope port. The recent run-list backfill fixture supplies the
// native statement-counting pattern; the original statements pass through here
// unmodified so the candidate SQL keeps its real shape.

const bindings = env as unknown as { CORE_DB: D1Database };
const db = bindings.CORE_DB;
const PRINCIPAL = "scan-native-owner";
const CREDENTIAL = "scan-native-credential";
const DEPLOYMENT = "scan-native-generation";
const CURSOR_KEY = "A".repeat(43);
const NOW_MS = Date.parse("2026-10-13T00:00:00.000Z");
const OCCURRED_AT = "2026-10-13T00:00:00.000Z";
const DIGEST = "a".repeat(64);
const SCOPE = { id: "scan-native-scope", revision: 1 } as const;
const HIDDEN_KIND = "ERASURE_COMPLETED";
const VISIBLE_KIND = "SOURCE_UPDATED";
const SCOPED_KIND = "ARTIFACT_DRAFTED";
const SCAN_SEALED_BYTES = 1 + 12 + 2560 + 16;

interface Counters {
  candidate: number;
  grant: number;
  anchor: number;
  total: number;
  last_candidate: string | null;
}

interface VisibilityScan {
  readonly direction: "FORWARD" | "LATEST";
  readonly state: "TARGET_REACHED" | "SOURCE_EXHAUSTED" | "BUDGET_STOPPED";
}

interface ScanRead {
  readonly protocol: string;
  readonly items: readonly ResearchChangeItem[];
  readonly next_cursor: string | null;
  readonly has_more: boolean;
  readonly visibility_scan: VisibilityScan;
}

type Service = ReturnType<typeof createResearchChangesService>;

interface Ports {
  readonly deny_scope?: boolean;
  readonly on_current?: () => Promise<void>;
}

// Isolated synthetic upstream layout. research_change_feed carries the exact
// columns the candidate SQL reads. Wiki changes now carry owner visibility in
// the feed row, so the bounded scan has no publication-table joins.
const CREATE_STATEMENTS: readonly string[] = [
  "CREATE TABLE research_change_feed(" +
  "sequence INTEGER PRIMARY KEY AUTOINCREMENT,change_ref TEXT NOT NULL UNIQUE,kind TEXT NOT NULL," +
  "subject_ref TEXT NOT NULL,subject_revision INTEGER NOT NULL,payload_ref TEXT NOT NULL," +
  "payload_sha256 TEXT NOT NULL,visibility_principal_ref TEXT,visibility_snapshot_id TEXT," +
  "visibility_snapshot_revision INTEGER,occurred_at TEXT NOT NULL,metadata_json TEXT NOT NULL)",
  "CREATE TABLE scope_access_grant(snapshot_id TEXT,snapshot_revision INTEGER,principal_ref TEXT," +
  "client_class TEXT,credential_generation TEXT,authorization_receipt_ref TEXT,state TEXT)",
];

beforeEach(async () => {
  await reset();
  await db.batch(CREATE_STATEMENTS.map((statement) => db.prepare(statement)));
});

function ordinal(value: number): string {
  return String(value).padStart(4, "0");
}

// Seeded in ascending order, so research_change_feed AUTOINCREMENT sequences
// match the argument order: hidden first, then visible, or scoped first.
async function seedRows(count: number, kind: string, scoped: boolean): Promise<readonly string[]> {
  const refs: string[] = [];
  const statements = [];
  for (let index = 1; index <= count; index += 1) {
    const family = kind === HIDDEN_KIND ? "hidden" : scoped ? "scoped" : "visible";
    const changeRef = `${family}-${ordinal(index)}`;
    refs.push(changeRef);
    statements.push(db.prepare(
      "INSERT INTO research_change_feed(change_ref,kind,subject_ref,subject_revision,payload_ref," +
      "payload_sha256,visibility_principal_ref,visibility_snapshot_id,visibility_snapshot_revision," +
      "occurred_at,metadata_json) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11)",
    ).bind(
      changeRef, kind, `subject-${ordinal(index)}`, 1, `payload-${ordinal(index)}`, DIGEST,
      PRINCIPAL, scoped ? SCOPE.id : null, scoped ? SCOPE.revision : null, OCCURRED_AT, "{}",
    ));
  }
  for (let offset = 0; offset < statements.length; offset += 50) {
    await db.batch(statements.slice(offset, offset + 50));
  }
  return refs;
}

async function seedHidden(count: number): Promise<readonly string[]> {
  return seedRows(count, HIDDEN_KIND, false);
}

async function seedVisible(count: number): Promise<readonly string[]> {
  return seedRows(count, VISIBLE_KIND, false);
}

async function seedScopeVisible(count: number): Promise<readonly string[]> {
  return seedRows(count, SCOPED_KIND, true);
}

async function grant(state: string): Promise<void> {
  await db.prepare(
    "INSERT INTO scope_access_grant(snapshot_id,snapshot_revision,principal_ref,client_class," +
    "credential_generation,authorization_receipt_ref,state) VALUES (?1,?2,?3,?4,?5,?6,?7)",
  ).bind(SCOPE.id, SCOPE.revision, PRINCIPAL, "owner_pwa", CREDENTIAL, "scan-native-receipt", state).run();
}

async function revokeGrant(): Promise<void> {
  await db.prepare(
    "UPDATE scope_access_grant SET state='REVOKED' WHERE snapshot_id=?1 AND snapshot_revision=?2 " +
    "AND principal_ref=?3 AND client_class=?4 AND credential_generation=?5",
  ).bind(SCOPE.id, SCOPE.revision, PRINCIPAL, "owner_pwa", CREDENTIAL).run();
}

async function grantState(): Promise<string | null> {
  const row = await db.prepare(
    "SELECT state FROM scope_access_grant WHERE snapshot_id=?1 AND snapshot_revision=?2 " +
    "AND principal_ref=?3 AND client_class=?4 AND credential_generation=?5 LIMIT 1",
  ).bind(SCOPE.id, SCOPE.revision, PRINCIPAL, "owner_pwa", CREDENTIAL).first<{ state: unknown }>();
  return typeof row?.state === "string" ? row.state : null;
}

function counters(): Counters {
  return { candidate: 0, grant: 0, anchor: 0, total: 0, last_candidate: null };
}

// Native D1 pass-through proxy: the original statements reach D1 untouched and
// are only classified, mirroring the Recent fixture counting pattern.
function counting(tracked: Counters): D1Database {
  return new Proxy(db, {
    get(target, key) {
      if (key === "prepare") return (sql: string) => {
        tracked.total += 1;
        if (sql.startsWith("SELECT c.sequence,c.change_ref")) {
          tracked.candidate += 1;
          tracked.last_candidate = sql;
        } else if (sql.startsWith("SELECT state FROM scope_access_grant")) {
          tracked.grant += 1;
        } else if (sql.startsWith("SELECT sequence,change_ref FROM research_change_feed")) {
          tracked.anchor += 1;
        }
        return target.prepare(sql);
      };
      const value: unknown = Reflect.get(target, key, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

// Controlled historical authority port. It hides the scope on demand and can
// revoke the grant between the initial authorization and the final currentness
// recheck; that update is the only write this file performs on its own rows.
function service(database: D1Database, ports: Ports = {}): Service {
  return createResearchChangesService({
    database,
    deployment_generation: DEPLOYMENT,
    cursor_key: CURSOR_KEY,
    authorize_historical_scope: async (_context, scopeRef) => {
      if (ports.deny_scope === true && scopeRef.id === SCOPE.id) {
        throw new CatalogInputError("NAVIGATION_SCOPE_NOT_CURRENT", "controlled scope denial", 403);
      }
      return {
        original_scope_snapshot_ref: scopeRef,
        requireCurrent: async () => {
          if (ports.on_current !== undefined) await ports.on_current();
        },
      };
    },
  }, { now: () => NOW_MS });
}

function actor(principal: string = PRINCIPAL, credential: string = CREDENTIAL): AuthenticatedRequestContext {
  return {
    request: new Request("https://research.example/api/v1/research/changes", {
      method: "POST",
      headers: { "content-type": "application/json" },
    }),
    principal_ref: principal,
    client_class: "owner_pwa",
    credential_generation: credential,
    trace_id: "scan-native",
  };
}

function firstPage(limit: number, kinds: readonly ResearchChangeKind[] = []): ResearchChangesRequest {
  return { after_cursor: null, limit, kinds: [...kinds] };
}

function continuation(cursor: string, limit: number): ResearchChangesRequest {
  return { after_cursor: cursor, limit, kinds: [] };
}

function latestPage(limit: number): ResearchChangesRequest {
  return { after_cursor: null, limit, kinds: [], start_at: "latest" as const };
}

async function read(
  api: Service,
  context: AuthenticatedRequestContext,
  raw: ResearchChangesRequest,
): Promise<ScanRead> {
  return (await api(context, raw)) as unknown as ScanRead;
}

function segment(token: string, index: number): string {
  const value = token.split(".").at(index);
  if (value === undefined) throw new Error("expected a two-part base64url cursor");
  return value;
}

function tokenBytes(part: string): Uint8Array {
  const binary = atob(part.replaceAll("-", "+").replaceAll("_", "/") +
    "=".repeat((4 - part.length % 4) % 4));
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function mutate(part: string, index: number): string {
  const characters = [...part];
  const current = characters.at(index);
  if (current === undefined) throw new Error("cursor segment is shorter than expected");
  characters[index] = current === "A" ? "B" : "A";
  return characters.join("");
}

// The confidential v2 token starts with its version byte; a legacy readable
// v1 payload starts with the JSON object character instead.
function sealedVersion(token: string): number {
  return tokenBytes(segment(token, 0))[0] ?? -1;
}

function assertNoSecrets(refs: readonly string[], serialized: string): void {
  for (const ref of refs) expect(serialized).not.toContain(ref);
}

describe("ER-45 bounded filtered scan over actual native D1", () => {
  it("reaches a visible row beyond 501 hidden candidates at limit 1 without losing lookahead", async () => {
    const hidden = await seedHidden(501);
    const visible = await seedVisible(2);
    const tracked = counters();
    const page = await read(service(counting(tracked)), actor(), firstPage(1));
    expect(tracked.candidate).toBe(6);
    expect(tracked.total).toBe(6);
    expect(page.items.map(item => item.change_ref)).toEqual([visible[0]]);
    expect(page.has_more).toBe(true);
    expect(page.visibility_scan).toEqual({ direction: "FORWARD", state: "TARGET_REACHED" });
    assertNoSecrets(hidden, JSON.stringify(page));
    // A visible-target successor remains the readable, deterministic legacy cursor.
    const cursor = page.next_cursor as string;
    expect(sealedVersion(cursor)).toBe("{".charCodeAt(0));
    const replay = await read(service(counting(counters())), actor(), firstPage(1));
    expect(replay).toEqual(page);
    const nextTracked = counters();
    const next = await read(service(counting(nextTracked)), actor(), continuation(cursor, 1));
    expect(next.items.map(item => item.change_ref)).toEqual([visible[1]]);
    expect(next.visibility_scan).toEqual({ direction: "FORWARD", state: "SOURCE_EXHAUSTED" });
    expect(next.has_more).toBe(false);
    expect(nextTracked.anchor).toBe(1);
    expect(nextTracked.candidate).toBe(1);
    expect(nextTracked.total).toBe(2);
  });

  it("continues through exact all-hidden budgets and only reports exhaustion after an empty read", async () => {
    const hidden = await seedHidden(1200);
    const api = service(db);
    const a = counters();
    const first = await read(service(counting(a)), actor(), firstPage(1));
    expect(a.candidate).toBe(6);
    expect(a.total).toBe(6);
    expect(first.items).toEqual([]);
    expect(first.visibility_scan).toEqual({ direction: "FORWARD", state: "BUDGET_STOPPED" });
    expect(first.has_more).toBe(true);
    expect(sealedVersion(first.next_cursor as string)).toBe(2);
    assertNoSecrets(hidden, JSON.stringify(first));
    const b = counters();
    const second = await read(service(counting(b)), actor(), continuation(first.next_cursor as string, 1));
    expect(b.anchor).toBe(1);
    expect(b.candidate).toBe(6);
    expect(b.total).toBe(7);
    expect(second.items).toEqual([]);
    expect(second.has_more).toBe(true);
    expect(second.visibility_scan).toEqual({ direction: "FORWARD", state: "BUDGET_STOPPED" });
    expect(second.next_cursor).not.toBe(first.next_cursor);
    const final = await read(api, actor(), continuation(second.next_cursor as string, 1));
    expect(final.items).toEqual([]);
    expect(final.has_more).toBe(false);
    expect(final.visibility_scan).toEqual({ direction: "FORWARD", state: "SOURCE_EXHAUSTED" });
    expect(final.next_cursor).toBe(second.next_cursor);
    assertNoSecrets(hidden, JSON.stringify(second));
    assertNoSecrets(hidden, JSON.stringify(final));
  });

  it("resumes a latest hidden tail and selects the newest six before reversing to ascending", async () => {
    const visible = await seedVisible(12);
    const hidden = await seedHidden(700); // Hidden rows are genuinely newest by D1 sequence.
    const initial = counters();
    const first = await read(service(counting(initial)), actor(), latestPage(6));
    expect(initial.candidate).toBe(6);
    expect(initial.total).toBe(6);
    expect(first.items).toEqual([]);
    expect(first.has_more).toBe(true);
    expect(first.visibility_scan).toEqual({ direction: "LATEST", state: "BUDGET_STOPPED" });
    assertNoSecrets(hidden, JSON.stringify(first));
    const resumedCount = counters();
    const resumed = await read(service(counting(resumedCount)), actor(), continuation(first.next_cursor as string, 6));
    expect(resumedCount.anchor).toBe(2);
    expect(resumedCount.candidate).toBe(2);
    expect(resumedCount.total).toBe(4);
    expect(resumed.items.map(item => item.change_ref)).toEqual(visible.slice(-6));
    expect(resumed.items.map(item => item.sequence)).toEqual([7, 8, 9, 10, 11, 12]);
    expect(resumed.has_more).toBe(false);
    expect(resumed.visibility_scan).toEqual({ direction: "LATEST", state: "TARGET_REACHED" });
    // Completion switches to forward polling after the original newest raw row.
    const pollCount = counters();
    const poll = await read(service(counting(pollCount)), actor(), continuation(resumed.next_cursor as string, 6));
    expect(poll.items).toEqual([]);
    expect(pollCount.candidate).toBe(1);
    expect(poll.visibility_scan).toEqual({ direction: "FORWARD", state: "SOURCE_EXHAUSTED" });
    expect(poll.has_more).toBe(false);
    assertNoSecrets(hidden, JSON.stringify(resumed));
  });

  it("retains total latest visible capacity across a partial budget-stopped chunk", async () => {
    const older = await seedVisible(10);
    await seedHidden(650);
    const newer = await seedScopeVisible(2);
    await grant("ACTIVE");
    const first = await read(service(db), actor(), latestPage(6));
    expect(first.items.map(item => item.change_ref)).toEqual(newer);
    expect(first.visibility_scan).toEqual({ direction: "LATEST", state: "BUDGET_STOPPED" });
    const second = await read(service(db), actor(), continuation(first.next_cursor as string, 6));
    expect(second.items.map(item => item.change_ref)).toEqual(older.slice(-4));
    expect(second.visibility_scan).toEqual({ direction: "LATEST", state: "TARGET_REACHED" });
    expect(first.items.length + second.items.length).toBe(6);
    expect(second.has_more).toBe(false);
  });

  it("keeps the dense forward page and signs the returned row instead of the fetched batch tail", async () => {
    const visible = await seedVisible(101);
    const tracked = counters();
    const first = await read(service(counting(tracked)), actor(), firstPage(100));
    expect(tracked.candidate).toBe(2);
    expect(tracked.total).toBe(2);
    expect(first.items.map(item => item.change_ref)).toEqual(visible.slice(0, 100));
    expect(first.items.map(item => item.sequence)).toEqual(Array.from({ length: 100 }, (_, i) => i + 1));
    expect(first.visibility_scan).toEqual({ direction: "FORWARD", state: "TARGET_REACHED" });
    const next = await read(service(db), actor(), continuation(first.next_cursor as string, 100));
    expect(next.items.map(item => item.change_ref)).toEqual(visible.slice(100));
    expect(next.has_more).toBe(false);
    expect(next.visibility_scan).toEqual({ direction: "FORWARD", state: "SOURCE_EXHAUSTED" });
  });

  it("counts actual authority statements separately and caches a denied scope within the raw budget", async () => {
    const scoped = await seedScopeVisible(2);
    const hidden = await seedHidden(700);
    await grant("ACTIVE");
    const denied = counters();
    const deniedPage = await read(service(counting(denied), { deny_scope: true }), actor(), firstPage(1));
    expect(denied.candidate).toBe(6);
    expect(denied.grant).toBe(1); // The original grant is read before historical authorization.
    expect(denied.total).toBe(7);
    expect(deniedPage.items).toEqual([]);
    expect(deniedPage.visibility_scan).toEqual({ direction: "FORWARD", state: "BUDGET_STOPPED" });
    assertNoSecrets([...hidden, ...scoped], JSON.stringify(deniedPage));
    const accepted = counters();
    const acceptedPage = await read(service(counting(accepted)), actor(), firstPage(1));
    expect(accepted.candidate).toBe(1);
    expect(accepted.grant).toBe(3); // Load, batch currentness and final currentness.
    expect(accepted.total).toBe(4);
    expect(acceptedPage.items.map(item => item.change_ref)).toEqual([scoped[0]]);
    expect(acceptedPage.has_more).toBe(true);
    assertNoSecrets(hidden, JSON.stringify(acceptedPage));
  });

  it("awaits a real grant revocation during the final authorization and backfills within the same budget", async () => {
    const scoped = await seedScopeVisible(2);
    const hidden = await seedHidden(700);
    await grant("ACTIVE");
    let currentCalls = 0;
    const tracked = counters();
    const page = await read(service(counting(tracked), {
      on_current: async () => {
        currentCalls += 1;
        if (currentCalls === 2) {
          await revokeGrant();
          throw new CatalogInputError("NAVIGATION_SCOPE_NOT_CURRENT", "controlled final revocation", 403);
        }
      },
    }), actor(), firstPage(1));
    expect(currentCalls).toBe(2);
    expect(await grantState()).toBe("REVOKED");
    expect(tracked.candidate).toBe(6);
    expect(tracked.grant).toBe(3);
    expect(tracked.total).toBe(9);
    expect(page.items).toEqual([]);
    expect(page.has_more).toBe(true);
    expect(page.visibility_scan).toEqual({ direction: "FORWARD", state: "BUDGET_STOPPED" });
    assertNoSecrets([...hidden, ...scoped], JSON.stringify(page));
    const later = await read(service(db), actor(), firstPage(1));
    expect(later.items).toEqual([]);
    assertNoSecrets(scoped, JSON.stringify(later));
  });

  it("encrypts hidden progress at fixed length and rejects tampering or foreign binding before D1 reads", async () => {
    const hidden = await seedHidden(700);
    const first = await read(service(db), actor(), firstPage(1));
    const cursor = first.next_cursor as string;
    expect(cursor.length).toBe(3496);
    expect(new TextEncoder().encode(cursor).byteLength).toBeLessThanOrEqual(4096);
    const payload = tokenBytes(segment(cursor, 0));
    expect(payload[0]).toBe(2);
    expect(payload.byteLength).toBe(SCAN_SEALED_BYTES);
    assertNoSecrets(hidden, JSON.stringify(first));
    assertNoSecrets(hidden, new TextDecoder().decode(payload));
    const replay = await read(service(db), actor(), firstPage(1));
    expect(replay.items).toEqual(first.items);
    expect(replay.visibility_scan).toEqual(first.visibility_scan);
    expect(replay.next_cursor).not.toBe(cursor);
    expect((replay.next_cursor as string).length).toBe(cursor.length);
    const forged = segment(cursor, 0) + "." + mutate(segment(cursor, 1), 1);
    for (const [context, request, code] of [
      [actor(), continuation(forged, 1), "RESEARCH_CHANGES_CURSOR_INVALID"],
      [actor("foreign-owner"), continuation(cursor, 1), "RESEARCH_CHANGES_CURSOR_BINDING_MISMATCH"],
      [actor(), continuation(cursor, 2), "RESEARCH_CHANGES_CURSOR_BINDING_MISMATCH"],
    ] as const) {
      const tracked = counters();
      await expect(read(service(counting(tracked)), context, request)).rejects.toMatchObject({ code });
      expect(tracked.total).toBe(0);
    }
  });
});
