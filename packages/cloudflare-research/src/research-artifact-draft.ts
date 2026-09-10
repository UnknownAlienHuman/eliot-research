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
  type ArtifactRevision,
  type ArtifactSectionRevision,
  type ArtifactSpec,
  type AllowedReferenceManifest,
  type EvidenceFreeze,
  type ObjectResidencyKey,
  type OperationIntent,
  type VersionedRef,
} from "@eliotr/contracts";
import { canonicalEvidenceJson, evidenceSha256Bytes } from "@eliotr/cloudflare-evidence";
import { canonicalDigest } from "@eliotr/platform-cloudflare";
import {
  createArtifactDraftStore,
  type ArtifactDraftReferencedObjectInput,
  type PrepareArtifactDraftResult,
} from "./artifact-draft.js";
import type { ResearchEvidencePack } from "./research-reference-manifest.js";

const CANDIDATE_SCHEMA = "eliotr.research.synthesis-output.v1" as const;
const REF_KEY = (ref: VersionedRef): string => `${ref.id}:${ref.revision}`;

/**
 * The only model-to-section boundary accepted here.  The caller must obtain
 * this value from the committed SYNTHESIZE readback; this module does not
 * treat a caller-supplied flag as evidence that the readback was committed.
 */
export interface VerifiedSynthesisOutput {
  readonly schema: typeof CANDIDATE_SCHEMA;
  readonly output_ref: VersionedRef;
  readonly output_sha256: string;
  readonly operation_id: string;
  readonly principal_ref: string;
  readonly scope_snapshot_ref: VersionedRef;
  readonly evidence_freeze_ref: VersionedRef;
  readonly manifest_ref: VersionedRef;
  readonly spec_ref: VersionedRef;
  readonly section_text: string;
  readonly cited_handle_refs: readonly VersionedRef[];
}

export interface ResearchArtifactDraftMaterializationInput {
  readonly database: D1Database;
  readonly work_bucket: R2Bucket;
  readonly intent: OperationIntent;
  readonly expected_draft_head_revision: number | null;
  readonly artifact_ref: VersionedRef;
  readonly spec: ArtifactSpec;
  readonly evidence_freeze: EvidenceFreeze;
  readonly reference_manifest: AllowedReferenceManifest;
  readonly evidence_pack: ResearchEvidencePack;
  readonly synthesis: VerifiedSynthesisOutput;
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

function isRef(value: unknown): value is VersionedRef {
  return VersionedRefSchema.safeParse(value).success;
}

function strictCandidate(value: unknown): VerifiedSynthesisOutput {
  if (value === null || typeof value !== "object" || Array.isArray(value)) fail("RESEARCH_ARTIFACT_DRAFT_INPUT_INVALID", "SYNTHESIZE output is not an object");
  const candidate = value as Record<string, unknown>;
  const keys = ["schema", "output_ref", "output_sha256", "operation_id", "principal_ref", "scope_snapshot_ref", "evidence_freeze_ref", "manifest_ref", "spec_ref", "section_text", "cited_handle_refs"];
  if (Object.keys(candidate).some((key) => !keys.includes(key)) || keys.some((key) => !(key in candidate))) fail("RESEARCH_ARTIFACT_DRAFT_INPUT_INVALID", "SYNTHESIZE output shape is not exact");
  if (candidate.schema !== CANDIDATE_SCHEMA || !isRef(candidate.output_ref) || !isRef(candidate.scope_snapshot_ref) || !isRef(candidate.evidence_freeze_ref) || !isRef(candidate.manifest_ref) || !isRef(candidate.spec_ref) ||
      typeof candidate.output_sha256 !== "string" || !/^[a-f0-9]{64}$/u.test(candidate.output_sha256) ||
      typeof candidate.operation_id !== "string" || candidate.operation_id.length < 1 || candidate.operation_id.length > 256 ||
      typeof candidate.principal_ref !== "string" || candidate.principal_ref.length < 1 || candidate.principal_ref.length > 256 ||
      typeof candidate.section_text !== "string" || candidate.section_text.length < 1 ||
      !Array.isArray(candidate.cited_handle_refs) || candidate.cited_handle_refs.length < 1 || candidate.cited_handle_refs.length > 512 ||
      candidate.cited_handle_refs.some((ref) => !isRef(ref))) {
    fail("RESEARCH_ARTIFACT_DRAFT_INPUT_INVALID", "SYNTHESIZE output fields are invalid");
  }
  return candidate as unknown as VerifiedSynthesisOutput;
}

function parsePack(pack: ResearchEvidencePack, expectedScope: VersionedRef, cited: readonly VersionedRef[]): void {
  if (!isRef(pack.pack_ref) || !isRef(pack.scope_snapshot_ref) || !isRef(pack.trace_ref) || !sameRef(pack.scope_snapshot_ref, expectedScope) ||
      !Array.isArray(pack.resolved_evidence) || !Array.isArray(pack.omitted_candidates) || !Number.isSafeInteger(pack.total_utf8_bytes) || pack.total_utf8_bytes < 0) {
    fail("RESEARCH_ARTIFACT_DRAFT_EVIDENCE_INVALID", "EvidencePack is malformed or bound to another scope");
  }
  const seen = new Set<string>();
  for (const item of pack.resolved_evidence) {
    const parsed = ResolvedEvidenceSchema.safeParse(item);
    if (!parsed.success || parsed.data.handle.terminal_state !== "LIVE") fail("RESEARCH_ARTIFACT_DRAFT_EVIDENCE_INVALID", "EvidencePack contains non-live evidence");
    const key = REF_KEY(parsed.data.handle.handle_ref);
    if (seen.has(key)) fail("RESEARCH_ARTIFACT_DRAFT_EVIDENCE_INVALID", "EvidencePack repeats an evidence handle");
    seen.add(key);
  }
  for (const ref of cited) if (!seen.has(REF_KEY(ref))) fail("RESEARCH_ARTIFACT_DRAFT_EVIDENCE_INVALID", "SYNTHESIZE cites a handle absent from its EvidencePack");
}

function exactObject(
  objects: readonly ArtifactDraftReferencedObjectInput[],
  ref: string,
  kind: ArtifactDraftReferencedObjectInput["object_kind"],
): ArtifactDraftReferencedObjectInput {
  const matches = objects.filter((object) => object.object_ref === ref && object.object_kind === kind);
  if (matches.length !== 1) fail("RESEARCH_ARTIFACT_DRAFT_INPUT_INVALID", `missing unique ${kind} object`);
  return matches[0] as ArtifactDraftReferencedObjectInput;
}

/** Materializes exactly one server-verified SYNTHESIZE section as a DRAFT. */
export async function materializeResearchArtifactDraft(
  input: ResearchArtifactDraftMaterializationInput,
): Promise<PrepareArtifactDraftResult> {
  const candidate = strictCandidate(input.synthesis);
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
  const scopeRef = input.spec.scope_snapshot_ref;
  if (!sameRef(scopeRef, input.evidence_freeze.scope_snapshot_ref) || !sameRef(scopeRef, input.reference_manifest.scope_snapshot_ref) ||
      !sameRef(scopeRef, input.evidence_pack.scope_snapshot_ref) || !sameRef(scopeRef, candidate.scope_snapshot_ref) ||
      !sameRef(input.evidence_freeze.freeze_ref, candidate.evidence_freeze_ref) || !sameRef(input.reference_manifest.manifest_ref, candidate.manifest_ref) ||
      !sameRef(input.spec.spec_ref, candidate.spec_ref) || candidate.principal_ref !== input.intent.principal_ref) {
    fail("RESEARCH_ARTIFACT_DRAFT_AUTHORITY_STALE", "SYNTHESIZE output authority bindings differ");
  }
  if (Date.parse(input.reference_manifest.expires_at) <= now) fail("RESEARCH_ARTIFACT_DRAFT_AUTHORITY_STALE", "reference manifest is expired");
  const citedKeys = new Set<string>();
  for (const ref of candidate.cited_handle_refs) {
    const key = REF_KEY(ref);
    if (citedKeys.has(key) || !input.reference_manifest.allowed_evidence_handle_refs.some((allowed) => sameRef(allowed, ref)) ||
        !input.evidence_freeze.included_evidence.some((included) => sameRef(included.handle_ref, ref))) {
      fail("RESEARCH_ARTIFACT_DRAFT_EVIDENCE_INVALID", "SYNTHESIZE cites an unverified handle");
    }
    citedKeys.add(key);
  }
  parsePack(input.evidence_pack, scopeRef, candidate.cited_handle_refs);
  const textBytes = new TextEncoder().encode(candidate.section_text);
  if (await evidenceSha256Bytes(textBytes) !== candidate.output_sha256 || candidate.output_sha256 !== input.section.body_sha256 ||
      input.section.body_object_ref.length < 1) fail("RESEARCH_ARTIFACT_DRAFT_INPUT_INVALID", "SYNTHESIZE text does not match section digest");
  for (const evidence of input.evidence_pack.resolved_evidence) {
    if (candidate.cited_handle_refs.some((ref) => sameRef(ref, evidence.handle.handle_ref)) && evidence.handle.expires_at !== undefined && Date.parse(evidence.handle.expires_at) <= now) {
      fail("RESEARCH_ARTIFACT_DRAFT_AUTHORITY_STALE", "cited evidence handle is expired");
    }
  }
  const dependencyRef = REF_KEY(input.reference_manifest.manifest_ref);
  const dependency = exactObject(input.referenced_objects, dependencyRef, "DEPENDENCY_MANIFEST");
  const ledger = exactObject(input.referenced_objects, input.section.evidence_ledger_ref, "EVIDENCE_LEDGER");
  const verification = exactObject(input.referenced_objects, input.section.verification_receipt_ref, "VERIFICATION_RECEIPT");
  let storedManifest: string;
  try { storedManifest = new TextDecoder("utf-8", { fatal: true }).decode(dependency.bytes); }
  catch { fail("RESEARCH_ARTIFACT_DRAFT_EVIDENCE_INVALID", "dependency manifest encoding is invalid"); }
  if (storedManifest !== canonicalEvidenceJson(input.reference_manifest)) fail("RESEARCH_ARTIFACT_DRAFT_EVIDENCE_INVALID", "dependency manifest bytes differ from verified manifest");
  const revision: ArtifactRevision = ArtifactRevisionSchema.parse({
    artifact_ref: input.artifact_ref,
    spec_ref: input.spec.spec_ref,
    spec_digest: await canonicalDigest(input.spec),
    evidence_freeze_ref: input.evidence_freeze.freeze_ref,
    sections: [input.section],
    dependency_manifest_ref: dependencyRef,
    deterministic_export_refs: {},
    status: "DRAFT",
    created_at: input.created_at,
  });
  const result = await createArtifactDraftStore(input.database, input.work_bucket).prepare({
    intent: input.intent,
    expected_draft_head_revision: input.expected_draft_head_revision,
    spec: input.spec,
    revision,
    sections: [{ section: input.section, bytes: textBytes, residency: input.section_residency }],
    referenced_objects: [dependency, ledger, verification],
    manifest_residency: input.manifest_residency,
  });
  return result;
}
