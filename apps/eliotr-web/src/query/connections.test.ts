import { describe, expect, it, vi } from "vitest";
import type { ProjectListView } from "@eliotr/owner-api-client";
import { createWorkspaceRuntime } from "../app/runtime";
import { createPrivacyController } from "../app/privacy";
import { createWorkspaceQueryClient, clearWorkspaceQueries } from "./client";
import { connectionsQueryOptions } from "./connections";

const stamp = "2026-10-09T12:00:00.000Z";
const generation = "deployment-1";
const owner = { protocol: "eliotr.owner-session.v1", principal_ref: "owner-1", credential_generation: "credentials-1", client_class: "owner_pwa", expires_at: "2027-01-01T00:00:00.000Z" };
const health = { ready: true, deployment_generation: generation, core_schema_generation: "schema-1", search_schema_generation: "schema-1", blocking_reason_codes: [], checked_at: stamp };
const projects: ProjectListView = { protocol: "eliotr.project-owner-list.v1", deployment_generation: generation, projects: [{ project_id: "project-1", title: "Current project", revision: 1, source_ids: [], created_at: stamp }] };
const grants = { protocol: "eliotr.project-client-grants.v1", grants: [] };
const json = (data: unknown) => new Response(JSON.stringify({ data, trace_id: "trace-1", deployment_generation: generation }), { headers: { "content-type": "application/json" } });

async function fixture() {
  const client = createWorkspaceQueryClient();
  const timers = { setTimeout: () => 0, clearTimeout() {} };
  const mint = vi.fn(() => "11111111-1111-4111-8111-111111111111");
  let reply: (path: string) => Promise<Response> = async () => json(grants);
  const fetcher = vi.fn<typeof fetch>(async input => {
    const path = String(input);
    if (path === "/api/v1/system/health") return json(health);
    if (path === "/api/v1/system/session") return json(owner);
    return reply(path);
  });
  const runtime = createWorkspaceRuntime({ fetch: fetcher, baseUrl: "https://owner.example", timers, now: () => Date.parse(stamp), mint,
    async sha256(bytes) { return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes.slice())), value => value.toString(16).padStart(2, "0")).join(""); },
    isCurrent: context => privacy.isCurrent(context), onAuthorizationLoss() { privacy.close(); },
  });
  const privacy = createPrivacyController({ now: () => Date.parse(stamp), timers, mask() { runtime.close(); }, reveal() {},
    cancelReads() { void client.cancelQueries(undefined, { revert: false, silent: true }); }, clearProtected() { clearWorkspaceQueries(client); },
    verify: signal => runtime.verify(signal),
  });
  await privacy.refresh();
  const snapshot = privacy.getSnapshot();
  if (snapshot.phase !== "available") throw new Error("Actual fixture bootstrap failed");
  runtime.bind(snapshot.context);
  const apis = runtime.read(snapshot.context);
  if (!apis) throw new Error("Actual fixture binding failed");
  const current = { projects };
  const options = connectionsQueryOptions(apis, privacy, snapshot.context, () => current.projects);
  fetcher.mockClear();
  return { client, privacy, runtime, fetcher, mint, options, current,
    reply(callback: typeof reply) { reply = callback; },
    dispose() { privacy.dispose(); runtime.dispose(); client.clear(); },
  };
}

describe("independent Connections Query facts through the real factories", () => {
  it("reads the exact saved model operation instead of inferring it from model selection", async () => {
    const test = await fixture();
    const keyOperationId = "11111111-1111-4111-8111-111111111111", operationId = "22222222-2222-4222-8222-222222222222";
    const receipt = { protocol: "eliotr.research.provider-key-model-use.v1", project_id: "project-1", key_operation_id: keyOperationId,
      operation_id: operationId, state: "uncertain", phase: "native_qualify", selected_configuration_ref: null, selection_revision: null,
      failure_code: "QUALIFICATION_OUTCOME_UNCERTAIN", created_at: stamp, updated_at: stamp };
    test.reply(async path => {
      if (path !== `/api/v1/projects/project-1/model-provider-key/model-use/${operationId}`) throw new Error("Selection read cannot qualify a saved operation");
      return json(receipt);
    });
    const query = test.options.modelUse(projects, "project-1", keyOperationId, operationId);
    expect(await test.client.fetchQuery(query)).toEqual(receipt);
    expect(test.fetcher).toHaveBeenCalledTimes(1);
    expect(test.fetcher.mock.calls[0]?.[1]?.method).toBe("GET");
    expect(query.queryKey.slice(-2)).toEqual([keyOperationId, operationId]);
    expect(test.mint).not.toHaveBeenCalled();
    test.dispose();
  });
  it("keeps healthy API and owner-session facts when a separate provider read fails", async () => {
    const test = await fixture();
    test.reply(async path => {
      if (path !== "/api/v1/projects/project-1/model-provider-key") throw new Error("Unexpected product request");
      return new Response(JSON.stringify({ type: "urn:eliotr:problem:PROVIDER_UNAVAILABLE", title: "Unavailable", status: 503, code: "PROVIDER_UNAVAILABLE", trace_id: "trace-1", retryable: true }), { status: 503, headers: { "content-type": "application/json" } });
    });
    expect(await test.client.fetchQuery(test.options.health())).toMatchObject({ ready: true });
    expect(await test.client.fetchQuery(test.options.session())).toMatchObject({ principal_ref: "owner-1" });
    await expect(test.client.fetchQuery(test.options.providers(projects, "project-1"))).rejects.toMatchObject({ code: "PROVIDER_UNAVAILABLE" });
    expect(test.client.getQueryState(test.options.health().queryKey)?.status).toBe("success");
    expect(test.client.getQueryState(test.options.session().queryKey)?.status).toBe("success");
    expect(test.client.getQueryState(test.options.providers(projects, "project-1").queryKey)?.status).toBe("error");
    expect(test.mint).not.toHaveBeenCalled();
    expect(test.fetcher).toHaveBeenCalledTimes(3);
    test.dispose();
  });
  it("rejects foreign, replaced and old-generation project selections before dispatch", async () => {
    const test = await fixture();
    await expect(test.client.fetchQuery(test.options.grants(projects, "foreign"))).rejects.toThrow("Connections project");
    test.current.projects = { ...projects };
    await expect(test.client.fetchQuery(test.options.grants(projects, "project-1"))).rejects.toThrow("Connections project");
    test.current.projects = { ...projects, deployment_generation: "old-deployment" };
    await expect(test.client.fetchQuery(test.options.providers(test.current.projects, "project-1"))).rejects.toThrow("Connections project");
    expect(test.fetcher).not.toHaveBeenCalled();
    test.dispose();
  });
  it("rejects a successful grant response when its caller-held project page changes in flight", async () => {
    const test = await fixture();
    test.reply(async () => { test.current.projects = { ...projects, projects: [] }; return json(grants); });
    const read = test.options.grants(projects, "project-1");
    await expect(test.client.fetchQuery(read)).rejects.toThrow("Connections project");
    expect(test.client.getQueryData(read.queryKey)).toBeUndefined();
    expect(test.fetcher).toHaveBeenCalledTimes(1);
    test.dispose();
  });
  it("drops pending protected reads immediately on owner-context invalidation", async () => {
    const test = await fixture();
    const started = Promise.withResolvers<void>(), held = Promise.withResolvers<Response>();
    test.reply(async () => { started.resolve(); return held.promise; });
    const read = test.options.grants(projects, "project-1");
    const pending = test.client.fetchQuery(read).then(() => "unexpected-success", () => "rejected");
    await started.promise;
    test.privacy.close();
    expect(test.client.getQueryData(read.queryKey)).toBeUndefined();
    held.resolve(json(grants));
    expect(await pending).toBe("rejected");
    expect(test.client.getQueryData(read.queryKey)).toBeUndefined();
    test.dispose();
  });
});
