// ER-08/ER-13 FIX4: atomic single-statement ledger command builders.
//
// Every create/append/supersede mutation is exactly ONE INSERT into
// investigation_ledger_command (see infra/d1/core/migrations/0016_*). The BEFORE INSERT
// triggers validate fence, epoch, D1 current-time bounds, actor/verifier binding and op
// shape; the AFTER INSERT trigger program performs every head/event effect in the same
// statement. Column order here MUST match the 0016 table definition exactly; the
// ledger-commands test asserts COMMAND_COLUMNS against the migrated table.
import {
  LedgerError, ledgerEventBindings, ledgerHeadBindings,
  type LedgerAuthorityFence, type LedgerEvent, type LedgerHead,
} from "./ports.js";

// D1 current-time bounds enforced by the 0016 ledger_cmd_time_fresh trigger.
export const LEDGER_COMMAND_FUTURE_SKEW_SEC = 60;
export const LEDGER_COMMAND_PAST_STALE_SEC = 300;
// Service-side expiry horizon; the migration caps TTL at observed + 10 minutes.
export const LEDGER_COMMAND_TTL_MIN = 5;

export function ledgerCommandExpiry(observedAt: string): string {
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
