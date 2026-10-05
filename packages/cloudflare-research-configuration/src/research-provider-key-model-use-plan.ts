import {
  canonicalModelGatewayJson,
  modelGatewayRequestParametersSha256,
  modelGatewaySha256,
  normalizeModelGatewayReasoningEffort,
  validateModelGatewayTransportPolicy,
  type ModelGatewayTransportPolicyV1,
} from "@eliotr/cloudflare-ai";
import {
  decodeModelRouteDeployment,
  type ModelRouteDeployment,
} from "@eliotr/platform-cloudflare";
import {
  createModelProfileDefinition,
  createOwnerModelProfileTemplateV2,
  decodeResearchProjectModelConfigurationBundle,
  readOwnerModelProfileTemplateV2,
  readResearchOwnerSpendPolicyTemplate,
  type ResearchProjectModelConfigurationBundle,
  type ResearchProjectModelSelection,
  type ResearchOwnerSpendPolicyTemplate,
} from "@eliotr/cloudflare-research";
import {
  PROVIDER_NATIVE_MODEL_PROBE_PROMPT,
  providerNativeModelProbeInputDigests,
} from "@eliotr/cloudflare-native-models";
import { APPLICATION_MODEL_ROUTES } from "@eliotr/platform-cloudflare";
import { parseResearchPreparedModelTransportPolicies } from "@eliotr/cloudflare-model-control/research-prepared-model-transport-policies.js";
import { selectResearchOwnerPrompt } from "@eliotr/cloudflare-research-stages";
import { parseResearchSemanticConfiguration } from "./research-semantic-configuration-schema.js";
import type { SelectedResearchProjectConfiguration } from "./research-project-configuration.js";
import type { ConfiguredResearchProviderKeyOperation } from "@eliotr/cloudflare-model-control";
import type { ResearchProviderKeyModelUseStage, ResearchProviderKeyModelUseStagePlan } from "./research-provider-key-model-use-store.js";

export const RESEARCH_PROVIDER_KEY_MODEL_USE_BASIS_PROTOCOL = "eliotr.research.provider-key-model-use-basis.v1" as const;
const MODEL_ID = "stealth/space-bunny-alpha" as const;
const STAGE_ORDER: readonly ResearchProviderKeyModelUseStage[] = ["ANALYZE_BRANCHES", "COUNTER_SEARCH", "SYNTHESIZE", "AUDIT_CLAIMS"];
const REQUIRED_VARS = [
  "ELIOTR_RESEARCH_SEMANTIC_CONFIG_JSON", "ELIOTR_MODEL_PROFILE_DEFINITION_JSON",
  "ELIOTR_MODEL_PROFILE_PROVENANCE_REF", "ELIOTR_MODEL_SPEND_POLICY_JSON",
  "ELIOTR_MODEL_SPEND_POLICY_PROVENANCE_REF", "ELIOTR_RESEARCH_REPORT_CONFIG_JSON",
  "ELIOTR_RESEARCH_REPORT_POLICY_PROVENANCE_REF",
] as const;
const SHA256 = /^[a-f0-9]{64}$/u;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/u;

export class ResearchProviderKeyModelUsePlanError extends Error {
  public constructor(public readonly code: "SERVER_POLICY_UNAVAILABLE" | "NO_SELECTED_CONFIGURATION", message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "ResearchProviderKeyModelUsePlanError";
  }
}

export interface ResearchProviderKeyModelUseStagePlanV1 extends ResearchProviderKeyModelUseStagePlan {
  readonly deployment: ModelRouteDeployment;
  readonly probe_deployment: ModelRouteDeployment;
  readonly transport_policy: ModelGatewayTransportPolicyV1;
  readonly probe_prompt_sha256: string;
  readonly probe_schema_sha256: string;
  readonly probe_parameters_sha256: string;
  readonly max_input_bytes: number;
  readonly max_output_bytes: number;
}

export interface ResearchProviderKeyModelUseBasisV1 {
  readonly protocol: typeof RESEARCH_PROVIDER_KEY_MODEL_USE_BASIS_PROTOCOL;
  readonly semantic_revision: ResearchProjectModelConfigurationBundle["semantic_revision"];
  readonly vars: ResearchProjectModelConfigurationBundle["vars"];
  readonly stages: readonly ResearchProviderKeyModelUseStagePlanV1[];
}

export interface ResearchProviderKeyModelUseRuntimePolicyV1 {
  readonly ELIOTR_MODEL_PROFILE_DEFINITION_JSON?: string;
  readonly ELIOTR_MODEL_PROFILE_PROVENANCE_REF?: string;
  readonly ELIOTR_MODEL_SPEND_POLICY_JSON?: string;
  readonly ELIOTR_MODEL_SPEND_POLICY_PROVENANCE_REF?: string;
  readonly ELIOTR_RESEARCH_REPORT_CONFIG_JSON?: string;
  readonly ELIOTR_RESEARCH_REPORT_POLICY_PROVENANCE_REF?: string;
  readonly ELIOTR_RESEARCH_MODEL_TRANSPORT_POLICIES_JSON?: string;
}

export interface ResearchProviderKeyModelUseSemanticConfigurationV1 {
  readonly config_json: string;
  readonly config_sha256: string;
  readonly revision_ref: string | null;
}

export interface ResearchProviderKeyModelUseSemanticSourceV1 {
  resolve(database: D1Database): Promise<ResearchProviderKeyModelUseSemanticConfigurationV1>;
}

function fail(message: string, cause?: unknown): never {
  throw new ResearchProviderKeyModelUsePlanError("SERVER_POLICY_UNAVAILABLE", message, cause);
}

function requireSha256(value: unknown, label: string): string {
  if (typeof value !== "string" || !SHA256.test(value)) fail(`${label} is invalid`);
  return value;
}

function requireStoredVar(vars: Record<string, unknown>, key: typeof REQUIRED_VARS[number]): string {
  const value = vars[key];
  if (typeof value !== "string" || value.length === 0) fail(`Stored project configuration variable ${key} is invalid`);
  return value;
}

function exactPlain(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value) ||
      (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) {
    fail(`${label} is not a plain server configuration object`);
  }
  return value as Record<string, unknown>;
}

function hashFromGeneration(value: string, prefix: string, label: string): string {
  if (!value.startsWith(prefix)) fail(`${label} generation is not an exact owner-managed digest`);
  const digest = value.slice(prefix.length);
  if (!SHA256.test(digest)) fail(`${label} generation digest is invalid`);
  return digest;
}

function stageParameters(semantic: ReturnType<typeof parseResearchSemanticConfiguration>, stage: ResearchProviderKeyModelUseStage) {
  if (stage === "SYNTHESIZE") return semantic.synthesis.trusted_parameters;
  if (stage === "AUDIT_CLAIMS") return semantic.audit.trusted_parameters;
  return semantic.roles?.trusted_parameters ?? semantic.audit.trusted_parameters;
}

function jsonSchemaPrompt(
  semantic: ReturnType<typeof parseResearchSemanticConfiguration>,
  stage: "SYNTHESIZE" | "AUDIT_CLAIMS",
) {
  const configured = stage === "SYNTHESIZE" ? semantic.synthesis.trusted_parameters : semantic.audit.trusted_parameters;
  for (const format of ["prompt_json", "json_schema"] as const) {
    const selected = selectResearchOwnerPrompt(stage, format);
    if (selected.prompt === configured.prompt &&
        canonicalModelGatewayJson(selected.response_format ?? null) === canonicalModelGatewayJson(configured.response_format ?? null)) {
      return selected;
    }
  }
  return fail(`${stage} prompt/schema is not an installed owner prompt`);
}

function fixedTransportPolicy(
  raw: string | undefined,
  stage: ResearchProviderKeyModelUseStage,
  base: ModelRouteDeployment,
  key: ConfiguredResearchProviderKeyOperation,
  selectedConfiguration: SelectedResearchProjectConfiguration | null,
): ModelGatewayTransportPolicyV1 {
  let sourcePolicy: unknown;
  const nativeSelection = selectedConfiguration?.configuration.model_selections.find((entry) =>
    entry.stage === stage && entry.candidate_kind === "provider-native-v1");
  if (nativeSelection !== undefined) {
    if (nativeSelection.route_ref !== base.route_ref || nativeSelection.route_version !== base.route_version) {
      fail(`${stage} selected Native transport does not match its current route`);
    }
    sourcePolicy = nativeSelection.transport_policy;
  } else {
    let policies;
    try { policies = parseResearchPreparedModelTransportPolicies(raw); }
    catch (cause) { return fail("The installed exact Bunny transport policy is invalid", cause); }
    const installed = policies?.model_selections.find((entry) => entry.stage === stage &&
      entry.route_ref === base.route_ref && entry.route_version === base.route_version &&
      entry.provider === "openrouter" && entry.model === MODEL_ID);
    if (installed === undefined) fail(`${stage} has no server-installed exact OpenRouter Bunny policy for its current route`);
    sourcePolicy = installed.transport_policy;
  }
  let source: ModelGatewayTransportPolicyV1;
  try { source = validateModelGatewayTransportPolicy(sourcePolicy); }
  catch (cause) { return fail(`${stage} OpenRouter policy is invalid`, cause); }
  if (source.api !== "openrouter-chat-completions" || source.provider !== "openrouter" ||
      source.model !== MODEL_ID || source.billing.mode !== "byok" ||
      source.billing.free_only !== true ||
      source.capabilities.max_output_tokens_field !== "max_tokens" ||
      source.capabilities.response_format_normalization !== "json-schema-to-json-object" ||
      source.billing.alias === "default" || key.alias === "default") {
    fail(`${stage} exact OpenRouter policy lacks the fixed native BYOK/JSON-object contract`);
  }
  return validateModelGatewayTransportPolicy({
    version: 1,
    transport: "cloudflare-ai-gateway",
    api: "openrouter-chat-completions",
    provider: "openrouter",
    model: MODEL_ID,
    billing: { mode: "byok", alias: key.alias, free_only: true },
    capabilities: source.capabilities,
  });
}

function stageVersion(operationId: string, stage: ResearchProviderKeyModelUseStage): string {
  return `native-${operationId.replaceAll("-", "")}-${stage.toLowerCase()}`;
}

async function buildStagePlan(
  input: {
    readonly stage: ResearchProviderKeyModelUseStage;
    readonly sequence_number: number;
    readonly base_deployment: ModelRouteDeployment;
    readonly max_input_bytes: number;
    readonly max_output_bytes: number;
    readonly semantic: ReturnType<typeof parseResearchSemanticConfiguration>;
    readonly transport_policy: ModelGatewayTransportPolicyV1;
    readonly operation_id: string;
  },
): Promise<ResearchProviderKeyModelUseStagePlanV1> {
  if (!(APPLICATION_MODEL_ROUTES as readonly string[]).includes(input.base_deployment.route_ref) ||
      !Number.isSafeInteger(input.max_input_bytes) || input.max_input_bytes < 1 ||
      !Number.isSafeInteger(input.max_output_bytes) || input.max_output_bytes < 1) {
    fail(`${input.stage} installed spend rule has invalid route or byte limits`);
  }
  const params = stageParameters(input.semantic, input.stage);
  if (params.reasoning_effort !== undefined) {
    try { normalizeModelGatewayReasoningEffort(params.reasoning_effort, input.transport_policy.capabilities); }
    catch (cause) { return fail(`${input.stage} parameter profile is unsupported by the fixed Bunny policy`, cause); }
  }
  const appPrompt = input.stage === "SYNTHESIZE" || input.stage === "AUDIT_CLAIMS"
    ? jsonSchemaPrompt(input.semantic, input.stage)
    : undefined;
  const appPromptSha = appPrompt === undefined
    ? hashFromGeneration(input.base_deployment.prompt_generation, "eliotr.research.owner-prompt-", `${input.stage} prompt`)
    : await modelGatewaySha256(canonicalModelGatewayJson({ content_kind: "eliotr.research.owner-prompt.v1", prompt: appPrompt.prompt }));
  const appSchemaSha = appPrompt === undefined
    ? hashFromGeneration(input.base_deployment.schema_generation, "eliotr.research.owner-schema-", `${input.stage} schema`)
    : await modelGatewaySha256(canonicalModelGatewayJson({ content_kind: "eliotr.research.owner-output-schema.v1", output_schema: appPrompt.output_schema }));
  const appParameters = {
    model: input.base_deployment.route_ref,
    messages: [],
    [input.transport_policy.capabilities.max_output_tokens_field]: params.max_tokens,
    ...(params.reasoning_effort === undefined ? {} : { reasoning_effort: params.reasoning_effort }),
    ...(params.response_format === undefined ? {} : { response_format: params.response_format }),
    stream: false,
  };
  const parametersSha = await modelGatewayRequestParametersSha256(
    appParameters, input.transport_policy.capabilities, input.transport_policy.api,
  );
  const routeVersion = stageVersion(input.operation_id, input.stage);
  const promptGeneration = appPrompt === undefined
    ? input.base_deployment.prompt_generation
    : `eliotr.research.owner-prompt-${appPromptSha}`;
  const schemaGeneration = appPrompt === undefined
    ? input.base_deployment.schema_generation
    : `eliotr.research.owner-schema-${appSchemaSha}`;
  const [probeDigests, probeParametersSha] = await Promise.all([
    providerNativeModelProbeInputDigests(),
    modelGatewayRequestParametersSha256({
      model: MODEL_ID,
      messages: [{ role: "user", content: PROVIDER_NATIVE_MODEL_PROBE_PROMPT }],
      max_tokens: 32,
      response_format: { type: "json_object" },
      stream: false,
    }, input.transport_policy.capabilities, input.transport_policy.api),
  ]);
  const pricingPlaceholder = "pricing-pending";
  const deployment = decodeModelRouteDeployment({
    route_ref: input.base_deployment.route_ref,
    route_version: routeVersion,
    prompt_generation: promptGeneration,
    schema_generation: schemaGeneration,
    parameters_digest: parametersSha,
    pricing_snapshot_ref: pricingPlaceholder,
  });
  const probeDeployment = decodeModelRouteDeployment({
    route_ref: input.base_deployment.route_ref,
    route_version: routeVersion,
    prompt_generation: `eliotr.research.provider-native-probe-prompt-${probeDigests.probe_prompt_sha256}`,
    schema_generation: `eliotr.research.provider-native-probe-schema-${probeDigests.probe_schema_sha256}`,
    parameters_digest: probeParametersSha,
    pricing_snapshot_ref: pricingPlaceholder,
  });
  return Object.freeze({
    sequence_number: input.sequence_number,
    stage: input.stage,
    route_ref: input.base_deployment.route_ref,
    route_version: routeVersion,
    prompt_sha256: appPromptSha,
    schema_sha256: appSchemaSha,
    parameters_sha256: parametersSha,
    deployment,
    probe_deployment: probeDeployment,
    transport_policy: input.transport_policy,
    probe_prompt_sha256: probeDigests.probe_prompt_sha256,
    probe_schema_sha256: probeDigests.probe_schema_sha256,
    probe_parameters_sha256: probeParametersSha,
    max_input_bytes: input.max_input_bytes,
    max_output_bytes: input.max_output_bytes,
  });
}

function readBaseVars(runtimePolicy: ResearchProviderKeyModelUseRuntimePolicyV1,
  selected: SelectedResearchProjectConfiguration | null,
  semantic: ResearchProviderKeyModelUseSemanticConfigurationV1): ResearchProjectModelConfigurationBundle["vars"] {
  const values = selected?.configuration.vars ?? {
    ELIOTR_RESEARCH_SEMANTIC_CONFIG_JSON: semantic.config_json,
    ELIOTR_MODEL_PROFILE_DEFINITION_JSON: runtimePolicy.ELIOTR_MODEL_PROFILE_DEFINITION_JSON ?? "",
    ELIOTR_MODEL_PROFILE_PROVENANCE_REF: runtimePolicy.ELIOTR_MODEL_PROFILE_PROVENANCE_REF ?? "",
    ELIOTR_MODEL_SPEND_POLICY_JSON: runtimePolicy.ELIOTR_MODEL_SPEND_POLICY_JSON ?? "",
    ELIOTR_MODEL_SPEND_POLICY_PROVENANCE_REF: runtimePolicy.ELIOTR_MODEL_SPEND_POLICY_PROVENANCE_REF ?? "",
    ELIOTR_RESEARCH_REPORT_CONFIG_JSON: runtimePolicy.ELIOTR_RESEARCH_REPORT_CONFIG_JSON ?? "",
    ELIOTR_RESEARCH_REPORT_POLICY_PROVENANCE_REF: runtimePolicy.ELIOTR_RESEARCH_REPORT_POLICY_PROVENANCE_REF ?? "",
  };
  if (REQUIRED_VARS.some((key) => typeof values[key] !== "string" || values[key].length === 0)) {
    fail("Complete installed semantic, profile, spend, and report configuration is required for first model use");
  }
  return Object.freeze({ ...values });
}

function assertSameSemanticRevision(
  vars: ResearchProjectModelConfigurationBundle["vars"],
  semantic: ResearchProviderKeyModelUseSemanticConfigurationV1,
  selected: SelectedResearchProjectConfiguration | null,
): ResearchProjectModelConfigurationBundle["semantic_revision"] {
  if (selected !== null) {
    if (semantic.revision_ref !== selected.configuration.semantic_revision.revision_ref ||
        semantic.config_sha256 !== selected.configuration.semantic_revision.config_sha256) {
      fail("Current installed semantic revision differs from the selected project's immutable basis");
    }
    return selected.configuration.semantic_revision;
  }
  if (semantic.revision_ref === null || semantic.revision_ref !== `scr-${semantic.config_sha256.slice(0, 12)}` ||
      !SHA256.test(semantic.config_sha256) ||
      vars.ELIOTR_RESEARCH_SEMANTIC_CONFIG_JSON !== semantic.config_json) {
    fail("A blank project requires a current canonical immutable semantic revision");
  }
  return Object.freeze({ revision_ref: semantic.revision_ref, config_sha256: semantic.config_sha256 });
}

/** Build the immutable app-stage bindings from selected project or installed server baseline. */
export async function createResearchProviderKeyModelUseBasis(input: {
  readonly runtime_policy: ResearchProviderKeyModelUseRuntimePolicyV1;
  readonly semantic_source: ResearchProviderKeyModelUseSemanticSourceV1;
  readonly selected: SelectedResearchProjectConfiguration | null;
  readonly key: ConfiguredResearchProviderKeyOperation;
  readonly operation_id: string;
  readonly database: D1Database;
}): Promise<ResearchProviderKeyModelUseBasisV1> {
  let semanticRevision: ResearchProviderKeyModelUseSemanticConfigurationV1;
  try { semanticRevision = await input.semantic_source.resolve(input.database); }
  catch (cause) { return fail("Current immutable semantic configuration cannot be resolved", cause); }
  const vars = readBaseVars(input.runtime_policy, input.selected, semanticRevision);
  const semantic = parseResearchSemanticConfiguration(vars.ELIOTR_RESEARCH_SEMANTIC_CONFIG_JSON);
  const revision = assertSameSemanticRevision(vars, semanticRevision, input.selected);
  let spend: ResearchOwnerSpendPolicyTemplate;
  try { spend = readResearchOwnerSpendPolicyTemplate(vars.ELIOTR_MODEL_SPEND_POLICY_JSON, vars.ELIOTR_MODEL_SPEND_POLICY_PROVENANCE_REF); }
  catch (cause) { return fail("The exact installed owner spend-policy template is unavailable", cause); }
  if (spend.client_class !== "owner_pwa" || spend.principal_ref !== input.key.owner_id ||
      spend.rules.length < 2 || spend.rules.length > 4) {
    fail("The trusted spend policy is not bound to this owner or its bounded stage set");
  }
  const sortedRules = [...spend.rules].sort((left, right) => STAGE_ORDER.indexOf(left.stage as ResearchProviderKeyModelUseStage) -
    STAGE_ORDER.indexOf(right.stage as ResearchProviderKeyModelUseStage));
  if (!sortedRules.some((rule) => rule.stage === "SYNTHESIZE") || !sortedRules.some((rule) => rule.stage === "AUDIT_CLAIMS") ||
      new Set(sortedRules.map((rule) => rule.stage)).size !== sortedRules.length) {
    fail("Trusted spend policy must enable each required stage exactly once");
  }
  const stages: ResearchProviderKeyModelUseStagePlanV1[] = [];
  for (const [index, rule] of sortedRules.entries()) {
    const stage = rule.stage as ResearchProviderKeyModelUseStage;
    let baseDeployment: ModelRouteDeployment;
    try { baseDeployment = decodeModelRouteDeployment(rule.deployment); }
    catch (cause) { return fail(`${stage} owner spend deployment is invalid`, cause); }
    const exactPolicy = fixedTransportPolicy(input.runtime_policy.ELIOTR_RESEARCH_MODEL_TRANSPORT_POLICIES_JSON,
      stage, baseDeployment, input.key, input.selected);
    stages.push(await buildStagePlan({
      stage,
      sequence_number: index,
      base_deployment: baseDeployment,
      max_input_bytes: rule.max_input_bytes,
      max_output_bytes: rule.max_output_bytes,
      semantic,
      transport_policy: exactPolicy,
      operation_id: input.operation_id,
    }));
  }
  return Object.freeze({
    protocol: RESEARCH_PROVIDER_KEY_MODEL_USE_BASIS_PROTOCOL,
    semantic_revision: revision,
    vars,
    stages: Object.freeze(stages),
  });
}

export function parseResearchProviderKeyModelUseBasis(raw: string): ResearchProviderKeyModelUseBasisV1 {
  if (typeof raw !== "string" || new TextEncoder().encode(raw).byteLength > 524_288) fail("Stored operation basis exceeds its byte bound");
  let decoded: unknown;
  try { decoded = JSON.parse(raw) as unknown; } catch (cause) { return fail("Stored operation basis is invalid JSON", cause); }
  const record = exactPlain(decoded, "Stored operation basis");
  if (Object.keys(record).length !== 4 || Object.keys(record).some((key) =>
    !["protocol", "semantic_revision", "vars", "stages"].includes(key))) {
    fail("Stored operation basis contains unsupported fields");
  }
  if (record.protocol !== RESEARCH_PROVIDER_KEY_MODEL_USE_BASIS_PROTOCOL ||
      !Array.isArray(record.stages) || record.stages.length < 2 || record.stages.length > 4) {
    fail("Stored operation basis has an invalid protocol or stage set");
  }
  if (canonicalModelGatewayJson(decoded) !== raw) fail("Stored operation basis is not canonical JSON");
  const semanticRevision = exactPlain(record.semantic_revision, "Stored semantic revision");
  if (Object.keys(semanticRevision).length !== 2 ||
      typeof semanticRevision.revision_ref !== "string" || !/^scr-[a-f0-9]{12}$/u.test(semanticRevision.revision_ref) ||
      typeof semanticRevision.config_sha256 !== "string" || !SHA256.test(semanticRevision.config_sha256) ||
      semanticRevision.revision_ref !== `scr-${semanticRevision.config_sha256.slice(0, 12)}`) {
    fail("Stored semantic revision identity is invalid");
  }
  const vars = exactPlain(record.vars, "Stored project configuration variables");
  if (Object.keys(vars).length !== REQUIRED_VARS.length || Object.entries(vars).some(([key, value]) =>
    !REQUIRED_VARS.includes(key as typeof REQUIRED_VARS[number]) || typeof value !== "string" || value.length > 262_144) ||
      REQUIRED_VARS.some((key) => typeof vars[key] !== "string" || vars[key].length === 0)) {
    fail("Stored project configuration variables are invalid");
  }
  const stages: ResearchProviderKeyModelUseStagePlanV1[] = [];
  const stageKeys = new Set([
    "sequence_number", "stage", "route_ref", "route_version", "prompt_sha256", "schema_sha256",
    "parameters_sha256", "probe_prompt_sha256", "probe_schema_sha256", "probe_parameters_sha256",
    "deployment", "probe_deployment", "transport_policy", "max_input_bytes", "max_output_bytes",
  ]);
  for (const [index, rawStage] of record.stages.entries()) {
    const stage = exactPlain(rawStage, "Stored stage binding");
    if (Object.keys(stage).length !== stageKeys.size || Object.keys(stage).some((key) => !stageKeys.has(key))) {
      fail("Stored stage binding contains unsupported fields");
    }
    const name = stage.stage;
    const routeRef = stage.route_ref;
    const routeVersion = stage.route_version;
    const appPromptSha = requireSha256(stage.prompt_sha256, "Stored app prompt digest");
    const appSchemaSha = requireSha256(stage.schema_sha256, "Stored app schema digest");
    const appParametersSha = requireSha256(stage.parameters_sha256, "Stored app parameters digest");
    const probePromptSha = requireSha256(stage.probe_prompt_sha256, "Stored probe prompt digest");
    const probeSchemaSha = requireSha256(stage.probe_schema_sha256, "Stored probe schema digest");
    const probeParametersSha = requireSha256(stage.probe_parameters_sha256, "Stored probe parameters digest");
    const sequence = stage.sequence_number;
    const maxInput = stage.max_input_bytes;
    const maxOutput = stage.max_output_bytes;
    if (typeof name !== "string" || !(STAGE_ORDER as readonly string[]).includes(name) ||
        sequence !== index || typeof routeRef !== "string" || !(APPLICATION_MODEL_ROUTES as readonly string[]).includes(routeRef) ||
        typeof routeVersion !== "string" || !ID.test(routeVersion) ||
        typeof maxInput !== "number" || !Number.isSafeInteger(maxInput) || maxInput < 1 || maxInput > 1_048_576 ||
        typeof maxOutput !== "number" || !Number.isSafeInteger(maxOutput) || maxOutput < 1 || maxOutput > 1_048_576) {
      fail("Stored stage binding identity or bounds are invalid");
    }
    let deployment: ModelRouteDeployment;
    let probeDeployment: ModelRouteDeployment;
    let transportPolicy: ModelGatewayTransportPolicyV1;
    try {
      deployment = decodeModelRouteDeployment(stage.deployment);
      probeDeployment = decodeModelRouteDeployment(stage.probe_deployment);
      transportPolicy = validateModelGatewayTransportPolicy(stage.transport_policy);
    } catch (cause) { return fail("Stored stage deployment or transport policy is invalid", cause); }
    if (deployment.route_ref !== routeRef || deployment.route_version !== routeVersion ||
        deployment.prompt_generation !== `eliotr.research.owner-prompt-${appPromptSha}` ||
        deployment.schema_generation !== `eliotr.research.owner-schema-${appSchemaSha}` ||
        deployment.parameters_digest !== appParametersSha || deployment.pricing_snapshot_ref !== "pricing-pending" ||
        probeDeployment.route_ref !== routeRef || probeDeployment.route_version !== routeVersion ||
        probeDeployment.parameters_digest !== probeParametersSha || probeDeployment.pricing_snapshot_ref !== "pricing-pending" ||
        probeDeployment.prompt_generation !== `eliotr.research.provider-native-probe-prompt-${probePromptSha}` ||
        probeDeployment.schema_generation !== `eliotr.research.provider-native-probe-schema-${probeSchemaSha}` ||
        transportPolicy.api !== "openrouter-chat-completions" || transportPolicy.provider !== "openrouter" ||
        transportPolicy.model !== MODEL_ID || transportPolicy.billing.mode !== "byok" ||
        transportPolicy.billing.free_only !== true || !/^eliotr-[0-9a-f]{48}$/u.test(transportPolicy.billing.alias) ||
        transportPolicy.capabilities.max_output_tokens_field !== "max_tokens" ||
        transportPolicy.capabilities.response_format_normalization !== "json-schema-to-json-object") {
      fail("Stored stage binding does not satisfy the fixed free-only Bunny preparation contract");
    }
    stages.push(Object.freeze({
      sequence_number: sequence,
      stage: name as ResearchProviderKeyModelUseStage,
      route_ref: routeRef,
      route_version: routeVersion,
      prompt_sha256: appPromptSha,
      schema_sha256: appSchemaSha,
      parameters_sha256: appParametersSha,
      probe_prompt_sha256: probePromptSha,
      probe_schema_sha256: probeSchemaSha,
      probe_parameters_sha256: probeParametersSha,
      deployment,
      probe_deployment: probeDeployment,
      transport_policy: transportPolicy,
      max_input_bytes: maxInput,
      max_output_bytes: maxOutput,
    }));
  }
  if (new Set(stages.map((stage) => stage.stage)).size !== stages.length ||
      !stages.some((stage) => stage.stage === "SYNTHESIZE") || !stages.some((stage) => stage.stage === "AUDIT_CLAIMS")) {
    fail("Stored stage set is duplicated or missing a required stage");
  }
  return Object.freeze({
    protocol: RESEARCH_PROVIDER_KEY_MODEL_USE_BASIS_PROTOCOL,
    semantic_revision: Object.freeze({ revision_ref: semanticRevision.revision_ref, config_sha256: semanticRevision.config_sha256 }),
    vars: Object.freeze({
      ELIOTR_RESEARCH_SEMANTIC_CONFIG_JSON: requireStoredVar(vars, "ELIOTR_RESEARCH_SEMANTIC_CONFIG_JSON"),
      ELIOTR_MODEL_PROFILE_DEFINITION_JSON: requireStoredVar(vars, "ELIOTR_MODEL_PROFILE_DEFINITION_JSON"),
      ELIOTR_MODEL_PROFILE_PROVENANCE_REF: requireStoredVar(vars, "ELIOTR_MODEL_PROFILE_PROVENANCE_REF"),
      ELIOTR_MODEL_SPEND_POLICY_JSON: requireStoredVar(vars, "ELIOTR_MODEL_SPEND_POLICY_JSON"),
      ELIOTR_MODEL_SPEND_POLICY_PROVENANCE_REF: requireStoredVar(vars, "ELIOTR_MODEL_SPEND_POLICY_PROVENANCE_REF"),
      ELIOTR_RESEARCH_REPORT_CONFIG_JSON: requireStoredVar(vars, "ELIOTR_RESEARCH_REPORT_CONFIG_JSON"),
      ELIOTR_RESEARCH_REPORT_POLICY_PROVENANCE_REF: requireStoredVar(vars, "ELIOTR_RESEARCH_REPORT_POLICY_PROVENANCE_REF"),
    }),
    stages: Object.freeze(stages),
  });
}

export function deploymentForStage(stage: ResearchProviderKeyModelUseStagePlanV1, pricingSnapshotRef: string): ModelRouteDeployment {
  return decodeModelRouteDeployment({ ...stage.deployment, pricing_snapshot_ref: pricingSnapshotRef });
}

export function probeDeploymentForStage(stage: ResearchProviderKeyModelUseStagePlanV1, pricingSnapshotRef: string): ModelRouteDeployment {
  return decodeModelRouteDeployment({ ...stage.probe_deployment, pricing_snapshot_ref: pricingSnapshotRef });
}

/** Rebuild the saved model/profile/spend bundle only from the durable basis and exact new stage receipts. */
export async function buildResearchProviderKeyModelUseTarget(input: {
  readonly basis: ResearchProviderKeyModelUseBasisV1;
  readonly selections: readonly ResearchProjectModelSelection[];
  readonly pricing_snapshot_refs: ReadonlyMap<ResearchProviderKeyModelUseStage, string>;
}): Promise<ResearchProjectModelConfigurationBundle> {
  const semantic = parseResearchSemanticConfiguration(input.basis.vars.ELIOTR_RESEARCH_SEMANTIC_CONFIG_JSON);
  const deployments = new Map<ResearchProviderKeyModelUseStage, ModelRouteDeployment>();
  for (const stage of input.basis.stages) {
    const pricing = input.pricing_snapshot_refs.get(stage.stage);
    if (pricing === undefined) fail(`${stage.stage} has no exact immutable free-price snapshot`);
    deployments.set(stage.stage, deploymentForStage(stage, pricing));
  }
  const synthDeployment = deployments.get("SYNTHESIZE");
  if (synthDeployment === undefined) fail("Required synthesis deployment is missing");
  let profileRaw: unknown;
  try { profileRaw = JSON.parse(input.basis.vars.ELIOTR_MODEL_PROFILE_DEFINITION_JSON) as unknown; }
  catch (cause) { return fail("Installed model profile cannot be rebuilt", cause); }
  const profile = exactPlain(profileRaw, "Installed model profile");
  let rebuiltProfile: unknown;
  if (profile.schema === "eliotr.research.model-profile-definition.v2") {
    const verified = await readOwnerModelProfileTemplateV2(profile, input.basis.vars.ELIOTR_MODEL_PROFILE_PROVENANCE_REF);
    rebuiltProfile = await createOwnerModelProfileTemplateV2({
      config_provenance_ref: verified.config_provenance_ref,
      model_profile_ref: verified.model_profile_ref,
      ...(verified.expires_at === undefined ? {} : { expires_at: verified.expires_at }),
      max_context_bytes: verified.max_context_bytes,
      deployment: synthDeployment,
      policy: verified.policy,
    });
  } else if (profile.schema === "eliotr.research.model-profile-definition.v1") {
    rebuiltProfile = await createModelProfileDefinition({
      config_provenance_ref: input.basis.vars.ELIOTR_MODEL_PROFILE_PROVENANCE_REF,
      model_profile_ref: profile.model_profile_ref as string,
      expires_at: profile.expires_at as string,
      max_context_bytes: profile.max_context_bytes as number,
      deployment: synthDeployment,
      policy: profile.policy as Parameters<typeof createModelProfileDefinition>[0]["policy"],
    });
  } else fail("Installed model profile protocol is unsupported");

  let spend: ResearchOwnerSpendPolicyTemplate;
  try { spend = readResearchOwnerSpendPolicyTemplate(input.basis.vars.ELIOTR_MODEL_SPEND_POLICY_JSON, input.basis.vars.ELIOTR_MODEL_SPEND_POLICY_PROVENANCE_REF); }
  catch (cause) { return fail("Installed owner spend policy cannot be rebuilt", cause); }
  const rules = spend.rules.map((rule) => {
    const deployment = deployments.get(rule.stage as ResearchProviderKeyModelUseStage);
    if (deployment === undefined) fail(`${rule.stage} trusted spend deployment has no native receipt`);
    return Object.freeze({ ...rule, deployment });
  });
  const rebuiltSpend = Object.freeze({ ...spend, rules: Object.freeze(rules) });
  const selections = [...input.selections].sort((left, right) => left.stage.localeCompare(right.stage));
  const result = Object.freeze({
    protocol: "eliotr.research-project-model-configuration.v1" as const,
    semantic_revision: input.basis.semantic_revision,
    model_selections: Object.freeze(selections),
    vars: Object.freeze({
      ...input.basis.vars,
      ELIOTR_MODEL_PROFILE_DEFINITION_JSON: canonicalModelGatewayJson(rebuiltProfile),
      ELIOTR_MODEL_SPEND_POLICY_JSON: canonicalModelGatewayJson(rebuiltSpend),
    }),
  });
  try { await decodeResearchProjectModelConfigurationBundle(result); }
  catch (cause) { return fail("Server-generated native project configuration failed strict bundle validation", cause); }
  void semantic;
  return result;
}
