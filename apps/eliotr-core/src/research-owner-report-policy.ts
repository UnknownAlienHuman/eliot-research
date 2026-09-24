import { z } from "zod";
import {
  ArtifactKindSchema,
  ArtifactSectionContractSchema,
  EvidenceLabelSchema,
  IdentifierSchema,
  IsoDateTimeSchema,
  ObjectResidencyKeySchema,
} from "@eliotr/contracts";
import { canonicalJson } from "@eliotr/platform-cloudflare";
import {
  createResearchReportConfigSource,
  type ResearchArtifactReportPolicy,
  type ResearchModelSpendPolicy,
  type ResearchReportAdmissionPolicy,
  type ResearchReportConfigSource,
} from "@eliotr/cloudflare-research";

type ReportResidencyTemplate = ResearchArtifactReportPolicy["section_residency"];
const ReportResidencyTemplateSchema = ObjectResidencyKeySchema.omit({ content_digest: true });

export type ResearchOwnerReportPolicyErrorCode =
  | "RESEARCH_OWNER_REPORT_POLICY_INVALID"
  | "RESEARCH_OWNER_REPORT_POLICY_AUTHORITY_STALE";

export class ResearchOwnerReportPolicyError extends Error {
  public readonly code: ResearchOwnerReportPolicyErrorCode;

  public constructor(code: ResearchOwnerReportPolicyErrorCode, message: string) {
    super(message);
    this.name = "ResearchOwnerReportPolicyError";
    this.code = code;
  }
}

export const RESEARCH_OWNER_REPORT_ADMISSION_TEMPLATE_PROTOCOL =
  "eliotr.research-owner-report-admission-template.v1" as const;

const ReportAdmissionTemplateSchema = z.object({
  protocol: z.literal(RESEARCH_OWNER_REPORT_ADMISSION_TEMPLATE_PROTOCOL),
  policy_ref: IdentifierSchema,
  policy_revision: z.number().int().positive(),
  config_provenance_ref: IdentifierSchema,
  principal_ref: IdentifierSchema,
  client_class: z.literal("owner_pwa"),
  deployment_generation: IdentifierSchema,
  allowed_use: z.array(IdentifierSchema).length(1).refine((values) => values[0] === "research"),
  disclosure_ceiling: IdentifierSchema,
  requested_output_class: z.literal("private-draft"),
  purpose: z.literal("research-report-materialization"),
  expires_at: IsoDateTimeSchema,
}).strict();
const ReportArtifactSchema = z.object({
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
}).strict();
const REPORT_CONFIG_KEYS = new Set(["schema", "admission_policy", "artifact_policy"]);

export type ResearchOwnerReportAdmissionTemplate = Readonly<z.infer<typeof ReportAdmissionTemplateSchema>>;

export type ResearchOwnerReportAdmissionPolicyInput =
  | ResearchReportAdmissionPolicy
  | ResearchOwnerReportAdmissionTemplate;

export interface ResearchOwnerReportAuthorityBinding {
  readonly sponsor_principal_ref?: string;
  readonly principal_ref: string;
  readonly client_class: ResearchModelSpendPolicy["client_class"];
  readonly deployment_generation: string;
  readonly policy_generation: string;
  readonly policy_authority_ref: string;
  readonly expires_at: string;
}

export interface ResearchOwnerReportAdmissionBindingInput {
  readonly current_spend_authority: ResearchOwnerReportAuthorityBinding;
  readonly now_ms?: number;
}

export interface ResearchOwnerReportConfigSourceOptions {
  readonly raw: string | undefined;
  readonly provenance_ref: string;
  readonly current_spend_authority: ResearchOwnerReportAuthorityBinding;
  readonly now_ms?: number;
}

export interface ResearchOwnerReportPolicyBindingInput {
  readonly sponsor_principal_ref?: string;
  /** The scope identity supplied by the already authenticated navigation root. */
  readonly current_scope_snapshot_id: string;
  /** The owner identity supplied by the already authenticated Worker principal. */
  readonly current_owner_principal_ref: string;
  /** The residency on the server-created frozen input manifest, including its content digest. */
  readonly frozen_manifest_residency: unknown;
}

function fail(code: ResearchOwnerReportPolicyErrorCode, message: string): never {
  throw new ResearchOwnerReportPolicyError(code, message);
}

function reportError(message: string): never {
  throw new ResearchOwnerReportPolicyError("RESEARCH_OWNER_REPORT_POLICY_INVALID", message);
}

function id(value: unknown, label: string): string {
  const parsed = IdentifierSchema.safeParse(value);
  if (!parsed.success) reportError(`${label} is invalid`);
  return parsed.data;
}

function canonicalTime(value: unknown, label: string): string {
  const parsed = IsoDateTimeSchema.safeParse(value);
  if (!parsed.success) reportError(`${label} is invalid`);
  return parsed.data;
}

function nowMs(value: number | undefined): number {
  const now = value ?? Date.now();
  if (!Number.isSafeInteger(now) || now < 0) reportError("report authority clock is invalid");
  return now;
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) reportError(`${label} is invalid`);
  return value as Record<string, unknown>;
}

function hasTemplateProtocol(value: unknown): boolean {
  return typeof value === "object" && value !== null && !Array.isArray(value) &&
    (value as Record<string, unknown>).protocol === RESEARCH_OWNER_REPORT_ADMISSION_TEMPLATE_PROTOCOL;
}

/** Decode only the private owner template; no authority fields are inferred here. */
export function readResearchOwnerReportAdmissionTemplate(
  value: unknown,
  provenanceRef: string,
): ResearchOwnerReportAdmissionTemplate {
  id(provenanceRef, "report template provenance");
  const result = ReportAdmissionTemplateSchema.safeParse(value);
  if (!result.success || result.data.config_provenance_ref !== provenanceRef) {
    reportError("owner report admission template is invalid");
  }
  return freeze(detached(result.data, "owner report admission template"));
}

/** Validate the artifact half without manufacturing admission authority fields. */
export function readResearchOwnerReportArtifactPolicy(value: unknown): ResearchArtifactReportPolicy {
  const result = ReportArtifactSchema.safeParse(value);
  if (!result.success || Object.keys(result.data.statement_labels).sort().join("\u0000") !==
      [...result.data.section_contract.required_claim_kinds].sort().join("\u0000") ||
      Object.values(result.data.statement_labels).some((label) => label !== "UNRESOLVED")) {
    reportError("owner report artifact policy is invalid");
  }
  return freeze(detached(result.data, "owner report artifact policy"));
}

/** Bind the template to the current D1-backed owner spend authority. */
export function bindResearchOwnerReportAdmissionTemplate(
  template: ResearchOwnerReportAdmissionTemplate,
  input: ResearchOwnerReportAdmissionBindingInput,
): ResearchReportAdmissionPolicy {
  const current = input.current_spend_authority;
  const principal = id(current.principal_ref, "current report principal");
  const client = current.client_class;
  const deployment = id(current.deployment_generation, "current report deployment");
  const generation = id(current.policy_generation, "current report policy generation");
  const authority = id(current.policy_authority_ref, "current report policy authority");
  const currentExpiry = canonicalTime(current.expires_at, "current report authority expiry");
  const now = nowMs(input.now_ms);
  const sponsor = current.sponsor_principal_ref;
  const validActor = client === "owner_pwa" ? sponsor === undefined && template.principal_ref === principal
    : (client === "trusted_agent" || client === "named_api_client") && sponsor !== undefined && template.principal_ref === sponsor;
  if (!validActor || template.deployment_generation !== deployment) {
    throw new ResearchOwnerReportPolicyError(
      "RESEARCH_OWNER_REPORT_POLICY_AUTHORITY_STALE",
      "owner report template is bound to another owner or deployment",
    );
  }
  const templateExpiry = Date.parse(template.expires_at);
  const authorityExpiry = Date.parse(currentExpiry);
  if (templateExpiry <= now || authorityExpiry <= now) {
    throw new ResearchOwnerReportPolicyError("RESEARCH_OWNER_REPORT_POLICY_AUTHORITY_STALE", "owner report authority has expired");
  }
  const expiresAt = new Date(Math.min(templateExpiry, authorityExpiry)).toISOString();
  return freeze({
    schema: client === "owner_pwa" ? "eliotr.research.report-admission.v1" : "eliotr.research.delegated-report-admission.v1",
    policy_ref: template.policy_ref,
    policy_revision: template.policy_revision,
    config_provenance_ref: template.config_provenance_ref,
    principal_ref: principal,
    client_class: client,
    policy_generation: generation,
    policy_authority_ref: authority,
    allowed_use: Object.freeze([...template.allowed_use]),
    disclosure_ceiling: template.disclosure_ceiling,
    requested_output_class: template.requested_output_class,
    purpose: template.purpose,
    expires_at: expiresAt,
  });
}

/**
 * Normalize a template before the existing strict REPORT parser. Legacy v1
 * configuration is passed to that parser untouched.
 */
export function createBoundResearchOwnerReportConfigSource(
  options: ResearchOwnerReportConfigSourceOptions,
): ResearchReportConfigSource {
  const raw = options.raw;
  if (raw === undefined) {
    return createResearchReportConfigSource({ raw, provenance_ref: options.provenance_ref });
  }
  if (typeof raw !== "string") reportError("REPORT configuration is invalid");
  if (raw.trim() === "") return createResearchReportConfigSource({ raw, provenance_ref: options.provenance_ref });
  if (new TextEncoder().encode(raw).byteLength > 65_536) reportError("REPORT configuration is oversized");
  let decoded: unknown;
  try { decoded = JSON.parse(raw); }
  catch { reportError("REPORT configuration is invalid JSON"); }
  const config = object(decoded, "REPORT configuration");
  const configKeys = Object.keys(config);
  if (configKeys.length !== REPORT_CONFIG_KEYS.size || configKeys.some((key) => !REPORT_CONFIG_KEYS.has(key))) {
    reportError("REPORT configuration has unknown or missing fields");
  }
  const admission = config.admission_policy;
  if (!hasTemplateProtocol(admission)) {
    return createResearchReportConfigSource({ raw, provenance_ref: options.provenance_ref });
  }
  const template = readResearchOwnerReportAdmissionTemplate(admission, options.provenance_ref);
  const bound = bindResearchOwnerReportAdmissionTemplate(template, {
    current_spend_authority: options.current_spend_authority,
    ...(options.now_ms === undefined ? {} : { now_ms: options.now_ms }),
  });
  const normalized = canonicalJson({ schema: config.schema, admission_policy: bound, artifact_policy: config.artifact_policy });
  return createResearchReportConfigSource({ raw: normalized, provenance_ref: options.provenance_ref });
}

function detached<T>(value: T, label: string): T {
  try {
    return structuredClone(value);
  } catch {
    fail("RESEARCH_OWNER_REPORT_POLICY_INVALID", `${label} cannot be snapshotted`);
  }
}

function freeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) freeze(child);
  }
  return value;
}

function template(value: unknown, label: string): ReportResidencyTemplate {
  const parsed = ReportResidencyTemplateSchema.safeParse(value);
  if (!parsed.success) fail("RESEARCH_OWNER_REPORT_POLICY_INVALID", `${label} is invalid`);
  return parsed.data;
}

/**
 * Binds the installed REPORT artifact policy to the real frozen run scope.
 * Only scope/access residency identity is run-derived; artifact policy,
 * contract, and report admission decisions remain exactly server-installed.
 */
export function bindResearchOwnerReportPolicy(
  policy: ResearchArtifactReportPolicy,
  input: ResearchOwnerReportPolicyBindingInput,
): ResearchArtifactReportPolicy {
  const scope = IdentifierSchema.safeParse(input.current_scope_snapshot_id);
  const owner = IdentifierSchema.safeParse(input.current_owner_principal_ref);
  if (!scope.success || !owner.success) fail("RESEARCH_OWNER_REPORT_POLICY_INVALID", "current report owner or scope is invalid");

  const frozen = ObjectResidencyKeySchema.safeParse(input.frozen_manifest_residency);
  if (!frozen.success) fail("RESEARCH_OWNER_REPORT_POLICY_INVALID", "frozen manifest residency is invalid");
  if (frozen.data.scope_domain_id !== scope.data || frozen.data.access_domain_id !== owner.data) {
    fail("RESEARCH_OWNER_REPORT_POLICY_AUTHORITY_STALE", "frozen manifest residency is outside the current owner scope");
  }

  const configuredSection = template(policy.section_residency, "configured section residency");
  const configuredManifest = template(policy.manifest_residency, "configured manifest residency");
  const policyOwner = input.sponsor_principal_ref === undefined ? owner.data : id(input.sponsor_principal_ref, "report sponsor");
  if (configuredSection.access_domain_id !== policyOwner || configuredManifest.access_domain_id !== policyOwner) {
    fail("RESEARCH_OWNER_REPORT_POLICY_AUTHORITY_STALE", "configured report residency belongs to another owner");
  }
  const bindResidency = (configured: ReportResidencyTemplate): ReportResidencyTemplate => ({
    ...configured,
    scope_domain_id: frozen.data.scope_domain_id,
    access_domain_id: frozen.data.access_domain_id,
  });
  const bound = detached({
    ...policy,
    section_residency: bindResidency(configuredSection),
    manifest_residency: bindResidency(configuredManifest),
  }, "bound report policy");
  return freeze(bound);
}
