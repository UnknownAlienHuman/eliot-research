import { describe, expect, it, vi } from "vitest";
import type { ProjectListView } from "@eliotr/owner-api-client";
import { createWorkspaceRuntime } from "../app/runtime";
import { createPrivacyController } from "../app/privacy";
import { createWorkspaceQueryClient, clearWorkspaceQueries } from "./client";
import { computerAgentDispatchQueryOptions } from "./computerAgentDispatches";

const stamp = "2026-10-14T12:00:00.000Z", generation = "deployment-1";
const page: ProjectListView = { protocol: "eliotr.project-owner-list.v1", deployment_generation: generation,
  projects: [{ project_id: "project-a", title: "Project A", revision: 1, source_ids: [], created_at: stamp }] };
const responsePage = { protocol: "eliotr.computer-agent-dispatch-list.v2", items: [{
  protocol: "eliotr.computer-agent-dispatch-summary.v2", dispatch_id: "dispatch-a", project_id: "project-a",
  connection_id: "agent-a", connection_revision: 1, state: "ACCEPTED", created_at: stamp,
  expires_at: "2026-10-15T00:00:00.000Z", question_preview: "Owner question", question_utf8_bytes: 14,
  question_truncated: false, accepted_workflow: { workflow_instance_id: "workflow-a", investigation_ref: { id: "investigation-a", revision: 1 } },
}], next_after_dispatch_id: null };
const json = (data: unknown) => new Response(JSON.stringify({ data, trace_id: "trace-1", deployment_generation: generation }),
  { headers: { "content-type": "application/json" } });

async function fixture() {
  const client = createWorkspaceQueryClient(), timers = { setTimeout: () => 0, clearTimeout() {} }, mint = vi.fn(() => "unused-intent");
  let reply = async () => json(responsePage);
  const fetcher = vi.fn(async (url: string | URL | Request) => {
    const path = String(url);
    if (path === "/api/v1/system/health") return json({ ready: true, deployment_generation: generation,
      core_schema_generation: "schema-1", search_schema_generation: "schema-1", blocking_reason_codes: [], checked_at: stamp });
    if (path === "/api/v1/system/session") return json({ protocol: "eliotr.owner-session.v1", principal_ref: "owner-1",
      credential_generation: "credential-1", client_class: "owner_pwa", expires_at: "2027-01-01T00:00:00.000Z" });
    return reply();
  });
  const runtime = createWorkspaceRuntime({ fetch: fetcher, baseUrl: "https://owner.example", timers, now: () => Date.parse(stamp),
    mint, async sha256() { return "a".repeat(64); }, isCurrent: context => privacy.isCurrent(context), onAuthorizationLoss() { privacy.close(); } });
  const privacy = createPrivacyController({ now: () => Date.parse(stamp), timers, mask() { runtime.close(); }, reveal() {},
    cancelReads() { void client.cancelQueries(undefined, { revert: false, silent: true }); }, clearProtected() { clearWorkspaceQueries(client); },
    verify: signal => runtime.verify(signal) });
  await privacy.refresh();
  const snapshot = privacy.getSnapshot();
  if (snapshot.phase !== "available") throw new Error("Owner did not verify");
  runtime.bind(snapshot.context);
  const apis = runtime.read(snapshot.context);
  if (!apis) throw new Error("Owner runtime did not bind");
  return { client, privacy, context: snapshot.context, apis, mint, setReply(next: typeof reply) { reply = next; } };
}

describe("protected owner dispatch query", () => {
  it("reads dispatch acceptance without inventing completion or minting an intent", async () => {
    const f = await fixture();
    const value = await f.client.fetchQuery(computerAgentDispatchQueryOptions(f.apis, f.privacy, f.context, page, "project-a", () => page));
    expect(value.items[0]?.state).toBe("ACCEPTED");
    expect(value.items[0]).not.toHaveProperty("progress");
    expect(f.mint).not.toHaveBeenCalled();
  });
  it("suppresses a late task page when the held project page changes", async () => {
    const f = await fixture(); let held: ProjectListView = page, finish: ((value: Response) => void) | undefined;
    f.setReply(() => new Promise<Response>(resolve => { finish = resolve; }));
    const options = computerAgentDispatchQueryOptions(f.apis, f.privacy, f.context, page, "project-a", () => held);
    const pending = f.client.fetchQuery(options), rejected = expect(pending).rejects.toThrow("exact current owner project");
    await vi.waitFor(() => expect(finish).toBeDefined()); held = { ...page, projects: [] };
    finish?.(json(responsePage)); await rejected;
    expect(f.client.getQueryData(options.queryKey)).toBeUndefined();
  });
  it("clears and rejects a late page after synchronous owner authority loss", async () => {
    const f = await fixture(); let finish: ((value: Response) => void) | undefined;
    f.setReply(() => new Promise<Response>(resolve => { finish = resolve; }));
    const options = computerAgentDispatchQueryOptions(f.apis, f.privacy, f.context, page, "project-a", () => page);
    const pending = f.client.fetchQuery(options), rejected = expect(pending).rejects.toThrow();
    await vi.waitFor(() => expect(finish).toBeDefined()); f.privacy.close(); finish?.(json(responsePage)); await rejected;
    expect(f.client.getQueryData(options.queryKey)).toBeUndefined();
  });
});
