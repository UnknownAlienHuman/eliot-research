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
import type { PendingRetrievalAdmissionV1, RetrievalResult, ScopeProfileBinding, StoredRetrievalResult } from "@eliotr/retrieval";
import { retrieveWithHeldScope } from "./research-retrieval-composition.js";
import type { ResearchRetrievalEnvironment } from "./research-retrieval-composition.js";
import { createD1RetrievalSettlementOwnerPort } from "./research-retrieval-settlement-owner.js";

const RETRIEVAL_QUERY_BUDGET_MS = 30_000;

export type ResearchQueryEnvironment = ResearchRetrievalEnvironment;

export interface ResearchQueryErrorBoundary {
	readonly fail: (code: string, message: string, status?: number, retryable?: boolean) => never;
	readonly isResearchServiceError: (error: unknown) => boolean;
}

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

/** A retry must retain the admitted scope and original logical request. */
export async function requirePendingResearchQueryBinding(input: {
  readonly pending: PendingRetrievalAdmissionV1;
  readonly parsed: QueryRequest;
  readonly context: AuthenticatedRequestContext;
  readonly profile: ScopeProfileBinding;
  readonly requireCurrentScope: RequireCurrentScope;
  readonly requireProfileBinding: RequireProfileBinding;
  readonly requireDelegatedScopeCurrent?: RequireCurrentScope;
}, errors: ResearchQueryErrorBoundary): Promise<void> {
  const scope = input.pending.scope_snapshot;
  if (input.pending.credential_generation !== input.context.credential_generation) {
    errors.fail("RESEARCH_AUTHORITY_STALE", "pending query access generation is displaced", 403);
  }
  await input.requireDelegatedScopeCurrent?.(scope);
  await input.requireCurrentScope(scope).catch((error: unknown) => mapRetrievalError(error, errors));
  await input.requireProfileBinding(scope, input.profile).catch((error: unknown) => mapRetrievalError(error, errors));
  if (scopeExpressionIdentity(input.parsed.scope_expression) !== scopeExpressionIdentity(scope.resolved_scope_expression) ||
      await retrievalRequestDigest({
        raw_query: input.parsed.query, product: input.parsed.product, literals: [...input.parsed.literals],
        requested_limit: input.parsed.max_results, scope_digest: scope.digest,
      }) !== input.pending.request_digest) {
    errors.fail("RESEARCH_CONFLICT", "idempotency identity is bound to different pending inputs", 409);
  }
  if (input.context.request.signal.aborted) errors.fail("RESEARCH_CANCELLED", "research query is cancelled", 409);
}

function coverageClaim(value: unknown, errors: ResearchQueryErrorBoundary): "NONE" | "SAMPLED" {
  if (value === "NONE" || value === "SAMPLED") return value;
	errors.fail("RESEARCH_SETTLEMENT_UNCERTAIN", "FAST_SEARCH coverage readback is unavailable", 503, true);
}

export function mapRetrievalError(error: unknown, errors: ResearchQueryErrorBoundary): never {
	if (errors.isResearchServiceError(error)) throw error;
  if (!(error instanceof RetrievalQueryError)) throw error;
  const status = error.code === "RETRIEVAL_INPUT_INVALID" ? 400 : error.code === "RETRIEVAL_AUTHORITY_STALE" ? 403 : error.code === "RETRIEVAL_RESOLUTION_UNCERTAIN" ? 503 : 409;
  const code = error.code === "RETRIEVAL_INPUT_INVALID" ? "RESEARCH_INPUT_INVALID" : error.code === "RETRIEVAL_RESOLUTION_UNCERTAIN" ? "RESEARCH_SETTLEMENT_UNCERTAIN" : error.code === "RETRIEVAL_BUDGET_STOP" ? "RESEARCH_BUDGET_STOP" : error.code === "RETRIEVAL_CANCELLED" ? "RESEARCH_CANCELLED" : error.code === "RETRIEVAL_SCOPE_STALE" || error.code === "RETRIEVAL_AUTHORITY_STALE" ? "RESEARCH_AUTHORITY_STALE" : "RESEARCH_CONFLICT";
	errors.fail(code, error.message, status, status === 503);
}

/** Projects fresh and stored retrievals onto the exact shared HTTP/MCP evidence result. */
export function createResearchQueryExecutionResult(
  retrieval: RetrievalResult,
  includeCoverage: boolean,
	errors: ResearchQueryErrorBoundary,
): ResearchQueryExecutionResult {
  return {
    result: { evidence_pack: retrieval.evidence_pack, trace_ref: retrieval.trace.trace_ref },
		...(includeCoverage ? { coverage_claim: coverageClaim(retrieval.coverage_claim, errors) } : {}),
  };
}

export function requireMcpFastSearchCoverageClaim(
  value: ResearchQueryExecutionResult["coverage_claim"],
	errors: ResearchQueryErrorBoundary,
): "NONE" | "SAMPLED" {
  if (value === undefined) {
		errors.fail("RESEARCH_SETTLEMENT_UNCERTAIN", "FAST_SEARCH coverage readback is unavailable", 503, true);
  }
	return coverageClaim(value, errors);
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
}, errors: ResearchQueryErrorBoundary): Promise<ResearchQueryExecutionResult> {
  const scope = input.prior.result.trace.scope_snapshot;
  await input.requireDelegatedScopeCurrent?.(scope);
	await input.requireCurrentScope(scope).catch((error: unknown) => mapRetrievalError(error, errors));
	await input.requireProfileBinding(scope, input.profile).catch((error: unknown) => mapRetrievalError(error, errors));
  if (scopeExpressionIdentity(input.parsed.scope_expression) !==
      scopeExpressionIdentity(scope.resolved_scope_expression)) {
		errors.fail("RESEARCH_CONFLICT", "idempotency identity is bound to a different scope expression", 409);
  }
  const requestDigest = await retrievalRequestDigest({
    raw_query: input.parsed.query,
    product: input.parsed.product,
    literals: [...input.parsed.literals],
    requested_limit: input.parsed.max_results,
    scope_digest: scope.digest,
  });
  if (requestDigest !== input.prior.request_digest) {
		errors.fail("RESEARCH_CONFLICT", "idempotency identity is bound to different inputs", 409);
  }
	await input.requireCurrentScope(scope).catch((error: unknown) => mapRetrievalError(error, errors));
  await input.requireDelegatedScopeCurrent?.(scope);
  if (input.context.request.signal.aborted) {
		errors.fail("RESEARCH_CANCELLED", "research query is cancelled", 409);
  }
	return createResearchQueryExecutionResult(input.prior.result, input.includeCoverage, errors);
}

export function createResearchQueryExecutor(input: {
  readonly env: ResearchQueryEnvironment;
  readonly profile: ScopeProfileBinding;
  readonly parseRequest: ParseQueryRequest;
  readonly idempotencyKey: QueryIdempotencyKey;
	readonly errors: ResearchQueryErrorBoundary;
}): (context: AuthenticatedRequestContext, request: QueryRequest, includeCoverage: boolean) =>
  Promise<ResearchQueryExecutionResult> {
  return async (context, request, includeCoverage) => {
    const parsed = input.parseRequest(request);
    if (includeCoverage && parsed.product !== "FAST_SEARCH") {
		input.errors.fail("RESEARCH_PROFILE_UNSUPPORTED", "MCP query results require FAST_SEARCH", 422);
    }
    if (context.client_class !== "owner_pwa" && parsed.product !== "FAST_SEARCH") {
		input.errors.fail("RESEARCH_PROFILE_UNSUPPORTED", "delegated research.query currently supports FAST_SEARCH only", 422);
    }
    const key = input.idempotencyKey(context);
    const delegated = context.client_class === "owner_pwa" ? undefined
      : await createProjectClientScopeAuthority(input.env.CORE_DB, context, parsed.scope_expression);
	if (context.request.signal.aborted) input.errors.fail("RESEARCH_CANCELLED", "research query is cancelled", 409);
    const access = {
      principal_ref: context.principal_ref,
      client_class: context.client_class,
      credential_generation: context.credential_generation,
    };
    const scopePorts = createD1ScopePorts(input.env.CORE_DB, access);
    const store = createD1RetrievalResultStore(input.env.CORE_DB, access, undefined, createD1RetrievalSettlementOwnerPort());
    const profilePort = createD1ScopeProfilePort(input.env.CORE_DB);
    const replay = (stored: StoredRetrievalResult): Promise<ResearchQueryExecutionResult> => readStoredResearchQueryExecutionResult({
      prior: stored, parsed, context, profile: input.profile, includeCoverage,
      requireCurrentScope: scope => scopePorts.requireCurrentScope(scope),
      requireProfileBinding: (scope, binding) => profilePort.requireBinding(scope, binding),
      ...(delegated === undefined ? {} : { requireDelegatedScopeCurrent: (scope: ScopeSnapshot) => delegated.requireScopeCurrent(scope) }),
    }, input.errors);
    const requirePending = (pending: PendingRetrievalAdmissionV1): Promise<void> => requirePendingResearchQueryBinding({
      pending, parsed, context, profile: input.profile,
      requireCurrentScope: scope => scopePorts.requireCurrentScope(scope),
      requireProfileBinding: (scope, binding) => profilePort.requireBinding(scope, binding),
      ...(delegated === undefined ? {} : { requireDelegatedScopeCurrent: (scope: ScopeSnapshot) => delegated.requireScopeCurrent(scope) }),
    }, input.errors);
    const prior = await store.load(key).catch((error: unknown) => {
		if (error instanceof RetrievalQueryError) mapRetrievalError(error, input.errors);
		input.errors.fail("RESEARCH_SETTLEMENT_UNCERTAIN", "stored query result is unavailable", 503, true);
    });
    if (prior !== null) return replay(prior);
    const pending = await store.loadPending(key).catch((error: unknown) => mapRetrievalError(error, input.errors));
    let snapshot: ScopeSnapshot;
    if (pending !== null) {
      await requirePending(pending);
      snapshot = pending.scope_snapshot;
    } else {
      const completed = await store.load(key).catch((error: unknown) => mapRetrievalError(error, input.errors));
      if (completed !== null) return replay(completed);
      const authority = delegated?.authority ?? createOwnerScopeAuthority(input.env.CORE_DB, context);
      await authority.requireReadPolicy();
      const freezer = createD1ScopeService(input.env.CORE_DB, authority, {
        max_snapshot_members: input.profile.max_sources,
        ...(delegated === undefined ? {} : { preserve_resolution_errors: true }),
      });
      snapshot = await freezer.freeze(parsed.scope_expression, context.credential_generation);
      await profilePort.recordBinding(snapshot, input.profile).catch((error: unknown) => mapRetrievalError(error, input.errors));
      await freezer.requireCurrent(snapshot);
      await authority.grant(snapshot);
    }
    await delegated?.requireScopeCurrent(snapshot);
    await scopePorts.requireCurrentScope(snapshot);
    const deadlineMs = Date.now() + RETRIEVAL_QUERY_BUDGET_MS;
    const result = await retrieveWithHeldScope(input.env, {
      access,
      scope_snapshot: snapshot,
      raw_query: parsed.query,
      product: parsed.product,
      literals: [...parsed.literals],
      requested_limit: parsed.max_results,
      deadline_ms: deadlineMs,
      idempotency_key: key,
      signal: context.request.signal,
      profile: input.profile,
	}).catch(async (error: unknown) => {
      if (error instanceof RetrievalQueryError &&
          (error.code === "RETRIEVAL_RESOLUTION_UNCERTAIN" || error.code === "RETRIEVAL_IDEMPOTENCY_CONFLICT")) {
        const completed = await store.load(key).catch((readError: unknown) => mapRetrievalError(readError, input.errors));
        if (completed !== null) {
          await replay(completed);
          return completed.result;
        }
        const admitted = await store.loadPending(key).catch((readError: unknown) => mapRetrievalError(readError, input.errors));
        if (admitted !== null) {
          await requirePending(admitted);
          input.errors.fail("RESEARCH_SETTLEMENT_UNCERTAIN", "original query invocation is still unsettled", 503, true);
        }
      }
      return mapRetrievalError(error, input.errors);
    });
    await delegated?.requireScopeCurrent(result.trace.scope_snapshot);
	if (context.request.signal.aborted) input.errors.fail("RESEARCH_CANCELLED", "research query is cancelled", 409);
	return createResearchQueryExecutionResult(result, includeCoverage, input.errors);
  };
}
