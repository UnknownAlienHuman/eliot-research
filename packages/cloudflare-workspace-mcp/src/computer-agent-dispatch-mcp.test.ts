import { describe, expect, it } from "vitest";
import {
  createMcpResearchApplicationDispatch,
  type McpResearchApplicationOperations,
  type McpResearchPreparedOperation,
} from "./research-application-dispatch.js";
import {
  MCP_RESEARCH_TOOLS,
  type McpComputerAgentDispatchToolName,
} from "./gemini-mcp-research-tools.js";
import type { GeminiMcpToolError } from "./gemini-mcp-tool-common.js";
import type { McpToolCallContext } from "./gemini-mcp-protocol.js";

const OWNER_GRANT = "owner-grant-7";
const DISPATCH_ID = "dispatch-owner-selected-7";
const REQUEST = {
  query: "What does the approved project source report?",
  product: "RESEARCH",
  scope_expression: { kind: "PROJECT", project_id: "project-7" },
  literals: [],
  evidence_grade: "E1",
  budget_ref: "research-budget-v1",
  max_results: 4,
  request_version: "eliotr.research-run-request.v2",
};

function context(profile: "service-token" | "managed-oauth"): McpToolCallContext {
  const actorRef = profile === "service-token" ? "agent-7.access" : "owner@example.com";
  const authenticationMethod = profile === "service-token" ? "service_token" : "cloudflare_access";
  const expiresAt = "2099-01-01T00:00:00.000Z";
  return {
    principal_ref: actorRef,
    trace_id: `trace-${profile}`,
    deployment_generation: "deployment-7",
    verified_actor: {
      actor_ref: actorRef,
      credential_generation: `${profile}-credential-7`,
      authentication_method: authenticationMethod,
      expires_at: expiresAt,
      auth_profile: profile,
      deployment_generation: "deployment-7",
    },
    verified_access: {
      principal_ref: actorRef,
      credential_generation: `${profile}-credential-7`,
      authentication_method: authenticationMethod,
      issuer: "https://mcp-test-example.cloudflareaccess.com",
      expires_at: expiresAt,
    },
  };
}

describe("service-token MCP owner-selected dispatch tools", () => {
  it("requires the owner grant, denies Managed OAuth, and replays acceptance through one run identity", async () => {
    const names: readonly McpComputerAgentDispatchToolName[] = [
      "eliotr_dispatch_pull", "eliotr_dispatch_accept", "eliotr_dispatch_decline",
    ];
    for (const name of names) {
      const schema = MCP_RESEARCH_TOOLS[name].inputSchema as {
        readonly additionalProperties?: boolean;
        readonly required?: readonly string[];
      };
      expect(schema.additionalProperties).toBe(false);
      expect(schema.required).toContain("client_grant_id");
    }

    const starts: Array<{ readonly key: string; readonly request: typeof REQUEST }> = [];
    const runs = new Map<string, { readonly workflow_instance_id: string }>();
    let uniqueWorkflowCreates = 0;
    let serviceCalls = 0;
    const execute = async (name: McpComputerAgentDispatchToolName,
      args: Record<string, unknown>): Promise<unknown> => {
      if (args.client_grant_id !== OWNER_GRANT) throw new Error("exact owner grant was not forwarded");
      if (name === "eliotr_dispatch_pull") {
        serviceCalls += 1;
        return { protocol: "eliotr.computer-agent-dispatch-offer.v1",
          dispatch: { dispatch_id: DISPATCH_ID, transport: "MCP_WRITE" } };
      }
      if (args.dispatch_id !== DISPATCH_ID) throw new Error("dispatch identity changed");
      if (name === "eliotr_dispatch_decline") return { declined: true };

      const key = `computer-agent-dispatch:${DISPATCH_ID}`;
      starts.push({ key, request: REQUEST });
      let run = runs.get(key);
      if (run === undefined) {
        uniqueWorkflowCreates += 1;
        run = { workflow_instance_id: "run-7" };
        runs.set(key, run);
      }
      serviceCalls += 1;
      return {
        protocol: "eliotr.computer-agent-dispatch-accepted.v1",
        dispatch_id: DISPATCH_ID,
        workflow_instance_id: run.workflow_instance_id,
      };
    };
    const prepared = (name: McpComputerAgentDispatchToolName,
      args: Record<string, unknown>): McpResearchPreparedOperation => ({ execute: () => execute(name, args) });
    const operations = {
      computer_agent_dispatch: async (name: McpComputerAgentDispatchToolName,
        args: Record<string, unknown>) => prepared(name, args),
    } as unknown as McpResearchApplicationOperations<McpToolCallContext>;
    const call = createMcpResearchApplicationDispatch({
      resolve_actor: async (_name, _args, toolContext) => ({
        context: toolContext,
        managed_oauth: toolContext.verified_actor?.auth_profile === "managed-oauth",
      }),
      require_owner_project: async () => undefined,
      operations,
      execute_with_currentness: async (_name, _args, _actor, operation) => operation.execute(),
      require_readiness: async () => undefined,
      map_error: (error): never => { throw error; },
    });

    const offer = await call("eliotr_dispatch_pull", { client_grant_id: OWNER_GRANT }, context("service-token"));
    expect(offer).toMatchObject({ protocol: "eliotr.computer-agent-dispatch-offer.v1",
      dispatch: { dispatch_id: DISPATCH_ID, transport: "MCP_WRITE" } });
    await expect(call("eliotr_dispatch_accept", {
      client_grant_id: OWNER_GRANT, dispatch_id: DISPATCH_ID,
    }, context("managed-oauth"))).rejects.toMatchObject({
      code: "MCP_RESEARCH_UNAVAILABLE",
    } satisfies Partial<GeminiMcpToolError>);

    const args = { client_grant_id: OWNER_GRANT, dispatch_id: DISPATCH_ID };
    const first = await call("eliotr_dispatch_accept", args, context("service-token"));
    const replay = await call("eliotr_dispatch_accept", args, context("service-token"));
    expect(replay).toEqual(first);
    expect(serviceCalls).toBe(3);
    expect(uniqueWorkflowCreates).toBe(1);
    expect(starts).toHaveLength(2);
    expect(starts.map((entry) => entry.key)).toEqual([
      `computer-agent-dispatch:${DISPATCH_ID}`,
      `computer-agent-dispatch:${DISPATCH_ID}`,
    ]);
    expect(starts[0]?.request).toEqual(starts[1]?.request);
  });
});
