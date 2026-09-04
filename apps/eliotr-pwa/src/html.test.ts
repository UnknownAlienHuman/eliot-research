import { describe, expect, it } from "vitest";
import { escapeHtml } from "./html.js";

describe("PWA HTML escaping", () => {
  it("escapes every HTML metacharacter in API-derived text", () => {
    expect(escapeHtml(`<img src=x onerror="alert('x')">&`)).toBe(
      "&lt;img src=x onerror=&quot;alert(&#39;x&#39;)&quot;&gt;&amp;",
    );
  });

  it("preserves ordinary health dimensions", () => {
    expect(escapeHtml("CORE_SCHEMA_GENERATION_MISMATCH")).toBe(
      "CORE_SCHEMA_GENERATION_MISMATCH",
    );
  });
});
