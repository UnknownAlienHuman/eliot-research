import { NormalizedBundleManifestSchema, type NormalizedBundleManifest } from "@eliotr/contracts";
import { bufferBounded, canonicalNormalizedBundleKey, objectResidencyKeyDigest } from "@eliotr/platform-cloudflare";
import { evidenceChecksumHex, evidenceSha256Bytes } from "./canonical.js";
import { EvidenceRuntimeError, type EvidenceSourceAuthority } from "./types.js";

const MAX_MANIFEST_BYTES = 512 * 1024;

function requireManifestObject(object: R2Object, authority: EvidenceSourceAuthority): void {
  const checksum = object.checksums?.sha256;
  const metadata = object.customMetadata ?? {};
  if (object.key !== authority.normalized_artifact_ref || !Number.isSafeInteger(object.size) ||
      object.size < 1 || object.size > MAX_MANIFEST_BYTES || checksum === undefined ||
      metadata.eliotr_immutable !== "true" || metadata.eliotr_sha256 !== evidenceChecksumHex(checksum) ||
      metadata.eliotr_size_bytes !== String(object.size) ||
      metadata.source_namespace_id !== authority.source_namespace_id ||
      metadata.source_owner_generation !== authority.source_owner_generation ||
      metadata.admission_receipt_ref !== authority.admission_receipt_ref ||
      object.httpMetadata?.contentType?.toLowerCase().startsWith("application/json") !== true) {
    throw new EvidenceRuntimeError("EVIDENCE_OBJECT_INTEGRITY", "admitted normalized manifest identity is invalid", {
      invalidation_state: "BROKEN_INTEGRITY",
    });
  }
}

function requireSameManifestObject(observed: R2Object | null, head: R2Object): void {
  if (observed === null || observed.key !== head.key || observed.size !== head.size ||
      observed.etag !== head.etag || observed.version !== head.version ||
      observed.httpEtag !== head.httpEtag) {
    throw new EvidenceRuntimeError("EVIDENCE_SETTLEMENT_UNCERTAIN", "admitted manifest changed during readback", {
      retryable: true,
      invalidation_state: "STALE",
    });
  }
}

async function canonicalManifestKey(
  manifest: NormalizedBundleManifest,
  manifestDigest: string,
  authority: EvidenceSourceAuthority,
): Promise<string> {
  const residencyDigest = await objectResidencyKeyDigest({
    scope_domain_id: manifest.residency_and_disclosure.scope_domain_id,
    access_domain_id: manifest.residency_and_disclosure.access_domain_id,
    confidentiality_domain_id: manifest.residency_and_disclosure.confidentiality_domain_id,
    encryption_key_domain_id: manifest.residency_and_disclosure.encryption_key_domain_id,
    retention_domain_id: manifest.residency_and_disclosure.retention_domain_id,
    erasure_domain_id: manifest.residency_and_disclosure.erasure_domain_id,
    content_digest: { algorithm: "sha256", digest: manifestDigest },
  });
  return canonicalNormalizedBundleKey(residencyDigest, {
    owner_system_id: authority.owner_system_id,
    source_namespace_id: authority.source_namespace_id,
    source_owner_generation: authority.source_owner_generation,
    source_logical_id: authority.source_id,
    source_revision_ref: authority.source_revision_ref,
  }, "manifest.json");
}

/** Read the admitted manifest and its separately-resident normalized content object. */
export async function readAdmittedNormalizedManifest(
  bucket: R2Bucket,
  authority: EvidenceSourceAuthority,
): Promise<{ readonly manifest: NormalizedBundleManifest; readonly content_size: number }> {
  const head = await bucket.head(authority.normalized_artifact_ref).catch(() => null);
  if (head === null) {
    throw new EvidenceRuntimeError("EVIDENCE_OBJECT_NOT_FOUND", "admitted normalized manifest is unavailable", { retryable: true });
  }
  requireManifestObject(head, authority);
  const object = await bucket.get(authority.normalized_artifact_ref, { onlyIf: { etagMatches: head.etag } }).catch(() => null);
  if (object === null || !("body" in object) || object.body === undefined) {
    throw new EvidenceRuntimeError("EVIDENCE_SETTLEMENT_UNCERTAIN", "admitted normalized manifest conditional read failed", { retryable: true });
  }
  requireSameManifestObject(object, head);
  let bytes: Uint8Array;
  try {
    bytes = await bufferBounded(object.body, MAX_MANIFEST_BYTES);
  } catch (cause) {
    throw new EvidenceRuntimeError("EVIDENCE_SETTLEMENT_UNCERTAIN", "admitted normalized manifest stream exceeded its bound", { retryable: true, cause });
  }
  if (bytes.byteLength !== head.size) {
    throw new EvidenceRuntimeError("EVIDENCE_SETTLEMENT_UNCERTAIN", "admitted normalized manifest size changed during readback", { retryable: true });
  }
  const checksum = head.checksums?.sha256;
  const manifestDigest = await evidenceSha256Bytes(bytes);
  if (checksum === undefined || manifestDigest !== evidenceChecksumHex(checksum) ||
      manifestDigest !== (head.customMetadata ?? {}).eliotr_sha256) {
    throw new EvidenceRuntimeError("EVIDENCE_OBJECT_INTEGRITY", "admitted normalized manifest bytes disagree with its pinned checksum", {
      invalidation_state: "BROKEN_INTEGRITY",
    });
  }
  let value: unknown;
  try { value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
  catch (cause) {
    throw new EvidenceRuntimeError("EVIDENCE_INPUT_INVALID", "admitted normalized manifest is malformed", { retryable: true, cause });
  }
  const parsed = NormalizedBundleManifestSchema.safeParse(value);
  if (!parsed.success || parsed.data.origin.owner_system_id !== authority.owner_system_id ||
      parsed.data.origin.source_revision_ref !== authority.source_revision_ref ||
      parsed.data.origin.source_namespace_id !== authority.source_namespace_id ||
      parsed.data.origin.source_owner_generation !== authority.source_owner_generation ||
      parsed.data.source.logical_id !== authority.source_id ||
      parsed.data.content.markdown_sha256 !== authority.content_sha256 || !parsed.data.capabilities.text_ranges) {
    throw new EvidenceRuntimeError("EVIDENCE_LOCATOR_NOT_RESOLVABLE", "normalized manifest does not match admitted source authority");
  }
  const expectedManifestKey = await canonicalManifestKey(parsed.data, manifestDigest, authority);
  if (expectedManifestKey !== authority.normalized_artifact_ref) {
    throw new EvidenceRuntimeError("EVIDENCE_LOCATOR_NOT_RESOLVABLE", "admitted normalized manifest key is not derived from its immutable bytes");
  }
  const contentKey = await canonicalNormalizedBundleKey(authority.object_residency_key_digest, {
    owner_system_id: authority.owner_system_id,
    source_namespace_id: authority.source_namespace_id,
    source_owner_generation: authority.source_owner_generation,
    source_logical_id: authority.source_id,
    source_revision_ref: authority.source_revision_ref,
  }, "content.md");
  const content = await bucket.head(contentKey).catch(() => null);
  if (content === null || !Number.isSafeInteger(content.size) || content.size < 1) {
    throw new EvidenceRuntimeError("EVIDENCE_OBJECT_NOT_FOUND", "admitted normalized content is unavailable", { retryable: true });
  }
  const metadata = content.customMetadata ?? {};
  if (metadata.eliotr_sha256 !== undefined && metadata.eliotr_sha256 !== authority.content_sha256) {
    throw new EvidenceRuntimeError("EVIDENCE_LOCATOR_NOT_RESOLVABLE", "normalized content digest metadata conflicts with source authority");
  }
  if (metadata.eliotr_size_bytes !== undefined && metadata.eliotr_size_bytes !== String(content.size)) {
    throw new EvidenceRuntimeError("EVIDENCE_LOCATOR_NOT_RESOLVABLE", "normalized content size metadata conflicts with R2 authority");
  }
  const settled = await bucket.head(authority.normalized_artifact_ref).catch(() => null);
  requireSameManifestObject(settled, head);
  if (settled !== null) requireManifestObject(settled, authority);
  return { manifest: parsed.data, content_size: content.size };
}
