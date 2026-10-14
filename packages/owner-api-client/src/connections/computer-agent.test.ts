import type {
  ComputerAgentConnection,
  ComputerAgentConnectionPut,
  ComputerAgentConnectionList,
  ComputerAgentQualificationStatus,
} from "@eliotr/contracts";
import { describe, expect, it, vi } from "vitest";
import { createComputerAgentConnectionApi } from "./computer-agent";
import type { LegacyErrorDetails, LegacyErrorFactory, LegacyHttpAdapter } from "../legacy/http";
import type { EpochPort } from "../transport/client";

const BASE = "/api/v1/system/computer-agents";
const envelope = (data: unknown, generation = "deploy-1") => ({
  data, trace_id: "trace-agent-1", deployment_generation: generation,
});
const connection = (overrides: Partial<ComputerAgentConnection> = {}): ComputerAgentConnection => ({
  protocol: "eliotr.computer-agent-connection.v1",
  connection_id: "agent-1",
  revision: 1,
  owner_principal_ref: "owner-1",
  state: "ENABLED",
  display_name: "Research agent",
  contour: "GEMINI_SPARK",
  actor: {
    issuer: "https://example.cloudflareaccess.com",
    authentication_method: "service_token",
    subject: "agent-1.access",
  },
  transport_capabilities: ["MCP_WRITE"],
  computer_capabilities: ["CLOUD_BROWSER"],
  task_kinds: ["RESEARCH_BRANCH_ANALYSIS"],
  created_at: "2026-10-14T12:00:00.000Z",
  updated_at: "2026-10-14T12:00:00.000Z",
  ...overrides,
});
const putInput = (expected_revision: number, overrides: Partial<ComputerAgentConnectionPut> = {}): ComputerAgentConnectionPut => ({
  display_name: "Research agent",
  contour: "GEMINI_SPARK",
  actor: connection().actor,
  transport_capabilities: ["MCP_WRITE"],
  computer_capabilities: ["CLOUD_BROWSER"],
  task_kinds: ["RESEARCH_BRANCH_ANALYSIS"],
  expected_revision,
  ...overrides,
});
const qualification = (overrides: Partial<ComputerAgentQualificationStatus> = {}): ComputerAgentQualificationStatus => ({
  protocol: "eliotr.computer-agent-qualification-status.v1",
  status: "READY",
  connection_id: "agent-1",
  connection_revision: 1,
  transport: "MCP_WRITE",
  challenge_id: "challenge-1",
  issued_at: "2026-10-14T12:00:00.000Z",
  expires_at: "2026-10-14T12:10:00.000Z",
  deployment_generation: "deploy-1",
  observation_ref: "observation-1",
  observed_at: "2026-10-14T12:01:00.000Z",
  ready_until: "2026-10-14T12:05:00.000Z",
  verified_credential_generation: "credential-1",
  ...overrides,
});

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
  let current = true;
  const stamp = Object.freeze({});
  const epoch: EpochPort = {
    capture: () => current ? stamp : undefined,
    isCurrent: (value) => current && value === stamp,
  };
  return { epoch, close: () => { current = false; } };
}
type Responder = (path: string, init: RequestInit | undefined, statuses: readonly number[]) => Promise<unknown>;
function makeApi(respond: Responder, options: { readonly epoch?: EpochPort; readonly mint?: () => string } = {}) {
  const current = options.epoch === undefined ? liveEpoch() : undefined;
  const activeEpoch = options.epoch ?? current?.epoch;
  if (activeEpoch === undefined) throw new Error("test epoch was not initialized");
  const requestApiWithStatuses = vi.fn<LegacyHttpAdapter["requestApiWithStatuses"]>(
    async (path, init, statuses) => respond(String(path), init, statuses));
  const api = createComputerAgentConnectionApi(
    { requestApiWithStatuses }, errors, activeEpoch,
    { mint: options.mint ?? (() => "identity-1") },
  );
  return { api, requestApiWithStatuses, close: current?.close };
}
const emptyList = (): ComputerAgentConnectionList => ({
  protocol: "eliotr.computer-agent-connections.v1", connections: [],
});

describe("createComputerAgentConnectionApi", () => {
  it("rejects a closed owner epoch before HTTP", async () => {
    const requestApiWithStatuses = vi.fn<LegacyHttpAdapter["requestApiWithStatuses"]>();
    const epoch: EpochPort = { capture: () => undefined, isCurrent: () => false };
    const api = createComputerAgentConnectionApi({ requestApiWithStatuses }, errors, epoch, { mint: () => "unused" });
    await expect(api.readComputerAgentConnections("deploy-1")).rejects.toMatchObject({ code: "API_SESSION_CLOSED" });
    expect(requestApiWithStatuses).not.toHaveBeenCalled();
  });

  it("suppresses a list body completed after its owner epoch closes", async () => {
    let release!: (value: unknown) => void;
    const body = new Promise<unknown>((resolve) => { release = resolve; });
    const { api, requestApiWithStatuses, close } = makeApi(() => body);
    const pending = api.readComputerAgentConnections("deploy-1");
    expect(requestApiWithStatuses).toHaveBeenCalledTimes(1);
    close?.();
    release(envelope({ ...emptyList(), connections: [connection()] }));
    await expect(pending).rejects.toMatchObject({ code: "API_SESSION_CLOSED" });
  });

  it("rejects deployment drift and malformed cursors without exposing list data", async () => {
    const wrongDeployment = makeApi(async () => envelope(emptyList(), "deploy-2"));
    await expect(wrongDeployment.api.readComputerAgentConnections("deploy-1"))
      .rejects.toMatchObject({ code: "API_GENERATION_MISMATCH" });
    const malformedCursor = makeApi(async () => envelope(emptyList()));
    await expect(malformedCursor.api.readComputerAgentConnections("deploy-1", "agent 1"))
      .rejects.toMatchObject({ code: "COMPUTER_AGENT_CONNECTION_INPUT_INVALID" });
    expect(malformedCursor.requestApiWithStatuses).not.toHaveBeenCalled();
  });

  it("rejects duplicate, out-of-order, and malformed continuation IDs", async () => {
    const duplicate = makeApi(async () => envelope({
      protocol: "eliotr.computer-agent-connections.v1",
      connections: [connection(), connection()],
    }));
    await expect(duplicate.api.readComputerAgentConnections("deploy-1"))
      .rejects.toMatchObject({ code: "API_RESPONSE_SCHEMA_MISMATCH" });
    const outOfOrder = makeApi(async () => envelope({
      protocol: "eliotr.computer-agent-connections.v1",
      connections: [connection({ connection_id: "agent-2" }), connection({ connection_id: "agent-1" })],
    }));
    await expect(outOfOrder.api.readComputerAgentConnections("deploy-1"))
      .rejects.toMatchObject({ code: "API_RESPONSE_SCHEMA_MISMATCH" });
    const cursor = makeApi(async () => envelope({
      protocol: "eliotr.computer-agent-connections.v1",
      connections: [connection()], next_connection_id: "agent-1",
    }));
    await expect(cursor.api.readComputerAgentConnections("deploy-1"))
      .rejects.toMatchObject({ code: "API_RESPONSE_SCHEMA_MISMATCH" });
    const repeatedCursor = makeApi(async () => envelope({
      protocol: "eliotr.computer-agent-connections.v1", connections: [connection()],
    }));
    await expect(repeatedCursor.api.readComputerAgentConnections("deploy-1", "agent-1"))
      .rejects.toMatchObject({ code: "API_RESPONSE_SCHEMA_MISMATCH" });
    const oversized = makeApi(async () => envelope({
      protocol: "eliotr.computer-agent-connections.v1",
      connections: Array.from({ length: 21 }, (_, index) => connection({ connection_id: `agent-${index + 1}` })),
    }));
    await expect(oversized.api.readComputerAgentConnections("deploy-1"))
      .rejects.toMatchObject({ code: "API_RESPONSE_SCHEMA_MISMATCH" });
  });

  it("fails closed on unknown envelope and connection fields", async () => {
    const unknownEnvelope = makeApi(async () => ({ ...envelope(emptyList()), request_id: "extra" }));
    await expect(unknownEnvelope.api.readComputerAgentConnections("deploy-1"))
      .rejects.toMatchObject({ code: "API_RESPONSE_SCHEMA_MISMATCH" });
    const unknownData = makeApi(async () => envelope({ ...emptyList(), unexpected: true }));
    await expect(unknownData.api.readComputerAgentConnections("deploy-1"))
      .rejects.toMatchObject({ code: "API_RESPONSE_SCHEMA_MISMATCH" });
  });

  it("passes typed authorization loss through without returning an older connection page", async () => {
    const accessLoss = new LegacyError({ code: "ACCESS_SESSION_REQUIRED", status: 401,
      message: "Owner access needs verification", traceId: null, retryable: false });
    const { api } = makeApi(async () => { throw accessLoss; });
    await expect(api.readComputerAgentConnections("deploy-1")).rejects.toBe(accessLoss);
  });

  it("returns current qualification evidence and its expiry unchanged", async () => {
    const observed = qualification();
    const { api, requestApiWithStatuses } = makeApi(async () => envelope(observed));
    const result = await api.readComputerAgentQualification(connection(), "MCP_WRITE", "deploy-1");
    expect(result).toEqual(observed);
    expect(result.ready_until).toBe(observed.ready_until);
    expect(Object.hasOwn(result, "connected")).toBe(false);
    expect(requestApiWithStatuses.mock.calls[0]?.[0]).toBe(`${BASE}/agent-1/qualifications/MCP_WRITE`);
  });

  it("rejects qualification deployment drift and unknown status fields", async () => {
    const nestedDrift = makeApi(async () => envelope(qualification({ deployment_generation: "deploy-2" })));
    await expect(nestedDrift.api.readComputerAgentQualification(connection(), "MCP_WRITE", "deploy-1"))
      .rejects.toMatchObject({ code: "API_GENERATION_MISMATCH" });
    const unknownField = makeApi(async () => envelope({ ...qualification(), presence: "online" }));
    await expect(unknownField.api.readComputerAgentQualification(connection(), "MCP_WRITE", "deploy-1"))
      .rejects.toMatchObject({ code: "API_RESPONSE_SCHEMA_MISMATCH" });
  });

  it("refuses qualification for a transport the connection does not declare", async () => {
    const { api, requestApiWithStatuses } = makeApi(async () => envelope(qualification()));
    await expect(api.readComputerAgentQualification(
      connection({ transport_capabilities: ["WEB_INBOX"] }), "MCP_WRITE", "deploy-1",
    )).rejects.toMatchObject({ code: "COMPUTER_AGENT_QUALIFICATION_INPUT_INVALID" });
    expect(requestApiWithStatuses).not.toHaveBeenCalled();
  });

  it("retains one immutable PUT intent across readback and explicit retry", async () => {
    const current = connection({ revision: 6 });
    const body = putInput(6, {
      display_name: "Updated research agent",
      transport_capabilities: ["WEB_INBOX", "MCP_WRITE"],
      computer_capabilities: ["LOCAL_COMPUTER", "CLOUD_BROWSER"],
    });
    const mint = vi.fn(() => "intent-1");
    let calls = 0;
    const { api, requestApiWithStatuses } = makeApi(async (_path, _init) => {
      calls += 1;
      if (calls === 1) throw new Error("acknowledgement lost");
      if (calls === 2) return envelope({
        protocol: "eliotr.computer-agent-connections.v1", connections: [current],
      });
      return envelope(connection({ revision: 7, display_name: body.display_name,
        transport_capabilities: ["MCP_WRITE", "WEB_INBOX"],
        computer_capabilities: ["CLOUD_BROWSER", "LOCAL_COMPUTER"],
        updated_at: "2026-10-14T12:05:00.000Z" }));
    }, { mint });
    const intent = api.prepareComputerAgentConnectionPut("agent-1", "deploy-1", body, current);
    expect(Object.isFrozen(intent)).toBe(true);
    expect(intent.expectedRevision).toBe(6);
    expect(intent.idempotencyKey).toBe("computer-agent-change-intent-1");
    expect(mint).toHaveBeenCalledTimes(1);
    expect(requestApiWithStatuses).not.toHaveBeenCalled();

    await expect(api.executeComputerAgentConnectionMutation(intent)).rejects.toThrow("acknowledgement lost");
    expect(requestApiWithStatuses).toHaveBeenCalledTimes(1);
    await api.readComputerAgentConnections("deploy-1");
    expect(mint).toHaveBeenCalledTimes(1);
    await expect(api.executeComputerAgentConnectionMutation(intent)).resolves.toMatchObject({
      connection_id: "agent-1", revision: 7, state: "ENABLED",
    });
    expect(requestApiWithStatuses).toHaveBeenCalledTimes(3);
    const first = requestApiWithStatuses.mock.calls[0]?.[1];
    const retry = requestApiWithStatuses.mock.calls[2]?.[1];
    expect(first?.body).toBe(intent.body);
    expect(retry?.body).toBe(intent.body);
    expect(new Headers(first?.headers).get("idempotency-key")).toBe(intent.idempotencyKey);
    expect(new Headers(retry?.headers).get("idempotency-key")).toBe(intent.idempotencyKey);
    expect(new Headers(retry?.headers).get("x-eliotr-csrf")).toBe("1");
  });

  it("refuses unsupported transports and stale expected revisions before mint or HTTP", () => {
    const mint = vi.fn(() => "must-not-mint");
    const { api, requestApiWithStatuses } = makeApi(async () => envelope(connection()), { mint });
    expect(() => api.prepareComputerAgentConnectionPut("agent-1", "deploy-1",
      putInput(0, { transport_capabilities: ["MCP_READ"] }), undefined))
      .toThrow(/shared contract/);
    expect(() => api.prepareComputerAgentConnectionPut("agent-1", "deploy-1", putInput(5), connection({ revision: 6 })))
      .toThrow(/current connection revision/);
    expect(mint).not.toHaveBeenCalled();
    expect(requestApiWithStatuses).not.toHaveBeenCalled();
  });

  it("prepares and executes disable with the exact current revision", async () => {
    const current = connection({ revision: 8 });
    const { api, requestApiWithStatuses } = makeApi(async () => envelope(connection({
      ...current, revision: 9, state: "DISABLED", updated_at: "2026-10-14T12:08:00.000Z",
    })));
    const intent = api.prepareComputerAgentConnectionDisable(current, "deploy-1");
    expect(JSON.parse(intent.body)).toEqual({ expected_revision: 8 });
    expect(intent.expectedRevision).toBe(8);
    const result = await api.executeComputerAgentConnectionMutation(intent);
    expect(result.state).toBe("DISABLED");
    expect(requestApiWithStatuses.mock.calls[0]?.[0]).toBe(`${BASE}/agent-1`);
    expect(requestApiWithStatuses.mock.calls[0]?.[1]?.method).toBe("DELETE");
  });
});
