import { describe, expect, it } from "vitest";
import { createResearchBranchRolePromptDependencies } from "../src/research-branch-role-prompt.js";

const MANIFEST_SERVICE = {
  buildAndPersist: async () => {
    throw new Error("not under test");
  },
};

const BUILD_MANIFEST_INPUT = async () => {
  throw new Error("not under test");
};

function input(overrides: Record<string, unknown> = {}) {
  return {
    role: "SUPPORT",
    manifest_service: MANIFEST_SERVICE,
    build_manifest_input: BUILD_MANIFEST_INPUT,
    trusted_parameters: { prompt: "Installed base prompt.", max_tokens: 100 },
    request_timeout_ms: 1000,
    ...overrides,
  } as never;
}

describe("createResearchBranchRolePromptDependencies", () => {
  it("composes the installed role question into the prompt", async () => {
    const deps = createResearchBranchRolePromptDependencies(input());
    const params = await deps.resolve_trusted_parameters({} as never, {} as never);
    expect(params.prompt).toContain("Installed base prompt.");
    expect(params.prompt).toContain("Branch role: SUPPORT");
    expect(params.prompt).toContain("What exact admitted evidence supports the primary question?");
    expect(params.prompt).toContain("eliotr.research.branch-role-output.v1");
    expect(params.max_tokens).toBe(100);
  });

  it("rejects missing trusted parameters", () => {
    expect(() => createResearchBranchRolePromptDependencies(
      input({ trusted_parameters: { prompt: "", max_tokens: 100 } }),
    )).toThrow();
  });

  it("rejects an invalid request timeout", () => {
    expect(() => createResearchBranchRolePromptDependencies(input({ request_timeout_ms: 0 })))
      .toThrow();
  });

  it("rejects a missing manifest service", () => {
    expect(() => createResearchBranchRolePromptDependencies(input({ manifest_service: null })))
      .toThrow();
  });
});
