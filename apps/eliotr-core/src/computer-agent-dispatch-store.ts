import type { AuthenticatedRequestContext, QueryRequest } from "@eliotr/interfaces";
import {
  createComputerAgentDispatchService as createService,
} from "@eliotr/cloudflare-computer-agent/computer-agent-dispatch-store";
import type { ComputerAgentRuntime } from "@eliotr/cloudflare-computer-agent/runtime";
import { createResearchRunService, parseResearchRunRequest, ResearchServiceError } from "./research-session.js";
import type { Env } from "./env.js";

export interface CoreComputerAgentDispatchServiceOptions {
  readonly now?: () => number;
  readonly start_run?: (context: AuthenticatedRequestContext, request: QueryRequest) => Promise<{
    investigation_ref: { readonly id: string; readonly revision: number };
    workflow_instance_id: string;
  }>;
  readonly allow_preferred_internal_key?: boolean;
}

export function createComputerAgentDispatchService(env: Env,
  options?: CoreComputerAgentDispatchServiceOptions) {
  const runtime: ComputerAgentRuntime = {
    database: env.CORE_DB,
    deployment_generation: env.DEPLOYMENT_GENERATION,
  };
  return createService(runtime, {
    ...(options?.now === undefined ? {} : { now: options.now }),
    start_run: options?.start_run ?? createResearchRunService(env).run,
    parse_run_request: parseResearchRunRequest,
    is_run_request_input_error: (error) => error instanceof ResearchServiceError,
    is_research_run_service_error: (error): error is ResearchServiceError => error instanceof ResearchServiceError,
    ...(options?.allow_preferred_internal_key === undefined
      ? {} : { allow_preferred_internal_key: options.allow_preferred_internal_key }),
  });
}
