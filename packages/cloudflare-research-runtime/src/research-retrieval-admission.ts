import { ScopeSnapshotSchema, Sha256Schema, type ScopeSnapshot } from "@eliotr/contracts";
import { D1_EXECUTION_LEASE_NOW_SQL } from "@eliotr/platform-cloudflare";
import { canonicalRetrievalJson, managedRetrievalInvocationIdsV1, RetrievalQueryError } from "@eliotr/retrieval";
import type {
  RetrievalQueryAccess, RetrievalQueryAdmissionPort,
  RetrievalQueryAdmissionReceiptV1 as RetrievalQueryAdmissionReceipt,
} from "@eliotr/retrieval";

interface AdmissionRow {
  readonly operation_id: unknown;
  readonly principal_ref: unknown;
  readonly client_class: unknown;
  readonly credential_generation: unknown;
  readonly request_digest: unknown;
  readonly scope_snapshot_id: unknown;
  readonly scope_snapshot_revision: unknown;
  readonly state: unknown;
  readonly intent_id: unknown;
  readonly payload_ref: unknown;
  readonly policy_decision_ref: unknown;
  readonly attempt_id: unknown;
  readonly attempt_state: unknown;
  readonly lease_owner: unknown;
  readonly lease_generation: unknown;
  readonly lease_state: unknown;
  readonly lease_current: unknown;
}

function uncertain(): never {
  throw new RetrievalQueryError("RETRIEVAL_RESOLUTION_UNCERTAIN", "query invocation ownership is not settled", true);
}

function mapAdmissionFailure(error: unknown): void {
  if (error instanceof RetrievalQueryError) throw error;
  const message = error instanceof Error ? error.message : "";
  if (message.includes("RETRIEVAL_AUTHORITY_STALE")) {
    throw new RetrievalQueryError("RETRIEVAL_AUTHORITY_STALE", "query invocation authority is stale");
  }
  if (message.includes("RETRIEVAL_CONFLICT") || message.includes("RETRIEVAL_IDEMPOTENCY_CONFLICT")) {
    throw new RetrievalQueryError("RETRIEVAL_IDEMPOTENCY_CONFLICT", "query invocation is bound to different inputs");
  }
  // Unknown batch acknowledgement is reconciled from durable rows before any provider effect.
}

/**
 * The existing PENDING result is the canonical request/scope binding. Generic QUERY
 * intent/attempt and the existing execution lease fence one invocation. An expired
 * or failed lease is never acquired again here: uncertain paid work needs reconciliation.
 * PENDING settlement requires the additive UPDATE guards; no applied migration is changed.
 */
export function createD1RetrievalQueryAdmissionPort(input: {
  readonly database: D1Database;
  readonly access: RetrievalQueryAccess;
  readonly scope_snapshot: ScopeSnapshot;
  readonly deadline_ms: number;
  readonly signal: AbortSignal;
  readonly require_current_scope: (scope: ScopeSnapshot) => Promise<void>;
  readonly clock?: () => number;
}): RetrievalQueryAdmissionPort {
  const { database, access } = input;
  const parsedScope = ScopeSnapshotSchema.safeParse(input.scope_snapshot);
  if (!parsedScope.success) {
    throw new RetrievalQueryError("RETRIEVAL_INPUT_INVALID", "query admission scope is malformed");
  }
  const scope = parsedScope.data;
  const clock = input.clock ?? Date.now;
  if (access.principal_ref.length === 0 || access.credential_generation.length === 0 ||
      !["owner_pwa", "named_api_client", "trusted_agent", "federation_client"].includes(access.client_class) ||
      !Number.isSafeInteger(input.deadline_ms)) {
    throw new RetrievalQueryError("RETRIEVAL_INPUT_INVALID", "query admission context is invalid");
  }

  async function requireCurrent(): Promise<number> {
    if (input.signal.aborted) throw new RetrievalQueryError("RETRIEVAL_CANCELLED", "query admission is cancelled");
    const now = clock();
    if (!Number.isSafeInteger(now) || now < 0 || now >= input.deadline_ms) {
      throw new RetrievalQueryError("RETRIEVAL_BUDGET_STOP", "query admission deadline is exhausted");
    }
    await input.require_current_scope(scope);
    return now;
  }

  async function read(operationId: string, executionId: string): Promise<AdmissionRow | null> {
    return database.prepare(
      "SELECT q.operation_id,q.principal_ref,q.client_class,q.credential_generation,q.request_digest," +
      "q.scope_snapshot_id,q.scope_snapshot_revision,q.state,i.intent_id,i.payload_ref,i.policy_decision_ref," +
      "a.attempt_id,a.state AS attempt_state,l.lease_owner,l.lease_generation,l.state AS lease_state," +
      "(l.lease_until > " + D1_EXECUTION_LEASE_NOW_SQL + ") AS lease_current " +
      "FROM retrieval_query_result q LEFT JOIN operation_intent i ON i.intent_id=q.operation_id AND i.revision=1 " +
      "LEFT JOIN operation_attempt a ON a.intent_id=i.intent_id AND a.intent_revision=1 AND a.attempt_number=1 " +
      "LEFT JOIN operation_execution_lease l ON l.operation_id=?2 " +
      "WHERE q.operation_id=?1 LIMIT 1",
    ).bind(operationId, executionId).first<AdmissionRow>().catch(() => uncertain());
  }

  function requireBinding(row: AdmissionRow, receipt: RetrievalQueryAdmissionReceipt): void {
    if (row.principal_ref !== access.principal_ref || row.client_class !== access.client_class ||
        row.credential_generation !== access.credential_generation) {
      throw new RetrievalQueryError("RETRIEVAL_AUTHORITY_STALE", "query invocation access generation is displaced");
    }
    if (row.request_digest !== receipt.request_digest || row.scope_snapshot_id !== scope.snapshot_id ||
        row.scope_snapshot_revision !== scope.revision) {
      throw new RetrievalQueryError("RETRIEVAL_IDEMPOTENCY_CONFLICT", "query invocation is bound to different inputs");
    }
    if (row.operation_id !== receipt.retrieval_operation_id || row.state !== "PENDING" ||
        row.intent_id !== receipt.intent_ref.id || row.payload_ref !== `retrieval-query-result:${receipt.scoped_invocation_id}` ||
        row.policy_decision_ref !== scope.policy_authority_ref || row.attempt_id !== receipt.attempt_ref ||
        row.attempt_state !== "STARTED" || row.lease_state !== "LEASED" || row.lease_generation !== 1 ||
        row.lease_owner !== receipt.fence.lease_owner) uncertain();
    if (row.lease_current !== 1) {
      throw new RetrievalQueryError("RETRIEVAL_BUDGET_STOP", "query invocation fence expired");
    }
  }

  return {
    async admit(request) {
      if (!Sha256Schema.safeParse(request.request_digest).success ||
          typeof request.idempotency_key !== "string" || request.idempotency_key.length < 1 || request.idempotency_key.length > 256 ||
          canonicalRetrievalJson(request.scope_snapshot) !== canonicalRetrievalJson(scope)) {
        throw new RetrievalQueryError("RETRIEVAL_INPUT_INVALID", "query admission request is invalid");
      }
      const now = await requireCurrent();
      const identity = await managedRetrievalInvocationIdsV1(access.principal_ref, access.client_class, request.idempotency_key);
      const operationId = identity.retrieval_operation_id;
      // A random token fences this one live claimant; it never changes the scoped invocation or retry ID.
      const owner = `rq-owner-${crypto.randomUUID()}`;
      const attemptId = `${operationId}-a1`;
      const createdAt = new Date(now).toISOString();
      const payloadRef = `retrieval-query-result:${operationId}`;
      const receipt: RetrievalQueryAdmissionReceipt = Object.freeze({
        protocol: "eliotr.retrieval-query-admission.v1",
        ...identity, request_digest: request.request_digest,
        scope_snapshot_ref: Object.freeze({ id: scope.snapshot_id, revision: scope.revision }), scope_digest: scope.digest,
        intent_ref: Object.freeze({ id: operationId, revision: 1 }), attempt_ref: attemptId,
        fence: Object.freeze({ operation_id: identity.execution_id, lease_owner: owner, lease_generation: 1 }),
      });
      const pending = database.prepare(
        "INSERT INTO retrieval_query_result (operation_id,principal_ref,client_class,credential_generation,idempotency_key," +
        "request_digest,scope_snapshot_id,scope_snapshot_revision,state,coverage_claim,created_at,expires_at) " +
        "VALUES (?1,?2,?3,?4,?5,?6,?7,?8,'PENDING','NONE',?9,?10) ON CONFLICT(operation_id) DO NOTHING",
      ).bind(operationId, access.principal_ref, access.client_class, access.credential_generation,
        request.idempotency_key, request.request_digest, scope.snapshot_id, scope.revision, createdAt, scope.expires_at);
      const intent = database.prepare(
        "INSERT INTO operation_intent (intent_id,revision,operation_kind,principal_ref,idempotency_key,payload_ref,policy_decision_ref,created_at) " +
        "SELECT ?1,1,'QUERY',?2,?1,?3,?4,?5 FROM retrieval_query_result q " +
        "WHERE q.operation_id=?1 AND q.state='PENDING' AND q.request_digest=?6 " +
        "AND q.scope_snapshot_id=?7 AND q.scope_snapshot_revision=?8 ON CONFLICT DO NOTHING",
      ).bind(operationId, access.principal_ref, payloadRef, scope.policy_authority_ref, createdAt,
        request.request_digest, scope.snapshot_id, scope.revision);
      const lease = database.prepare(
        "INSERT INTO operation_execution_lease (operation_id,operation_kind,lease_owner,lease_generation,lease_until,attempt,state,checkpoint_ref,created_at,updated_at) " +
        "SELECT ?10,'QUERY',?2,1," + D1_EXECUTION_LEASE_NOW_SQL + "+?3,1,'LEASED',?4," +
        D1_EXECUTION_LEASE_NOW_SQL + "," + D1_EXECUTION_LEASE_NOW_SQL + " FROM operation_intent i " +
        "JOIN retrieval_query_result q ON q.operation_id=i.intent_id WHERE i.intent_id=?1 AND i.revision=1 " +
        "AND i.operation_kind='QUERY' AND i.principal_ref=?5 AND i.payload_ref=?4 AND i.policy_decision_ref=?6 " +
        "AND q.state='PENDING' AND q.request_digest=?7 AND q.scope_snapshot_id=?8 AND q.scope_snapshot_revision=?9 " +
        "ON CONFLICT(operation_id) DO NOTHING",
      ).bind(operationId, owner, input.deadline_ms - now, payloadRef, access.principal_ref,
        scope.policy_authority_ref, request.request_digest, scope.snapshot_id, scope.revision, receipt.execution_id);
      const attempt = database.prepare(
        "INSERT INTO operation_attempt (attempt_id,intent_id,intent_revision,attempt_number,state,started_at) " +
        "SELECT ?1,?2,1,1,'STARTED',?3 FROM operation_execution_lease l WHERE l.operation_id=?5 " +
        "AND l.operation_kind='QUERY' AND l.lease_owner=?4 AND l.lease_generation=1 AND l.state='LEASED' " +
        "AND l.lease_until>" + D1_EXECUTION_LEASE_NOW_SQL + " ON CONFLICT DO NOTHING",
      ).bind(attemptId, operationId, createdAt, owner, receipt.execution_id);
      try { await database.batch([pending, intent, lease, attempt]); }
      catch (error: unknown) { mapAdmissionFailure(error); }
      const row = await read(operationId, receipt.execution_id);
      if (row === null) uncertain();
      requireBinding(row, receipt);
      await requireCurrent();
      return receipt;
    },
    async recheck(receipt) {
      if (receipt.protocol !== "eliotr.retrieval-query-admission.v1" || receipt.fence.operation_id !== receipt.execution_id ||
          receipt.scoped_invocation_id !== receipt.retrieval_operation_id ||
          receipt.intent_ref.id !== receipt.retrieval_operation_id || receipt.intent_ref.revision !== 1 ||
          receipt.scope_snapshot_ref.id !== scope.snapshot_id || receipt.scope_snapshot_ref.revision !== scope.revision ||
          receipt.scope_digest !== scope.digest || receipt.fence.lease_generation !== 1) {
        throw new RetrievalQueryError("RETRIEVAL_INPUT_INVALID", "query admission receipt is malformed");
      }
      await requireCurrent();
      const row = await read(receipt.retrieval_operation_id, receipt.execution_id);
      if (row === null) uncertain();
      requireBinding(row, receipt);
      await requireCurrent();
    },
  };
}
