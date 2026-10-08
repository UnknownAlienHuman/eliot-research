import { describe, expect, it } from "vitest";
import { canonicalDigest } from "@eliotr/platform-cloudflare";
import { CloudflareArtifactCowAdapter } from "./artifact-cow.js";
import { artifactCowFixture } from "./artifact-cow-fixture.js";

const artifactRef = { id: "artifact-one", revision: 1 };

async function sha256(bytes: Uint8Array): Promise<string> {
  const owned = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(owned).set(bytes);
  const digest = await crypto.subtle.digest("SHA-256", owned);
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, "0")).join("");
}
describe("CloudflareArtifactCowAdapter", () => {
  it("refuses stale or missing parents before invoking a producer or writing", async () => {
    const stale = await artifactCowFixture();
    const staleAdapter = new CloudflareArtifactCowAdapter(stale.ports);
    await expect(staleAdapter.reviseSection(artifactRef, "introduction", 2)).rejects.toMatchObject({ code: "ARTIFACT_COW_HEAD_STALE" });

    const missing = await artifactCowFixture();
    const missingAdapter = new CloudflareArtifactCowAdapter({
      ...missing.ports,
      readExactParent: async () => null,
    });
    await expect(missingAdapter.reviseSection(artifactRef, "introduction", 1)).rejects.toMatchObject({ code: "ARTIFACT_COW_PARENT_MISSING" });
    await expect(new CloudflareArtifactCowAdapter(missing.ports).reviseSection(artifactRef, "absent", 1))
      .rejects.toMatchObject({ code: "ARTIFACT_COW_SECTION_MISSING" });
  });

  it("does not reuse an untouched section when its citations or freeze dependency no longer validate", async () => {
    const { ports } = await artifactCowFixture();
    let compileCalls = 0;
    let prepareCalls = 0;
    const adapter = new CloudflareArtifactCowAdapter({
      ...ports,
      validateParentSection: async ({ section }) => {
        if (section.section.contract_id === "findings") throw new Error("frozen citation support was purged");
      },
      compileSection: async (input) => {
        compileCalls += 1;
        return ports.compileSection(input);
      },
      prepare: async (input) => {
        prepareCalls += 1;
        return ports.prepare(input);
      },
    });
    await expect(adapter.reviseSection(artifactRef, "introduction", 1)).rejects.toThrow("frozen citation support was purged");
    expect(compileCalls).toBe(0);
    expect(prepareCalls).toBe(0);
  });

  it("rejects malformed artifact refs before calling the exact-parent reader", async () => {
    const { ports } = await artifactCowFixture();
    let readCalls = 0;
    const adapter = new CloudflareArtifactCowAdapter({
      ...ports,
      readExactParent: async (ref) => {
        readCalls += 1;
        return ports.readExactParent(ref);
      },
    });
    await expect(adapter.reviseSection({ id: "", revision: 1 }, "introduction", 1))
      .rejects.toMatchObject({ code: "ARTIFACT_COW_INPUT_INVALID" });
    expect(readCalls).toBe(0);
  });

  it("revises one section, preserves old bytes, carries lineage, and assembles a hashed next manifest", async () => {
    const { parent, ports, prepared } = await artifactCowFixture();
    const adapter = new CloudflareArtifactCowAdapter(ports);
    const result = await adapter.reviseSection(artifactRef, "introduction", 1);
    expect(prepared).toHaveLength(1);
    expect(prepared[0]?.expected_draft_head_revision).toBe(1);
    expect(prepared[0]?.sections[0]?.bytes).not.toEqual(parent.sections[0]?.bytes);
    expect(prepared[0]?.sections[1]?.bytes).toEqual(parent.sections[1]?.bytes);
    expect(prepared[0]?.sections[1]?.section.body_object_ref).toBe("body-findings-v1");
    expect(await sha256(prepared[0]?.sections[1]?.bytes ?? new Uint8Array())).toBe(parent.sections[1]?.section.body_sha256);
    expect(prepared[0]?.manifest_residency.content_digest.digest).toBe(await canonicalDigest({ spec: parent.spec, revision: result }));
    expect(result.artifact_ref).toEqual({ id: "artifact-one", revision: 2 });
    expect(result.status).toBe("DRAFT");
    expect(result.sections[0]?.body_object_ref).toBe("body-intro-v2");
    expect(result.sections[1]?.body_object_ref).toBe("body-findings-v1");
    expect(result.sections[1]?.reused_from_revision_ref).toEqual(artifactRef);
    expect(result.dependency_manifest_ref).toBe("dependencies-v2");
    expect(parent.sections[0]?.bytes).toEqual(new TextEncoder().encode("Original introduction."));
    expect(parent.revision.sections[0]?.body_sha256).toBe(await sha256(parent.sections[0]?.bytes ?? new Uint8Array()));
    expect(result.sections[0]?.body_sha256).toBe(await sha256(new TextEncoder().encode("Updated introduction, checked against the current evidence freeze.")));
  });

  it("lets exactly one concurrent revision win the existing expected-head CAS", async () => {
    const { ports } = await artifactCowFixture();
    const adapter = new CloudflareArtifactCowAdapter(ports);
    const results = await Promise.allSettled([
      adapter.reviseSection(artifactRef, "introduction", 1),
      adapter.reviseSection(artifactRef, "introduction", 1),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
  });
});
