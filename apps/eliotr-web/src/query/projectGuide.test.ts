import { describe, expect, it, vi } from "vitest";
import type { ProjectGuideApi, ProjectGuideView } from "@eliotr/owner-api-client";
import { createPrivacyController } from "../app/privacy";
import { createWorkspaceQueryClient } from "./client";
import { ensureProjectGuideOnOpen, projectGuideQueryOptions, type ProjectGuideConnection } from "./projectGuide";

const missing: ProjectGuideView = { protocol: "eliotr.project-guide.v1", project_id: "project", language: "en", state: "MISSING",
  corpus_digest: "a".repeat(64), identity_digest: "b".repeat(64), source_count: 1,
  workflow_instance_id: null, artifact_ref: null, reason_code: null, guide: null };
async function fixture() {
  const privacy = createPrivacyController({ mask() {}, reveal() {}, cancelReads() {}, clearProtected() {},
    timers: { setTimeout: () => 0, clearTimeout() {} }, now: () => Date.parse("2026-10-17T00:00:00.000Z"),
    verify: async () => ({ principal: "owner", credentialGeneration: "credential", deploymentGeneration: "deployment",
      expiresAt: "2027-01-01T00:00:00.000Z" }) });
  await privacy.refresh(); const state = privacy.getSnapshot(); if (state.phase !== "available") throw new Error("session");
  let current = true;
  const ensure = vi.fn<ProjectGuideApi["ensure"]>(async () => ({ ...missing, state: "UNKNOWN", workflow_instance_id: "run-guide" }));
  const read = vi.fn<ProjectGuideApi["read"]>(async () => missing);
  const connection: ProjectGuideConnection = { api: { ensure, read }, privacy, context: state.context,
    projectId: "project", hasSourceEvidence: true, isProjectCurrent: () => current };
  return { connection, ensure, read, close: () => privacy.close(), stale: () => { current = false; } };
}
describe("guide project-open coordination", () => {
  it("reconciles rejection before reservation by GET and retries only after a fresh same-identity MISSING read", async () => {
    const f = await fixture(), client = createWorkspaceQueryClient(), signal = new AbortController().signal;
    f.ensure.mockRejectedValueOnce(new Error("failed before reservation"));
    expect(await ensureProjectGuideOnOpen(f.connection, missing, signal)).toEqual(missing);
    expect(f.read).toHaveBeenCalledTimes(1);
    expect(ensureProjectGuideOnOpen(f.connection, missing, signal)).toBeUndefined();
    expect(f.ensure).toHaveBeenCalledTimes(1);
    expect((await client.fetchQuery(projectGuideQueryOptions(f.connection, "en"))).state).toBe("UNKNOWN");
    expect(f.read).toHaveBeenCalledTimes(2); expect(f.ensure).toHaveBeenCalledTimes(2);
    expect(f.ensure.mock.calls[1]?.slice(0, 3)).toEqual(f.ensure.mock.calls[0]?.slice(0, 3));
    f.close(); client.clear();
  });
  it.each(["UNKNOWN", "PENDING"] as const)("retains a confirmed %s reservation after a rejected POST", async state => {
    const f = await fixture(), client = createWorkspaceQueryClient(), signal = new AbortController().signal;
    f.ensure.mockRejectedValue(new Error("response lost after reservation"));
    f.read.mockResolvedValueOnce({ ...missing, state, workflow_instance_id: "run-guide" });
    expect((await ensureProjectGuideOnOpen(f.connection, missing, signal))?.state).toBe(state);
    await client.fetchQuery(projectGuideQueryOptions(f.connection, "en"));
    expect(ensureProjectGuideOnOpen(f.connection, missing, signal)).toBeUndefined();
    expect(f.ensure).toHaveBeenCalledTimes(1); f.close(); client.clear();
  });
  it("cannot loop admission on renders when both the first POST and the checked retry fail", async () => {
    const f = await fixture(), client = createWorkspaceQueryClient(), signal = new AbortController().signal;
    f.ensure.mockRejectedValue(new Error("still before reservation"));
    await ensureProjectGuideOnOpen(f.connection, missing, signal);
    for (let i = 0; i < 5; i++) expect(ensureProjectGuideOnOpen(f.connection, missing, signal)).toBeUndefined();
    const options = projectGuideQueryOptions(f.connection, "en");
    expect(options.retry).toBe(false); expect(options.retryOnMount).toBe(false);
    expect(options.refetchOnMount).toBe(false); expect(options.refetchOnWindowFocus).toBe(false);
    await client.fetchQuery(options);
    for (let i = 0; i < 5; i++) expect(ensureProjectGuideOnOpen(f.connection, missing, signal)).toBeUndefined();
    expect(f.ensure).toHaveBeenCalledTimes(2); expect(f.read).toHaveBeenCalledTimes(3);
    f.close(); client.clear();
  });
  it("does not release a rejected old identity when reconciliation reads a changed identity", async () => {
    const f = await fixture(), client = createWorkspaceQueryClient(), signal = new AbortController().signal;
    f.ensure.mockRejectedValue(new Error("unknown outcome"));
    f.read.mockResolvedValue({ ...missing, identity_digest: "c".repeat(64) });
    await ensureProjectGuideOnOpen(f.connection, missing, signal);
    await client.fetchQuery(projectGuideQueryOptions(f.connection, "en"));
    expect(ensureProjectGuideOnOpen(f.connection, missing, signal)).toBeUndefined();
    expect(f.ensure).toHaveBeenCalledTimes(1); f.close(); client.clear();
  });
  it("keeps an unreadable POST outcome held until a later authoritative MISSING read", async () => {
    const f = await fixture(), client = createWorkspaceQueryClient(), signal = new AbortController().signal;
    f.ensure.mockRejectedValueOnce(new Error("unknown POST outcome"));
    f.read.mockRejectedValueOnce(new Error("reconciliation unavailable"));
    await expect(ensureProjectGuideOnOpen(f.connection, missing, signal)).rejects.toThrow("reconciliation unavailable");
    expect(ensureProjectGuideOnOpen(f.connection, missing, signal)).toBeUndefined();
    expect(f.ensure).toHaveBeenCalledTimes(1);
    await client.fetchQuery(projectGuideQueryOptions(f.connection, "en"));
    expect(f.ensure).toHaveBeenCalledTimes(2); f.close(); client.clear();
  });
  it("cannot release the failed latch from a same-identity read after project authority is lost", async () => {
    const f = await fixture(), client = createWorkspaceQueryClient(), signal = new AbortController().signal;
    f.ensure.mockRejectedValueOnce(new Error("failed admission"));
    await ensureProjectGuideOnOpen(f.connection, missing, signal);
    const gate = Promise.withResolvers<ProjectGuideView>(); f.read.mockImplementation(() => gate.promise);
    const checked = client.fetchQuery(projectGuideQueryOptions(f.connection, "en"));
    f.stale(); gate.resolve(missing);
    await expect(checked).rejects.toThrow("no longer current");
    expect(ensureProjectGuideOnOpen({ ...f.connection, isProjectCurrent: () => true }, missing, signal)).toBeUndefined();
    expect(f.ensure).toHaveBeenCalledTimes(1); f.close(); client.clear();
  });
  it("keeps the latch while rejection reconciliation is still in flight", async () => {
    const f = await fixture(), client = createWorkspaceQueryClient(), signal = new AbortController().signal;
    const gate = Promise.withResolvers<ProjectGuideView>();
    f.ensure.mockRejectedValue(new Error("lost response"));
    f.read.mockImplementationOnce(() => gate.promise);
    const pending = ensureProjectGuideOnOpen(f.connection, missing, signal);
    await vi.waitFor(() => expect(f.read).toHaveBeenCalledTimes(1));
    await client.fetchQuery(projectGuideQueryOptions(f.connection, "en"));
    gate.resolve(missing); await pending;
    expect(ensureProjectGuideOnOpen(f.connection, missing, signal)).toBeUndefined();
    expect(f.ensure).toHaveBeenCalledTimes(1); f.close(); client.clear();
  });
  it("coalesces repeated StrictMode/open events and never re-dispatches a settled unknown identity", async () => {
    const f = await fixture(), signal = new AbortController().signal;
    const first = ensureProjectGuideOnOpen(f.connection, missing, signal);
    expect(ensureProjectGuideOnOpen(f.connection, missing, signal)).toBe(first);
    await first;
    expect(ensureProjectGuideOnOpen(f.connection, missing, signal)).toBeUndefined();
    expect(f.ensure).toHaveBeenCalledTimes(1); f.close();
  });
  it("does not ensure empty projects, stale scope, blocked models or already held outcomes", async () => {
    const f = await fixture(), signal = new AbortController().signal;
    expect(ensureProjectGuideOnOpen({ ...f.connection, hasSourceEvidence: false }, missing, signal)).toBeUndefined();
    for (const state of ["EMPTY", "BLOCKED", "UNKNOWN", "FAILED", "PENDING"] as const) {
      expect(ensureProjectGuideOnOpen(f.connection, { ...missing, state }, signal)).toBeUndefined();
    }
    f.stale(); expect(ensureProjectGuideOnOpen(f.connection, missing, signal)).toBeUndefined();
    expect(f.ensure).not.toHaveBeenCalled(); f.close();
  });
  it("drops responses after owner/project loss without mutating ordinary Research state", async () => {
    const f = await fixture(), client = createWorkspaceQueryClient();
    const gate = Promise.withResolvers<ProjectGuideView>(); f.read.mockImplementation(() => gate.promise);
    const options = projectGuideQueryOptions(f.connection, "en");
    const result = client.fetchQuery(options); f.stale(); gate.resolve(missing);
    await expect(result).rejects.toThrow("no longer current");
    expect(client.getQueryData(options.queryKey)).toBeUndefined(); expect(f.ensure).not.toHaveBeenCalled();
    f.close(); client.clear();
  });
});
