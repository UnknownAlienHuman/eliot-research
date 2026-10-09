import { describe, expect, it, vi } from "vitest";
import { createErasureOperations } from "./erasure";
import type { ErasureApiFailure } from "./decoders";

const GENERATION = "gen-1";
const REF = { id: "ers-1", revision: 1 };

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

const PREPARE_BODY = {
  data: {
    protocol: "eliotr.owner-erasure-preview.v1",
    source_id: "src-1",
    source_title: "Quarterly notes",
    revision_targets: ["rev-1", "rev-2"],
    request: {
      protocol: "eliotr.owner-erasure.v1" as const,
      permission_ref: REF,
      request: {
        protocol: "erc.privacy.erasure.v1" as const,
        erasure_ref: REF,
        requested_by_principal_ref: "prn-1",
        exact_subject_refs: ["sub-1", "sub-2"],
        required_locations: ["CanonicalPayload" as const],
        legal_basis_ref: "lb-1",
        admitted_at: "2026-10-09T00:00:00.000Z",
        deadline: "2026-10-10T00:00:00.000Z",
      },
    },
  },
  trace_id: "tr-1",
  deployment_generation: GENERATION,
};

const PREPARED_VIEW = {
  protocol: "eliotr.owner-erasure-preview.v1",
  source_id: "src-1",
  source_title: "Quarterly notes",
  revision_targets: ["rev-1", "rev-2"],
  request: PREPARE_BODY.data.request,
  trace_id: "tr-1",
  deployment_generation: GENERATION,
} as const;

function failureCollector(): { readonly fail: (failure: ErasureApiFailure) => Error; readonly seen: ErasureApiFailure[] } {
  const seen: ErasureApiFailure[] = [];
  return { seen, fail: (failure) => { seen.push(failure); return new Error(failure.message); } };
}

function typedError(error: unknown): boolean {
  return typeof error === "object" && error !== null &&
    typeof (error as { code?: unknown }).code === "string";
}

/** A closed epoch: capture returns undefined, so nothing is current. */
function closedEpoch(): { capture(): object | undefined; isCurrent(capture: unknown): boolean } {
  return { capture: () => undefined, isCurrent: () => false };
}

/** An epoch whose stamp can be replaced mid-flight to model a stale session. */
function controllableEpoch(): { readonly epoch: { capture(): object; isCurrent(capture: unknown): boolean }; invalidate(): void } {
  let stamp: object = {};
  return {
    epoch: { capture: () => stamp, isCurrent: (capture) => capture === stamp },
    invalidate() { stamp = {}; },
  };
}

function currentEpoch(): { capture(): object; isCurrent(capture: unknown): boolean } {
  const stamp = {};
  return { capture: () => stamp, isCurrent: (capture) => capture === stamp };
}

function adapter(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    requestApi: vi.fn(async () => ({})),
    requestApiWithStatuses: vi.fn(async () => ({})),
    ...overrides,
  };
}

describe("erasure operations", () => {
  it("posts the prepare body with its idempotency key", async () => {
    const collector = failureCollector();
    const requestApiWithStatuses = vi.fn(async () => PREPARE_BODY);
    const operations = createErasureOperations({
      http: adapter({ requestApiWithStatuses }) as never,
      fail: collector.fail,
      epoch: currentEpoch(),
      isRequestError: typedError,
    });
    const view = await operations.prepareErasureForOwner("src-1", "key-1", GENERATION);
    expect(view.source_id).toBe("src-1");
    expect(requestApiWithStatuses).toHaveBeenCalledWith(
      "/api/v1/library/erasure/prepare",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ source_id: "src-1", idempotency_key: "key-1" }),
      },
      [200],
    );
  });

  it("sends the prepared command with the CSRF header on execute", async () => {
    const collector = failureCollector();
    const requestApiWithStatuses = vi.fn(async () => ({ data: TERMINAL_RECEIPT, trace_id: "tr-1", deployment_generation: GENERATION }));
    const operations = createErasureOperations({
      http: adapter({ requestApiWithStatuses }) as never,
      fail: collector.fail,
      epoch: currentEpoch(),
      isRequestError: typedError,
    });
    const receipt = await operations.executePreparedErasure(PREPARED_VIEW, GENERATION);
    expect(receipt.state).toBe("COMPLETE");
    expect(requestApiWithStatuses).toHaveBeenCalledWith(
      "/api/v1/library/erasure",
      {
        method: "POST",
        headers: { "content-type": "application/json", "x-eliotr-csrf": "1" },
        body: JSON.stringify(PREPARED_VIEW.request),
      },
      [200],
    );
  });

  it("refuses to dispatch when the epoch is already stale", async () => {
    const collector = failureCollector();
    const requestApiWithStatuses = vi.fn(async () => ({}));
    const closed = closedEpoch();
    const operations = createErasureOperations({
      http: adapter({ requestApiWithStatuses }) as never,
      fail: collector.fail,
      epoch: closed,
      isRequestError: typedError,
    });
    await expect(operations.prepareErasureForOwner("src-1", "key-1", GENERATION)).rejects.toThrow();
    expect(requestApiWithStatuses).not.toHaveBeenCalled();
    expect(collector.seen[0]?.code).toBe("API_SESSION_CLOSED");
    expect(collector.seen[0]?.status).toBe(503);
  });

  it("discards an execute whose prepared generation no longer matches", async () => {
    const collector = failureCollector();
    const requestApiWithStatuses = vi.fn(async () => ({}));
    const operations = createErasureOperations({
      http: adapter({ requestApiWithStatuses }) as never,
      fail: collector.fail,
      epoch: currentEpoch(),
      isRequestError: typedError,
    });
    await expect(operations.executePreparedErasure(PREPARED_VIEW, "gen-2")).rejects.toThrow();
    expect(requestApiWithStatuses).not.toHaveBeenCalled();
    expect(collector.seen[0]?.code).toBe("API_GENERATION_MISMATCH");
    expect(collector.seen[0]?.status).toBe(409);
  });

  it("fences a stale epoch after the await, before decoding", async () => {
    const collector = failureCollector();
    const control = controllableEpoch();
    const requestApiWithStatuses = vi.fn(async () => {
      control.invalidate();
      return PREPARE_BODY;
    });
    const operations = createErasureOperations({
      http: adapter({ requestApiWithStatuses }) as never,
      fail: collector.fail,
      epoch: control.epoch,
      isRequestError: typedError,
    });
    await expect(operations.prepareErasureForOwner("src-1", "key-1", GENERATION)).rejects.toThrow();
    expect(collector.seen[0]?.code).toBe("API_SESSION_CLOSED");
  });

  it("returns null for ERASURE_NOT_FOUND and ERASURE_STATUS_NOT_FOUND", async () => {
    for (const code of ["ERASURE_NOT_FOUND", "ERASURE_STATUS_NOT_FOUND"]) {
      const collector = failureCollector();
      const requestApiWithStatuses = vi.fn(async () => {
        throw Object.assign(new Error("not found"), { status: 404, code });
      });
      const operations = createErasureOperations({
        http: adapter({ requestApiWithStatuses }) as never,
        fail: collector.fail,
        epoch: currentEpoch(),
      isRequestError: typedError,
      });
      await expect(operations.readErasureStatus(REF, GENERATION)).resolves.toBeNull();
    }
  });

  it("rethrows a 404 with another code", async () => {
    const collector = failureCollector();
    const requestApiWithStatuses = vi.fn(async () => {
      throw Object.assign(new Error("other"), { status: 404, code: "SOMETHING_ELSE" });
    });
    const operations = createErasureOperations({
      http: adapter({ requestApiWithStatuses }) as never,
      fail: collector.fail,
      epoch: currentEpoch(),
      isRequestError: typedError,
    });
    await expect(operations.readErasureStatus(REF, GENERATION)).rejects.toThrow("other");
  });

  it("fences a stale epoch before the 404 null result", async () => {
    const collector = failureCollector();
    const control = controllableEpoch();
    const requestApiWithStatuses = vi.fn(async () => {
      control.invalidate();
      throw Object.assign(new Error("not found"), { status: 404, code: "ERASURE_NOT_FOUND" });
    });
    const operations = createErasureOperations({
      http: adapter({ requestApiWithStatuses }) as never,
      fail: collector.fail,
      epoch: control.epoch,
      isRequestError: typedError,
    });
    await expect(operations.readErasureStatus(REF, GENERATION)).rejects.toThrow();
    expect(collector.seen[0]?.code).toBe("API_SESSION_CLOSED");
  });

  it("reads the status path with the encoded ref", async () => {
    const collector = failureCollector();
    const requestApiWithStatuses = vi.fn(async () => ({
      data: { protocol: "eliotr.owner-erasure-status.v1", erasure_ref: REF, state: "UNKNOWN" },
      trace_id: "tr-1",
      deployment_generation: GENERATION,
    }));
    const operations = createErasureOperations({
      http: adapter({ requestApiWithStatuses }) as never,
      fail: collector.fail,
      epoch: currentEpoch(),
      isRequestError: typedError,
    });
    const view = await operations.readErasureStatus(REF, GENERATION);
    expect(view?.state).toBe("UNKNOWN");
    expect(requestApiWithStatuses).toHaveBeenCalledWith(
      `/api/v1/library/erasure/${encodeURIComponent(REF.id)}/${REF.revision}`,
      undefined,
      [200],
    );
  });

  it("rejects an erasure ref that is not a versioned reference", async () => {
    const collector = failureCollector();
    const operations = createErasureOperations({
      http: adapter() as never,
      fail: collector.fail,
      epoch: currentEpoch(),
      isRequestError: typedError,
    });
    await expect(operations.readErasureStatus({ id: "ers-1" } as never, GENERATION)).rejects.toThrow();
    expect(collector.seen[0]?.code).toBe("API_RESPONSE_SCHEMA_MISMATCH");
  });
});

