import type { AuthenticatedRequestContext, QueryRequest } from "@eliotr/interfaces";
import type { ScopeSnapshot } from "@eliotr/contracts";
import type { Env } from "./env.js";
import { ResearchServiceError, failResearch } from "./research-service-error.js";
import {
  createResearchQueryExecutionResult as createResearchQueryExecutionResultCapability,
  createResearchQueryExecutor as createResearchQueryExecutorCapability,
  mapRetrievalError as mapRetrievalErrorCapability,
  readStoredResearchQueryExecutionResult as readStoredResearchQueryExecutionResultCapability,
  requireMcpFastSearchCoverageClaim as requireMcpFastSearchCoverageClaimCapability,
} from "@eliotr/cloudflare-research-runtime";
import type {
  McpFastSearchQueryResult,
  ResearchQueryEnvironment as RuntimeResearchQueryEnvironment,
  ResearchQueryExecutionResult,
} from "@eliotr/cloudflare-research-runtime";
import type { RetrievalResult, ScopeProfileBinding, StoredRetrievalResult } from "@eliotr/retrieval";

export type ResearchQueryEnvironment = Pick<Env, "CORE_DB" | "SEARCH_DB" | "EVIDENCE_BUCKET"> & {
  readonly AI_SEARCH?: Env["AI_SEARCH"];
};

export type { McpFastSearchQueryResult, ResearchQueryExecutionResult };

const errors = {
  fail: failResearch,
  isResearchServiceError: (error: unknown): error is ResearchServiceError => error instanceof ResearchServiceError,
};

export function mapRetrievalError(error: unknown): never {
  return mapRetrievalErrorCapability(error, errors);
}

export function createResearchQueryExecutionResult(retrieval: RetrievalResult, includeCoverage: boolean) {
  return createResearchQueryExecutionResultCapability(retrieval, includeCoverage, errors);
}

export function requireMcpFastSearchCoverageClaim(value: ResearchQueryExecutionResult["coverage_claim"]): "NONE" | "SAMPLED" {
  return requireMcpFastSearchCoverageClaimCapability(value, errors);
}

export function readStoredResearchQueryExecutionResult(input: {
  readonly prior: StoredRetrievalResult;
  readonly parsed: QueryRequest;
  readonly context: AuthenticatedRequestContext;
  readonly profile: ScopeProfileBinding;
  readonly includeCoverage: boolean;
  readonly requireCurrentScope: (snapshot: ScopeSnapshot) => Promise<void>;
  readonly requireProfileBinding: (snapshot: ScopeSnapshot, profile: ScopeProfileBinding) => Promise<void>;
  readonly requireDelegatedScopeCurrent?: (snapshot: ScopeSnapshot) => Promise<void>;
}) {
  return readStoredResearchQueryExecutionResultCapability(input, errors);
}

export function createResearchQueryExecutor(input: {
  readonly env: ResearchQueryEnvironment;
  readonly profile: ScopeProfileBinding;
  readonly parseRequest: (raw: unknown) => QueryRequest;
  readonly idempotencyKey: (context: AuthenticatedRequestContext) => string;
}): (context: AuthenticatedRequestContext, request: QueryRequest, includeCoverage: boolean) =>
  Promise<ResearchQueryExecutionResult> {
  const runtimeEnvironment: RuntimeResearchQueryEnvironment = input.env;
  return createResearchQueryExecutorCapability({ ...input, env: runtimeEnvironment, errors });
}
