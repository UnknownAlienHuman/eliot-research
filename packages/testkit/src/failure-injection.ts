export type FailurePoint =
  | "BEFORE_INTENT_COMMIT"
  | "AFTER_INTENT_BEFORE_QUEUE"
  | "AFTER_SIDE_EFFECT_BEFORE_RECEIPT"
  | "AFTER_RECEIPT_BEFORE_ACK"
  | "DURING_READBACK"
  | "DURING_RECONCILIATION"
  | "STALE_OWNER_GENERATION"
  | "PURGE_BETWEEN_RETRIEVAL_AND_RESOLUTION"
  | "DRIVE_ROW_TAMPERED"
  | "OAUTH_REVOKED";

export interface FailureInjector {
  hit(point: FailurePoint): Promise<void>;
}

export class ScriptedFailureInjector implements FailureInjector {
  public constructor(private readonly failures: ReadonlyMap<FailurePoint, Error>) {}
  public async hit(point: FailurePoint): Promise<void> {
    const failure = this.failures.get(point);
    if (failure !== undefined) throw failure;
  }
}
