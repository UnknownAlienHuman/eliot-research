import { z } from "zod";
import {
  ArtifactKindSchema,
  ArtifactSectionContractSchema,
  EvidenceLabelSchema,
  IdentifierSchema,
  IsoDateTimeSchema,
  ObjectResidencyKeySchema,
} from "@eliotr/contracts";
import type { ResearchArtifactReportPolicy } from "./research-artifact-metadata.js";
import type {
  ResearchReportAdmissionPolicy,
  ResearchReportAdmissionPolicySource,
} from "./research-report-admission.js";

export const RESEARCH_REPORT_CONFIG_JSON_ENV = "ELIOTR_RESEARCH_REPORT_CONFIG_JSON" as const;
export const RESEARCH_REPORT_CONFIG_SCHEMA = "eliotr.research.report-config.v1" as const;

export interface ResearchReportConfigSourceOptions {
  /** Raw server-owned value of RESEARCH_REPORT_CONFIG_JSON_ENV, if installed. */
  readonly raw: string | undefined;
  /** External provenance label for the installed configuration record. */
  readonly provenance_ref: string;
}

export type ResearchReportConfigErrorCode =
  | "REPORT_CONFIG_INPUT_INVALID"
  | "REPORT_CONFIG_MISSING"
  | "REPORT_CONFIG_INVALID";

export class ResearchReportConfigError extends Error {
  public readonly code: ResearchReportConfigErrorCode;

  public constructor(code: ResearchReportConfigErrorCode, message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "ResearchReportConfigError";
    this.code = code;
  }
}

export interface ResearchReportConfigSource extends ResearchReportAdmissionPolicySource {
  readonly readArtifactPolicy: () => Promise<ResearchArtifactReportPolicy | null>;
}

const CONFIG_KEYS = new Set(["schema", "admission_policy", "artifact_policy"]);
const ADMISSION_KEYS = new Set([
  "schema", "policy_ref", "policy_revision", "config_provenance_ref", "principal_ref", "client_class",
  "policy_generation", "policy_authority_ref", "allowed_use", "disclosure_ceiling", "requested_output_class",
  "purpose", "expires_at",
]);
const ARTIFACT_KEYS = new Set([
  "kind", "title", "audience", "language", "section_contract", "statement_labels", "citation_policy_ref",
  "verification_policy_ref", "length_policy_ref", "export_formats", "include_counterevidence", "include_methodology",
  "budget_ref", "section_residency", "manifest_residency",
]);

function invalid(message: string, cause?: unknown): never {
  throw new ResearchReportConfigError("REPORT_CONFIG_INVALID", message, cause);
}

function inputInvalid(message: string): never {
  throw new ResearchReportConfigError("REPORT_CONFIG_INPUT_INVALID", message);
}

function plain(value: unknown, keys: ReadonlySet<string>, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value) ||
      !sameKeys(value as Record<string, unknown>, keys)) invalid(`${label} has unknown or missing fields`);
  return value as Record<string, unknown>;
}

function sameKeys(value: Record<string, unknown>, keys: ReadonlySet<string>): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.size && actual.every((key) => keys.has(key));
}

function parseAdmission(value: unknown, provenanceRef: string): ResearchReportAdmissionPolicy {
  const record = plain(value, ADMISSION_KEYS, "admission policy");
  if (record.config_provenance_ref !== provenanceRef) invalid("admission policy provenance does not match installed provenance");
  const result = z.object({
    schema: z.literal("eliotr.research.report-admission.v1"),
    policy_ref: IdentifierSchema,
    policy_revision: z.number().int().positive(),
    config_provenance_ref: IdentifierSchema,
    principal_ref: IdentifierSchema,
    client_class: z.literal("owner_pwa"),
    policy_generation: IdentifierSchema,
    policy_authority_ref: IdentifierSchema,
    allowed_use: z.array(IdentifierSchema).min(1),
    disclosure_ceiling: IdentifierSchema,
    requested_output_class: z.literal("private-draft"),
    purpose: z.literal("research-report-materialization"),
    expires_at: IsoDateTimeSchema,
  }).strict().safeParse(record);
  if (!result.success) invalid("admission policy fails strict validation");
  return result.data;
}

function parseArtifact(value: unknown): ResearchArtifactReportPolicy {
  const record = plain(value, ARTIFACT_KEYS, "artifact policy");
  const result = z.object({
    kind: ArtifactKindSchema,
    title: z.string().min(1),
    audience: z.string().min(1),
    language: IdentifierSchema,
    section_contract: ArtifactSectionContractSchema,
    statement_labels: z.record(IdentifierSchema, EvidenceLabelSchema),
    citation_policy_ref: IdentifierSchema,
    verification_policy_ref: IdentifierSchema,
    length_policy_ref: IdentifierSchema,
    export_formats: z.array(z.enum(["markdown", "html", "pdf", "docx"])),
    include_counterevidence: z.boolean(),
    include_methodology: z.boolean(),
    budget_ref: IdentifierSchema,
    section_residency: ObjectResidencyKeySchema.omit({ content_digest: true }),
    manifest_residency: ObjectResidencyKeySchema.omit({ content_digest: true }),
  }).strict().safeParse(record);
  if (!result.success) invalid("artifact policy fails strict validation");
  if (Object.keys(result.data.statement_labels).sort().join("\u0000") !== [...result.data.section_contract.required_claim_kinds].sort().join("\u0000") ||
      Object.values(result.data.statement_labels).some((label) => label !== "UNRESOLVED")) {
    invalid("artifact policy must use UNRESOLVED statement labels");
  }
  return result.data;
}

function snapshot(value: unknown, label: string): string {
  try {
    const text = JSON.stringify(value);
    if (text === undefined) invalid(`${label} cannot be serialized`);
    return text;
  } catch (cause) {
    invalid(`${label} cannot be serialized`, cause);
  }
}

/** Reads one explicitly installed REPORT configuration without deriving authority from grants. */
export function createResearchReportConfigSource(options: ResearchReportConfigSourceOptions): ResearchReportConfigSource {
  if (typeof options !== "object" || options === null || !IdentifierSchema.safeParse(options.provenance_ref).success) {
    inputInvalid("REPORT configuration provenance is invalid");
  }
  if (options.raw === undefined || (typeof options.raw === "string" && options.raw.trim() === "")) {
    return Object.freeze({ provenance_ref: options.provenance_ref, read: async () => null, readArtifactPolicy: async () => null });
  }
  if (typeof options.raw !== "string") inputInvalid("REPORT configuration must be a JSON string");
  let parsed: unknown;
  try { parsed = JSON.parse(options.raw); }
  catch (cause) { invalid("REPORT configuration is not valid JSON", cause); }
  const config = plain(parsed, CONFIG_KEYS, "REPORT configuration");
  if (config.schema !== RESEARCH_REPORT_CONFIG_SCHEMA) invalid("REPORT configuration schema is unsupported");
  const admission = parseAdmission(config.admission_policy, options.provenance_ref);
  const artifact = parseArtifact(config.artifact_policy);
  const serialized = snapshot({ schema: RESEARCH_REPORT_CONFIG_SCHEMA, admission_policy: admission, artifact_policy: artifact }, "REPORT configuration");
  return Object.freeze({
    provenance_ref: options.provenance_ref,
    read: async () => (JSON.parse(serialized) as { readonly admission_policy: ResearchReportAdmissionPolicy }).admission_policy,
    readArtifactPolicy: async () => JSON.parse(serialized).artifact_policy as ResearchArtifactReportPolicy,
  });
}
