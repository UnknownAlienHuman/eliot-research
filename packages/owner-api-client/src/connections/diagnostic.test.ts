// Adapted to the extracted C3-C factories. Transport, error construction and epoch arrive
// as caller-owned collaborators; the 404 predicate is injected rather than instanceof-bound.
import { describe, expect, it, vi } from "vitest";
import { createMcpDiagnosticApi } from "./diagnostic";
import type { LegacyErrorDetails, LegacyErrorFactory, LegacyHttpAdapter } from "../legacy/http";
import type { EpochPort } from "../transport/client";

const DIAGNOSTIC_PATH = "/api/v1/system/mcp-diagnostics";

const envelope = (data: unknown, generation = "deploy-1") => ({
  data,
  trace_id: "trace-diag-1",
  deployment_generation: generation,
});

const confirmedData = {
  protocol: "eliotr.mcp.client-diagnostic.v1",
  status: "CONFIRMED",
  challenge_id: "challenge-1",
  issued_at: "2026-10-09T12:00:00.000Z",
  expires_at: "2026-10-09T12:05:00.000Z",
  observed_at: "2026-10-09T12:01:00.000Z",
  auth_profile: "managed-oauth",
  deployment_generation: "deploy-1",
  observation_ref: "observation-1",
  trace_id: "trace-diag-1",
};

const issuedData = {
  protocol: "eliotr.mcp.client-diagnostic.v1",
  status: "ISSUED",
  challenge_id: "challenge-1",
  challenge_token: "opaque-token/with-punctuation",
  issued_at: "2026-10-09T12:00:00.000Z",
  expires_at: "2026-10-09T12:05:00.000Z",
  deployment_generation: "deploy-1",
  auth_profile: "managed-oauth",
};

class LegacyError extends Error {
  public readonly status: number;
  public readonly code: string;
  public readonly traceId: string | null;
  public readonly retryable: boolean;
  public constructor(details: LegacyErrorDetails) {
    super(details.message);
    this.name = "LegacyError";
    this.status = details.status;
    this.code = details.code;
    this.traceId = details.traceId;
    this.retryable = details.retryable;
  }
}

const errors: LegacyErrorFactory = (details) => new LegacyError(details);

/** The injected predicate owns the typed-empty-state decision. */
const isRequestError = (value: unknown): value is Error & LegacyErrorDetails =>
  value instanceof LegacyError;

function liveEpoch() {
  let closed = false;
  const stamp = {};
  const epoch: EpochPort = {
    capture: () => (closed ? undefined : stamp),
    isCurrent: (capture: unknown) => !closed && capture === stamp,
  };
  return { epoch, close: () => { closed = true; } };
}

type DiagnosticHttp = Pick<LegacyHttpAdapter, "requestApiWithStatuses">;

function diagnosticHttp(respond: (path: string, init: RequestInit | undefined, statuses: readonly number[]) => Promise<unknown>) {
  const requestApiWithStatuses = vi.fn<LegacyHttpAdapter["requestApiWithStatuses"]>(
    async (path, init, accepted, _timeoutMs) => respond(String(path), init, accepted),
  );
  return { http: { requestApiWithStatuses } as DiagnosticHttp, requestApiWithStatuses };
}

function makeApi(respond: (path: string, init: RequestInit | undefined, statuses: readonly number[]) => Promise<unknown>) {
  const { epoch, close } = liveEpoch();
  const { http, requestApiWithStatuses } = diagnosticHttp(respond);
  return { api: createMcpDiagnosticApi(http, errors, epoch, isRequestError), requestApiWithStatuses, close };
}

function deadApi() {
  const { http, requestApiWithStatuses } = diagnosticHttp(async () => envelope(confirmedData));
  const epoch: EpochPort = { capture: () => undefined, isCurrent: () => false };
  return { api: createMcpDiagnosticApi(http, errors, epoch, isRequestError), requestApiWithStatuses };
}

describe("createMcpDiagnosticApi", () => {
  it("issues a challenge with a CSRF POST, an empty body and 201", async () => {
    const { api, requestApiWithStatuses } = makeApi(async () => envelope(issuedData));
    await expect(api.issueMcpClientDiagnostic("deploy-1")).resolves.toMatchObject({
      status: "ISSUED",
      challenge_id: "challenge-1",
    });
    const call = requestApiWithStatuses.mock.calls[0];
    expect(call?.[0]).toBe(DIAGNOSTIC_PATH);
    expect(call?.[2]).toEqual([201]);
    expect(call?.[1]?.method).toBe("POST");
    expect(new Headers(call?.[1]?.headers).get("x-eliotr-csrf")).toBe("1");
    expect(call?.[1]?.body).toBe("{}");
  });

  it("reads a confirmed status through the injected seam", async () => {
    const { api, requestApiWithStatuses } = makeApi(async () => envelope(confirmedData));
    await expect(api.getLatestMcpClientDiagnostic("deploy-1")).resolves.toMatchObject({
      status: "CONFIRMED",
      observation_ref: "observation-1",
    });
    expect(requestApiWithStatuses.mock.calls[0]?.[2]).toEqual([200]);
    expect(requestApiWithStatuses.mock.calls[0]?.[1]?.method).toBe("GET");
  });

  it("maps only the typed empty-state 404 to null and propagates other errors", async () => {
    const notFound = makeApi(async () => { throw new LegacyError({ status: 404, code: "MCP_DIAGNOSTIC_CHALLENGE_NOT_FOUND", message: "none", traceId: null, retryable: false }); });
    await expect(notFound.api.getLatestMcpClientDiagnostic("deploy-1")).resolves.toBeNull();

    const other = makeApi(async () => { throw new LegacyError({ status: 502, code: "API_RESPONSE_SCHEMA_MISMATCH", message: "bad", traceId: null, retryable: false }); });
    await expect(other.api.getLatestMcpClientDiagnostic("deploy-1")).rejects.toMatchObject({
      code: "API_RESPONSE_SCHEMA_MISMATCH",
    });
  });

  it("rejects a confirmed status whose observed time precedes its issue", async () => {
    const { api } = makeApi(async () => envelope({ ...confirmedData, observed_at: "2026-10-09T11:59:00.000Z" }));
    await expect(api.getLatestMcpClientDiagnostic("deploy-1")).rejects.toThrow();
  });

  it("rejects an envelope containing an unknown field", async () => {
    const { api } = makeApi(async () => ({ ...envelope(confirmedData), extra: 1 }));
    await expect(api.getLatestMcpClientDiagnostic("deploy-1")).rejects.toThrow(/does not match its contract/);
    await expect(api.getLatestMcpClientDiagnostic("deploy-1")).rejects.toBeInstanceOf(LegacyError);
  });

  it("rejects a readback for a foreign deployment generation", async () => {
    const { api } = makeApi(async () => envelope(confirmedData, "foreign-generation"));
    await expect(api.getLatestMcpClientDiagnostic("deploy-1")).rejects.toThrow(/Application changed/);
  });

  it("fails closed on a closed epoch without dispatching the request", async () => {
    const { api, requestApiWithStatuses } = deadApi();
    await expect(api.getLatestMcpClientDiagnostic("deploy-1")).rejects.toMatchObject({ code: "API_SESSION_CLOSED" });
    expect(requestApiWithStatuses).not.toHaveBeenCalled();
  });

  it("fails closed when the epoch closes during the awaited read", async () => {
    let release: (value: unknown) => void = () => {};
    const gate = new Promise<unknown>((resolve) => { release = resolve; });
    const { api, close } = makeApi(async () => gate);
    const pending = api.getLatestMcpClientDiagnostic("deploy-1");
    close();
    release(envelope(confirmedData));
    await expect(pending).rejects.toMatchObject({ code: "API_SESSION_CLOSED" });
  });
});
