import { AllowedReferenceManifestSchema, type VersionedRef } from "@eliotr/contracts";
import { canonicalJson } from "@eliotr/platform-cloudflare";
import {
  decodeArtifactDraftVerification,
  type ArtifactDraftVerificationRecord,
} from "./artifact-draft-verification.js";

export interface ArtifactDraftSectionCitationsRead {
  readonly artifact_ref: VersionedRef;
  readonly section_ref: VersionedRef;
  readonly scope_snapshot_ref: VersionedRef;
  readonly verification_receipt_ref: string;
  readonly semantic_verification: "NOT_EXECUTED";
  readonly cited_evidence: readonly Pick<ArtifactDraftVerificationRecord["cited_evidence"][number], "handle_ref" | "excerpt_sha256">[];
}

export interface ArtifactDraftSectionCitationsContext {
  readonly artifact_ref: VersionedRef;
  readonly evidence_freeze_ref: VersionedRef;
  readonly section_ref: VersionedRef;
  readonly section_sha256: string;
  readonly scope_snapshot_ref: VersionedRef;
  readonly scope_snapshot_digest: string;
  readonly dependency_manifest_ref: string;
  readonly dependency_bytes: Uint8Array;
  readonly verification_receipt_ref: string;
  readonly verification_bytes: Uint8Array;
}

export class ArtifactDraftSectionCitationsError extends Error {
  public readonly stale: boolean;

  public constructor(message: string, stale = false) {
    super(message);
    this.name = "ArtifactDraftSectionCitationsError";
    this.stale = stale;
  }
}

function fail(message: string, stale = false): never {
  throw new ArtifactDraftSectionCitationsError(message, stale);
}

function refKey(ref: VersionedRef): string {
  return `${ref.id}:${ref.revision}`;
}

export async function readArtifactDraftSectionCitations(
  input: ArtifactDraftSectionCitationsContext,
): Promise<ArtifactDraftSectionCitationsRead> {
  let dependencyText: string;
  let dependency: ReturnType<typeof AllowedReferenceManifestSchema.parse>;
  try {
    dependencyText = new TextDecoder("utf-8", { fatal: true }).decode(input.dependency_bytes);
    const parsed = AllowedReferenceManifestSchema.parse(JSON.parse(dependencyText));
    if (canonicalJson(parsed) !== dependencyText) throw new Error("reference manifest is not canonical");
    dependency = parsed;
  } catch {
    fail("draft reference manifest is invalid");
  }
  let verification;
  try {
    verification = await decodeArtifactDraftVerification(input.verification_bytes, input.verification_receipt_ref);
  } catch {
    fail("draft verification receipt is invalid");
  }
  const record = verification.record;
  const allowed = new Set(dependency.allowed_evidence_handle_refs.map(refKey));
  if (record.section_sha256 !== input.section_sha256 || refKey(record.freeze_ref) !== refKey(input.evidence_freeze_ref) ||
      refKey(record.manifest_ref) !== `${dependency.manifest_ref.id}:${dependency.manifest_ref.revision}` ||
      record.manifest_sha256 !== dependency.manifest_digest || refKey(record.manifest_ref) !== input.dependency_manifest_ref ||
      refKey(dependency.scope_snapshot_ref) !== refKey(input.scope_snapshot_ref) ||
      record.cited_evidence.some((item) => !allowed.has(refKey(item.handle_ref)))) {
    fail("draft citation lineage is inconsistent");
  }
  if (record.cited_evidence.some((item) => item.scope_snapshot_digest !== input.scope_snapshot_digest)) {
    fail("draft citation scope is stale", true);
  }
  return {
    artifact_ref: input.artifact_ref,
    section_ref: input.section_ref,
    scope_snapshot_ref: input.scope_snapshot_ref,
    verification_receipt_ref: input.verification_receipt_ref,
    semantic_verification: record.semantic_verification,
    cited_evidence: record.cited_evidence.map(({ handle_ref, excerpt_sha256 }) => ({ handle_ref, excerpt_sha256 })),
  };
}
