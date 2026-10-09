// Adapted to the extracted C3-C factories. Transport, error construction and epoch all
// arrive as caller-owned collaborators; nothing here constructs OwnerBodyError directly.
import { describe, expect, it, vi } from "vitest";
import { createHealthApi } from "./health";
import type { LegacyErrorDetails, LegacyErrorFactory } from "../legacy/http";
import type { EpochPort } from "../transport/client";

const HEALTH_PATH = "/api/v1/system/health";

const healthEnvelope = (data: unknown) => ({
  data,
  trace_id: "trace-health-1",
  deployment_generation: "deploy-1",
});

const validData = {
  ready: true,
  deployment_generation: "deploy-1",
  core_schema_generation: "core-1",
  search_schema_generation: null,
  blocking_reason_codes: [],
  checked_at: "2026-10-09T12:00:00.000Z",
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

function makeEpoch() {
  let closed = false;
  const stamp = {};
  const epoch: EpochPort = {
    capture: () => (closed ? undefined : stamp),
    isCurrent: (capture: unknown) => !closed && capture === stamp,
  };
  return { epoch, close: () => { closed = true; } };
}

/** A closed epoch proves both transport-fence failures. */
function deadEpoch(): EpochPort {
  return { capture: () => undefined, isCurrent: () => false };
}

function makeApi(respond: (path: string) => Promise<unknown>) {
  const { epoch, close } = makeEpoch();
  const requestApi = vi.fn(async (path: string) => respond(path));
  return { api: createHealthApi({ requestApi }, errors, epoch), requestApi, close };
}

function deadApi() {
  const requestApi = vi.fn(async () => healthEnvelope(validData));
  return { api: createHealthApi({ requestApi }, errors, deadEpoch()), requestApi };
}

describe("createHealthApi", () => {
  it("reads the health path and decodes the response", async () => {
    const { api, requestApi } = makeApi(async () => healthEnvelope(validData));
    await expect(api.getSystemHealth()).resolves.toMatchObject({ ready: true });
    expect(requestApi.mock.calls[0]?.[0]).toBe(HEALTH_PATH);
  });

  it("decodes the optional google_external_transport field", async () => {
    const { api } = makeApi(async () => healthEnvelope({ ...validData, google_external_transport: "drive-exchange" }));
    await expect(api.getSystemHealth()).resolves.toMatchObject({ google_external_transport: "drive-exchange" });
  });

  it("rejects an unknown top-level envelope field with the caller's error type", async () => {
    const { api } = makeApi(async () => ({ ...healthEnvelope(validData), extra: 1 }));
    await expect(api.getSystemHealth()).rejects.toThrow(/has missing or unknown fields/);
    await expect(api.getSystemHealth()).rejects.toBeInstanceOf(LegacyError);
  });

  it("rejects a payload whose generation differs from the envelope", async () => {
    const { api } = makeApi(async () => healthEnvelope({ ...validData, deployment_generation: "deploy-2" }));
    await expect(api.getSystemHealth()).rejects.toThrow(/generations differ/);
  });

  it("rejects a non-boolean ready flag", async () => {
    const { api } = makeApi(async () => healthEnvelope({ ...validData, ready: "yes" }));
    await expect(api.getSystemHealth()).rejects.toThrow(/ready must be boolean/);
  });

  it("rejects a non-canonical checked_at timestamp", async () => {
    const { api } = makeApi(async () => healthEnvelope({ ...validData, checked_at: "2026-10-09 12:00:00" }));
    await expect(api.getSystemHealth()).rejects.toThrow(/canonical ISO timestamp/);
  });

  it("fails closed on a closed epoch without dispatching the request", async () => {
    const { api, requestApi } = deadApi();
    await expect(api.getSystemHealth()).rejects.toMatchObject({ code: "API_SESSION_CLOSED" });
    expect(requestApi).not.toHaveBeenCalled();
  });

  it("fails closed when the epoch closes during the awaited read", async () => {
    let release: (value: unknown) => void = () => {};
    const gate = new Promise<unknown>((resolve) => { release = resolve; });
    const { api, close } = makeApi(async () => gate);
    const pending = api.getSystemHealth();
    close();
    release(healthEnvelope(validData));
    await expect(pending).rejects.toMatchObject({ code: "API_SESSION_CLOSED" });
  });

  it("propagates a rejected read through the caller's error path", async () => {
    const { api } = makeApi(async () => { throw new Error("network"); });
    await expect(api.getSystemHealth()).rejects.toThrow(/network/);
  });
});
