import { describe, expect, it } from "vitest";
import {
  decodeErasurePrepare,
  decodeErasureReceiptEnvelope,
  decodeErasureStatus,
  ERASURE_EXECUTE_PROTOCOL,
  ERASURE_PREVIEW_PROTOCOL,
  ERASURE_STATUS_PROTOCOL,
  validateErasureExpectedGeneration,
  validateErasureExpectedInputs,
  type ErasureApiFailure,
} from "./decoders";

const GENERATION = "gen-1";
const REF = { id: "ers-1", revision: 1 };

function failureCollector(): { readonly fail: (failure: ErasureApiFailure) => Error; readonly seen: ErasureApiFailure[] } {
  const seen: ErasureApiFailure[] = [];
  return { seen, fail: (failure) => { seen.push(failure); return new Error(failure.message); } };
}

function envelope(data: unknown, trace = "tr-1", generation = GENERATION): unknown {
  return { data, trace_id: trace, deployment_generation: generation };
}

const PREPARE_DATA = {
  protocol: ERASURE_PREVIEW_PROTOCOL,
  source_id: "src-1",
  source_title: "Quarterly notes",
  revision_targets: ["rev-1", "rev-2"],
  request: {
    protocol: ERASURE_EXECUTE_PROTOCOL,
    permission_ref: REF,
    request: {
      protocol: "erc.privacy.erasure.v1",
      erasure_ref: REF,
      requested_by_principal_ref: "prn-1",
      exact_subject_refs: ["sub-1", "sub-2"],
      required_locations: ["CanonicalPayload"],
      legal_basis_ref: "lb-1",
      admitted_at: "2026-10-09T00:00:00.000Z",
      deadline: "2026-10-10T00:00:00.000Z",
    },
  },
};

const TERMINAL_RECEIPT = {
  protocol: "erc.privacy.erasure.v1",
  erasure_ref: REF,
  state: "COMPLETE",
  requested_locations: ["CanonicalPayload"],
  completed_locations: ["CanonicalPayload"],
  blocked_locations: [],
  purge_ledger_entry_ref: "led-1",
  issued_at: "2026-10-10T00:00:00.000Z",
};

const BLOCKED_RECEIPT = {
  ...TERMINAL_RECEIPT,
  state: "BLOCKED",
  completed_locations: [],
  blocked_locations: [{ location: "CanonicalPayload", policy_or_hold_ref: "hold-1", next_review_at: "2026-11-10T00:00:00.000Z" }],
};

describe("erasure decoders", () => {
  it("accepts a matching prepare view", () => {
    const collector = failureCollector();
    const view = decodeErasurePrepare(envelope(PREPARE_DATA), GENERATION, "src-1", collector.fail);
    expect(view.source_id).toBe("src-1");
    expect(view.revision_targets).toEqual(["rev-1", "rev-2"]);
    expect(view.request.protocol).toBe(ERASURE_EXECUTE_PROTOCOL);
  });

  it("rejects a prepare view for another source", () => {
    const collector = failureCollector();
    expect(() => decodeErasurePrepare(envelope(PREPARE_DATA), GENERATION, "src-2", collector.fail)).toThrow();
    expect(collector.seen[0]?.code).toBe("API_RESPONSE_SCHEMA_MISMATCH");
  });

  it("rejects a generation mismatch through the injected factory", () => {
    const collector = failureCollector();
    expect(() => decodeErasurePrepare(envelope(PREPARE_DATA, "tr-1", "gen-2"), GENERATION, "src-1", collector.fail)).toThrow();
    expect(collector.seen[0]?.code).toBe("API_GENERATION_MISMATCH");
    expect(collector.seen[0]?.status).toBe(409);
    expect(collector.seen[0]?.retryable).toBe(true);
  });

  it("rejects a prepare view whose subject count differs from its targets", () => {
    const collector = failureCollector();
    const data = structuredClone(PREPARE_DATA);
    data.request.request.exact_subject_refs = ["sub-1"];
    expect(() => decodeErasurePrepare(envelope(data), GENERATION, "src-1", collector.fail)).toThrow();
    expect(collector.seen[0]?.code).toBe("API_RESPONSE_SCHEMA_MISMATCH");
  });

  it("keeps a partial purge state without a receipt", () => {
    const collector = failureCollector();
    const view = decodeErasureStatus(envelope({
      protocol: ERASURE_STATUS_PROTOCOL,
      erasure_ref: REF,
      state: "PURGE_EACH_LOCATION",
    }), GENERATION, collector.fail);
    expect(view.state).toBe("PURGE_EACH_LOCATION");
    expect(view.receipt).toBeUndefined();
  });

  it("keeps a held purge state without a receipt", () => {
    const collector = failureCollector();
    const view = decodeErasureStatus(envelope({
      protocol: ERASURE_STATUS_PROTOCOL,
      erasure_ref: REF,
      state: "CHECK_RETENTION_AND_HOLDS",
    }), GENERATION, collector.fail);
    expect(view.state).toBe("CHECK_RETENTION_AND_HOLDS");
    expect(view.receipt).toBeUndefined();
  });

  it("keeps an UNKNOWN purge state without a receipt", () => {
    const collector = failureCollector();
    const view = decodeErasureStatus(envelope({
      protocol: ERASURE_STATUS_PROTOCOL,
      erasure_ref: REF,
      state: "UNKNOWN",
    }), GENERATION, collector.fail);
    expect(view.state).toBe("UNKNOWN");
    expect(view.receipt).toBeUndefined();
  });

  it("requires a receipt for COMPLETE and BLOCKED", () => {
    const collector = failureCollector();
    expect(() => decodeErasureStatus(envelope({
      protocol: ERASURE_STATUS_PROTOCOL,
      erasure_ref: REF,
      state: "COMPLETE",
    }), GENERATION, collector.fail)).toThrow();
    expect(collector.seen[0]?.code).toBe("API_RESPONSE_SCHEMA_MISMATCH");
  });

  it("rejects a receipt on a non-terminal state", () => {
    const collector = failureCollector();
    expect(() => decodeErasureStatus(envelope({
      protocol: ERASURE_STATUS_PROTOCOL,
      erasure_ref: REF,
      state: "PURGE_EACH_LOCATION",
      receipt: TERMINAL_RECEIPT,
    }), GENERATION, collector.fail)).toThrow();
    expect(collector.seen[0]?.code).toBe("API_RESPONSE_SCHEMA_MISMATCH");
  });

  it("rejects a terminal receipt whose identity does not match the status", () => {
    const collector = failureCollector();
    expect(() => decodeErasureStatus(envelope({
      protocol: ERASURE_STATUS_PROTOCOL,
      erasure_ref: REF,
      state: "BLOCKED",
      receipt: { ...TERMINAL_RECEIPT, erasure_ref: { id: "ers-9", revision: 1 } },
    }), GENERATION, collector.fail)).toThrow();
    expect(collector.seen[0]?.code).toBe("API_RESPONSE_SCHEMA_MISMATCH");
  });

  it("accepts a terminal status whose receipt matches", () => {
    const collector = failureCollector();
    const view = decodeErasureStatus(envelope({
      protocol: ERASURE_STATUS_PROTOCOL,
      erasure_ref: REF,
      state: "BLOCKED",
      receipt: BLOCKED_RECEIPT,
    }), GENERATION, collector.fail);
    expect(view.state).toBe("BLOCKED");
    expect(view.receipt?.erasure_ref.id).toBe("ers-1");
  });

  it("rejects unknown fields in the status record", () => {
    const collector = failureCollector();
    expect(() => decodeErasureStatus(envelope({
      protocol: ERASURE_STATUS_PROTOCOL,
      erasure_ref: REF,
      state: "UNKNOWN",
      extra: true,
    }), GENERATION, collector.fail)).toThrow();
    expect(collector.seen[0]?.code).toBe("API_RESPONSE_SCHEMA_MISMATCH");
  });

  it("decodes a receipt envelope", () => {
    const collector = failureCollector();
    const receipt = decodeErasureReceiptEnvelope(envelope(TERMINAL_RECEIPT), GENERATION, collector.fail);
    expect(receipt.state).toBe("COMPLETE");
  });

  it("rejects an idempotency key outside the accepted shape", () => {
    const collector = failureCollector();
    expect(() => validateErasureExpectedInputs("src-1", "bad key", GENERATION, collector.fail)).toThrow();
    expect(collector.seen[0]?.code).toBe("ERASURE_INPUT_INVALID");
    expect(collector.seen[0]?.status).toBe(400);
  });

  it("rejects a generation outside the accepted shape", () => {
    const collector = failureCollector();
    expect(() => validateErasureExpectedGeneration("bad generation", collector.fail)).toThrow();
    expect(collector.seen[0]?.code).toBe("API_GENERATION_MISMATCH");
  });
});
