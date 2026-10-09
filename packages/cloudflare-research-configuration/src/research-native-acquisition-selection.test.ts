import { canonicalJson } from "@eliotr/platform-cloudflare";
import { WorkflowCheckpointError } from "@eliotr/cloudflare-workflows";
import { describe, expect, it } from "vitest";
import {
  parseResearchNativeAcquisitionSelection,
  parseResearchNativeAcquisitionSelectionJson,
  RESEARCH_NATIVE_ACQUISITION_SELECTION_PROTOCOL,
} from "./research-native-acquisition-selection.js";

describe("research native acquisition selection", () => {
  it("keeps an explicit corpus-only selection free of a provider profile", () => {
    const selection = parseResearchNativeAcquisitionSelection({
      protocol: RESEARCH_NATIVE_ACQUISITION_SELECTION_PROTOCOL,
      source_mode: "corpus_only",
      profile: null,
    });

    expect(selection).toEqual({
      protocol: RESEARCH_NATIVE_ACQUISITION_SELECTION_PROTOCOL,
      source_mode: "corpus_only",
      profile: null,
    });
    expect(Object.isFrozen(selection)).toBe(true);
  });

  it("parses and freezes the exact owner-selected web profile", () => {
    const selectionJson = canonicalJson({
      protocol: RESEARCH_NATIVE_ACQUISITION_SELECTION_PROTOCOL,
      source_mode: "web_discovery",
      profile: {
        result_limit: 3,
        search: {
          gateway_id: "owner-selected-gateway",
          provider: "exa",
          byok_alias: "owner_key_alias",
          timeout_ms: 12_000,
        },
        browser_markdown: {
          timeout_ms: 20_000,
          max_markdown_bytes: 128_000,
          redirect_policy: "exact_url_only",
        },
      },
    });
    const selection = parseResearchNativeAcquisitionSelectionJson(selectionJson);

    expect(selection.source_mode).toBe("web_discovery");
    expect(selection.profile).toMatchObject({
      result_limit: 3,
      search: { gateway_id: "owner-selected-gateway", provider: "exa", byok_alias: "owner_key_alias" },
      browser_markdown: { redirect_policy: "exact_url_only" },
    });
    expect(Object.isFrozen(selection.profile)).toBe(true);
    if (selection.source_mode === "web_discovery") {
      expect(Object.isFrozen(selection.profile.search)).toBe(true);
      expect(Object.isFrozen(selection.profile.browser_markdown)).toBe(true);
    }
  });

  it("fails closed on incomplete, unknown, or non-canonical selections", () => {
    expect(() => parseResearchNativeAcquisitionSelection({
      protocol: RESEARCH_NATIVE_ACQUISITION_SELECTION_PROTOCOL,
      source_mode: "web_discovery",
      profile: {
        result_limit: 3,
        search: { provider: "exa", timeout_ms: 1000 },
        browser_markdown: { timeout_ms: 1000, max_markdown_bytes: 1000, redirect_policy: "exact_url_only" },
      },
    })).toThrow(WorkflowCheckpointError);

    expect(() => parseResearchNativeAcquisitionSelection({
      protocol: RESEARCH_NATIVE_ACQUISITION_SELECTION_PROTOCOL,
      source_mode: "web_discovery",
      profile: {
        result_limit: 3,
        search: { gateway_id: "owner-gateway", provider: "unselected", timeout_ms: 1000 },
        browser_markdown: { timeout_ms: 1000, max_markdown_bytes: 1000, redirect_policy: "exact_url_only" },
      },
    })).toThrow(WorkflowCheckpointError);

    expect(() => parseResearchNativeAcquisitionSelectionJson(
      '{"protocol":"eliotr.research-native-acquisition-selection.v1", "source_mode":"corpus_only", "profile":null}',
    )).toThrow(WorkflowCheckpointError);
  });
});
