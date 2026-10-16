import { describe, expect, it } from "vitest";
import { scopeIncludesProject } from "./research-history-project.js";
describe("recent research project scope", () => {
  it("keeps a different project's runs out even when sources may overlap", () => {
    expect(scopeIncludesProject({ kind: "PROJECT", project_id: "project-a" }, "project-b")).toBe(false);
    expect(scopeIncludesProject({ kind: "PROJECT", project_id: "project-a" }, "project-a")).toBe(true);
  });
  it("retains explicit source selections within the selected project", () => {
    expect(scopeIncludesProject({ kind: "INTERSECT", left: { kind: "PROJECT", project_id: "project-a" },
      right: { kind: "SELECTED_SOURCES", source_ids: ["source-1"] } }, "project-a")).toBe(true);
  });
  it("does not label a global search excluding a project as research in that project", () => {
    expect(scopeIncludesProject({ kind: "EXCEPT", left: { kind: "GLOBAL_LIBRARY" },
      right: { kind: "PROJECT", project_id: "project-a" } }, "project-a")).toBe(false);
    expect(scopeIncludesProject({ kind: "PROJECT", project_id: "project-a", forged: true }, "project-a")).toBe(false);
  });
});
