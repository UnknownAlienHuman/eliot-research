import { describe, expect, it } from "vitest";
import { gateMayBeReportedAsPass, initialLiveGateReceipt } from "./gate-state.js";

describe("live conformance ledger", () => {
  it("reports missing live credentials as NOT_EXECUTED", () => {
    const receipt = initialLiveGateReceipt("T4-drive-round-trip", "development");
    expect(receipt.state).toBe("NOT_EXECUTED");
    expect(gateMayBeReportedAsPass(receipt)).toBe(false);
  });

  it("does not accept PASS without a durable redacted receipt", () => {
    const receipt = { ...initialLiveGateReceipt("T4-r2-readback", "staging"), state: "PASS" as const, reason_codes: [] };
    expect(gateMayBeReportedAsPass(receipt)).toBe(false);
  });
});
