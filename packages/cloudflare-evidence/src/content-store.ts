// IMPLEMENTED_NOT_LIVE: ER-07 pinned normalized byte/line excerpt materialization; exact phrase/literal verification, coordinate-map table/cell resolution, tokenizer-fallback table, bounded regex scans and sharded exhaustive execution remain separate.
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
// A line anchor is not permission to scan an unbounded object or whole corpus.
const MAX_LINE_SCAN_BYTES = 4 * 1024 * 1024;
const MAX_LINE_SCAN_CHUNKS = 262_144;
type ByteRange = { readonly start: number; readonly end: number };
type LineAnchor = Extract<EvidenceAnchor, { readonly kind: "normalized_line_range" }>;

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

function requireByteRange(range: ByteRange): ByteRange {
  if (
    !Number.isSafeInteger(range.start) || !Number.isSafeInteger(range.end) ||
    range.start < 0 || range.end <= range.start
  ) {
    fail("EVIDENCE_RANGE_INVALID", "normalized byte range is invalid");
  }
  if (range.end - range.start > MAX_EXCERPT_BYTES) {
    fail("EVIDENCE_RANGE_INVALID", "requested evidence excerpt exceeds the hard byte limit");
  }
  return { start: range.start, end: range.end };
}

function captureAnchor(anchor: EvidenceAnchor): ByteRange | LineAnchor {
  if (anchor.kind === "normalized_byte_range") return requireByteRange(anchor);
  if (anchor.kind !== "normalized_line_range") {
    fail(
      "EVIDENCE_PRECISION_UNSUPPORTED",
      "page, table and code anchors require a verified coordinate map",
    );
  }
  if (
    !Number.isSafeInteger(anchor.start_line) || !Number.isSafeInteger(anchor.end_line) ||
    anchor.start_line < 1 || anchor.end_line < anchor.start_line
  ) {
    fail("EVIDENCE_RANGE_INVALID", "normalized line range is invalid");
  }
  // Do not retain caller-owned coordinates across R2 awaits.
  return { kind: "normalized_line_range", start_line: anchor.start_line, end_line: anchor.end_line };
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

function requireSameObject(observed: R2Object | null, head: R2Object): void {
  if (
    observed === null || observed.key !== head.key || observed.version !== head.version ||
    observed.etag !== head.etag || observed.httpEtag !== head.httpEtag || observed.size !== head.size
  ) {
    fail("EVIDENCE_SETTLEMENT_UNCERTAIN", "R2 object changed during pinned evidence readback", {
      retryable: true,
      invalidation_state: "STALE",
    });
  }
}

async function openRange(
  bucket: R2Bucket, key: string, source: EvidenceSourceAuthority,
  head: R2Object, range: ByteRange,
): Promise<R2ObjectBody> {
  const length = range.end - range.start;
  const opened = await bucket.get(key, {
    onlyIf: { etagMatches: head.httpEtag },
    range: { offset: range.start, length },
  });
  if (opened === null || !("body" in opened) || opened.body === undefined) {
    fail("EVIDENCE_SETTLEMENT_UNCERTAIN", "conditional R2 range read did not return body bytes", {
      retryable: true,
      invalidation_state: "STALE",
    });
  }
  try {
    requireSameObject(opened, head);
    requireObjectMetadata(opened, source);
    const observedRange = opened.range;
    if (
      observedRange === undefined || !("offset" in observedRange) ||
      observedRange.offset !== range.start || observedRange.length !== length
    ) {
      fail("EVIDENCE_RANGE_INVALID", "R2 returned a different byte range");
    }
    return opened;
  } catch (error) {
    try { await opened.body.cancel(); } catch { /* preserve the authority error */ }
    throw error;
  }
}

/** Seek LF-delimited, one-based inclusive normalized lines without retaining the prefix.
 * CRLF and BOM bytes are not rewritten; a final LF does not create a nonempty extra line.
 * The located interval is reread independently under the same R2 object pin.
 */
async function locateLines(
  opened: R2ObjectBody, anchor: LineAnchor, scanLength: number, objectSize: number,
): Promise<ByteRange> {
  const reader = opened.body.getReader();
  let offset = 0;
  let line = 1;
  let chunks = 0;
  let start: number | undefined = anchor.start_line === 1 ? 0 : undefined;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      chunks += 1;
      if (chunks > MAX_LINE_SCAN_CHUNKS) {
        fail("EVIDENCE_PRECISION_UNSUPPORTED", "line seek exceeds the hard stream chunk limit");
      }
      if (!(chunk.value instanceof Uint8Array) || chunk.value.byteLength > scanLength - offset) {
        fail("EVIDENCE_RANGE_INVALID", "line seek returned a non-byte or oversized stream chunk");
      }
      for (let index = 0; index < chunk.value.byteLength; index += 1) {
        const end = offset + index + 1;
        if (start !== undefined && end - start > MAX_EXCERPT_BYTES) {
          fail("EVIDENCE_RANGE_INVALID", "requested evidence lines exceed the hard excerpt byte limit");
        }
        if (chunk.value[index] !== 10) continue;
        if (line === anchor.end_line && start !== undefined) {
          return requireByteRange({ start, end });
        }
        line += 1;
        if (line === anchor.start_line) start = end;
      }
      offset += chunk.value.byteLength;
    }
    if (offset !== scanLength) {
      fail("EVIDENCE_SETTLEMENT_UNCERTAIN", "line seek ended before its declared R2 range", {
        retryable: true,
      });
    }
    if (offset < objectSize) {
      fail("EVIDENCE_PRECISION_UNSUPPORTED", "line anchor requires a scan beyond the hard byte limit");
    }
    if (start === undefined || start === offset || line !== anchor.end_line) {
      fail("EVIDENCE_RANGE_INVALID", "requested lines do not exist in the admitted source object");
    }
    return requireByteRange({ start, end: offset });
  } finally {
    // Also stop the prefix read as soon as the selected line is located.
    try { await reader.cancel(); } catch { /* preserve the original result */ }
    reader.releaseLock();
  }
}

export interface R2EvidenceContentDependencies {
  readonly evidence_bucket: R2Bucket;
}

export function createR2EvidenceContentPort(
  dependencies: R2EvidenceContentDependencies,
): EvidenceContentPort {
  return {
    async materialize(rawSource, rawAnchor): Promise<MaterializedEvidenceExcerpt> {
      const anchor = captureAnchor(rawAnchor);
      const source = { ...rawSource };
      const bucket = dependencies.evidence_bucket;
      const key = await normalizedContentKey(source);
      const head = await bucket.head(key);
      if (head === null) {
        fail("EVIDENCE_OBJECT_NOT_FOUND", "normalized Evidence object is missing", {
          retryable: true,
          invalidation_state: "BROKEN_INTEGRITY",
        });
      }
      requireObjectMetadata(head, source);
      if (
        head.key !== key || typeof head.version !== "string" || head.version.length === 0 ||
        typeof head.etag !== "string" || head.etag.length === 0 ||
        typeof head.httpEtag !== "string" || head.httpEtag.length === 0
      ) {
        fail("EVIDENCE_OBJECT_INTEGRITY", "R2 object identity is missing or differs from the pinned key", {
          invalidation_state: "BROKEN_INTEGRITY",
        });
      }
      let range: ByteRange;
      if ("kind" in anchor) {
        const scanLength = Math.min(head.size, MAX_LINE_SCAN_BYTES);
        const prefix = await openRange(bucket, key, source, head, { start: 0, end: scanLength });
        range = await locateLines(prefix, anchor, scanLength, head.size);
      } else {
        range = anchor;
      }
      if (range.end > head.size) {
        fail("EVIDENCE_RANGE_INVALID", "evidence anchor exceeds the admitted source object");
      }
      const opened = await openRange(bucket, key, source, head, range);
      const length = range.end - range.start;
      const bytes = await bufferBounded(opened.body, MAX_EXCERPT_BYTES);
      if (bytes.byteLength !== length) {
        fail("EVIDENCE_SETTLEMENT_UNCERTAIN", "R2 range streamed length differs from authority", {
          retryable: true,
        });
      }
      let exactExcerpt: string;
      try { exactExcerpt = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes); }
      catch (cause) {
        fail("EVIDENCE_RANGE_INVALID", "evidence byte range cuts through invalid UTF-8 boundaries", { cause });
      }
      const excerptSha256 = await evidenceSha256Bytes(bytes);
      const objectRefDigest = await evidenceSha256(key);
      // A matching GET does not cover replacement/deletion while its body was streaming.
      const settled = await bucket.head(key);
      requireSameObject(settled, head);
      if (settled !== null) requireObjectMetadata(settled, source);
      return {
        exact_excerpt: exactExcerpt,
        excerpt_sha256: excerptSha256,
        excerpt_byte_length: bytes.byteLength,
        normalized_object_ref: key,
        normalized_object_ref_digest: objectRefDigest,
        source_object_size: head.size,
        source_object_sha256: source.content_sha256,
      };
    },
  };
}
