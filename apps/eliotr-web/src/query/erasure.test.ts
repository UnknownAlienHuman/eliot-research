import { describe, expect, it, vi } from "vitest";
import type { ErasurePrepareView, LibraryPage } from "@eliotr/owner-api-client";
import { createWorkspaceRuntime } from "../app/runtime";
import { createPrivacyController } from "../app/privacy";
import { createWorkspaceQueryClient, clearWorkspaceQueries } from "./client";
import { erasureActions, isErasureComplete } from "./erasure";

const generation = "deployment-1", stamp = "2026-10-09T12:00:00.000Z";
const ref = { id: "erase-1", revision: 1 };
const page: LibraryPage = { generation, trace: "trace-1", projects: [], sources: [{ id: "source-1", title: "Selected document", readiness_ref: "readiness-1" }] };
const preview = { protocol: "eliotr.owner-erasure-preview.v1", source_id: "source-1", source_title: "Selected document", revision_targets: ["revision-1"],
  request: { protocol: "eliotr.owner-erasure.v1", permission_ref: { id: "permission-1", revision: 1 },
    request: { protocol: "erc.privacy.erasure.v1", erasure_ref: ref, requested_by_principal_ref: "owner-1", exact_subject_refs: ["subject-1"],
      required_locations: ["CanonicalPayload"], legal_basis_ref: "basis-1", admitted_at: stamp, deadline: "2026-11-09T12:00:00.000Z" } } };
const receipt = { protocol: "erc.privacy.erasure.v1", erasure_ref: ref, state: "COMPLETE", requested_locations: ["CanonicalPayload"],
  completed_locations: ["CanonicalPayload"], blocked_locations: [], purge_ledger_entry_ref: "ledger-1", issued_at: stamp };
const saved = { protocol: "eliotr.owner-erasure-status.v1", erasure_ref: ref, state: "COMPLETE", receipt };
const json = (data: unknown) => new Response(JSON.stringify({ data, trace_id: "trace-1", deployment_generation: generation }), { headers: { "content-type": "application/json" } });

async function fixture() {
  const client = createWorkspaceQueryClient(), timers = { setTimeout: () => 0, clearTimeout() {} };
  let reply: (path: string) => Promise<Response> = async path => json(path.endsWith("/prepare") ? preview : path.endsWith("/erasure") ? receipt : saved);
  const fetcher = vi.fn<typeof fetch>(async input => {
    const path = String(input);
    if (path === "/api/v1/system/health") return json({ ready: true, deployment_generation: generation, core_schema_generation: "schema-1", search_schema_generation: "schema-1", blocking_reason_codes: [], checked_at: stamp });
    if (path === "/api/v1/system/session") return json({ protocol: "eliotr.owner-session.v1", principal_ref: "owner-1", credential_generation: "credentials-1", client_class: "owner_pwa", expires_at: "2027-01-01T00:00:00.000Z" });
    return reply(path);
  });
  const mint = vi.fn(() => "11111111-1111-4111-8111-111111111111");
  const runtime = createWorkspaceRuntime({ fetch: fetcher, baseUrl: "https://owner.example", timers, now: () => Date.parse(stamp), mint,
    sha256: async () => "a".repeat(64), isCurrent: context => privacy.isCurrent(context), onAuthorizationLoss() { privacy.close(); } });
  const privacy = createPrivacyController({ now: () => Date.parse(stamp), timers, mask() { runtime.close(); }, reveal() {},
    cancelReads() { void client.cancelQueries(undefined, { revert: false, silent: true }); }, clearProtected() { clearWorkspaceQueries(client); }, verify: signal => runtime.verify(signal) });
  await privacy.refresh();
  const snapshot = privacy.getSnapshot();
  if (snapshot.phase !== "available") throw new Error("Actual bootstrap failed");
  runtime.bind(snapshot.context);
  const apis = runtime.read(snapshot.context);
  if (!apis) throw new Error("Actual binding failed");
  const current: { page: LibraryPage; prepared?: ErasurePrepareView } = { page };
  const actions = erasureActions(apis.sources.erasure, privacy, snapshot.context, { library: () => current.page, prepared: () => current.prepared });
  fetcher.mockClear();
  return { client, runtime, privacy, context: snapshot.context, fetcher, mint, actions, current,
    reply(callback: typeof reply) { reply = callback; }, dispose() { privacy.dispose(); runtime.dispose(); client.clear(); } };
}

describe("explicit erasure actions through actual protected runtime", () => {
  it("reviews a fixed intent without executing, then confirms the exact saved command and reads completion", async () => {
    const test = await fixture(), signal = new AbortController().signal;
    const prepared = await test.actions.prepare(page, "source-1", "intent-1", signal);
    test.current.prepared = prepared;
    expect(test.fetcher).toHaveBeenCalledTimes(1);
    expect(test.fetcher.mock.calls[0]?.[0]).toBe("/api/v1/library/erasure/prepare");
    expect(JSON.parse(String(test.fetcher.mock.calls[0]?.[1]?.body))).toEqual({ source_id: "source-1", idempotency_key: "intent-1" });
    expect(isErasureComplete(prepared, undefined, test.privacy, test.context)).toBe(false);
    expect(await test.actions.confirm(prepared, signal)).toMatchObject({ erasure_ref: ref });
    const dispatch = test.fetcher.mock.calls[1];
    expect(dispatch?.[0]).toBe("/api/v1/library/erasure");
    expect(dispatch?.[1]?.method).toBe("POST");
    expect(new Headers(dispatch?.[1]?.headers).get("x-eliotr-csrf")).toBe("1");
    expect(JSON.parse(String(dispatch?.[1]?.body))).toEqual(prepared.request);
    const status = await test.client.fetchQuery(test.actions.status(prepared));
    expect(isErasureComplete(prepared, status, test.privacy, test.context)).toBe(true);
    expect(test.mint).not.toHaveBeenCalled();
    test.dispose();
  });
  it("rejects a successful preview if its selected source page was replaced in flight", async () => {
    const test = await fixture();
    test.reply(async () => { test.current.page = { ...page, sources: [] }; return json(preview); });
    await expect(test.actions.prepare(page, "source-1", "intent-1", new AbortController().signal)).rejects.toThrow("Deletion source");
    expect(test.current.prepared).toBeUndefined();
    expect(test.fetcher).toHaveBeenCalledTimes(1);
    test.dispose();
  });
  it("dispatches neither confirmation nor status for a replaced or foreign-generation review", async () => {
    const test = await fixture(), signal = new AbortController().signal;
    const prepared = await test.actions.prepare(page, "source-1", "intent-1", signal);
    test.current.prepared = prepared; test.fetcher.mockClear();
    await expect(test.actions.confirm({ ...prepared }, signal)).rejects.toThrow("Deletion review");
    test.current.prepared = { ...prepared, deployment_generation: "old-generation" };
    await expect(test.actions.confirm(test.current.prepared, signal)).rejects.toThrow("Deletion review");
    await expect(test.client.fetchQuery(test.actions.status(prepared))).rejects.toThrow("Deletion review");
    expect(test.fetcher).not.toHaveBeenCalled();
    test.dispose();
  });
  it("keeps blocked and null readback incomplete and discards late successful status after owner invalidation", async () => {
    const test = await fixture();
    const prepared = await test.actions.prepare(page, "source-1", "intent-1", new AbortController().signal);
    test.current.prepared = prepared;
    const blocked = { ...receipt, state: "BLOCKED", completed_locations: [], blocked_locations: [{ location: "CanonicalPayload", policy_or_hold_ref: "hold-1", next_review_at: "2026-11-09T12:00:00.000Z" }] };
    test.reply(async () => json({ ...saved, state: "BLOCKED", receipt: blocked }));
    expect(isErasureComplete(prepared, await test.client.fetchQuery(test.actions.status(prepared)), test.privacy, test.context)).toBe(false);
    expect(isErasureComplete(prepared, null, test.privacy, test.context)).toBe(false);
    const started = Promise.withResolvers<void>(), held = Promise.withResolvers<Response>();
    test.reply(async () => { started.resolve(); return held.promise; });
    const options = test.actions.status(prepared);
    const pending = test.client.fetchQuery(options).then(() => "unexpected-success", () => "discarded");
    await started.promise;
    test.privacy.close(); held.resolve(json(saved));
    expect(await pending).toBe("discarded");
    expect(test.client.getQueryData(options.queryKey)).toBeUndefined();
    test.dispose();
  });
});
