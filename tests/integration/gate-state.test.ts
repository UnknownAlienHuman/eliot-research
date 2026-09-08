import { describe, expect, it } from "vitest";
import {
  gateMayBeReportedAsPass,
  initialLiveGateReceipt,
  type LiveGateReceipt,
} from "./gate-state.js";

// Fixed trial clock: all timestamps are explicit so the suite is deterministic.
// observed=19:00:02Z, "now" is 60s later; the default 24h freshness window holds.
const STARTED_AT = "2026-09-08T19:00:00.000Z";
const FINISHED_AT = "2026-09-08T19:00:01.000Z";
const OBSERVED_AT = "2026-09-08T19:00:02.000Z";
const NOW_MS = Date.parse(OBSERVED_AT) + 60_000;
const INPUT_DIGEST = "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08"; // sha256("test")

function makeBoundPassReceipt(overrides: Partial<LiveGateReceipt> = {}): LiveGateReceipt {
  return {
    ...initialLiveGateReceipt("T4-d1-write-readback", "staging"),
    state: "PASS",
    environment: "staging",
    generation_ref: "worker-config-gen-2026-09-08-001",
    worker_generation: "worker-build-abcdef1234",
    data_generation: "d1-data-gen-2026-09-08-001",
    test_id: "T4-d1-write-readback",
    input_digest: INPUT_DIGEST,
    started_at: STARTED_AT,
    finished_at: FINISHED_AT,
    observed_at: OBSERVED_AT,
    redacted_receipt_ref: "sha256:9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08",
    reason_codes: [],
    cleanup_state: "COMPLETE",
    ...overrides,
  };
}

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

  it("accepts a fully identity-bound fresh staging PASS", () => {
    expect(gateMayBeReportedAsPass(makeBoundPassReceipt(), { nowMs: NOW_MS })).toBe(true);
  });

  it("rejects a development PASS even with full identity: local fakes cannot green a live gate", () => {
    const receipt = makeBoundPassReceipt({ environment: "development" });
    expect(gateMayBeReportedAsPass(receipt, { nowMs: NOW_MS })).toBe(false);
  });

  it("rejects PASS with a null deployment generation: observation is not bound to a Worker/config", () => {
    const receipt = makeBoundPassReceipt({ generation_ref: null });
    expect(gateMayBeReportedAsPass(receipt, { nowMs: NOW_MS })).toBe(false);
  });

  it("rejects PASS with a null worker generation: deployed-Worker identity is missing", () => {
    const receipt = makeBoundPassReceipt({ worker_generation: null });
    expect(gateMayBeReportedAsPass(receipt, { nowMs: NOW_MS })).toBe(false);
  });

  it("rejects PASS with a null data generation: readback generation is missing", () => {
    const receipt = makeBoundPassReceipt({ data_generation: null });
    expect(gateMayBeReportedAsPass(receipt, { nowMs: NOW_MS })).toBe(false);
  });

  it("rejects PASS when the test id does not match the gate id", () => {
    const receipt = makeBoundPassReceipt({ test_id: "T4-r2-immutable-put-readback" });
    expect(gateMayBeReportedAsPass(receipt, { nowMs: NOW_MS })).toBe(false);
  });

  it("rejects PASS with a malformed input digest: the probe input is not pinned", () => {
    const receipt = makeBoundPassReceipt({ input_digest: "not-a-digest" });
    expect(gateMayBeReportedAsPass(receipt, { nowMs: NOW_MS })).toBe(false);
  });

  it("rejects PASS when finished precedes started: timestamps are incoherent", () => {
    const receipt = makeBoundPassReceipt({ started_at: FINISHED_AT, finished_at: STARTED_AT });
    expect(gateMayBeReportedAsPass(receipt, { nowMs: NOW_MS })).toBe(false);
  });

  it("rejects PASS with a missing observation timestamp: freshness cannot be checked", () => {
    const receipt = makeBoundPassReceipt({ observed_at: null });
    expect(gateMayBeReportedAsPass(receipt, { nowMs: NOW_MS })).toBe(false);
  });

  it("rejects PASS with a stale observation: a replayed receipt is not current", () => {
    const receipt = makeBoundPassReceipt({ observed_at: "2026-09-01T19:00:02.000Z" });
    expect(gateMayBeReportedAsPass(receipt, { nowMs: NOW_MS })).toBe(false);
  });

  it("rejects PASS with an observation timestamp in the future relative to the trial clock", () => {
    const receipt = makeBoundPassReceipt({ observed_at: "2026-09-08T19:05:00.000Z" });
    expect(gateMayBeReportedAsPass(receipt, { nowMs: NOW_MS })).toBe(false);
  });

  it("rejects PASS with an empty receipt handle: empty string is not a durable receipt", () => {
    const receipt = makeBoundPassReceipt({ redacted_receipt_ref: "" });
    expect(gateMayBeReportedAsPass(receipt, { nowMs: NOW_MS })).toBe(false);
  });

  it("rejects PASS when the receipt handle carries secret-shaped material", () => {
    const receipt = makeBoundPassReceipt({
      redacted_receipt_ref: "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c", // privacy-allowlist: synthetic token fixture
    });
    expect(gateMayBeReportedAsPass(receipt, { nowMs: NOW_MS })).toBe(false);
  });

  it("rejects PASS with failed cleanup: effects were not reclaimed", () => {
    const receipt = makeBoundPassReceipt({ cleanup_state: "FAILED" });
    expect(gateMayBeReportedAsPass(receipt, { nowMs: NOW_MS })).toBe(false);
  });

  it("rejects PASS with pending cleanup: the trial is not settled", () => {
    const receipt = makeBoundPassReceipt({ cleanup_state: "PENDING" });
    expect(gateMayBeReportedAsPass(receipt, { nowMs: NOW_MS })).toBe(false);
  });
});
