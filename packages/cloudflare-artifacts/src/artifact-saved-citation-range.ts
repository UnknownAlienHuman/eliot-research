import type { EvidenceHandle } from "@eliotr/contracts";
import { evidenceSha256Bytes, evidenceUtf8Bytes, type CandidateAnchorAuthority,
  type MaterializedEvidenceExcerpt } from "@eliotr/cloudflare-evidence";
import { ArtifactDraftReadError } from "./artifact-draft-reader-contracts.js";

type SavedRange = Pick<EvidenceHandle, "anchor" | "coordinate_map_ref" | "excerpt_sha256" | "excerpt_byte_length">;
const invalid = (): never => { throw new ArtifactDraftReadError("ARTIFACT_DRAFT_READ_INTEGRITY", 409,
  "saved citation range differs from canonical evidence"); };

/** A narrowed SEM handle retains the coordinate-map identity of its verified parent section. */
export function savedCitationParentSpan(saved: SavedRange): Readonly<{ start: number; end: number }> {
  if (saved.anchor.kind !== "normalized_byte_range") return invalid();
  const match = /^normalized-bytes:(0|[1-9][0-9]*):(0|[1-9][0-9]*)$/u.exec(saved.coordinate_map_ref ?? "");
  const start = match === null ? saved.anchor.start : Number(match[1]);
  const end = match === null ? saved.anchor.end : Number(match[2]);
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end <= start ||
      saved.anchor.start < start || saved.anchor.end > end ||
      saved.anchor.end - saved.anchor.start !== saved.excerpt_byte_length) return invalid();
  return Object.freeze({ start, end });
}

export function savedCitationAnchor(parent: CandidateAnchorAuthority, saved: SavedRange): CandidateAnchorAuthority {
  const span = savedCitationParentSpan(saved);
  if (parent.anchor.kind !== "normalized_byte_range" || parent.anchor.start !== span.start || parent.anchor.end !== span.end ||
      parent.coordinate_map_ref !== saved.coordinate_map_ref) return invalid();
  if (saved.anchor.kind !== "normalized_byte_range") return invalid();
  if (saved.anchor.start === span.start && saved.anchor.end === span.end && parent.content_sha256 !== saved.excerpt_sha256) return invalid();
  return { ...parent, anchor: saved.anchor, content_sha256: saved.excerpt_sha256 };
}

/** Verify the full parent first, then derive the exact old byte range. No provider preview or offsets are trusted. */
export async function materializeSavedCitationRange(parent: CandidateAnchorAuthority,
  whole: MaterializedEvidenceExcerpt, saved: SavedRange): Promise<MaterializedEvidenceExcerpt> {
  const bound = savedCitationAnchor(parent, saved);
  if (bound.anchor.kind !== "normalized_byte_range" || parent.anchor.kind !== "normalized_byte_range") return invalid();
  const bytes = evidenceUtf8Bytes(whole.exact_excerpt);
  if (whole.excerpt_byte_length !== bytes.byteLength || bytes.byteLength !== parent.anchor.end - parent.anchor.start ||
      whole.excerpt_sha256 !== parent.content_sha256 || await evidenceSha256Bytes(bytes) !== parent.content_sha256) return invalid();
  const selected = bytes.slice(bound.anchor.start - parent.anchor.start, bound.anchor.end - parent.anchor.start);
  let text: string;
  try { text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(selected); }
  catch { return invalid(); }
  const digest = await evidenceSha256Bytes(selected);
  if (selected.byteLength !== saved.excerpt_byte_length || digest !== saved.excerpt_sha256) return invalid();
  return { ...whole, exact_excerpt: text, excerpt_byte_length: selected.byteLength, excerpt_sha256: digest };
}
