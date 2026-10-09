export type EvidenceFreezeStageErrorCode =
  | "EVIDENCE_FREEZE_INPUT_INVALID"
  | "EVIDENCE_FREEZE_SCOPE_STALE"
  | "EVIDENCE_FREEZE_EVIDENCE_INVALID"
  | "EVIDENCE_FREEZE_AUTHORITY_INVALID"
  | "EVIDENCE_FREEZE_SETTLEMENT_UNCERTAIN";

export class EvidenceFreezeStageError extends Error {
  public readonly retryable: boolean;

  public constructor(
    public readonly code: EvidenceFreezeStageErrorCode,
    message: string,
    retryable = false,
    cause?: unknown,
  ) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "EvidenceFreezeStageError";
    this.retryable = retryable;
  }
}

export function failEvidenceFreeze(
  code: EvidenceFreezeStageErrorCode,
  message: string,
  retryable = false,
  cause?: unknown,
): never {
  throw new EvidenceFreezeStageError(code, message, retryable, cause);
}
