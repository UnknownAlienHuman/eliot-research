import { describe, expect, it } from "vitest";
import { getSafeReadingMarkdownHref, isWithinReadingMarkdownLimit } from "./reading-markdown.js";

describe("reading Markdown safety boundaries", () => {
  it("keeps only absolute HTTP, HTTPS, and mailto destinations", () => {
    expect(getSafeReadingMarkdownHref("https://example.com/a?b=1")).toBe("https://example.com/a?b=1");
    expect(getSafeReadingMarkdownHref("http://example.com")).toBe("http://example.com/");
    expect(getSafeReadingMarkdownHref("mailto:reader@example.com")).toBe("mailto:reader@example.com");
    for (const href of ["/relative", "#section", "//example.com", "javascript:alert(1)", "data:text/html,x", "file:///tmp/a", "blob:https://example.com/id", "https://user:pass@example.com"]) {
      expect(getSafeReadingMarkdownHref(href)).toBeNull();
    }
  });

  it("rejects formatting input beyond the byte budget, including multibyte text", () => {
    expect(isWithinReadingMarkdownLimit("# bounded")).toBe(true);
    expect(isWithinReadingMarkdownLimit("x".repeat(256 * 1024 + 1))).toBe(false);
    expect(isWithinReadingMarkdownLimit("é".repeat(128 * 1024 + 1))).toBe(false);
  });
});
