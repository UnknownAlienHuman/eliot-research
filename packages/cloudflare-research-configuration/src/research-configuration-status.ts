import { validateModelGatewayToken } from "@eliotr/cloudflare-ai";
import { IdentifierSchema, IsoDateTimeSchema } from "@eliotr/contracts";
import {
  createModelProfileBindingConfigSource,
  createResearchReportConfigSource,
  readResearchOwnerSpendPolicyTemplate,
  readResearchModelSpendPolicy,
} from "@eliotr/cloudflare-research";
import { parseResearchSemanticConfiguration } from "./research-semantic-configuration-schema.js";
import type { ResearchSemanticConfigSource } from "./research-semantic-config-revision.js";
import type { AuthenticatedRequestContext } from "@eliotr/interfaces";
import { parseResearchClaimAuditPolicy } from "@eliotr/cloudflare-research-stages";
import {
  RESEARCH_OWNER_REPORT_ADMISSION_TEMPLATE_PROTOCOL,
  RESEARCH_OWNER_REPORT_ADMISSION_TEMPLATE_V2_PROTOCOL,
  readResearchOwnerReportArtifactPolicy,
  readResearchOwnerReportAdmissionTemplate,
} from "./research-owner-report-policy.js";

const MAX_CONFIGURATION_BYTES = 65_536;
const RESEARCH_CONFIGURATION_PROTOCOL = "eliotr.research-configuration-status.v1" as const;

type RequiredField =
  | "ELIOTR_RESEARCH_SEMANTIC_CONFIG_REF"
  | "ELIOTR_RESEARCH_SEMANTIC_CONFIG_SHA256"
  | "ELIOTR_RESEARCH_SEMANTIC_CONFIG_JSON"
  | "ELIOTR_MODEL_PROFILE_DEFINITION_JSON"
  | "ELIOTR_MODEL_PROFILE_PROVENANCE_REF"
  | "ELIOTR_MODEL_SPEND_POLICY_JSON"
  | "ELIOTR_MODEL_SPEND_POLICY_PROVENANCE_REF"
  | "ELIOTR_RESEARCH_REPORT_CONFIG_JSON"
  | "ELIOTR_RESEARCH_REPORT_POLICY_PROVENANCE_REF";

type ConfigurationField = RequiredField | "ELIOTR_MODEL_GATEWAY_TOKEN";

/** Env-free values needed for a status projection; Core constructs this from its bindings. */
export interface ResearchConfigurationRuntimeValues {
  readonly configuration_fields: Readonly<Partial<Record<ConfigurationField, string | undefined>>>;
  readonly semantic_source: ResearchSemanticConfigSource | null;
  readonly semantic_configuration_json?: string;
  readonly semantic_json_chunks_present: boolean;
  readonly deployment_generation?: string;
  readonly native_model_gateway_available: boolean;
}

export interface ResearchConfigurationStatus {
  readonly protocol: typeof RESEARCH_CONFIGURATION_PROTOCOL;
  readonly configuration: "missing" | "present" | "invalid";
  readonly model_transport: "available" | "unavailable";
  readonly missing_fields: readonly string[];
  readonly invalid_fields: readonly string[];
  readonly checked_at: string;
}

function hasText(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

function withinConfigurationLimit(value: string): boolean {
  return new TextEncoder().encode(value).byteLength <= MAX_CONFIGURATION_BYTES;
}

function validProvenance(value: string): boolean {
  return IdentifierSchema.safeParse(value).success;
}

function validGatewayToken(value: string | undefined): boolean {
  if (!hasText(value)) return false;
  try { validateModelGatewayToken(value); return true; }
  catch { return false; }
}

function validSemanticConfiguration(value: string): boolean {
  if (!withinConfigurationLimit(value)) return false;
  try {
    const parsed = parseResearchSemanticConfiguration(value);
    if (!parsed.audit.allowed_verifier_refs.includes(parsed.audit.verifier_ref)) return false;
    parseResearchClaimAuditPolicy(parsed.audit.policy);
    return true;
  } catch {
    return false;
  }
}

function validJsonObject(value: string): boolean {
  if (!withinConfigurationLimit(value)) return false;
  try {
    const parsed: unknown = JSON.parse(value);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed);
  } catch {
    return false;
  }
}

function embeddedProvenance(value: string, report: boolean): string | undefined {
  try {
    const parsed: unknown = JSON.parse(value);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
    const record = parsed as Record<string, unknown>;
    const candidate = report ? record.admission_policy : record;
    if (typeof candidate !== "object" || candidate === null || Array.isArray(candidate)) return undefined;
    const provenance = (candidate as Record<string, unknown>).config_provenance_ref;
    return typeof provenance === "string" ? provenance : undefined;
  } catch {
    return undefined;
  }
}

function embeddedProtocol(value: string): string | undefined {
  try {
    const parsed: unknown = JSON.parse(value);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
    const protocol = (parsed as Record<string, unknown>).protocol;
    return typeof protocol === "string" ? protocol : undefined;
  } catch {
    return undefined;
  }
}

function embeddedAdmissionProtocol(value: string): string | undefined {
  try {
    const parsed: unknown = JSON.parse(value);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
    const admission = (parsed as Record<string, unknown>).admission_policy;
    if (typeof admission !== "object" || admission === null || Array.isArray(admission)) return undefined;
    const protocol = (admission as Record<string, unknown>).protocol;
    return typeof protocol === "string" ? protocol : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Reports installed configuration syntax, expiry, owner binding and transport presence. It does
 * not read D1/R2, contact a provider, or assert model qualification/readiness.
 */
export function readResearchConfigurationStatus(
  env: ResearchConfigurationRuntimeValues,
  owner?: Pick<AuthenticatedRequestContext, "principal_ref" | "credential_generation" | "client_class">,
): ResearchConfigurationStatus {
  const now = Date.now();
  const missing = new Set<string>();
  const invalid = new Set<string>();
  const read = (field: RequiredField): string | undefined => {
    const value = env.configuration_fields[field];
    if (!hasText(value)) {
      missing.add(field);
      return undefined;
    }
    return value;
  };

  // S29: the revision reference is the primary source; the legacy split JSON
  // remains accepted during the migration window. Mixing both, or a partial
  // revision identity, is invalid. Digest readback against D1 happens at
  // dispatch; this sync status check only validates identity shape.
  const semanticSource = env.semantic_source ?? undefined;
  if (semanticSource === undefined) {
    invalid.add("ELIOTR_RESEARCH_SEMANTIC_CONFIG_REF");
    invalid.add("ELIOTR_RESEARCH_SEMANTIC_CONFIG_SHA256");
  } else if (semanticSource.kind === "absent") {
    missing.add("ELIOTR_RESEARCH_SEMANTIC_CONFIG_REF");
  } else if (semanticSource.kind === "legacy") {
    const semantic = env.semantic_configuration_json;
    const semanticHasChunks = env.semantic_json_chunks_present;
    if (semantic === undefined) {
      if (env.configuration_fields.ELIOTR_RESEARCH_SEMANTIC_CONFIG_JSON === undefined && !semanticHasChunks) {
        missing.add("ELIOTR_RESEARCH_SEMANTIC_CONFIG_JSON");
      } else {
        invalid.add("ELIOTR_RESEARCH_SEMANTIC_CONFIG_JSON");
      }
    } else if (!hasText(semantic)) {
      (semanticHasChunks ? invalid : missing).add("ELIOTR_RESEARCH_SEMANTIC_CONFIG_JSON");
    } else if (!validSemanticConfiguration(semantic)) {
      invalid.add("ELIOTR_RESEARCH_SEMANTIC_CONFIG_JSON");
    }
  }
  const profile = read("ELIOTR_MODEL_PROFILE_DEFINITION_JSON");
  const profileProvenance = read("ELIOTR_MODEL_PROFILE_PROVENANCE_REF");
  const spend = read("ELIOTR_MODEL_SPEND_POLICY_JSON");
  const spendProvenance = read("ELIOTR_MODEL_SPEND_POLICY_PROVENANCE_REF");
  const report = read("ELIOTR_RESEARCH_REPORT_CONFIG_JSON");
  const reportProvenance = read("ELIOTR_RESEARCH_REPORT_POLICY_PROVENANCE_REF");

  const profileJsonValid = profile === undefined || validJsonObject(profile);
  const profileProvenanceValid = profileProvenance === undefined || validProvenance(profileProvenance);
  const profileEmbeddedProvenance = profile !== undefined && profileJsonValid ? embeddedProvenance(profile, false) : undefined;
  if (profile !== undefined && !profileJsonValid) invalid.add("ELIOTR_MODEL_PROFILE_DEFINITION_JSON");
  if (profileProvenance !== undefined && !profileProvenanceValid) invalid.add("ELIOTR_MODEL_PROFILE_PROVENANCE_REF");
  if (profile !== undefined && profileJsonValid) {
    if (profileEmbeddedProvenance === undefined ||
        (profileProvenance !== undefined && profileProvenanceValid && profileEmbeddedProvenance !== profileProvenance)) {
      invalid.add("ELIOTR_MODEL_PROFILE_DEFINITION_JSON");
    }
  }
  const profileParserProvenance = profileProvenance !== undefined && profileProvenanceValid
    ? profileProvenance : profileEmbeddedProvenance;
  if (profile !== undefined && profileJsonValid && profileParserProvenance !== undefined && validProvenance(profileParserProvenance)) {
    try {
      // The source checks the JSON envelope. Full definition digest validation
      // remains in the runtime profile producer.
      createModelProfileBindingConfigSource({ raw: profile, provenance_ref: profileParserProvenance });
      const definition = JSON.parse(profile) as { schema?: unknown; expires_at?: unknown };
      if (definition.schema === "eliotr.research.model-profile-definition.v2") {
        if (definition.expires_at !== undefined) {
          const expires = IsoDateTimeSchema.safeParse(definition.expires_at);
          if (!expires.success || Date.parse(expires.data) <= now) invalid.add("ELIOTR_MODEL_PROFILE_DEFINITION_JSON");
        }
      } else {
        const expires = IsoDateTimeSchema.safeParse(definition.expires_at);
        if (!expires.success || Date.parse(expires.data) <= now) invalid.add("ELIOTR_MODEL_PROFILE_DEFINITION_JSON");
      }
    } catch {
      invalid.add("ELIOTR_MODEL_PROFILE_DEFINITION_JSON");
    }
  }

  const spendJsonValid = spend === undefined || validJsonObject(spend);
  const spendProvenanceValid = spendProvenance === undefined || validProvenance(spendProvenance);
  if (spend !== undefined && !spendJsonValid) invalid.add("ELIOTR_MODEL_SPEND_POLICY_JSON");
  if (spendProvenance !== undefined && !spendProvenanceValid) invalid.add("ELIOTR_MODEL_SPEND_POLICY_PROVENANCE_REF");
  if (spend !== undefined && spendJsonValid) {
    const spendProtocol = embeddedProtocol(spend);
    const isTemplate = spendProtocol === "eliotr.research-owner-spend-template.v1" ||
      spendProtocol === "eliotr.research-owner-spend-template.v2";
    if (isTemplate) {
      // The template's companion provenance is required. Embedded provenance
      // remains a legacy-only parser fallback and never authorizes a template.
      if (spendProvenance === undefined) {
        missing.add("ELIOTR_MODEL_SPEND_POLICY_PROVENANCE_REF");
        invalid.add("ELIOTR_MODEL_SPEND_POLICY_JSON");
      } else if (spendProvenanceValid) {
        try {
          const template = readResearchOwnerSpendPolicyTemplate(spend, spendProvenance);
          const expiry = template.expires_at;
          if ((expiry !== undefined && Date.parse(expiry) <= now) ||
              (template.protocol === "eliotr.research-owner-spend-template.v1" &&
                template.deployment_generation !== env.deployment_generation) ||
              (owner !== undefined && (template.principal_ref !== owner.principal_ref ||
                template.client_class !== owner.client_class))) {
            invalid.add("ELIOTR_MODEL_SPEND_POLICY_JSON");
          }
        } catch {
          invalid.add("ELIOTR_MODEL_SPEND_POLICY_JSON");
        }
      } else {
        invalid.add("ELIOTR_MODEL_SPEND_POLICY_JSON");
      }
    } else {
      const parserProvenance = spendProvenance !== undefined && spendProvenanceValid
        ? spendProvenance : embeddedProvenance(spend, false);
      if (parserProvenance === undefined || !validProvenance(parserProvenance)) {
        if (spendProvenance === undefined) missing.add("ELIOTR_MODEL_SPEND_POLICY_PROVENANCE_REF");
        invalid.add("ELIOTR_MODEL_SPEND_POLICY_JSON");
      } else {
        try {
          // With no installed companion, the embedded provenance is used only
          // to exercise the existing strict parser; it grants no authority.
          const policy = readResearchModelSpendPolicy(spend, parserProvenance);
          if (Date.parse(policy.expires_at) <= now || policy.deployment_generation !== env.deployment_generation ||
              (owner !== undefined && (policy.principal_ref !== owner.principal_ref ||
                policy.credential_generation !== owner.credential_generation || policy.client_class !== owner.client_class))) {
            invalid.add("ELIOTR_MODEL_SPEND_POLICY_JSON");
          }
        } catch {
          invalid.add("ELIOTR_MODEL_SPEND_POLICY_JSON");
        }
      }
    }
  }

  const reportJsonValid = report === undefined || validJsonObject(report);
  const reportProvenanceValid = reportProvenance === undefined || validProvenance(reportProvenance);
  if (report !== undefined && !reportJsonValid) invalid.add("ELIOTR_RESEARCH_REPORT_CONFIG_JSON");
  if (reportProvenance !== undefined && !reportProvenanceValid) invalid.add("ELIOTR_RESEARCH_REPORT_POLICY_PROVENANCE_REF");
  if (report !== undefined && reportJsonValid) {
    const reportProtocol = embeddedAdmissionProtocol(report);
    const isTemplate = reportProtocol === RESEARCH_OWNER_REPORT_ADMISSION_TEMPLATE_PROTOCOL ||
      reportProtocol === RESEARCH_OWNER_REPORT_ADMISSION_TEMPLATE_V2_PROTOCOL;
    if (isTemplate) {
      // A report template must carry its installed companion provenance. It is
      // bound to current policy authority only inside the request composition.
      if (reportProvenance === undefined) {
        missing.add("ELIOTR_RESEARCH_REPORT_POLICY_PROVENANCE_REF");
        invalid.add("ELIOTR_RESEARCH_REPORT_CONFIG_JSON");
      } else if (reportProvenanceValid) {
        try {
          const decoded = JSON.parse(report) as {
            schema?: unknown;
            admission_policy?: unknown;
            artifact_policy?: unknown;
          };
          const admission = readResearchOwnerReportAdmissionTemplate(decoded.admission_policy, reportProvenance);
          readResearchOwnerReportArtifactPolicy(decoded.artifact_policy);
          const v1 = admission.protocol === RESEARCH_OWNER_REPORT_ADMISSION_TEMPLATE_PROTOCOL;
          if (decoded.schema !== "eliotr.research.report-config.v1" ||
              (admission.expires_at !== undefined && Date.parse(admission.expires_at) <= now) ||
              (v1 && admission.deployment_generation !== env.deployment_generation) || (owner !== undefined &&
                (admission.principal_ref !== owner.principal_ref || admission.client_class !== owner.client_class))) {
            invalid.add("ELIOTR_RESEARCH_REPORT_CONFIG_JSON");
          }
        } catch {
          invalid.add("ELIOTR_RESEARCH_REPORT_CONFIG_JSON");
        }
      } else {
        invalid.add("ELIOTR_RESEARCH_REPORT_CONFIG_JSON");
      }
    } else {
      const parserProvenance = reportProvenance !== undefined && reportProvenanceValid
        ? reportProvenance : embeddedProvenance(report, true);
      if (parserProvenance === undefined || !validProvenance(parserProvenance)) {
        if (reportProvenance === undefined) missing.add("ELIOTR_RESEARCH_REPORT_POLICY_PROVENANCE_REF");
        invalid.add("ELIOTR_RESEARCH_REPORT_CONFIG_JSON");
      } else {
        try {
          // As above, report config parsing is synchronous; readArtifactPolicy
          // would only decode the already parsed local snapshot.
          createResearchReportConfigSource({ raw: report, provenance_ref: parserProvenance });
          const { admission_policy: admission } = JSON.parse(report) as {
            admission_policy: { expires_at: string; principal_ref: string; client_class: string };
          };
          if (Date.parse(admission.expires_at) <= now || (owner !== undefined &&
              (admission.principal_ref !== owner.principal_ref || admission.client_class !== owner.client_class))) {
            invalid.add("ELIOTR_RESEARCH_REPORT_CONFIG_JSON");
          }
        } catch {
          invalid.add("ELIOTR_RESEARCH_REPORT_CONFIG_JSON");
        }
      }
    }
  }

  const configuredGatewayToken = env.configuration_fields.ELIOTR_MODEL_GATEWAY_TOKEN;
  const hasGatewayToken = hasText(configuredGatewayToken);
  const gatewayTokenValid = hasGatewayToken && validGatewayToken(configuredGatewayToken);
  if (hasGatewayToken && !gatewayTokenValid) invalid.add("ELIOTR_MODEL_GATEWAY_TOKEN");
  const hasNativeGateway = env.native_model_gateway_available;
  const modelTransport = (hasGatewayToken ? gatewayTokenValid : hasNativeGateway)
    ? "available" : "unavailable";
  const configuration = invalid.size > 0 ? "invalid" : missing.size > 0 ? "missing" : "present";
  return Object.freeze({
    protocol: RESEARCH_CONFIGURATION_PROTOCOL,
    configuration,
    model_transport: modelTransport,
    missing_fields: Object.freeze([...missing]),
    invalid_fields: Object.freeze([...invalid]),
    checked_at: new Date(now).toISOString(),
  });
}
