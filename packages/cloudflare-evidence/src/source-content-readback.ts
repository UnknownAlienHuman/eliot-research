import type { EvidenceSourceAuthority } from "./types.js";
import {
  readAdmittedNormalizedMarkdown,
  type AdmittedNormalizedMarkdown,
} from "./content-store.js";

export interface ProjectSourceContent {
  readonly project_id: string;
  readonly source_id: string;
  readonly source_revision_ref: string;
  readonly content_sha256: string;
  readonly bytes: Uint8Array;
  readonly size_bytes: number;
  readonly context_sha256: string;
  readonly authority_generation: number;
  readonly observed_at: number;
  readonly expires_at: number;
}

/** Performs the bounded immutable R2 read, then settles caller-owned D1 authority before returning bytes. */
export async function readSettledAdmittedNormalizedMarkdown(
  bucket: R2Bucket,
  source: EvidenceSourceAuthority,
  recheckAuthority: (content: AdmittedNormalizedMarkdown) => Promise<void>,
): Promise<AdmittedNormalizedMarkdown> {
  const content = await readAdmittedNormalizedMarkdown(bucket, source);
  await recheckAuthority(content);
  return content;
}
