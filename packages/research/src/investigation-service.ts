// IMPLEMENTED_NOT_LIVE: ER-08/ER-13 versioned Investigation ledger over D1 with transaction-time guards, ledger epoch and explicit supersession; Workflow/Session composition and live receipts remain separate.
import type { Investigation, InquiryProtocolProfile, ScopeSnapshot, VersionedRef } from "@eliotr/contracts";
import { z } from "zod";
import {
  GUARD_SQL, LEDGER_SQL, LedgerError, LedgerEventSchema, LedgerHeadSchema, decodeLedgerEvent, decodeLedgerHead, ledgerCasBindings, ledgerEventBindings, ledgerFenceDriftCode, ledgerHeadBindings, parseLedgerTriggerCode, sameLedgerEvent, sameLedgerFence, sameLedgerHead, throwIfCancelled,
  type InvestigationLedgerStore, type LedgerAuthorityFence, type LedgerEvent, type LedgerEventRow, type LedgerHead, type LedgerHeadRow,
  type LedgerObligation, type LedgerSnapshot,
} from "./ports.js";
import type { ResearchRunResult } from "./ports.js";
export interface LedgerD1Statement {
  first<T>(): Promise<T | null>;
  all<T>(): Promise<{ results: T[] }>;
  run(): Promise<{ meta: { changes: number } }>;
  readonly sql: string;
  readonly params: readonly unknown[];
}
export interface LedgerD1Database {
  prepare(sql: string): { bind(...params: unknown[]): LedgerD1Statement };
  batch(statements: readonly LedgerD1Statement[]): Promise<readonly { meta: { changes: number } }[]>;
}
export interface CreateInvestigationInput {
  readonly goal: string; readonly intended_decision_or_artifact: string; readonly interpretations: readonly string[];
  readonly scope_snapshot: ScopeSnapshot; readonly protocol: InquiryProtocolProfile;
  readonly execution_product: Investigation["execution_product"]; readonly model_profile_ref: string;
  readonly budget_ref: string; readonly stop_rule_ref: string; readonly parent_investigation_ref?: VersionedRef;
}
export interface InvestigationService {
  create(input: CreateInvestigationInput): Promise<Investigation>;
  start(investigationRef: VersionedRef, idempotencyKey: string): Promise<{ workflow_instance_id: string }>;
  cancel(investigationRef: VersionedRef, reason: string): Promise<VersionedRef>;
  reopen(investigationRef: VersionedRef, reason: string, affectedClaimRefs: readonly string[]): Promise<Investigation>;
  status(investigationRef: VersionedRef): Promise<Investigation>;
  result(investigationRef: VersionedRef): Promise<ResearchRunResult | null>;
}
const HEX64 = /^[a-f0-9]{64}$/;
const ID = z.string().min(1).max(128); const REF256 = z.string().min(1).max(256); const GOAL = z.string().min(1).max(2000);
const HANDLE = z.string().min(1).max(256); const DIGEST = z.string().regex(HEX64); const ISO = z.string().datetime({ offset: true });
const GENERATION = z.string().min(1).max(256); const GRADE = z.enum(["E0", "E1", "E2", "E3"]);
const LANE = z.enum(["confirmatory", "exploratory", "mixed_with_declared_split"]); const OBL_LANE = z.enum(["confirmatory", "exploratory"]);
const ObligationSchema = z.object({
  obligation_id: ID, verifier_ref: REF256, lane: OBL_LANE, metric_ref: REF256,
  status: z.enum(["REGISTERED", "ACCEPTED", "DEVIATED"]), exposed: z.boolean(),
}).strict();
const CreateInputSchema = z.object({
  investigation_id: ID, goal: GOAL, scope_snapshot_id: REF256, scope_snapshot_revision: z.number().int().min(1).max(1000000), evidence_grade: GRADE, lane: LANE,
  lane_registrations: z.array(REF256).max(16), obligations: z.array(ObligationSchema).max(32), hypotheses: z.array(z.string().min(1).max(1024)).max(32),
  portfolio_ref: HANDLE, debt_refs: z.array(REF256).max(32), principal_ref: REF256, input_digest: DIGEST, policy_generation: GENERATION,
  policy_authority_ref: REF256, deployment_generation: GENERATION, idempotency_key: REF256, model_profile_ref: REF256, event_id: ID,
  payload_handle_ref: HANDLE, payload_digest: DIGEST, created_at: ISO,
}).strict();
function ledgerFail(code: "LEDGER_INPUT_INVALID" | "LEDGER_CONFLICT" | "LEDGER_STALE_HEAD" | "LEDGER_PRINCIPAL_DENIED" | "LEDGER_SCOPE_FOREIGN" | "LEDGER_POLICY_STALE" | "LEDGER_DEPLOYMENT_STALE" | "LEDGER_PURGE_STALE" | "LEDGER_VERIFIER_DENIED" | "LEDGER_SUPERSESSION_REQUIRED" | "LEDGER_HANDLE_MISSING" | "LEDGER_SETTLEMENT_UNCERTAIN", message: string, retryable = false, cause?: unknown): never {
  throw new LedgerError(code, message, retryable, cause);
}
function parseHead(value: unknown): LedgerHead {
  try { return LedgerHeadSchema.parse(value); } catch (cause) { ledgerFail("LEDGER_INPUT_INVALID", "ledger head failed strict validation", false, cause); }
}
function parseEvent(value: unknown): LedgerEvent {
  try { return LedgerEventSchema.parse(value); } catch (cause) { ledgerFail("LEDGER_INPUT_INVALID", "ledger event failed strict validation", false, cause); }
}
const decodeHead = decodeLedgerHead;
const decodeEvent = decodeLedgerEvent;
const headBindings = ledgerHeadBindings;
const casBindings = ledgerCasBindings;
const eventBindings = ledgerEventBindings;
const sameHead = sameLedgerHead;
const sameEvent = sameLedgerEvent;
type HeadRow = LedgerHeadRow;
type EventRow = LedgerEventRow;
function guardExpiry(observedAt: string): string { return new Date(Date.parse(observedAt) + 5 * 60 * 1000).toISOString(); }
function guardIdFor(eventId: string): string { return `guard-${eventId}`.slice(0, 256); }
async function readEpoch(database: LedgerD1Database): Promise<number> {
  const row = await database.prepare(GUARD_SQL.selectEpoch).bind().first<{ generation: number }>();
  if (row === null) ledgerFail("LEDGER_SETTLEMENT_UNCERTAIN", "ledger epoch missing", true);
  return row.generation;
}
async function materializeAuthority(database: LedgerD1Database, fence: LedgerAuthorityFence, policyRef: string, now: string): Promise<void> {
  const expiry = guardExpiry(now);
  try {
    await database.batch([database.prepare(GUARD_SQL.upsertAuthority).bind(fence.principal_ref, fence.scope_snapshot_id, fence.scope_snapshot_revision, fence.policy_generation, policyRef, fence.deployment_generation, fence.purge_revision, fence.scope_purge_revision, now, expiry)]);
  } catch { /* ledger batch revalidates; stale materialization fails there with typed code */ }
}
function guardParams(guardId: string, op: "CREATE" | "APPEND" | "SUPERSEDE", oldId: string, newId: string | null, oldRev: number, newRev: number, oldHead: number, newHeadCount: number, eventId: string, newEventId: string | null, fence: LedgerAuthorityFence, policyRef: string, epoch: number, now: string): readonly unknown[] {
  return [guardId, op, oldId, newId, oldRev, newRev, oldHead, newHeadCount, eventId, newEventId, fence.principal_ref, fence.scope_snapshot_id, fence.scope_snapshot_revision, fence.policy_generation, policyRef, fence.deployment_generation, fence.purge_revision, fence.scope_purge_revision, epoch, now, guardExpiry(now)];
}
function mapTriggerError(error: unknown): never {
  if (error instanceof LedgerError) throw error;
  const code = error instanceof Error ? parseLedgerTriggerCode(error.message) : null;
  if (code !== null && code !== "LEDGER_SETTLEMENT_UNCERTAIN") ledgerFail(code, error instanceof Error ? error.message : "ledger guard rejected");
  if (error instanceof Error && /ABORT|UNIQUE|CHECK|constraint|append-only|guard/i.test(error.message)) ledgerFail("LEDGER_CONFLICT", "ledger conflicted");
  ledgerFail("LEDGER_SETTLEMENT_UNCERTAIN", "ledger outcome is unknown", true, error);
}
async function readSnapshot(database: LedgerD1Database, investigationId: string) {
  const headRow = await database.prepare(LEDGER_SQL.selectHead).bind(investigationId).first<HeadRow>();
  if (headRow === null) return null;
  const head = decodeHead(headRow);
  const eventRows = await database.prepare(LEDGER_SQL.selectEvents).bind(investigationId).all<EventRow>();
  const events = (eventRows.results ?? []).map(decodeEvent);
  assertContiguous(head, events);
  return { head, events };
}
function assertContiguous(head: LedgerHead, events: readonly LedgerEvent[]): void {
  if (events.length !== head.event_head) ledgerFail("LEDGER_INPUT_INVALID", "ledger event/head count diverged");
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index];
    if (event === undefined || event.sequence !== index + 1 || event.investigation_id !== head.investigation_id) {
      ledgerFail("LEDGER_INPUT_INVALID", "ledger events are not contiguous");
    }
  }
}
function checkAppendShape(head: LedgerHead, current: LedgerHead, parsedEvent: LedgerEvent, expectedRevision: number): void {
  if (current.revision !== expectedRevision) ledgerFail("LEDGER_STALE_HEAD", "stale expected revision for ledger head");
  if (head.revision !== current.revision + 1 || parsedEvent.sequence !== current.event_head + 1) {
    ledgerFail("LEDGER_INPUT_INVALID", "ledger append must advance revision and sequence by one");
  }
  if (head.investigation_id !== current.investigation_id || parsedEvent.investigation_id !== current.investigation_id) {
    ledgerFail("LEDGER_INPUT_INVALID", "ledger append bound to another investigation");
  }
  if (head.evidence_grade !== current.evidence_grade || head.protocol_version !== current.protocol_version) {
    ledgerFail("LEDGER_SUPERSESSION_REQUIRED", "protocol or grade change requires explicit supersession");
  }
  if (head.idempotency_key !== current.idempotency_key || head.principal_ref !== current.principal_ref ||
    head.input_digest !== current.input_digest || head.policy_generation !== current.policy_generation ||
    head.deployment_generation !== current.deployment_generation) {
    ledgerFail("LEDGER_INPUT_INVALID", "ledger authority identity is immutable");
  }
}
async function storedEvent(database: LedgerD1Database, eventId: string): Promise<LedgerEvent | null> {
  const row = await database.prepare(LEDGER_SQL.selectByEventId).bind(eventId).first<EventRow>();
  return row === null ? null : decodeEvent(row);
}
async function appliedAlready(database: LedgerD1Database, head: LedgerHead, parsedEvent: LedgerEvent): Promise<LedgerHead | null> {
  const stored = await storedEvent(database, parsedEvent.event_id);
  if (stored === null) return null;
  if (!sameEvent(stored, parsedEvent)) ledgerFail("LEDGER_CONFLICT", "event id reused with different event bytes");
  const fresh = await readSnapshot(database, head.investigation_id);
  if (fresh !== null && sameHead(fresh.head, head) && fresh.events.some((item) => sameEvent(item, parsedEvent))) return fresh.head;
  ledgerFail("LEDGER_CONFLICT", "event id already bound to a committed event");
}
async function supersessionAlready(database: LedgerD1Database, oldHead: LedgerHead, oldEvent: LedgerEvent, newHead: LedgerHead, newEvent: LedgerEvent): Promise<{ oldHead: LedgerHead; newHead: LedgerHead } | null> {
  const a = await storedEvent(database, oldEvent.event_id);
  const b = await storedEvent(database, newEvent.event_id);
  if (a === null && b === null) return null;
  if ((a !== null && !sameEvent(a, oldEvent)) || (b !== null && !sameEvent(b, newEvent)) || a === null || b === null) ledgerFail("LEDGER_CONFLICT", "supersession event id reused with different event bytes");
  const freshOld = await readSnapshot(database, oldHead.investigation_id);
  const freshNew = await readSnapshot(database, newHead.investigation_id);
  if (freshOld !== null && freshNew !== null && sameHead(freshOld.head, oldHead) && sameHead(freshNew.head, newHead) && freshOld.events.some((item) => sameEvent(item, oldEvent)) && freshNew.events.some((item) => sameEvent(item, newEvent))) return { oldHead: freshOld.head, newHead: freshNew.head };
  ledgerFail("LEDGER_CONFLICT", "supersession event id already bound with divergent ledger bytes");
}
export function createD1InvestigationLedgerStore(database: LedgerD1Database): InvestigationLedgerStore {
  return {
    async create(rawHead, rawEvent, context?) {
      throwIfCancelled(context);
      const head = parseHead(rawHead);
      const firstEvent = parseEvent(rawEvent);
      if (firstEvent.sequence !== 1 || firstEvent.kind !== "CREATED" || firstEvent.investigation_id !== head.investigation_id) {
        ledgerFail("LEDGER_INPUT_INVALID", "first ledger event must be CREATED sequence 1");
      }
      if (head.revision !== 1 || head.event_head !== 1) ledgerFail("LEDGER_INPUT_INVALID", "new ledger head must start at revision 1 with one event");
      const byKey = await database.prepare(LEDGER_SQL.selectByIdempotency).bind(head.idempotency_key).first<HeadRow>();
      if (byKey !== null) {
        const existing = await readSnapshot(database, decodeHead(byKey).investigation_id);
        if (existing === null) ledgerFail("LEDGER_SETTLEMENT_UNCERTAIN", "idempotent readback missing", true);
        if (!sameHead(existing.head, head) || existing.events.length < 1 || !sameEvent(existing.events[0] as LedgerEvent, firstEvent)) {
          ledgerFail("LEDGER_CONFLICT", "idempotency identity already bound to different ledger bytes");
        }
        return { head: existing.head, disposition: "EXISTING" };
      }
      if (await database.prepare(LEDGER_SQL.selectHead).bind(head.investigation_id).first<HeadRow>() !== null) {
        ledgerFail("LEDGER_CONFLICT", "investigation id is already bound");
      }
      if (await database.prepare(LEDGER_SQL.selectByEventId).bind(firstEvent.event_id).first<EventRow>() !== null) {
        ledgerFail("LEDGER_CONFLICT", "event id is already bound");
      }
      try {
        const now = head.updated_at;
        const globalRow = await database.prepare("SELECT COALESCE(MAX(ledger_revision), 0) AS n FROM purge_ledger").bind().first<{ n: number }>().catch(() => ({ n: 0 }));
        const scopeRow = await database.prepare("SELECT purge_ledger_revision AS p FROM scope_snapshot WHERE snapshot_id = ?1 AND revision = ?2").bind(head.scope_snapshot_id, head.scope_snapshot_revision).first<{ p: number }>().catch(() => null);
        const fence: LedgerAuthorityFence = { principal_ref: head.principal_ref, scope_snapshot_id: head.scope_snapshot_id, scope_snapshot_revision: head.scope_snapshot_revision, policy_generation: head.policy_generation, policy_authority_ref: head.policy_authority_ref, deployment_generation: head.deployment_generation, purge_revision: globalRow?.n ?? 0, scope_purge_revision: scopeRow?.p ?? 0 };
        await materializeAuthority(database, fence, head.policy_authority_ref, now);
        const epoch = await readEpoch(database);
        const gid = guardIdFor(firstEvent.event_id);
        const batch = await database.batch([
          database.prepare(GUARD_SQL.insertGuard).bind(...guardParams(gid, "CREATE", head.investigation_id, null, 0, 1, 0, 1, firstEvent.event_id, null, fence, head.policy_authority_ref, epoch, now)),
          database.prepare(LEDGER_SQL.insertHead).bind(...headBindings(head)),
          database.prepare(LEDGER_SQL.insertEvent).bind(...eventBindings(firstEvent)),
          database.prepare(GUARD_SQL.consumeGuard).bind(gid),
        ]);
        if (batch.some((item) => (item.meta?.changes ?? 0) !== 1)) ledgerFail("LEDGER_SETTLEMENT_UNCERTAIN", "ledger batch did not settle", true);
      } catch (error) {
        if (error instanceof LedgerError) throw error;
        const raced = await database.prepare(LEDGER_SQL.selectByIdempotency).bind(head.idempotency_key).first<HeadRow>();
        if (raced !== null) {
          const existing = await readSnapshot(database, decodeHead(raced).investigation_id);
          if (existing !== null && sameHead(existing.head, head) && existing.events.length > 0 && sameEvent(existing.events[0] as LedgerEvent, firstEvent)) {
            return { head: existing.head, disposition: "EXISTING" };
          }
          ledgerFail("LEDGER_CONFLICT", "idempotency identity raced with different ledger bytes");
        }
        if (await database.prepare(LEDGER_SQL.selectByEventId).bind(firstEvent.event_id).first<EventRow>() !== null) {
          ledgerFail("LEDGER_CONFLICT", "event id raced with another ledger");
        }
        mapTriggerError(error);
      }
      const readback = await readSnapshot(database, head.investigation_id);
      if (readback === null) ledgerFail("LEDGER_SETTLEMENT_UNCERTAIN", "ledger create readback missing", true);
      if (!sameHead(readback.head, head)) ledgerFail("LEDGER_SETTLEMENT_UNCERTAIN", "ledger create readback diverged", true);
      return { head: readback.head, disposition: "CREATED" };
    },
    async read(investigationId) {
      if (typeof investigationId !== "string" || investigationId.length < 1) ledgerFail("LEDGER_INPUT_INVALID", "investigation id is invalid");
      return readSnapshot(database, investigationId);
    },
    async readByIdempotency(idempotencyKey) {
      const row = await database.prepare(LEDGER_SQL.selectByIdempotency).bind(idempotencyKey).first<HeadRow>();
      if (row === null) return null;
      return readSnapshot(database, decodeHead(row).investigation_id);
    },
    async append(nextHead, expectedRevision, event, context?) {
      throwIfCancelled(context);
      const head = parseHead(nextHead);
      const parsedEvent = parseEvent(event);
      const fastReplay = await appliedAlready(database, head, parsedEvent);
      if (fastReplay !== null) return fastReplay;
      const currentRow = await database.prepare(LEDGER_SQL.selectHead).bind(head.investigation_id).first<HeadRow>();
      if (currentRow === null) ledgerFail("LEDGER_CONFLICT", "unknown investigation ledger");
      const current = decodeHead(currentRow);
      checkAppendShape(head, current, parsedEvent, expectedRevision);
      const racedReplay = await appliedAlready(database, head, parsedEvent);
      if (racedReplay !== null) return racedReplay;
      const globalRow = await database.prepare("SELECT COALESCE(MAX(ledger_revision), 0) AS n FROM purge_ledger").bind().first<{ n: number }>().catch(() => ({ n: 0 }));
      const scopeRow = await database.prepare("SELECT purge_ledger_revision AS p FROM scope_snapshot WHERE snapshot_id = ?1 AND revision = ?2").bind(head.scope_snapshot_id, head.scope_snapshot_revision).first<{ p: number }>().catch(() => null);
      const fence: LedgerAuthorityFence = { principal_ref: head.principal_ref, scope_snapshot_id: head.scope_snapshot_id, scope_snapshot_revision: head.scope_snapshot_revision, policy_generation: head.policy_generation, policy_authority_ref: head.policy_authority_ref, deployment_generation: head.deployment_generation, purge_revision: globalRow?.n ?? 0, scope_purge_revision: scopeRow?.p ?? 0 };
      await materializeAuthority(database, fence, head.policy_authority_ref, head.updated_at);
      const epoch = await readEpoch(database);
      const gid = guardIdFor(parsedEvent.event_id);
      let applied: readonly { meta: { changes: number } }[];
      try {
        applied = await database.batch([
          database.prepare(GUARD_SQL.insertGuard).bind(...guardParams(gid, "APPEND", head.investigation_id, null, expectedRevision, head.revision, current.event_head, head.event_head, parsedEvent.event_id, null, fence, head.policy_authority_ref, epoch, head.updated_at)),
          database.prepare(LEDGER_SQL.insertEvent).bind(...eventBindings(parsedEvent)),
          database.prepare(LEDGER_SQL.casHead).bind(...casBindings(head, expectedRevision)),
          database.prepare(GUARD_SQL.consumeGuard).bind(gid),
        ]);
      } catch (error) {
        if (error instanceof LedgerError) throw error;
        const replayed = await appliedAlready(database, head, parsedEvent);
        if (replayed !== null) return replayed;
        if (error instanceof Error && /protocol\/grade change requires explicit supersession/i.test(error.message)) {
          ledgerFail("LEDGER_SUPERSESSION_REQUIRED", "protocol or grade change requires explicit supersession");
        }
        mapTriggerError(error);
      }
      if ((applied[2]?.meta?.changes ?? 0) !== 1) {
        const replayed = await appliedAlready(database, head, parsedEvent);
        if (replayed !== null) return replayed;
        ledgerFail("LEDGER_STALE_HEAD", "concurrent ledger head update lost the compare-and-swap");
      }
      if ((applied[1]?.meta?.changes ?? 0) !== 1) ledgerFail("LEDGER_SETTLEMENT_UNCERTAIN", "ledger event insert is uncertain", true);
      const readback = await readSnapshot(database, head.investigation_id);
      if (readback === null || !sameHead(readback.head, head)) ledgerFail("LEDGER_SETTLEMENT_UNCERTAIN", "ledger append readback diverged", true);
      return readback.head;
    },
    async supersede(rawOldHead, rawOldEvent, expectedOldRevision, rawNewHead, rawNewEvent, context?) {
      throwIfCancelled(context);
      const oldHead = parseHead(rawOldHead);
      const oldEvent = parseEvent(rawOldEvent);
      const newHead = parseHead(rawNewHead);
      const newEvent = parseEvent(rawNewEvent);
      if (newHead.revision !== 1 || newHead.event_head !== 1 || newEvent.sequence !== 1 || newEvent.kind !== "CREATED") {
        ledgerFail("LEDGER_INPUT_INVALID", "superseding ledger must start at revision 1 with one CREATED event");
      }
      if (newEvent.investigation_id !== newHead.investigation_id || oldEvent.investigation_id !== oldHead.investigation_id) {
        ledgerFail("LEDGER_INPUT_INVALID", "supersession events bound to another investigation");
      }
      if (newHead.investigation_id === oldHead.investigation_id || newHead.supersedes_id !== oldHead.investigation_id) {
        ledgerFail("LEDGER_INPUT_INVALID", "supersession requires a new cross-linked investigation id");
      }
      if (oldHead.revision !== expectedOldRevision + 1 || oldEvent.sequence !== oldHead.event_head || oldEvent.kind !== "SUPERSEDED") {
        ledgerFail("LEDGER_INPUT_INVALID", "supersession mark must append the next SUPERSEDED event");
      }
      const fastSupersession = await supersessionAlready(database, oldHead, oldEvent, newHead, newEvent);
      if (fastSupersession !== null) return fastSupersession;
      const currentRow = await database.prepare(LEDGER_SQL.selectHead).bind(oldHead.investigation_id).first<HeadRow>();
      if (currentRow === null) ledgerFail("LEDGER_CONFLICT", "unknown investigation ledger");
      const current = decodeHead(currentRow);
      if (current.revision !== expectedOldRevision) ledgerFail("LEDGER_STALE_HEAD", "stale expected revision for superseded head");
      if (oldHead.status !== "SUPERSEDED" || current.status !== "OPEN") ledgerFail("LEDGER_INPUT_INVALID", "only an open ledger can be superseded");
      if (oldHead.revision !== current.revision + 1 || oldHead.event_head !== current.event_head + 1) {
        ledgerFail("LEDGER_INPUT_INVALID", "supersession mark must advance revision and sequence by one");
      }
      if (await database.prepare(LEDGER_SQL.selectHead).bind(newHead.investigation_id).first<HeadRow>() !== null) {
        ledgerFail("LEDGER_CONFLICT", "superseding investigation id is already bound");
      }
      if (await database.prepare(LEDGER_SQL.selectByIdempotency).bind(newHead.idempotency_key).first<HeadRow>() !== null) {
        ledgerFail("LEDGER_CONFLICT", "superseding idempotency identity is already bound");
      }
      const racedSupersession = await supersessionAlready(database, oldHead, oldEvent, newHead, newEvent);
      if (racedSupersession !== null) return racedSupersession;
      const globalRow = await database.prepare("SELECT COALESCE(MAX(ledger_revision), 0) AS n FROM purge_ledger").bind().first<{ n: number }>().catch(() => ({ n: 0 }));
      const scopeRow = await database.prepare("SELECT purge_ledger_revision AS p FROM scope_snapshot WHERE snapshot_id = ?1 AND revision = ?2").bind(oldHead.scope_snapshot_id, oldHead.scope_snapshot_revision).first<{ p: number }>().catch(() => null);
      const fence: LedgerAuthorityFence = { principal_ref: oldHead.principal_ref, scope_snapshot_id: oldHead.scope_snapshot_id, scope_snapshot_revision: oldHead.scope_snapshot_revision, policy_generation: oldHead.policy_generation, policy_authority_ref: oldHead.policy_authority_ref, deployment_generation: oldHead.deployment_generation, purge_revision: globalRow?.n ?? 0, scope_purge_revision: scopeRow?.p ?? 0 };
      await materializeAuthority(database, fence, oldHead.policy_authority_ref, oldEvent.created_at);
      const epoch = await readEpoch(database);
      const gid = guardIdFor(oldEvent.event_id);
      try {
        const batch = await database.batch([
          database.prepare(GUARD_SQL.insertGuard).bind(...guardParams(gid, "SUPERSEDE", oldHead.investigation_id, newHead.investigation_id, expectedOldRevision, oldHead.revision, current.event_head, oldHead.event_head, oldEvent.event_id, newEvent.event_id, fence, oldHead.policy_authority_ref, epoch, oldEvent.created_at)),
          database.prepare(LEDGER_SQL.casHead).bind(...casBindings(oldHead, expectedOldRevision)),
          database.prepare(LEDGER_SQL.insertEvent).bind(...eventBindings(oldEvent)),
          database.prepare(LEDGER_SQL.insertHead).bind(...headBindings(newHead)),
          database.prepare(LEDGER_SQL.insertEvent).bind(...eventBindings(newEvent)),
          database.prepare(GUARD_SQL.consumeGuard).bind(gid),
        ]);
        if ((batch[1]?.meta?.changes ?? 0) !== 1) {
          const lost = await supersessionAlready(database, oldHead, oldEvent, newHead, newEvent);
          if (lost !== null) return lost;
          ledgerFail("LEDGER_STALE_HEAD", "concurrent ledger head update lost the supersession compare-and-swap");
        }
        if (batch.some((item) => (item.meta?.changes ?? 0) !== 1)) ledgerFail("LEDGER_SETTLEMENT_UNCERTAIN", "supersession batch did not settle", true);
      } catch (error) {
        if (error instanceof LedgerError) throw error;
        const replayedSupersession = await supersessionAlready(database, oldHead, oldEvent, newHead, newEvent);
        if (replayedSupersession !== null) return replayedSupersession;
        mapTriggerError(error);
      }
      const oldReadback = await readSnapshot(database, oldHead.investigation_id);
      const newReadback = await readSnapshot(database, newHead.investigation_id);
      if (oldReadback === null || newReadback === null || !sameHead(oldReadback.head, oldHead) || !sameHead(newReadback.head, newHead)) {
        ledgerFail("LEDGER_SETTLEMENT_UNCERTAIN", "supersession readback diverged", true);
      }
      if (oldReadback.head.status !== "SUPERSEDED" || newReadback.head.supersedes_id !== oldHead.investigation_id) {
        ledgerFail("LEDGER_SETTLEMENT_UNCERTAIN", "supersession lineage readback diverged", true);
      }
      return { oldHead: oldReadback.head, newHead: newReadback.head };
    },
  };
}
export interface LedgerHandleChecker {
  has(handleRef: string): Promise<boolean>;
  digestFor(handleRef: string): Promise<string | null>;
}
export interface CreateLedgerInput {
  readonly investigation_id: string; readonly goal: string; readonly scope_snapshot_id: string; readonly scope_snapshot_revision: number;
  readonly evidence_grade: "E0" | "E1" | "E2" | "E3"; readonly lane: "confirmatory" | "exploratory" | "mixed_with_declared_split";
  readonly lane_registrations: readonly string[]; readonly obligations: readonly LedgerObligation[]; readonly hypotheses: readonly string[];
  readonly portfolio_ref: string; readonly debt_refs: readonly string[]; readonly principal_ref: string; readonly input_digest: string;
  readonly policy_generation: string; readonly policy_authority_ref: string; readonly deployment_generation: string;
  readonly idempotency_key: string; readonly model_profile_ref: string; readonly event_id: string;
  readonly payload_handle_ref: string; readonly payload_digest: string; readonly created_at: string;
}
type ParsedCreate = z.infer<typeof CreateInputSchema>;
function parseCreate(raw: unknown): ParsedCreate {
  let parsed: ParsedCreate;
  try {
    parsed = CreateInputSchema.parse(raw);
  } catch (cause) {
    ledgerFail("LEDGER_INPUT_INVALID", "ledger input failed strict validation", false, cause);
  }
  const ids = new Set<string>();
  for (const obligation of parsed.obligations) {
    if (ids.has(obligation.obligation_id)) ledgerFail("LEDGER_CONFLICT", "duplicate obligation id");
    ids.add(obligation.obligation_id);
  }
  return { ...parsed, lane_registrations: [...parsed.lane_registrations], obligations: parsed.obligations.map((item) => ({ ...item })), hypotheses: [...parsed.hypotheses], debt_refs: [...parsed.debt_refs] };
}
export function createInvestigationLedgerService(
  store: InvestigationLedgerStore,
  fences: { current(): Promise<LedgerAuthorityFence> },
  handles: LedgerHandleChecker,
  clock: () => string = () => new Date().toISOString(),
): {
  create(input: CreateLedgerInput): Promise<LedgerHead>;
  checkpoint(investigationId: string, expectedRevision: number, checkpointHead: number, actor: string, eventId: string, handleRef: string, handleDigest: string): Promise<LedgerHead>;
  acceptObligation(investigationId: string, expectedRevision: number, obligationId: string, verifierRef: string, metricRef: string, actor: string, eventId: string, handleRef: string, handleDigest: string): Promise<LedgerHead>;
  recordDeviation(investigationId: string, expectedRevision: number, obligationId: string, actor: string, eventId: string, handleRef: string, handleDigest: string, observed: string): Promise<LedgerHead>;
  recordObserved(investigationId: string, expectedRevision: number, execution: string, fidelity: string, assurance: string, actor: string, eventId: string, handleRef: string, handleDigest: string): Promise<LedgerHead>;
  close(investigationId: string, expectedRevision: number, actor: string, eventId: string, handleRef: string, handleDigest: string): Promise<LedgerHead>;
  reopen(investigationId: string, expectedRevision: number, actor: string, eventId: string, handleRef: string, handleDigest: string): Promise<LedgerHead>;
  supersede(oldId: string, expectedRevision: number, input: CreateLedgerInput, reason: string, actor: string): Promise<LedgerHead>;
  read(investigationId: string): Promise<LedgerHead>;
} {
  async function requireHandle(handleRef: string, digest: string): Promise<void> {
    if (!HEX64.test(digest)) ledgerFail("LEDGER_INPUT_INVALID", "payload digest is malformed");
    if (handleRef.length < 1 || handleRef.length > 256) ledgerFail("LEDGER_INPUT_INVALID", "payload handle is invalid");
    let present: boolean;
    try {
      present = await handles.has(handleRef);
    } catch (cause) {
      ledgerFail("LEDGER_HANDLE_MISSING", "payload handle backend is unavailable", true, cause);
    }
    if (!present) ledgerFail("LEDGER_HANDLE_MISSING", "payload handle is missing");
    let actual: string | null;
    try {
      actual = await handles.digestFor(handleRef);
    } catch (cause) {
      ledgerFail("LEDGER_HANDLE_MISSING", "payload handle backend is unavailable", true, cause);
    }
    if (actual !== digest) ledgerFail("LEDGER_HANDLE_MISSING", "payload handle digest mismatched");
  }
  function checkFence(head: LedgerHead, fence: LedgerAuthorityFence): void {
    if (head.principal_ref !== fence.principal_ref) ledgerFail("LEDGER_PRINCIPAL_DENIED", "wrong principal for ledger");
    if (head.scope_snapshot_id !== fence.scope_snapshot_id || head.scope_snapshot_revision !== fence.scope_snapshot_revision) ledgerFail("LEDGER_SCOPE_FOREIGN", "foreign scope for ledger");
    if (head.policy_generation !== fence.policy_generation || head.policy_authority_ref !== fence.policy_authority_ref) ledgerFail("LEDGER_POLICY_STALE", "stale policy generation");
    if (head.deployment_generation !== fence.deployment_generation) ledgerFail("LEDGER_DEPLOYMENT_STALE", "stale deployment generation");
    if (fence.scope_purge_revision < fence.purge_revision) ledgerFail("LEDGER_PURGE_STALE", "scope is purged");
  }
  function checkOwner(head: LedgerHead, fence: LedgerAuthorityFence, actor: string): void {
    if (actor !== head.principal_ref || actor !== fence.principal_ref) ledgerFail("LEDGER_PRINCIPAL_DENIED", "foreign actor cannot mutate ledger");
  }
  async function loadForMutation(investigationId: string): Promise<LedgerSnapshot> {
    const snapshot = await store.read(investigationId);
    if (snapshot === null) ledgerFail("LEDGER_CONFLICT", "unknown investigation ledger");
    return snapshot;
  }
  function requireStableFence(pre: LedgerAuthorityFence, post: LedgerAuthorityFence): void {
    if (!sameLedgerFence(pre, post)) throw new LedgerError(ledgerFenceDriftCode(pre, post), "authority fence changed between preflight and write; no effect was committed");
  }
  async function guardOwner(head: LedgerHead, actor: string, pre: LedgerAuthorityFence): Promise<void> {
    const post = await fences.current();
    requireStableFence(pre, post);
    checkFence(head, post);
    checkOwner(head, post, actor);
  }
  function headFor(parsed: ParsedCreate, revision: number, eventHead: number, createdAt: string, updatedAt: string, extra: Partial<LedgerHead>): LedgerHead {
    return {
      investigation_id: parsed.investigation_id, revision, protocol_version: "eliotr.investigation.v1",
      goal: parsed.goal, scope_snapshot_id: parsed.scope_snapshot_id, scope_snapshot_revision: parsed.scope_snapshot_revision,
      evidence_grade: parsed.evidence_grade, lane: parsed.lane, lane_registrations: [...parsed.lane_registrations],
      obligations: parsed.obligations.map((item) => ({ ...item })), hypotheses: [...parsed.hypotheses],
      portfolio_ref: parsed.portfolio_ref, debt_refs: [...parsed.debt_refs], checkpoint_head: 0,
      principal_ref: parsed.principal_ref, input_digest: parsed.input_digest, policy_generation: parsed.policy_generation,
      policy_authority_ref: parsed.policy_authority_ref, deployment_generation: parsed.deployment_generation,
      idempotency_key: parsed.idempotency_key, model_profile_ref: parsed.model_profile_ref,
      observed_execution: null, observed_fidelity: null, observed_assurance: null,
      status: "OPEN", supersedes_id: null, supersession_reason: null, event_head: eventHead,
      created_at: createdAt, updated_at: updatedAt, ...extra,
    };
  }
  return {
    async create(raw) {
      const parsed = parseCreate(raw);
      const head = headFor(parsed, 1, 1, parsed.created_at, parsed.created_at, {});
      const pre = await fences.current();
      checkFence(head, pre);
      await requireHandle(parsed.payload_handle_ref, parsed.payload_digest);
      await requireHandle(parsed.portfolio_ref, parsed.input_digest);
      const event: LedgerEvent = { investigation_id: parsed.investigation_id, sequence: 1, event_id: parsed.event_id, kind: "CREATED", payload_handle_ref: parsed.payload_handle_ref, payload_digest: parsed.payload_digest, actor_ref: parsed.principal_ref, verifier_ref: null, created_at: parsed.created_at };
      requireStableFence(pre, await fences.current());
      return (await store.create(head, event)).head;
    },
    async checkpoint(investigationId, expectedRevision, checkpointHead, actor, eventId, handleRef, handleDigest) {
      await requireHandle(handleRef, handleDigest);
      const snapshot = await loadForMutation(investigationId);
      const fence = await fences.current();
      checkFence(snapshot.head, fence);
      checkOwner(snapshot.head, fence, actor);
      if (snapshot.head.status !== "OPEN") ledgerFail("LEDGER_INPUT_INVALID", "ledger is not open");
      if (!Number.isInteger(checkpointHead) || checkpointHead < 0 || checkpointHead > 1000000) ledgerFail("LEDGER_INPUT_INVALID", "checkpoint head is invalid");
      const now = clock();
      const next: LedgerHead = { ...snapshot.head, revision: snapshot.head.revision + 1, checkpoint_head: checkpointHead, event_head: snapshot.head.event_head + 1, updated_at: now };
      const event: LedgerEvent = { investigation_id: investigationId, sequence: snapshot.head.event_head + 1, event_id: eventId, kind: "CHECKPOINT", payload_handle_ref: handleRef, payload_digest: handleDigest, actor_ref: actor, verifier_ref: null, created_at: now };
      await guardOwner(snapshot.head, actor, fence);
      return store.append(next, expectedRevision, event);
    },
    async acceptObligation(investigationId, expectedRevision, obligationId, verifierRef, metricRef, actor, eventId, handleRef, handleDigest) {
      await requireHandle(handleRef, handleDigest);
      const snapshot = await loadForMutation(investigationId);
      const pre = await fences.current();
      checkFence(snapshot.head, pre);
      const obligation = snapshot.head.obligations.find((item) => item.obligation_id === obligationId);
      if (obligation === undefined) ledgerFail("LEDGER_INPUT_INVALID", "unknown obligation");
      if (obligation.verifier_ref !== verifierRef || actor !== verifierRef) ledgerFail("LEDGER_VERIFIER_DENIED", "only the named verifier accepts");
      if (obligation.status === "DEVIATED") ledgerFail("LEDGER_SUPERSESSION_REQUIRED", "deviated obligation requires explicit supersession");
      if (obligation.exposed && obligation.lane === "confirmatory" && obligation.metric_ref !== metricRef) {
        ledgerFail("LEDGER_SUPERSESSION_REQUIRED", "confirmatory metric changed after exposure");
      }
      const now = clock();
      const next: LedgerHead = {
        ...snapshot.head, revision: snapshot.head.revision + 1, event_head: snapshot.head.event_head + 1, updated_at: now,
        obligations: snapshot.head.obligations.map((item) => item.obligation_id === obligationId ? { ...item, status: "ACCEPTED" as const, metric_ref: metricRef } : item),
      };
      const event: LedgerEvent = { investigation_id: investigationId, sequence: snapshot.head.event_head + 1, event_id: eventId, kind: "OBLIGATION_ACCEPTED", payload_handle_ref: handleRef, payload_digest: handleDigest, actor_ref: actor, verifier_ref: verifierRef, created_at: now };
      requireStableFence(pre, await fences.current());
      return store.append(next, expectedRevision, event);
    },
    async recordDeviation(investigationId, expectedRevision, obligationId, actor, eventId, handleRef, handleDigest, observed) {
      await requireHandle(handleRef, handleDigest);
      if (observed.length < 1 || observed.length > 1024) ledgerFail("LEDGER_INPUT_INVALID", "observed note is invalid");
      const snapshot = await loadForMutation(investigationId);
      const fence = await fences.current();
      checkFence(snapshot.head, fence);
      checkOwner(snapshot.head, fence, actor);
      if (!snapshot.head.obligations.some((item) => item.obligation_id === obligationId)) ledgerFail("LEDGER_INPUT_INVALID", "unknown obligation");
      const now = clock();
      const next: LedgerHead = {
        ...snapshot.head, revision: snapshot.head.revision + 1, event_head: snapshot.head.event_head + 1, updated_at: now, observed_execution: observed,
        obligations: snapshot.head.obligations.map((item) => item.obligation_id === obligationId ? { ...item, status: "DEVIATED" as const } : item),
      };
      const event: LedgerEvent = { investigation_id: investigationId, sequence: snapshot.head.event_head + 1, event_id: eventId, kind: "DEVIATION", payload_handle_ref: handleRef, payload_digest: handleDigest, actor_ref: actor, verifier_ref: null, created_at: now };
      await guardOwner(snapshot.head, actor, fence);
      return store.append(next, expectedRevision, event);
    },
    async recordObserved(investigationId, expectedRevision, execution, fidelity, assurance, actor, eventId, handleRef, handleDigest) {
      await requireHandle(handleRef, handleDigest);
      for (const value of [execution, fidelity, assurance]) {
        if (value.length < 1 || value.length > 1024) ledgerFail("LEDGER_INPUT_INVALID", "observed value is invalid");
      }
      const snapshot = await loadForMutation(investigationId);
      const fence = await fences.current();
      checkFence(snapshot.head, fence);
      checkOwner(snapshot.head, fence, actor);
      const now = clock();
      const next: LedgerHead = { ...snapshot.head, revision: snapshot.head.revision + 1, event_head: snapshot.head.event_head + 1, updated_at: now, observed_execution: execution, observed_fidelity: fidelity, observed_assurance: assurance };
      const event: LedgerEvent = { investigation_id: investigationId, sequence: snapshot.head.event_head + 1, event_id: eventId, kind: "OBSERVED", payload_handle_ref: handleRef, payload_digest: handleDigest, actor_ref: actor, verifier_ref: null, created_at: now };
      await guardOwner(snapshot.head, actor, fence);
      return store.append(next, expectedRevision, event);
    },
    async close(investigationId, expectedRevision, actor, eventId, handleRef, handleDigest) {
      await requireHandle(handleRef, handleDigest);
      const snapshot = await loadForMutation(investigationId);
      const fence = await fences.current();
      checkFence(snapshot.head, fence);
      checkOwner(snapshot.head, fence, actor);
      if (snapshot.head.status !== "OPEN") ledgerFail("LEDGER_INPUT_INVALID", "ledger is not open");
      const now = clock();
      const next: LedgerHead = { ...snapshot.head, revision: snapshot.head.revision + 1, event_head: snapshot.head.event_head + 1, updated_at: now, status: "CLOSED" };
      const event: LedgerEvent = { investigation_id: investigationId, sequence: snapshot.head.event_head + 1, event_id: eventId, kind: "CLOSED", payload_handle_ref: handleRef, payload_digest: handleDigest, actor_ref: actor, verifier_ref: null, created_at: now };
      await guardOwner(snapshot.head, actor, fence);
      return store.append(next, expectedRevision, event);
    },
    async reopen(investigationId, expectedRevision, actor, eventId, handleRef, handleDigest) {
      await requireHandle(handleRef, handleDigest);
      const snapshot = await loadForMutation(investigationId);
      const fence = await fences.current();
      checkFence(snapshot.head, fence);
      checkOwner(snapshot.head, fence, actor);
      if (snapshot.head.status !== "CLOSED") ledgerFail("LEDGER_INPUT_INVALID", "ledger is not closed");
      const now = clock();
      const next: LedgerHead = { ...snapshot.head, revision: snapshot.head.revision + 1, event_head: snapshot.head.event_head + 1, updated_at: now, status: "OPEN" };
      const event: LedgerEvent = { investigation_id: investigationId, sequence: snapshot.head.event_head + 1, event_id: eventId, kind: "REOPENED", payload_handle_ref: handleRef, payload_digest: handleDigest, actor_ref: actor, verifier_ref: null, created_at: now };
      await guardOwner(snapshot.head, actor, fence);
      return store.append(next, expectedRevision, event);
    },
    async supersede(oldId, expectedRevision, input, reason, actor) {
      if (reason.length < 1 || reason.length > 1024) ledgerFail("LEDGER_INPUT_INVALID", "supersession reason is invalid");
      const parsed = parseCreate(input);
      if (parsed.investigation_id === oldId) ledgerFail("LEDGER_INPUT_INVALID", "supersession requires a new investigation id");
      const snapshot = await loadForMutation(oldId);
      const pre = await fences.current();
      checkFence(snapshot.head, pre);
      checkOwner(snapshot.head, pre, actor);
      if (parsed.principal_ref !== pre.principal_ref || actor !== parsed.principal_ref) {
        ledgerFail("LEDGER_PRINCIPAL_DENIED", "superseding principal must match the fenced actor");
      }
      checkFence({ ...snapshot.head, principal_ref: parsed.principal_ref, scope_snapshot_id: parsed.scope_snapshot_id, scope_snapshot_revision: parsed.scope_snapshot_revision, policy_generation: parsed.policy_generation, policy_authority_ref: parsed.policy_authority_ref, deployment_generation: parsed.deployment_generation }, pre);
      await requireHandle(parsed.payload_handle_ref, parsed.payload_digest);
      await requireHandle(parsed.portfolio_ref, parsed.input_digest);
      if (snapshot.head.status === "SUPERSEDED") {
        const prior = await store.read(parsed.investigation_id);
        if (prior === null) ledgerFail("LEDGER_INPUT_INVALID", "only an open ledger can be superseded");
        const want = headFor(parsed, 1, 1, prior.head.created_at, prior.head.updated_at, { supersedes_id: oldId, supersession_reason: reason });
        if (!sameHead(prior.head, want)) ledgerFail("LEDGER_CONFLICT", "supersession identity already bound to different ledger bytes");
        const markId = `supersede-${parsed.event_id}`;
        const storedMark = snapshot.events.find((item) => item.event_id === markId);
        const storedNew = prior.events.find((item) => item.event_id === parsed.event_id);
        if (storedMark === undefined || storedNew === undefined) ledgerFail("LEDGER_CONFLICT", "supersession identity already bound to different ledger bytes");
        const wantMark: LedgerEvent = { investigation_id: oldId, sequence: snapshot.head.event_head, event_id: markId, kind: "SUPERSEDED", payload_handle_ref: parsed.payload_handle_ref, payload_digest: parsed.payload_digest, actor_ref: actor, verifier_ref: null, created_at: prior.head.created_at };
        const wantNew: LedgerEvent = { investigation_id: parsed.investigation_id, sequence: 1, event_id: parsed.event_id, kind: "CREATED", payload_handle_ref: parsed.payload_handle_ref, payload_digest: parsed.payload_digest, actor_ref: actor, verifier_ref: null, created_at: prior.head.created_at };
        if (!sameEvent(storedMark, wantMark) || !sameEvent(storedNew, wantNew)) ledgerFail("LEDGER_CONFLICT", "supersession identity already bound to different ledger bytes");
        return prior.head;
      }
      const now = clock();
      const marked: LedgerHead = { ...snapshot.head, revision: snapshot.head.revision + 1, event_head: snapshot.head.event_head + 1, updated_at: now, status: "SUPERSEDED", supersession_reason: reason };
      const markEvent: LedgerEvent = { investigation_id: oldId, sequence: snapshot.head.event_head + 1, event_id: `supersede-${parsed.event_id}`, kind: "SUPERSEDED", payload_handle_ref: parsed.payload_handle_ref, payload_digest: parsed.payload_digest, actor_ref: actor, verifier_ref: null, created_at: now };
      const head = headFor(parsed, 1, 1, now, now, { supersedes_id: oldId, supersession_reason: reason });
      const event: LedgerEvent = { investigation_id: parsed.investigation_id, sequence: 1, event_id: parsed.event_id, kind: "CREATED", payload_handle_ref: parsed.payload_handle_ref, payload_digest: parsed.payload_digest, actor_ref: actor, verifier_ref: null, created_at: now };
      requireStableFence(pre, await fences.current());
      return (await store.supersede(marked, markEvent, expectedRevision, head, event)).newHead;
    },
    async read(investigationId) {
      const snapshot = await store.read(investigationId);
      if (snapshot === null) ledgerFail("LEDGER_CONFLICT", "unknown investigation ledger");
      return snapshot.head;
    },
  };
}
