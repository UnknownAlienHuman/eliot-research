import type {
  ComputerAgentConnection,
  ComputerAgentDispatch,
  ComputerAgentDispatchCreate,
  ComputerAgentDispatchStatus,
} from "@eliotr/contracts";
import { RESEARCH_DEFAULT_INQUIRY_PROTOCOL_REF } from "@eliotr/contracts";
import { describe, expect, it, vi } from "vitest";
import { createComputerAgentTaskApi } from "./computer-agent-task-assignment";
import type { LegacyErrorDetails, LegacyErrorFactory, LegacyHttpAdapter } from "../legacy/http";
import type { EpochPort } from "../transport/client";

const PROJECT = "project-1";
const DISPATCH = "dispatch-1";
const DEPLOYMENT = "deploy-1";

const envelope = (data: unknown) => ({ data, trace_id: "trace-task-1", deployment_generation: DEPLOYMENT });

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

const errors: LegacyErrorFactory = details => new LegacyError(details);

function liveEpoch(): EpochPort {
  const token = Object.freeze({});
  return { capture: () => token, isCurrent: value => value === token };
}

function connection(state: ComputerAgentConnection["state"] = "ENABLED"): ComputerAgentConnection {
  return {
    protocol: "eliotr.computer-agent-connection.v1",
    connection_id: "agent-1",
    revision: 3,
    owner_principal_ref: "owner-1",
    state,
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
    created_at: "2026-10-15T00:00:00.000Z",
    updated_at: "2026-10-15T00:00:00.000Z",
  };
}

function input(): ComputerAgentDispatchCreate {
  return {
    transport: "MCP_WRITE",
    expected_route_revision: 4,
    connection_id: "agent-1",
    connection_revision: 3,
    client_grant_id: "grant-1",
    client_grant_revision: 2,
    expires_in_seconds: 900,
    run_request: {
      query: "Check the project's primary claim",
      product: "RESEARCH",
      scope_expression: { kind: "PROJECT", project_id: PROJECT },
      literals: [],
      evidence_grade: "E0",
      budget_ref: "research-budget-v1",
      max_results: 8,
      request_version: "eliotr.research-run-request.v2",
      inquiry_protocol_ref: RESEARCH_DEFAULT_INQUIRY_PROTOCOL_REF,
    },
  };
}

function dispatch(): ComputerAgentDispatch {
  return {
    protocol: "eliotr.computer-agent-dispatch.v1",
    dispatch_id: DISPATCH,
    project_id: PROJECT,
    task_kind: "RESEARCH_BRANCH_ANALYSIS",
    transport: "MCP_WRITE",
    route_revision: 4,
    priority: 0,
    connection_id: "agent-1",
    connection_revision: 3,
    client_grant_id: "grant-1",
    client_grant_revision: 2,
    owner_principal_ref: "owner-1",
    owner_credential_generation: "credential-1",
    actor: connection().actor,
    qualification: {
      challenge_id: "challenge-1",
      observation_ref: "observation-1",
      verified_credential_generation: "credential-1",
      ready_until: "2026-10-15T01:00:00.000Z",
      deployment_generation: DEPLOYMENT,
    },
    run_request: input().run_request,
    run_request_sha256: "a".repeat(64),
    created_at: "2026-10-15T00:00:00.000Z",
    expires_at: "2026-10-15T00:15:00.000Z",
  };
}

function status(): ComputerAgentDispatchStatus {
  return {
    protocol: "eliotr.computer-agent-dispatch-status.v2",
    state: "PENDING",
    dispatch: dispatch(),
    acceptance: null,
    abandonment: null,
    decline: null,
    reassignment: null,
  };
}

function routeReadiness() {
  return {
    protocol: "eliotr.project-computer-agent-route-readiness.v1" as const,
    project_id: PROJECT,
    task_kind: "RESEARCH_BRANCH_ANALYSIS" as const,
    route_revision: 4,
    route_state: "ACTIVE" as const,
    strategy: "ORIGINATING_MATCH" as const,
    transport: "MCP_WRITE" as const,
    deployment_generation: DEPLOYMENT,
    observed_at: "2026-10-15T00:00:00.000Z",
    entries: [{
      priority: 0,
      connection_id: "agent-1",
      connection_revision: 3,
      display_name: "Research agent",
      contour: "GEMINI_SPARK" as const,
      transport: "MCP_WRITE" as const,
      connection_state: "CURRENT" as const,
      capability_state: "SUPPORTED" as const,
      qualification_state: "READY" as const,
      qualification: {
        protocol: "eliotr.computer-agent-qualification-status.v1" as const,
        status: "READY" as const,
        connection_id: "agent-1",
        connection_revision: 3,
        transport: "MCP_WRITE" as const,
        challenge_id: "challenge-1",
        issued_at: "2026-10-15T00:00:00.000Z",
        expires_at: "2026-10-15T01:00:00.000Z",
        deployment_generation: DEPLOYMENT,
        observation_ref: "observation-1",
        observed_at: "2026-10-15T00:00:00.000Z",
        ready_until: "2026-10-15T00:45:00.000Z",
        verified_credential_generation: "credential-1",
      },
      eligible: true,
    }],
    preferred_ready_connection: { priority: 0, connection_id: "agent-1", connection_revision: 3 },
  };
}

function makeApi(respond: (path: string, init: RequestInit | undefined, statuses: readonly number[]) => Promise<unknown>) {
  const requestApiWithStatuses = vi.fn<LegacyHttpAdapter["requestApiWithStatuses"]>(
    async (path, init, statuses) => respond(String(path), init, statuses),
  );
  const api = createComputerAgentTaskApi({ requestApiWithStatuses }, errors, liveEpoch(), { mint: () => "stable-1" });
  return { api, requestApiWithStatuses };
}

describe("computer-agent task assignment API", () => {
  it("posts one frozen owner intent and reads its canonical durable status", async () => {
    const target = connection();
    const observed = dispatch();
    const { api, requestApiWithStatuses } = makeApi(async (path, _init) => {
      if (path === `/api/v1/research/projects/${PROJECT}/computer-agent-routes/RESEARCH_BRANCH_ANALYSIS/readiness/MCP_WRITE`) return envelope(routeReadiness());
      if (path === `/api/v1/research/projects/${PROJECT}/computer-agent-dispatches`) return envelope(observed);
      if (path === `/api/v1/research/projects/${PROJECT}/computer-agent-dispatches/${DISPATCH}`) return envelope(status());
      throw new Error(`Unexpected path ${path}`);
    });
    await expect(api.readComputerAgentRouteReadiness(PROJECT, "MCP_WRITE", DEPLOYMENT))
      .resolves.toMatchObject({ route_revision: 4, preferred_ready_connection: { connection_id: "agent-1" } });
    const intent = api.prepareComputerAgentDispatch(
      PROJECT, DEPLOYMENT, "owner-1", "credential-1", target, input(),
    );
    expect(Object.isFrozen(intent)).toBe(true);

    await expect(api.executeComputerAgentDispatch(intent)).resolves.toMatchObject({ dispatch_id: DISPATCH });
    await expect(api.readComputerAgentDispatchStatus(
      PROJECT, DISPATCH, DEPLOYMENT, "owner-1", "credential-1",
    )).resolves.toMatchObject({ state: "PENDING", dispatch: { dispatch_id: DISPATCH } });

    expect(requestApiWithStatuses).toHaveBeenNthCalledWith(2,
      `/api/v1/research/projects/${PROJECT}/computer-agent-dispatches`,
      expect.objectContaining({ method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": "computer-agent-dispatch-stable-1" } }),
      [200],
    );
    expect(requestApiWithStatuses).toHaveBeenNthCalledWith(3,
      `/api/v1/research/projects/${PROJECT}/computer-agent-dispatches/${DISPATCH}`,
      expect.objectContaining({ method: "GET" }), [200],
    );
    expect(requestApiWithStatuses).toHaveBeenNthCalledWith(1,
      `/api/v1/research/projects/${PROJECT}/computer-agent-routes/RESEARCH_BRANCH_ANALYSIS/readiness/MCP_WRITE`,
      expect.objectContaining({ method: "GET" }), [200],
    );
  });

  it("refuses a disabled server-listed connection before dispatching a mutation", () => {
    const { api, requestApiWithStatuses } = makeApi(async () => { throw new Error("must not request"); });
    expect(() => api.prepareComputerAgentDispatch(
      PROJECT, DEPLOYMENT, "owner-1", "credential-1", connection("DISABLED"), input(),
    )).toThrow(/enabled connection/);
    expect(requestApiWithStatuses).not.toHaveBeenCalled();
  });
});
