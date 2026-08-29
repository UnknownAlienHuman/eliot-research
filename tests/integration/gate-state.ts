export type LiveGateState = "NOT_EXECUTED" | "RUNNING" | "PASS" | "FAIL" | "BLOCKED";

export interface LiveGateReceipt {
  readonly gate_id: string;
  readonly state: LiveGateState;
  readonly environment: string;
  readonly generation_ref: string | null;
  readonly started_at: string | null;
  readonly finished_at: string | null;
  readonly redacted_receipt_ref: string | null;
  readonly reason_codes: readonly string[];
  readonly cleanup_state: "NOT_REQUIRED" | "PENDING" | "COMPLETE" | "FAILED";
}

export function initialLiveGateReceipt(gateId: string, environment: string): LiveGateReceipt {
  return {
    gate_id: gateId,
    state: "NOT_EXECUTED",
    environment,
    generation_ref: null,
    started_at: null,
    finished_at: null,
    redacted_receipt_ref: null,
    reason_codes: ["LIVE_CREDENTIALS_OR_BINDINGS_NOT_PRESENT"],
    cleanup_state: "NOT_REQUIRED",
  };
}

export function gateMayBeReportedAsPass(receipt: LiveGateReceipt): boolean {
  return receipt.state === "PASS"
    && receipt.redacted_receipt_ref !== null
    && receipt.finished_at !== null
    && receipt.reason_codes.length === 0
    && (receipt.cleanup_state === "COMPLETE" || receipt.cleanup_state === "NOT_REQUIRED");
}
