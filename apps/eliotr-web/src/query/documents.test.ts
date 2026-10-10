import { describe, expect, it, vi } from "vitest";
import type { AdmittedDocument, LibraryPage, SourceRevisionPage } from "@eliotr/owner-api-client";
import { createPrivacyController } from "../app/privacy";
import { createWorkspaceQueryClient } from "./client";
import { documentQueryOptions } from "./documents";

const library: LibraryPage = { projects: [], sources: [{ id: "source", title: "Source", readiness_ref: "readiness:source:head" }], generation: "deployment", trace: "trace" };
const revisions: SourceRevisionPage = {
  source_id: "source", head_revision_ref: "revision", observed_at: "2026-10-09T00:00:00.000Z", readiness_basis: "RECORDED_ONLY",
  generation: "deployment", trace: "trace",
  revisions: [{ source_revision_ref: "revision", content_sha256: "a".repeat(64), captured_at: "2026-10-09T00:00:00.000Z", admitted_at: "2026-10-09T00:00:00.000Z", quality_state: "standard", currentness_state: "unknown", readiness: [] }],
};
const document: AdmittedDocument = { sourceRevisionRef: "revision", deploymentGeneration: "deployment", contentSha256: "a".repeat(64), text: "Verified text", bytes: new TextEncoder().encode("Verified text"), sizeBytes: 13 };
async function fixture() {
  const privacy = createPrivacyController({
    now: () => Date.parse("2026-10-09T00:00:00.000Z"), timers: { setTimeout: () => 0, clearTimeout() {} },
    mask() {}, reveal() {}, cancelReads() {}, clearProtected() {},
    async verify() { return { principal: "owner", credentialGeneration: "credentials", deploymentGeneration: "deployment", expiresAt: "2027-01-01T00:00:00.000Z" }; },
  });
  await privacy.refresh();
  const snapshot = privacy.getSnapshot();
  if (snapshot.phase !== "available") throw new Error("Unavailable fixture");
  const current = { library, revisions };
  const read = vi.fn(async (): Promise<AdmittedDocument> => document);
  const client = createWorkspaceQueryClient();
  return { current, read, client, options: (ref = "revision", sourceId = "source") => documentQueryOptions(
    { readAdmittedDocument: read }, privacy, snapshot.context, { library: () => current.library, revisions: () => current.revisions }, library, revisions, sourceId, ref,
  ) };
}

describe("document Query admission", () => {
  it("reads only the explicitly selected current revision", async () => {
    const test = await fixture();
    expect(await test.client.fetchQuery(test.options())).toBe(document);
    expect(test.read).toHaveBeenCalledWith("revision", "deployment", expect.any(AbortSignal));
    test.client.clear();
  });
  it("refuses a readiness reference as a document revision before any read", async () => {
    const test = await fixture();
    await expect(test.client.fetchQuery(test.options("readiness:source:head"))).rejects.toThrow("Document revision");
    expect(test.read).not.toHaveBeenCalled(); test.client.clear();
  });
  it("refuses a foreign source and a replaced same-generation revision page", async () => {
    const test = await fixture();
    await expect(test.client.fetchQuery(test.options("revision", "foreign"))).rejects.toThrow("Document selection");
    test.current.revisions = { ...revisions };
    await expect(test.client.fetchQuery(test.options())).rejects.toThrow("Document selection");
    expect(test.read).not.toHaveBeenCalled(); test.client.clear();
  });
  it("rejects bytes if the current library changes while the reader is awaiting", async () => {
    const test = await fixture();
    test.read.mockImplementationOnce(async () => { test.current.library = { ...library, sources: [] }; return document; });
    await expect(test.client.fetchQuery(test.options())).rejects.toThrow("Document selection");
    expect(test.client.getQueryData(test.options().queryKey)).toBeUndefined(); test.client.clear();
  });
  it("refuses a digest that differs from the explicitly selected revision", async () => {
    const test = await fixture();
    test.read.mockResolvedValueOnce({ ...document, contentSha256: "b".repeat(64) });
    await expect(test.client.fetchQuery(test.options())).rejects.toThrow("Document bytes");
    expect(test.client.getQueryData(test.options().queryKey)).toBeUndefined(); test.client.clear();
  });
});
