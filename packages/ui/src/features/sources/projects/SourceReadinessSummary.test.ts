import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import type { LibraryPage } from "@eliotr/owner-api-client";
import { SourceReadinessSummary } from "./SourceReadinessSummary";
type Summary = NonNullable<LibraryPage["sources"][number]["readiness_summary"]>;
function summary(state: Summary["channels"][number]["state"] = "ready"): Summary {
  return { protocol: "eliotr.library-row-readiness.v1", source_revision_ref: "revision", basis: "RECORDED_ONLY",
    scope: "SOURCE_PROJECTION", observed_at: "2026-10-17T12:00:00Z", quality_state: "standard",
    channels: (["exact_ready","lexical_ready","semantic_ready"] as const).map((channel, index) => ({
      source_revision_ref:"revision", channel, state, reason_codes: [], generation:"generation",receipt_ref:"receipt",
      observed_at: index ? "2026-10-16T11:00:00Z" : "2026-10-15T10:00:00Z",
    })) };
}
describe("recorded readiness row presentation", () => {
  it("shows the conservative saved check time rather than the catalog fetch time in both languages", () => {
    for (const locale of ["en", "ru"] as const) {
      const html = renderToStaticMarkup(createElement(SourceReadinessSummary, { locale, summary: summary() }));
      expect(html).toContain(locale === "en" ? "Ready at last check" : "Готов при последней проверке");
      expect(html).toContain('dateTime="2026-10-15T10:00:00.000Z"');
      expect(html).not.toContain("2026-10-17T12:00:00"); expect(html).not.toContain("Projection");
    }
  });
  it("does not promote queued, stale, incomplete, or poor-quality observations to ready", () => {
    const queued = renderToStaticMarkup(createElement(SourceReadinessSummary, { locale: "en", summary: summary("queued") }));
    expect(queued).toContain("Indexing queued"); expect(queued).not.toContain("Ready at last check");
    const stale = renderToStaticMarkup(createElement(SourceReadinessSummary, { locale: "en", summary: summary("stale") }));
    expect(stale).toContain("Needs attention"); expect(stale).toContain('data-state="stale"');
    expect(stale).toContain("out of date");
    for (const value of [{...summary(), channels:summary().channels.slice(0,2)}, {...summary(), channels:[]}, undefined]) {
      expect(renderToStaticMarkup(createElement(SourceReadinessSummary, { locale: "en", summary: value }))).toContain("Readiness unknown");
    }
    expect(renderToStaticMarkup(createElement(SourceReadinessSummary, { locale: "ru", summary: {...summary(),quality_state:"unqualified"} })))
      .toContain("Требует внимания");
  });
});

