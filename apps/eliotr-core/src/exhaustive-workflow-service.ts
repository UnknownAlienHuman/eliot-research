import {
  createExhaustiveWorkflowBinding,
  ExhaustiveWorkflowBindingError,
  type ExhaustiveWorkflowPayload as BoundExhaustiveWorkflowPayload,
} from "@eliotr/cloudflare-navigation";
import type { ExhaustiveWorkflowResult, AuthenticatedRequestContext } from "@eliotr/interfaces";
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

export function createExhaustiveWorkflowService(env: Pick<Env, "CORE_DB" | "RESEARCH_WORKFLOW" | "DEPLOYMENT_GENERATION">): {
  launch(context: AuthenticatedRequestContext, raw: unknown): Promise<ExhaustiveWorkflowResult>;
  status(context: AuthenticatedRequestContext, instanceId: string): Promise<ExhaustiveWorkflowResult>;
  cancel(context: AuthenticatedRequestContext, instanceId: string): Promise<ExhaustiveWorkflowResult>;
} {
  const binding = createExhaustiveWorkflowBinding<ExhaustiveQueryRequest>({
    database: env.CORE_DB,
    workflow: env.RESEARCH_WORKFLOW,
    deployment_generation: env.DEPLOYMENT_GENERATION,
    parseRequest: parseExhaustiveQueryRequest,
    idempotencyKey: exhaustiveIdempotencyKey,
  });
  return {
    launch: (context, raw) => binding.launch(context, raw).catch(translate),
    status: (context, instanceId) => binding.status(context, instanceId).catch(translate),
    cancel: (context, instanceId) => binding.cancel(context, instanceId).catch(translate),
  };
}

export { ExhaustiveWorkflowBindingError };
