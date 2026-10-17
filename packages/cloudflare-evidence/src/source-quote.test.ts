/// <reference types="node" />
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { evidenceUtf8Bytes } from "./canonical.js";
import { matchSourceQuote, SOURCE_QUOTE_BOUNDS, type SourceQuoteByteRange } from "./source-quote.js";

const bytes = evidenceUtf8Bytes;
const hash = (value: Uint8Array) => createHash("sha256").update(value).digest("hex");
const match = (source: string, quote: string, allowed_byte_window?: SourceQuoteByteRange) => matchSourceQuote({
  source_bytes: bytes(source), quote, ...(allowed_byte_window === undefined ? {} : { allowed_byte_window }),
});

async function expectMatch(source: string, quote: string, exact: string, prefix = "", window?: SourceQuoteByteRange) {
  const result = await match(source, quote, window);
  expect(result.status).toBe("MATCHED");
  if (result.status !== "MATCHED") throw new Error(`expected match, received ${result.status}`);
  const start = bytes(prefix).byteLength;
  const end = start + bytes(exact).byteLength;
  expect(result.range).toEqual({ start, end });
  expect(result.exact_bytes).toEqual(bytes(source).slice(start, end));
  expect(result.exact_text).toBe(exact);
  expect(result.sha256).toBe(hash(bytes(exact)));
  expect(result.sha256).toMatch(/^[a-f0-9]{64}$/u);
  return result;
}

describe("model quote to original normalized source byte range", () => {
  it("returns a known SHA-256 and exclusive original byte range", async () => {
    const result = await expectMatch("head abc tail", "abc", "abc", "head ");
    expect(result.sha256).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });

  it("maps Unicode, astral pairs, combining accents and a preserved BOM to byte offsets", async () => {
    const prefix = "\ufeffНачало 😀 e\u0301\n";
    const original = "Точный фрагмент 🧪\n第二行";
    await expectMatch(`${prefix}${original}\nEnd`, "Точный фрагмент 🧪 第二行", original, prefix);
  });

  it("collapses CRLF, tabs, NBSP, Unicode line separators and NEL without changing returned bytes", async () => {
    const original = "alpha\r\n\tbeta\u00a0\u00a0gamma\u2028delta\u0085end";
    const result = await expectMatch(`before\t${original}\r\nafter`, "alpha beta gamma delta end", original, "before\t");
    expect(result.sha256).not.toBe(hash(bytes("alpha beta gamma delta end")));
  });

  it("anchors a multibyte match ending exactly at the source end", async () => {
    const result = await expectMatch("start \u65e5\u672c\u8a9e", "\u65e5\u672c\u8a9e", "\u65e5\u672c\u8a9e", "start ");
    expect(result.range.end).toBe(bytes("start \u65e5\u672c\u8a9e").byteLength);
  });

  it("treats different whitespace spellings as the same ambiguous occurrence", async () => {
    expect(await match("a b / a\u00a0b", "a b")).toEqual({ status: "AMBIGUOUS" });
  });

  it("also accepts whitespace runs in the quote and retains whole leading/trailing source runs", async () => {
    await expectMatch("alpha beta", "alpha\u00a0\r\nbeta", "alpha beta");
    await expectMatch("x\r\n abc\t\tz", " \tabc\r\n", "\r\n abc\t\t", "x");
  });

  it.each([
    ["Transformer", "transformer"], ["a,b", "a b"], ["A–B", "A-B"],
    ["café", "cafe"], ["café", "cafe\u0301"], ["ﬁ", "fi"],
    ["positional encodings", "position encodings"], ["incom\ng", "incoming"],
    ["a b", "ab"], ["ab", "a b"], ["a\u200bb", "a b"], ["a\ufeffb", "a b"],
  ])("does not rewrite non-whitespace source %j to quote %j", async (source, quote) => {
    expect(await match(source, quote)).toEqual({ status: "NOT_FOUND" });
  });

  it.each([
    ["same middle same", "same"], ["aaa", "aa"],
    ["same phrase / same\r\nphrase", "same phrase"], ["😀😀😀", "😀😀"],
  ])("rejects duplicate or overlapping occurrences in %j", async (source, quote) => {
    expect(await match(source, quote)).toEqual({ status: "AMBIGUOUS" });
  });

  it("uses a trusted window to select a unique occurrence and returns absolute byte offsets", async () => {
    const prefix = "😀 same\tphrase | ";
    const exact = "same\r\nphrase";
    const source = `${prefix}${exact} tail`;
    const start = bytes(prefix).byteLength;
    const end = start + bytes(exact).byteLength;
    expect(await match(source, "same phrase")).toEqual({ status: "AMBIGUOUS" });
    await expectMatch(source, "same phrase", exact, prefix, { start, end });
    expect(await match(source, "same phrase", { start: 0, end: bytes(source).byteLength }))
      .toEqual({ status: "AMBIGUOUS" });
    expect(await match(source, "same phrase", { start, end: end - 1 })).toEqual({ status: "NOT_FOUND" });
  });

  it.each([
    { start: -1, end: 2 }, { start: 0, end: 0 }, { start: 2, end: 1 }, { start: 0, end: 4 },
    { start: 0.5, end: 2 }, { start: 0, end: 2.5 }, { start: NaN, end: 2 },
    { start: 0, end: Infinity }, { start: 0, end: Number.MAX_SAFE_INTEGER + 1 },
  ])("rejects invalid byte window %j", async (window) => {
    expect(await match("abc", "a", window)).toEqual({ status: "INVALID_TEXT" });
  });

  it("rejects either boundary cutting a UTF-8 code point", async () => {
    expect(await match("x🙂y", "x", { start: 0, end: 2 })).toEqual({ status: "INVALID_TEXT" });
    expect(await match("x🙂y", "y", { start: 2, end: 6 })).toEqual({ status: "INVALID_TEXT" });
    await expectMatch("x🙂y", "🙂", "🙂", "x", { start: 1, end: 5 });
  });

  it.each(["", " \r\n\t\u00a0\u2028", "\ud800", "\udc00", "a\ud800b", "\ud83d"]) (
    "rejects empty, whitespace-only or ill-formed model quote %j", async (quote) => {
      expect(await match("source � 😀", quote)).toEqual({ status: "INVALID_TEXT" });
    },
  );

  it("does not confuse a literal replacement character with malformed model UTF-16", async () => {
    await expectMatch("source � tail", "�", "�", "source ");
  });

  it.each([[], [0xff], [0x80], [0xc0, 0xaf], [0xe2, 0x82], [0xed, 0xa0, 0x80], [0xf4, 0x90, 0x80, 0x80]])(
    "rejects malformed or empty source bytes %j", async (...invalid) => {
      expect(await matchSourceQuote({ source_bytes: new Uint8Array(invalid), quote: "a" }))
        .toEqual({ status: "INVALID_TEXT" });
    },
  );

  it("validates all source UTF-8 even when a trusted window excludes corruption", async () => {
    expect(await matchSourceQuote({ source_bytes: new Uint8Array([0x61, 0xff]), quote: "a",
      allowed_byte_window: { start: 0, end: 1 } })).toEqual({ status: "INVALID_TEXT" });
    expect(await match("\r\n\u00a0", "a")).toEqual({ status: "INVALID_TEXT" });
  });

  it("accepts exactly 2 MiB of source and refuses an oversized source", async () => {
    const source = `abc${"x".repeat(SOURCE_QUOTE_BOUNDS.max_source_bytes - 3)}`;
    await expectMatch(source, "abc", "abc");
    expect(await match(`${source}x`, "abc")).toEqual({ status: "INVALID_TEXT" });
  });

  it("enforces the existing excerpt limit in UTF-8 bytes, inclusively", async () => {
    const quote = "é".repeat(SOURCE_QUOTE_BOUNDS.max_quote_bytes / 2);
    await expectMatch(quote, quote, quote);
    expect(await match(`${quote}é`, `${quote}é`)).toEqual({ status: "INVALID_TEXT" });
    expect(await match("a", "a".repeat(SOURCE_QUOTE_BOUNDS.max_quote_bytes + 1)))
      .toEqual({ status: "INVALID_TEXT" });
  });

  it("bounds the original excerpt after whitespace expansion and hashes the original bytes", async () => {
    const exact = `a${" ".repeat(SOURCE_QUOTE_BOUNDS.max_quote_bytes - 2)}b`;
    await expectMatch(exact, "a b", exact);
    expect(await match(`a${" ".repeat(SOURCE_QUOTE_BOUNDS.max_quote_bytes - 1)}b`, "a b"))
      .toEqual({ status: "INVALID_TEXT" });
  });

  it("snapshots caller bytes before asynchronous hashing and returns an independent exact slice", async () => {
    const original = bytes("x a\r\nb y");
    const pending = matchSourceQuote({ source_bytes: original, quote: "a b" });
    original.fill(0x7a);
    const result = await pending;
    expect(result.status).toBe("MATCHED");
    if (result.status !== "MATCHED") throw new Error("expected a byte match");
    expect(result.range).toEqual({ start: 2, end: 6 });
    expect(result.exact_text).toBe("a\r\nb");
    expect(result.exact_bytes).toEqual(bytes("a\r\nb"));
    expect(result.sha256).toBe(hash(bytes("a\r\nb")));
    result.exact_bytes.fill(0);
    expect(original).toEqual(bytes("z".repeat(original.byteLength)));
  });
});
