import type { ResearchBranchRole } from "@eliotr/contracts";
import type { ModelGatewayRequestCapabilitiesV1 } from "@eliotr/cloudflare-ai";
import {
  researchBranchRoleQuestion,
  type ResearchModelPromptCompilerDependencies,
  type TrustedModelPromptParameters,
} from "@eliotr/cloudflare-research";
import type { ModelCallInput } from "@eliotr/research";
import type { ModelRouteDeployment } from "@eliotr/platform-cloudflare";

export interface ResearchBranchRolePromptDependenciesInput {
  readonly role: ResearchBranchRole;
  /** Caller-owned manifest service (reference firewall for the role's evidence pack). */
  readonly manifest_service: ResearchModelPromptCompilerDependencies["manifest_service"];
  /** Caller-owned manifest input builder bound to the role's evidence pack. */
  readonly build_manifest_input: ResearchModelPromptCompilerDependencies["build_manifest_input"];
  /** Explicitly installed by the server; no model or prompt defaults are selected here. */
  readonly trusted_parameters: TrustedModelPromptParameters;
  readonly request_capabilities?: ModelGatewayRequestCapabilitiesV1;
  readonly request_timeout_ms: number;
}

function fail(message: string): never {
  throw new Error(`research branch role prompt: ${message}`);
}

/**
 * Builds the installed per-role prompt compiler dependencies. The prompt text
 * is the server-installed branch role question composed with the trusted
 * parameters; the model must return the branch-role output schema with handles
 * selected only from the evidence pack. Evidence bounding is enforced again
 * deterministically when the model output is parsed.
 */
export function createResearchBranchRolePromptDependencies(
  rawInput: ResearchBranchRolePromptDependenciesInput,
): ResearchModelPromptCompilerDependencies {
  if (rawInput === null || typeof rawInput !== "object" ||
      typeof rawInput.manifest_service?.buildAndPersist !== "function" ||
      typeof rawInput.build_manifest_input !== "function") {
    fail("prompt dependencies are invalid");
  }
  const trustedParameters = rawInput.trusted_parameters;
  if (trustedParameters === null || typeof trustedParameters !== "object" ||
      typeof trustedParameters.prompt !== "string" || trustedParameters.prompt.length === 0 ||
      !Number.isSafeInteger(trustedParameters.max_tokens) || trustedParameters.max_tokens < 1) {
    fail("trusted parameters are invalid");
  }
  if (!Number.isSafeInteger(rawInput.request_timeout_ms) || rawInput.request_timeout_ms < 1 ||
      rawInput.request_timeout_ms > 300_000) {
    fail("request timeout is invalid");
  }
  const role = rawInput.role;
  const question = researchBranchRoleQuestion(role);
  const promptText = `${trustedParameters.prompt}\n\nBranch role: ${role}\nInstalled branch question: ${question}\n\n` +
    `Analyze only the evidence listed in the evidence pack. Quote, summarize, or select only listed entries. ` +
    `Return a JSON object with protocol "eliotr.research.branch-role-output.v1", the branch role, a status of ` +
    `CANDIDATE_READY or BLOCKED, the selected evidence_handle_refs (only handles from the evidence pack), ` +
    `unknowns, and limitations. A branch with no usable evidence is BLOCKED with no evidence_handle_refs.`;
  return Object.freeze({
    manifest_service: rawInput.manifest_service,
    build_manifest_input: rawInput.build_manifest_input,
    resolve_trusted_parameters: async (
      _input: ModelCallInput,
      _deployment: ModelRouteDeployment,
    ): Promise<TrustedModelPromptParameters> => Object.freeze({ ...trustedParameters, prompt: promptText }),
    ...(rawInput.request_capabilities === undefined ? {} : { request_capabilities: rawInput.request_capabilities }),
    request_timeout_ms: rawInput.request_timeout_ms,
  });
}
