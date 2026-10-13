// IMPLEMENTED_NOT_LIVE: ER-04 D1-backed retrieval query persistence over migration 0021 with frozen-scope binding, idempotent result replay and exact trace linkage; lane/R2 composition and Worker wiring remain separate.
import {
  IdentifierSchema,
  MANAGED_RETRIEVAL_TRACE_PROTOCOL,
  RetrievalTraceSchema,
  IsoDateTimeSchema,
  ScopeSnapshotSchema,
  VersionedRefSchema,
  type RetrievalTrace,
  type ScopeSnapshot,
  type VersionedRef,
} from "@eliotr/contracts";
import type {
  PendingRetrievalAdmissionV1,
  RetrievalQueryAccess,
  RetrievalQueryAdmissionReceiptV1,
  RetrievalQueryD1,
  RetrievalQueryD1Statement,
  RetrievalRequest,
  RetrievalSettlementBatchPlanV1,
  RetrievalSettlementOwnerPortV1,
  RetrievalTerminalSettlementIdentityV1,
  RetrievalTracePersistenceOptions,
} from "./ports.js";
export type {
  PendingRetrievalAdmissionV1,
  RetrievalQueryAccess,
  RetrievalQueryAdmissionReceiptV1,
  RetrievalQueryAdmissionReceiptV1 as ManagedRetrievalAdmissionReceiptV1,
  RetrievalQueryD1,
  RetrievalQueryD1Statement,
  RetrievalSettlementBatchPlanV1,
  RetrievalSettlementOwnerPortV1,
  RetrievalTerminalSettlementIdentityV1,
} from "./ports.js";
import { decodeRetrievalBudgetSettlementV1 } from "./query-budget-settlement.js";
import {
  RetrievalQueryError,
  type RetrievalQueryErrorCode,
  type StoredRetrievalResult,
} from "./service.js";
import { createScopeProfilePort, type ScopeProfileBinding } from "./query-scope-profile.js";
export type { ScopeProfileBinding } from "./query-scope-profile.js";
import {
  canonicalRetrievalJson as canonicalJson,
  decodeCanonicalRetrievalJson,
  decodeEvidencePack,
  decodeRetrievalPersistenceValue,
  decodeRetrievalResult,
  decodeRetrievalTrace,
  encodeRetrievalTraceForPersistence,
  encodeRetrievalResultForPersistence,
  canonicalRetrievalResultJson,
  canonicalManagedRetrievalPublicOutputJsonV1,
  isManagedRetrievalTrace,
  managedRetrievalInvocationIdsV1,
  managedRetrievalRefIdV1,
  isRetrievalRecord as isRecord,
  retrievalSha256Hex as sha256Hex,
} from "./query-codec.js";

export function canonicalRetrievalJson(value: unknown): string {
  try {
    return canonicalJson(value);
  } catch {
    failQuery("RETRIEVAL_INPUT_INVALID", "stored query result is not canonical");
  }
}

function failQuery(code: RetrievalQueryErrorCode, message: string, retryable = false): never {
  throw new RetrievalQueryError(code, message, retryable);
}

/** A failed read-only D1 transport; corrupt bytes and stale authority are separate failures. */
export class RetrievalResultReadUnavailable extends RetrievalQueryError {
  public readonly read_only_storage_failure = true;

  public constructor(message: string) {
    super("RETRIEVAL_RESOLUTION_UNCERTAIN", message, true);
    this.name = "RetrievalResultReadUnavailable";
  }
}

function rethrowTypedQueryError(error: unknown): void {
  if (error instanceof RetrievalQueryError) throw error;
}

function mapStoreError(error: unknown): never {
  rethrowTypedQueryError(error);
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes("RETRIEVAL_AUTHORITY_STALE")) {
    failQuery("RETRIEVAL_AUTHORITY_STALE", "scope authorization is denied, purged or expired");
  }
  if (message.includes("RETRIEVAL_TRACE_CORRUPT")) {
    failQuery("RETRIEVAL_TRACE_CORRUPT", "persisted trace binding does not match the frozen query");
  }
  if (message.includes("RETRIEVAL_CONFLICT") || message.includes("RETRIEVAL_IDEMPOTENCY_CONFLICT")) {
    failQuery("RETRIEVAL_IDEMPOTENCY_CONFLICT", "idempotency identity is bound to different inputs");
  }
  failQuery("RETRIEVAL_RESOLUTION_UNCERTAIN", "query result settlement is uncertain", true);
}

function checkAccess(access: RetrievalQueryAccess): void {
  if (
    typeof access.principal_ref !== "string" || access.principal_ref.length === 0 ||
    (access.client_class !== "owner_pwa" && access.client_class !== "named_api_client" &&
      access.client_class !== "trusted_agent" && access.client_class !== "federation_client") ||
    typeof access.credential_generation !== "string" || access.credential_generation.length === 0
  ) {
    failQuery("RETRIEVAL_INPUT_INVALID", "query access identity is invalid");
  }
}

interface ScopeAuthorityRow {
  readonly snapshot_digest: unknown;
  readonly invalidated_at: unknown;
  readonly expires_at: unknown;
  readonly purge_ledger_revision: unknown;
  readonly policy_authority_ref: unknown;
  readonly grant_state: unknown;
  readonly grant_expires_at: unknown;
  readonly grant_policy_ref: unknown;
  readonly purge_frontier: unknown;
  readonly stale_members: unknown;
}

export interface CurrentScopeExpiry {
  readonly scope_expires_at: string;
  readonly grant_expires_at: string;
}

async function readScopeAuthority(
  database: RetrievalQueryD1,
  snapshotId: string,
  revision: number,
  access: RetrievalQueryAccess,
): Promise<ScopeAuthorityRow | null> {
  const row = await database.prepare(
    "SELECT s.snapshot_digest, s.invalidated_at, s.expires_at, s.purge_ledger_revision, " +
    "s.policy_authority_ref, g.state AS grant_state, g.expires_at AS grant_expires_at, " +
    "g.policy_authority_ref AS grant_policy_ref, " +
    "COALESCE((SELECT MAX(ledger_revision) FROM purge_ledger), 0) AS purge_frontier, " +
    "EXISTS (SELECT 1 FROM json_each(s.member_source_revision_refs_json) member WHERE NOT EXISTS (" +
    "SELECT 1 FROM source_revision sr JOIN source src ON src.source_id = sr.source_id " +
    "JOIN source_namespace_ownership o ON o.source_namespace_id = src.source_namespace_id " +
    "AND o.status = 'ACTIVE' " +
    "JOIN json_each(s.source_owner_generations_json) gen ON gen.key = member.value " +
    "WHERE sr.source_revision_ref = member.value AND sr.purge_state = 'LIVE' " +
    "AND sr.source_owner_generation = o.source_owner_generation " +
    "AND gen.value = sr.source_owner_generation)) AS stale_members " +
    "FROM scope_snapshot s LEFT JOIN scope_access_grant_effective g " +
    "ON g.snapshot_id = s.snapshot_id AND g.snapshot_revision = s.revision " +
    "AND g.principal_ref = ?3 AND g.client_class = ?4 AND g.credential_generation = ?5 " +
    "WHERE s.snapshot_id = ?1 AND s.revision = ?2 LIMIT 1",
  ).bind(snapshotId, revision, access.principal_ref, access.client_class, access.credential_generation)
    .first<ScopeAuthorityRow>().catch((error: unknown) => {
      rethrowTypedQueryError(error);
      failQuery("RETRIEVAL_RESOLUTION_UNCERTAIN", "scope authority read is unavailable", true);
    });
  return row;
}

function requireLiveScope(row: ScopeAuthorityRow, scope: ScopeSnapshot, nowIso: string): CurrentScopeExpiry {
  if (row.snapshot_digest !== scope.digest || row.invalidated_at !== null) {
    failQuery("RETRIEVAL_SCOPE_STALE", "ScopeSnapshot is invalidated or displaced");
  }
  const parsedNow = IsoDateTimeSchema.safeParse(nowIso);
  const nowMs = parsedNow.success ? Date.parse(parsedNow.data) : Number.NaN;
  const parsedScopeExpiry = IsoDateTimeSchema.safeParse(row.expires_at);
  const scopeExpiryMs = parsedScopeExpiry.success ? Date.parse(parsedScopeExpiry.data) : Number.NaN;
  if (!Number.isFinite(nowMs) || !parsedScopeExpiry.success || !Number.isFinite(scopeExpiryMs) || scopeExpiryMs <= nowMs) {
    failQuery("RETRIEVAL_SCOPE_STALE", "ScopeSnapshot expired");
  }
  if (row.purge_ledger_revision !== row.purge_frontier || row.stale_members !== 0) {
    failQuery("RETRIEVAL_SCOPE_STALE", "scope members are purged or rotated");
  }
  const parsedGrantExpiry = IsoDateTimeSchema.safeParse(row.grant_expires_at);
  const grantExpiryMs = parsedGrantExpiry.success ? Date.parse(parsedGrantExpiry.data) : Number.NaN;
  if (row.grant_state !== "ACTIVE" || row.grant_policy_ref !== row.policy_authority_ref ||
      !parsedGrantExpiry.success || !Number.isFinite(grantExpiryMs) || grantExpiryMs <= nowMs) {
    failQuery("RETRIEVAL_AUTHORITY_STALE", "no active exact ScopeSnapshot authorization exists");
  }
  return {
    scope_expires_at: parsedScopeExpiry.data,
    grant_expires_at: parsedGrantExpiry.data,
  };
}

export function createD1ScopePorts(
  database: RetrievalQueryD1,
  access: RetrievalQueryAccess,
  now: () => string = () => new Date().toISOString(),
): {
  freezeScope(request: RetrievalRequest): Promise<ScopeSnapshot>;
  requireCurrentScope(snapshot: ScopeSnapshot): Promise<void>;
  requireCurrentScopeWithExpiry(snapshot: ScopeSnapshot): Promise<CurrentScopeExpiry>;
} {
  checkAccess(access);
  const requireCurrentScopeWithExpiry = async (snapshot: ScopeSnapshot): Promise<CurrentScopeExpiry> => {
    const parsed = ScopeSnapshotSchema.safeParse(snapshot);
    if (!parsed.success) failQuery("RETRIEVAL_INPUT_INVALID", "scope snapshot fails strict validation");
    const row = await readScopeAuthority(database, parsed.data.snapshot_id, parsed.data.revision, access);
    if (row === null) failQuery("RETRIEVAL_SCOPE_STALE", "ScopeSnapshot does not exist");
    return requireLiveScope(row, parsed.data, now());
  };
  return {
    async freezeScope(request: RetrievalRequest): Promise<ScopeSnapshot> {
      const parsed = ScopeSnapshotSchema.safeParse(request.scope_snapshot);
      if (!parsed.success) failQuery("RETRIEVAL_INPUT_INVALID", "scope snapshot fails strict validation");
      const scope = parsed.data;
      const row = await readScopeAuthority(database, scope.snapshot_id, scope.revision, access);
      if (row === null) failQuery("RETRIEVAL_SCOPE_STALE", "ScopeSnapshot does not exist");
      requireLiveScope(row, scope, now());
      return scope;
    },
    requireCurrentScopeWithExpiry,
    async requireCurrentScope(snapshot: ScopeSnapshot): Promise<void> {
      await requireCurrentScopeWithExpiry(snapshot);
    },
  };
}

interface StoredResultRow {
  readonly operation_id: unknown;
  readonly principal_ref: unknown;
  readonly client_class: unknown;
  readonly credential_generation: unknown;
  readonly idempotency_key: unknown;
  readonly request_digest: unknown;
  readonly result_json: unknown;
  readonly result_digest: unknown;
  readonly scope_snapshot_id: unknown;
  readonly scope_snapshot_revision: unknown;
  readonly trace_id: unknown;
  readonly trace_revision: unknown;
  readonly coverage_claim: unknown;
  readonly state: unknown;
}

interface PendingAdmissionRow {
  readonly operation_id: unknown;
  readonly principal_ref: unknown;
  readonly client_class: unknown;
  readonly credential_generation: unknown;
  readonly idempotency_key: unknown;
  readonly request_digest: unknown;
  readonly scope_snapshot_id: unknown;
  readonly scope_snapshot_revision: unknown;
  readonly state: unknown;
  readonly resolved_scope_expression_json: unknown;
  readonly participant_generations_json: unknown;
  readonly member_source_revision_refs_json: unknown;
  readonly source_owner_generations_json: unknown;
  readonly policy_authority_ref: unknown;
  readonly disclosure_closure_digest: unknown;
  readonly purge_ledger_revision: unknown;
  readonly client_fence_ref: unknown;
  readonly snapshot_digest: unknown;
  readonly snapshot_created_at: unknown;
  readonly scope_expires_at: unknown;
}

function parseStoredJson(value: unknown): unknown {
  if (typeof value !== "string") return undefined;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return undefined;
  }
}

function scopeFromPendingRow(row: PendingAdmissionRow): ScopeSnapshot {
  const candidate = {
    snapshot_id: row.scope_snapshot_id,
    revision: row.scope_snapshot_revision,
    resolved_scope_expression: parseStoredJson(row.resolved_scope_expression_json),
    participant_generations: parseStoredJson(row.participant_generations_json),
    member_source_revision_refs: parseStoredJson(row.member_source_revision_refs_json),
    source_owner_generations: parseStoredJson(row.source_owner_generations_json),
    policy_authority_ref: row.policy_authority_ref,
    disclosure_closure_digest: row.disclosure_closure_digest,
    purge_ledger_revision: row.purge_ledger_revision,
    ...(row.client_fence_ref === null ? {} : { client_fence_ref: row.client_fence_ref }),
    digest: row.snapshot_digest,
    created_at: row.snapshot_created_at,
    expires_at: row.scope_expires_at,
  };
  const parsed = ScopeSnapshotSchema.safeParse(candidate);
  if (!parsed.success) {
    failQuery("RETRIEVAL_RESOLUTION_UNCERTAIN", "pending query scope snapshot is malformed", true);
  }
  return parsed.data;
}

function publicResultFromPersistedEnvelope(value: unknown): unknown | undefined {
  if (!isRecord(value)) return undefined;
  const decoded = decodeRetrievalPersistenceValue(value);
  if (decoded === null) return undefined;
  const wrapped = value.protocol === "eliotr.retrieval-result.managed.v1" ||
    Object.prototype.hasOwnProperty.call(value, "budget_settlement") ||
    Object.prototype.hasOwnProperty.call(value, "budget_settlement_digest");
  return wrapped ? {
    evidence_pack: decoded.result.evidence_pack,
    trace: decoded.result.trace,
    coverage_claim: decoded.result.coverage_claim,
  } : undefined;
}

// Rejection-only shape: an old record missing its original expression cannot
// prove replay identity. Never fill it from today's membership or decode it as
// an accepted result. Unknown fields and other malformed shapes stay uncertain.
const traceWithoutExpression = RetrievalTraceSchema.extend({
  scope_snapshot: ScopeSnapshotSchema.omit({ resolved_scope_expression: true }),
});
function lacksOriginalExpression(value: unknown): boolean {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (Object.keys(record).sort().join(",") !== "coverage_claim,evidence_pack,trace") return false;
  const trace = traceWithoutExpression.safeParse(record.trace);
  const pack = decodeEvidencePack(record.evidence_pack);
  return trace.success && pack !== null && (record.coverage_claim === "NONE" || record.coverage_claim === "SAMPLED") &&
    pack.scope_snapshot_ref.id === trace.data.scope_snapshot.snapshot_id &&
    pack.scope_snapshot_ref.revision === trace.data.scope_snapshot.revision &&
    pack.trace_ref.id === trace.data.trace_ref.id && pack.trace_ref.revision === trace.data.trace_ref.revision;
}

async function decodeStoredResult(row: StoredResultRow, idempotencyKey: string): Promise<StoredRetrievalResult> {
  if (row.state === "INVALIDATED") {
    failQuery("RETRIEVAL_SCOPE_STALE", "stored query scope is invalidated");
  }
  if (
    typeof row.request_digest !== "string" || !/^[a-f0-9]{64}$/u.test(row.request_digest) ||
    typeof row.result_json !== "string" ||
    typeof row.result_digest !== "string" || row.state !== "COMPLETE"
  ) {
    failQuery("RETRIEVAL_RESOLUTION_UNCERTAIN", "stored query result is unavailable");
  }
  const parsed = decodeCanonicalRetrievalJson(row.result_json);
  const decoded = parsed === undefined ? null : decodeRetrievalPersistenceValue(parsed);
  const resultValue = decoded === null ? parsed : {
    evidence_pack: decoded.result.evidence_pack,
    trace: decoded.result.trace,
    coverage_claim: decoded.result.coverage_claim,
  };
  const result = decoded?.result ?? null;
  if (result === null) {
    if (lacksOriginalExpression(resultValue)) {
      failQuery("RETRIEVAL_IDEMPOTENCY_CONFLICT", "stored query cannot prove its original scope expression");
    }
    failQuery("RETRIEVAL_RESOLUTION_UNCERTAIN", "stored query result is malformed or not a strict retrieval result");
  }
  if (decoded?.budget_settlement_digest !== undefined) {
    if (decoded.budget_settlement_digest !== await sha256Hex(
      canonicalRetrievalJson(decoded.budget_settlement),
    )) {
      failQuery("RETRIEVAL_RESOLUTION_UNCERTAIN", "stored budget settlement digest is invalid");
    }
    const budgetSettlement = await decodeRetrievalBudgetSettlementV1(
      decoded.budget_settlement,
      row.request_digest,
      result,
    );
    if (budgetSettlement === null) {
      failQuery("RETRIEVAL_RESOLUTION_UNCERTAIN", "stored budget settlement is malformed or not bound to its result");
    }
    return {
      request_digest: row.request_digest,
      idempotency_key: idempotencyKey,
      result,
      budget_settlement: budgetSettlement,
    };
  }
  return { request_digest: row.request_digest, idempotency_key: idempotencyKey, result };
}

async function validateManagedAdmission(
  receipt: RetrievalQueryAdmissionReceiptV1,
  record: StoredRetrievalResult,
  access: RetrievalQueryAccess,
): Promise<void> {
  const trace = isManagedRetrievalTrace(record.result.trace) ? record.result.trace : null;
  const outcomes = trace?.managed_ranking_outcomes;
  const fence = receipt?.fence;
  const ids = await managedRetrievalInvocationIdsV1(
    access.principal_ref,
    access.client_class,
    record.idempotency_key,
  );
  if (
    receipt?.protocol !== "eliotr.retrieval-query-admission.v1" ||
    trace === null || trace.protocol !== MANAGED_RETRIEVAL_TRACE_PROTOCOL ||
    receipt.retrieval_operation_id !== ids.retrieval_operation_id ||
    receipt.scoped_invocation_id !== ids.scoped_invocation_id ||
    receipt.execution_id !== ids.execution_id ||
    !IdentifierSchema.safeParse(receipt.scoped_invocation_id).success ||
    !IdentifierSchema.safeParse(receipt.execution_id).success ||
    receipt.execution_id !== fence?.operation_id ||
    receipt.request_digest !== record.request_digest ||
    !VersionedRefSchema.safeParse(receipt.scope_snapshot_ref).success ||
    receipt.scope_snapshot_ref.id !== trace.scope_snapshot.snapshot_id ||
    receipt.scope_snapshot_ref.revision !== trace.scope_snapshot.revision ||
    receipt.scope_digest !== trace.scope_snapshot.digest ||
    !VersionedRefSchema.safeParse(receipt.intent_ref).success ||
    receipt.intent_ref.id !== receipt.retrieval_operation_id || receipt.intent_ref.revision !== 1 ||
    receipt.attempt_ref !== `${receipt.retrieval_operation_id}-a1` ||
    !IdentifierSchema.safeParse(fence.operation_id).success ||
    !IdentifierSchema.safeParse(fence.lease_owner).success ||
    fence.lease_generation !== 1 ||
    receipt.scoped_invocation_id === receipt.request_digest ||
    outcomes === undefined || outcomes.length < 1 || outcomes.some((outcome) =>
      !isRecord(outcome) || outcome.scoped_invocation_id !== receipt.scoped_invocation_id ||
      outcome.request_digest !== record.request_digest)
  ) {
    failQuery("RETRIEVAL_AUTHORITY_STALE", "managed retrieval has no exact caller-owned admission receipt");
  }
}

function makeSettlementIdentity(input: {
  readonly access: RetrievalQueryAccess;
  readonly receipt: RetrievalQueryAdmissionReceiptV1;
  readonly idempotency_key: string;
  readonly request_digest: string;
  readonly output_digest: string;
  readonly result_json_sha256: string;
  readonly trace_ref: VersionedRef;
  readonly trace_json_sha256: string;
}): RetrievalTerminalSettlementIdentityV1 {
  return {
    access: input.access,
    retrieval_operation_id: input.receipt.retrieval_operation_id,
    scoped_invocation_id: input.receipt.scoped_invocation_id,
    execution_id: input.receipt.execution_id,
    idempotency_key: input.idempotency_key,
    scope_snapshot_ref: input.receipt.scope_snapshot_ref,
    scope_digest: input.receipt.scope_digest,
    intent_ref: input.receipt.intent_ref,
    attempt_ref: input.receipt.attempt_ref,
    request_digest: input.request_digest,
    output_digest: input.output_digest,
    result_json_sha256: input.result_json_sha256,
    trace_ref: input.trace_ref,
    trace_json_sha256: input.trace_json_sha256,
  };
}

const D1_EXECUTION_LEASE_NOW_SQL = "CAST(unixepoch('subsec') * 1000 AS INTEGER)";

function pendingOwnerPredicate(firstParam: number): string {
  const p = (offset: number): string => `?${firstParam + offset}`;
  return "EXISTS (SELECT 1 FROM retrieval_query_result q " +
    "JOIN scope_snapshot s ON s.snapshot_id=q.scope_snapshot_id AND s.revision=q.scope_snapshot_revision " +
    "JOIN operation_intent i ON i.intent_id=q.operation_id AND i.revision=" + p(9) + " " +
    "JOIN operation_attempt a ON a.intent_id=i.intent_id AND a.intent_revision=i.revision " +
    "JOIN operation_execution_lease l ON l.operation_id=" + p(11) + " " +
    "WHERE q.operation_id=" + p(0) + " AND q.principal_ref=" + p(1) + " AND q.client_class=" + p(2) + " " +
    "AND q.credential_generation=" + p(3) + " AND q.idempotency_key=" + p(4) + " " +
    "AND q.request_digest=" + p(5) + " AND q.scope_snapshot_id=" + p(6) + " " +
    "AND q.scope_snapshot_revision=" + p(7) + " AND q.state='PENDING' " +
    "AND s.snapshot_digest=" + p(8) + " " +
    "AND i.intent_id=" + p(0) + " AND i.operation_kind='QUERY' AND i.principal_ref=q.principal_ref " +
    "AND i.idempotency_key=q.operation_id AND i.payload_ref='retrieval-query-result:'||q.operation_id " +
    "AND i.policy_decision_ref=s.policy_authority_ref " +
    "AND a.attempt_id=" + p(10) + " AND a.attempt_number=1 AND a.state='STARTED' " +
    "AND l.operation_kind='QUERY' AND l.lease_owner=" + p(12) + " AND l.lease_generation=" + p(13) + " " +
    "AND l.attempt=1 AND l.state='LEASED' AND l.lease_until > " + D1_EXECUTION_LEASE_NOW_SQL + ")";
}

function pendingOwnerValues(
  access: RetrievalQueryAccess,
  identity: RetrievalTerminalSettlementIdentityV1,
  receipt: RetrievalQueryAdmissionReceiptV1,
): readonly unknown[] {
  return [
    identity.retrieval_operation_id,
    access.principal_ref,
    access.client_class,
    access.credential_generation,
    identity.idempotency_key,
    identity.request_digest,
    identity.scope_snapshot_ref.id,
    identity.scope_snapshot_ref.revision,
    identity.scope_digest,
    identity.intent_ref.revision,
    identity.attempt_ref,
    identity.execution_id,
    receipt.fence.lease_owner,
    receipt.fence.lease_generation,
  ];
}

export function createD1RetrievalResultStore(
  database: RetrievalQueryD1,
  access: RetrievalQueryAccess,
  now: () => string = () => new Date().toISOString(),
  settlementOwner?: RetrievalSettlementOwnerPortV1,
): {
  load(idempotencyKey: string): Promise<StoredRetrievalResult | null>;
  loadPending(idempotencyKey: string): Promise<PendingRetrievalAdmissionV1 | null>;
  store(record: StoredRetrievalResult): Promise<void>;
  settle(record: StoredRetrievalResult, receipt?: RetrievalQueryAdmissionReceiptV1): Promise<StoredRetrievalResult>;
} {
  checkAccess(access);
  const readResultRow = async (idempotencyKey: string): Promise<StoredResultRow | null> => {
    try {
      const currentCredentialRow = await database.prepare(
        "SELECT operation_id, principal_ref, client_class, credential_generation, idempotency_key, request_digest, result_json, result_digest, " +
        "scope_snapshot_id, scope_snapshot_revision, trace_id, trace_revision, coverage_claim, state FROM retrieval_query_result " +
        "WHERE principal_ref = ?1 AND client_class = ?2 AND credential_generation = ?3 " +
        "AND idempotency_key = ?4 LIMIT 1",
      ).bind(access.principal_ref, access.client_class, access.credential_generation, idempotencyKey)
        .first<StoredResultRow>();
      if (currentCredentialRow !== null) return currentCredentialRow;
      const ids = await managedRetrievalInvocationIdsV1(access.principal_ref, access.client_class, idempotencyKey);
      return await database.prepare(
        "SELECT operation_id, principal_ref, client_class, credential_generation, idempotency_key, request_digest, result_json, result_digest, " +
        "scope_snapshot_id, scope_snapshot_revision, trace_id, trace_revision, coverage_claim, state FROM retrieval_query_result " +
        "WHERE operation_id = ?1 AND principal_ref = ?2 AND client_class = ?3 AND idempotency_key = ?4 LIMIT 1",
      ).bind(ids.retrieval_operation_id, access.principal_ref, access.client_class, idempotencyKey)
        .first<StoredResultRow>();
    } catch (error: unknown) {
      rethrowTypedQueryError(error);
      throw new RetrievalResultReadUnavailable("stored query result is unavailable");
    }
  };
  const readPendingRow = async (idempotencyKey: string): Promise<PendingAdmissionRow | null> => {
    try {
      const ids = await managedRetrievalInvocationIdsV1(access.principal_ref, access.client_class, idempotencyKey);
      return await database.prepare(
        "SELECT q.operation_id,q.principal_ref,q.client_class,q.credential_generation,q.idempotency_key,q.request_digest," +
        "q.scope_snapshot_id,q.scope_snapshot_revision,q.state,s.resolved_scope_expression_json," +
        "s.participant_generations_json,s.member_source_revision_refs_json,s.source_owner_generations_json," +
        "s.policy_authority_ref,s.disclosure_closure_digest,s.purge_ledger_revision,s.client_fence_ref," +
        "s.snapshot_digest,s.created_at AS snapshot_created_at,s.expires_at AS scope_expires_at " +
        "FROM retrieval_query_result q JOIN scope_snapshot s ON s.snapshot_id=q.scope_snapshot_id " +
        "AND s.revision=q.scope_snapshot_revision WHERE q.operation_id=?1 AND q.principal_ref=?2 " +
        "AND q.client_class=?3 AND q.idempotency_key=?4 AND q.state='PENDING' LIMIT 1",
      ).bind(ids.retrieval_operation_id, access.principal_ref, access.client_class, idempotencyKey)
        .first<PendingAdmissionRow>();
    } catch (error: unknown) {
      rethrowTypedQueryError(error);
      failQuery("RETRIEVAL_RESOLUTION_UNCERTAIN", "pending query admission is unavailable", true);
    }
  };
  const readTraceRow = async (traceId: string, revision: number): Promise<{
    readonly trace_json: unknown;
    readonly trace_digest: unknown;
    readonly scope_snapshot_id: unknown;
    readonly scope_snapshot_revision: unknown;
  } | null> => {
    try {
      return await database.prepare(
        "SELECT trace_json, trace_digest, scope_snapshot_id, scope_snapshot_revision FROM retrieval_query_trace " +
        "WHERE trace_id = ?1 AND revision = ?2 LIMIT 1",
      ).bind(traceId, revision).first<{
        readonly trace_json: unknown;
        readonly trace_digest: unknown;
        readonly scope_snapshot_id: unknown;
        readonly scope_snapshot_revision: unknown;
      }>();
    } catch (error: unknown) {
      rethrowTypedQueryError(error);
      throw new RetrievalResultReadUnavailable("stored query trace is unavailable");
    }
  };
  const load = async (idempotencyKey: string): Promise<StoredRetrievalResult | null> => {
    if (
      typeof idempotencyKey !== "string" || idempotencyKey.length < 1 || idempotencyKey.length > 256 ||
      /[\u0000-\u0020\u007f]/u.test(idempotencyKey)
    ) {
      failQuery("RETRIEVAL_INPUT_INVALID", "idempotency-key is required");
    }
    const row = await readResultRow(idempotencyKey);
    if (row === null) return null;
    // PENDING is the canonical admission record, not a replayable result.
    // Callers must loadPending before minting any replacement scope snapshot.
    if (row.state === "PENDING") return null;
    if (row.state === "COMPLETE" && typeof row.result_json === "string" &&
        row.result_digest !== await sha256Hex(row.result_json)) {
      const envelopeValue = decodeCanonicalRetrievalJson(row.result_json);
      const publicResult = publicResultFromPersistedEnvelope(envelopeValue);
      if (publicResult === undefined ||
          row.result_digest !== await sha256Hex(canonicalRetrievalResultJson(publicResult))) {
        failQuery("RETRIEVAL_RESOLUTION_UNCERTAIN", "stored query result metadata is not bound to its result");
      }
    }
    const stored = await decodeStoredResult(row, idempotencyKey);
    if (typeof row.result_json !== "string" ||
        row.scope_snapshot_id !== stored.result.trace.scope_snapshot.snapshot_id ||
        row.scope_snapshot_revision !== stored.result.trace.scope_snapshot.revision ||
        row.scope_snapshot_id !== stored.result.evidence_pack.scope_snapshot_ref.id ||
        row.scope_snapshot_revision !== stored.result.evidence_pack.scope_snapshot_ref.revision ||
        row.trace_id !== stored.result.trace.trace_ref.id || row.trace_revision !== stored.result.trace.trace_ref.revision ||
        row.trace_id !== stored.result.evidence_pack.trace_ref.id || row.trace_revision !== stored.result.evidence_pack.trace_ref.revision ||
        row.coverage_claim !== stored.result.coverage_claim) {
      failQuery("RETRIEVAL_RESOLUTION_UNCERTAIN", "stored query result metadata is not bound to its result");
    }
    const traceRow = await readTraceRow(stored.result.trace.trace_ref.id, stored.result.trace.trace_ref.revision);
    const storedTraceValue = traceRow !== null && typeof traceRow.trace_json === "string"
      ? decodeCanonicalRetrievalJson(traceRow.trace_json)
      : undefined;
    if (traceRow === null || typeof traceRow.trace_json !== "string" || typeof traceRow.trace_digest !== "string" ||
        traceRow.trace_digest !== await sha256Hex(traceRow.trace_json) ||
        traceRow.scope_snapshot_id !== stored.result.trace.scope_snapshot.snapshot_id ||
        traceRow.scope_snapshot_revision !== stored.result.trace.scope_snapshot.revision ||
        traceRow.scope_snapshot_id !== stored.result.evidence_pack.scope_snapshot_ref.id ||
        traceRow.scope_snapshot_revision !== stored.result.evidence_pack.scope_snapshot_ref.revision ||
        storedTraceValue === undefined ||
        encodeRetrievalTraceForPersistence(storedTraceValue) !== encodeRetrievalTraceForPersistence(stored.result.trace)) {
      failQuery("RETRIEVAL_RESOLUTION_UNCERTAIN", "stored query trace linkage is not bound to its result");
    }
    if (isManagedRetrievalTrace(stored.result.trace)) {
      if (typeof row.operation_id !== "string" || typeof row.result_json !== "string" ||
          typeof traceRow.trace_json !== "string" || typeof traceRow.trace_digest !== "string" ||
          settlementOwner === undefined) {
        failQuery("RETRIEVAL_RESOLUTION_UNCERTAIN", "managed query owner readback is unavailable", true);
      }
      const scopeRow = await readScopeAuthority(
        database,
        stored.result.trace.scope_snapshot.snapshot_id,
        stored.result.trace.scope_snapshot.revision,
        access,
      );
      if (scopeRow === null) failQuery("RETRIEVAL_SCOPE_STALE", "managed query scope no longer exists");
      requireLiveScope(scopeRow, stored.result.trace.scope_snapshot, now());
      const outcomes = stored.result.trace.managed_ranking_outcomes;
      const ids = await managedRetrievalInvocationIdsV1(access.principal_ref, access.client_class, idempotencyKey);
      const outputDigest = await sha256Hex(canonicalManagedRetrievalPublicOutputJsonV1(stored.result));
      if (row.operation_id !== ids.retrieval_operation_id || row.request_digest !== stored.request_digest ||
          outcomes.length < 1 || outcomes.some((outcome) => outcome.scoped_invocation_id !== ids.scoped_invocation_id ||
            outcome.request_digest !== stored.request_digest || outcome.output_digest !== outputDigest)) {
        failQuery("RETRIEVAL_RESOLUTION_UNCERTAIN", "managed query invocation identity is inconsistent", true);
      }
      const identity: RetrievalTerminalSettlementIdentityV1 = {
        access,
        retrieval_operation_id: ids.retrieval_operation_id,
        scoped_invocation_id: ids.scoped_invocation_id,
        execution_id: ids.execution_id,
        idempotency_key: idempotencyKey,
        scope_snapshot_ref: { id: stored.result.trace.scope_snapshot.snapshot_id, revision: stored.result.trace.scope_snapshot.revision },
        scope_digest: stored.result.trace.scope_snapshot.digest,
        intent_ref: { id: ids.retrieval_operation_id, revision: 1 },
        attempt_ref: `${ids.retrieval_operation_id}-a1`,
        request_digest: stored.request_digest,
        output_digest: outputDigest,
        result_json_sha256: await sha256Hex(row.result_json),
        trace_ref: stored.result.trace.trace_ref,
        trace_json_sha256: traceRow.trace_digest,
      };
      const committed = await settlementOwner.readCompletedSettlement(database, identity);
      if (committed !== "COMMITTED") {
        failQuery("RETRIEVAL_RESOLUTION_UNCERTAIN", "managed query terminal authority is not committed", true);
      }
    }
    return stored;
  };
  const loadPending = async (idempotencyKey: string): Promise<PendingRetrievalAdmissionV1 | null> => {
    if (
      typeof idempotencyKey !== "string" || idempotencyKey.length < 1 || idempotencyKey.length > 256 ||
      /[\u0000-\u0020\u007f]/u.test(idempotencyKey)
    ) {
      failQuery("RETRIEVAL_INPUT_INVALID", "idempotency-key is required");
    }
    // Preserve historical completed replay as the first leg. A second load by
    // the caller after a null result closes the completion race before scope freeze.
    if (await load(idempotencyKey) !== null) return null;
    const row = await readPendingRow(idempotencyKey);
    if (row === null) return null;
    const ids = await managedRetrievalInvocationIdsV1(access.principal_ref, access.client_class, idempotencyKey);
    if (row.operation_id !== ids.retrieval_operation_id || row.principal_ref !== access.principal_ref ||
        row.client_class !== access.client_class || row.idempotency_key !== idempotencyKey ||
        typeof row.credential_generation !== "string" || typeof row.request_digest !== "string" ||
        !/^[a-f0-9]{64}$/u.test(row.request_digest)) {
      failQuery("RETRIEVAL_RESOLUTION_UNCERTAIN", "pending query admission identity is malformed", true);
    }
    const scopeSnapshot = scopeFromPendingRow(row);
    if (scopeSnapshot.snapshot_id !== row.scope_snapshot_id || scopeSnapshot.revision !== row.scope_snapshot_revision) {
      failQuery("RETRIEVAL_RESOLUTION_UNCERTAIN", "pending query scope binding is malformed", true);
    }
    return {
      retrieval_operation_id: ids.retrieval_operation_id,
      request_digest: row.request_digest,
      idempotency_key: idempotencyKey,
      credential_generation: row.credential_generation,
      scope_snapshot: scopeSnapshot,
    };
  };
  const persistSettlement = async (
    record: StoredRetrievalResult,
    admission?: RetrievalQueryAdmissionReceiptV1,
  ): Promise<StoredRetrievalResult> => {
    if (typeof record.idempotency_key !== "string" || typeof record.request_digest !== "string" ||
        !/^[a-f0-9]{64}$/u.test(record.request_digest)) {
      failQuery("RETRIEVAL_INPUT_INVALID", "query result identity is invalid");
    }
    const historical = await load(record.idempotency_key);
    if (historical !== null) {
      if (historical.request_digest !== record.request_digest) {
        failQuery("RETRIEVAL_IDEMPOTENCY_CONFLICT", "idempotency identity is bound to different inputs");
      }
      return historical;
    }
    if (record.result.coverage_claim !== "NONE" && record.result.coverage_claim !== "SAMPLED") {
      failQuery("RETRIEVAL_INPUT_INVALID", "coverage stronger than SAMPLED is never stored");
    }
    if (decodeRetrievalResult(record.result) === null) {
      failQuery("RETRIEVAL_INPUT_INVALID", "query result fails strict validation");
    }
    const trace = decodeRetrievalTrace(record.result.trace);
    if (trace === null) failQuery("RETRIEVAL_INPUT_INVALID", "query trace fails strict validation");
    const managed = isManagedRetrievalTrace(trace);
    let managedOutputDigest: string | undefined;
    if (managed) {
      if (admission === undefined || settlementOwner === undefined) {
        failQuery("RETRIEVAL_AUTHORITY_STALE", "managed result settlement requires the caller's durable admission receipt");
      }
      await validateManagedAdmission(admission, record, access);
      const pending = await readPendingRow(record.idempotency_key);
      if (pending === null) {
        // Another ACK may have completed between the initial replay read and
        // this check. Re-read the completed path before treating it as lost.
        const completed = await load(record.idempotency_key);
        if (completed !== null && completed.request_digest === record.request_digest) return completed;
        failQuery("RETRIEVAL_AUTHORITY_STALE", "managed result has no original PENDING admission row");
      }
      const pendingScope = scopeFromPendingRow(pending);
      if (pending.request_digest !== record.request_digest || pending.request_digest !== admission.request_digest) {
        failQuery("RETRIEVAL_IDEMPOTENCY_CONFLICT", "PENDING request digest differs from the admitted request");
      }
      if (pending.operation_id !== admission.retrieval_operation_id ||
          pending.credential_generation !== access.credential_generation) {
        failQuery("RETRIEVAL_AUTHORITY_STALE", "PENDING row is not owned by the current admission receipt");
      }
      if (pending.scope_snapshot_id !== admission.scope_snapshot_ref.id ||
          pending.scope_snapshot_revision !== admission.scope_snapshot_ref.revision ||
          pendingScope.digest !== admission.scope_digest ||
          canonicalRetrievalJson(pendingScope) !== canonicalRetrievalJson(trace.scope_snapshot)) {
        failQuery("RETRIEVAL_IDEMPOTENCY_CONFLICT", "managed result does not use the original frozen scope snapshot");
      }
      const outcomes = trace.managed_ranking_outcomes;
      managedOutputDigest = await sha256Hex(canonicalManagedRetrievalPublicOutputJsonV1(record.result));
      if (outcomes.length < 1 || outcomes.some((outcome) => outcome.output_digest !== managedOutputDigest)) {
        failQuery("RETRIEVAL_TRACE_CORRUPT", "managed outcome output digest does not bind the public evidence payload");
      }
    } else {
      if (admission !== undefined) {
        failQuery("RETRIEVAL_INPUT_INVALID", "legacy result cannot consume a managed query admission receipt");
      }
      if (await readPendingRow(record.idempotency_key) !== null) {
        failQuery("RETRIEVAL_AUTHORITY_STALE", "legacy result cannot settle a managed PENDING admission");
      }
    }
    if (record.budget_settlement !== undefined && await decodeRetrievalBudgetSettlementV1(
      record.budget_settlement,
      record.request_digest,
      record.result,
    ) === null) {
      failQuery("RETRIEVAL_TRACE_CORRUPT", "budget settlement is not bound to the query result");
    }
    const persistedValue = record.budget_settlement === undefined
      ? record.result
      : {
        ...record.result,
        budget_settlement: record.budget_settlement,
        budget_settlement_digest: await sha256Hex(canonicalRetrievalJson(record.budget_settlement)),
      };
    const resultJson = encodeRetrievalResultForPersistence(persistedValue);
    const traceJson = encodeRetrievalTraceForPersistence(trace);
    if (new TextEncoder().encode(resultJson).byteLength > 1000000 ||
        new TextEncoder().encode(traceJson).byteLength > 262144) {
      failQuery("RETRIEVAL_INPUT_INVALID", "query result or trace exceeds its bound");
    }
    const resultDigest = await sha256Hex(canonicalRetrievalResultJson(record.result));
    const traceDigest = await sha256Hex(traceJson);
    const operationId = managed
      ? admission?.retrieval_operation_id ?? failQuery("RETRIEVAL_AUTHORITY_STALE", "managed admission receipt is absent")
      : `q3-${(await sha256Hex(canonicalRetrievalJson({
        principal: access.principal_ref,
        client: access.client_class,
        credential: access.credential_generation,
        key: record.idempotency_key,
      }))).slice(0, 48)}`;
    if (managed) {
      if (admission === undefined) failQuery("RETRIEVAL_AUTHORITY_STALE", "managed admission receipt is absent");
      const traceId = await managedRetrievalRefIdV1(admission.scoped_invocation_id, "trace");
      const packId = await managedRetrievalRefIdV1(admission.scoped_invocation_id, "pack");
      if (trace.trace_ref.id !== traceId || trace.trace_ref.revision !== 1 ||
          record.result.evidence_pack.pack_ref.id !== packId || record.result.evidence_pack.pack_ref.revision !== 1) {
        failQuery("RETRIEVAL_TRACE_CORRUPT", "managed trace and pack refs are not bound to the stable invocation identity");
      }
    }
    const createdAt = now();
    if (!IsoDateTimeSchema.safeParse(createdAt).success) {
      failQuery("RETRIEVAL_RESOLUTION_UNCERTAIN", "settlement clock returned an invalid timestamp", true);
    }
    const batch = database.batch;
    if (batch === undefined) {
      failQuery("RETRIEVAL_RESOLUTION_UNCERTAIN", "atomic D1 trace/result settlement is unavailable", true);
    }
    let identity: RetrievalTerminalSettlementIdentityV1 | undefined;
    let batchPlan: RetrievalSettlementBatchPlanV1 | undefined;
    if (managed) {
      if (admission === undefined || managedOutputDigest === undefined || settlementOwner === undefined) {
        failQuery("RETRIEVAL_AUTHORITY_STALE", "managed terminal settlement context is absent");
      }
      identity = makeSettlementIdentity({
        access,
        receipt: admission,
        idempotency_key: record.idempotency_key,
        request_digest: record.request_digest,
        output_digest: managedOutputDigest,
        result_json_sha256: await sha256Hex(resultJson),
        trace_ref: trace.trace_ref,
        trace_json_sha256: traceDigest,
      });
      batchPlan = settlementOwner.prepareTerminalSettlement(database, admission, identity, createdAt);
    }
    let traceWrite: RetrievalQueryD1Statement;
    let resultWrite: RetrievalQueryD1Statement;
    if (managed) {
      if (identity === undefined || admission === undefined) {
        failQuery("RETRIEVAL_AUTHORITY_STALE", "managed terminal settlement identity is absent");
      }
      const ownerValues = pendingOwnerValues(access, identity, admission);
      const ownerPredicate = pendingOwnerPredicate(8);
      traceWrite = database.prepare(
        "INSERT INTO retrieval_query_trace (trace_id,revision,scope_snapshot_id,scope_snapshot_revision,trace_json,trace_digest,created_at) " +
        `SELECT ?1,?2,?3,?4,?5,?6,?7 WHERE ${ownerPredicate} ` +
        "AND NOT EXISTS (SELECT 1 FROM retrieval_query_trace WHERE trace_id=?1 AND revision=?2 " +
        "AND (scope_snapshot_id IS NOT ?3 OR scope_snapshot_revision IS NOT ?4 OR trace_json IS NOT ?5 OR trace_digest IS NOT ?6)) " +
        "ON CONFLICT DO NOTHING",
      ).bind(
        trace.trace_ref.id, trace.trace_ref.revision, trace.scope_snapshot.snapshot_id,
        trace.scope_snapshot.revision, traceJson, traceDigest, createdAt, ...ownerValues,
      );
      const updateOwnerPredicate = pendingOwnerPredicate(6);
      resultWrite = database.prepare(
        "UPDATE retrieval_query_result SET state='COMPLETE',result_json=?1,result_digest=?2,trace_id=?3," +
        "trace_revision=?4,coverage_claim=?5 WHERE operation_id=?6 AND state='PENDING' " +
        `AND ${updateOwnerPredicate} AND EXISTS (SELECT 1 FROM retrieval_query_trace t ` +
        "WHERE t.trace_id=?3 AND t.revision=?4 AND t.scope_snapshot_id=?20 AND t.scope_snapshot_revision=?21 " +
        "AND t.trace_json=?22 AND t.trace_digest=?23)",
      ).bind(resultJson, resultDigest, trace.trace_ref.id, trace.trace_ref.revision,
        record.result.coverage_claim, ...ownerValues, trace.scope_snapshot.snapshot_id,
        trace.scope_snapshot.revision, traceJson, traceDigest);
    } else {
      traceWrite = database.prepare(
        "INSERT INTO retrieval_query_trace (trace_id,revision,scope_snapshot_id,scope_snapshot_revision,trace_json,trace_digest,created_at) " +
        "SELECT ?1,?2,?3,?4,?5,?6,?7 WHERE NOT EXISTS (SELECT 1 FROM retrieval_query_result q " +
        "WHERE q.operation_id=?8 OR (q.principal_ref=?9 AND q.client_class=?10 AND q.idempotency_key=?12 " +
        "AND (q.credential_generation=?11 OR q.operation_id LIKE 'q4-%'))) " +
        "AND NOT EXISTS (SELECT 1 FROM retrieval_query_trace WHERE trace_id=?1 AND revision=?2 " +
        "AND (scope_snapshot_id IS NOT ?3 OR scope_snapshot_revision IS NOT ?4 OR trace_json IS NOT ?5 OR trace_digest IS NOT ?6)) " +
        "ON CONFLICT DO NOTHING",
      ).bind(
        trace.trace_ref.id, trace.trace_ref.revision, trace.scope_snapshot.snapshot_id,
        trace.scope_snapshot.revision, traceJson, traceDigest, createdAt,
        operationId, access.principal_ref, access.client_class, access.credential_generation, record.idempotency_key,
      );
      resultWrite = database.prepare(
        "INSERT INTO retrieval_query_result (operation_id,principal_ref,client_class,credential_generation,idempotency_key,request_digest," +
        "scope_snapshot_id,scope_snapshot_revision,state,result_json,result_digest,trace_id,trace_revision,coverage_claim,created_at,expires_at) " +
        "SELECT ?1,?2,?3,?4,?5,?6,?7,?8,'COMPLETE',?9,?10,?11,?12,?13,?14,?15 " +
        "WHERE EXISTS (SELECT 1 FROM retrieval_query_trace WHERE trace_id=?11 AND revision=?12 AND scope_snapshot_id=?7 " +
        "AND scope_snapshot_revision=?8 AND trace_json=?16 AND trace_digest=?17) " +
        "AND NOT EXISTS (SELECT 1 FROM retrieval_query_result q WHERE q.operation_id=?1 OR " +
        "(q.principal_ref=?2 AND q.client_class=?3 AND q.credential_generation=?4 AND q.idempotency_key=?5)) " +
        "ON CONFLICT DO NOTHING",
      ).bind(
        operationId, access.principal_ref, access.client_class, access.credential_generation,
        record.idempotency_key, record.request_digest, trace.scope_snapshot.snapshot_id,
        trace.scope_snapshot.revision, resultJson, resultDigest,
        trace.trace_ref.id, trace.trace_ref.revision, record.result.coverage_claim,
        createdAt, trace.scope_snapshot.expires_at, traceJson, traceDigest,
      );
    }
    const statements: RetrievalQueryD1Statement[] = [
      traceWrite,
      resultWrite,
      ...(batchPlan?.terminal_writes ?? []),
      ...(batchPlan === undefined ? [] : [batchPlan.assert_terminal]),
    ];
    let batchError: unknown;
    try {
      await batch.call(database, statements);
    } catch (error: unknown) {
      batchError = error;
    }

    const durableRow = managed
      ? await database.prepare(
        "SELECT operation_id,principal_ref,client_class,credential_generation,idempotency_key,request_digest,result_json,result_digest," +
        "scope_snapshot_id,scope_snapshot_revision,trace_id,trace_revision,coverage_claim,state FROM retrieval_query_result " +
        "WHERE operation_id=?1 AND principal_ref=?2 AND client_class=?3 AND idempotency_key=?4 LIMIT 1",
      ).bind(operationId, access.principal_ref, access.client_class, record.idempotency_key).first<StoredResultRow>()
      : await readResultRow(record.idempotency_key);
    if (durableRow !== null && durableRow.request_digest !== record.request_digest) {
      failQuery("RETRIEVAL_IDEMPOTENCY_CONFLICT", "idempotency identity is bound to different inputs");
    }
    let exactRows = false;
    if (durableRow !== null && typeof durableRow.result_json === "string" &&
        typeof durableRow.result_digest === "string" && durableRow.operation_id === operationId &&
        durableRow.result_json === resultJson && durableRow.result_digest === resultDigest &&
        durableRow.scope_snapshot_id === trace.scope_snapshot.snapshot_id &&
        durableRow.scope_snapshot_revision === trace.scope_snapshot.revision &&
        durableRow.trace_id === trace.trace_ref.id && durableRow.trace_revision === trace.trace_ref.revision &&
        durableRow.coverage_claim === record.result.coverage_claim && durableRow.state === "COMPLETE") {
      const durableTrace = await readTraceRow(trace.trace_ref.id, trace.trace_ref.revision);
      exactRows = durableTrace !== null && durableTrace.trace_json === traceJson &&
        durableTrace.trace_digest === traceDigest &&
        durableTrace.scope_snapshot_id === trace.scope_snapshot.snapshot_id &&
        durableTrace.scope_snapshot_revision === trace.scope_snapshot.revision;
    }

    if (managed && admission !== undefined && settlementOwner !== undefined && identity !== undefined) {
      const scopeRow = await readScopeAuthority(
        database,
        trace.scope_snapshot.snapshot_id,
        trace.scope_snapshot.revision,
        access,
      );
      if (scopeRow === null) failQuery("RETRIEVAL_SCOPE_STALE", "managed query scope no longer exists");
      requireLiveScope(scopeRow, trace.scope_snapshot, now());
      const authority = batchError === undefined && exactRows
        ? await settlementOwner.readCompletedSettlement(database, identity)
        : await settlementOwner.reconcileLostAck(database, admission, identity);
      if (authority !== "COMMITTED" || !exactRows) {
        failQuery("RETRIEVAL_RESOLUTION_UNCERTAIN", "managed settlement ACK cannot be reconciled to current owner authority", true);
      }
    } else if (batchError !== undefined && !exactRows) {
      mapStoreError(batchError);
    }

    if (!exactRows) {
      if (batchError !== undefined) mapStoreError(batchError);
      failQuery("RETRIEVAL_RESOLUTION_UNCERTAIN", "query result and trace were not durably settled together", true);
    }
    const winner = await load(record.idempotency_key);
    if (winner === null) failQuery("RETRIEVAL_RESOLUTION_UNCERTAIN", "query result settlement is uncertain", true);
    if (winner.request_digest !== record.request_digest) {
      failQuery("RETRIEVAL_IDEMPOTENCY_CONFLICT", "idempotency identity is bound to different inputs");
    }
    return winner;
  };
  return {
    load,
    loadPending,
    async store(record: StoredRetrievalResult): Promise<void> {
      await persistSettlement(record);
    },
    settle: persistSettlement,
  };
}

export function createD1RetrievalTracePort(
  database: RetrievalQueryD1,
  access: RetrievalQueryAccess,
  now: () => string = () => new Date().toISOString(),
): {
  persistTrace(trace: RetrievalTrace, options?: RetrievalTracePersistenceOptions): Promise<VersionedRef>;
} {
  checkAccess(access);
  return {
    async persistTrace(
      trace: RetrievalTrace,
      options?: RetrievalTracePersistenceOptions,
    ): Promise<VersionedRef> {
      const body = decodeRetrievalTrace(trace);
      if (body === null) failQuery("RETRIEVAL_INPUT_INVALID", "query trace fails strict validation");
      if (isManagedRetrievalTrace(body) && options?.defer_until_result_settlement !== true) {
        failQuery("RETRIEVAL_AUTHORITY_STALE", "managed trace must be deferred into atomic result settlement");
      }
      const traceJson = encodeRetrievalTraceForPersistence(body);
      if (new TextEncoder().encode(traceJson).byteLength > 262144) {
        failQuery("RETRIEVAL_INPUT_INVALID", "query trace exceeds its bound");
      }
      if (options?.defer_until_result_settlement === true) return body.trace_ref;
      const traceDigest = await sha256Hex(traceJson);
      try {
        await database.prepare(
          "INSERT INTO retrieval_query_trace (trace_id, revision, scope_snapshot_id, " +
          "scope_snapshot_revision, trace_json, trace_digest, created_at) " +
          "VALUES (?1,?2,?3,?4,?5,?6,?7) ON CONFLICT DO NOTHING",
        ).bind(
          body.trace_ref.id, body.trace_ref.revision, body.scope_snapshot.snapshot_id,
          body.scope_snapshot.revision, traceJson, traceDigest, now(),
        ).run();
      } catch (error) {
        mapStoreError(error);
      }
      let settled: { readonly trace_json: unknown; readonly trace_digest: unknown } | null;
      try {
        settled = await database.prepare(
          "SELECT trace_json, trace_digest FROM retrieval_query_trace " +
          "WHERE trace_id = ?1 AND revision = ?2 LIMIT 1",
        ).bind(body.trace_ref.id, body.trace_ref.revision)
          .first<{ readonly trace_json: unknown; readonly trace_digest: unknown }>();
      } catch (error: unknown) {
        rethrowTypedQueryError(error);
        failQuery("RETRIEVAL_RESOLUTION_UNCERTAIN", "trace persistence is unavailable", true);
      }
      if (settled === null || settled.trace_json !== traceJson || settled.trace_digest !== traceDigest) {
        failQuery("RETRIEVAL_RESOLUTION_UNCERTAIN", "trace persistence is unavailable", true);
      }
      return body.trace_ref;
    },
  };
}

export function createQueryBudgetGuard(
  deadlineMs: number,
  isCancelled: () => boolean = () => false,
  nowMs: () => number = Date.now,
): { checkBudget(): void } {
  return {
    checkBudget(): void {
      if (isCancelled()) failQuery("RETRIEVAL_CANCELLED", "query is cancelled");
      if (!Number.isSafeInteger(deadlineMs) || nowMs() > deadlineMs) {
        failQuery("RETRIEVAL_BUDGET_STOP", "query budget is exhausted");
      }
    },
  };
}

export function createD1ScopeProfilePort(
  database: RetrievalQueryD1,
  now: () => string = () => new Date().toISOString(),
): {
  loadBinding(snapshot: ScopeSnapshot): Promise<ScopeProfileBinding>;
  recordBinding(snapshot: ScopeSnapshot, binding: ScopeProfileBinding): Promise<void>;
  requireBinding(snapshot: ScopeSnapshot, binding: ScopeProfileBinding): Promise<void>;
} {
  return createScopeProfilePort(database, now, { failQuery, mapStoreError, rethrowTypedQueryError });
}

export { retrievalRequestDigest } from "./query-codec.js";
