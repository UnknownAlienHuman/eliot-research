import { describe, expect, it } from "vitest";
import { createAiSearchScopeFilter, type AiSearchAuthorizedProjectCopy } from "./ai-search-scope-filter.js";

const generation = "a".repeat(64);

function copy(
  source_revision_ref: string,
  project_id: string,
  membership_generation: number,
  folder_prefix: string,
): AiSearchAuthorizedProjectCopy {
  return {
    source_revision_ref,
    source_owner_generation: "owner-generation-1",
    project_id,
    project_membership_id: `project:${project_id}:generation:${membership_generation}`,
    membership_generation,
    folder_prefix,
  };
}

describe("AI Search pre-retrieval project-copy filters", () => {
  it("ANDs frozen source and generation fences with exact folder representatives", () => {
    const filter = createAiSearchScopeFilter(
      ["revision-a", "revision-b"],
      generation,
      [
        copy("revision-a", "project-a", 7, "projection/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA/"),
        copy("revision-b", "project-b", 4, "projection/BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB/"),
      ],
    );

    expect(filter).toEqual({
      source_revision_ref: { $in: ["revision-a", "revision-b"] },
      projection_generation: generation,
      folder: { $in: [
        "projection/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA/",
        "projection/BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB/",
      ] },
    });
    expect(new TextEncoder().encode(JSON.stringify(filter)).byteLength).toBeLessThan(2048);
  });

  it("rejects silent omissions, duplicate source representatives, and invalid membership identity", () => {
    expect(() => createAiSearchScopeFilter(["revision-a"], generation, [])).toThrow(/exactly one/u);
    expect(() => createAiSearchScopeFilter(
      ["revision-a"],
      generation,
      [
        copy("revision-a", "project-a", 7, "projection/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA/"),
        copy("revision-a", "project-b", 4, "projection/BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB/"),
      ],
    )).toThrow(/multiple copies/u);
    expect(() => createAiSearchScopeFilter(
      ["revision-a"],
      generation,
      [{
        ...copy("revision-a", "project-a", 7, "projection/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA/"),
        project_membership_id: "project:project-a:generation:8",
      }],
    )).toThrow(/Core identity/u);
  });

  it("rejects a complete filter that exceeds the provider byte budget before dispatch", () => {
    const refs = Array.from({ length: 20 }, (_, index) => `revision-${index.toString().padStart(2, "0")}-${"r".repeat(48)}`);
    const copies = refs.map((ref, index) => copy(
      ref,
      `project-${index.toString().padStart(2, "0")}`,
      index + 1,
      `projection/${String.fromCharCode(65 + index).repeat(43)}/`,
    ));
    expect(() => createAiSearchScopeFilter(refs, generation, copies)).toThrow(/2048 bytes/u);
  });
});
