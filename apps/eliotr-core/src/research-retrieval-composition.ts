import {
  createCloudflareEvidenceResolver,
  createD1EvidenceAuthorityPort,
  createR2EvidenceContentPort,
  EvidenceRuntimeError,
} from "@eliotr/cloudflare-evidence";
import { AI_SEARCH_PRIMARY_NAMESPACE, createD1BackedAiSearchManagedSearchPort } from "@eliotr/cloudflare-ai";
import { createD1SearchIdentPort, createD1SearchLexPort } from "@eliotr/cloudflare-projection";
import {
  createD1RetrievalResultStore,
  createD1RetrievalTracePort,
  createD1ScopePorts,
  createD1ScopeProfilePort,
  createIdentLaneExecutor,
  createLexLaneExecutor,
  createQueryBudgetGuard,
  createRetrievalQueryService,
  createSemLaneExecutor,
  RetrievalQueryError,
  type RetrievalQueryAccess,
  type RetrievalQueryPorts,
  type ScopeProfileBinding,
} from "@eliotr/retrieval";
import type { LocatorCandidate, ResolvedEvidence, RetrievalLane, ScopeSnapshot, VersionedRef } from "@eliotr/contracts";
import type { RetrievalRequest, RetrievalResult } from "@eliotr/retrieval";
import type { Env } from "./env.js";

export type ResearchRetrievalEnvironment = Pick<Env, "CORE_DB" | "SEARCH_DB" | "EVIDENCE_BUCKET"> & {
  readonly AI_SEARCH?: Env["AI_SEARCH"];
};

export interface HeldScopeRetrievalInput {
  readonly access: RetrievalQueryAccess;
  readonly scope_snapshot: ScopeSnapshot;
  readonly raw_query: string;
  readonly product: RetrievalRequest["product"];
  readonly literals: readonly string[];
  readonly requested_limit: number;
  readonly deadline_ms: number;
  readonly idempotency_key: string;
  readonly signal: AbortSignal;
  /** Server-selected immutable profile; never sourced from a public request. */
  readonly profile: ScopeProfileBinding;
}

export interface HeldResearchScope {
  readonly operation_id: string;
  readonly investigation_id: string;
  readonly scope_snapshot_ref: VersionedRef;
  readonly scope_snapshot: ScopeSnapshot;
  readonly policy_generation: string;
  readonly policy_authority_ref: string;
  readonly authorization_receipt_ref: string;
  readonly purge_revision: number;
  readonly deployment_generation: string;
}

interface StoredRunScopeRow {
  readonly operation_id: unknown;
  readonly investigation_id: unknown;
  readonly principal_ref: unknown;
  readonly credential_generation: unknown;
  readonly deployment_generation: unknown;
  readonly policy_generation: unknown;
  readonly policy_authority_ref: unknown;
  readonly authorization_receipt_ref: unknown;
  readonly scope_snapshot_id: unknown;
  readonly scope_snapshot_revision: unknown;
  readonly purge_revision: unknown;
}

const OMITTED_CANDIDATE_CODES: ReadonlySet<string> = new Set([
  "EVIDENCE_INPUT_INVALID", "EVIDENCE_SCOPE_MISMATCH", "EVIDENCE_LOCATOR_NOT_RESOLVABLE",
  "EVIDENCE_PRECISION_UNSUPPORTED", "EVIDENCE_OBJECT_NOT_FOUND", "EVIDENCE_OBJECT_INTEGRITY",
  "EVIDENCE_RANGE_INVALID", "EVIDENCE_SOURCE_NOT_FOUND", "EVIDENCE_HANDLE_NOT_FOUND",
  "EVIDENCE_HANDLE_NOT_LIVE", "EVIDENCE_IDENTITY_CONFLICT",
]);
const STALE_AUTHORITY_CODES: ReadonlySet<string> = new Set([
  "EVIDENCE_SCOPE_NOT_FOUND", "EVIDENCE_SCOPE_INVALIDATED", "EVIDENCE_SCOPE_EXPIRED",
  "EVIDENCE_AUTHORIZATION_DENIED", "EVIDENCE_SOURCE_NOT_LIVE", "EVIDENCE_OWNER_GENERATION_MISMATCH",
]);

function fail(code: "RETRIEVAL_RESOLUTION_UNCERTAIN" | "RETRIEVAL_AUTHORITY_STALE", message: string): never {
  throw new RetrievalQueryError(code, message, code === "RETRIEVAL_RESOLUTION_UNCERTAIN");
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) fail("RETRIEVAL_RESOLUTION_UNCERTAIN", `stored research scope ${field} is invalid`);
  return value;
}

function positiveRevision(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) fail("RETRIEVAL_RESOLUTION_UNCERTAIN", "stored research scope revision is invalid");
  return value as number;
}

function nonnegativeInteger(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) fail("RETRIEVAL_RESOLUTION_UNCERTAIN", "stored research purge revision is invalid");
  return value as number;
}

/**
 * Loads the scope pinned by a durable W1/W2 run. The workflow view is the
 * trusted binding for principal, policy, deployment and research grant; the
 * snapshot reader then supplies the canonical stored bytes. This never
 * freezes, grants, or derives a scope from caller input.
 */
export async function loadHeldResearchScope(
  env: Pick<Env, "CORE_DB" | "SEARCH_DB">,
  access: RetrievalQueryAccess,
  operationId: string,
  deploymentGeneration: string,
): Promise<HeldResearchScope> {
  requiredString(deploymentGeneration, "deployment_generation");
  let row: StoredRunScopeRow | null;
  try {
    row = await env.CORE_DB.prepare(
      "SELECT operation_id, investigation_id, principal_ref, credential_generation, deployment_generation, " +
      "policy_generation, policy_authority_ref, authorization_receipt_ref, scope_snapshot_id, " +
      "scope_snapshot_revision, purge_revision FROM research_workflow_current " +
      "WHERE operation_id = ?1 AND principal_ref = ?2 AND credential_generation = ?3 " +
      "AND deployment_generation = ?4 LIMIT 1",
    ).bind(operationId, access.principal_ref, access.credential_generation, deploymentGeneration)
      .first<StoredRunScopeRow>();
  } catch {
    fail("RETRIEVAL_RESOLUTION_UNCERTAIN", "stored research scope authority is unavailable");
  }
  if (row === null) fail("RETRIEVAL_AUTHORITY_STALE", "durable research scope is not current for this owner");
  const scopeRef = { id: requiredString(row.scope_snapshot_id, "snapshot_id"), revision: positiveRevision(row.scope_snapshot_revision) };
  const authority = await createD1EvidenceAuthorityPort({
    core_database: env.CORE_DB,
    search_database: env.SEARCH_DB,
  }).loadScope(scopeRef).catch(() => {
    fail("RETRIEVAL_RESOLUTION_UNCERTAIN", "stored research ScopeSnapshot read is unavailable");
  });
  if (authority === null || authority.invalidated_at !== null) fail("RETRIEVAL_AUTHORITY_STALE", "durable research ScopeSnapshot is unavailable");
  const scope = authority.snapshot;
  await createD1ScopePorts(env.CORE_DB, access).requireCurrentScope(scope);
  if (requiredString(row.operation_id, "operation_id") !== operationId ||
      requiredString(row.principal_ref, "principal_ref") !== access.principal_ref ||
      requiredString(row.credential_generation, "credential_generation") !== access.credential_generation ||
      requiredString(row.deployment_generation, "deployment_generation") !== deploymentGeneration ||
      scope.snapshot_id !== scopeRef.id || scope.revision !== scopeRef.revision) {
    fail("RETRIEVAL_AUTHORITY_STALE", "durable research scope identity changed");
  }
  return {
    operation_id: operationId,
    investigation_id: requiredString(row.investigation_id, "investigation_id"),
    scope_snapshot_ref: scopeRef,
    scope_snapshot: scope,
    policy_generation: requiredString(row.policy_generation, "policy_generation"),
    policy_authority_ref: requiredString(row.policy_authority_ref, "policy_authority_ref"),
    authorization_receipt_ref: requiredString(row.authorization_receipt_ref, "authorization_receipt_ref"),
    purge_revision: nonnegativeInteger(row.purge_revision),
    deployment_generation: requiredString(row.deployment_generation, "deployment_generation"),
  };
}

export async function retrieveWithHeldScope(
  env: ResearchRetrievalEnvironment,
  input: HeldScopeRetrievalInput,
): Promise<RetrievalResult> {
  const access = input.access;
  const scopePorts = createD1ScopePorts(env.CORE_DB, access);
  await createD1ScopeProfilePort(env.CORE_DB).recordBinding(input.scope_snapshot, input.profile);
  const resolver = createCloudflareEvidenceResolver({
    authority: createD1EvidenceAuthorityPort({ core_database: env.CORE_DB, search_database: env.SEARCH_DB }),
    content: createR2EvidenceContentPort({ evidence_bucket: env.EVIDENCE_BUCKET }),
  });
  async function resolveEvidence(candidate: LocatorCandidate, scope: ScopeSnapshot): Promise<ResolvedEvidence | null> {
    try {
      return await resolver.resolveCandidate({
        candidate,
        scope_snapshot_ref: { id: scope.snapshot_id, revision: scope.revision },
        access,
      });
    } catch (error) {
      if (error instanceof EvidenceRuntimeError) {
        if (!STALE_AUTHORITY_CODES.has(error.code) && OMITTED_CANDIDATE_CODES.has(error.code)) return null;
        if (STALE_AUTHORITY_CODES.has(error.code)) throw new RetrievalQueryError("RETRIEVAL_AUTHORITY_STALE", error.message);
        throw new RetrievalQueryError("RETRIEVAL_RESOLUTION_UNCERTAIN", error.message, true);
      }
      throw new RetrievalQueryError("RETRIEVAL_RESOLUTION_UNCERTAIN", error instanceof Error ? error.message : "evidence resolution failed", true);
    }
  }
  const ident = createIdentLaneExecutor(createD1SearchIdentPort({ search_database: env.SEARCH_DB, core_database: env.CORE_DB }));
  const lex = createLexLaneExecutor(createD1SearchLexPort({ search_database: env.SEARCH_DB, core_database: env.CORE_DB }));
  const sem = env.AI_SEARCH === undefined ? null : createSemLaneExecutor(createD1BackedAiSearchManagedSearchPort(
    env.SEARCH_DB,
    env.AI_SEARCH,
    { expected_namespace: AI_SEARCH_PRIMARY_NAMESPACE, max_preview_bytes: 4096, match_threshold: 0 },
  ));
  const lanes = {
    executorFor(lane: RetrievalLane) {
      if (lane === "IDENT") return ident;
      if (lane === "LEX") return lex;
      if (lane === "SEM") return sem;
      return null;
    },
  };
  const ports: RetrievalQueryPorts = {
    ...scopePorts,
    lanes,
    fusion: { reciprocal_rank_constant: 60, lane_weights: { IDENT: 2, LEX: 1, SEM: 1 }, maxPerSourceRevision: 8 },
    resolveEvidence,
    persistTrace: (trace) => createD1RetrievalTracePort(env.CORE_DB, access).persistTrace(trace),
    results: createD1RetrievalResultStore(env.CORE_DB, access),
    checkBudget: () => createQueryBudgetGuard(input.deadline_ms, () => input.signal.aborted).checkBudget(),
  };
  const request: RetrievalRequest = {
    raw_query: input.raw_query,
    product: input.product,
    scope_snapshot: input.scope_snapshot,
    literals: [...input.literals],
    requested_limit: input.requested_limit,
    deadline_ms: input.deadline_ms,
  };
  return createRetrievalQueryService(ports).query({ request, idempotency_key: input.idempotency_key });
}
