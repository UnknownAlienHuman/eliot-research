import { IdentifierSchema, ObjectResidencyKeySchema } from "@eliotr/contracts";
import type { ResearchArtifactReportPolicy } from "@eliotr/cloudflare-research";

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

export interface ResearchOwnerReportPolicyBindingInput {
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
  if (configuredSection.access_domain_id !== owner.data || configuredManifest.access_domain_id !== owner.data) {
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
