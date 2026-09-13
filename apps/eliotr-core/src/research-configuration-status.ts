import { z } from "zod";
import { IdentifierSchema, IsoDateTimeSchema, VersionedRefSchema } from "@eliotr/contracts";
import {
  createModelProfileBindingConfigSource,
  createResearchReportConfigSource,
  readResearchModelSpendPolicy,
  type ResearchModelGatewayBinding,
} from "@eliotr/cloudflare-research";
import type { Env } from "./env.js";
import type { AuthenticatedRequestContext } from "@eliotr/interfaces";
import { parseResearchClaimAuditPolicy } from "@eliotr/cloudflare-research-stages";

const MAX_CONFIGURATION_BYTES = 65_536;
const RESEARCH_CONFIGURATION_PROTOCOL = "eliotr.research-configuration-status.v1" as const;

const PromptSchema = z.object({
  prompt: z.string().min(1),
  max_tokens: z.number().int().positive().safe(),
  response_format: z.unknown().optional(),
  seed: z.number().int().optional(),
  stop: z.union([z.string(), z.array(z.string())]).optional(),
  temperature: z.number().finite().optional(),
  top_p: z.number().finite().optional(),
}).strict();
const PromptConfigSchema = z.object({
  trusted_parameters: PromptSchema,
  request_timeout_ms: z.number().int().min(1).max(300_000),
}).strict();
const SemanticConfigurationSchema = z.object({
  protocol: z.literal("eliotr.research-semantic-config.v1"),
  synthesis: PromptConfigSchema,
  audit: PromptConfigSchema.extend({
    verifier_ref: IdentifierSchema,
    verifier_schema_generation: IdentifierSchema,
    allowed_verifier_refs: z.array(IdentifierSchema).min(1).max(512),
    policy: z.unknown(),
  }).strict(),
  normalization: z.object({
    section_ref: VersionedRefSchema,
    required_precision: IdentifierSchema,
    required_source_class: IdentifierSchema,
  }).strict(),
}).strict();

const REQUIRED_FIELDS = [
  "ELIOTR_RESEARCH_SEMANTIC_CONFIG_JSON",
  "ELIOTR_MODEL_PROFILE_DEFINITION_JSON",
  "ELIOTR_MODEL_PROFILE_PROVENANCE_REF",
  "ELIOTR_MODEL_SPEND_POLICY_JSON",
  "ELIOTR_MODEL_SPEND_POLICY_PROVENANCE_REF",
  "ELIOTR_RESEARCH_REPORT_CONFIG_JSON",
  "ELIOTR_RESEARCH_REPORT_POLICY_PROVENANCE_REF",
] as const;
type RequiredField = typeof REQUIRED_FIELDS[number];

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

function validSemanticConfiguration(value: string): boolean {
  if (!withinConfigurationLimit(value)) return false;
  try {
    const parsed = SemanticConfigurationSchema.safeParse(JSON.parse(value));
    if (!parsed.success || !parsed.data.audit.allowed_verifier_refs.includes(parsed.data.audit.verifier_ref)) return false;
    parseResearchClaimAuditPolicy(parsed.data.audit.policy);
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

/**
 * Reports installed configuration syntax, expiry, owner binding and transport presence. It does
 * not read D1/R2, contact a provider, or assert model qualification/readiness.
 */
export function readResearchConfigurationStatus(
  env: Env,
  owner?: Pick<AuthenticatedRequestContext, "principal_ref" | "credential_generation" | "client_class">,
): ResearchConfigurationStatus {
  const now = Date.now();
  const missing = new Set<string>();
  const invalid = new Set<string>();
  const read = (field: RequiredField): string | undefined => {
    const value = env[field];
    if (!hasText(value)) {
      missing.add(field);
      return undefined;
    }
    return value;
  };

  const semantic = read("ELIOTR_RESEARCH_SEMANTIC_CONFIG_JSON");
  const profile = read("ELIOTR_MODEL_PROFILE_DEFINITION_JSON");
  const profileProvenance = read("ELIOTR_MODEL_PROFILE_PROVENANCE_REF");
  const spend = read("ELIOTR_MODEL_SPEND_POLICY_JSON");
  const spendProvenance = read("ELIOTR_MODEL_SPEND_POLICY_PROVENANCE_REF");
  const report = read("ELIOTR_RESEARCH_REPORT_CONFIG_JSON");
  const reportProvenance = read("ELIOTR_RESEARCH_REPORT_POLICY_PROVENANCE_REF");

  if (semantic !== undefined && !validSemanticConfiguration(semantic)) {
    invalid.add("ELIOTR_RESEARCH_SEMANTIC_CONFIG_JSON");
  }

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
      const definition = JSON.parse(profile) as { expires_at?: unknown };
      const expires = IsoDateTimeSchema.safeParse(definition.expires_at);
      if (!expires.success || Date.parse(expires.data) <= now) invalid.add("ELIOTR_MODEL_PROFILE_DEFINITION_JSON");
    } catch {
      invalid.add("ELIOTR_MODEL_PROFILE_DEFINITION_JSON");
    }
  }

  const spendJsonValid = spend === undefined || validJsonObject(spend);
  const spendProvenanceValid = spendProvenance === undefined || validProvenance(spendProvenance);
  if (spend !== undefined && !spendJsonValid) invalid.add("ELIOTR_MODEL_SPEND_POLICY_JSON");
  if (spendProvenance !== undefined && !spendProvenanceValid) invalid.add("ELIOTR_MODEL_SPEND_POLICY_PROVENANCE_REF");
  if (spend !== undefined && spendJsonValid) {
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
        if (Date.parse(policy.expires_at) <= now || policy.deployment_generation !== env.DEPLOYMENT_GENERATION ||
            (owner !== undefined && (policy.principal_ref !== owner.principal_ref ||
              policy.credential_generation !== owner.credential_generation || policy.client_class !== owner.client_class))) {
          invalid.add("ELIOTR_MODEL_SPEND_POLICY_JSON");
        }
      } catch {
        invalid.add("ELIOTR_MODEL_SPEND_POLICY_JSON");
      }
    }
  }

  const reportJsonValid = report === undefined || validJsonObject(report);
  const reportProvenanceValid = reportProvenance === undefined || validProvenance(reportProvenance);
  if (report !== undefined && !reportJsonValid) invalid.add("ELIOTR_RESEARCH_REPORT_CONFIG_JSON");
  if (reportProvenance !== undefined && !reportProvenanceValid) invalid.add("ELIOTR_RESEARCH_REPORT_POLICY_PROVENANCE_REF");
  if (report !== undefined && reportJsonValid) {
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

  const configuration = invalid.size > 0 ? "invalid" : missing.size > 0 ? "missing" : "present";
  const modelTransport = typeof (env.AI as Partial<ResearchModelGatewayBinding> | undefined)?.gateway === "function" && hasText(env.AI_GATEWAY_REASONING_URL)
    ? "available" : "unavailable";
  return Object.freeze({
    protocol: RESEARCH_CONFIGURATION_PROTOCOL,
    configuration,
    model_transport: modelTransport,
    missing_fields: Object.freeze([...missing]),
    invalid_fields: Object.freeze([...invalid]),
    checked_at: new Date(now).toISOString(),
  });
}
