import { describe, expect, it } from "vitest";
import { createPrivacyController } from "../app/privacy";
import { clearWorkspaceQueries, createWorkspaceQueryClient, protectedQueryKey, ProtectedReadClosedError, runProtectedRead } from "./client";
describe("protected query boundary", () => {
  it("disables automatic retries and evicts query and mutation state without executing them", () => {
    const client = createWorkspaceQueryClient();
    expect(client.getDefaultOptions().queries?.retry).toBe(false); expect(client.getDefaultOptions().mutations?.retry).toBe(false);
    client.setQueryData(["private"], "fixture bytes");
    client.getMutationCache().build(client, { mutationKey: ["private"], mutationFn: async () => { throw new Error("must not execute"); } });
    clearWorkspaceQueries(client); expect(client.getQueryCache().getAll()).toHaveLength(0); expect(client.getMutationCache().getAll()).toHaveLength(0);
  });
  it("rejects a late old-context read, and gives a fresh session a separate key", async () => {
    const privacy = createPrivacyController({
    now: () => Date.parse("2026-10-09T00:00:00.000Z"),
    timers: { setTimeout: () => 0, clearTimeout() {} }, mask() {}, reveal() {}, cancelReads() {}, clearProtected() {}, async verify() { return { principal: "owner", credentialGeneration: "cg", deploymentGeneration: "dg", expiresAt: "2027-01-01T00:00:00.000Z" }; } });
    await privacy.refresh(); const initial = privacy.getSnapshot(); if (initial.phase !== "available") throw new Error("Fixture unavailable");
    let complete!: (value: string) => void; const pending = new Promise<string>(resolve => { complete = resolve; });
    const result = runProtectedRead(privacy, initial.context, new AbortController().signal, async () => pending);
    privacy.close(); await privacy.refresh(); complete("old protected bytes");
    await expect(result).rejects.toBeInstanceOf(ProtectedReadClosedError);
    const next = privacy.getSnapshot(); if (next.phase !== "available") throw new Error("Fixture unavailable");
    expect(protectedQueryKey(initial.context, "report")).not.toEqual(protectedQueryKey(next.context, "report"));
    expect(privacy.isCurrent({ ...next.context })).toBe(false);
  });
});
