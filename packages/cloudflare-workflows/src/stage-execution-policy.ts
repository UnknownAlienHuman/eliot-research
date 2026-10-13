import type { ResearchWorkflowStage } from "@eliotr/contracts";
import {
  textDigest,
  WORKFLOW_NATIVE_STAGE_EFFECT_POLICY_GENERATION,
  type StageRequest,
  type WorkflowNativeStageAuthority,
  type WorkflowNativeStagePolicy,
} from "./types.js";

const NATIVE_PURE_STAGE_GENERATIONS: Readonly<Partial<Record<ResearchWorkflowStage, readonly string[]>>> = {
  ORIENT: [
    "research-handlers.exploratory.v1", "research-handlers.exploratory.v2",
    "research-handlers.exploratory.v3", "research-handlers.exploratory.v4",
    "research-handlers.exploratory.v5", "research-handlers.exploratory.v6",
    "research-handlers.exploratory.v7", "research-handlers.exploratory.v8",
  ],
  INTERPRET: [
    "research-handlers.exploratory.v1", "research-handlers.exploratory.v2",
    "research-handlers.exploratory.v3", "research-handlers.exploratory.v4",
    "research-handlers.exploratory.v5", "research-handlers.exploratory.v6",
    "research-handlers.exploratory.v7", "research-handlers.exploratory.v8",
  ],
  COMPILE_OBLIGATIONS: [
    "research-handlers.exploratory.v1", "research-handlers.exploratory.v2",
    "research-handlers.exploratory.v3", "research-handlers.exploratory.v4",
    "research-handlers.exploratory.v5", "research-handlers.exploratory.v6",
    "research-handlers.exploratory.v7", "research-handlers.exploratory.v8",
  ],
  PLAN: [
    "research-handlers.exploratory.v1", "research-handlers.exploratory.v2",
    "research-handlers.exploratory.v3", "research-handlers.exploratory.v4",
    "research-handlers.exploratory.v5", "research-handlers.exploratory.v6",
    "research-handlers.exploratory.v7", "research-handlers.exploratory.v8",
  ],
};

// Only the persisted-output v7 reader is eligible for AUTHORIZED_READ. V9
// executes a query plan and is intentionally not admitted by this map.
const NATIVE_AUTHORIZED_READ_STAGE_GENERATIONS: Readonly<Partial<Record<ResearchWorkflowStage, readonly string[]>>> = {
  READ_AND_EXTRACT: ["research-handlers.exploratory.v7"],
};

const LEGACY_AUTHORITY_POLICY_GENERATION = "research-policy-v1";

/**
 * Native retries are permitted only for installed deterministic early-stage
 * handlers plus the exact v7 persisted-output reader and the authority generation
 * scheme used by Research admission. V9 query planning, retrieval, acquisition,
 * persisted scope freeze, writes, and unknown tuples remain on the W2 path.
 */
export async function compileWorkflowNativeStagePolicy(input: {
  readonly request: StageRequest;
  readonly authority: WorkflowNativeStageAuthority;
  readonly run_effect_policy_generation: string | null;
}): Promise<WorkflowNativeStagePolicy | null> {
  if (input.run_effect_policy_generation !== WORKFLOW_NATIVE_STAGE_EFFECT_POLICY_GENERATION) return null;
  const pureHandlers = NATIVE_PURE_STAGE_GENERATIONS[input.request.stage];
  const authorizedReadHandlers = NATIVE_AUTHORIZED_READ_STAGE_GENERATIONS[input.request.stage];
  const isPure = pureHandlers?.includes(input.request.handler_generation) === true;
  const isAuthorizedRead = authorizedReadHandlers?.includes(input.request.handler_generation) === true;
  if (!isPure && !isAuthorizedRead) return null;

  const currentAuthorityGeneration = `${LEGACY_AUTHORITY_POLICY_GENERATION}:${await textDigest(input.authority.policy_authority_ref)}`;
  if (input.authority.policy_generation !== LEGACY_AUTHORITY_POLICY_GENERATION &&
      input.authority.policy_generation !== currentAuthorityGeneration) return null;

  return Object.freeze({
    effect_class: isAuthorizedRead ? "AUTHORIZED_READ" : "PURE_COMPUTE",
    effect_policy_generation: WORKFLOW_NATIVE_STAGE_EFFECT_POLICY_GENERATION,
    retry_limit: 1,
    retry_delay_ms: 1_000,
  });
}
