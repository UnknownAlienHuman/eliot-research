import { NormalizedBundleManifestSchema, type NormalizedBundleManifest } from "@eliotr/contracts";
import { canonicalNormalizedBundleKey } from "@eliotr/platform-cloudflare";
import { EvidenceRuntimeError, type EvidenceSourceAuthority } from "./types.js";

/** Read the admitted manifest and its separately-resident normalized content object. */
export async function readAdmittedNormalizedManifest(
  bucket: R2Bucket,
  authority: EvidenceSourceAuthority,
): Promise<{ readonly manifest: NormalizedBundleManifest; readonly content_size: number }> {
  const object = await bucket.get(authority.normalized_artifact_ref).catch(() => null);
  if (object === null || object.size > 512 * 1024) {
    throw new EvidenceRuntimeError("EVIDENCE_OBJECT_NOT_FOUND", "admitted normalized manifest is unavailable", { retryable: true });
  }
  let value: unknown;
  try { value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(await object.arrayBuffer())); }
  catch (cause) {
    throw new EvidenceRuntimeError("EVIDENCE_INPUT_INVALID", "admitted normalized manifest is malformed", { retryable: true, cause });
  }
  const parsed = NormalizedBundleManifestSchema.safeParse(value);
  if (!parsed.success || parsed.data.origin.owner_system_id !== authority.owner_system_id ||
      parsed.data.origin.source_revision_ref !== authority.source_revision_ref ||
      parsed.data.origin.source_namespace_id !== authority.source_namespace_id ||
      parsed.data.origin.source_owner_generation !== authority.source_owner_generation ||
      parsed.data.content.markdown_sha256 !== authority.content_sha256 || !parsed.data.capabilities.text_ranges) {
    throw new EvidenceRuntimeError("EVIDENCE_LOCATOR_NOT_RESOLVABLE", "normalized manifest does not match admitted source authority");
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
  return { manifest: parsed.data, content_size: content.size };
}
