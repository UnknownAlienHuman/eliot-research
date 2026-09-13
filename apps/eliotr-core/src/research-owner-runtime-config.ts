import { canonicalJson } from "@eliotr/platform-cloudflare";
import { modelGatewayRequestParametersSha256 } from "@eliotr/cloudflare-ai";
import {
  createModelProfileDefinition,
  createResearchReportConfigSource,
  readResearchOwnerSpendPolicyTemplate,
  readResearchModelSpendPolicy,
  type ModelProfileDefinitionInput,
  type ResearchArtifactReportPolicy,
  type ResearchModelSpendPolicy,
  type ResearchOwnerSpendPolicyTemplate,
  type ResearchReportAdmissionPolicy,
} from "@eliotr/cloudflare-research";
import {
  createResearchOwnerSemanticConfiguration,
  type ResearchOwnerReasoningEffort,
  type ResearchOwnerSemanticConfigurationInput,
} from "./research-owner-semantic-config.js";
import {
  RESEARCH_OWNER_REPORT_ADMISSION_TEMPLATE_PROTOCOL,
  readResearchOwnerReportArtifactPolicy,
  readResearchOwnerReportAdmissionTemplate,
  type ResearchOwnerReportAdmissionTemplate,
} from "./research-owner-report-policy.js";
import { RESEARCH_OWNER_MODEL_PROFILE } from "./research-owner-profile.js";

type ResearchOwnerDeploymentInput = Omit<ModelProfileDefinitionInput["deployment"], "parameters_digest"> & {
  readonly parameters_digest?: string;
};

export type ResearchOwnerModelProfileDefinitionInput = Omit<ModelProfileDefinitionInput, "deployment"> & {
  readonly deployment: ResearchOwnerDeploymentInput;
};

type ResearchOwnerSpendRuleInput = Omit<ResearchModelSpendPolicy["rules"][number], "deployment"> & {
  readonly deployment: ResearchOwnerDeploymentInput;
};

type ResearchOwnerLegacySpendPolicyInput = Omit<ResearchModelSpendPolicy, "rules"> & {
  readonly rules: readonly ResearchOwnerSpendRuleInput[];
};

/**
 * Operator-owned spend intent. Runtime binds the omitted credential and policy
 * authority generations from the authenticated owner and current D1 state.
 */
export interface ResearchOwnerSpendPolicyTemplateInput {
  readonly protocol: "eliotr.research-owner-spend-template.v1";
  readonly approved: true;
  readonly policy_ref: ResearchModelSpendPolicy["policy_ref"];
  readonly config_provenance_ref: ResearchModelSpendPolicy["config_provenance_ref"];
  readonly principal_ref: ResearchModelSpendPolicy["principal_ref"];
  readonly client_class: ResearchModelSpendPolicy["client_class"];
  readonly deployment_generation: ResearchModelSpendPolicy["deployment_generation"];
  readonly expires_at: ResearchModelSpendPolicy["expires_at"];
  readonly rules: readonly ResearchOwnerSpendRuleInput[];
}

export type ResearchOwnerSpendPolicyInput =
  | ResearchOwnerLegacySpendPolicyInput
  | ResearchOwnerSpendPolicyTemplateInput;

export interface ResearchOwnerRuntimeConfigurationInput {
  readonly protocol: "eliotr.research-owner-setup.v1";
  readonly semantic: ResearchOwnerSemanticConfigurationInput;
  readonly model_profile: ResearchOwnerModelProfileDefinitionInput;
  readonly spend_policy: ResearchOwnerSpendPolicyInput;
  readonly report: {
    readonly admission_policy: ResearchReportAdmissionPolicy | ResearchOwnerReportAdmissionTemplate;
    readonly artifact_policy: ResearchArtifactReportPolicy;
  };
}

export interface ResearchOwnerRuntimeConfiguration {
  readonly protocol: "eliotr.research-runtime.v1";
  readonly vars: Readonly<Record<string, string>>;
}

function invalid(message: string): never {
  throw new Error(`Research owner setup is invalid: ${message}`);
}

async function semanticParametersDigest(
  routeRef: string,
  configured: {
    readonly trusted_parameters: {
      readonly max_tokens: number;
      readonly reasoning_effort?: ResearchOwnerReasoningEffort;
      readonly response_format?: unknown;
    };
  },
): Promise<string> {
  return modelGatewayRequestParametersSha256({
    model: routeRef,
    messages: [],
    max_tokens: configured.trusted_parameters.max_tokens,
    ...(configured.trusted_parameters.reasoning_effort === undefined ? {} : {
      reasoning_effort: configured.trusted_parameters.reasoning_effort,
    }),
    ...(configured.trusted_parameters.response_format === undefined ? {} : {
      response_format: configured.trusted_parameters.response_format,
    }),
    stream: false,
  });
}

function fillParametersDigest(
  deployment: ResearchOwnerDeploymentInput,
  expected: string,
  label: string,
): ModelProfileDefinitionInput["deployment"] {
  if (deployment.parameters_digest !== undefined && deployment.parameters_digest !== expected) {
    invalid(`${label} parameters differ from the configured prompt`);
  }
  return Object.freeze({ ...deployment, parameters_digest: expected });
}

/**
 * Compile explicit operator decisions into the seven installed Worker values.
 * This does not authorize a call, install a route, or assert live qualification.
 */
export async function createResearchOwnerRuntimeConfiguration(
  input: ResearchOwnerRuntimeConfigurationInput,
): Promise<ResearchOwnerRuntimeConfiguration> {
  if (input?.protocol !== "eliotr.research-owner-setup.v1" ||
      Object.keys(input).sort().join(",") !== "model_profile,protocol,report,semantic,spend_policy") {
    invalid("unsupported setup document");
  }
  const semantic = createResearchOwnerSemanticConfiguration(input.semantic);
  const synthesisParametersDigest = await semanticParametersDigest(
    input.model_profile.deployment.route_ref,
    semantic.synthesis,
  );
  const profile = await createModelProfileDefinition({
    ...input.model_profile,
    deployment: fillParametersDigest(
      input.model_profile.deployment,
      synthesisParametersDigest,
      "SYNTHESIZE deployment",
    ),
  });
  if (profile.model_profile_ref !== RESEARCH_OWNER_MODEL_PROFILE) {
    invalid(`owner research requires profile ${RESEARCH_OWNER_MODEL_PROFILE}`);
  }
  const spendRules: Array<ResearchModelSpendPolicy["rules"][number]> = [];
  for (const rule of input.spend_policy.rules) {
    const configured = rule.stage === "SYNTHESIZE" ? semantic.synthesis : semantic.audit;
    const parametersDigest = await semanticParametersDigest(rule.deployment.route_ref, configured);
    spendRules.push({
      ...rule,
      deployment: fillParametersDigest(rule.deployment, parametersDigest, `${rule.stage} deployment`),
    });
  }
  const spendJson = canonicalJson({ ...input.spend_policy, rules: spendRules });
  const spend: ResearchModelSpendPolicy | ResearchOwnerSpendPolicyTemplate = input.spend_policy.protocol === "eliotr.research-owner-spend-template.v1"
    ? readResearchOwnerSpendPolicyTemplate(spendJson, input.spend_policy.config_provenance_ref)
    : readResearchModelSpendPolicy(spendJson, input.spend_policy.config_provenance_ref);
  const reportJson = canonicalJson({ schema: "eliotr.research.report-config.v1", ...input.report });
  const reportIsTemplate = "protocol" in input.report.admission_policy &&
    input.report.admission_policy.protocol === RESEARCH_OWNER_REPORT_ADMISSION_TEMPLATE_PROTOCOL;
  let admission: ResearchReportAdmissionPolicy | ResearchOwnerReportAdmissionTemplate | null;
  let artifact: ResearchArtifactReportPolicy | null;
  if (reportIsTemplate) {
    admission = readResearchOwnerReportAdmissionTemplate(
      input.report.admission_policy,
      input.report.admission_policy.config_provenance_ref,
    );
    artifact = readResearchOwnerReportArtifactPolicy(input.report.artifact_policy);
  } else {
    const report = createResearchReportConfigSource({
      raw: reportJson, provenance_ref: input.report.admission_policy.config_provenance_ref,
    });
    admission = await report.read();
    artifact = await report.readArtifactPolicy();
  }
  if (!admission || !artifact) invalid("report policy is missing");
  const spendIsTemplate = spend.protocol === "eliotr.research-owner-spend-template.v1";
  const authorityMatches = reportIsTemplate || spendIsTemplate ||
    ((admission as ResearchReportAdmissionPolicy).policy_generation === spend.policy_generation &&
      (admission as ResearchReportAdmissionPolicy).policy_authority_ref === spend.policy_authority_ref);
  if (admission.principal_ref !== spend.principal_ref || admission.client_class !== spend.client_class ||
      !authorityMatches) {
    invalid("report and model spend must belong to the same owner and policy");
  }
  const reportTemplate = reportIsTemplate ? admission as ResearchOwnerReportAdmissionTemplate : undefined;
  if (reportTemplate !== undefined && reportTemplate.deployment_generation !== spend.deployment_generation) {
    invalid("report template and model deployment differ");
  }
  const synthesis = spend.rules.find((rule) => rule.stage === "SYNTHESIZE");
  if (!synthesis || canonicalJson(synthesis.deployment) !== canonicalJson(profile.deployment)) {
    invalid("model profile and synthesis spend route differ");
  }
  if (!profile.policy.allowed_use.includes("research") || !admission.allowed_use.includes("research") ||
      profile.policy.disclosure_ceiling !== admission.disclosure_ceiling) {
    invalid("report and model profile must permit the same research disclosure");
  }
  if (!profile.policy.allowed_verifier_refs.includes(semantic.audit.verifier_ref)) {
    invalid("model profile does not permit the selected verifier");
  }
  if (Date.parse(spend.expires_at) > Date.parse(profile.expires_at) ||
      Date.parse(admission.expires_at) > Date.parse(profile.expires_at)) {
    invalid("spend or report policy outlives the model profile");
  }
  if (Math.min(Date.parse(profile.expires_at), Date.parse(spend.expires_at), Date.parse(admission.expires_at)) <= Date.now()) {
    invalid("model, spend, or report policy has already expired");
  }
  const vars = {
    ELIOTR_RESEARCH_SEMANTIC_CONFIG_JSON: canonicalJson(semantic),
    ELIOTR_MODEL_PROFILE_DEFINITION_JSON: canonicalJson(profile),
    ELIOTR_MODEL_PROFILE_PROVENANCE_REF: profile.config_provenance_ref,
    ELIOTR_MODEL_SPEND_POLICY_JSON: canonicalJson(spend),
    ELIOTR_MODEL_SPEND_POLICY_PROVENANCE_REF: spend.config_provenance_ref,
    ELIOTR_RESEARCH_REPORT_CONFIG_JSON: reportJson,
    ELIOTR_RESEARCH_REPORT_POLICY_PROVENANCE_REF: admission.config_provenance_ref,
  };
  for (const [key, value] of Object.entries(vars)) {
    if (new TextEncoder().encode(value).byteLength > 65_536) invalid(`${key} exceeds the Worker configuration limit`);
  }
  return Object.freeze({ protocol: "eliotr.research-runtime.v1", vars: Object.freeze(vars) });
}
