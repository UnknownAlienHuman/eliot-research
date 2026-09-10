import type { PrepareBundleUploadRequest } from "@eliotr/interfaces";
import { readRawNormalizedCandidate } from "./raw-normalized-candidate-reader.js";
import type {
  RawNormalizedAdmissionPreparation,
  RawNormalizedCandidateReaderInput,
} from "./raw-normalized-types.js";

/**
 * Converts a verified candidate into the existing normalized-folder prepare DTO.
 * The caller owns authentication and invokes the existing createIngestService;
 * this helper performs no D1, R2, HTTP, provider, or admission mutation.
 */
export async function prepareRawNormalizedAdmission(
  input: RawNormalizedCandidateReaderInput,
  idempotency_key: string,
): Promise<RawNormalizedAdmissionPreparation> {
  if (typeof idempotency_key !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/u.test(idempotency_key)) {
    throw new Error("raw normalized admission idempotency key is invalid");
  }
  const candidate = await readRawNormalizedCandidate(input);
  const request: PrepareBundleUploadRequest = {
    manifest: candidate.manifest,
    total_bytes: candidate.total_bytes,
    file_hashes: candidate.file_hashes,
    idempotency_key,
  };
  return { candidate, request };
}
