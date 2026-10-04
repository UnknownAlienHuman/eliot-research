import {
  canonicalModelGatewayJson,
  modelGatewayRequestParametersSha256,
  modelGatewaySha256,
  normalizeModelGatewayReasoningEffort,
  validateModelGatewayTransportPolicy,
  type ModelGatewayRequestCapabilitiesV1,
} from "@eliotr/cloudflare-ai";
import {
  canonicalJson,
  decodeModelRouteDeployment,
  type ModelRouteDeployment,
} from "@eliotr/platform-cloudflare";
import {
  createD1DynamicRouteQualificationProofStore,
  createD1ModelGatewayDeploymentRegistry,
  createD1ResearchModelQualificationObservationStore,
  createModelProfileDefinition,
  decodeResearchProjectModelConfigurationBundle,
  readResearchOwnerSpendPolicyTemplate,
  readOwnerModelProfileTemplateV2,
  type ModelProfileDefinition,
  type OwnerModelProfileTemplateV2,
  type PinnedModelSelection,
  type ResearchOwnerSpendPolicyTemplate,
  type ResearchProjectModelConfigurationBundle,
  type ResearchProjectModelSelection,
} from "@eliotr/cloudflare-research";
import { selectResearchOwnerPrompt } from "@eliotr/cloudflare-research-stages";
import { parseResearchSemanticConfiguration } from "./research-semantic-server.js";
import {
  readResearchOwnerReportAdmissionTemplate,
  readResearchOwnerReportArtifactPolicy,
  RESEARCH_OWNER_REPORT_ADMISSION_TEMPLATE_PROTOCOL,
  RESEARCH_OWNER_REPORT_ADMISSION_TEMPLATE_V2_PROTOCOL,
} from "./research-owner-report-policy.js";
import { RESEARCH_OWNER_MODEL_PROFILE } from "./research-owner-profile.js";

const REASONING_EFFORT = new Set(["low", "medium", "high", "max"]);

export class ResearchProjectModelConfigurationAuthorityError extends Error {
  public constructor(
    public readonly code: string,
    message: string,
    public readonly status: number,
    public readonly retryable = false,
    cause?: unknown,
  ) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "ResearchProjectModelConfigurationAuthorityError";
  }
}

export function fail(code: string, status: number, message: string, cause?: unknown): never {
  throw new ResearchProjectModelConfigurationAuthorityError(code, message, status, false, cause);
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail("RESEARCH_PROJECT_MODEL_CONFIGURATION_INPUT_INVALID", 400, `${label} is invalid`);
  }
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[], label: string): void {
  const actual = Object.keys(value);
  if (actual.length !== expected.length || actual.some((key) => !expected.includes(key))) {
    fail("RESEARCH_PROJECT_MODEL_CONFIGURATION_INPUT_INVALID", 400, `${label} contains missing or unsupported fields`);
  }
}

function same(left: unknown, right: unknown): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

function sameOptional(left: unknown, right: unknown): boolean {
  return left === undefined || right === undefined ? left === right : same(left, right);
}

function qualificationRequired(message: string, cause?: unknown): never {
  fail("RESEARCH_MODEL_CONFIGURATION_QUALIFICATION_REQUIRED", 409, message, cause);
}

async function decodeProfile(
  raw: string,
  provenanceRef: string,
): Promise<ModelProfileDefinition | OwnerModelProfileTemplateV2> {
  let value: unknown;
  try { value = JSON.parse(raw) as unknown; }
  catch (cause) { fail("RESEARCH_PROJECT_MODEL_CONFIGURATION_INPUT_INVALID", 400, "model profile JSON is invalid", cause); }
  const record = object(value, "model profile");
  if (record.config_provenance_ref !== provenanceRef) {
    fail("RESEARCH_PROJECT_MODEL_CONFIGURATION_INPUT_INVALID", 400, "model profile provenance does not match its stored reference");
  }
  if (record.schema === "eliotr.research.model-profile-definition.v2") {
    return readOwnerModelProfileTemplateV2(record, provenanceRef);
  }
  exactKeys(record, ["schema", "config_provenance_ref", "model_profile_ref", "expires_at", "max_context_bytes",
    "deployment", "policy", "definition_ref", "definition_sha256"], "model profile");
  if (record.schema !== "eliotr.research.model-profile-definition.v1") {
    fail("RESEARCH_PROJECT_MODEL_CONFIGURATION_INPUT_INVALID", 400, "model profile protocol is unsupported");
  }
  const decoded = await createModelProfileDefinition({
    config_provenance_ref: provenanceRef,
    model_profile_ref: record.model_profile_ref as string,
    expires_at: record.expires_at as string,
    max_context_bytes: record.max_context_bytes as number,
    deployment: record.deployment as ModelRouteDeployment,
    policy: record.policy as ModelProfileDefinition["policy"],
  });
  if (decoded.definition_sha256 !== record.definition_sha256 || !same(decoded.definition_ref, record.definition_ref)) {
    fail("RESEARCH_PROJECT_MODEL_CONFIGURATION_INPUT_INVALID", 400, "model profile digest does not match its canonical bytes");
  }
  return decoded;
}

function decodeReport(raw: string, provenanceRef: string) {
  let value: unknown;
  try { value = JSON.parse(raw) as unknown; }
  catch (cause) { fail("RESEARCH_PROJECT_MODEL_CONFIGURATION_INPUT_INVALID", 400, "report configuration JSON is invalid", cause); }
  const report = object(value, "report configuration");
  exactKeys(report, ["schema", "admission_policy", "artifact_policy"], "report configuration");
  if (report.schema !== "eliotr.research.report-config.v1") {
    fail("RESEARCH_PROJECT_MODEL_CONFIGURATION_INPUT_INVALID", 400, "report configuration protocol is unsupported");
  }
  let admission: ReturnType<typeof readResearchOwnerReportAdmissionTemplate>;
  let artifact: ReturnType<typeof readResearchOwnerReportArtifactPolicy>;
  try {
    admission = readResearchOwnerReportAdmissionTemplate(report.admission_policy, provenanceRef);
    artifact = readResearchOwnerReportArtifactPolicy(report.artifact_policy);
  } catch (cause) {
    if (cause instanceof ResearchProjectModelConfigurationAuthorityError) throw cause;
    fail("RESEARCH_PROJECT_MODEL_CONFIGURATION_INPUT_INVALID", 400, "report admission or artifact policy is invalid", cause);
  }
  return { admission, artifact };
}

function parseSpend(raw: string, provenanceRef: string): ResearchOwnerSpendPolicyTemplate {
  let protocol: unknown;
  try {
    const value: unknown = JSON.parse(raw);
    protocol = object(value, "spend policy").protocol;
  } catch (cause) {
    if (cause instanceof ResearchProjectModelConfigurationAuthorityError) throw cause;
    fail("RESEARCH_PROJECT_MODEL_CONFIGURATION_INPUT_INVALID", 400, "spend policy JSON is invalid", cause);
  }
  if (protocol === "eliotr.research-owner-spend-template.v1" || protocol === "eliotr.research-owner-spend-template.v2") {
    try {
      return readResearchOwnerSpendPolicyTemplate(raw, provenanceRef);
    } catch (cause) {
      if (cause instanceof ResearchProjectModelConfigurationAuthorityError) throw cause;
      fail("RESEARCH_PROJECT_MODEL_CONFIGURATION_INPUT_INVALID", 400, "owner spend-policy template is invalid", cause);
    }
  }
  // A project snapshot must carry operator-owned, stable spend intent, never
  // a previously bound per-deployment policy or a catalog-derived price.
  fail("RESEARCH_PROJECT_MODEL_CONFIGURATION_INPUT_INVALID", 400,
    "project configuration requires an explicit owner spend-policy template");
}

function templateVersion(
  profile: ModelProfileDefinition | OwnerModelProfileTemplateV2,
  spend: ResearchOwnerSpendPolicyTemplate,
  report: ReturnType<typeof decodeReport>["admission"],
): "v1" | "v2" {
  const profileV2 = profile.schema === "eliotr.research.model-profile-definition.v2";
  const spendV2 = spend.protocol === "eliotr.research-owner-spend-template.v2";
  const reportV2 = report.protocol === RESEARCH_OWNER_REPORT_ADMISSION_TEMPLATE_V2_PROTOCOL;
  const reportV1 = report.protocol === RESEARCH_OWNER_REPORT_ADMISSION_TEMPLATE_PROTOCOL;
  if (profileV2 !== spendV2 || profileV2 !== reportV2 || (!reportV1 && !reportV2)) {
    fail("RESEARCH_PROJECT_MODEL_CONFIGURATION_INPUT_INVALID", 400,
      "model, spend, and report settings must use one owner-template revision protocol");
  }
  return profileV2 ? "v2" : "v1";
}

export function selectedEffort(
  semantic: ReturnType<typeof parseResearchSemanticConfiguration>,
  stage: string,
  capabilities?: ModelGatewayRequestCapabilitiesV1,
): "low" | "medium" | "high" | "max" | null {
  const parameters = stage === "SYNTHESIZE" ? semantic.synthesis.trusted_parameters
    : stage === "AUDIT_CLAIMS" ? semantic.audit.trusted_parameters
      : semantic.roles?.trusted_parameters;
  const value = parameters?.reasoning_effort;
  if (typeof value !== "string" || !REASONING_EFFORT.has(value)) return null;
  if (capabilities === undefined) return value as "low" | "medium" | "high" | "max";
  try { return normalizeModelGatewayReasoningEffort(value, capabilities); }
  catch { return null; }
}

async function validateOwnerPromptBinding(
  semantic: ReturnType<typeof parseResearchSemanticConfiguration>,
  stage: "SYNTHESIZE" | "AUDIT_CLAIMS",
  deployment: ModelRouteDeployment,
  transportPolicy: ResearchProjectModelSelection["transport_policy"],
): Promise<void> {
  const configured = stage === "SYNTHESIZE" ? semantic.synthesis : semantic.audit;
  let promptMatch: ReturnType<typeof selectResearchOwnerPrompt> | undefined;
  for (const format of ["prompt_json", "json_schema"] as const) {
    const prompt = selectResearchOwnerPrompt(stage, format);
    if (prompt.prompt === configured.trusted_parameters.prompt &&
        sameOptional(prompt.response_format, configured.trusted_parameters.response_format)) {
      promptMatch = prompt;
      break;
    }
  }
  if (promptMatch === undefined) {
    fail("RESEARCH_PROJECT_MODEL_CONFIGURATION_INPUT_INVALID", 400,
      `${stage} prompt/schema bytes do not match a supported immutable prompt bundle`);
  }
  const p = configured.trusted_parameters;
  const params = {
    model: deployment.route_ref,
    messages: [],
    [transportPolicy.capabilities.max_output_tokens_field]: p.max_tokens,
    ...(p.reasoning_effort === undefined ? {} : { reasoning_effort: p.reasoning_effort }),
    ...(p.response_format === undefined ? {} : { response_format: p.response_format }),
    stream: false,
  };
  const [parameterSha, promptSha, schemaSha] = await Promise.all([
    modelGatewayRequestParametersSha256(params, transportPolicy.capabilities, transportPolicy.api),
    modelGatewaySha256(canonicalModelGatewayJson({ content_kind: "eliotr.research.owner-prompt.v1", prompt: promptMatch.prompt })),
    modelGatewaySha256(canonicalModelGatewayJson({ content_kind: "eliotr.research.owner-output-schema.v1", output_schema: promptMatch.output_schema })),
  ]);
  if (deployment.parameters_digest !== parameterSha ||
      deployment.prompt_generation !== `eliotr.research.owner-prompt-${promptSha}` ||
      deployment.schema_generation !== `eliotr.research.owner-schema-${schemaSha}`) {
    fail("RESEARCH_PROJECT_MODEL_CONFIGURATION_INPUT_INVALID", 400,
      `${stage} deployment does not match the saved prompt, schema, and request parameters`);
  }
}

export interface ConfigurationValidation {
  readonly bundle: ResearchProjectModelConfigurationBundle;
  readonly semantic: ReturnType<typeof parseResearchSemanticConfiguration>;
  readonly profile: ModelProfileDefinition | OwnerModelProfileTemplateV2;
  readonly spend: ResearchOwnerSpendPolicyTemplate;
  readonly report: ReturnType<typeof decodeReport>;
  readonly version: "v1" | "v2";
}

export function createResearchProjectModelConfigurationValidator(options: {
  readonly database: D1Database;
  readonly deployment_environment?: "TEST" | "PRODUCTION";
  readonly deployment_generation?: string;
  readonly now?: () => number;
}): (raw: unknown, expectedOwner: string, project: string) => Promise<ConfigurationValidation> {
  const now = options.now ?? (() => Date.now());
  const environment = options.deployment_environment ?? "PRODUCTION";
  const deployments = createD1ModelGatewayDeploymentRegistry(options.database, { environment });
  const proofs = createD1DynamicRouteQualificationProofStore(options.database);
  const qualificationObservations = createD1ResearchModelQualificationObservationStore(options.database);

  async function validateConfiguration(
    raw: unknown,
    expectedOwner: string,
    project: string,
  ): Promise<ConfigurationValidation> {
    const storeDecoded = await decodeResearchProjectModelConfigurationBundle(raw);
    const bundle = storeDecoded.bundle;
    const vars = bundle.vars;
    let semantic: ReturnType<typeof parseResearchSemanticConfiguration>;
    try { semantic = parseResearchSemanticConfiguration(vars.ELIOTR_RESEARCH_SEMANTIC_CONFIG_JSON); }
    catch (cause) { fail("RESEARCH_PROJECT_MODEL_CONFIGURATION_INPUT_INVALID", 400, "semantic configuration is invalid", cause); }
    const profile = await decodeProfile(vars.ELIOTR_MODEL_PROFILE_DEFINITION_JSON,
      vars.ELIOTR_MODEL_PROFILE_PROVENANCE_REF).catch((cause: unknown) => {
        if (cause instanceof ResearchProjectModelConfigurationAuthorityError) throw cause;
        fail("RESEARCH_PROJECT_MODEL_CONFIGURATION_INPUT_INVALID", 400, "model profile is invalid", cause);
      });
    const spend = parseSpend(vars.ELIOTR_MODEL_SPEND_POLICY_JSON, vars.ELIOTR_MODEL_SPEND_POLICY_PROVENANCE_REF);
    const report = decodeReport(vars.ELIOTR_RESEARCH_REPORT_CONFIG_JSON,
      vars.ELIOTR_RESEARCH_REPORT_POLICY_PROVENANCE_REF);
    const version = templateVersion(profile, spend, report.admission);
    if (profile.config_provenance_ref !== vars.ELIOTR_MODEL_PROFILE_PROVENANCE_REF ||
        spend.config_provenance_ref !== vars.ELIOTR_MODEL_SPEND_POLICY_PROVENANCE_REF ||
        report.admission.config_provenance_ref !== vars.ELIOTR_RESEARCH_REPORT_POLICY_PROVENANCE_REF ||
        profile.model_profile_ref !== RESEARCH_OWNER_MODEL_PROFILE ||
        profile.policy.allowed_use.indexOf("research") < 0 ||
        !profile.policy.allowed_verifier_refs.includes(semantic.audit.verifier_ref) ||
        profile.policy.disclosure_ceiling !== report.admission.disclosure_ceiling) {
      fail("RESEARCH_PROJECT_MODEL_CONFIGURATION_INPUT_INVALID", 400,
        "model profile, semantic verifier, spend, and report settings do not agree");
    }
    if (spend.client_class !== "owner_pwa" || report.admission.client_class !== "owner_pwa" ||
        spend.principal_ref !== expectedOwner || report.admission.principal_ref !== expectedOwner) {
      fail("RESEARCH_PROJECT_MODEL_CONFIGURATION_AUTHORITY_STALE", 409,
        "Saved project configuration belongs to another owner or client class");
    }
    const expires = [
      "expires_at" in profile && typeof profile.expires_at === "string" ? Date.parse(profile.expires_at) : Number.POSITIVE_INFINITY,
      "expires_at" in spend && typeof spend.expires_at === "string" ? Date.parse(spend.expires_at) : Number.POSITIVE_INFINITY,
      "expires_at" in report.admission && typeof report.admission.expires_at === "string" ? Date.parse(report.admission.expires_at) : Number.POSITIVE_INFINITY,
    ];
    if (expires.some((at) => Number.isFinite(at) && at <= now())) {
      fail("RESEARCH_PROJECT_MODEL_CONFIGURATION_AUTHORITY_STALE", 409, "Saved owner model or report setting has expired");
    }
    if (version === "v1") {
      // The protocol discriminator above narrows these legacy fields. V2 is
      // intentionally generation-free and uses live scope/grant authority.
      if (spend.protocol !== "eliotr.research-owner-spend-template.v1" ||
          report.admission.protocol !== RESEARCH_OWNER_REPORT_ADMISSION_TEMPLATE_PROTOCOL ||
          profile.schema !== "eliotr.research.model-profile-definition.v1") {
        fail("RESEARCH_PROJECT_MODEL_CONFIGURATION_INPUT_INVALID", 400, "legacy owner settings are inconsistent");
      }
      if (spend.deployment_generation !== report.admission.deployment_generation ||
          (options.deployment_generation !== undefined && spend.deployment_generation !== options.deployment_generation)) {
        fail("RESEARCH_PROJECT_MODEL_CONFIGURATION_AUTHORITY_STALE", 409,
          "Legacy owner model settings are bound to another deployment generation");
      }
      if (Date.parse(spend.expires_at) > Date.parse(profile.expires_at) ||
          Date.parse(report.admission.expires_at) > Date.parse(profile.expires_at)) {
        fail("RESEARCH_PROJECT_MODEL_CONFIGURATION_AUTHORITY_STALE", 409,
          "Legacy spend and report settings cannot outlive the model profile");
      }
    }
    const synthRule = spend.rules.find((rule) => rule.stage === "SYNTHESIZE");
    if (synthRule === undefined || !same(synthRule.deployment, profile.deployment)) {
      fail("RESEARCH_PROJECT_MODEL_CONFIGURATION_INPUT_INVALID", 400,
        "Model profile deployment must equal the SYNTHESIZE spend deployment");
    }
    const semanticSha = await modelGatewaySha256(vars.ELIOTR_RESEARCH_SEMANTIC_CONFIG_JSON);
    if (semanticSha !== bundle.semantic_revision.config_sha256 ||
        bundle.semantic_revision.revision_ref !== `scr-${semanticSha.slice(0, 12)}`) {
      fail("RESEARCH_PROJECT_MODEL_CONFIGURATION_INPUT_INVALID", 400,
        "Semantic revision reference does not match the exact saved semantic bytes");
    }
    if (spend.rules.length !== bundle.model_selections.length) {
      fail("RESEARCH_PROJECT_MODEL_CONFIGURATION_QUALIFICATION_REQUIRED", 409,
        "Every spend stage needs one exact saved qualified model selection");
    }
    const byStage = new Map(bundle.model_selections.map((selection) => [selection.stage, selection]));
    const spendStages = new Set<string>(spend.rules.map((rule) => rule.stage));
    if (spendStages.size !== spend.rules.length || spend.rules.some((rule) => !byStage.has(rule.stage)) ||
        bundle.model_selections.some((selection) => !spendStages.has(selection.stage))) {
      fail("RESEARCH_PROJECT_MODEL_CONFIGURATION_QUALIFICATION_REQUIRED", 409,
        "Saved model selections must cover the exact spend-policy stages once each");
    }
    for (const rule of spend.rules) {
      const selection = byStage.get(rule.stage);
      if (selection === undefined || selection.route_ref !== rule.deployment.route_ref ||
          selection.route_version !== rule.deployment.route_version) {
        fail("RESEARCH_PROJECT_MODEL_CONFIGURATION_QUALIFICATION_REQUIRED", 409,
          `${rule.stage} has no model selection for its exact spend deployment`);
      }
      let transport;
      try { transport = validateModelGatewayTransportPolicy(selection.transport_policy); }
      catch (cause) { qualificationRequired(`${rule.stage} transport policy is invalid`, cause); }
      if (selection.stage === "SYNTHESIZE" || selection.stage === "AUDIT_CLAIMS") {
        await validateOwnerPromptBinding(semantic, selection.stage, rule.deployment, transport);
      } else {
        const configured = semantic.roles?.trusted_parameters ?? semantic.audit.trusted_parameters;
        if (configured.reasoning_effort !== undefined) {
          try { normalizeModelGatewayReasoningEffort(configured.reasoning_effort, transport.capabilities); }
          catch (cause) { qualificationRequired(`${rule.stage} selected reasoning effort is outside the saved transport capabilities`, cause); }
        }
        const paramSha = await modelGatewayRequestParametersSha256({
          model: rule.deployment.route_ref,
          messages: [],
          [transport.capabilities.max_output_tokens_field]: configured.max_tokens,
          ...(configured.reasoning_effort === undefined ? {} : { reasoning_effort: configured.reasoning_effort }),
          ...(configured.response_format === undefined ? {} : { response_format: configured.response_format }),
          stream: false,
        }, transport.capabilities, transport.api);
        if (rule.deployment.parameters_digest !== paramSha) {
          fail("RESEARCH_PROJECT_MODEL_CONFIGURATION_INPUT_INVALID", 400,
            `${rule.stage} deployment request parameters do not match the saved semantic policy`);
        }
      }
      if (selection.stage === "SYNTHESIZE" || selection.stage === "AUDIT_CLAIMS") {
        const configured = selection.stage === "SYNTHESIZE" ? semantic.synthesis.trusted_parameters
          : semantic.audit.trusted_parameters;
        if (configured.reasoning_effort !== undefined) {
          try { normalizeModelGatewayReasoningEffort(configured.reasoning_effort, transport.capabilities); }
          catch (cause) { qualificationRequired(`${rule.stage} selected reasoning effort is outside the saved transport capabilities`, cause); }
        }
      }
      const pinned: PinnedModelSelection = selection;
      try {
        const resolved = await deployments.resolvePinned(rule.deployment, pinned, {
          allow_expired_qualification: version === "v2",
        });
        if (resolved === null || !same(decodeModelRouteDeployment(resolved), rule.deployment)) {
          qualificationRequired(`${rule.stage} exact model candidate is not currently LIVE qualified`);
        }
        const proof = await proofs.readPinned({ ...pinned });
        if (proof === null) {
          qualificationRequired(`${rule.stage} exact LIVE qualification proof is missing`);
        }
        const qualification = object(proof?.qualification, "qualification proof");
        if (typeof qualification.execution_probe_ref !== "string") {
          qualificationRequired(`${rule.stage} qualification proof has no execution observation reference`);
        }
        const executionProbeRef = qualification.execution_probe_ref;
        const observationReceiptRaw = await qualificationObservations.read(executionProbeRef);
        if (observationReceiptRaw === null) {
          qualificationRequired(`${rule.stage} exact qualification observation is missing`);
        }
        const observationReceipt = object(observationReceiptRaw, "qualification observation receipt");
        if (observationReceipt.protocol !== "eliotr.dynamic-route-qualification-observation.v1" ||
            observationReceipt.execution_probe_ref !== executionProbeRef) {
          qualificationRequired(`${rule.stage} qualification observation receipt does not match its proof reference`);
        }
        const observation = object(observationReceipt.observation, "qualification observation");
        const fingerprint = object(observation.route_fingerprint, "qualification route fingerprint");
        if (qualification.tier !== "LIVE" || fingerprint.route_ref !== qualification.route_ref ||
            fingerprint.route_version !== qualification.route_version ||
            fingerprint.prompt_generation !== qualification.prompt_generation ||
            fingerprint.schema_generation !== qualification.schema_generation ||
            fingerprint.parameters_digest !== qualification.parameters_digest ||
            fingerprint.pricing_snapshot_ref !== qualification.pricing_snapshot_ref ||
            observation.verified_at !== qualification.verified_at || observation.expires_at !== qualification.expires_at ||
            fingerprint.provider !== transport.provider ||
            fingerprint.exact_model_id !== transport.model || observation.response_model !== transport.model) {
          qualificationRequired(`${rule.stage} provider/model does not match the exact LIVE qualification proof`);
        }
      } catch (cause) {
        if (cause instanceof ResearchProjectModelConfigurationAuthorityError) throw cause;
        qualificationRequired(`${rule.stage} exact LIVE qualification proof is missing, revoked, stale, or mismatched`, cause);
      }
    }
    // The canonical bundle itself is the content-addressed approved unit.
    // `project` is intentionally not put in the JSON: identical approved
    // runtime bytes can be imported into another explicitly owned project.
    void project;
    return { bundle, semantic, profile, spend, report, version };
  }

  return validateConfiguration;
}
