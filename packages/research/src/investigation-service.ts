// IMPLEMENTED_NOT_LIVE: ER-08/ER-13 versioned Investigation ledger over D1 with atomic batch append, generation fences and explicit supersession; Workflow/Session composition and live receipts remain separate.
import type { Investigation, InquiryProtocolProfile, ScopeSnapshot, VersionedRef } from "@eliotr/contracts";
import { z } from "zod";
import {
  LEDGER_SQL, LedgerError, LedgerEventSchema, LedgerHeadSchema,
  type InvestigationLedgerStore, type LedgerAuthorityFence, type LedgerEvent, type LedgerHead,
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
  investigation_id: ID, goal: GOAL, scope_snapshot_id: REF256,
  scope_snapshot_revision: z.number().int().min(1).max(1000000), evidence_grade: GRADE, lane: LANE,
  lane_registrations: z.array(REF256).max(16), obligations: z.array(ObligationSchema).max(32),
  hypotheses: z.array(z.string().min(1).max(1024)).max(32), portfolio_ref: HANDLE,
  debt_refs: z.array(REF256).max(32), principal_ref: REF256, input_digest: DIGEST,
  policy_generation: GENERATION, policy_authority_ref: REF256, deployment_generation: GENERATION,
  idempotency_key: REF256, model_profile_ref: REF256, event_id: ID,
  payload_handle_ref: HANDLE, payload_digest: DIGEST, created_at: ISO,
}).strict();
function ledgerFail(code: "LEDGER_INPUT_INVALID" | "LEDGER_CONFLICT" | "LEDGER_STALE_HEAD" | "LEDGER_PRINCIPAL_DENIED" | "LEDGER_SCOPE_FOREIGN" | "LEDGER_POLICY_STALE" | "LEDGER_DEPLOYMENT_STALE" | "LEDGER_PURGE_STALE" | "LEDGER_VERIFIER_DENIED" | "LEDGER_SUPERSESSION_REQUIRED" | "LEDGER_HANDLE_MISSING" | "LEDGER_SETTLEMENT_UNCERTAIN", message: string, retryable = false, cause?: unknown): never {
  throw new LedgerError(code, message, retryable, cause);
}
interface HeadRow {
  readonly investigation_id: unknown; readonly revision: unknown; readonly protocol_version: unknown; readonly goal: unknown;
  readonly scope_snapshot_id: unknown; readonly scope_snapshot_revision: unknown; readonly evidence_grade: unknown; readonly lane: unknown;
  readonly lane_registrations_json: unknown; readonly obligations_json: unknown; readonly hypotheses_json: unknown; readonly portfolio_ref: unknown;
  readonly debt_refs_json: unknown; readonly checkpoint_head: unknown; readonly principal_ref: unknown; readonly input_digest: unknown;
  readonly policy_generation: unknown; readonly policy_authority_ref: unknown; readonly deployment_generation: unknown; readonly idempotency_key: unknown;
  readonly model_profile_ref: unknown; readonly observed_execution: unknown; readonly observed_fidelity: unknown; readonly observed_assurance: unknown;
  readonly status: unknown; readonly supersedes_id: unknown; readonly supersession_reason: unknown; readonly event_head: unknown;
  readonly created_at: unknown; readonly updated_at: unknown;
}
interface EventRow {
  readonly investigation_id: unknown; readonly sequence: unknown; readonly event_id: unknown; readonly kind: unknown;
  readonly payload_handle_ref: unknown; readonly payload_digest: unknown; readonly actor_ref: unknown; readonly verifier_ref: unknown;
  readonly created_at: unknown;
}
function parseHead(value: unknown): LedgerHead {
  try {
    return LedgerHeadSchema.parse(value);
  } catch (cause) {
    ledgerFail("LEDGER_INPUT_INVALID", "ledger head failed strict validation", false, cause);
  }
}
function parseEvent(value: unknown): LedgerEvent {
  try {
    return LedgerEventSchema.parse(value);
  } catch (cause) {
    ledgerFail("LEDGER_INPUT_INVALID", "ledger event failed strict validation", false, cause);
  }
}
function decodeHead(row: HeadRow): LedgerHead {
  try {
    const parsed = LedgerHeadSchema.parse({
      investigation_id: row.investigation_id, revision: row.revision, protocol_version: row.protocol_version,
      goal: row.goal, scope_snapshot_id: row.scope_snapshot_id, scope_snapshot_revision: row.scope_snapshot_revision,
      evidence_grade: row.evidence_grade, lane: row.lane, lane_registrations: JSON.parse(String(row.lane_registrations_json)),
      obligations: JSON.parse(String(row.obligations_json)), hypotheses: JSON.parse(String(row.hypotheses_json)),
      portfolio_ref: row.portfolio_ref, debt_refs: JSON.parse(String(row.debt_refs_json)), checkpoint_head: row.checkpoint_head,
      principal_ref: row.principal_ref, input_digest: row.input_digest, policy_generation: row.policy_generation,
      policy_authority_ref: row.policy_authority_ref, deployment_generation: row.deployment_generation, idempotency_key: row.idempotency_key,
      model_profile_ref: row.model_profile_ref, observed_execution: row.observed_execution, observed_fidelity: row.observed_fidelity,
      observed_assurance: row.observed_assurance, status: row.status, supersedes_id: row.supersedes_id,
      supersession_reason: row.supersession_reason, event_head: row.event_head, created_at: row.created_at, updated_at: row.updated_at,
    });
    return { ...parsed, lane_registrations: [...parsed.lane_registrations], obligations: [...parsed.obligations], hypotheses: [...parsed.hypotheses], debt_refs: [...parsed.debt_refs] };
  } catch (cause) {
    ledgerFail("LEDGER_INPUT_INVALID", "stored ledger head is malformed", false, cause);
  }
}
function decodeEvent(row: EventRow): LedgerEvent {
  try {
    return LedgerEventSchema.parse({
      investigation_id: row.investigation_id, sequence: row.sequence, event_id: row.event_id, kind: row.kind,
      payload_handle_ref: row.payload_handle_ref, payload_digest: row.payload_digest, actor_ref: row.actor_ref,
      verifier_ref: row.verifier_ref, created_at: row.created_at,
    });
  } catch (cause) {
    ledgerFail("LEDGER_INPUT_INVALID", "stored ledger event is malformed", false, cause);
  }
}
function headBindings(head: LedgerHead): readonly unknown[] {
  return [head.investigation_id, head.revision, head.protocol_version, head.goal, head.scope_snapshot_id,
    head.scope_snapshot_revision, head.evidence_grade, head.lane, JSON.stringify([...head.lane_registrations]),
    JSON.stringify([...head.obligations]), JSON.stringify([...head.hypotheses]), head.portfolio_ref,
    JSON.stringify([...head.debt_refs]), head.checkpoint_head, head.principal_ref, head.input_digest,
    head.policy_generation, head.policy_authority_ref, head.deployment_generation, head.idempotency_key,
    head.model_profile_ref, head.observed_execution, head.observed_fidelity, head.observed_assurance,
    head.status, head.supersedes_id, head.supersession_reason, head.event_head, head.created_at, head.updated_at];
}
function casBindings(head: LedgerHead, expectedRevision: number): readonly unknown[] {
  return [head.investigation_id, expectedRevision, head.revision, JSON.stringify([...head.lane_registrations]),
    JSON.stringify([...head.obligations]), JSON.stringify([...head.hypotheses]), head.portfolio_ref,
    JSON.stringify([...head.debt_refs]), head.checkpoint_head, head.observed_execution, head.observed_fidelity,
    head.observed_assurance, head.status, head.supersedes_id, head.supersession_reason, head.event_head, head.updated_at];
}
function eventBindings(event: LedgerEvent): readonly unknown[] {
  return [event.investigation_id, event.sequence, event.event_id, event.kind, event.payload_handle_ref,
    event.payload_digest, event.actor_ref, event.verifier_ref, event.created_at];
}
function sameHead(left: LedgerHead, right: LedgerHead): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}
function sameEvent(left: LedgerEvent, right: LedgerEvent): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
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
async function appliedAlready(database: LedgerD1Database, head: LedgerHead, parsedEvent: LedgerEvent): Promise<LedgerHead | null> {
  const fresh = await readSnapshot(database, head.investigation_id);
  if (fresh !== null && sameHead(fresh.head, head) && fresh.events.some((item) => item.event_id === parsedEvent.event_id)) return fresh.head;
  return null;
}
export function createD1InvestigationLedgerStore(database: LedgerD1Database): InvestigationLedgerStore {
  return {
    async create(rawHead, rawEvent) {
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
        const batch = await database.batch([
          database.prepare(LEDGER_SQL.insertHead).bind(...headBindings(head)),
          database.prepare(LEDGER_SQL.insertEventIfRevision).bind(...eventBindings(firstEvent), head.revision),
        ]);
        if ((batch[0]?.meta?.changes ?? 0) !== 1 || (batch[1]?.meta?.changes ?? 0) !== 1) {
          ledgerFail("LEDGER_SETTLEMENT_UNCERTAIN", "ledger batch did not mutate exactly two rows", true);
        }
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
        if (error instanceof Error && /ABORT|UNIQUE|CHECK|constraint|append-only/i.test(error.message)) {
          ledgerFail("LEDGER_CONFLICT", "ledger create conflicted with existing rows");
        }
        ledgerFail("LEDGER_SETTLEMENT_UNCERTAIN", "ledger create outcome is unknown", true, error);
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
    async append(nextHead, expectedRevision, event) {
      const head = parseHead(nextHead);
      const parsedEvent = parseEvent(event);
      const currentRow = await database.prepare(LEDGER_SQL.selectHead).bind(head.investigation_id).first<HeadRow>();
      if (currentRow === null) ledgerFail("LEDGER_CONFLICT", "unknown investigation ledger");
      const current = decodeHead(currentRow);
      checkAppendShape(head, current, parsedEvent, expectedRevision);
      if (await database.prepare(LEDGER_SQL.selectByEventId).bind(parsedEvent.event_id).first<EventRow>() !== null) {
        ledgerFail("LEDGER_CONFLICT", "event id is already bound");
      }
      let applied: readonly { meta: { changes: number } }[];
      try {
        applied = await database.batch([
          database.prepare(LEDGER_SQL.insertEventIfRevision).bind(...eventBindings(parsedEvent), expectedRevision),
          database.prepare(LEDGER_SQL.casHead).bind(...casBindings(head, expectedRevision)),
        ]);
      } catch (error) {
        if (error instanceof LedgerError) throw error;
        const replayed = await appliedAlready(database, head, parsedEvent);
        if (replayed !== null) return replayed;
        if (error instanceof Error && /protocol\/grade change requires explicit supersession/i.test(error.message)) {
          ledgerFail("LEDGER_SUPERSESSION_REQUIRED", "protocol or grade change requires explicit supersession");
        }
        if (error instanceof Error && /ABORT|UNIQUE|CHECK|constraint|append-only/i.test(error.message)) ledgerFail("LEDGER_CONFLICT", "ledger append conflicted");
        ledgerFail("LEDGER_SETTLEMENT_UNCERTAIN", "ledger append outcome is unknown", true, error);
      }
      if ((applied[1]?.meta?.changes ?? 0) !== 1) {
        const replayed = await appliedAlready(database, head, parsedEvent);
        if (replayed !== null) return replayed;
        ledgerFail("LEDGER_STALE_HEAD", "concurrent ledger head update lost the compare-and-swap");
      }
      if ((applied[0]?.meta?.changes ?? 0) !== 1) ledgerFail("LEDGER_SETTLEMENT_UNCERTAIN", "ledger event insert is uncertain", true);
      const readback = await readSnapshot(database, head.investigation_id);
      if (readback === null || !sameHead(readback.head, head)) ledgerFail("LEDGER_SETTLEMENT_UNCERTAIN", "ledger append readback diverged", true);
      return readback.head;
    },
    async supersede(rawOldHead, rawOldEvent, expectedOldRevision, rawNewHead, rawNewEvent) {
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
      const currentRow = await database.prepare(LEDGER_SQL.selectHead).bind(oldHead.investigation_id).first<HeadRow>();
      if (currentRow === null) ledgerFail("LEDGER_CONFLICT", "unknown investigation ledger");
      const current = decodeHead(currentRow);
      if (current.revision !== expectedOldRevision) ledgerFail("LEDGER_STALE_HEAD", "stale expected revision for superseded head");
      if (oldHead.revision !== current.revision + 1 || oldHead.event_head !== current.event_head + 1) {
        ledgerFail("LEDGER_INPUT_INVALID", "supersession mark must advance revision and sequence by one");
      }
      if (await database.prepare(LEDGER_SQL.selectHead).bind(newHead.investigation_id).first<HeadRow>() !== null) {
        ledgerFail("LEDGER_CONFLICT", "superseding investigation id is already bound");
      }
      if (await database.prepare(LEDGER_SQL.selectByIdempotency).bind(newHead.idempotency_key).first<HeadRow>() !== null) {
        ledgerFail("LEDGER_CONFLICT", "superseding idempotency identity is already bound");
      }
      for (const candidate of [oldEvent, newEvent]) {
        if (await database.prepare(LEDGER_SQL.selectByEventId).bind(candidate.event_id).first<EventRow>() !== null) {
          ledgerFail("LEDGER_CONFLICT", "supersession event id is already bound");
        }
      }
      try {
        const batch = await database.batch([
          database.prepare(LEDGER_SQL.insertHead).bind(...headBindings(newHead)),
          database.prepare(LEDGER_SQL.insertEventIfRevision).bind(...eventBindings(newEvent), newHead.revision),
          database.prepare(LEDGER_SQL.casHead).bind(...casBindings(oldHead, expectedOldRevision)),
          database.prepare(LEDGER_SQL.insertEventIfRevision).bind(...eventBindings(oldEvent), oldHead.revision),
        ]);
        if (batch.some((item) => (item.meta?.changes ?? 0) !== 1)) ledgerFail("LEDGER_SETTLEMENT_UNCERTAIN", "supersession batch did not settle all four rows", true);
      } catch (error) {
        if (error instanceof LedgerError) throw error;
        const freshOld = await readSnapshot(database, oldHead.investigation_id);
        const freshNew = await readSnapshot(database, newHead.investigation_id);
        if (freshOld !== null && freshNew !== null && sameHead(freshOld.head, oldHead) && sameHead(freshNew.head, newHead) &&
          freshOld.events.some((item) => item.event_id === oldEvent.event_id) && freshNew.events.some((item) => item.event_id === newEvent.event_id)) {
          return { oldHead: freshOld.head, newHead: freshNew.head };
        }
        if (error instanceof Error && /ABORT|UNIQUE|CHECK|constraint|append-only/i.test(error.message)) {
          ledgerFail("LEDGER_CONFLICT", "supersession conflicted with existing rows");
        }
        ledgerFail("LEDGER_SETTLEMENT_UNCERTAIN", "supersession outcome is unknown", true, error);
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
    if (head.scope_snapshot_id !== fence.scope_snapshot_id || head.scope_snapshot_revision !== fence.scope_snapshot_revision) {
      ledgerFail("LEDGER_SCOPE_FOREIGN", "foreign scope for ledger");
    }
    if (head.policy_generation !== fence.policy_generation) ledgerFail("LEDGER_POLICY_STALE", "stale policy generation");
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
  async function guardOwner(head: LedgerHead, actor: string): Promise<void> {
    const fence = await fences.current();
    checkFence(head, fence);
    checkOwner(head, fence, actor);
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
      checkFence(head, await fences.current());
      await requireHandle(parsed.payload_handle_ref, parsed.payload_digest);
      await requireHandle(parsed.portfolio_ref, parsed.input_digest);
      const event: LedgerEvent = {
        investigation_id: parsed.investigation_id, sequence: 1, event_id: parsed.event_id, kind: "CREATED",
        payload_handle_ref: parsed.payload_handle_ref, payload_digest: parsed.payload_digest,
        actor_ref: parsed.principal_ref, verifier_ref: null, created_at: parsed.created_at,
      };
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
      await guardOwner(snapshot.head, actor);
      return store.append(next, expectedRevision, event);
    },
    async acceptObligation(investigationId, expectedRevision, obligationId, verifierRef, metricRef, actor, eventId, handleRef, handleDigest) {
      await requireHandle(handleRef, handleDigest);
      const snapshot = await loadForMutation(investigationId);
      checkFence(snapshot.head, await fences.current());
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
      checkFence(snapshot.head, await fences.current());
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
      await guardOwner(snapshot.head, actor);
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
      await guardOwner(snapshot.head, actor);
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
      await guardOwner(snapshot.head, actor);
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
      await guardOwner(snapshot.head, actor);
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
      if (snapshot.head.status !== "OPEN") ledgerFail("LEDGER_INPUT_INVALID", "only an open ledger can be superseded");
      if (snapshot.head.revision !== expectedRevision) ledgerFail("LEDGER_STALE_HEAD", "stale expected revision");
      if (parsed.principal_ref !== pre.principal_ref || actor !== parsed.principal_ref) {
        ledgerFail("LEDGER_PRINCIPAL_DENIED", "superseding principal must match the fenced actor");
      }
      checkFence({ ...snapshot.head, principal_ref: parsed.principal_ref, scope_snapshot_id: parsed.scope_snapshot_id, scope_snapshot_revision: parsed.scope_snapshot_revision, policy_generation: parsed.policy_generation, deployment_generation: parsed.deployment_generation }, pre);
      await requireHandle(parsed.payload_handle_ref, parsed.payload_digest);
      await requireHandle(parsed.portfolio_ref, parsed.input_digest);
      const now = clock();
      const marked: LedgerHead = { ...snapshot.head, revision: snapshot.head.revision + 1, event_head: snapshot.head.event_head + 1, updated_at: now, status: "SUPERSEDED", supersession_reason: reason };
      const markEvent: LedgerEvent = { investigation_id: oldId, sequence: snapshot.head.event_head + 1, event_id: `supersede-${parsed.event_id}`, kind: "SUPERSEDED", payload_handle_ref: parsed.payload_handle_ref, payload_digest: parsed.payload_digest, actor_ref: actor, verifier_ref: null, created_at: now };
      const head = headFor(parsed, 1, 1, now, now, { supersedes_id: oldId, supersession_reason: reason });
      const event: LedgerEvent = { investigation_id: parsed.investigation_id, sequence: 1, event_id: parsed.event_id, kind: "CREATED", payload_handle_ref: parsed.payload_handle_ref, payload_digest: parsed.payload_digest, actor_ref: actor, verifier_ref: null, created_at: now };
      return (await store.supersede(marked, markEvent, expectedRevision, head, event)).newHead;
    },
    async read(investigationId) {
      const snapshot = await store.read(investigationId);
      if (snapshot === null) ledgerFail("LEDGER_CONFLICT", "unknown investigation ledger");
      return snapshot.head;
    },
  };
}
