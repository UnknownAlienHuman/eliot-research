import { describe, expect, it } from "vitest";
import type { AuthenticatedRequestContext } from "@eliotr/interfaces";
import {
  callMcpComputerAgentDispatch,
  type McpComputerAgentDispatchServiceFactory,
} from "../src/mcp-computer-agent-dispatch.js";
import type { Env } from "../src/env.js";

const GRANT_ID = "owner-grant-adapter-test";
const DISPATCH_ID = "owner-dispatch-adapter-test";
const REQUEST = {
  query: "Use the original owner-approved request",
  product: "RESEARCH",
  scope_expression: { kind: "PROJECT", project_id: "owner-project-adapter-test" },
  literals: [],
  evidence_grade: "E1",
  budget_ref: "research-budget-v1",
  max_results: 4,
  request_version: "eliotr.research-run-request.v2",
};

function serviceContext(): AuthenticatedRequestContext {
  const principal = "codex-adapter-test.access";
  const credentialGeneration = "codex-adapter-credential-7";
  const expiresAt = "2099-01-01T00:00:00.000Z";
  return {
    request: new Request("https://research.example/mcp", {
      method: "POST",
      headers: {
        "X-Eliotr-Client-Grant": GRANT_ID,
        "Idempotency-Key": "caller-action-key",
      },
    }),
    principal_ref: principal,
    client_class: "trusted_agent",
    credential_generation: credentialGeneration,
    trace_id: "dispatch-adapter-test",
    access: {
      principal_ref: principal,
      credential_generation: credentialGeneration,
      authentication_method: "service_token",
      issuer: "https://adapter-test.cloudflareaccess.com",
      expires_at: expiresAt,
    },
  };
}

describe("Core MCP computer-agent dispatch adapter", () => {
  it("pins MCP_WRITE pull and replays accept through the same grant, dispatch ID and run identity", async () => {
    const database = {
      prepare: () => ({ bind: () => ({ first: async () => null }) }),
    } as unknown as D1Database;
    const env = { CORE_DB: database, DEPLOYMENT_GENERATION: "deployment-adapter-test" } as Env;
    const requests: Array<{ readonly idempotency_key: string; readonly body: typeof REQUEST }> = [];
    const workflows = new Map<string, { readonly workflow_instance_id: string }>();
    let uniqueWorkflowCreates = 0;
    let pulledTransport: unknown;
    let receivedContext: AuthenticatedRequestContext | undefined;
    const service = {
      async pull(context: AuthenticatedRequestContext, input: { readonly transport: string }) {
        receivedContext = context;
        pulledTransport = input.transport;
        return { protocol: "eliotr.computer-agent-dispatch-offer.v1", dispatch: null };
      },
      async accept(context: AuthenticatedRequestContext, dispatchId: string, input: Record<string, never>) {
        receivedContext = context;
        expect(dispatchId).toBe(DISPATCH_ID);
        expect(input).toEqual({});
        const key = `computer-agent-dispatch:${dispatchId}`;
        requests.push({ idempotency_key: key, body: REQUEST });
        let workflow = workflows.get(key);
        if (workflow === undefined) {
          uniqueWorkflowCreates += 1;
          workflow = { workflow_instance_id: "run-adapter-test" };
          workflows.set(key, workflow);
        }
        return {
          protocol: "eliotr.computer-agent-dispatch-accepted.v1",
          dispatch_id: dispatchId,
          workflow_instance_id: workflow.workflow_instance_id,
          investigation_ref: { id: "investigation-adapter-test", revision: 1 },
          connection_id: "connection-adapter-test",
          connection_revision: 1,
          client_grant_id: GRANT_ID,
          client_grant_revision: 1,
          actor: { issuer: "https://adapter-test.cloudflareaccess.com",
            authentication_method: "service_token", subject: "codex-adapter-test.access" },
          credential_generation: "codex-adapter-credential-7",
          accepted_at: "2026-10-15T00:00:00.000Z",
        };
      },
    };
    const factory: McpComputerAgentDispatchServiceFactory = () =>
      service as unknown as ReturnType<McpComputerAgentDispatchServiceFactory>;
    const context = serviceContext();

    const offer = await callMcpComputerAgentDispatch(env, context, { kind: "pull" }, factory);
    expect(offer).toMatchObject({ protocol: "eliotr.computer-agent-dispatch-offer.v1", dispatch: null });
    expect(pulledTransport).toBe("MCP_WRITE");
    expect(receivedContext?.request.headers.get("X-Eliotr-Client-Grant")).toBe(GRANT_ID);

    const command = { kind: "accept" as const, dispatch_id: DISPATCH_ID };
    const first = await callMcpComputerAgentDispatch(env, context, command, factory);
    const replay = await callMcpComputerAgentDispatch(env, context, command, factory);
    expect(replay).toEqual(first);
    expect(requests).toHaveLength(2);
    expect(requests.map((entry) => entry.idempotency_key)).toEqual([
      `computer-agent-dispatch:${DISPATCH_ID}`,
      `computer-agent-dispatch:${DISPATCH_ID}`,
    ]);
    expect(requests[0]?.body).toEqual(requests[1]?.body);
    expect(uniqueWorkflowCreates).toBe(1);
    expect(receivedContext?.request.headers.get("X-Eliotr-Client-Grant")).toBe(GRANT_ID);
    expect(receivedContext?.principal_ref).toBe("codex-adapter-test.access");
    expect(receivedContext?.credential_generation).toBe("codex-adapter-credential-7");
  });
});
