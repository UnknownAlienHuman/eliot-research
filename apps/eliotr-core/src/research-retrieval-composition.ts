import {
  createCloudflareEvidenceResolver,
  createD1EvidenceAuthorityPort,
  createR2EvidenceContentPort,
  createNavigationReadAuthority,
  EvidenceRuntimeError,
} from "@eliotr/cloudflare-evidence";
import {
  readHeldResearchScope as readStoredHeldResearchScope,
  ResearchHeldScopeError,
  type HeldResearchScope,
} from "@eliotr/cloudflare-research";
import { AI_SEARCH_PRIMARY_NAMESPACE, createD1BackedAiSearchManagedSearchPort } from "@eliotr/cloudflare-ai";
import { createD1SearchExactPort, createD1SearchIdentPort, createD1SearchLexPort } from "@eliotr/cloudflare-projection";
import {
  createD1RetrievalResultStore,
  createD1RetrievalTracePort,
  createD1ScopePorts,
  createD1ScopeProfilePort,
  createExactLaneExecutor,
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
import type { LocatorCandidate, ResolvedEvidence, RetrievalLane, ScopeSnapshot } from "@eliotr/contracts";
import type { RetrievalRequest, RetrievalResult } from "@eliotr/retrieval";
import type { Env } from "./env.js";
import { createExactPhraseVerifier } from "./research-exact-search.js";

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

export type { HeldResearchScope } from "@eliotr/cloudflare-research";
export async function loadHeldResearchScope(
  env: Pick<Env, "CORE_DB" | "SEARCH_DB">,
  access: RetrievalQueryAccess,
  operationId: string,
  deploymentGeneration: string,
): Promise<HeldResearchScope> {
  try {
    return await readStoredHeldResearchScope({
      core_database: env.CORE_DB,
      search_database: env.SEARCH_DB,
      access,
      operation_id: operationId,
      deployment_generation: deploymentGeneration,
      require_current_scope: async (scope) => { await createD1ScopePorts(env.CORE_DB, access).requireCurrentScope(scope); },
    });
  } catch (error) {
    if (error instanceof ResearchHeldScopeError) {
      fail(error.code === "RESEARCH_HELD_SCOPE_STALE" ? "RETRIEVAL_AUTHORITY_STALE" : "RETRIEVAL_RESOLUTION_UNCERTAIN", "stored research scope authority is unavailable");
    }
    throw error;
  }
}

export async function retrieveWithHeldScope(
  env: ResearchRetrievalEnvironment,
  input: HeldScopeRetrievalInput,
): Promise<RetrievalResult> {
  const access = input.access;
  const scopePorts = createD1ScopePorts(env.CORE_DB, access);
  // Validate the held scope and its owner grant before creating any retrieval
  // profile row. This keeps revoked or foreign workflow scopes read-only.
  await scopePorts.requireCurrentScope(input.scope_snapshot);
  if (input.scope_snapshot.member_source_revision_refs.length > input.profile.max_sources ||
      input.requested_limit > input.profile.max_results) {
    throw new RetrievalQueryError("RETRIEVAL_INPUT_INVALID", "retrieval request exceeds its server-selected scope profile");
  }
  await createD1ScopeProfilePort(env.CORE_DB).recordBinding(input.scope_snapshot, input.profile);
  const evidenceAuthority = createD1EvidenceAuthorityPort({
    core_database: env.CORE_DB,
    search_database: env.SEARCH_DB,
  });
  const evidenceContent = createR2EvidenceContentPort({ evidence_bucket: env.EVIDENCE_BUCKET });
  const resolver = createCloudflareEvidenceResolver({ authority: evidenceAuthority, content: evidenceContent });
  const navigation = createNavigationReadAuthority({
    database: env.CORE_DB,
    scope_snapshot: input.scope_snapshot,
    access,
    require_current: async (scope) => {
      await scopePorts.requireCurrentScope(scope);
      return scope;
    },
  });
  const queryBudget = createQueryBudgetGuard(input.deadline_ms, () => input.signal.aborted);
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
  const exact = createExactLaneExecutor(createD1SearchExactPort({
    search_database: env.SEARCH_DB,
    core_database: env.CORE_DB,
    verifyExactPhrase: createExactPhraseVerifier({
      navigation,
      authority: evidenceAuthority,
      content: evidenceContent,
      checkBudget: () => queryBudget.checkBudget(),
    }),
  }));
  const lex = createLexLaneExecutor(createD1SearchLexPort({ search_database: env.SEARCH_DB, core_database: env.CORE_DB }));
  const sem = env.AI_SEARCH === undefined ? null : createSemLaneExecutor(createD1BackedAiSearchManagedSearchPort(
    env.SEARCH_DB,
    env.AI_SEARCH,
    { expected_namespace: AI_SEARCH_PRIMARY_NAMESPACE, max_preview_bytes: 4096, match_threshold: 0 },
  ));
  const lanes = {
    executorFor(lane: RetrievalLane) {
      if (lane === "IDENT") return ident;
      if (lane === "EXACT") return exact;
      if (lane === "LEX") return lex;
      if (lane === "SEM") return sem;
      return null;
    },
  };
  const ports: RetrievalQueryPorts = {
    ...scopePorts,
    lanes,
    fusion: { reciprocal_rank_constant: 60, lane_weights: { IDENT: 2, EXACT: 2, LEX: 1, SEM: 1 }, maxPerSourceRevision: 8 },
    resolveEvidence,
    persistTrace: (trace) => createD1RetrievalTracePort(env.CORE_DB, access).persistTrace(trace),
    results: createD1RetrievalResultStore(env.CORE_DB, access),
    checkBudget: () => queryBudget.checkBudget(),
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
