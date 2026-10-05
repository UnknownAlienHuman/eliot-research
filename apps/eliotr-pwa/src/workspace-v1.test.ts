import { describe, expect, it } from "vitest";
import { renderLibraryReadiness } from "@eliotr/pwa-source-workspace";
import type { LibraryReadinessView } from "./library-readiness-api.js";
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
    expect(markup).toContain("data-research-tools-home");
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
  it("keeps the full title and freshness on the card while moving raw identifiers into source details", () => {
    const revision = "raw-revision-a1f2c0e13e32ee9d68bd538fdfdc02af85e411450587267f";
    const sourceId = "source-readme";
    const markup = renderLibrary({
      projects: [{ id: "project-orbita", title: "Орбита", generation: "generation-1" }],
      sources: [{
        id: sourceId,
        title: "README <draft>",
        readiness_ref: `readiness:${sourceId}:${revision}`,
      }, {
        id: "source-release-note",
        title: "Release note",
        readiness_ref: "readiness:source-release-note:release-2026-10-04",
      }],
      generation: "generation-1",
      trace: "trace-1",
    });

    const cardStart = markup.indexOf('<article class="source-card library-source-card">');
    const cardEnd = markup.indexOf("</article>", cardStart) + "</article>".length;
    const card = markup.slice(cardStart, cardEnd);
    const detailsStart = card.indexOf('<details class="library-source-details">');
    const visibleCard = card.slice(0, detailsStart);
    const sourceDetails = card.slice(detailsStart);
    expect(visibleCard).toContain('aria-label="Read README &lt;draft&gt;"');
    expect(visibleCard).toContain("README &lt;draft&gt;");
    expect(visibleCard).toContain("Freshness not checked");
    expect(visibleCard).not.toContain("Current version");
    expect(visibleCard).not.toContain("a1f2c0e13e32");
    expect(sourceDetails).toContain("Source details and versions");
    expect(sourceDetails).toContain(`<code>${sourceId}</code>`);
    expect(sourceDetails).toContain(`<code>${revision}</code>`);
    expect(sourceDetails).toContain("Versions and recorded states");
  });
});

describe("library readiness presentation", () => {
  it("keeps quality, currentness and all channel states visible with one escaped details disclosure", () => {
    const timestamp = "2026-10-05T12:00:00.000Z";
    const readiness: LibraryReadinessView = {
      protocol: "eliotr.library-readiness.v1",
      source_id: "source-readme",
      source_revision_ref: "revision-7",
      deployment_generation: "deployment-3",
      catalog_generation: "12",
      observed_at: timestamp,
      currentness: {
        verification: "VERIFIED",
        value: {
          source_revision_ref: "revision-7",
          owner_system_id: "owner-1",
          source_owner_generation: "owner-generation-4",
          source_view_ref: "view-2",
          workspace_view_revision_ref: "workspace-view-6",
          observation_freshness: "gap_detected",
          observed_at: timestamp,
          expires_at: "2026-10-06T12:00:00.000Z",
          gap_refs: ["gap-1"],
        },
      },
      quality_state: "degraded",
      readiness_basis: "ACTIVE_VERIFIED",
      channels: [
        { source_revision_ref: "revision-7", channel: "exact_ready", state: "ready", generation: "exact-generation-2", reason_codes: [], receipt_ref: "exact-receipt-4", observed_at: timestamp },
        { source_revision_ref: "revision-7", channel: "lexical_ready", state: "degraded", reason_codes: ["POLICY_DENIED", "<untrusted&reason>"], observed_at: timestamp },
        { source_revision_ref: "revision-7", channel: "semantic_ready", state: "stale", reason_codes: ["SEMANTIC_GENERATION_STALE"], observed_at: timestamp },
      ],
    };
    const markup = renderLibraryReadiness(readiness);

    expect(markup).toContain('<p class="readiness-quality"><span>Quality</span><strong>Degraded</strong></p>');
    expect(markup).toContain('<p class="readiness-currentness"><span>Currentness</span><strong>Saved source observation · a history gap was detected</strong></p>');
    expect(markup).toContain('data-readiness-channel="exact_ready" data-readiness-state="ready"><span class="readiness-channel-label">Exact search</span><strong class="readiness-channel-state">Ready</strong>');
    expect(markup).toContain('data-readiness-channel="lexical_ready" data-readiness-state="degraded"><span class="readiness-channel-label">Lexical search</span><strong class="readiness-channel-state">Degraded</strong>');
    expect(markup).toContain('data-readiness-channel="semantic_ready" data-readiness-state="stale"><span class="readiness-channel-label">Semantic search</span><strong class="readiness-channel-state">Stale</strong>');
    expect(markup.match(/<details\b/gu)).toHaveLength(1);
    expect(markup).toContain("<summary>Readiness details</summary>");
    expect(markup).toContain("POLICY_DENIED");
    expect(markup).toContain("&lt;untrusted&amp;reason&gt;");
    expect(markup).toContain("exact-generation-2");
    expect(markup).toContain("exact-receipt-4");
    expect(markup).toContain("Currentness freshness</dt><dd>gap_detected");
    expect(markup).not.toContain("<summary>Details</summary>");
  });
});
