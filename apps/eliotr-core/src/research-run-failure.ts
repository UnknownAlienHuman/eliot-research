import type { Env } from "./env.js";
import {
  readResearchEngineStatus as readResearchEngineStatusCapability,
  researchRunFailure,
} from "@eliotr/cloudflare-research-runtime";

export function readResearchEngineStatus(env: Env, operationId: string) {
  return readResearchEngineStatusCapability({ get_workflow: (id) => env.RESEARCH_WORKFLOW.get(id) }, operationId);
}

export { researchRunFailure };
export type { ResearchEngineObservation } from "@eliotr/cloudflare-research-runtime";
