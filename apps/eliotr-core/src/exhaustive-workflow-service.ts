import {
  createExhaustiveWorkflowBinding,
  ExhaustiveWorkflowBindingError,
  validateExhaustiveWorkflowJobCurrent,
  validateExhaustiveJobCurrent,
  type ExhaustiveWorkflowPayload as BoundExhaustiveWorkflowPayload,
} from "@eliotr/cloudflare-navigation";
import type {
  ExhaustiveWorkflowJobsRequest,
  ExhaustiveWorkflowPage,
  ExhaustiveWorkflowResult,
  AuthenticatedRequestContext,
} from "@eliotr/interfaces";
import type { Env } from "./env.js";
import {
  exhaustiveIdempotencyKey,
  parseExhaustiveQueryRequest,
  type ExhaustiveQueryRequest,
  ExhaustiveQueryError,
} from "./exhaustive-query-service.js";

export type ExhaustiveWorkflowPayload = BoundExhaustiveWorkflowPayload<ExhaustiveQueryRequest>;

function translate(error: unknown): never {
  if (error instanceof ExhaustiveWorkflowBindingError) {
    throw new ExhaustiveQueryError(error.code, error.message, error.status, error.retryable);
  }
  throw error;
}

export function createExhaustiveWorkflowService(env: Pick<Env, "CORE_DB" | "SEARCH_DB" | "EVIDENCE_BUCKET" | "RESEARCH_WORKFLOW" | "DEPLOYMENT_GENERATION">): {
  launch(context: AuthenticatedRequestContext, raw: unknown): Promise<ExhaustiveWorkflowResult>;
  status(context: AuthenticatedRequestContext, instanceId: string): Promise<ExhaustiveWorkflowResult>;
  cancel(context: AuthenticatedRequestContext, instanceId: string): Promise<ExhaustiveWorkflowResult>;
  list(context: AuthenticatedRequestContext, request: ExhaustiveWorkflowJobsRequest): Promise<ExhaustiveWorkflowPage>;
} {
  const binding = createExhaustiveWorkflowBinding<ExhaustiveQueryRequest>({
    database: env.CORE_DB,
    workflow: env.RESEARCH_WORKFLOW,
    deployment_generation: env.DEPLOYMENT_GENERATION,
    parseRequest: parseExhaustiveQueryRequest,
    idempotencyKey: exhaustiveIdempotencyKey,
    validateCurrentJob: (jobId, context) => validateExhaustiveJobCurrent(env, context, jobId),
    validateCurrentWorkflowJob: (jobId, context) => validateExhaustiveWorkflowJobCurrent(env, context, jobId),
  });
  return {
    launch: (context, raw) => binding.launch(context, raw).catch(translate),
    status: (context, instanceId) => binding.status(context, instanceId).catch(translate),
    cancel: (context, instanceId) => binding.cancel(context, instanceId).catch(translate),
    list: (context, request) => binding.list(context, request).catch(translate),
  };
}

export { ExhaustiveWorkflowBindingError };
