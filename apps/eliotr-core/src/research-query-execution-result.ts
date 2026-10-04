import { scopeExpressionIdentity } from "@eliotr/domain";
import type { AuthenticatedRequestContext, QueryRequest, QueryResult } from "@eliotr/interfaces";
import type { ScopeSnapshot } from "@eliotr/contracts";
import {
  createD1ScopeService,
  createOwnerScopeAuthority,
  createProjectClientScopeAuthority,
} from "@eliotr/cloudflare-navigation";
import {
  createD1RetrievalResultStore,
  createD1ScopePorts,
  createD1ScopeProfilePort,
  retrievalRequestDigest,
  RetrievalQueryError,
} from "@eliotr/retrieval";
import type { RetrievalResult, ScopeProfileBinding, StoredRetrievalResult } from "@eliotr/retrieval";
import { ResearchServiceError, failResearch as fail } from "./research-service-error.js";
import { retrieveWithHeldScope } from "./research-retrieval-composition.js";
import type { Env } from "./env.js";

const RETRIEVAL_QUERY_BUDGET_MS = 30_000;

export type ResearchQueryEnvironment = Pick<Env, "CORE_DB" | "SEARCH_DB" | "EVIDENCE_BUCKET"> & {
  readonly AI_SEARCH?: Env["AI_SEARCH"];
};

export interface McpFastSearchQueryResult extends QueryResult {
  readonly coverage_claim: "NONE" | "SAMPLED";
}

export interface ResearchQueryExecutionResult {
  readonly result: QueryResult;
  readonly coverage_claim?: "NONE" | "SAMPLED";
}

type RequireCurrentScope = (snapshot: ScopeSnapshot) => Promise<void>;
type RequireProfileBinding = (snapshot: ScopeSnapshot, profile: ScopeProfileBinding) => Promise<void>;
type ParseQueryRequest = (raw: unknown) => QueryRequest;
type QueryIdempotencyKey = (context: AuthenticatedRequestContext) => string;

function coverageClaim(value: unknown): "NONE" | "SAMPLED" {
  if (value === "NONE" || value === "SAMPLED") return value;
  fail("RESEARCH_SETTLEMENT_UNCERTAIN", "FAST_SEARCH coverage readback is unavailable", 503, true);
}

export function mapRetrievalError(error: unknown): never {
  if (error instanceof ResearchServiceError) throw error;
  if (!(error instanceof RetrievalQueryError)) throw error;
  const status = error.code === "RETRIEVAL_INPUT_INVALID" ? 400 : error.code === "RETRIEVAL_AUTHORITY_STALE" ? 403 : error.code === "RETRIEVAL_RESOLUTION_UNCERTAIN" ? 503 : 409;
  const code = error.code === "RETRIEVAL_INPUT_INVALID" ? "RESEARCH_INPUT_INVALID" : error.code === "RETRIEVAL_RESOLUTION_UNCERTAIN" ? "RESEARCH_SETTLEMENT_UNCERTAIN" : error.code === "RETRIEVAL_BUDGET_STOP" ? "RESEARCH_BUDGET_STOP" : error.code === "RETRIEVAL_CANCELLED" ? "RESEARCH_CANCELLED" : error.code === "RETRIEVAL_SCOPE_STALE" || error.code === "RETRIEVAL_AUTHORITY_STALE" ? "RESEARCH_AUTHORITY_STALE" : "RESEARCH_CONFLICT";
  fail(code, error.message, status, status === 503);
}

/** Projects fresh and stored retrievals onto the exact shared HTTP/MCP evidence result. */
export function createResearchQueryExecutionResult(
  retrieval: RetrievalResult,
  includeCoverage: boolean,
): ResearchQueryExecutionResult {
  return {
    result: { evidence_pack: retrieval.evidence_pack, trace_ref: retrieval.trace.trace_ref },
    ...(includeCoverage ? { coverage_claim: coverageClaim(retrieval.coverage_claim) } : {}),
  };
}

export function requireMcpFastSearchCoverageClaim(
  value: ResearchQueryExecutionResult["coverage_claim"],
): "NONE" | "SAMPLED" {
  if (value === undefined) {
    fail("RESEARCH_SETTLEMENT_UNCERTAIN", "FAST_SEARCH coverage readback is unavailable", 503, true);
  }
  return coverageClaim(value);
}

/** Verifies the immutable stored result against the same scope, profile, and request before replay. */
export async function readStoredResearchQueryExecutionResult(input: {
  readonly prior: StoredRetrievalResult;
  readonly parsed: QueryRequest;
  readonly context: AuthenticatedRequestContext;
  readonly profile: ScopeProfileBinding;
  readonly includeCoverage: boolean;
  readonly requireCurrentScope: RequireCurrentScope;
  readonly requireProfileBinding: RequireProfileBinding;
  readonly requireDelegatedScopeCurrent?: RequireCurrentScope;
}): Promise<ResearchQueryExecutionResult> {
  const scope = input.prior.result.trace.scope_snapshot;
  await input.requireDelegatedScopeCurrent?.(scope);
  await input.requireCurrentScope(scope).catch(mapRetrievalError);
  await input.requireProfileBinding(scope, input.profile).catch(mapRetrievalError);
  if (scopeExpressionIdentity(input.parsed.scope_expression) !==
      scopeExpressionIdentity(scope.resolved_scope_expression)) {
    fail("RESEARCH_CONFLICT", "idempotency identity is bound to a different scope expression", 409);
  }
  const requestDigest = await retrievalRequestDigest({
    raw_query: input.parsed.query,
    product: input.parsed.product,
    literals: [...input.parsed.literals],
    requested_limit: input.parsed.max_results,
    scope_digest: scope.digest,
  });
  if (requestDigest !== input.prior.request_digest) {
    fail("RESEARCH_CONFLICT", "idempotency identity is bound to different inputs", 409);
  }
  await input.requireCurrentScope(scope).catch(mapRetrievalError);
  await input.requireDelegatedScopeCurrent?.(scope);
  if (input.context.request.signal.aborted) {
    fail("RESEARCH_CANCELLED", "research query is cancelled", 409);
  }
  return createResearchQueryExecutionResult(input.prior.result, input.includeCoverage);
}

export function createResearchQueryExecutor(input: {
  readonly env: ResearchQueryEnvironment;
  readonly profile: ScopeProfileBinding;
  readonly parseRequest: ParseQueryRequest;
  readonly idempotencyKey: QueryIdempotencyKey;
}): (context: AuthenticatedRequestContext, request: QueryRequest, includeCoverage: boolean) =>
  Promise<ResearchQueryExecutionResult> {
  return async (context, request, includeCoverage) => {
    const parsed = input.parseRequest(request);
    if (includeCoverage && parsed.product !== "FAST_SEARCH") {
      fail("RESEARCH_PROFILE_UNSUPPORTED", "MCP query results require FAST_SEARCH", 422);
    }
    if (context.client_class !== "owner_pwa" && parsed.product !== "FAST_SEARCH") {
      fail("RESEARCH_PROFILE_UNSUPPORTED", "delegated research.query currently supports FAST_SEARCH only", 422);
    }
    const key = input.idempotencyKey(context);
    const delegated = context.client_class === "owner_pwa" ? undefined
      : await createProjectClientScopeAuthority(input.env.CORE_DB, context, parsed.scope_expression);
    if (context.request.signal.aborted) fail("RESEARCH_CANCELLED", "research query is cancelled", 409);
    const access = {
      principal_ref: context.principal_ref,
      client_class: context.client_class,
      credential_generation: context.credential_generation,
    };
    const scopePorts = createD1ScopePorts(input.env.CORE_DB, access);
    const store = createD1RetrievalResultStore(input.env.CORE_DB, access);
    const prior = await store.load(key).catch((error: unknown) => {
      if (error instanceof RetrievalQueryError) mapRetrievalError(error);
      fail("RESEARCH_SETTLEMENT_UNCERTAIN", "stored query result is unavailable", 503, true);
    });
    if (prior !== null) {
      const profilePort = createD1ScopeProfilePort(input.env.CORE_DB);
      return readStoredResearchQueryExecutionResult({
        prior,
        parsed,
        context,
        profile: input.profile,
        includeCoverage,
        requireCurrentScope: (scope) => scopePorts.requireCurrentScope(scope),
        requireProfileBinding: (scope, binding) => profilePort.requireBinding(scope, binding),
        ...(delegated === undefined ? {} : {
          requireDelegatedScopeCurrent: (scope) => delegated.requireScopeCurrent(scope),
        }),
      });
    }
    const authority = delegated?.authority ?? createOwnerScopeAuthority(input.env.CORE_DB, context);
    await authority.requireReadPolicy();
    const freezer = createD1ScopeService(input.env.CORE_DB, authority, {
      max_snapshot_members: input.profile.max_sources,
      ...(delegated === undefined ? {} : { preserve_resolution_errors: true }),
    });
    const snapshot = await freezer.freeze(parsed.scope_expression, context.credential_generation);
    await createD1ScopeProfilePort(input.env.CORE_DB).recordBinding(snapshot, input.profile)
      .catch(mapRetrievalError);
    await freezer.requireCurrent(snapshot);
    await authority.grant(snapshot);
    await delegated?.requireScopeCurrent(snapshot);
    await scopePorts.requireCurrentScope(snapshot);
    const deadlineMs = Date.now() + RETRIEVAL_QUERY_BUDGET_MS;
    const result = await retrieveWithHeldScope(input.env, {
      access,
      scope_snapshot: snapshot,
      raw_query: parsed.query,
      product: parsed.product,
      literals: [],
      requested_limit: parsed.max_results,
      deadline_ms: deadlineMs,
      idempotency_key: key,
      signal: context.request.signal,
      profile: input.profile,
    }).catch(mapRetrievalError);
    await delegated?.requireScopeCurrent(snapshot);
    if (context.request.signal.aborted) fail("RESEARCH_CANCELLED", "research query is cancelled", 409);
    return createResearchQueryExecutionResult(result, includeCoverage);
  };
}
