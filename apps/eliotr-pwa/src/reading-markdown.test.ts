import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { getSafeReadingMarkdownHref, isWithinReadingMarkdownLimit } from "./reading-markdown.js";

// The host browser harness executes this same assertion against the real PWA DOM.
export const READING_MARKDOWN_DOM_FIXTURE = '# Fidelity\n\n<script>window.__readingInjected=true</script>\n\n[unsafe](javascript:alert(1)) ![caption](https://example.invalid/image.png)\n\nUse `READY SHA-256 <img onerror=alert(1)>` literally.\n\n3. Third step\n4. Fourth step\n\n- Bullet\n\n| State | Digest |\n| --- | --- |\n| READY | SHA-256 |';

export function assertReadingMarkdownDOM(container: HTMLElement): void {
  const code = container.querySelector("p code");
  if (!(code instanceof HTMLElement) || code.closest("pre") !== null ||
      code.textContent !== "READY SHA-256 <img onerror=alert(1)>" || code.children.length !== 0) {
    throw new Error("Inline code must render as an exact, inert code element");
  }
  if (getComputedStyle(code).fontFamily === getComputedStyle(container).fontFamily) {
    throw new Error("Inline code must retain its distinct code typography");
  }
  const ordered = container.querySelector("ol");
  if (!(ordered instanceof HTMLOListElement) || ordered.start !== 3 || ordered.getAttribute("start") !== "3" ||
      ordered.children.length !== 2 || ordered.children[0]?.textContent !== "Third step" ||
      ordered.children[1]?.textContent !== "Fourth step") {
    throw new Error("Ordered list must preserve the admitted starting ordinal and items");
  }
  if (container.querySelector("ul")?.hasAttribute("start") !== false || container.querySelector("img,script") !== null) {
    throw new Error("Bullet lists and code text must not acquire unintended markup");
  }
}

describe("actual Markdown worker output", () => {
  const replies: unknown[] = [];
  let receive: (event: { data: unknown }) => void;
  beforeAll(async () => {
    vi.stubGlobal("postMessage", (reply: unknown) => replies.push(reply));
    vi.stubGlobal("onmessage", null);
    await import("./reading-markdown.worker.js");
    receive = (globalThis as unknown as { onmessage: typeof receive }).onmessage;
  });
  afterAll(() => vi.unstubAllGlobals());
  const parse = (text: string): unknown => {
    replies.length = 0;
    receive({ data: { type: "parse-reading-markdown", text } });
    expect(replies).toHaveLength(1);
    return replies[0];
  };
  it("preserves inline code as a typed, literal node", () => {
    expect(parse('Use `READY SHA-256 <img onerror=alert(1)>` literally.')).toEqual({
      type: "reading-markdown-result", ok: true, nodes: [{ type: "paragraph", children: [
        { type: "text", text: "Use " }, { type: "code", text: "READY SHA-256 <img onerror=alert(1)>" },
        { type: "text", text: " literally." },
      ] }],
    });
  });
  it("preserves non-default, zero and default list starts without numbering bullets", () => {
    for (const [text, start, ordered] of [["3. Third step\n4. Fourth step", 3, true], ["0. Zero", 0, true], ["1. First", 1, true], ["- Bullet", null, false]] as const) {
      expect(parse(text)).toMatchObject({ type: "reading-markdown-result", ok: true,
        nodes: [{ type: "list", ordered, start }],
      });
    }
  });
});

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
