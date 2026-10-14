import { describe, expect, it, vi } from "vitest";
import { createWorkspaceRuntime } from "../app/runtime";
import { createPrivacyController } from "../app/privacy";
import { createWorkspaceQueryClient, clearWorkspaceQueries } from "./client";
import { computerAgentQueryOptions } from "./computerAgents";

const stamp = "2026-10-14T12:00:00.000Z";
const generation = "deployment-1";
const json = (data: unknown) => new Response(JSON.stringify({ data, trace_id: "trace-1", deployment_generation: generation }),
  { headers: { "content-type": "application/json" } });
const connection = {
  protocol: "eliotr.computer-agent-connection.v1", connection_id: "agent-a", revision: 1,
  owner_principal_ref: "owner-1", state: "ENABLED", display_name: "Research agent", contour: "OTHER",
  actor: { issuer: "https://owner.cloudflareaccess.com", authentication_method: "service_token", subject: "agent.access" },
  transport_capabilities: ["MCP_WRITE"], computer_capabilities: [], task_kinds: ["RESEARCH_BRANCH_ANALYSIS"],
  created_at: stamp, updated_at: stamp,
};

async function fixture() {
  const client = createWorkspaceQueryClient();
  const timers = { setTimeout: () => 0, clearTimeout() {} };
  const mint = vi.fn(() => "operation-1");
  let reply: (path: string) => Promise<Response> = async () => json({ protocol: "eliotr.computer-agent-connections.v1", connections: [connection] });
  const fetcher = vi.fn<typeof fetch>(async input => {
    const path = String(input);
    if (path === "/api/v1/system/health") return json({ ready: true, deployment_generation: generation,
      core_schema_generation: "schema-1", search_schema_generation: "schema-1", blocking_reason_codes: [], checked_at: stamp });
    if (path === "/api/v1/system/session") return json({ protocol: "eliotr.owner-session.v1", principal_ref: "owner-1",
      credential_generation: "credential-1", client_class: "owner_pwa", expires_at: "2027-01-01T00:00:00.000Z" });
    return reply(path);
  });
  const runtime = createWorkspaceRuntime({ fetch: fetcher, baseUrl: "https://owner.example", timers,
    now: () => Date.parse(stamp), mint, async sha256(bytes) {
      return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes.slice())), b => b.toString(16).padStart(2, "0")).join("");
    }, isCurrent: context => privacy.isCurrent(context), onAuthorizationLoss() { privacy.close(); } });
  const privacy = createPrivacyController({ now: () => Date.parse(stamp), timers,
    mask() { runtime.close(); }, reveal() {}, cancelReads() { void client.cancelQueries(undefined, { revert: false, silent: true }); },
    clearProtected() { clearWorkspaceQueries(client); }, verify: signal => runtime.verify(signal) });
  await privacy.refresh();
  const snapshot = privacy.getSnapshot();
  if (snapshot.phase !== "available") throw new Error("fixture owner did not verify");
  runtime.bind(snapshot.context);
  const apis = runtime.read(snapshot.context);
  if (apis === undefined) throw new Error("fixture runtime did not bind");
  return { client, runtime, apis, privacy, context: snapshot.context, fetcher, mint,
    setReply(next: typeof reply) { reply = next; } };
}

describe("protected owner agent connection query", () => {
  it("reads configured connections without minting an intent or claiming presence", async () => {
    const f = await fixture();
    const page = await f.client.fetchQuery(computerAgentQueryOptions(f.apis, f.privacy, f.context));
    expect(page.connections[0]).toMatchObject({ state: "ENABLED", display_name: "Research agent" });
    expect(page.connections[0]).not.toHaveProperty("presence");
    expect(f.mint).not.toHaveBeenCalled();
    expect(f.fetcher.mock.calls.map(call => String(call[0])).filter(path => path.includes("computer-agents")))
      .toEqual(["/api/v1/system/computer-agents"]);
  });

  it("rejects a cross-owner page before caching its connection names", async () => {
    const f = await fixture();
    f.setReply(async () => json({ protocol: "eliotr.computer-agent-connections.v1",
      connections: [{ ...connection, owner_principal_ref: "other-owner" }] }));
    const options = computerAgentQueryOptions(f.apis, f.privacy, f.context);
    await expect(f.client.fetchQuery(options)).rejects.toThrow("another owner");
    expect(f.client.getQueryData(options.queryKey)).toBeUndefined();
  });

  it("suppresses a late page after synchronous authority loss", async () => {
    const f = await fixture();
    let resolve: ((response: Response) => void) | undefined;
    f.setReply(() => new Promise<Response>(done => { resolve = done; }));
    const options = computerAgentQueryOptions(f.apis, f.privacy, f.context);
    const pending = f.client.fetchQuery(options);
    const rejection = expect(pending).rejects.toThrow();
    await vi.waitFor(() => expect(resolve).toBeDefined());
    f.privacy.close();
    if (resolve === undefined) throw new Error("page was not requested");
    resolve(json({ protocol: "eliotr.computer-agent-connections.v1", connections: [connection] }));
    await rejection;
    expect(f.client.getQueryData(options.queryKey)).toBeUndefined();
  });
});
