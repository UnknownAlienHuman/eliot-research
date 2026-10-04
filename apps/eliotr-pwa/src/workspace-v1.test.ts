import { describe, expect, it } from "vitest";
import { renderLibrary } from "./library-panel.js";
import { renderWorkspaceShell } from "./workspace-shell.js";

describe("three-panel workspace shell", () => {
  it("keeps Sources left, the run mount in Research, and a contextual inspector on the right", () => {
    const markup = renderWorkspaceShell({
      healthBadge: "CONNECTED",
      healthSummary: "Private workspace connected.",
      healthDetails: "Connection details",
      workspaceConnection: "Workspace connection details",
    });

    expect(markup).toContain('class="panel panel--sources"');
    expect(markup).toContain('id="library-sidebar-home"');
    expect(markup).toContain('id="workspace-content"');
    expect(markup).toContain('class="panel panel--inspector"');
    expect(markup).toContain("Select a citation to inspect its evidence and source revision.");
    const centerStart = markup.indexOf('<section id="workspace-content"');
    const inspectorStart = markup.indexOf('<aside class="panel panel--inspector"');
    expect(centerStart).toBeGreaterThanOrEqual(0);
    expect(inspectorStart).toBeGreaterThan(centerStart);
    expect(markup.slice(centerStart, inspectorStart)).toContain('id="research-run"');
    expect(markup.slice(inspectorStart)).toContain("data-inspector-report");
    expect(markup.slice(inspectorStart)).not.toContain("data-run-result");
    expect(markup).not.toContain("artifact-column-content");
    expect(markup.match(/id="library"/gu)).toHaveLength(1);
    expect(markup).toContain('dialog class="panel panel--evidence"');
  });
});

describe("source cards", () => {
  it("shows the admitted title and a compact observed revision without claiming freshness", () => {
    const revision = "raw-revision-a1f2c0e13e32ee9d68bd538fdfdc02af85e411450587267f";
    const markup = renderLibrary({
      projects: [{ id: "project-orbita", title: "Орбита", generation: "generation-1" }],
      sources: [{
        id: "source-readme",
        title: "README <draft>",
        readiness_ref: `readiness:source-readme:${revision}`,
      }, {
        id: "source-release-note",
        title: "Release note",
        readiness_ref: "readiness:source-release-note:release-2026-10-04",
      }],
      generation: "generation-1",
      trace: "trace-1",
    });

    expect(markup).toContain("README &lt;draft&gt;");
    expect(markup).toContain("Current version");
    expect(markup).toContain("a1f2c0e13e32…");
    expect(markup).toContain("…e-2026-10-04");
    expect(markup).toContain("Freshness not checked");
    expect(markup).toContain(`<code>${revision}</code>`);
    expect(markup).toContain("Source details and versions");
  });
});
