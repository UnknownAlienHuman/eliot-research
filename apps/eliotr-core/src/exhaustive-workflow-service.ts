import {
  createExhaustiveWorkflowService as createNavigationWorkflowService,
  ExhaustiveWorkflowBindingError,
  type ExhaustiveWorkflowPayload as BoundExhaustiveWorkflowPayload,
  type ExhaustiveWorkflowService,
} from "@eliotr/cloudflare-navigation";
import type { Env } from "./env.js";
import { ExhaustiveQueryError, type ExhaustiveQueryRequest } from "./exhaustive-query-service.js";

export type ExhaustiveWorkflowPayload = BoundExhaustiveWorkflowPayload<ExhaustiveQueryRequest>;

function translate(error: unknown): never {
  if (error instanceof ExhaustiveWorkflowBindingError) {
    throw new ExhaustiveQueryError(error.code, error.message, error.status, error.retryable);
  }
  throw error;
}

export function createExhaustiveWorkflowService(env: Pick<Env, "CORE_DB" | "SEARCH_DB" | "EVIDENCE_BUCKET" | "RESEARCH_WORKFLOW" | "DEPLOYMENT_GENERATION">): ExhaustiveWorkflowService {
  return createNavigationWorkflowService(env, translate);
}

export { ExhaustiveWorkflowBindingError };
