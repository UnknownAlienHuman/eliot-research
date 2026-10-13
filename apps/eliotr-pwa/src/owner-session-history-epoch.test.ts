import { afterEach, describe, expect, it, vi } from "vitest";
import { createPwaResearchRunHistoryApi } from "@eliotr/pwa-research-workspace/research-run-api";
import { createOwnerSessionLifecycle } from "./owner-session-lifecycle.js";
import type { OwnerSession } from "./owner-session-api.js";

const now = Date.parse("2026-10-13T00:00:00.000Z");
const generation = "history-epoch-generation";
const session = (): OwnerSession => ({ principal_ref: "test-owner", credential_generation: "test-credential",
  expires_at: new Date(now + 60_000).toISOString(), client_class: "owner_pwa" });
function fixture() {
  vi.spyOn(Date, "now").mockReturnValue(now);
  let currentGeneration = generation, healthy = true;
  const lifecycle = createOwnerSessionLifecycle({ deploymentGeneration: () => currentGeneration,
    healthReady: () => healthy, onVerified() {}, onCleared() {}, refreshReadPanes() {} });
  return { lifecycle, changeGeneration() { currentGeneration = "new-generation"; }, loseHealth() { healthy = false; } };
}
const response = () => new Response(JSON.stringify({ trace_id: "history-epoch-test", deployment_generation: generation,
  data: { protocol: "eliotr.research-runs.v4", configuration_state: "INSTALLED", checked_at: new Date(now).toISOString(),
    runs: [], saved_drafts: [], visibility_scan: { runs: "SOURCE_EXHAUSTED", saved_drafts: "SOURCE_EXHAUSTED" } } }),
  { status: 200, headers: { "content-type": "application/json" } });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("actual PWA owner-session epoch for history", () => {
  it("captures only the actual verified session object", () => {
    const { lifecycle } = fixture();
    expect(lifecycle.epoch.capture()).toBeUndefined();
    expect(lifecycle.epoch.isCurrent(undefined)).toBe(false);
    const owner = session(); lifecycle.onVerified(owner, generation);
    expect(lifecycle.epoch.capture()).toBe(owner);
    expect(lifecycle.epoch.isCurrent(owner)).toBe(true);
    expect(lifecycle.epoch.isCurrent({ ...owner })).toBe(false);
  });
  it.each(["clear", "expire", "generation", "health", "replace"] as const)("rejects the old capture after %s", reason => {
    const f = fixture(), owner = session(); f.lifecycle.onVerified(owner, generation);
    if (reason === "clear") f.lifecycle.onCleared();
    if (reason === "expire") vi.spyOn(Date, "now").mockReturnValue(now + 60_000);
    if (reason === "generation") f.changeGeneration();
    if (reason === "health") f.loseHealth();
    if (reason === "replace") f.lifecycle.onVerified(session(), generation);
    expect(f.lifecycle.epoch.isCurrent(owner)).toBe(false);
    if (reason !== "replace") expect(f.lifecycle.epoch.capture()).toBeUndefined();
  });
  it("keeps the real legacy HTTP transport behind the owner history preflight and response fences", async () => {
    const f = fixture(), history = createPwaResearchRunHistoryApi(f.lifecycle.epoch);
    const fetch = vi.fn< typeof globalThis.fetch >(); vi.stubGlobal("fetch", fetch);
    await expect(history.readResearchRunHistory(generation)).rejects.toMatchObject({ code: "API_SESSION_CLOSED" });
    expect(fetch).not.toHaveBeenCalled();
    f.lifecycle.onVerified(session(), generation);
    fetch.mockResolvedValueOnce(response());
    await expect(history.readResearchRunHistory(generation)).resolves.toMatchObject({ protocol: "eliotr.research-runs.v4" });
    let release: (value: Response) => void = () => { throw new Error("held response was not requested"); };
    fetch.mockImplementationOnce(() => new Promise<Response>(resolve => { release = resolve; }));
    const pending = history.readResearchRunHistory(generation);
    f.lifecycle.onCleared(); release(response());
    await expect(pending).rejects.toMatchObject({ code: "API_SESSION_CLOSED" });
    expect(fetch).toHaveBeenCalledTimes(2);
  });
  it.each(["principal", "credential", "deployment", "class", "expired"] as const)("clears before publishing a replacement %s authority", reason => {
    vi.spyOn(Date, "now").mockReturnValue(now);
    const events: string[] = [];
    let generationAtRoot = generation;
    const lifecycle = createOwnerSessionLifecycle({ deploymentGeneration: () => generationAtRoot, healthReady: () => true,
      onVerified() { events.push("verified"); }, onCleared() {
        expect(lifecycle.epoch.capture()).toBeUndefined(); events.push("cleared");
      }, refreshReadPanes() {} });
    const original = session(); lifecycle.onVerified(original, generation); events.length = 0;
    const next = { ...original,
      ...(reason === "principal" ? { principal_ref: "next-owner" } : {}),
      ...(reason === "credential" ? { credential_generation: "next-credential" } : {}),
      ...(reason === "class" ? { client_class: "named_api_client" } : {}),
      ...(reason === "expired" ? { expires_at: new Date(now + 120_000).toISOString() } : {}),
    };
    if (reason === "deployment") generationAtRoot = "new-generation";
    if (reason === "expired") vi.spyOn(Date, "now").mockReturnValue(now + 60_000);
    lifecycle.onVerified(next, generationAtRoot);
    expect(events).toEqual(["cleared", "verified"]);
    expect(lifecycle.epoch.capture()).toBe(next);
    expect(lifecycle.epoch.isCurrent(original)).toBe(false);
  });
  it("accepts owner v2 failure outcomes and ordered consequences through the actual PWA caller", async () => {
    const f = fixture(); f.lifecycle.onVerified(session(), generation);
    const first = { code: "WORKFLOW_EFFECT_UNCERTAIN", phase: "RECOVERY", stage: "RECONCILE", retryable: false,
      protocol: "eliotr.workflow-failure-outcome.v1", dispatch_state: "OUTCOME_UNKNOWN",
      references_intact: "UNKNOWN", recovery_action: "READBACK" };
    const consequence = { code: "WORKFLOW_BUDGET_STOP", phase: "STAGE", stage: "PLAN", retryable: false };
    vi.stubGlobal("fetch", vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(JSON.stringify({
      trace_id: "history-v2-outcome", deployment_generation: generation,
      data: { protocol: "eliotr.research-runs.v4", configuration_state: "INSTALLED", checked_at: new Date(now).toISOString(),
        saved_drafts: [], visibility_scan: { runs: "SOURCE_EXHAUSTED", saved_drafts: "SOURCE_EXHAUSTED" },
        runs: [{ created_at: new Date(now).toISOString(), status: { protocol: "eliotr.research-run-status.v2",
          workflow_instance_id: "test-run", investigation_ref: { id: "test-investigation", revision: 2 },
          execution_state: "ACTIVE", engine_status: "errored", next_stage_index: 3, answer: { availability: "unavailable" },
          failure: { ...first, consequence, consequences: [consequence] } } }] } }),
      { status: 200, headers: { "content-type": "application/json" } })));
    const view = await createPwaResearchRunHistoryApi(f.lifecycle.epoch).readResearchRunHistory(generation);
    expect(view.runs[0]?.status.failure).toEqual({ ...first, consequence, consequences: [consequence] });
  });
});
