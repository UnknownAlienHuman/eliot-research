import {
  ArtifactSectionContractSchema,
  ArtifactSpecSchema,
  ObjectResidencyKeySchema,
  OperationIntentSchema,
  type ArtifactKind,
  type ArtifactSectionContract,
  type EvidenceLabel,
  type ObjectResidencyKey,
  type OperationIntent,
  type VersionedRef,
} from "@eliotr/contracts";
import { canonicalEvidenceJson, evidenceSha256Bytes } from "@eliotr/cloudflare-evidence";
import { canonicalDigest } from "@eliotr/platform-cloudflare";
import type { ArtifactDraftReferencedObjectInput } from "./artifact-draft-types.js";
import type { ArtifactSectionMaterializationTemplate, ObjectResidencyTemplate } from "./research-artifact-draft.js";
import type { EvidenceFreezeMaterializeContext } from "./research-evidence-freeze-composition.js";
import type { ResearchMaterializeTrustedMetadata } from "./research-materialize-stage-handler.js";
import type { StageRequest, WorkflowPrincipal } from "./types.js";

export interface ResearchArtifactReportPolicy {
  readonly kind: ArtifactKind;
  readonly title: string;
  readonly audience: string;
  readonly language: string;
  readonly section_contract: ArtifactSectionContract;
  readonly statement_labels: Readonly<Record<string, EvidenceLabel>>;
  readonly citation_policy_ref: string;
  readonly verification_policy_ref: string;
  readonly length_policy_ref: string;
  readonly export_formats: readonly ("markdown" | "html" | "pdf" | "docx")[];
  readonly include_counterevidence: boolean;
  readonly include_methodology: boolean;
  readonly budget_ref: string;
  readonly section_residency: ObjectResidencyTemplate;
  readonly manifest_residency: ObjectResidencyTemplate;
}

export interface ResearchArtifactMetadataProducerInput {
  /** Explicit server-read operation authority; no intent is derived from request bytes. */
  readonly intent: OperationIntent;
  readonly expected_draft_head_revision: number | null;
  readonly policy: ResearchArtifactReportPolicy;
}

export type ResearchArtifactMetadataProducerRequest = {
  readonly request: StageRequest;
  readonly principal: WorkflowPrincipal;
  readonly context: EvidenceFreezeMaterializeContext;
};

export type ResearchArtifactMetadataErrorCode =
  | "RESEARCH_ARTIFACT_METADATA_INPUT_INVALID"
  | "RESEARCH_ARTIFACT_METADATA_AUTHORITY_STALE";

export class ResearchArtifactMetadataError extends Error {
  public readonly code: ResearchArtifactMetadataErrorCode;

  public constructor(code: ResearchArtifactMetadataErrorCode, message: string) {
    super(message);
    this.name = "ResearchArtifactMetadataError";
    this.code = code;
  }
}

function fail(code: ResearchArtifactMetadataErrorCode, message: string): never {
  throw new ResearchArtifactMetadataError(code, message);
}

function sameRef(left: VersionedRef, right: VersionedRef): boolean {
  return left.id === right.id && left.revision === right.revision;
}

function refKey(ref: VersionedRef): string {
  return `${ref.id}:${ref.revision}`;
}

function residency(value: ObjectResidencyTemplate, label: string): ObjectResidencyTemplate {
  try { return ObjectResidencyKeySchema.omit({ content_digest: true }).parse(value); }
  catch { fail("RESEARCH_ARTIFACT_METADATA_INPUT_INVALID", `${label} is invalid`); }
}

function validatePolicy(policy: ResearchArtifactReportPolicy): void {
  try { ArtifactSectionContractSchema.parse(policy.section_contract); }
  catch { fail("RESEARCH_ARTIFACT_METADATA_INPUT_INVALID", "report section contract is invalid"); }
  residency(policy.section_residency, "section residency");
  residency(policy.manifest_residency, "manifest residency");
  if (Object.keys(policy.statement_labels).sort().join("\u0000") !== [...policy.section_contract.required_claim_kinds].sort().join("\u0000") ||
      Object.values(policy.statement_labels).some((label) => label !== "UNRESOLVED")) {
    fail("RESEARCH_ARTIFACT_METADATA_INPUT_INVALID", "report labels must cover claims as UNRESOLVED");
  }
}

function objectResidency(template: ObjectResidencyTemplate, digest: string): ObjectResidencyKey {
  return { ...template, content_digest: { algorithm: "sha256", digest } };
}

export function createResearchArtifactMetadataProducer(input: ResearchArtifactMetadataProducerInput):
  (request: ResearchArtifactMetadataProducerRequest) => Promise<ResearchMaterializeTrustedMetadata> {
  try { OperationIntentSchema.parse(input.intent); }
  catch { fail("RESEARCH_ARTIFACT_METADATA_INPUT_INVALID", "server operation intent is invalid"); }
  validatePolicy(input.policy);
  if (input.intent.operation_kind !== "REPORT" ||
      (!Number.isSafeInteger(input.expected_draft_head_revision) && input.expected_draft_head_revision !== null) ||
      (input.expected_draft_head_revision !== null && input.expected_draft_head_revision < 1)) {
    fail("RESEARCH_ARTIFACT_METADATA_INPUT_INVALID", "report operation authority is invalid");
  }
  const intent = Object.freeze({ ...input.intent });
  const policy = Object.freeze({ ...input.policy });
  return async ({ request, principal, context }) => {
    if (request.stage !== "MATERIALIZE" || principal.principal_ref !== intent.principal_ref ||
        intent.idempotency_key !== request.idempotency_key || context.operation_id !== request.operation_id ||
        context.principal_ref !== principal.principal_ref || context.credential_generation !== principal.credential_generation ||
        !sameRef(context.freeze.scope_snapshot_ref, context.manifest.scope_snapshot_ref)) {
      fail("RESEARCH_ARTIFACT_METADATA_AUTHORITY_STALE", "materialize metadata is not bound to the accepted operation");
    }
    const scope = context.freeze.scope_snapshot_ref;
    if (policy.section_residency.scope_domain_id !== scope.id || policy.section_residency.access_domain_id !== principal.principal_ref ||
        policy.manifest_residency.scope_domain_id !== scope.id || policy.manifest_residency.access_domain_id !== principal.principal_ref) {
      fail("RESEARCH_ARTIFACT_METADATA_AUTHORITY_STALE", "report residency is not scope-bound");
    }
    const identity = await canonicalDigest({
      schema: "eliotr.research.artifact-metadata.v1", operation_id: context.operation_id,
      investigation_id: context.investigation_id, freeze_ref: context.freeze.freeze_ref,
      manifest_ref: context.manifest.manifest_ref, stage_five_attempt_ref: context.stage_five.stage_attempt_ref,
      stage_ten_attempt_ref: context.stage_ten_attempt_ref, intent_ref: intent.intent_ref,
      idempotency_key: intent.idempotency_key, policy,
    });
    const artifactRef: VersionedRef = { id: `eliotr.research.artifact-${identity}`, revision: 1 };
    const specRef: VersionedRef = { id: `eliotr.research.artifact-spec-${identity}`, revision: 1 };
    const sectionRef: VersionedRef = { id: `eliotr.research.artifact-section-${identity}`, revision: 1 };
    const spec = ArtifactSpecSchema.parse({
      spec_ref: specRef, kind: policy.kind, title: policy.title, scope_snapshot_ref: scope,
      inquiry_protocol_ref: context.stage_ten_input.protocol_profile.profile_ref, audience: policy.audience,
      language: policy.language, section_contracts: [policy.section_contract],
      citation_policy_ref: policy.citation_policy_ref, verification_policy_ref: policy.verification_policy_ref,
      include_counterevidence: policy.include_counterevidence, include_methodology: policy.include_methodology,
      length_policy_ref: policy.length_policy_ref, export_formats: [...policy.export_formats], budget_ref: policy.budget_ref,
    });
    const section: ArtifactSectionMaterializationTemplate = {
      section_ref: sectionRef, contract_id: policy.section_contract.section_id,
      body_object_ref: `eliotr.research.artifact-body-${identity}`, statement_labels: { ...policy.statement_labels },
      evidence_ledger_ref: `eliotr.research.evidence-ledger-${identity}`,
    };
    const manifestBytes = new TextEncoder().encode(canonicalEvidenceJson(context.manifest));
    const ledgerBytes = new TextEncoder().encode(canonicalEvidenceJson(context.stage_five.evidence_pack));
    const [manifestDigest, ledgerDigest] = await Promise.all([evidenceSha256Bytes(manifestBytes), evidenceSha256Bytes(ledgerBytes)]);
    const manifestObject: ArtifactDraftReferencedObjectInput = {
      object_ref: refKey(context.manifest.manifest_ref), object_kind: "DEPENDENCY_MANIFEST", bytes: manifestBytes,
      residency: objectResidency(policy.manifest_residency, manifestDigest),
    };
    const ledgerObject: ArtifactDraftReferencedObjectInput = {
      object_ref: section.evidence_ledger_ref, object_kind: "EVIDENCE_LEDGER", bytes: ledgerBytes,
      residency: objectResidency(policy.section_residency, ledgerDigest),
    };
    return {
      intent, expected_draft_head_revision: input.expected_draft_head_revision, artifact_ref: artifactRef, spec, section,
      section_residency: residency(policy.section_residency, "section residency"), referenced_objects: [manifestObject, ledgerObject],
      manifest_residency: residency(policy.manifest_residency, "manifest residency"), created_at: context.freeze.frozen_at,
    };
  };
}
