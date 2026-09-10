import {
  AllowedReferenceManifestSchema,
  ArtifactRevisionSchema,
  ArtifactSectionRevisionSchema,
  ArtifactSpecSchema,
  EvidenceFreezeSchema,
  ObjectResidencyKeySchema,
  OperationIntentSchema,
  ResolvedEvidenceSchema,
  VersionedRefSchema,
  type AllowedReferenceManifest,
  type ArtifactRevision,
  type ArtifactSectionRevision,
  type ArtifactSpec,
  type EvidenceFreeze,
  type ObjectResidencyKey,
  type OperationIntent,
  type VersionedRef,
} from "@eliotr/contracts";
import { canonicalEvidenceJson, evidenceSha256, evidenceSha256Bytes } from "@eliotr/cloudflare-evidence";
import { canonicalDigest } from "@eliotr/platform-cloudflare";
import {
  createArtifactDraftStore,
  type ArtifactDraftReferencedObjectInput,
  type PrepareArtifactDraftResult,
} from "./artifact-draft.js";
import type { ResearchEvidencePack } from "./research-reference-manifest.js";
import type { ModelAttemptReadback, ModelOutputBinding } from "./model-attempt-types.js";
import type { StageReceipt } from "./types.js";

const CANDIDATE_SCHEMA = "eliotr.research.synthesis-section-candidate.v1" as const;

export interface SynthesisSectionCandidate {
  readonly schema: typeof CANDIDATE_SCHEMA;
  readonly section_text: string;
  readonly cited_handle_refs: readonly VersionedRef[];
}

/** Structural type of the committed reader result supplied by Astro's reader. */
export interface CommittedResearchSynthesisOutputReadback {
  readonly operation_id: string;
  readonly investigation_ref: VersionedRef;
  readonly stage: "SYNTHESIZE";
  readonly stage_attempt_ref: string;
  readonly stage_request_sha256: string;
  readonly workflow_receipt: StageReceipt;
  readonly model_attempt: ModelAttemptReadback;
  readonly output: ModelOutputBinding;
  readonly bytes: Uint8Array;
}

export interface ResearchArtifactDraftMaterializationInput {
  readonly database: D1Database;
  readonly work_bucket: R2Bucket;
  readonly operation_id: string;
  readonly intent: OperationIntent;
  readonly expected_draft_head_revision: number | null;
  readonly artifact_ref: VersionedRef;
  readonly spec: ArtifactSpec;
  readonly evidence_freeze: EvidenceFreeze;
  readonly reference_manifest: AllowedReferenceManifest;
  readonly evidence_pack: ResearchEvidencePack;
  readonly synthesis_readback: CommittedResearchSynthesisOutputReadback;
  readonly section: ArtifactSectionRevision;
  readonly section_residency: ObjectResidencyKey;
  readonly referenced_objects: readonly ArtifactDraftReferencedObjectInput[];
  readonly manifest_residency: ObjectResidencyKey;
  readonly created_at: string;
  readonly now?: () => number;
}

export type ResearchArtifactDraftErrorCode =
  | "RESEARCH_ARTIFACT_DRAFT_INPUT_INVALID"
  | "RESEARCH_ARTIFACT_DRAFT_AUTHORITY_STALE"
  | "RESEARCH_ARTIFACT_DRAFT_EVIDENCE_INVALID";

export class ResearchArtifactDraftError extends Error {
  public readonly code: ResearchArtifactDraftErrorCode;

  public constructor(code: ResearchArtifactDraftErrorCode, message: string) {
    super(message);
    this.name = "ResearchArtifactDraftError";
    this.code = code;
  }
}

function fail(code: ResearchArtifactDraftErrorCode, message: string): never {
  throw new ResearchArtifactDraftError(code, message);
}

function sameRef(left: VersionedRef, right: VersionedRef): boolean {
  return left.id === right.id && left.revision === right.revision;
}

function refKey(ref: VersionedRef): string {
  return `${ref.id}:${ref.revision}`;
}

function strictCandidate(bytes: Uint8Array): SynthesisSectionCandidate {
  let text: string;
  try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
  catch { fail("RESEARCH_ARTIFACT_DRAFT_INPUT_INVALID", "SYNTHESIZE output encoding is invalid"); }
  let value: unknown;
  try { value = JSON.parse(text) as unknown; }
  catch { fail("RESEARCH_ARTIFACT_DRAFT_INPUT_INVALID", "SYNTHESIZE output is not JSON"); }
  if (value === null || typeof value !== "object" || Array.isArray(value)) fail("RESEARCH_ARTIFACT_DRAFT_INPUT_INVALID", "SYNTHESIZE candidate is not an object");
  const candidate = value as Record<string, unknown>;
  const keys = ["schema", "section_text", "cited_handle_refs"];
  if (Object.keys(candidate).some((key) => !keys.includes(key)) || keys.some((key) => !(key in candidate)) || candidate.schema !== CANDIDATE_SCHEMA ||
      typeof candidate.section_text !== "string" || candidate.section_text.length < 1 || !Array.isArray(candidate.cited_handle_refs) ||
      candidate.cited_handle_refs.length < 1 || candidate.cited_handle_refs.length > 512 || candidate.cited_handle_refs.some((ref) => !VersionedRefSchema.safeParse(ref).success)) {
    fail("RESEARCH_ARTIFACT_DRAFT_INPUT_INVALID", "SYNTHESIZE section candidate shape is invalid");
  }
  return candidate as unknown as SynthesisSectionCandidate;
}

function parseEvidencePack(pack: ResearchEvidencePack, expectedScope: VersionedRef, cited: readonly VersionedRef[]): void {
  if (!VersionedRefSchema.safeParse(pack.pack_ref).success || !VersionedRefSchema.safeParse(pack.scope_snapshot_ref).success ||
      !VersionedRefSchema.safeParse(pack.trace_ref).success || !sameRef(pack.scope_snapshot_ref, expectedScope) ||
      !Array.isArray(pack.resolved_evidence) || !Array.isArray(pack.omitted_candidates) || !Number.isSafeInteger(pack.total_utf8_bytes) || pack.total_utf8_bytes < 0) {
    fail("RESEARCH_ARTIFACT_DRAFT_EVIDENCE_INVALID", "EvidencePack is malformed or bound to another scope");
  }
  const present = new Set<string>();
  for (const item of pack.resolved_evidence) {
    const parsed = ResolvedEvidenceSchema.safeParse(item);
    if (!parsed.success || parsed.data.handle.terminal_state !== "LIVE") fail("RESEARCH_ARTIFACT_DRAFT_EVIDENCE_INVALID", "EvidencePack contains non-live evidence");
    const key = refKey(parsed.data.handle.handle_ref);
    if (present.has(key)) fail("RESEARCH_ARTIFACT_DRAFT_EVIDENCE_INVALID", "EvidencePack repeats an evidence handle");
    present.add(key);
  }
  for (const ref of cited) if (!present.has(refKey(ref))) fail("RESEARCH_ARTIFACT_DRAFT_EVIDENCE_INVALID", "cited handle is absent from EvidencePack");
}

function requiredObject(objects: readonly ArtifactDraftReferencedObjectInput[], objectRef: string, kind: ArtifactDraftReferencedObjectInput["object_kind"]): ArtifactDraftReferencedObjectInput {
  const matches = objects.filter((object) => object.object_ref === objectRef && object.object_kind === kind);
  if (matches.length !== 1) fail("RESEARCH_ARTIFACT_DRAFT_INPUT_INVALID", `missing unique ${kind} object`);
  return matches[0] as ArtifactDraftReferencedObjectInput;
}

/** Converts one committed SYNTHESIZE output into one DRAFT section. */
export async function materializeResearchArtifactDraft(input: ResearchArtifactDraftMaterializationInput): Promise<PrepareArtifactDraftResult> {
  const readback = input.synthesis_readback;
  if (typeof input.operation_id !== "string" || input.operation_id.length < 1 || readback.operation_id !== input.operation_id || readback.stage !== "SYNTHESIZE" ||
      readback.workflow_receipt.operation_id !== input.operation_id || readback.workflow_receipt.stage !== "SYNTHESIZE" ||
      readback.output.output_object_ref.length < 1 || !/^[a-f0-9]{64}$/u.test(readback.output.output_sha256)) {
    fail("RESEARCH_ARTIFACT_DRAFT_AUTHORITY_STALE", "SYNTHESIZE readback is not bound to the selected operation");
  }
  if (readback.output.readback_sha256 !== readback.output.output_sha256 || !Number.isSafeInteger(readback.output.output_size_bytes) ||
      readback.output.output_size_bytes < 1 || readback.bytes.byteLength !== readback.output.output_size_bytes ||
      await evidenceSha256Bytes(readback.bytes) !== readback.output.output_sha256) {
    fail("RESEARCH_ARTIFACT_DRAFT_EVIDENCE_INVALID", "SYNTHESIZE bytes differ from durable output digest");
  }
  const candidate = strictCandidate(readback.bytes);
  try {
    OperationIntentSchema.parse(input.intent);
    ArtifactSpecSchema.parse(input.spec);
    EvidenceFreezeSchema.parse(input.evidence_freeze);
    AllowedReferenceManifestSchema.parse(input.reference_manifest);
    ArtifactSectionRevisionSchema.parse(input.section);
    ObjectResidencyKeySchema.parse(input.section_residency);
    ObjectResidencyKeySchema.parse(input.manifest_residency);
    VersionedRefSchema.parse(input.artifact_ref);
  } catch {
    fail("RESEARCH_ARTIFACT_DRAFT_INPUT_INVALID", "materialization input failed its versioned contracts");
  }
  const now = input.now?.() ?? Date.now();
  if (!Number.isSafeInteger(now)) fail("RESEARCH_ARTIFACT_DRAFT_INPUT_INVALID", "materialization clock is invalid");
  const scope = input.spec.scope_snapshot_ref;
  if (!sameRef(scope, input.evidence_freeze.scope_snapshot_ref) || !sameRef(scope, input.reference_manifest.scope_snapshot_ref) || !sameRef(scope, input.evidence_pack.scope_snapshot_ref) ||
      readback.workflow_receipt.investigation_ref.id !== readback.investigation_ref.id || readback.model_attempt.authority.principal_ref !== input.intent.principal_ref ||
      !sameRef(readback.model_attempt.authority.scope_snapshot_ref, scope) || readback.model_attempt.output?.output_object_ref !== readback.output.output_object_ref ||
      readback.model_attempt.output?.output_sha256 !== readback.output.output_sha256) {
    fail("RESEARCH_ARTIFACT_DRAFT_AUTHORITY_STALE", "SYNTHESIZE lineage is not bound to the selected authority");
  }
  if (Date.parse(input.reference_manifest.expires_at) <= now) fail("RESEARCH_ARTIFACT_DRAFT_AUTHORITY_STALE", "reference manifest is expired");
  const { manifest_digest: manifestDigest, ...manifestPayload } = input.reference_manifest;
  if (await evidenceSha256(manifestPayload) !== manifestDigest) fail("RESEARCH_ARTIFACT_DRAFT_EVIDENCE_INVALID", "reference manifest digest is invalid");
  const citedKeys = new Set<string>();
  for (const ref of candidate.cited_handle_refs) {
    const key = refKey(ref);
    if (citedKeys.has(key) || !input.reference_manifest.allowed_evidence_handle_refs.some((allowed) => sameRef(allowed, ref)) ||
        !input.evidence_freeze.included_evidence.some((included) => sameRef(included.handle_ref, ref))) fail("RESEARCH_ARTIFACT_DRAFT_EVIDENCE_INVALID", "SYNTHESIZE cites an unverified handle");
    citedKeys.add(key);
  }
  parseEvidencePack(input.evidence_pack, scope, candidate.cited_handle_refs);
  const sectionBytes = new TextEncoder().encode(candidate.section_text);
  if (await evidenceSha256Bytes(sectionBytes) !== input.section.body_sha256) fail("RESEARCH_ARTIFACT_DRAFT_INPUT_INVALID", "section text differs from the server-selected section revision");
  for (const evidence of input.evidence_pack.resolved_evidence) {
    if (candidate.cited_handle_refs.some((ref) => sameRef(ref, evidence.handle.handle_ref)) && evidence.handle.expires_at !== undefined && Date.parse(evidence.handle.expires_at) <= now) fail("RESEARCH_ARTIFACT_DRAFT_AUTHORITY_STALE", "cited evidence handle is expired");
  }
  const dependencyRef = refKey(input.reference_manifest.manifest_ref);
  const dependency = requiredObject(input.referenced_objects, dependencyRef, "DEPENDENCY_MANIFEST");
  const ledger = requiredObject(input.referenced_objects, input.section.evidence_ledger_ref, "EVIDENCE_LEDGER");
  const verification = requiredObject(input.referenced_objects, input.section.verification_receipt_ref, "VERIFICATION_RECEIPT");
  let dependencyText: string;
  try { dependencyText = new TextDecoder("utf-8", { fatal: true }).decode(dependency.bytes); }
  catch { fail("RESEARCH_ARTIFACT_DRAFT_EVIDENCE_INVALID", "dependency manifest encoding is invalid"); }
  if (dependencyText !== canonicalEvidenceJson(input.reference_manifest)) fail("RESEARCH_ARTIFACT_DRAFT_EVIDENCE_INVALID", "dependency manifest bytes differ from the verified manifest");
  const revision: ArtifactRevision = ArtifactRevisionSchema.parse({
    artifact_ref: input.artifact_ref, spec_ref: input.spec.spec_ref, spec_digest: await canonicalDigest(input.spec),
    evidence_freeze_ref: input.evidence_freeze.freeze_ref, sections: [input.section], dependency_manifest_ref: dependencyRef,
    deterministic_export_refs: {}, status: "DRAFT", created_at: input.created_at,
  });
  return createArtifactDraftStore(input.database, input.work_bucket).prepare({
    intent: input.intent, expected_draft_head_revision: input.expected_draft_head_revision, spec: input.spec, revision,
    sections: [{ section: input.section, bytes: sectionBytes, residency: input.section_residency }],
    referenced_objects: [dependency, ledger, verification], manifest_residency: input.manifest_residency,
  });
}
