import type { EvidenceHandle } from "@eliotr/contracts";
import { domainError, type DomainError } from "./errors.js";
import { err, ok, type Result } from "./result.js";

export interface EvidenceResolutionObservation {
  readonly authorized: boolean;
  readonly currentOwnerGeneration: string;
  readonly currentPurgeState: string;
  readonly sourceRevisionDigest: string;
  readonly excerptDigest: string;
  readonly excerptByteLength: number;
  readonly scopeSnapshotId: string;
  readonly coordinateMapPresent: boolean;
}

export function validateEvidenceResolution(
  handle: EvidenceHandle,
  observed: EvidenceResolutionObservation,
): Result<void, DomainError> {
  if (!observed.authorized || handle.terminal_state !== "LIVE" || observed.currentPurgeState !== "LIVE") {
    return err(domainError("EVIDENCE_NOT_LIVE", "evidence is not currently authorized and live"));
  }
  if (handle.source_owner_generation !== observed.currentOwnerGeneration) {
    return err(domainError("OWNER_GENERATION_MISMATCH", "evidence owner generation is stale"));
  }
  if (handle.scope_snapshot_ref.id !== observed.scopeSnapshotId) {
    return err(domainError("EVIDENCE_SCOPE_MISMATCH", "evidence handle is bound to another scope snapshot"));
  }
  if (handle.excerpt_sha256 !== observed.excerptDigest || handle.excerpt_byte_length !== observed.excerptByteLength) {
    return err(domainError("EVIDENCE_DIGEST_MISMATCH", "exact excerpt digest or byte length mismatch"));
  }
  if ((handle.anchor.kind === "page_region" || handle.anchor.kind === "table_cell") && !observed.coordinateMapPresent) {
    return err(domainError("UNSUPPORTED_PRECISION", "native page/table precision requires a coordinate map"));
  }
  return ok(undefined);
}
