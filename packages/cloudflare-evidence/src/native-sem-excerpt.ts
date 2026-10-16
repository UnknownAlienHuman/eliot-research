import type { LocatorCandidate } from "@eliotr/contracts";
import { evidenceSha256Bytes, evidenceUtf8Bytes } from "./canonical.js";
import type { CandidateAnchorAuthority, MaterializedEvidenceExcerpt } from "./types.js";

/** Called only after the admitted full section and its locator digest have been verified. */
export async function narrowNativeSemExcerpt(
  candidate: LocatorCandidate,
  authority: CandidateAnchorAuthority,
  section: MaterializedEvidenceExcerpt,
): Promise<{ readonly anchorAuthority: CandidateAnchorAuthority; readonly materialized: MaterializedEvidenceExcerpt }> {
  const unchanged = { anchorAuthority: authority, materialized: section };
  if (candidate.lane !== "SEM" || candidate.metadata.provider !== "cloudflare_ai_search" ||
      candidate.metadata.provider_chunk_type !== "text" || candidate.index_generation !== authority.projection_generation ||
      authority.anchor.kind !== "normalized_byte_range" || candidate.preview.length === 0) return unchanged;

  const bytes = evidenceUtf8Bytes(section.exact_excerpt);
  const needle = evidenceUtf8Bytes(candidate.preview);
  const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
  // TextEncoder replaces lone surrogates. Never mistake that replacement for an exact locator.
  if (decoder.decode(bytes) !== section.exact_excerpt || decoder.decode(needle) !== candidate.preview ||
      bytes.byteLength !== section.excerpt_byte_length ||
      authority.anchor.end - authority.anchor.start !== bytes.byteLength || needle.byteLength >= bytes.byteLength) return unchanged;

  const found = section.exact_excerpt.indexOf(candidate.preview);
  if (found < 0 || section.exact_excerpt.indexOf(candidate.preview, found + 1) !== -1) return unchanged;
  const offset = evidenceUtf8Bytes(section.exact_excerpt.slice(0, found)).byteLength;
  const selected = bytes.slice(offset, offset + needle.byteLength);
  const exactExcerpt = decoder.decode(selected);
  if (exactExcerpt !== candidate.preview) return unchanged;
  // The provider supplies neither offsets nor evidence digests: derive both from canonical bytes.
  const digest = await evidenceSha256Bytes(selected);
  return {
    anchorAuthority: { ...authority, anchor: { kind: "normalized_byte_range",
      start: authority.anchor.start + offset, end: authority.anchor.start + offset + selected.byteLength }, content_sha256: digest },
    materialized: { ...section, exact_excerpt: exactExcerpt, excerpt_sha256: digest, excerpt_byte_length: selected.byteLength },
  };
}
