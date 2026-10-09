import type { ResearchBranchRole } from "@eliotr/contracts";
import {
  BranchQueryPlanSchema,
  BranchQueryResultSchema,
  ResearchBranchRoleSchema,
  ResearchReadExtractCheckpointV2Schema,
  type BranchQueryPlan,
  type BranchQueryResult,
} from "@eliotr/contracts";
import { canonicalEvidenceJson } from "@eliotr/cloudflare-evidence";
import type { ModelGatewayRequestCapabilitiesV1 } from "@eliotr/cloudflare-ai";
import { researchBranchRoleQuestion } from "./research-planning-manifest.js";
import type {
  ResearchModelPromptCompilerDependencies,
  TrustedModelPromptParameters,
} from "@eliotr/cloudflare-model-control";
import type { ModelCallInput } from "@eliotr/research";
import type { ModelRouteDeployment } from "@eliotr/platform-cloudflare";

export interface ResearchBranchRolePromptDependenciesInput {
  readonly role: ResearchBranchRole;
  /** Exact role-bound plan and result read from the committed v2 read/extract checkpoint. */
  readonly branch_query?: {
    readonly plan: BranchQueryPlan;
    readonly result: BranchQueryResult;
  };
  /** Caller-owned manifest service (reference firewall for the role's evidence pack). */
  readonly manifest_service: ResearchModelPromptCompilerDependencies["manifest_service"];
  /** Caller-owned manifest input builder bound to the role's evidence pack. */
  readonly build_manifest_input: ResearchModelPromptCompilerDependencies["build_manifest_input"];
  /** Explicitly installed by the server; no model or prompt defaults are selected here. */
  readonly trusted_parameters: TrustedModelPromptParameters;
  readonly request_capabilities?: ModelGatewayRequestCapabilitiesV1;
  readonly selected_transport_policy?: ResearchModelPromptCompilerDependencies["selected_transport_policy"];
  readonly request_timeout_ms: number;
}

function fail(message: string): never {
  throw new Error(`research branch role prompt: ${message}`);
}

/** Parse the committed read/extract bytes into the exact question/query context for one model call. */
export function branchQueryPromptContextFromReadExtract(
  inputBytes: Uint8Array,
  role: ResearchBranchRole,
): { readonly plan: BranchQueryPlan; readonly result: BranchQueryResult } {
  const parsedRole = ResearchBranchRoleSchema.parse(role);
  let text: string;
  let raw: unknown;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(inputBytes);
    raw = JSON.parse(text) as unknown;
  } catch (cause) {
    fail(`v2 read/extract input is invalid: ${String(cause)}`);
  }
  const checkpoint = ResearchReadExtractCheckpointV2Schema.safeParse(raw);
  if (!checkpoint.success || canonicalEvidenceJson(checkpoint.data) !== text) fail("v2 read/extract input is not a canonical committed checkpoint");
  const query = checkpoint.data.role_queries.find((item) => item.query_plan.role === parsedRole);
  if (query === undefined) fail("committed read/extract checkpoint has no query for this role");
  return Object.freeze({
    plan: BranchQueryPlanSchema.parse(query.query_plan),
    result: BranchQueryResultSchema.parse(query.query_result),
  });
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
  let promptText: string;
  if (rawInput.branch_query === undefined) {
    const question = researchBranchRoleQuestion(role);
    promptText = `${trustedParameters.prompt}\n\nBranch role: ${role}\nInstalled branch question: ${question}\n\n` +
      `Analyze only the evidence listed in the evidence pack. Quote, summarize, or select only listed entries. ` +
      `Return a JSON object with protocol "eliotr.research.branch-role-output.v1", the branch role, a status of ` +
      `CANDIDATE_READY or BLOCKED, the selected evidence_handle_refs (only handles from the evidence pack), ` +
      `unknowns, and limitations. A branch with no usable evidence is BLOCKED with no evidence_handle_refs.`;
  } else {
    const plan = BranchQueryPlanSchema.parse(rawInput.branch_query.plan);
    const result = BranchQueryResultSchema.parse(rawInput.branch_query.result);
    if (plan.role !== role || result.role !== role ||
        result.query_plan_ref.id !== plan.query_plan_ref.id || result.query_plan_digest !== plan.identity_digest ||
        plan.root_question.question_ref.revision !== 1 || plan.branch_question.question_ref.revision !== 1) {
      fail("branch query prompt context is not bound to the role and plan");
    }
    const retrieval = result.query_legs.map((leg) => ({
      query_id: leg.query_id,
      query_sha256: leg.query_sha256,
      retrieval_request_digest: leg.retrieval_request_digest,
      ...(leg.trace === undefined ? {} : { trace_ref: leg.trace.trace_ref }),
      stop_reason: leg.stop_reason,
      resolved_handle_refs: leg.resolved_handle_refs.map((item) => item.handle_ref),
      omitted_candidates: leg.omitted_candidates,
    }));
    promptText = `${trustedParameters.prompt}\n\nBranch role: ${role}\n` +
      `Root question (${plan.root_question.question_ref.id}, sha256 ${plan.root_question.text_sha256}): ${plan.root_question.text}\n` +
      `Branch question (${plan.branch_question.question_ref.id}, sha256 ${plan.branch_question.text_sha256}): ${plan.branch_question.text}\n` +
      `Query plan (${plan.query_plan_ref.id}, sha256 ${plan.identity_digest}): ${canonicalEvidenceJson(plan.query_legs)}\n` +
      `Executed retrieval provenance: ${canonicalEvidenceJson(retrieval)}\n\n` +
      `Analyze this branch question using only exact evidence entries in the evidence pack. Do not infer truth from retrieval metadata, ` +
      `and do not cite a handle absent from that pack. Return protocol "eliotr.research.branch-role-output.v2", ` +
      `role, root_question_ref/root_question_sha256, branch_question_ref/branch_question_sha256, query_plan_ref/query_plan_digest, ` +
      `and a finding object using "eliotr.research.branch-finding-draft.v1" with role, question_ref/question_sha256, ` +
      `kind, state, statement, conditions, scope, evidence_handle_refs, unknowns and limitations. ` +
      `Use state BLOCKED, empty statement and no evidence refs when the query result has no admissible evidence. ` +
      `Do not return hidden reasoning.`;
  }
  return Object.freeze({
    manifest_service: rawInput.manifest_service,
    build_manifest_input: rawInput.build_manifest_input,
    resolve_trusted_parameters: async (
      _input: ModelCallInput,
      _deployment: ModelRouteDeployment,
    ): Promise<TrustedModelPromptParameters> => Object.freeze({ ...trustedParameters, prompt: promptText }),
    ...(rawInput.request_capabilities === undefined ? {} : { request_capabilities: rawInput.request_capabilities }),
    ...(rawInput.selected_transport_policy === undefined ? {} : { selected_transport_policy: rawInput.selected_transport_policy }),
    request_timeout_ms: rawInput.request_timeout_ms,
  });
}
