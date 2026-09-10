import {
  CoordinateMapSchema,
  ObjectResidencyKeySchema,
  type CoordinateMap,
  type NormalizedBundleManifest,
  type ObjectResidencyKey,
} from "@eliotr/contracts";
import {
  bufferBounded,
  canonicalNormalizedBundleKey,
  objectResidencyKeyDigest,
} from "@eliotr/platform-cloudflare";
import { MAX_CANONICAL_BYTES } from "@eliotr/retrieval";
import { evidenceChecksumHex, evidenceSha256Bytes } from "./canonical.js";
import { readAdmittedNormalizedManifest } from "./exhaustive-manifest.js";
import { readAdmittedNormalizedMarkdown } from "./content-store.js";
import { EvidenceRuntimeError, type EvidenceSourceAuthority } from "./types.js";

const MAX_COORDINATE_MAP_BYTES = MAX_CANONICAL_BYTES;
const MAX_COORDINATE_MAP_EXCERPT_BYTES = MAX_COORDINATE_MAP_BYTES * 4;

function fail(
  code: ConstructorParameters<typeof EvidenceRuntimeError>[0],
  message: string,
  options: ConstructorParameters<typeof EvidenceRuntimeError>[2] = {},
): never {
  throw new EvidenceRuntimeError(code, message, options);
}

function requireMapMetadata(object: R2Object, source: EvidenceSourceAuthority, digest: string): void {
  const checksum = object.checksums?.sha256;
  const metadata = object.customMetadata ?? {};
  if (
    checksum === undefined || evidenceChecksumHex(checksum) !== digest ||
    metadata.eliotr_immutable !== "true" || metadata.eliotr_sha256 !== digest ||
    metadata.eliotr_size_bytes !== String(object.size) ||
    metadata.source_namespace_id !== source.source_namespace_id ||
    metadata.source_owner_generation !== source.source_owner_generation ||
    metadata.admission_receipt_ref !== source.admission_receipt_ref
  ) {
    fail("EVIDENCE_OBJECT_INTEGRITY", "coordinate map immutable authority metadata mismatch", {
      invalidation_state: "BROKEN_INTEGRITY",
    });
  }
  if (object.httpMetadata?.contentType?.toLowerCase().startsWith("application/json") !== true) {
    fail("EVIDENCE_OBJECT_INTEGRITY", "coordinate map has an invalid media type", {
      invalidation_state: "BROKEN_INTEGRITY",
    });
  }
}

function requireStableObject(observed: R2Object | null, head: R2Object): void {
  if (
    observed === null || observed.key !== head.key || observed.size !== head.size ||
    observed.etag !== head.etag ||
    (head.version !== undefined && observed.version !== head.version) ||
    (head.httpEtag !== undefined && observed.httpEtag !== head.httpEtag)
  ) {
    fail("EVIDENCE_SETTLEMENT_UNCERTAIN", "coordinate map changed during pinned readback", {
      retryable: true,
      invalidation_state: "STALE",
    });
  }
}

function mapResidency(manifest: NormalizedBundleManifest, digest: string): ObjectResidencyKey {
  return ObjectResidencyKeySchema.parse({
    scope_domain_id: manifest.residency_and_disclosure.scope_domain_id,
    access_domain_id: manifest.residency_and_disclosure.access_domain_id,
    confidentiality_domain_id: manifest.residency_and_disclosure.confidentiality_domain_id,
    encryption_key_domain_id: manifest.residency_and_disclosure.encryption_key_domain_id,
    retention_domain_id: manifest.residency_and_disclosure.retention_domain_id,
    erasure_domain_id: manifest.residency_and_disclosure.erasure_domain_id,
    content_digest: { algorithm: "sha256", digest },
  });
}

function validateRanges(map: CoordinateMap, markdown: string, contentSize: number): Promise<void> {
  const bytes = new TextEncoder().encode(markdown);
  if (bytes.byteLength !== contentSize) {
    fail("EVIDENCE_OBJECT_INTEGRITY", "normalized content size changed during coordinate map read", {
      invalidation_state: "STALE",
    });
  }
  return (async () => {
    let totalExcerptBytes = 0;
    for (const entry of map.entries) {
      const start = entry.normalized_start_byte;
      const end = entry.normalized_end_byte;
      if (start >= end || end > bytes.byteLength) {
        fail("EVIDENCE_RANGE_INVALID", "coordinate map range is outside admitted normalized content");
      }
      totalExcerptBytes += end - start;
      if (totalExcerptBytes > MAX_COORDINATE_MAP_EXCERPT_BYTES) {
        fail("EVIDENCE_RANGE_INVALID", "coordinate map excerpt work exceeds its bounded total");
      }
      const excerpt = bytes.slice(start, end);
      try { new TextDecoder("utf-8", { fatal: true }).decode(excerpt); }
      catch (cause) { fail("EVIDENCE_RANGE_INVALID", "coordinate map range cuts a UTF-8 code point", { cause }); }
      if (await evidenceSha256Bytes(excerpt) !== entry.excerpt_sha256) {
        fail("EVIDENCE_OBJECT_INTEGRITY", "coordinate map excerpt digest disagrees with normalized content", {
          invalidation_state: "BROKEN_INTEGRITY",
        });
      }
    }
  })();
}

export interface CoordinateMapReadOptions {
  readonly require_current?: () => Promise<void>;
}

export interface AdmittedCoordinateMap {
  readonly map: CoordinateMap;
  readonly map_object_ref: string;
  readonly map_sha256: string;
  readonly map_object_residency_key_digest: string;
}

/** Read one admitted table-cell map; all map identity fields are derived outside the payload. */
export async function readAdmittedCoordinateMap(
  bucket: R2Bucket,
  source: EvidenceSourceAuthority,
  options: CoordinateMapReadOptions = {},
): Promise<AdmittedCoordinateMap> {
  await options.require_current?.();
  const { manifest } = await readAdmittedNormalizedManifest(bucket, source);
  if (!manifest.capabilities.tables || manifest.content.tables === undefined ||
      manifest.content.mappings === undefined || manifest.content.coordinate_map_digest === undefined ||
      (source.source_assurance_ceiling !== "QUALIFIED" && source.source_assurance_ceiling !== "EXACT")) {
    fail("EVIDENCE_PRECISION_UNSUPPORTED", "admitted manifest does not qualify table-cell coordinates");
  }
  const path = manifest.content.mappings;
  const digest = manifest.content.coordinate_map_digest;
  if (path === undefined || digest === undefined) {
    fail("EVIDENCE_PRECISION_UNSUPPORTED", "admitted normalized bundle has no coordinate map");
  }
  const residencyDigest = await objectResidencyKeyDigest(mapResidency(manifest, digest));
  const key = await canonicalNormalizedBundleKey(residencyDigest, {
    owner_system_id: source.owner_system_id,
    source_namespace_id: source.source_namespace_id,
    source_owner_generation: source.source_owner_generation,
    source_logical_id: source.source_id,
    source_revision_ref: source.source_revision_ref,
  }, path);
  const head = await bucket.head(key).catch(() => null);
  if (head === null) fail("EVIDENCE_OBJECT_NOT_FOUND", "admitted coordinate map is unavailable", { retryable: true });
  if (!Number.isSafeInteger(head.size) || head.size < 1 || head.size > MAX_COORDINATE_MAP_BYTES) {
    fail("EVIDENCE_RANGE_INVALID", "coordinate map exceeds its bounded object size");
  }
  requireMapMetadata(head, source, digest);
  const opened = await bucket.get(key, { onlyIf: { etagMatches: head.etag } });
  if (opened === null || !("body" in opened) || opened.body === undefined) {
    fail("EVIDENCE_SETTLEMENT_UNCERTAIN", "coordinate map conditional read returned no body", { retryable: true });
  }
  let bytes: Uint8Array;
  try { bytes = await bufferBounded(opened.body, MAX_COORDINATE_MAP_BYTES); }
  catch (cause) { fail("EVIDENCE_SETTLEMENT_UNCERTAIN", "coordinate map stream could not be bounded", { retryable: true, cause }); }
  requireStableObject(opened, head);
  if (bytes.byteLength !== head.size || await evidenceSha256Bytes(bytes) !== digest) {
    fail("EVIDENCE_OBJECT_INTEGRITY", "coordinate map bytes disagree with its admitted digest", {
      invalidation_state: "BROKEN_INTEGRITY",
    });
  }
  let value: unknown;
  try { value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
  catch (cause) { fail("EVIDENCE_INPUT_INVALID", "coordinate map is not valid UTF-8 JSON", { cause }); }
  const parsed = CoordinateMapSchema.safeParse(value);
  if (!parsed.success) fail("EVIDENCE_INPUT_INVALID", "coordinate map failed strict validation");
  const map = parsed.data;
  if (
    map.source_owner_system_id !== source.owner_system_id ||
    map.source_namespace_id !== source.source_namespace_id ||
    map.source_owner_generation !== source.source_owner_generation ||
    map.source_logical_id !== source.source_id ||
    map.source_revision_ref !== source.source_revision_ref ||
    map.source_content_sha256 !== source.content_sha256 ||
    map.normalized_content_path !== manifest.content.markdown
  ) {
    fail("EVIDENCE_LOCATOR_NOT_RESOLVABLE", "coordinate map source binding disagrees with admitted authority");
  }
  const content = await readAdmittedNormalizedMarkdown(bucket, source);
  await validateRanges(map, content.markdown, content.size_bytes);
  const finalHead = await bucket.head(key).catch(() => null);
  if (finalHead === null) {
    fail("EVIDENCE_SETTLEMENT_UNCERTAIN", "coordinate map disappeared during validation", { retryable: true });
  }
  requireStableObject(finalHead, head);
  requireMapMetadata(finalHead, source, digest);
  await options.require_current?.();
  return {
    map,
    map_object_ref: key,
    map_sha256: digest,
    map_object_residency_key_digest: residencyDigest,
  };
}
