// ER-08/ER-13 FIX4: atomic single-statement ledger command builders.
// FIX5: strict canonical UTC timestamps plus exhaustive event-kind mutation masks.
//
// Every create/append/supersede mutation is exactly ONE INSERT into
// investigation_ledger_command (see infra/d1/core/migrations/0016_* and 0017_*).
// The BEFORE INSERT triggers validate fence, epoch, canonical time, D1
// current-time bounds, actor/verifier binding, op shape and per-kind mutation
// masks; the AFTER INSERT trigger program performs every head/event effect in
// the same statement. Column order here MUST match the 0016 table definition
// exactly; the ledger-commands test asserts COMMAND_COLUMNS against the
// migrated table.
import {
  LedgerError, ledgerEventBindings, ledgerHeadBindings,
  type LedgerAuthorityFence, type LedgerEvent, type LedgerHead,
} from "./ports.js";

// FIX5 P1-B: strict canonical UTC millis-Z. SQLite julianday() yields NULL for
// malformed text, which silently disables WHEN/CHECK time bounds, so every
// timestamp is shape + calendar + round-trip validated BEFORE any julianday
// comparison, in TS here and in the 0017 D1 triggers.
const CANONICAL_TS_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

export function isCanonicalLedgerTimestamp(value: unknown): value is string {
  if (typeof value !== "string" || !CANONICAL_TS_RE.test(value)) return false;
  const month = Number(value.slice(5, 7));
  const day = Number(value.slice(8, 10));
  const hour = Number(value.slice(11, 13));
  const minute = Number(value.slice(14, 16));
  const second = Number(value.slice(17, 19));
  if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59 || second > 59) return false;
  const millis = Date.parse(value);
  if (!Number.isFinite(millis)) return false;
  const date = new Date(millis);
  // Leap-aware day-of-month ceiling for the stated month.
  if (day > new Date(Date.UTC(date.getUTCFullYear(), month, 0)).getUTCDate()) return false;
  return date.toISOString() === value;
}

export function assertCanonicalLedgerTimestamp(value: unknown, what = "timestamp"): asserts value is string {
  if (!isCanonicalLedgerTimestamp(value)) {
    throw new LedgerError("LEDGER_INPUT_INVALID", `ledger ${what} is not canonical UTC millis-Z`);
  }
}

function assertHeadEventTimes(head: LedgerHead | null, event: LedgerEvent | null, observedAt: string): void {
  assertCanonicalLedgerTimestamp(observedAt, "observed_at");
  if (head !== null) {
    assertCanonicalLedgerTimestamp(head.created_at, "head created_at");
    assertCanonicalLedgerTimestamp(head.updated_at, "head updated_at");
  }
  if (event !== null) {
    assertCanonicalLedgerTimestamp(event.created_at, "event created_at");
  }
}

// FIX5 P1-A: exhaustive event-kind-to-field mutation masks for APPEND. The
// caller-supplied next head is untrusted: only the fields reserved to the
// event kind may differ from the live D1 head, and semantic transition rules
// (single-obligation flip, named-verifier binding, exposed-metric freeze,
// observed/status preconditions, append-only growth) hold in TS here and in
// the 0017 D1 triggers. Lower-authority kinds can never touch acceptance,
// lineage, portfolio/debt, observed, or status fields.
const APPEND_ALLOWED_KINDS: readonly LedgerEvent["kind"][] = [
  "LANE_REGISTERED", "OBLIGATION_REGISTERED", "OBLIGATION_ACCEPTED", "CHECKPOINT",
  "HYPOTHESIS_RECORDED", "OBSERVED", "DEVIATION", "CLOSED", "REOPENED",
];

function maskFail(message: string): never {
  throw new LedgerError("LEDGER_INPUT_INVALID", message);
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function singleObligationFlip(
  current: LedgerHead, next: LedgerHead, event: LedgerEvent,
  from: "REGISTERED" | "ACCEPTED" | "REGISTERED_OR_ACCEPTED", to: "ACCEPTED" | "DEVIATED",
): { index: number } {
  const cur = current.obligations;
  const nxt = next.obligations;
  if (nxt.length !== cur.length) maskFail("obligation cardinality changed outside registration");
  let found = -1;
  for (let index = 0; index < cur.length; index += 1) {
    const a = cur[index] as LedgerHead["obligations"][number];
    const b = nxt[index] as LedgerHead["obligations"][number];
    if (sameJson(a, b)) continue;
    if (found !== -1) maskFail("more than one obligation changed in a single event");
    found = index;
    const okFrom = from === "REGISTERED_OR_ACCEPTED"
      ? (a.status === "REGISTERED" || a.status === "ACCEPTED")
      : a.status === from;
    if (!okFrom || b.status !== to) {
      if (a.status === "DEVIATED" && to === "ACCEPTED") {
        throw new LedgerError("LEDGER_SUPERSESSION_REQUIRED", "deviated obligation requires explicit supersession");
      }
      maskFail("obligation status transition is not permitted for this event kind");
    }
    if (a.obligation_id !== b.obligation_id || a.verifier_ref !== b.verifier_ref ||
      a.lane !== b.lane || a.exposed !== b.exposed) {
      maskFail("obligation identity changed outside registration");
    }
    if (to === "ACCEPTED") {
      if (b.verifier_ref !== event.verifier_ref || event.actor_ref !== event.verifier_ref) {
        throw new LedgerError("LEDGER_VERIFIER_DENIED", "only the named verifier accepts");
      }
    } else if (b.metric_ref !== a.metric_ref) {
      maskFail("deviation must not rewrite the obligation metric");
    }
    if (a.exposed && a.lane === "confirmatory" && b.metric_ref !== a.metric_ref) {
      throw new LedgerError("LEDGER_SUPERSESSION_REQUIRED", "confirmatory metric changed after exposure");
    }
  }
  if (found === -1) maskFail("event kind requires its reserved field to advance");
  return { index: found };
}

export function assertAppendMutationMask(current: LedgerHead, next: LedgerHead, event: LedgerEvent): void {
  if (!APPEND_ALLOWED_KINDS.includes(event.kind)) {
    maskFail("event kind requires an explicit create or supersede command");
  }
  // Immutable and cross-command families: never mutable via APPEND.
  if (next.portfolio_ref !== current.portfolio_ref || !sameJson(next.debt_refs, current.debt_refs)) {
    maskFail("portfolio or debt refs are immutable outside supersession");
  }
  if (next.goal !== current.goal || next.lane !== current.lane ||
    next.model_profile_ref !== current.model_profile_ref || next.created_at !== current.created_at ||
    next.supersedes_id !== current.supersedes_id || next.supersession_reason !== current.supersession_reason) {
    maskFail("lineage or descriptive identity changed outside supersession");
  }
  const laneSame = sameJson(next.lane_registrations, current.lane_registrations);
  const oblSame = sameJson(next.obligations, current.obligations);
  const hypSame = sameJson(next.hypotheses, current.hypotheses);
  const chkSame = next.checkpoint_head === current.checkpoint_head;
  const obsSame = next.observed_execution === current.observed_execution &&
    next.observed_fidelity === current.observed_fidelity &&
    next.observed_assurance === current.observed_assurance;
  switch (event.kind) {
    case "CHECKPOINT": {
      if (current.status !== "OPEN" || next.status !== "OPEN") maskFail("checkpoint requires an open ledger");
      if (!oblSame || !hypSame || !laneSame || !obsSame) maskFail("checkpoint mutated a protected family");
      break;
    }
    case "OBLIGATION_ACCEPTED": {
      if (current.status !== "OPEN" || next.status !== "OPEN") maskFail("acceptance requires an open ledger");
      // Event-level verifier binding first: mirrors D1 firing order so a forged
      // verifier on any shape still reports VERIFIER_DENIED (FIX4 property).
      if (event.verifier_ref === null || event.actor_ref !== event.verifier_ref) {
        throw new LedgerError("LEDGER_VERIFIER_DENIED", "only the named verifier accepts");
      }
      if (!chkSame || !hypSame || !laneSame || !obsSame) maskFail("acceptance mutated a protected family");
      if (oblSame) maskFail("acceptance left obligations unchanged");
      singleObligationFlip(current, next, event, "REGISTERED", "ACCEPTED");
      break;
    }
    case "DEVIATION": {
      if (current.status !== "OPEN" || next.status !== "OPEN") maskFail("deviation requires an open ledger");
      if (!chkSame || !hypSame || !laneSame) maskFail("deviation mutated a protected family");
      if (next.observed_fidelity !== current.observed_fidelity ||
        next.observed_assurance !== current.observed_assurance) {
        maskFail("deviation mutated a protected observed family");
      }
      if (oblSame) maskFail("deviation left obligations unchanged");
      singleObligationFlip(current, next, event, "REGISTERED_OR_ACCEPTED", "DEVIATED");
      if (next.observed_execution === current.observed_execution) maskFail("deviation requires an observed note");
      if (next.observed_execution === null || next.observed_execution.length < 1 ||
        next.observed_execution.length > 1024) maskFail("observed note is invalid");
      break;
    }
    case "OBSERVED": {
      if (current.status !== "OPEN" || next.status !== "OPEN") maskFail("observation requires an open ledger");
      if (!oblSame || !hypSame || !laneSame || !chkSame) maskFail("observation mutated a protected family");
      if (obsSame) maskFail("observation left observed state unchanged");
      for (const value of [next.observed_execution, next.observed_fidelity, next.observed_assurance]) {
        if (value !== null && (value.length < 1 || value.length > 1024)) maskFail("observed value is invalid");
      }
      break;
    }
    case "CLOSED": {
      if (current.status !== "OPEN" || next.status !== "CLOSED") maskFail("close requires an open ledger");
      if (!oblSame || !hypSame || !laneSame || !chkSame || !obsSame) maskFail("close mutated a protected family");
      break;
    }
    case "REOPENED": {
      if (current.status !== "CLOSED" || next.status !== "OPEN") maskFail("reopen requires a closed ledger");
      if (!oblSame || !hypSame || !laneSame || !chkSame || !obsSame) maskFail("reopen mutated a protected family");
      break;
    }
    case "LANE_REGISTERED": {
      if (current.status !== "OPEN" || next.status !== "OPEN") maskFail("lane registration requires an open ledger");
      if (!oblSame || !hypSame || !chkSame || !obsSame) maskFail("lane registration mutated a protected family");
      if (next.lane_registrations.length !== current.lane_registrations.length + 1 ||
        !current.lane_registrations.every((value, index) => next.lane_registrations[index] === value)) {
        maskFail("lane registration must append exactly one entry");
      }
      break;
    }
    case "OBLIGATION_REGISTERED": {
      if (current.status !== "OPEN" || next.status !== "OPEN") maskFail("obligation registration requires an open ledger");
      if (!chkSame || !hypSame || !laneSame || !obsSame) maskFail("obligation registration mutated a protected family");
      if (next.obligations.length !== current.obligations.length + 1 ||
        !current.obligations.every((value, index) => sameJson(value, next.obligations[index]))) {
        maskFail("obligation registration must append exactly one entry");
      }
      const added = next.obligations[next.obligations.length - 1] as LedgerHead["obligations"][number];
      if (added.status !== "REGISTERED") maskFail("registered obligation must start REGISTERED");
      if (current.obligations.some((item) => item.obligation_id === added.obligation_id)) {
        maskFail("duplicate obligation id");
      }
      break;
    }
    case "HYPOTHESIS_RECORDED": {
      if (current.status !== "OPEN" || next.status !== "OPEN") maskFail("hypothesis record requires an open ledger");
      if (!oblSame || !chkSame || !laneSame || !obsSame) maskFail("hypothesis record mutated a protected family");
      if (next.hypotheses.length !== current.hypotheses.length + 1 ||
        !current.hypotheses.every((value, index) => next.hypotheses[index] === value)) {
        maskFail("hypothesis record must append exactly one entry");
      }
      break;
    }
    default: {
      maskFail("event kind requires an explicit create or supersede command");
    }
  }
}

// D1 current-time bounds enforced by the 0016 ledger_cmd_time_fresh trigger.
export const LEDGER_COMMAND_FUTURE_SKEW_SEC = 60;
export const LEDGER_COMMAND_PAST_STALE_SEC = 300;
// Service-side expiry horizon; the migration caps TTL at observed + 10 minutes.
export const LEDGER_COMMAND_TTL_MIN = 5;

export function ledgerCommandExpiry(observedAt: string): string {
  assertCanonicalLedgerTimestamp(observedAt, "observed_at");
  return new Date(Date.parse(observedAt) + LEDGER_COMMAND_TTL_MIN * 60 * 1000).toISOString();
}

export function ledgerCommandIdFor(eventId: string): string {
  return `cmd-${eventId}`.slice(0, 256);
}

const HEAD_SUFFIXES = [
  "investigation_id", "revision", "protocol_version", "goal", "scope_snapshot_id",
  "scope_snapshot_revision", "evidence_grade", "lane", "lane_registrations_json",
  "obligations_json", "hypotheses_json", "portfolio_ref", "debt_refs_json",
  "checkpoint_head", "principal_ref", "input_digest", "policy_generation",
  "policy_authority_ref", "deployment_generation", "idempotency_key", "model_profile_ref",
  "observed_execution", "observed_fidelity", "observed_assurance", "status",
  "supersedes_id", "supersession_reason", "event_head", "created_at", "updated_at",
] as const;
const EVENT_SUFFIXES = [
  "investigation_id", "sequence", "event_id", "kind", "payload_handle_ref",
  "payload_digest", "actor_ref", "verifier_ref", "created_at",
] as const;

function prefixed(prefix: string, suffixes: readonly string[]): string[] {
  return suffixes.map((suffix) => `${prefix}_${suffix}`);
}

export const COMMAND_COLUMNS: readonly string[] = [
  "command_id", "op_kind", "expected_old_revision", "expected_new_revision",
  "expected_old_event_head", "expected_new_event_head", "expected_epoch",
  "principal_ref", "scope_snapshot_id", "scope_snapshot_revision", "policy_generation",
  "policy_authority_ref", "deployment_generation", "global_purge_revision",
  "scope_purge_revision", "observed_at", "expires_at",
  ...prefixed("oh", HEAD_SUFFIXES),
  ...prefixed("oe", EVENT_SUFFIXES),
  ...prefixed("nh", HEAD_SUFFIXES),
  ...prefixed("ne", EVENT_SUFFIXES),
];

export const COMMAND_SQL = {
  selectEpoch: "SELECT generation FROM investigation_ledger_epoch WHERE singleton = 1 LIMIT 1",
  selectCommand: "SELECT command_id, op_kind FROM investigation_ledger_command WHERE command_id = ?1 LIMIT 1",
  insertCommand: `INSERT INTO investigation_ledger_command (${COMMAND_COLUMNS.join(", ")}) VALUES (${COMMAND_COLUMNS.map((_, index) => `?${index + 1}`).join(",")})`,
} as const;

// Command fence: canonical D1 reads. scope_purge_revision is null only when the scope row
// itself is missing; the scope trigger then fails the command with LEDGER_SCOPE_FOREIGN.
export interface LedgerCommandFence extends Omit<LedgerAuthorityFence, "purge_revision" | "scope_purge_revision"> {
  readonly purge_revision: number;
  readonly scope_purge_revision: number | null;
}

function headParams(head: LedgerHead | null): readonly unknown[] {
  if (head === null) return new Array<unknown>(HEAD_SUFFIXES.length).fill(null);
  return ledgerHeadBindings(head);
}

function eventParams(event: LedgerEvent | null): readonly unknown[] {
  if (event === null) return new Array<unknown>(EVENT_SUFFIXES.length).fill(null);
  return ledgerEventBindings(event);
}

function metaParams(
  commandId: string, op: "CREATE" | "APPEND" | "SUPERSEDE",
  expectedOldRevision: number, expectedNewRevision: number,
  expectedOldEventHead: number, expectedNewEventHead: number,
  epoch: number, fence: LedgerCommandFence, observedAt: string,
): readonly unknown[] {
  return [
    commandId, op, expectedOldRevision, expectedNewRevision,
    expectedOldEventHead, expectedNewEventHead, epoch,
    fence.principal_ref, fence.scope_snapshot_id, fence.scope_snapshot_revision,
    fence.policy_generation, fence.policy_authority_ref, fence.deployment_generation,
    fence.purge_revision, fence.scope_purge_revision, observedAt, ledgerCommandExpiry(observedAt),
  ];
}

export interface LedgerCommand {
  readonly commandId: string;
  readonly params: readonly unknown[];
}

export function buildCreateCommand(head: LedgerHead, event: LedgerEvent, fence: LedgerCommandFence, epoch: number, observedAt: string): LedgerCommand {
  assertHeadEventTimes(head, event, observedAt);
  const commandId = ledgerCommandIdFor(event.event_id);
  return {
    commandId,
    params: [
      ...metaParams(commandId, "CREATE", 0, 1, 0, 1, epoch, fence, observedAt),
      ...headParams(null), ...eventParams(null), ...headParams(head), ...eventParams(event),
    ],
  };
}

export function buildAppendCommand(head: LedgerHead, expectedRevision: number, event: LedgerEvent, fence: LedgerCommandFence, epoch: number, observedAt: string): LedgerCommand {
  assertHeadEventTimes(head, event, observedAt);
  const commandId = ledgerCommandIdFor(event.event_id);
  return {
    commandId,
    params: [
      ...metaParams(commandId, "APPEND", expectedRevision, head.revision, head.event_head - 1, head.event_head, epoch, fence, observedAt),
      ...headParams(null), ...eventParams(null), ...headParams(head), ...eventParams(event),
    ],
  };
}

export function buildSupersedeCommand(oldHead: LedgerHead, oldEvent: LedgerEvent, expectedOldRevision: number, newHead: LedgerHead, newEvent: LedgerEvent, fence: LedgerCommandFence, epoch: number, observedAt: string): LedgerCommand {
  assertHeadEventTimes(oldHead, oldEvent, observedAt);
  assertHeadEventTimes(newHead, newEvent, observedAt);
  const commandId = ledgerCommandIdFor(oldEvent.event_id);
  return {
    commandId,
    params: [
      ...metaParams(commandId, "SUPERSEDE", expectedOldRevision, oldHead.revision, oldHead.event_head - 1, oldHead.event_head, epoch, fence, observedAt),
      ...headParams(oldHead), ...eventParams(oldEvent), ...headParams(newHead), ...eventParams(newEvent),
    ],
  };
}

// Minimal structural database port so this module never imports the store/service layer.
export interface LedgerCommandReader {
  prepare(sql: string): { bind(...params: unknown[]): { first<T>(): Promise<T | null> } };
}

export interface LedgerCommandDatabase extends LedgerCommandReader {
  prepare(sql: string): {
    bind(...params: unknown[]): {
      first<T>(): Promise<T | null>;
      all<T>(): Promise<{ results: T[] }>;
      run(): Promise<{ meta: { changes: number } }>;
    };
  };
  batch(statements: readonly { sql: string; params: readonly unknown[] }[]): Promise<readonly { meta: { changes: number } }[]>;
}

export async function hasCommittedCommand(reader: LedgerCommandReader, commandId: string): Promise<boolean> {
  try {
    const row = await reader.prepare(COMMAND_SQL.selectCommand).bind(commandId).first<{ command_id: unknown }>();
    return row !== null;
  } catch {
    return false;
  }
}

// Canonical fence read with no mutation and no error suppression: any read failure aborts
// the operation before the command statement with a retryable uncertain outcome, leaving
// authority, epoch and ledger rows byte-identical. scope_purge_revision is null only when
// the scope row itself is missing; the scope trigger then fails closed with SCOPE_FOREIGN.
export async function readCommandFence(database: LedgerCommandDatabase, head: LedgerHead): Promise<LedgerCommandFence> {
  try {
    const globalRow = await database.prepare("SELECT COALESCE(MAX(ledger_revision), 0) AS n FROM purge_ledger").bind().first<{ n: number }>();
    const scopeRow = await database.prepare("SELECT purge_ledger_revision AS p FROM scope_snapshot WHERE snapshot_id = ?1 AND revision = ?2").bind(head.scope_snapshot_id, head.scope_snapshot_revision).first<{ p: number }>();
    return {
      principal_ref: head.principal_ref, scope_snapshot_id: head.scope_snapshot_id,
      scope_snapshot_revision: head.scope_snapshot_revision, policy_generation: head.policy_generation,
      policy_authority_ref: head.policy_authority_ref, deployment_generation: head.deployment_generation,
      purge_revision: globalRow?.n ?? 0, scope_purge_revision: scopeRow?.p ?? null,
    };
  } catch (cause) {
    throw new LedgerError("LEDGER_SETTLEMENT_UNCERTAIN", "ledger fence read failed; no effect was committed", true, cause);
  }
}
