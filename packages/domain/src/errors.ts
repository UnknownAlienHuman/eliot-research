export type DomainErrorCode =
  | "INVALID_TRANSITION"
  | "OWNER_GENERATION_MISMATCH"
  | "DUAL_ACTIVE_OWNER"
  | "CUTOVER_RECEIPT_INVALID"
  | "REVISION_SET_MISMATCH"
  | "RESIDENCY_MISMATCH"
  | "CROSS_DOMAIN_DEDUP_FORBIDDEN"
  | "SCOPE_REFERENCE_UNKNOWN"
  | "SCOPE_EMPTY"
  | "SCOPE_STALE"
  | "EVIDENCE_NOT_LIVE"
  | "EVIDENCE_DIGEST_MISMATCH"
  | "EVIDENCE_SCOPE_MISMATCH"
  | "UNSUPPORTED_PRECISION"
  | "ABSENCE_WITHOUT_COMPLETE_DENOMINATOR"
  | "POST_FREEZE_EVIDENCE"
  | "GRADE_DOWNGRADE_REQUIRES_SUPERSESSION"
  | "UNKNOWN_LOAD_BEARING_FIELD"
  | "INVALID_SOURCE_CANDIDATE_TRANSITION"
  | "MEMBERSHIP_ALREADY_CLOSED"
  | "INVALID_MEMBERSHIP_INTERVAL";

export interface DomainError {
  readonly code: DomainErrorCode;
  readonly message: string;
  readonly path?: readonly string[];
  readonly details?: Readonly<Record<string, string | number | boolean>>;
}

export function domainError(
  code: DomainErrorCode,
  message: string,
  details?: Readonly<Record<string, string | number | boolean>>,
): DomainError {
  return details === undefined ? { code, message } : { code, message, details };
}
