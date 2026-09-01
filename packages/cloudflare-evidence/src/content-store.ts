import {
  bufferBounded,
  canonicalNormalizedBundleKey,
} from "@eliotr/platform-cloudflare";
import {
  evidenceChecksumHex,
  evidenceSha256,
  evidenceSha256Bytes,
} from "./canonical.js";
import {
  EvidenceRuntimeError,
  type EvidenceContentPort,
  type EvidenceSourceAuthority,
  type MaterializedEvidenceExcerpt,
} from "./types.js";
import type { EvidenceAnchor } from "@eliotr/contracts";

const MAX_EXCERPT_BYTES = 256 * 1024;

function fail(
  code: EvidenceRuntimeError["code"],
  message: string,
  options: ConstructorParameters<typeof EvidenceRuntimeError>[2] = {},
): never {
  throw new EvidenceRuntimeError(code, message, options);
}

async function normalizedContentKey(source: EvidenceSourceAuthority): Promise<string> {
  return canonicalNormalizedBundleKey(
    source.object_residency_key_digest,
    {
      owner_system_id: source.owner_system_id,
      source_namespace_id: source.source_namespace_id,
      source_owner_generation: source.source_owner_generation,
      source_logical_id: source.source_id,
      source_revision_ref: source.source_revision_ref,
    },
    "content.md",
  );
}

function requireByteRange(anchor: EvidenceAnchor): { readonly start: number; readonly end: number } {
  if (anchor.kind !== "normalized_byte_range") {
    fail(
      "EVIDENCE_PRECISION_UNSUPPORTED",
      "only normalized byte anchors are materializable without a verified coordinate map",
    );
  }
  if (!Number.isSafeInteger(anchor.start) || !Number.isSafeInteger(anchor.end) || anchor.end <= anchor.start) {
    fail("EVIDENCE_RANGE_INVALID", "normalized byte range is invalid");
  }
  if (anchor.end - anchor.start > MAX_EXCERPT_BYTES) {
    fail("EVIDENCE_RANGE_INVALID", "requested evidence excerpt exceeds the hard byte limit");
  }
  return anchor;
}

function requireStoredChecksum(object: R2Object, expected: string): void {
  const stored = object.checksums.sha256;
  if (stored === undefined || evidenceChecksumHex(stored) !== expected) {
    fail(
      "EVIDENCE_OBJECT_INTEGRITY",
      "R2 object lacks the admitted full-object SHA-256 checksum",
      { invalidation_state: "BROKEN_INTEGRITY" },
    );
  }
}

function requireObjectMetadata(object: R2Object, source: EvidenceSourceAuthority): void {
  if (!Number.isSafeInteger(object.size) || object.size < 1) {
    fail("EVIDENCE_OBJECT_INTEGRITY", "R2 object size is invalid", {
      invalidation_state: "BROKEN_INTEGRITY",
    });
  }
  requireStoredChecksum(object, source.content_sha256);
  const metadata = object.customMetadata ?? {};
  if (
    metadata.eliotr_immutable !== "true" ||
    metadata.eliotr_sha256 !== source.content_sha256 ||
    metadata.eliotr_size_bytes !== String(object.size) ||
    metadata.source_namespace_id !== source.source_namespace_id ||
    metadata.source_owner_generation !== source.source_owner_generation ||
    metadata.admission_receipt_ref !== source.admission_receipt_ref
  ) {
    fail("EVIDENCE_OBJECT_INTEGRITY", "R2 immutable authority metadata mismatch", {
      invalidation_state: "BROKEN_INTEGRITY",
    });
  }
  const contentType = object.httpMetadata?.contentType;
  if (contentType === undefined || !contentType.toLowerCase().startsWith("text/markdown")) {
    fail("EVIDENCE_OBJECT_INTEGRITY", "normalized evidence object has an invalid media type", {
      invalidation_state: "BROKEN_INTEGRITY",
    });
  }
}

export interface R2EvidenceContentDependencies {
  readonly evidence_bucket: R2Bucket;
}

export function createR2EvidenceContentPort(
  dependencies: R2EvidenceContentDependencies,
): EvidenceContentPort {
  return {
    async materialize(source, anchor): Promise<MaterializedEvidenceExcerpt> {
      const range = requireByteRange(anchor);
      const key = await normalizedContentKey(source);
      const head = await dependencies.evidence_bucket.head(key);
      if (head === null) {
        fail("EVIDENCE_OBJECT_NOT_FOUND", "normalized Evidence object is missing", {
          retryable: true,
          invalidation_state: "BROKEN_INTEGRITY",
        });
      }
      requireObjectMetadata(head, source);
      if (range.end > head.size) {
        fail("EVIDENCE_RANGE_INVALID", "evidence anchor exceeds the admitted source object");
      }
      const length = range.end - range.start;
      const opened = await dependencies.evidence_bucket.get(key, {
        onlyIf: { etagMatches: head.httpEtag },
        range: { offset: range.start, length },
      });
      if (opened === null || !("body" in opened)) {
        fail("EVIDENCE_SETTLEMENT_UNCERTAIN", "conditional R2 range read did not return body bytes", {
          retryable: true,
          invalidation_state: "STALE",
        });
      }
      requireObjectMetadata(opened, source);
      const observedRange = opened.range;
      if (
        observedRange === undefined ||
        !("offset" in observedRange) ||
        observedRange.offset !== range.start ||
        observedRange.length !== length
      ) {
        try { await opened.body.cancel(); } catch { /* preserve the authority error */ }
        fail("EVIDENCE_RANGE_INVALID", "R2 returned a different byte range");
      }
      const bytes = await bufferBounded(opened.body, MAX_EXCERPT_BYTES);
      if (bytes.byteLength !== length) {
        fail("EVIDENCE_SETTLEMENT_UNCERTAIN", "R2 range streamed length differs from authority", {
          retryable: true,
        });
      }
      let exactExcerpt: string;
      try { exactExcerpt = new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
      catch (cause) {
        fail("EVIDENCE_RANGE_INVALID", "evidence byte range cuts through invalid UTF-8 boundaries", { cause });
      }
      const excerptSha256 = await evidenceSha256Bytes(bytes);
      return {
        exact_excerpt: exactExcerpt,
        excerpt_sha256: excerptSha256,
        excerpt_byte_length: bytes.byteLength,
        normalized_object_ref: key,
        normalized_object_ref_digest: await evidenceSha256(key),
        source_object_size: head.size,
        source_object_sha256: source.content_sha256,
      };
    },
  };
}
