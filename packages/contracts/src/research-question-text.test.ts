import { describe, expect, it } from "vitest";
import { isResearchQuestionText } from "./research.js";
import { validateUnicodeText } from "./unicode-text.js";

const cases: ReadonlyArray<readonly [string, unknown, boolean]> = [
  ["undefined", undefined, false],
  ["null", null, false],
  ["number", 7, false],
  ["object", { text: "x" }, false],
  ["empty", "", false],
  ["lone high surrogate", "\ud800", false],
  ["lone low surrogate", "\udfff", false],
  ["astral scalar", "A\u{1f600}Z", true],
  ["BOM", "\ufeffBOM", true],
  ["LF", "a\nb", true],
  ["CRLF", "a\r\nb", true],
  ["isolated CR", "a\rb", false],
  ["horizontal tab", "a\tb", true],
  ["NUL control", "a\u0000b", false],
  ["U+001F control", "a\u001fb", false],
  ["DEL control", "a\u007fb", false],
  ["combining sequence", "e\u0301", true],
  ["large UTF-16 input", "x".repeat(32768), true],
];

describe("isResearchQuestionText", () => {
  it.each(cases)("preserves the pre-refactor result for %s", (name, input, accepted) => {
    expect(isResearchQuestionText(input)).toBe(accepted);

    if (typeof input !== "string") return;

    const checked = validateUnicodeText(input, {
      unit: "utf16-code-units",
      maximum: input.length,
    });
    expect(checked.text).toBe(input);
    expect(checked.reason).not.toBe("too-long");
    expect(checked.valid).toBe(name !== "lone high surrogate" && name !== "lone low surrogate");
  });
});
