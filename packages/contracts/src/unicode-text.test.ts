import { describe, expect, it } from "vitest";
import { validateUnicodeText } from "./unicode-text.js";

describe("validateUnicodeText", () => {
  it("counts UTF-16 code units and UTF-8 bytes only in the explicitly selected unit", () => {
    expect(validateUnicodeText("😀", { unit: "utf16-code-units", maximum: 2 }))
      .toEqual({ text: "😀", valid: true, reason: null });
    expect(validateUnicodeText("😀", { unit: "utf16-code-units", maximum: 1 }))
      .toEqual({ text: "😀", valid: false, reason: "too-long" });
    expect(validateUnicodeText("😀", { unit: "utf8-bytes", maximum: 4 }))
      .toEqual({ text: "😀", valid: true, reason: null });
    expect(validateUnicodeText("😀", { unit: "utf8-bytes", maximum: 3 }))
      .toEqual({ text: "😀", valid: false, reason: "too-long" });
    expect(validateUnicodeText("é", { unit: "utf8-bytes", maximum: 2 }))
      .toEqual({ text: "é", valid: true, reason: null });
  });

  it("reports malformed UTF-16 without replacing or otherwise changing the text", () => {
    for (const text of ["\ud800", "\udc00", "\ud800x", "x\udc00", "\ud800\ud800", "\udc00\ud800"]) {
      expect(validateUnicodeText(text, { unit: "utf16-code-units", maximum: 100 }))
        .toEqual({ text, valid: false, reason: "ill-formed-unicode" });
    }
  });

  it("keeps a leading BOM and rejects lone surrogates in the native-method fallback", () => {
    const nativeDescriptor = Object.getOwnPropertyDescriptor(String.prototype, "isWellFormed");
    if (nativeDescriptor !== undefined) {
      Object.defineProperty(String.prototype, "isWellFormed", {
        configurable: true,
        value: undefined,
        writable: true,
      });
    }

    try {
      const text = "\ufeffBOM remains text";
      expect(validateUnicodeText(text, { unit: "utf8-bytes", maximum: 100 }))
        .toEqual({ text, valid: true, reason: null });
      expect(validateUnicodeText("\ud800", { unit: "utf16-code-units", maximum: 100 }))
        .toEqual({ text: "\ud800", valid: false, reason: "ill-formed-unicode" });
    } finally {
      if (nativeDescriptor !== undefined) Object.defineProperty(String.prototype, "isWellFormed", nativeDescriptor);
    }
  });

  it("preserves empty, whitespace, NUL, line endings, combining text, and BMP/astral text", () => {
    for (const text of ["", " \t", "a\u0000b", "line\nfeed", "carriage\r\nreturn", "e\u0301", "é", "😀", "\ufeffBOM"]) {
      expect(validateUnicodeText(text, { unit: "utf8-bytes", maximum: 100 }).text).toBe(text);
      expect(validateUnicodeText(text, { unit: "utf8-bytes", maximum: 100 }).valid).toBe(true);
    }
  });
});
