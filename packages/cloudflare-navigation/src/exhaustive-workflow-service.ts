import type {
  AuthenticatedRequestContext,
  ExhaustiveWorkflowJobsRequest,
  ExhaustiveWorkflowPage,
  ExhaustiveWorkflowResult,
} from "@eliotr/interfaces";
import {
  createExhaustiveWorkflowBinding,
  type ExhaustiveWorkflowBindingInput,
} from "./exhaustive-workflow-binding.js";
import {
  exhaustiveIdempotencyKey,
  parseExhaustiveQueryRequest,
  validateExhaustiveJobCurrent,
  validateExhaustiveWorkflowJobCurrent,
  type ExhaustiveQueryEnvironment,
  type ExhaustiveQueryRequest,
} from "./exhaustive-query-service.js";

export interface ExhaustiveWorkflowServiceInput<T> extends ExhaustiveWorkflowBindingInput<T> {
  readonly translateError?: (error: unknown) => never;
}

export interface ExhaustiveWorkflowService<T> {
  launch(context: AuthenticatedRequestContext, raw: unknown): Promise<ExhaustiveWorkflowResult>;
  status(context: AuthenticatedRequestContext, instanceId: string): Promise<ExhaustiveWorkflowResult>;
  cancel(context: AuthenticatedRequestContext, instanceId: string): Promise<ExhaustiveWorkflowResult>;
  list(context: AuthenticatedRequestContext, request: ExhaustiveWorkflowJobsRequest): Promise<ExhaustiveWorkflowPage>;
}

function createExhaustiveWorkflowBindingService<T>(input: ExhaustiveWorkflowServiceInput<T>): ExhaustiveWorkflowService<T> {
  const binding = createExhaustiveWorkflowBinding(input);
  const translateError = input.translateError ?? ((error: unknown): never => { throw error; });
  return {
    launch: (context, raw) => binding.launch(context, raw).catch(translateError),
    status: (context, instanceId) => binding.status(context, instanceId).catch(translateError),
    cancel: (context, instanceId) => binding.cancel(context, instanceId).catch(translateError),
    list: (context, request) => binding.list(context, request).catch(translateError),
  };
}

export function createExhaustiveWorkflowService(
  env: Omit<ExhaustiveQueryEnvironment, "SEARCH_DB" | "EVIDENCE_BUCKET"> & {
    readonly SEARCH_DB: D1Database;
    readonly EVIDENCE_BUCKET: R2Bucket;
    readonly RESEARCH_WORKFLOW: ExhaustiveWorkflowBindingInput<ExhaustiveQueryRequest>["workflow"];
    readonly DEPLOYMENT_GENERATION: string;
  },
  translateError?: (error: unknown) => never,
): ExhaustiveWorkflowService<ExhaustiveQueryRequest> {
  return createExhaustiveWorkflowBindingService({
    database: env.CORE_DB,
    workflow: env.RESEARCH_WORKFLOW,
    deployment_generation: env.DEPLOYMENT_GENERATION,
    parseRequest: parseExhaustiveQueryRequest,
    idempotencyKey: exhaustiveIdempotencyKey,
    validateCurrentJob: (jobId, context) => validateExhaustiveJobCurrent(env, context, jobId),
    validateCurrentWorkflowJob: (jobId, context) => validateExhaustiveWorkflowJobCurrent(env, context, jobId),
    ...(translateError === undefined ? {} : { translateError }),
  });
}
