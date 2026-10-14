interface CapturedStatement {
  readonly native: D1PreparedStatement;
  readonly sql: string;
  readonly parameters: readonly unknown[];
}

export interface ManagedRetrievalBatchObservation {
  readonly statements: readonly { readonly sql: string; readonly parameters: readonly unknown[] }[];
  readonly changes?: readonly (number | null)[];
  readonly error?: string;
}

export interface ManagedRetrievalSettlementSnapshot {
  readonly result: Readonly<Record<string, unknown>> | null;
  readonly trace: Readonly<Record<string, unknown>> | null;
  readonly intent: Readonly<Record<string, unknown>> | null;
  readonly attempt: Readonly<Record<string, unknown>> | null;
  readonly lease: Readonly<Record<string, unknown>> | null;
  readonly receipt: Readonly<Record<string, unknown>> | null;
}

/**
 * Observe the real Miniflare D1 calls while passing the exact native prepared
 * statements and result arrays through unchanged.
 */
export function observeManagedRetrievalD1(database: D1Database): {
  readonly database: D1Database;
  readonly batches: ManagedRetrievalBatchObservation[];
} {
  const nativeStatements = new WeakMap<D1PreparedStatement, CapturedStatement>();
  const batches: ManagedRetrievalBatchObservation[] = [];

  function wrap(statement: D1PreparedStatement, sql: string, parameters: readonly unknown[] = []): D1PreparedStatement {
    const proxy = new Proxy(statement, { get(target, property) {
      if (property === "bind") {
        return (...values: unknown[]) => wrap(target.bind(...values), sql, values);
      }
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    } });
    nativeStatements.set(proxy, { native: statement, sql, parameters });
    return proxy;
  }

  const observed = new Proxy(database, { get(target, property) {
    if (property === "prepare") return (sql: string) => wrap(target.prepare(sql), sql);
    if (property === "batch") {
      return async (statements: D1PreparedStatement[]) => {
        const captured = statements.map((statement) => nativeStatements.get(statement) ?? {
          native: statement, sql: "<unobserved>", parameters: [],
        });
        const publicStatements = captured.map(({ sql, parameters }) => ({ sql, parameters }));
        try {
          const results = await target.batch(captured.map((entry) => entry.native));
          batches.push({
            statements: publicStatements,
            changes: results.map((result) => Number.isFinite(result.meta.changes) ? result.meta.changes : null),
          });
          return results;
        } catch (error) {
          batches.push({
            statements: publicStatements,
            error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
          });
          throw error;
        }
      };
    }
    const value = Reflect.get(target, property, target);
    return typeof value === "function" ? value.bind(target) : value;
  } });

  return { database: observed, batches };
}

/** Compile captured SQL without executing it, to isolate a D1 batch compile failure. */
export async function explainManagedRetrievalBatches(
  database: D1Database,
  batches: readonly ManagedRetrievalBatchObservation[],
): Promise<readonly { readonly sql: string; readonly error?: string }[]> {
  const results: { sql: string; error?: string }[] = [];
  for (const batch of batches) {
    for (const statement of batch.statements) {
      try {
        await database.prepare(`EXPLAIN ${statement.sql}`).bind(...statement.parameters).all();
        results.push({ sql: statement.sql.slice(0, 180) });
      } catch (error) {
        results.push({
          sql: statement.sql.slice(0, 180),
          error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
        });
      }
    }
  }
  return results;
}

/** Read the canonical managed owner chain after a test failure without editing it. */
export async function readManagedRetrievalSettlementSnapshot(
  database: D1Database,
  input: {
    readonly principal_ref: string;
    readonly client_class: string;
    readonly credential_generation: string;
    readonly idempotency_key: string;
  },
): Promise<ManagedRetrievalSettlementSnapshot> {
  const result = await database.prepare(
    "SELECT operation_id,state,request_digest,scope_snapshot_id,scope_snapshot_revision,trace_id,trace_revision,coverage_claim " +
      "FROM retrieval_query_result WHERE principal_ref=?1 AND client_class=?2 AND credential_generation=?3 " +
      "AND idempotency_key=?4 LIMIT 1",
  ).bind(input.principal_ref, input.client_class, input.credential_generation, input.idempotency_key)
    .first<Readonly<Record<string, unknown>>>();
  if (result === null || typeof result.operation_id !== "string") {
    return { result, trace: null, intent: null, attempt: null, lease: null, receipt: null };
  }
  const operationId = result.operation_id;
  const attemptId = `${operationId}-a1`;
  const executionId = operationId.startsWith("q4-") ? operationId.slice(3, 51) : "";
  const [trace, intent, attempt, lease, receipt] = await Promise.all([
    typeof result.trace_id === "string" && typeof result.trace_revision === "number"
      ? database.prepare(
        "SELECT trace_id,revision,scope_snapshot_id,scope_snapshot_revision,trace_digest FROM retrieval_query_trace " +
          "WHERE trace_id=?1 AND revision=?2 LIMIT 1",
      ).bind(result.trace_id, result.trace_revision).first<Readonly<Record<string, unknown>>>()
      : Promise.resolve(null),
    database.prepare(
      "SELECT intent_id,revision,operation_kind,principal_ref,idempotency_key,payload_ref,policy_decision_ref " +
        "FROM operation_intent WHERE intent_id=?1 AND revision=1 LIMIT 1",
    ).bind(operationId).first<Readonly<Record<string, unknown>>>(),
    database.prepare(
      "SELECT attempt_id,attempt_number,state,checkpoint_ref,ended_at,error_code FROM operation_attempt " +
        "WHERE attempt_id=?1 LIMIT 1",
    ).bind(attemptId).first<Readonly<Record<string, unknown>>>(),
    executionId.length === 48
      ? database.prepare(
        "SELECT operation_id,operation_kind,lease_owner,lease_generation,state,terminal_receipt_ref,lease_until " +
          "FROM operation_execution_lease WHERE operation_id=?1 LIMIT 1",
      ).bind(executionId).first<Readonly<Record<string, unknown>>>()
      : Promise.resolve(null),
    database.prepare(
      "SELECT receipt_id,revision,attempt_id,outcome,output_refs_json,created_at FROM operation_receipt " +
        "WHERE intent_id=?1 AND intent_revision=1 AND attempt_id=?2 LIMIT 1",
    ).bind(operationId, attemptId).first<Readonly<Record<string, unknown>>>(),
  ]);
  return { result, trace, intent, attempt, lease, receipt };
}
