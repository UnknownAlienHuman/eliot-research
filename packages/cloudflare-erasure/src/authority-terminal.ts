import type { ErasureFence } from "@eliotr/contracts";
import { erasureFail } from "./canonical.js";

interface TerminalGuardRow {
  readonly closure_digest: unknown;
  readonly requested_locations_json: unknown;
  readonly completed_locations_json: unknown;
  readonly blocked_locations_json: unknown;
  readonly terminal_state: unknown;
  readonly receipt_sha256: unknown;
  readonly purge_ledger_revision: unknown;
  readonly verified: unknown;
  readonly lease_owner: unknown;
  readonly lease_generation: unknown;
  readonly lease_until: unknown;
}

interface TerminalExecutionRow {
  readonly state: unknown;
  readonly closure_digest: unknown;
  readonly lease_owner: unknown;
  readonly lease_generation: unknown;
  readonly lease_until: unknown;
  readonly terminal_receipt_json: unknown;
  readonly terminal_receipt_sha256: unknown;
  readonly purge_ledger_revision: unknown;
}

interface TerminalCaseRow {
  readonly state: unknown;
  readonly completed_locations_json: unknown;
  readonly blocked_locations_json: unknown;
}

export interface PersistTerminalErasureInput {
  readonly fence: ErasureFence;
  readonly closure_digest: string;
  readonly terminal_state: "COMPLETE" | "BLOCKED";
  readonly requested_locations_json: string;
  readonly completed_locations_json: string;
  readonly blocked_locations_json: string;
  readonly receipt_json: string;
  readonly receipt_sha256: string;
  readonly ledger_entry_ref: string;
  readonly ledger_revision: number;
  readonly expected_non_absent_targets: number;
  readonly now: string;
  readonly now_ms: number;
}

async function first<T>(database: D1Database, sql: string, values: readonly (string | number)[]): Promise<T | null> {
  try {
    return await database.prepare(sql).bind(...values).first<T>();
  } catch (cause) {
    erasureFail("ERASURE_SETTLEMENT_UNCERTAIN", "terminal erasure readback failed", true, cause);
  }
}

function guardMatches(row: TerminalGuardRow | null, input: PersistTerminalErasureInput): boolean {
  return row !== null && row.closure_digest === input.closure_digest &&
    row.requested_locations_json === input.requested_locations_json &&
    row.completed_locations_json === input.completed_locations_json &&
    row.blocked_locations_json === input.blocked_locations_json &&
    row.terminal_state === input.terminal_state && row.receipt_sha256 === input.receipt_sha256 &&
    row.purge_ledger_revision === input.ledger_revision && row.verified === 1 &&
    row.lease_owner === input.fence.lease_owner && row.lease_generation === input.fence.lease_generation &&
    row.lease_until === input.fence.lease_until_ms;
}

export async function persistTerminalErasure(
  database: D1Database,
  input: PersistTerminalErasureInput,
): Promise<void> {
  const { fence } = input;
  const values = [
    fence.erasure_id,
    fence.revision,
    input.closure_digest,
    input.requested_locations_json,
    input.completed_locations_json,
    input.blocked_locations_json,
    input.terminal_state,
    input.receipt_sha256,
    input.ledger_revision,
    input.expected_non_absent_targets,
    input.now,
    fence.lease_owner,
    fence.lease_generation,
    fence.lease_until_ms,
    input.now_ms,
    input.ledger_entry_ref,
  ] as const;

  const guardInsert = database.prepare(
    "INSERT INTO erasure_terminal_guard(erasure_id,erasure_revision,closure_digest," +
      "requested_locations_json,completed_locations_json,blocked_locations_json,terminal_state," +
      "receipt_sha256,purge_ledger_revision,verified,created_at,lease_owner,lease_generation,lease_until) " +
      "SELECT ?1,?2,?3,?4,?5,?6,?7,?8,?9,CASE WHEN " +
      "EXISTS (SELECT 1 FROM purge_ledger p WHERE p.ledger_revision=?9 AND p.erasure_id=?1 " +
      "AND p.receipt_ref=?16 AND p.disposition=?7) " +
      "AND EXISTS (SELECT 1 FROM erasure_stage_receipt s WHERE s.erasure_id=?1 " +
      "AND s.erasure_revision=?2 AND s.stage='INVALIDATE_DEPENDENTS' AND s.lease_generation=?13) " +
      "AND (?10<0 OR (SELECT COUNT(*) FROM erasure_target t WHERE t.erasure_id=?1 " +
      "AND t.erasure_revision=?2 AND t.state<>'ABSENT')=?10) THEN 1 ELSE 0 END,?11,?12,?13,?14 " +
      "WHERE EXISTS (SELECT 1 FROM erasure_case c JOIN erasure_execution e " +
      "ON e.erasure_id=c.erasure_id AND e.revision=c.revision " +
      "WHERE c.erasure_id=?1 AND c.revision=?2 AND c.state='INVALIDATE_DEPENDENTS' " +
      "AND e.state='INVALIDATE_DEPENDENTS' AND e.closure_digest=?3 AND e.lease_owner=?12 " +
      "AND e.lease_generation=?13 AND e.lease_until=?14 AND e.lease_until>?15) " +
      "AND EXISTS (SELECT 1 FROM purge_ledger p WHERE p.ledger_revision=?9 AND p.erasure_id=?1 " +
      "AND p.receipt_ref=?16 AND p.disposition=?7) " +
      "AND EXISTS (SELECT 1 FROM erasure_stage_receipt s WHERE s.erasure_id=?1 " +
      "AND s.erasure_revision=?2 AND s.stage='INVALIDATE_DEPENDENTS' AND s.lease_generation=?13) " +
      "AND (?10<0 OR (SELECT COUNT(*) FROM erasure_target t WHERE t.erasure_id=?1 " +
      "AND t.erasure_revision=?2 AND t.state<>'ABSENT')=?10)",
  ).bind(...values);

  const caseUpdate = database.prepare(
    "UPDATE erasure_case SET state=?3,completed_locations_json=?4,blocked_locations_json=?5,updated_at=?6 " +
      "WHERE erasure_id=?1 AND revision=?2 AND state='INVALIDATE_DEPENDENTS' AND EXISTS (" +
      "SELECT 1 FROM erasure_execution e JOIN erasure_terminal_guard g " +
      "ON g.erasure_id=e.erasure_id AND g.erasure_revision=e.revision " +
      "WHERE e.erasure_id=?1 AND e.revision=?2 AND e.state='INVALIDATE_DEPENDENTS' " +
      "AND e.closure_digest=?7 AND e.lease_owner=?8 AND e.lease_generation=?9 AND e.lease_until=?10 " +
      "AND e.lease_until>?11 AND g.closure_digest=?7 AND g.requested_locations_json=?12 " +
      "AND g.completed_locations_json=?4 AND g.blocked_locations_json=?5 AND g.terminal_state=?3 " +
      "AND g.receipt_sha256=?13 AND g.purge_ledger_revision=?14 AND g.verified=1 " +
      "AND g.lease_owner=?8 AND g.lease_generation=?9 AND g.lease_until=?10)",
  ).bind(
    fence.erasure_id,
    fence.revision,
    input.terminal_state,
    input.completed_locations_json,
    input.blocked_locations_json,
    input.now,
    input.closure_digest,
    fence.lease_owner,
    fence.lease_generation,
    fence.lease_until_ms,
    input.now_ms,
    input.requested_locations_json,
    input.receipt_sha256,
    input.ledger_revision,
  );

  const executionUpdate = database.prepare(
    "UPDATE erasure_execution SET state=?5,terminal_receipt_json=?6,terminal_receipt_sha256=?7," +
      "purge_ledger_revision=?8,lease_owner=NULL,lease_until=NULL,updated_at=?9 " +
      "WHERE erasure_id=?1 AND revision=?2 AND state='INVALIDATE_DEPENDENTS' AND closure_digest=?10 " +
      "AND lease_owner=?3 AND lease_generation=?4 AND lease_until=?11 AND lease_until>?12 AND EXISTS (" +
      "SELECT 1 FROM erasure_terminal_guard g WHERE g.erasure_id=?1 AND g.erasure_revision=?2 " +
      "AND g.closure_digest=?10 AND g.requested_locations_json=?13 AND g.completed_locations_json=?14 " +
      "AND g.blocked_locations_json=?15 AND g.terminal_state=?5 AND g.receipt_sha256=?7 " +
      "AND g.purge_ledger_revision=?8 AND g.verified=1 AND g.lease_owner=?3 " +
      "AND g.lease_generation=?4 AND g.lease_until=?11) AND EXISTS (" +
      "SELECT 1 FROM erasure_case c WHERE c.erasure_id=?1 AND c.revision=?2 AND c.state=?5 " +
      "AND c.completed_locations_json=?14 AND c.blocked_locations_json=?15)",
  ).bind(
    fence.erasure_id,
    fence.revision,
    fence.lease_owner,
    fence.lease_generation,
    input.terminal_state,
    input.receipt_json,
    input.receipt_sha256,
    input.ledger_revision,
    input.now,
    input.closure_digest,
    fence.lease_until_ms,
    input.now_ms,
    input.requested_locations_json,
    input.completed_locations_json,
    input.blocked_locations_json,
  );

  try {
    await database.batch([guardInsert, caseUpdate, executionUpdate]);
  } catch (cause) {
    const current = await first<TerminalExecutionRow>(database,
      "SELECT state,closure_digest,lease_owner,lease_generation,lease_until,terminal_receipt_json," +
        "terminal_receipt_sha256,purge_ledger_revision FROM erasure_execution " +
        "WHERE erasure_id=?1 AND revision=?2 LIMIT 1",
      [fence.erasure_id, fence.revision]);
    if (current === null || current.state !== "INVALIDATE_DEPENDENTS" ||
        current.closure_digest !== input.closure_digest || current.lease_owner !== fence.lease_owner ||
        current.lease_generation !== fence.lease_generation || current.lease_until !== fence.lease_until_ms ||
        typeof current.lease_until !== "number" || current.lease_until <= input.now_ms) {
      erasureFail("ERASURE_LEASE_LOST", "terminal settlement no longer owns the exact live erasure fence", true, cause);
    }
    erasureFail("ERASURE_SETTLEMENT_UNCERTAIN", "terminal settlement batch did not commit", true, cause);
  }

  const [guard, execution, caseRow] = await Promise.all([
    first<TerminalGuardRow>(database,
      "SELECT closure_digest,requested_locations_json,completed_locations_json,blocked_locations_json," +
        "terminal_state,receipt_sha256,purge_ledger_revision,verified,lease_owner,lease_generation,lease_until " +
        "FROM erasure_terminal_guard WHERE erasure_id=?1 AND erasure_revision=?2 LIMIT 1",
      [fence.erasure_id, fence.revision]),
    first<TerminalExecutionRow>(database,
      "SELECT state,closure_digest,lease_owner,lease_generation,lease_until,terminal_receipt_json," +
        "terminal_receipt_sha256,purge_ledger_revision FROM erasure_execution " +
        "WHERE erasure_id=?1 AND revision=?2 LIMIT 1",
      [fence.erasure_id, fence.revision]),
    first<TerminalCaseRow>(database,
      "SELECT state,completed_locations_json,blocked_locations_json FROM erasure_case " +
        "WHERE erasure_id=?1 AND revision=?2 LIMIT 1",
      [fence.erasure_id, fence.revision]),
  ]);

  if (!guardMatches(guard, input)) {
    if (execution === null || execution.state !== "INVALIDATE_DEPENDENTS" ||
        execution.lease_owner !== fence.lease_owner || execution.lease_generation !== fence.lease_generation ||
        execution.lease_until !== fence.lease_until_ms || typeof execution.lease_until !== "number" ||
        execution.lease_until <= input.now_ms) {
      erasureFail("ERASURE_LEASE_LOST", "terminal guard was not inserted under the current live erasure fence", true);
    }
    erasureFail("ERASURE_CLOSURE_INCOMPLETE", "terminal guard failed its exact durable readback");
  }
  if (execution === null || execution.state !== input.terminal_state || execution.closure_digest !== input.closure_digest ||
      execution.lease_owner !== null || execution.lease_until !== null ||
      execution.terminal_receipt_json !== input.receipt_json || execution.terminal_receipt_sha256 !== input.receipt_sha256 ||
      execution.purge_ledger_revision !== input.ledger_revision || caseRow === null ||
      caseRow.state !== input.terminal_state || caseRow.completed_locations_json !== input.completed_locations_json ||
      caseRow.blocked_locations_json !== input.blocked_locations_json) {
    erasureFail("ERASURE_SETTLEMENT_UNCERTAIN", "terminal case, execution, and guard readbacks do not agree", true);
  }
}
