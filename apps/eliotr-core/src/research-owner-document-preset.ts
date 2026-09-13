import {
  ArtifactKindSchema,
  ArtifactSectionContractSchema,
  EvidenceLabelSchema,
  IdentifierSchema,
  ObjectResidencyKeySchema,
  VersionedRefSchema,
  type EvidenceLabel,
  type VersionedRef,
} from "@eliotr/contracts";
import type { ResearchArtifactReportPolicy } from "@eliotr/cloudflare-research";
import { RUNTIME_LIMITS } from "@eliotr/platform-cloudflare";
import {
  parseResearchClaimAuditPolicy,
  type ResearchClaimAuditPolicy,
} from "@eliotr/cloudflare-research-stages";
import {
  createResearchOwnerSemanticConfiguration,
  type ResearchOwnerAuditConfigurationInput,
  type ResearchOwnerNormalizationInput,
  type ResearchOwnerPromptLimits,
  type ResearchOwnerSemanticConfigurationInput,
} from "./research-owner-semantic-config.js";

type ResidencyTemplate = Omit<ResearchArtifactReportPolicy["section_residency"], "content_digest">;

const RESIDENCY_TEMPLATE_SCHEMA = ObjectResidencyKeySchema.omit({ content_digest: true });
const DOCUMENT_CLAIM_KINDS = ["observation"] as const;

export interface ResearchOwnerDocumentPresetOwnerInput {
  /** Principal from the authenticated owner session, never from a document request. */
  readonly principal_ref: string;
  /** Scope selected by the already-authorized navigation/orientation path. */
  readonly scope_snapshot_ref: VersionedRef;
}

export interface ResearchOwnerDocumentPresetReportInput {
  /** Installed policy references; this helper does not create or authorize them. */
  readonly citation_policy_ref: string;
  readonly verification_policy_ref: string;
  readonly length_policy_ref: string;
  readonly budget_ref: string;
  /** Existing owner/scope-bound residency templates, without a content digest. */
  readonly section_residency: ResidencyTemplate;
  readonly manifest_residency: ResidencyTemplate;
}

export interface ResearchOwnerDocumentPresetInput {
  readonly owner: ResearchOwnerDocumentPresetOwnerInput;
  /** Explicit token and timeout choices; no quota or model default is inferred. */
  readonly synthesis: ResearchOwnerPromptLimits;
  readonly audit: ResearchOwnerAuditConfigurationInput;
  readonly normalization: ResearchOwnerNormalizationInput;
  readonly report: ResearchOwnerDocumentPresetReportInput;
}

export interface ResearchOwnerDocumentPreset {
  /** Input for createResearchOwnerSemanticConfiguration; trusted prompts/schemas are injected there. */
  readonly semantic: ResearchOwnerSemanticConfigurationInput;
  /** Server-owned presentation policy for a private Russian Markdown answer. */
  readonly artifact_policy: ResearchArtifactReportPolicy;
}

export type ResearchOwnerDocumentPresetErrorCode = "RESEARCH_OWNER_DOCUMENT_PRESET_INVALID";

export class ResearchOwnerDocumentPresetError extends Error {
  public readonly code: ResearchOwnerDocumentPresetErrorCode = "RESEARCH_OWNER_DOCUMENT_PRESET_INVALID";

  public constructor(message: string) {
    super(message);
    this.name = "ResearchOwnerDocumentPresetError";
  }
}

function invalid(message: string): never {
  throw new ResearchOwnerDocumentPresetError(message);
}

function freezeDeep<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) freezeDeep(child);
  }
  return value;
}

function boundAuthority(input: ResearchOwnerDocumentPresetInput): {
  readonly principal_ref: string;
  readonly scope_snapshot_ref: VersionedRef;
  readonly section_residency: ResidencyTemplate;
  readonly manifest_residency: ResidencyTemplate;
} {
  const principal = IdentifierSchema.safeParse(input.owner?.principal_ref);
  const scope = VersionedRefSchema.safeParse(input.owner?.scope_snapshot_ref);
  const section = RESIDENCY_TEMPLATE_SCHEMA.safeParse(input.report?.section_residency);
  const manifest = RESIDENCY_TEMPLATE_SCHEMA.safeParse(input.report?.manifest_residency);
  if (!principal.success || !scope.success || !section.success || !manifest.success) {
    invalid("owner, scope, or report residency is invalid");
  }
  if (section.data.scope_domain_id !== scope.data.id || manifest.data.scope_domain_id !== scope.data.id ||
      section.data.access_domain_id !== principal.data || manifest.data.access_domain_id !== principal.data) {
    invalid("report residency is not bound to the supplied owner scope");
  }
  return {
    principal_ref: principal.data,
    scope_snapshot_ref: Object.freeze({ id: scope.data.id, revision: scope.data.revision }),
    section_residency: section.data,
    manifest_residency: manifest.data,
  };
}

function explicitRef(value: unknown, label: string): string {
  const parsed = IdentifierSchema.safeParse(value);
  if (!parsed.success) invalid(`${label} is invalid`);
  return parsed.data;
}

/**
 * Build the ordinary owner document-Q&A configuration from explicit authority
 * inputs. Prompts, response schemas, and claim-audit semantics remain pinned
 * package assets; spend, pricing, qualification, and report admission remain
 * separate operator decisions.
 */
export function createResearchOwnerDocumentPreset(
  input: ResearchOwnerDocumentPresetInput,
): ResearchOwnerDocumentPreset {
  if (input === null || typeof input !== "object") invalid("preset input is invalid");
  const owner = boundAuthority(input);
  let auditPolicy: ResearchClaimAuditPolicy;
  try {
    auditPolicy = parseResearchClaimAuditPolicy(input.audit.policy);
  } catch {
    invalid("audit policy is invalid");
  }
  const semantic: ResearchOwnerSemanticConfigurationInput = {
    synthesis: {
      max_tokens: input.synthesis.max_tokens,
      request_timeout_ms: input.synthesis.request_timeout_ms,
    },
    audit: {
      max_tokens: input.audit.max_tokens,
      request_timeout_ms: input.audit.request_timeout_ms,
      verifier_ref: input.audit.verifier_ref,
      verifier_schema_generation: input.audit.verifier_schema_generation,
      allowed_verifier_refs: [...input.audit.allowed_verifier_refs],
      policy: auditPolicy,
    },
    normalization: {
      section_ref: { id: input.normalization.section_ref.id, revision: input.normalization.section_ref.revision },
      required_precision: input.normalization.required_precision,
      required_source_class: input.normalization.required_source_class,
    },
  };
  // This is the single existing validator/factory for trusted prompts and
  // response schemas. Its result is intentionally not exposed as authority.
  createResearchOwnerSemanticConfiguration(semantic);

  const citationPolicyRef = explicitRef(input.report.citation_policy_ref, "citation_policy_ref");
  const verificationPolicyRef = explicitRef(input.report.verification_policy_ref, "verification_policy_ref");
  const lengthPolicyRef = explicitRef(input.report.length_policy_ref, "length_policy_ref");
  const budgetRef = explicitRef(input.report.budget_ref, "budget_ref");
  const sectionContract = ArtifactSectionContractSchema.parse({
    section_id: "answer",
    title: "Ответ",
    purpose: "Ответ на вопрос по документу с источниками, контраргументами и ограничениями",
    required_claim_kinds: [...DOCUMENT_CLAIM_KINDS],
    required_evidence_classes: ["source"],
    maximum_utf8_bytes: RUNTIME_LIMITS.artifact_section_target_bytes,
  });
  const unresolved = EvidenceLabelSchema.parse("UNRESOLVED");
  const statementLabels: Record<string, EvidenceLabel> = {
    observation: unresolved,
  };
  const artifactPolicy: ResearchArtifactReportPolicy = {
    kind: ArtifactKindSchema.parse("research_report"),
    title: "Ответ по документам",
    audience: "owner",
    language: "ru",
    section_contract: sectionContract,
    statement_labels: statementLabels,
    citation_policy_ref: citationPolicyRef,
    verification_policy_ref: verificationPolicyRef,
    length_policy_ref: lengthPolicyRef,
    export_formats: ["markdown"],
    include_counterevidence: true,
    include_methodology: true,
    budget_ref: budgetRef,
    section_residency: owner.section_residency,
    manifest_residency: owner.manifest_residency,
  };
  return freezeDeep({ semantic, artifact_policy: artifactPolicy });
}
