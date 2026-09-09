import type { DrivePayloadPart, DriveRequestRow, ExchangeGeneration } from "@eliotr/contracts";
import {
  DRIVE_SCAN_FIRST_DATA_ROW,
  DRIVE_SCAN_MAX_PAGES,
  DRIVE_SCAN_PAGE_ROWS,
  DriveReconcileError,
  type DriveCursorRepository,
  type DriveObservationRepository,
} from "./cursor.js";
import { parsePayloadPartCells, parseRequestCells } from "./contribution.js";
import type { GoogleDrivePort, SheetRange } from "./port.js";
import { validateExchangeGeneration } from "./serializer.js";

export interface FrozenTransportEnvelopePort {
  freeze(input: { generation_id: string; object_kind: "request" | "payload"; object_id: string; canonical_utf8: string }): Promise<{ object_ref: string; sha256: string }>;
  /**
   * Read back the authoritative frozen bytes for a previously frozen object.
   * Returns `null` when the frozen object is absent. The tamper audit compares
   * live Drive bytes against exactly these bytes; a missing/unreadable frozen
   * envelope is an unknown outcome (`DRIVE_FROZEN_MISSING`), never tamper.
   */
  readFrozen(objectRef: string): Promise<{ sha256: string; canonical_utf8: string } | null>;
}

export interface ContributionIntentPort {
  admitFrozenEnvelope(input: { generation_id: string; request_id: string; idempotency_key: string; frozen_object_ref: string; sha256: string }): Promise<"ADMITTED" | "DUPLICATE" | "REJECTED">;
}

export interface ReconciliationDependencies {
  readonly drive: GoogleDrivePort;
  readonly cursors: DriveCursorRepository;
  readonly observations: DriveObservationRepository;
  readonly frozenEnvelopes: FrozenTransportEnvelopePort;
  readonly contributionIntents: ContributionIntentPort;
}

export interface PollCounts {
  readonly imported: number;
  readonly duplicates: number;
  readonly tampered: number;
  readonly incomplete: number;
}

export interface AuditCounts {
  /** Canonical IMPORTED observation rows examined (superset of tampered + missing). */
  readonly checked: number;
  readonly tampered: number;
  readonly missing: number;
}

// IMPLEMENTED_NOT_LIVE: ER-19 durable leased Drive cursor poll with ID/hash dedup plus digest-against-frozen-envelope tamper audit; owner provisioning/Doc publication/composition and live qualification remain separate.
export interface DriveReconciler {
  poll(generation: ExchangeGeneration, leaseOwner: string, nowEpochMs: number): Promise<PollCounts>;
  auditHistoricalRows(generation: ExchangeGeneration): Promise<AuditCounts>;
}

const HEX64 = /^[0-9a-f]{64}$/u;
const MAX_IDENTITY = 256;
const MAX_CHANGE_PAGES = 5;

function fail(code: string): never {
  throw new DriveReconcileError(code);
}

function identity(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length < 1 || value.length > MAX_IDENTITY) fail(label);
  return value as string;
}

function validNow(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > 8640000000000000) {
    fail("DRIVE_TIME_INVALID");
  }
  return value;
}

function activeGeneration(raw: ExchangeGeneration): ExchangeGeneration {
  const generation = validateExchangeGeneration(raw);
  if (generation.status !== "active") fail("EXCHANGE_GENERATION_NOT_ACTIVE");
  return generation;
}

async function sha256HexUtf8(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text);
  const copy = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(copy).set(bytes);
  const digest = await crypto.subtle.digest("SHA-256", copy);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

interface ScannedRow {
  readonly cells: readonly unknown[];
  /** 1-indexed sheet row number. A scan hint only; identity is always the ID column. */
  readonly sheetRow: number;
}

interface TabScan {
  readonly rows: readonly ScannedRow[];
  /** Next unread 1-indexed row after the fully-read prefix. */
  readonly nextRow: number;
}

/**
 * Bounded forward scan of one Exchange tab from `fromRow` (1-indexed, inclusive).
 * Reads at most DRIVE_SCAN_MAX_PAGES pages of DRIVE_SCAN_PAGE_ROWS rows and stops
 * at the first short page. Throws DRIVE_SCAN_LIMIT instead of ever treating a
 * truncated scan as a complete/absence proof.
 */
async function scanTab(
  drive: GoogleDrivePort,
  spreadsheetId: string,
  tab: "REQUESTS" | "PAYLOAD_PARTS",
  fromRow: number,
): Promise<TabScan> {
  const width = tab === "REQUESTS" ? "P" : "E";
  const rows: ScannedRow[] = [];
  let cursor = fromRow;
  for (let page = 0; page < DRIVE_SCAN_MAX_PAGES; page += 1) {
    const end = cursor + DRIVE_SCAN_PAGE_ROWS;
    const ranges = [`'${tab}'!A${cursor}:${width}${end}`];
    let batch: SheetRange[];
    try {
      batch = await drive.readSheetRanges(spreadsheetId, ranges);
    } catch {
      fail("DRIVE_POLL_TRANSPORT");
    }
    const values = (batch as SheetRange[])[0]?.values ?? [];
    for (let index = 0; index < values.length; index += 1) {
      rows.push({ cells: values[index] as readonly unknown[], sheetRow: cursor + index });
    }
    cursor += values.length;
    if (values.length < DRIVE_SCAN_PAGE_ROWS) return { rows, nextRow: cursor };
  }
  return fail("DRIVE_SCAN_LIMIT");
}

interface ParsedRequest {
  readonly row: DriveRequestRow;
  readonly sheetRow: number;
}

interface ParsedPart {
  readonly part: DrivePayloadPart;
  readonly sheetRow: number;
}

/** Malformed cells in newly scanned rows are an unknown outcome (incomplete), never tamper. */
function parseTabRows(requests: readonly ScannedRow[], parts: readonly ScannedRow[]): { parsedRequests: ParsedRequest[]; parsedParts: ParsedPart[] } {
  const parsedRequests: ParsedRequest[] = [];
  const parsedParts: ParsedPart[] = [];
  try {
    for (const row of requests) parsedRequests.push({ row: parseRequestCells(row.cells), sheetRow: row.sheetRow });
    for (const row of parts) parsedParts.push({ part: parsePayloadPartCells(row.cells), sheetRow: row.sheetRow });
  } catch {
    fail("DRIVE_ROW_UNREADABLE");
  }
  return { parsedRequests, parsedParts };
}

function partObjectId(payloadId: string, partIndex: number): string {
  return `${payloadId}:${partIndex}`;
}

export function createDriveReconciler(
  dependencies: ReconciliationDependencies,
  /**
   * Commit-time clock for the cursor lease guard. Defaults to the wall clock;
   * tests inject a fixed clock. The poll's `nowEpochMs` remains the caller's
   * time authority for lease acquisition; the guard rechecks liveness at
   * commit so a poll that outruns its TTL can never advance the cursor.
   */
  clock: () => number = Date.now,
): DriveReconciler {
  const { drive, cursors, observations, frozenEnvelopes, contributionIntents } = dependencies;
  if (!drive || !cursors || !observations || !frozenEnvelopes || !contributionIntents) {
    throw new DriveReconcileError("DRIVE_DEPENDENCIES_INVALID");
  }

  async function poll(rawGeneration: ExchangeGeneration, rawOwner: string, rawNow: number): Promise<PollCounts> {
    const generation = activeGeneration(rawGeneration);
    const leaseOwner = identity(rawOwner, "DRIVE_OWNER_INVALID");
    const nowEpochMs = validNow(rawNow);

    // Intent: the lease is authority. No Drive, freeze, admission or D1-mutation
    // attempt happens before it is held.
    const lease = await cursors.acquireLease(generation.connection_id, leaseOwner, nowEpochMs);
    if (lease === null) fail("DRIVE_LEASE_HELD");
    if (lease.connection_id !== generation.connection_id
      || lease.lease_owner !== leaseOwner
      || (lease.lease_until ?? 0) <= nowEpochMs) {
      fail("DRIVE_LEASE_EXPIRED");
    }
    const storedToken = lease.start_page_token;
    const storedExtents = { ...(lease.last_grid_extent_by_sheet ?? {}) };
    const requestFrom = extentOf(storedExtents, "requests");
    const partFrom = extentOf(storedExtents, "payload_parts");

    let released = false;
    const release = async (): Promise<void> => {
      if (released) return;
      released = true;
      await cursors.releaseLease(generation.connection_id, leaseOwner).catch(() => undefined);
    };

    try {
      return await pollUnderLease(generation, leaseOwner, nowEpochMs, storedToken, storedExtents, requestFrom, partFrom);
    } catch (error) {
      // Transport/incomplete paths already recorded their failure where the
      // outcome was determined; record only authority rejections and
      // unexpected failures here, then always rethrow without committing.
      if (!(error instanceof DriveReconcileError)
        || error.code === "DRIVE_CONTRIBUTION_REJECTED"
        || error.code === "DRIVE_LEASE_EXPIRED"
        || error.code === "DRIVE_LEASE_HELD") {
        await cursors.recordFailure(generation.connection_id, error instanceof DriveReconcileError ? error.code : "DRIVE_POLL_FAILED").catch(() => undefined);
      }
      throw error;
    } finally {
      await release();
    }
  }

  async function pollUnderLease(
    generation: ExchangeGeneration,
    leaseOwner: string,
    nowEpochMs: number,
    storedToken: string,
    storedExtents: Record<string, number>,
    requestFrom: number,
    partFrom: number,
  ): Promise<PollCounts> {
    // Attempt: leased changes.list replay. A lost response here is an unknown
    // outcome: return zero counts without advancing anything.
    let terminalToken: string | null = null;
    let relevantChange = false;
    let spreadsheetModifiedTime: string | undefined;
    try {
      let token: string | undefined = storedToken;
      for (let page = 0; page < MAX_CHANGE_PAGES && token !== undefined; page += 1) {
        const result = await drive.listChanges(token);
        for (const change of result.changes) {
          if (change.fileId === generation.spreadsheet_id && !change.removed) {
            relevantChange = true;
            if (change.modifiedTime !== undefined) spreadsheetModifiedTime = change.modifiedTime;
          }
        }
        if (result.newStartPageToken !== undefined) {
          terminalToken = result.newStartPageToken;
          token = undefined;
        } else {
          token = result.nextPageToken;
        }
      }
    } catch {
      await cursors.recordFailure(generation.connection_id, "DRIVE_POLL_TRANSPORT").catch(() => undefined);
      return { imported: 0, duplicates: 0, tampered: 0, incomplete: 0 };
    }

    // A poll that trusts notifications alone would miss rows after a lost
    // notification, so any token movement (or relevant change) triggers a
    // bounded ID-column scan from the durable extents. An unchanged token with
    // no relevant change means nothing happened: zero counts, no writes.
    if (!relevantChange && (terminalToken === null || terminalToken === storedToken)) {
      return { imported: 0, duplicates: 0, tampered: 0, incomplete: 0 };
    }

    const fallbackModifiedTime = new Date(nowEpochMs).toISOString();
    const observedModifiedTime = spreadsheetModifiedTime ?? fallbackModifiedTime;

    // Read the full new prefix before any admission effect. A read failure is
    // unknown: zero counts, no cursor advance.
    let requestScan: TabScan;
    let partScan: TabScan;
    try {
      requestScan = await scanTab(drive, generation.spreadsheet_id, "REQUESTS", requestFrom);
      partScan = await scanTab(drive, generation.spreadsheet_id, "PAYLOAD_PARTS", partFrom);
    } catch (error) {
      const code = error instanceof DriveReconcileError ? error.code : "DRIVE_POLL_TRANSPORT";
      await cursors.recordFailure(generation.connection_id, code).catch(() => undefined);
      if (error instanceof DriveReconcileError && error.code === "DRIVE_SCAN_LIMIT") throw error;
      return { imported: 0, duplicates: 0, tampered: 0, incomplete: 0 };
    }

    let parsed: { parsedRequests: ParsedRequest[]; parsedParts: ParsedPart[] };
    try {
      parsed = parseTabRows(requestScan.rows, partScan.rows);
    } catch {
      await cursors.recordFailure(generation.connection_id, "DRIVE_ROW_UNREADABLE").catch(() => undefined);
      return { imported: 0, duplicates: 0, tampered: 0, incomplete: 1 };
    }

    const partsByPayload = new Map<string, ParsedPart[]>();
    for (const entry of parsed.parsedParts) {
      const group = partsByPayload.get(entry.part.payload_id) ?? [];
      group.push(entry);
      partsByPayload.set(entry.part.payload_id, group);
    }

    let imported = 0;
    let duplicates = 0;
    let tampered = 0;
    let incomplete = 0;

    for (const entry of parsed.parsedRequests) {
      const outcome = await reconcileRequest(generation, entry, partsByPayload, observedModifiedTime);
      imported += outcome.imported;
      duplicates += outcome.duplicates;
      tampered += outcome.tampered;
      incomplete += outcome.incomplete;
      // The cursor never advances past unfinished work: stop at the first
      // incomplete contribution; already-admitted rows reconcile as duplicates
      // on the next poll without a second admission effect.
      if (outcome.incomplete > 0) break;
    }

    if (incomplete > 0) {
      // Receipt: partial work stays admitted (idempotent) but the cursor does
      // not move; readback on retry resolves every row by ID and digest.
      await cursors.recordFailure(generation.connection_id, "DRIVE_POLL_INCOMPLETE").catch(() => undefined);
      return { imported, duplicates, tampered, incomplete };
    }

    // Reconciliation: commit extents over the fully-read prefix and the
    // terminal token when one was observed. The store rechecks lease ownership
    // and expiry against the commit-time clock inside the guarded update, so a
    // stolen, expired, or outrun lease throws here instead of advancing.
    const nextExtents: Record<string, number> = {
      ...storedExtents,
      requests: requestScan.nextRow,
      payload_parts: partScan.nextRow,
    };
    const commitNow = clock();
    if (!Number.isSafeInteger(commitNow) || commitNow < 0 || commitNow > 8640000000000000) {
      fail("DRIVE_TIME_INVALID");
    }
    await cursors.persistAfterCommit(
      generation.connection_id,
      terminalToken ?? storedToken,
      nextExtents,
      leaseOwner,
      commitNow,
    );
    return { imported, duplicates, tampered, incomplete };
  }

  interface RequestOutcome {
    readonly imported: number;
    readonly duplicates: number;
    readonly tampered: number;
    readonly incomplete: number;
  }

  /**
   * Reconcile one request contribution. Returns per-request counters; throws
   * only when the authority rejects (fail closed) or the outcome is otherwise
   * uninterpretable. Transport uncertainty resolves to `incomplete`, never to
   * `tampered`: an unreadable row is not proof of tampering.
   */
  async function reconcileRequest(
    generation: ExchangeGeneration,
    entry: ParsedRequest,
    partsByPayload: ReadonlyMap<string, readonly ParsedPart[]>,
    observedModifiedTime: string,
  ): Promise<RequestOutcome> {
    const request = entry.row;
    const none: RequestOutcome = { imported: 0, duplicates: 0, tampered: 0, incomplete: 0 };

    const wantedParts = request.body_encoding === "inline_json" ? [] : orderedParts(request, partsByPayload);
    if (wantedParts === null) return { ...none, incomplete: 1 };

    const requestCanonical = JSON.stringify(request);
    const requestSha = await sha256HexUtf8(requestCanonical);
    const existing = await observations.lookup(generation.generation_id, "request", request.request_id);

    if (existing !== null && existing.content_sha256 === requestSha) {
      // Duplicate recognised by ID and digest: never re-freeze or re-admit.
      // Close the crash window where a previous poll admitted but recorded
      // only some rows: record still-missing part rows without admission.
      let tampered = 0;
      for (const partEntry of wantedParts) {
        const partCanonical = JSON.stringify(partEntry.part);
        const partSha = await sha256HexUtf8(partCanonical);
        const partId = partObjectId(partEntry.part.payload_id, partEntry.part.part_index);
        const seen = await observations.lookup(generation.generation_id, "payload", partId);
        if (seen !== null) {
          if (seen.content_sha256 !== partSha) tampered += 1;
          continue;
        }
        let frozenRef: string;
        try {
          frozenRef = (await frozenEnvelopes.freeze({ generation_id: generation.generation_id,
            object_kind: "payload", object_id: partId, canonical_utf8: partCanonical })).object_ref;
        } catch {
          return { ...none, tampered, incomplete: 1 };
        }
        try {
          await observations.insertFrozenObservation({ generation_id: generation.generation_id,
            object_kind: "payload", object_id: partId, content_sha256: partSha,
            observed_row: partEntry.sheetRow, drive_modified_time: observedModifiedTime,
            frozen_r2_key: frozenRef });
        } catch {
          return { ...none, tampered, incomplete: 1 };
        }
      }
      if (tampered > 0) return { ...none, tampered };
      return { ...none, duplicates: 1 };
    }

    if (existing !== null) {
      // Same ID, different digest: the Drive row was edited, reordered or
      // replaced after admission. Mark TRANSPORT_TAMPERED against the original
      // frozen envelope, which remains the authority; never re-freeze the edit.
      const marked = await markTampered(generation, "request", request.request_id,
        requestSha, entry.sheetRow, observedModifiedTime, request.actor_claim,
        existing.frozen_r2_key, request.idempotency_key);
      return { ...none, tampered: marked };
    }

    // New contribution: freeze every row, admit once via the request envelope,
    // then record. Any transport uncertainty aborts as incomplete.
    const partFreezes: { id: string; sha: string; ref: string; sheetRow: number }[] = [];
    try {
      for (const partEntry of wantedParts) {
        const partCanonical = JSON.stringify(partEntry.part);
        const partSha = await sha256HexUtf8(partCanonical);
        const partId = partObjectId(partEntry.part.payload_id, partEntry.part.part_index);
        const seen = await observations.lookup(generation.generation_id, "payload", partId);
        if (seen !== null && seen.content_sha256 !== partSha) {
          const marked = await markTampered(generation, "payload", partId, partSha,
            partEntry.sheetRow, observedModifiedTime, undefined, seen.frozen_r2_key, undefined);
          return { ...none, tampered: marked };
        }
        if (seen === null) {
          const frozen = await frozenEnvelopes.freeze({ generation_id: generation.generation_id,
            object_kind: "payload", object_id: partId, canonical_utf8: partCanonical });
          if (!HEX64.test(frozen.sha256)) fail("DRIVE_FROZEN_DIGEST_INVALID");
          partFreezes.push({ id: partId, sha: partSha, ref: frozen.object_ref, sheetRow: partEntry.sheetRow });
        }
      }
      const frozenRequest = await frozenEnvelopes.freeze({ generation_id: generation.generation_id,
        object_kind: "request", object_id: request.request_id, canonical_utf8: requestCanonical });
      if (!HEX64.test(frozenRequest.sha256)) fail("DRIVE_FROZEN_DIGEST_INVALID");
      const verdict = await contributionIntents.admitFrozenEnvelope({ generation_id: generation.generation_id,
        request_id: request.request_id, idempotency_key: request.idempotency_key,
        frozen_object_ref: frozenRequest.object_ref, sha256: frozenRequest.sha256 });
      if (verdict === "REJECTED") fail("DRIVE_CONTRIBUTION_REJECTED");
      const record = verdict === "ADMITTED" ? 1 : 0;
      await observations.insertFrozenObservation({ generation_id: generation.generation_id,
        object_kind: "request", object_id: request.request_id, idempotency_key: request.idempotency_key,
        content_sha256: requestSha, observed_row: entry.sheetRow, drive_modified_time: observedModifiedTime,
        actor_claim: request.actor_claim, frozen_r2_key: frozenRequest.object_ref });
      for (const frozen of partFreezes) {
        await observations.insertFrozenObservation({ generation_id: generation.generation_id,
          object_kind: "payload", object_id: frozen.id, content_sha256: frozen.sha,
          observed_row: frozen.sheetRow, drive_modified_time: observedModifiedTime,
          frozen_r2_key: frozen.ref });
      }
      return record === 1 ? { ...none, imported: 1 } : { ...none, duplicates: 1 };
    } catch (error) {
      if (error instanceof DriveReconcileError && error.code === "DRIVE_CONTRIBUTION_REJECTED") throw error;
      return { ...none, incomplete: 1 };
    }
  }

  /**
   * Ordered payload parts for a chunked request, or `null` when the set is
   * incomplete (missing parts never start a job). Assembly is by declared
   * index, never by row position.
   */
  function orderedParts(
    request: DriveRequestRow,
    partsByPayload: ReadonlyMap<string, readonly ParsedPart[]>,
  ): ParsedPart[] | null {
    if (request.payload_id === undefined) return null;
    const group = partsByPayload.get(request.payload_id) ?? [];
    if (group.length !== request.part_count) return null;
    const ordered = [...group].sort((left, right) => left.part.part_index - right.part.part_index);
    for (let index = 0; index < ordered.length; index += 1) {
      const item = ordered[index];
      if (item === undefined || item.part.part_index !== index || item.part.part_count !== request.part_count) return null;
    }
    return ordered;
  }

  async function markTampered(
    generation: ExchangeGeneration,
    kind: "request" | "payload",
    objectId: string,
    observedSha: string,
    observedRow: number,
    observedModifiedTime: string,
    actorClaim: string | undefined,
    frozenR2Key: string,
    idempotencyKey: string | undefined,
  ): Promise<number> {
    await observations.insertFrozenObservation({ generation_id: generation.generation_id,
      object_kind: kind, object_id: objectId,
      ...(idempotencyKey === undefined ? {} : { idempotency_key: idempotencyKey }),
      content_sha256: observedSha, observed_row: observedRow,
      drive_modified_time: observedModifiedTime,
      ...(actorClaim === undefined ? {} : { actor_claim: actorClaim }),
      frozen_r2_key: frozenR2Key });
    return 1;
  }

  async function auditHistoricalRows(rawGeneration: ExchangeGeneration): Promise<AuditCounts> {
    const generation = activeGeneration(rawGeneration);
    const canonical = await observations.listImportedForGeneration(generation.generation_id);

    // Re-read the live sheets end to end (bounded). An unreadable audit scan is
    // an unknown outcome: fail closed with a typed error rather than reporting
    // absence or tamper from a half-read sheet.
    let requestScan: TabScan;
    let partScan: TabScan;
    try {
      requestScan = await scanTab(drive, generation.spreadsheet_id, "REQUESTS", DRIVE_SCAN_FIRST_DATA_ROW);
      partScan = await scanTab(drive, generation.spreadsheet_id, "PAYLOAD_PARTS", DRIVE_SCAN_FIRST_DATA_ROW);
    } catch {
      fail("DRIVE_AUDIT_TRANSPORT");
    }
    let liveRequests: Map<string, string>;
    let liveParts: Map<string, string>;
    try {
      liveRequests = await digestRows(requestScan.rows, "request");
      liveParts = await digestRows(partScan.rows, "payload");
    } catch {
      fail("DRIVE_AUDIT_TRANSPORT");
    }

    let checked = 0;
    let tampered = 0;
    let missing = 0;
    for (const row of canonical) {
      checked += 1;
      // Authority first: the frozen envelope, not the stored flag or digest.
      const frozen = await frozenEnvelopes.readFrozen(row.frozen_r2_key);
      if (frozen === null) fail("DRIVE_FROZEN_MISSING");
      const frozenDigest = await sha256HexUtf8(frozen.canonical_utf8);
      if (frozenDigest !== frozen.sha256) fail("DRIVE_FROZEN_CORRUPT");
      if (frozen.sha256 !== row.content_sha256) {
        tampered += 1;
        continue;
      }
      const live = row.object_kind === "request" ? liveRequests.get(row.object_id) : liveParts.get(row.object_id);
      if (live === undefined) {
        missing += 1;
        continue;
      }
      if (live !== frozen.sha256) tampered += 1;
    }
    return { checked, tampered, missing };
  }

  /** Current live digest per object ID. Malformed rows fail the whole audit scan. */
  async function digestRows(rows: readonly ScannedRow[], kind: "request" | "payload"): Promise<Map<string, string>> {
    const live = new Map<string, string>();
    for (const row of rows) {
      if (kind === "request") {
        const parsed = parseRequestCells(row.cells);
        live.set(parsed.request_id, await sha256HexUtf8(JSON.stringify(parsed)));
      } else {
        const parsed = parsePayloadPartCells(row.cells);
        live.set(partObjectId(parsed.payload_id, parsed.part_index), await sha256HexUtf8(JSON.stringify(parsed)));
      }
    }
    return live;
  }

  return { poll, auditHistoricalRows };
}

function extentOf(extents: Readonly<Record<string, number>>, key: string): number {
  const value = extents[key];
  if (value === undefined) return DRIVE_SCAN_FIRST_DATA_ROW;
  if (!Number.isSafeInteger(value) || value < DRIVE_SCAN_FIRST_DATA_ROW) fail("DRIVE_EXTENT_INVALID");
  return value;
}
