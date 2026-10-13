import { IdentifierSchema, IsoDateTimeSchema, OperationReceiptSchema, Sha256Schema } from "@eliotr/contracts";
import { D1_EXECUTION_LEASE_NOW_SQL } from "@eliotr/platform-cloudflare";
import { canonicalRetrievalJson, RetrievalQueryError } from "@eliotr/retrieval";
import type {
  RetrievalQueryAdmissionReceiptV1, RetrievalQueryD1, RetrievalQueryD1Statement,
  RetrievalSettlementOwnerPortV1, RetrievalTerminalSettlementIdentityV1,
} from "@eliotr/retrieval";

type SettlementIdentity = RetrievalTerminalSettlementIdentityV1;
type AdmissionReceipt = RetrievalQueryAdmissionReceiptV1;
type SettlementState = "COMMITTED" | "NOT_COMMITTED" | "UNKNOWN";

interface BoundSql {
  readonly values: unknown[];
  value(value: unknown): string;
}

function boundSql(): BoundSql {
  const values: unknown[] = [];
  return { values, value(value) { values.push(value); return `?${values.length}`; } };
}

function statement(database: RetrievalQueryD1, sql: string, args: BoundSql): RetrievalQueryD1Statement {
  return database.prepare(sql).bind(...args.values);
}

function failInput(): never {
  throw new RetrievalQueryError("RETRIEVAL_INPUT_INVALID", "managed query terminal identity is malformed");
}

function requireIdentity(identity: SettlementIdentity, receipt?: AdmissionReceipt): void {
  const operationId = identity.retrieval_operation_id;
  if (!/^q4-[a-f0-9]{64}$/u.test(operationId) || identity.scoped_invocation_id !== operationId ||
      identity.execution_id !== operationId.slice(3, 51) || identity.intent_ref.id !== operationId ||
      identity.intent_ref.revision !== 1 || identity.attempt_ref !== `${operationId}-a1` ||
      !IdentifierSchema.safeParse(identity.access.principal_ref).success ||
      !IdentifierSchema.safeParse(identity.access.credential_generation).success ||
      !["owner_pwa", "named_api_client", "trusted_agent", "federation_client"].includes(identity.access.client_class) ||
      typeof identity.idempotency_key !== "string" || identity.idempotency_key.length < 1 || identity.idempotency_key.length > 256 ||
      !IdentifierSchema.safeParse(identity.scope_snapshot_ref.id).success || !Number.isSafeInteger(identity.scope_snapshot_ref.revision) ||
      identity.scope_snapshot_ref.revision < 1 || !IdentifierSchema.safeParse(identity.trace_ref.id).success || identity.trace_ref.revision !== 1 ||
      [identity.request_digest, identity.scope_digest, identity.output_digest, identity.result_json_sha256,
        identity.trace_json_sha256].some(digest => !Sha256Schema.safeParse(digest).success)) failInput();
  if (receipt !== undefined && (receipt.protocol !== "eliotr.retrieval-query-admission.v1" ||
      receipt.retrieval_operation_id !== operationId || receipt.scoped_invocation_id !== identity.scoped_invocation_id ||
      receipt.execution_id !== identity.execution_id || receipt.fence.operation_id !== identity.execution_id ||
      receipt.fence.lease_generation !== 1 || !IdentifierSchema.safeParse(receipt.fence.lease_owner).success ||
      receipt.intent_ref.id !== operationId || receipt.intent_ref.revision !== 1 || receipt.attempt_ref !== identity.attempt_ref ||
      receipt.scope_snapshot_ref.id !== identity.scope_snapshot_ref.id ||
      receipt.scope_snapshot_ref.revision !== identity.scope_snapshot_ref.revision ||
      receipt.scope_digest !== identity.scope_digest || receipt.request_digest !== identity.request_digest)) failInput();
}

function receiptId(identity: SettlementIdentity): string {
  return `retrieval-receipt-${identity.result_json_sha256}`;
}

function resultRef(identity: SettlementIdentity): string {
  return `retrieval-query-result:${identity.retrieval_operation_id}`;
}

function outputRefs(identity: SettlementIdentity): string {
  return canonicalRetrievalJson([
    resultRef(identity),
    `retrieval-query-trace:${identity.trace_ref.id}:${identity.trace_ref.revision}`,
  ]);
}

function terminalReceiptPredicate(args: BoundSql, identity: SettlementIdentity, createdAt?: string): string {
  const p = args.value;
  return "EXISTS (SELECT 1 FROM operation_receipt r WHERE r.receipt_id=" + p(receiptId(identity)) +
    " AND r.revision=1 AND r.intent_id=" + p(identity.intent_ref.id) + " AND r.intent_revision=1" +
    " AND r.attempt_id=" + p(identity.attempt_ref) + " AND r.outcome='SUCCEEDED'" +
    " AND r.output_refs_json=" + p(outputRefs(identity)) +
    " AND r.readback_receipt_refs_json='[]' AND r.reconciliation_required=0 AND r.reason_codes_json='[]'" +
    (createdAt === undefined ? " AND r.created_at=a.ended_at" : " AND r.created_at=" + p(createdAt)) + ")";
}

/** All participants refer to the same completed result and direct trace body. */
function participantPredicate(args: BoundSql, identity: SettlementIdentity, input: {
  readonly receipt?: AdmissionReceipt;
  readonly attempt_state: "STARTED" | "SUCCEEDED";
  readonly lease_state: "LEASED" | "COMPLETED";
  readonly terminal_created_at?: string;
  readonly require_terminal?: boolean;
}): string {
  const p = args.value;
  const owner = input.receipt === undefined ? "" : " AND l.lease_owner=" + p(input.receipt.fence.lease_owner);
  return "EXISTS (SELECT 1 FROM retrieval_query_result q" +
    " JOIN scope_snapshot s ON s.snapshot_id=q.scope_snapshot_id AND s.revision=q.scope_snapshot_revision" +
    " JOIN retrieval_query_trace t ON t.trace_id=q.trace_id AND t.revision=q.trace_revision" +
    " JOIN operation_intent i ON i.intent_id=q.operation_id AND i.revision=1" +
    " JOIN operation_attempt a ON a.intent_id=i.intent_id AND a.intent_revision=1 AND a.attempt_number=1" +
    " JOIN operation_execution_lease l ON l.operation_id=" + p(identity.execution_id) +
    " WHERE q.operation_id=" + p(identity.retrieval_operation_id) + " AND q.state='COMPLETE'" +
    " AND q.principal_ref=" + p(identity.access.principal_ref) + " AND q.client_class=" + p(identity.access.client_class) +
    " AND q.credential_generation=" + p(identity.access.credential_generation) +
    " AND q.idempotency_key=" + p(identity.idempotency_key) + " AND q.request_digest=" + p(identity.request_digest) +
    " AND q.scope_snapshot_id=" + p(identity.scope_snapshot_ref.id) +
    " AND q.scope_snapshot_revision=" + p(identity.scope_snapshot_ref.revision) +
    " AND s.snapshot_digest=" + p(identity.scope_digest) +
    " AND s.invalidated_at IS NULL AND julianday(s.expires_at)>julianday('now')" +
    " AND EXISTS (SELECT 1 FROM scope_access_grant_effective g WHERE g.snapshot_id=s.snapshot_id" +
    " AND g.snapshot_revision=s.revision AND g.principal_ref=q.principal_ref AND g.client_class=q.client_class" +
    " AND g.credential_generation=q.credential_generation AND g.state='ACTIVE'" +
    " AND g.policy_authority_ref=s.policy_authority_ref AND julianday(g.expires_at)>julianday('now'))" +
    " AND s.purge_ledger_revision=COALESCE((SELECT MAX(ledger_revision) FROM purge_ledger),0)" +
    " AND NOT EXISTS (SELECT 1 FROM json_each(s.member_source_revision_refs_json) member WHERE NOT EXISTS (" +
    "SELECT 1 FROM source_revision sr JOIN source src ON src.source_id=sr.source_id" +
    " JOIN source_namespace_ownership o ON o.source_namespace_id=src.source_namespace_id AND o.status='ACTIVE'" +
    " JOIN json_each(s.source_owner_generations_json) gen ON gen.key=member.value" +
    " WHERE sr.source_revision_ref=member.value AND sr.purge_state='LIVE'" +
    " AND sr.source_owner_generation=o.source_owner_generation AND gen.value=sr.source_owner_generation))" +
    " AND t.trace_id=" + p(identity.trace_ref.id) + " AND t.revision=" + p(identity.trace_ref.revision) +
    " AND t.scope_snapshot_id=q.scope_snapshot_id AND t.scope_snapshot_revision=q.scope_snapshot_revision" +
    " AND t.trace_digest=" + p(identity.trace_json_sha256) +
    " AND json_extract(q.result_json,'$.protocol')='eliotr.retrieval-result.managed.v1'" +
    " AND json_extract(q.result_json,'$.numeric_codec')='eliotr.json-number.ecma-json-finite.v1'" +
    " AND json_extract(q.result_json,'$.result.trace') IS json(t.trace_json)" +
    " AND json_array_length(t.trace_json,'$.managed_ranking_outcomes')>=1" +
    " AND NOT EXISTS (SELECT 1 FROM json_each(t.trace_json,'$.managed_ranking_outcomes') o" +
    " WHERE json_extract(o.value,'$.request_digest') IS NOT " + p(identity.request_digest) +
    " OR json_extract(o.value,'$.scoped_invocation_id') IS NOT " + p(identity.scoped_invocation_id) +
    " OR json_extract(o.value,'$.output_digest') IS NOT " + p(identity.output_digest) + ")" +
    " AND i.operation_kind='QUERY' AND i.principal_ref=q.principal_ref AND i.idempotency_key=q.operation_id" +
    " AND i.payload_ref=" + p(resultRef(identity)) + " AND i.policy_decision_ref=s.policy_authority_ref" +
    " AND a.attempt_id=" + p(identity.attempt_ref) + " AND a.state=" + p(input.attempt_state) +
    " AND l.operation_kind='QUERY' AND l.attempt=1 AND l.lease_generation=1 AND l.state=" + p(input.lease_state) + owner +
    (input.lease_state === "LEASED" ? " AND l.lease_until>" + D1_EXECUTION_LEASE_NOW_SQL :
      " AND l.terminal_receipt_ref=" + p(`receipt:${receiptId(identity)}:1`) + " AND a.checkpoint_ref=" + p(resultRef(identity))) +
    (input.require_terminal === true ? " AND " + terminalReceiptPredicate(args, identity, input.terminal_created_at) : "") + ")";
}

interface CompletedRow {
  readonly result_json: unknown;
  readonly trace_json: unknown;
  readonly receipt_created_at: unknown;
}

async function sha256(text: string): Promise<string> {
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)))]
    .map(byte => byte.toString(16).padStart(2, "0")).join("");
}

async function readCompleted(database: RetrievalQueryD1, identity: SettlementIdentity, receipt?: AdmissionReceipt): Promise<SettlementState> {
  requireIdentity(identity, receipt);
  const args = boundSql();
  const predicate = participantPredicate(args, identity, {
    ...(receipt === undefined ? {} : { receipt }), attempt_state: "SUCCEEDED", lease_state: "COMPLETED", require_terminal: true,
  });
  const operation = args.value(identity.retrieval_operation_id);
  const terminalId = args.value(receiptId(identity));
  try {
    const row = await statement(database,
      "SELECT q.result_json,t.trace_json,r.created_at AS receipt_created_at FROM retrieval_query_result q" +
      " JOIN retrieval_query_trace t ON t.trace_id=q.trace_id AND t.revision=q.trace_revision" +
      " JOIN operation_receipt r ON r.receipt_id=" + terminalId + " AND r.revision=1" +
      " WHERE q.operation_id=" + operation + " AND " + predicate,
      args).first<CompletedRow>();
    if (row === null) return "NOT_COMMITTED";
    if (typeof row.result_json !== "string" || typeof row.trace_json !== "string" ||
        !IsoDateTimeSchema.safeParse(row.receipt_created_at).success ||
        await sha256(row.result_json) !== identity.result_json_sha256 ||
        await sha256(row.trace_json) !== identity.trace_json_sha256) return "UNKNOWN";
    return "COMMITTED";
  } catch { return "UNKNOWN"; }
}

/** Adds no schema and performs no effect outside the caller's existing result/trace batch. */
export function createD1RetrievalSettlementOwnerPort(): RetrievalSettlementOwnerPortV1 {
  return {
    prepareTerminalSettlement(database, receipt, identity, settledAt) {
      requireIdentity(identity, receipt);
      const operationReceipt = OperationReceiptSchema.safeParse({
        receipt_ref: { id: receiptId(identity), revision: 1 }, intent_ref: identity.intent_ref,
        attempt_id: identity.attempt_ref, outcome: "SUCCEEDED", output_refs: JSON.parse(outputRefs(identity)) as unknown,
        readback_receipt_refs: [], reconciliation_required: false, reason_codes: [], created_at: settledAt,
      });
      if (!operationReceipt.success) failInput();
      const receiptArgs = boundSql();
      const receiptValues = [receiptId(identity), identity.intent_ref.id, identity.attempt_ref, outputRefs(identity), settledAt]
        .map(value => receiptArgs.value(value));
      const receiptGuard = participantPredicate(receiptArgs, identity, { receipt, attempt_state: "STARTED", lease_state: "LEASED" });
      const receiptWrite = statement(database,
        "INSERT INTO operation_receipt (receipt_id,revision,intent_id,intent_revision,attempt_id,outcome,output_refs_json," +
        "readback_receipt_refs_json,reconciliation_required,reason_codes_json,created_at) SELECT " +
        `${receiptValues[0]},1,${receiptValues[1]},1,${receiptValues[2]},'SUCCEEDED',${receiptValues[3]},'[]',0,'[]',${receiptValues[4]}` +
        " WHERE " + receiptGuard + " ON CONFLICT DO NOTHING", receiptArgs);
      const attemptArgs = boundSql();
      const checkpoint = attemptArgs.value(resultRef(identity)), endedAt = attemptArgs.value(settledAt);
      const attemptId = attemptArgs.value(identity.attempt_ref);
      const attemptGuard = participantPredicate(attemptArgs, identity, {
        receipt, attempt_state: "STARTED", lease_state: "LEASED", require_terminal: true, terminal_created_at: settledAt,
      });
      const attemptWrite = statement(database,
        "UPDATE operation_attempt SET state='SUCCEEDED',checkpoint_ref=" + checkpoint + ",ended_at=" + endedAt +
        ",error_code=NULL WHERE attempt_id=" + attemptId + " AND " + attemptGuard, attemptArgs);
      const leaseArgs = boundSql();
      const terminalRef = leaseArgs.value(`receipt:${receiptId(identity)}:1`), executionId = leaseArgs.value(identity.execution_id);
      const leaseGuard = participantPredicate(leaseArgs, identity, {
        receipt, attempt_state: "SUCCEEDED", lease_state: "LEASED", require_terminal: true, terminal_created_at: settledAt,
      });
      const leaseWrite = statement(database,
        "UPDATE operation_execution_lease SET state='COMPLETED',terminal_receipt_ref=" + terminalRef +
        ",last_error_code=NULL,updated_at=" + D1_EXECUTION_LEASE_NOW_SQL + " WHERE operation_id=" + executionId +
        " AND " + leaseGuard, leaseArgs);
      const assertArgs = boundSql();
      const resultId = assertArgs.value(identity.retrieval_operation_id);
      const completed = participantPredicate(assertArgs, identity, {
        receipt, attempt_state: "SUCCEEDED", lease_state: "COMPLETED", require_terminal: true,
      });
      // A valid terminal chain changes nothing. A partial chain attempts an illegal
      // canonical completion and existing/additive result guards abort the whole batch.
      const assertTerminal = statement(database,
        "UPDATE retrieval_query_result SET state='COMPLETE' WHERE operation_id=" + resultId + " AND NOT " + completed,
        assertArgs);
      return { terminal_writes: [receiptWrite, attemptWrite, leaseWrite], assert_terminal: assertTerminal };
    },
    reconcileLostAck: (database, receipt, identity) => readCompleted(database, identity, receipt),
    readCompletedSettlement: (database, identity) => readCompleted(database, identity),
  };
}
