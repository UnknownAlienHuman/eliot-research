// Adapted to the extracted C3-C factories. Transport, error construction and epoch arrive
// as caller-owned collaborators; the expiry clock is injected, never ambient.
import { describe, expect, it, vi } from "vitest";
import { createOwnerSessionApi } from "./session";
import type { LegacyErrorDetails, LegacyErrorFactory, LegacyHttpAdapter } from "../legacy/http";
import type { EpochPort } from "../transport/client";

const SESSION_PATH = "/api/v1/system/session";

const sessionEnvelope = (data: unknown) => ({
  data,
  trace_id: "trace-session-1",
  deployment_generation: "deploy-1",
});

// The Core session has no session id; tests assert the exact four public fields.
const validData = {
  protocol: "eliotr.owner-session.v1",
  principal_ref: "principal-1",
  client_class: "owner_pwa",
  credential_generation: "cred-1",
  expires_at: "2026-10-09T13:00:00.000Z",
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

type SessionHttp = Pick<LegacyHttpAdapter, "requestApi">;

function sessionHttp(respond: (path: string, init?: RequestInit) => Promise<unknown>) {
  const requestApi = vi.fn<LegacyHttpAdapter["requestApi"]>(async (path, init) => respond(String(path), init));
  return { http: { requestApi } as SessionHttp, requestApi };
}

const clock = { now: () => Date.parse("2026-10-09T12:30:00.000Z") };

function makeApi(respond: (path: string) => Promise<unknown>) {
  const { epoch, close } = liveEpoch();
  const { http, requestApi } = sessionHttp(async (path) => respond(path));
  return { api: createOwnerSessionApi(http, errors, epoch, clock), requestApi, close };
}

function deadApi() {
  const { http, requestApi } = sessionHttp(async () => sessionEnvelope(validData));
  const epoch: EpochPort = { capture: () => undefined, isCurrent: () => false };
  return { api: createOwnerSessionApi(http, errors, epoch, clock), requestApi };
}

describe("createOwnerSessionApi", () => {
  it("reads the session path and returns exactly the four public fields", async () => {
    const { api, requestApi } = makeApi(async () => sessionEnvelope(validData));
    const session = await api.readOwnerSession("deploy-1");
    expect(session).toEqual({
      principal_ref: "principal-1",
      credential_generation: "cred-1",
      expires_at: "2026-10-09T13:00:00.000Z",
      client_class: "owner_pwa",
    });
    expect(Object.keys(session).sort()).toEqual(["client_class", "credential_generation", "expires_at", "principal_ref"]);
    expect(requestApi.mock.calls[0]?.[0]).toBe(SESSION_PATH);
  });

  it("treats a future expiry as unexpired against the injected clock", async () => {
    const { api } = makeApi(async () => sessionEnvelope(validData));
    const session = await api.readOwnerSession("deploy-1");
    expect(api.isOwnerSessionUnexpired(session)).toBe(true);
  });

  it("treats an expiry at or before the injected clock as expired", async () => {
    const { api } = makeApi(async () => sessionEnvelope(validData));
    const session = await api.readOwnerSession("deploy-1");
    const late = { now: () => Date.parse("2026-10-09T14:00:00.000Z") };
    const lateApi = createOwnerSessionApi(sessionHttp(async () => sessionEnvelope(validData)).http, errors, liveEpoch().epoch, late);
    expect(lateApi.isOwnerSessionUnexpired(session)).toBe(false);
  });

  it("rejects an envelope deployment generation that differs from expected", async () => {
    const { api } = makeApi(async () => sessionEnvelope(validData));
    await expect(api.readOwnerSession("deploy-2")).rejects.toThrow(/another deployment/);
    await expect(api.readOwnerSession("deploy-2")).rejects.toBeInstanceOf(LegacyError);
  });

  it("rejects an unknown protocol", async () => {
    const { api } = makeApi(async () => sessionEnvelope({ ...validData, protocol: "other.v1" }));
    await expect(api.readOwnerSession("deploy-1")).rejects.toThrow(/protocol is invalid/);
  });

  it("rejects an unlisted client class", async () => {
    const { api } = makeApi(async () => sessionEnvelope({ ...validData, client_class: "rogue" }));
    await expect(api.readOwnerSession("deploy-1")).rejects.toThrow(/client class is invalid/);
  });

  it("rejects an unknown session data field", async () => {
    const { api } = makeApi(async () => sessionEnvelope({ ...validData, extra: 1 }));
    await expect(api.readOwnerSession("deploy-1")).rejects.toThrow(/has missing or unknown fields/);
  });

  it("fails closed on a closed epoch without dispatching the request", async () => {
    const { api, requestApi } = deadApi();
    await expect(api.readOwnerSession("deploy-1")).rejects.toMatchObject({ code: "API_SESSION_CLOSED" });
    expect(requestApi).not.toHaveBeenCalled();
  });

  it("fails closed when the epoch closes during the awaited read", async () => {
    let release: (value: unknown) => void = () => {};
    const gate = new Promise<unknown>((resolve) => { release = resolve; });
    const { api, close } = makeApi(async () => gate);
    const pending = api.readOwnerSession("deploy-1");
    close();
    release(sessionEnvelope(validData));
    await expect(pending).rejects.toMatchObject({ code: "API_SESSION_CLOSED" });
  });
});
