// Adapted to the extracted C3-C factories. Transport, error construction and epoch arrive
// as caller-owned collaborators; nothing here constructs OwnerBodyError directly.
import { describe, expect, it, vi } from "vitest";
import { createProviderKeyApi } from "./provider";
import type { LegacyErrorDetails, LegacyErrorFactory, LegacyHttpAdapter } from "../legacy/http";
import type { EpochPort } from "../transport/client";

const PROVIDER_PATH = "/api/v1/projects/proj-1/model-provider-key";
const OPERATION_ID = "0f9a7b6c-5d4e-4f3a-8b2c-1d0e9f8a7b6c";

const envelope = (data: unknown) => ({
  data,
  trace_id: "trace-provider-1",
  deployment_generation: "deploy-1",
});

const pageData = {
  protocol: "eliotr.research-provider-key-configuration.v1",
  project_id: "proj-1",
  provider_id: "openrouter",
  configurations: [],
  truncated: false,
};

const receiptData = {
  protocol: "eliotr.research-provider-key-configuration.v1",
  project_id: "proj-1",
  provider_id: "openrouter",
  operation_id: OPERATION_ID,
  alias: "eliotr-" + "a".repeat(48),
  provider_config_id: "provider-config-1",
  status: "configured_not_qualified",
  created_at: "2026-10-09T12:00:00.000Z",
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

function liveEpoch() {
  let closed = false;
  const stamp = {};
  const epoch: EpochPort = {
    capture: () => (closed ? undefined : stamp),
    isCurrent: (capture: unknown) => !closed && capture === stamp,
  };
  return { epoch, close: () => { closed = true; } };
}

type ProviderHttp = Pick<LegacyHttpAdapter, "requestApiWithStatuses">;

function providerHttp(respond: (path: string, init: RequestInit | undefined, statuses: readonly number[]) => Promise<unknown>) {
  const requestApiWithStatuses = vi.fn<LegacyHttpAdapter["requestApiWithStatuses"]>(
    async (path, init, accepted) => respond(String(path), init, accepted),
  );
  return { http: { requestApiWithStatuses } as ProviderHttp, requestApiWithStatuses };
}

function makeApi(response: unknown) {
  const { epoch, close } = liveEpoch();
  const { http, requestApiWithStatuses } = providerHttp(async () => response);
  return { api: createProviderKeyApi(http, errors, epoch), requestApiWithStatuses, close };
}

function deadApi() {
  const { http, requestApiWithStatuses } = providerHttp(async () => envelope(pageData));
  const epoch: EpochPort = { capture: () => undefined, isCurrent: () => false };
  return { api: createProviderKeyApi(http, errors, epoch), requestApiWithStatuses };
}
describe("createProviderKeyApi", () => {
  it("accepts a realistic provider key length and rejects a short one", () => {
    const { api } = makeApi(envelope(pageData));
    expect(api.isResearchProviderKeyInputValid("k".repeat(48))).toBe(true);
    expect(api.isResearchProviderKeyInputValid("short")).toBe(false);
  });

  it("reads the provider path with the expected generation and 200", async () => {
    const { api, requestApiWithStatuses } = makeApi(envelope(pageData));
    await expect(api.readResearchProviderKeyConfigurations("proj-1", "deploy-1"))
      .resolves.toMatchObject({ project_id: "proj-1" });
    const call = requestApiWithStatuses.mock.calls[0];
    expect(call?.[0]).toBe(PROVIDER_PATH);
    expect(call?.[2]).toEqual([200]);
    expect(call?.[1]?.method).toBe("GET");
  });

  it("appends a validated uuid operation filter to the query", async () => {
    const { api, requestApiWithStatuses } = makeApi(envelope(pageData));
    await expect(api.readResearchProviderKeyConfigurations("proj-1", "deploy-1", undefined, OPERATION_ID))
      .resolves.toBeDefined();
    expect(String(requestApiWithStatuses.mock.calls[0]?.[0])).toBe(PROVIDER_PATH + "?operation_id=" + OPERATION_ID);
  });

  it("rejects a non-uuid operation filter before any request", async () => {
    const { api, requestApiWithStatuses } = makeApi(envelope(pageData));
    await expect(api.readResearchProviderKeyConfigurations("proj-1", "deploy-1", undefined, "not-a-uuid"))
      .rejects.toThrow(/Operation identity is invalid/);
    expect(requestApiWithStatuses).not.toHaveBeenCalled();
  });

  it("rejects a page belonging to another project", () => {
    const { api } = makeApi(envelope({ ...pageData, project_id: "proj-2" }));
    expect(() => api.decodeResearchProviderKeyConfigurationPage(
      envelope({ ...pageData, project_id: "proj-2" }), "deploy-1", "proj-1",
    )).toThrow(/another project/);
  });

  it("rejects a protocol mismatch in the page decoder", () => {
    const { api } = makeApi(envelope({ ...pageData, protocol: "other.v1" }));
    expect(() => api.decodeResearchProviderKeyConfigurationPage(
      envelope({ ...pageData, protocol: "other.v1" }), "deploy-1", "proj-1",
    )).toThrow(/page is invalid/);
  });

  it("rejects an unexpected generation in the page decoder", () => {
    const { api } = makeApi(envelope(pageData));
    expect(() => api.decodeResearchProviderKeyConfigurationPage(envelope(pageData), "deploy-2", "proj-1"))
      .toThrow(/another deployment/);
  });

  it("rejects an unknown data field in the page decoder", () => {
    const { api } = makeApi(envelope({ ...pageData, extra: 1 }));
    expect(() => api.decodeResearchProviderKeyConfigurationPage(
      envelope({ ...pageData, extra: 1 }), "deploy-1", "proj-1",
    )).toThrow(/has missing or unknown fields/);
  });

  it("decodes a configuration receipt and rejects a receipt mismatch", async () => {
    const { api } = makeApi(envelope(receiptData));
    expect(api.decodeResearchProviderKeyConfigurationReceipt(
      envelope(receiptData), "deploy-1", "proj-1", OPERATION_ID,
    )).toMatchObject({ status: "configured_not_qualified", operation_id: OPERATION_ID });
    expect(() => api.decodeResearchProviderKeyConfigurationReceipt(
      envelope(receiptData), "deploy-1", "proj-1", "0f9a7b6c-5d4e-4f3a-8b2c-1d0e9f8a7b6d",
    )).toThrow();
  });

  it("configures with CSRF, idempotency and 200 or 201", async () => {
    const { api, requestApiWithStatuses } = makeApi(envelope(receiptData));
    await expect(api.configureResearchProviderKey("proj-1", "deploy-1", OPERATION_ID, "k".repeat(48)))
      .resolves.toMatchObject({ alias: receiptData.alias });
    const call = requestApiWithStatuses.mock.calls[0];
    expect(call?.[0]).toBe(PROVIDER_PATH);
    expect(call?.[2]).toEqual([200, 201]);
    expect(new Headers(call?.[1]?.headers).get("x-eliotr-csrf")).toBe("1");
    expect(new Headers(call?.[1]?.headers).get("idempotency-key")).toBe(OPERATION_ID);
    expect(call?.[1]?.method).toBe("POST");
  });

  it("rejects an invalid provider key before any request", async () => {
    const { api, requestApiWithStatuses } = makeApi(envelope(receiptData));
    await expect(api.configureResearchProviderKey("proj-1", "deploy-1", OPERATION_ID, "short"))
      .rejects.toThrow(/Provider key input is invalid/);
    expect(requestApiWithStatuses).not.toHaveBeenCalled();
  });

  it("fails closed on a closed epoch without dispatching the request", async () => {
    const { api, requestApiWithStatuses } = deadApi();
    await expect(api.readResearchProviderKeyConfigurations("proj-1", "deploy-1"))
      .rejects.toMatchObject({ code: "API_SESSION_CLOSED" });
    expect(requestApiWithStatuses).not.toHaveBeenCalled();
  });

  it("fails closed when the epoch closes during the awaited read", async () => {
    let release: (value: unknown) => void = () => {};
    const gate = new Promise<unknown>((resolve) => { release = resolve; });
    const { api, close } = makeApi(gate);
    const pending = api.readResearchProviderKeyConfigurations("proj-1", "deploy-1");
    close();
    release(envelope(pageData));
    await expect(pending).rejects.toMatchObject({ code: "API_SESSION_CLOSED" });
  });
});
