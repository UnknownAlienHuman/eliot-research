import { describe, expect, it, vi } from "vitest";
import { createWorkspaceRuntime } from "../app/runtime";
import { createPrivacyController } from "../app/privacy";
import { createWorkspaceQueryClient } from "./client";
import { matchesResearchRunLaunch, researchQueryOptions } from "./research";

const generation = "deployment-1";
const stamp = "2026-10-09T12:00:00.000Z";
const readiness = { protocol: "eliotr.research-configuration-readiness.v1", configuration: "present", model_transport: "available",
  qualification_state: "current", run_readiness: "ready", readiness_reason: "QUALIFICATION_PROOFS_CURRENT", model_route: "route/research",
  qualification_expires_at: "2027-01-01T00:00:00.000Z", missing_fields: [], invalid_fields: [], checked_at: stamp };
const json = (data: unknown) => new Response(JSON.stringify({ data, trace_id: "trace-1", deployment_generation: generation }), { headers: { "content-type": "application/json" } });

async function fixture() {
  const client = createWorkspaceQueryClient(), timers = { setTimeout: () => 0, clearTimeout() {} };
  let reply = async () => json(readiness);
  const fetcher = vi.fn<typeof fetch>(async input => {
    if (String(input) === "/api/v1/system/health") return json({ ready: true, deployment_generation: generation, core_schema_generation: "schema-1", search_schema_generation: "schema-1", blocking_reason_codes: [], checked_at: stamp });
    if (String(input) === "/api/v1/system/session") return json({ protocol: "eliotr.owner-session.v1", principal_ref: "owner-1", credential_generation: "credentials-1", client_class: "owner_pwa", expires_at: "2027-01-01T00:00:00.000Z" });
    return reply();
  });
  const runtime = createWorkspaceRuntime({ fetch: fetcher, baseUrl: "https://owner.example", timers, now: () => Date.parse(stamp),
    mint: () => "11111111-1111-4111-8111-111111111111",
    async sha256(bytes) { return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes.slice())), value => value.toString(16).padStart(2, "0")).join(""); },
    isCurrent: context => privacy.isCurrent(context), onAuthorizationLoss() { privacy.close(); },
  });
  const privacy = createPrivacyController({ timers, now: () => Date.parse(stamp), mask() { runtime.close(); }, reveal() {}, cancelReads() {}, clearProtected() {}, verify: signal => runtime.verify(signal) });
  await privacy.refresh();
  const state = privacy.getSnapshot(); if (state.phase !== "available") throw new Error("Fixture unavailable");
  fetcher.mockClear();
  runtime.bind(state.context);
  const apis = runtime.read(state.context); if (!apis) throw new Error("Fixture binding unavailable");
  return { client, privacy, context: state.context, fetcher, apis: { ...apis.research, configuration: apis.connections.configuration }, reply: (value: () => Promise<Response>) => { reply = value; } };
}

describe("Research selected project readiness", () => {
  it("passes the selected project through the real client and gives each project a distinct cache key", async () => {
    const test = await fixture();
    const options = researchQueryOptions(test.apis, test.privacy, test.context, { id: "project/one", isCurrent: () => true });
    expect((await test.client.fetchQuery(options.configuration())).run_readiness).toBe("ready");
    expect(String(test.fetcher.mock.calls[0]?.[0])).toBe("/api/v1/system/research-configuration?project_id=project%2Fone");
    const other = researchQueryOptions(test.apis, test.privacy, test.context, { id: "project/two", isCurrent: () => true });
    expect(other.configuration().queryKey).not.toEqual(options.configuration().queryKey);
    test.privacy.close(); test.client.clear();
  });
  it("refuses an absent or stale project before any request", async () => {
    const test = await fixture();
    await expect(test.client.fetchQuery(researchQueryOptions(test.apis, test.privacy, test.context).configuration())).rejects.toThrow("project is no longer current");
    await expect(test.client.fetchQuery(researchQueryOptions(test.apis, test.privacy, test.context, { id: "old-project", isCurrent: () => false }).configuration())).rejects.toThrow("project is no longer current");
    expect(test.fetcher).not.toHaveBeenCalled();
    test.privacy.close(); test.client.clear();
  });
  it("rejects readiness that arrives after its project page stops being current", async () => {
    const test = await fixture(); let current = true; let finish!: (value: Response) => void;
    test.reply(() => new Promise(resolve => { finish = resolve; }));
    const options = researchQueryOptions(test.apis, test.privacy, test.context, { id: "project/one", isCurrent: () => current });
    const pending = test.client.fetchQuery(options.configuration());
    await vi.waitFor(() => expect(test.fetcher).toHaveBeenCalledTimes(1));
    current = false; finish(json(readiness));
    await expect(pending).rejects.toThrow("project is no longer current");
    expect(test.client.getQueryData(options.configuration().queryKey)).toBeUndefined();
    test.privacy.close(); test.client.clear();
  });
});


describe("Research run revision advancement", () => {
  const launch = { workflow_instance_id: "run-1", investigation_ref: { id: "investigation-1", revision: 1 }, deployment_generation: generation };
  const current = { protocol: "eliotr.research-run-status.v2", workflow_instance_id: launch.workflow_instance_id,
    investigation_ref: { id: launch.investigation_ref.id, revision: 12 }, execution_state: "ACTIVE", engine_status: "errored",
    next_stage_index: 11, answer: { availability: "unavailable" },
    failure: { code: "WORKFLOW_EFFECT_UNCERTAIN", phase: "STAGE", retryable: false, stage: "FREEZE_EVIDENCE",
      protocol: "eliotr.workflow-failure-outcome.v1", dispatch_state: "OUTCOME_UNKNOWN", references_intact: "UNKNOWN",
      recovery_action: "RECONCILE", consequence: { code: "WORKFLOW_EFFECT_UNCERTAIN", phase: "STAGE", retryable: false, stage: "FREEZE_EVIDENCE" },
      consequences: [{ code: "WORKFLOW_EFFECT_UNCERTAIN", phase: "STAGE", retryable: false, stage: "FREEZE_EVIDENCE" }] } };
  it("reads the actual failure after an admitted investigation advances to revision 12", async () => {
    const test = await fixture(); test.reply(async () => json(current));
    const view = await test.client.fetchQuery(researchQueryOptions(test.apis, test.privacy, test.context).status(launch));
    expect(String(test.fetcher.mock.calls[0]?.[0])).toBe("/api/v1/research/run/run-1");
    expect(view.investigation_ref.revision).toBe(12); expect(view.failure?.code).toBe("WORKFLOW_EFFECT_UNCERTAIN");
    test.privacy.close(); test.client.clear();
  });
  it("accepts a completed current revision for a run selected from history", async () => {
    const test = await fixture();
    test.reply(async () => json({ protocol: "eliotr.research-run-status.v1", workflow_instance_id: launch.workflow_instance_id,
      investigation_ref: { id: launch.investigation_ref.id, revision: 19 }, execution_state: "ENGINE_COMPLETED", engine_status: "complete",
      next_stage_index: 18, answer: { availability: "draft", artifact_ref: { id: "artifact-1", revision: 1 } } }));
    const historyLaunch = { ...launch, investigation_ref: { ...launch.investigation_ref, revision: 12 } };
    const view = await test.client.fetchQuery(researchQueryOptions(test.apis, test.privacy, test.context).status(historyLaunch));
    expect(view.answer).toEqual({ availability: "draft", artifact_ref: { id: "artifact-1", revision: 1 } });
    expect(matchesResearchRunLaunch(view, historyLaunch)).toBe(true);
    test.privacy.close(); test.client.clear();
  });
  it("rejects foreign investigation identity and a revision older than the held history snapshot", async () => {
    const test = await fixture();
    test.reply(async () => json({ ...current, investigation_ref: { id: "foreign-investigation", revision: 12 } }));
    const options = researchQueryOptions(test.apis, test.privacy, test.context);
    await expect(test.client.fetchQuery(options.status(launch))).rejects.toThrow("does not belong");
    const historyLaunch = { ...launch, investigation_ref: { ...launch.investigation_ref, revision: 13 } };
    test.reply(async () => json(current));
    await expect(test.client.fetchQuery(options.status(historyLaunch))).rejects.toThrow("does not belong");
    expect(test.client.getQueryData(options.status(historyLaunch).queryKey)).toBeUndefined();
    test.privacy.close(); test.client.clear();
  });
});
