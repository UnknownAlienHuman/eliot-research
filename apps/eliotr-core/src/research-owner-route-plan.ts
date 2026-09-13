import {
  canonicalModelGatewayJson,
  compileDynamicRouteDesired,
  modelGatewayRequestParametersSha256,
  modelGatewaySha256,
  type DynamicRouteCompiledDesired,
  type DynamicRouteProvisioningInput,
} from "@eliotr/cloudflare-ai";
import {
  parseResearchOwnerOutputFormat,
  selectResearchOwnerPrompt,
  type ResearchOwnerOutputFormat,
} from "@eliotr/cloudflare-research-stages";
import {
  parseResearchOwnerReasoningEffort,
  type ResearchOwnerReasoningEffort,
} from "./research-owner-semantic-config.js";
import {
  APPLICATION_MODEL_ROUTES,
  type ApplicationModelRoute,
  type ModelRouteDeployment,
} from "@eliotr/platform-cloudflare";

const PROMPT_GENERATION_PREFIX = "eliotr.research.owner-prompt";
const SCHEMA_GENERATION_PREFIX = "eliotr.research.owner-schema";

export type ResearchOwnerRoutePlanStage = "SYNTHESIZE" | "AUDIT_CLAIMS";

export interface ResearchOwnerRoutePlanInput {
  readonly route_ref: ApplicationModelRoute;
  readonly route_version: string;
  readonly pricing_snapshot_ref: string;
  readonly stage: ResearchOwnerRoutePlanStage;
  readonly max_tokens: number;
  readonly route_definition: unknown;
  readonly output_format?: ResearchOwnerOutputFormat;
  readonly reasoning_effort?: ResearchOwnerReasoningEffort;
}

export interface ResearchOwnerRoutePlan {
  readonly stage: ResearchOwnerRoutePlanStage;
  readonly output_format: ResearchOwnerOutputFormat;
  readonly reasoning_effort?: ResearchOwnerReasoningEffort;
  readonly deployment: ModelRouteDeployment;
  readonly provisioning: DynamicRouteProvisioningInput;
  readonly compiled: DynamicRouteCompiledDesired;
}

function freezeDeep<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) freezeDeep(child);
    Object.freeze(value);
  }
  return value;
}

function snapshotJson<T>(value: T, label: string): T {
  try {
    return freezeDeep(JSON.parse(canonicalModelGatewayJson(value)) as T);
  } catch (cause) {
    throw new Error(`${label} is not canonical JSON`, { cause });
  }
}

function assertRouteRef(value: ApplicationModelRoute): void {
  if (!(APPLICATION_MODEL_ROUTES as readonly string[]).includes(value)) {
    throw new Error("research owner route reference is invalid");
  }
}

/**
 * Build a server-selected dynamic route without persistence or provider I/O.
 * All authority, pricing, qualification, and promotion decisions remain
 * outside this pure planning helper.
 */
export async function createResearchOwnerRoutePlan(
  input: ResearchOwnerRoutePlanInput,
): Promise<ResearchOwnerRoutePlan> {
  if (input === null || typeof input !== "object") {
    throw new Error("research owner route plan input is invalid");
  }
  const stage = input.stage;
  const routeRef = input.route_ref;
  const routeVersion = input.route_version;
  const pricingSnapshotRef = input.pricing_snapshot_ref;
  const maxTokens = input.max_tokens;
  if (!Number.isSafeInteger(maxTokens) || maxTokens < 1) {
    throw new Error("research owner route max_tokens must be a positive safe integer");
  }
  assertRouteRef(routeRef);
  const outputFormat = parseResearchOwnerOutputFormat(input.output_format);
  let reasoningEffort: ResearchOwnerReasoningEffort | undefined;
  try {
    reasoningEffort = parseResearchOwnerReasoningEffort(input.reasoning_effort);
  } catch {
    throw new Error("research owner reasoning_effort is invalid");
  }
  const prompt = selectResearchOwnerPrompt(stage, outputFormat);
  const routeDefinition = snapshotJson(input.route_definition, "route definition");
  if (!Array.isArray(routeDefinition) || routeDefinition.length === 0) {
    throw new Error("Cloudflare route_definition must be a non-empty element array");
  }

  const [parametersDigest, promptDigest, schemaDigest, routeDefinitionSha256] = await Promise.all([
    modelGatewayRequestParametersSha256({
      model: routeRef,
      messages: [],
      max_tokens: maxTokens,
      ...(reasoningEffort === undefined ? {} : { reasoning_effort: reasoningEffort }),
      ...(prompt.response_format === undefined ? {} : { response_format: prompt.response_format }),
      stream: false,
    }),
    modelGatewaySha256(canonicalModelGatewayJson({
      content_kind: "eliotr.research.owner-prompt.v1",
      prompt: prompt.prompt,
    })),
    modelGatewaySha256(canonicalModelGatewayJson({
      content_kind: "eliotr.research.owner-output-schema.v1",
      output_schema: prompt.output_schema,
    })),
    modelGatewaySha256(canonicalModelGatewayJson(routeDefinition)),
  ]);

  const deployment: ModelRouteDeployment = Object.freeze({
    route_ref: routeRef,
    route_version: routeVersion,
    prompt_generation: `${PROMPT_GENERATION_PREFIX}-${promptDigest}`,
    schema_generation: `${SCHEMA_GENERATION_PREFIX}-${schemaDigest}`,
    parameters_digest: parametersDigest,
    pricing_snapshot_ref: pricingSnapshotRef,
  });
  const provisioning: DynamicRouteProvisioningInput = Object.freeze({
    deployment,
    route_definition: routeDefinition,
    route_definition_sha256: routeDefinitionSha256,
  });
  const compiled = await compileDynamicRouteDesired(provisioning);
  return Object.freeze({
    stage,
    output_format: outputFormat,
    ...(reasoningEffort === undefined ? {} : { reasoning_effort: reasoningEffort }),
    deployment,
    provisioning,
    compiled,
  });
}
