import { EXACT_VERIFICATION_BOUNDS, MAX_CANONICAL_BYTES } from "@eliotr/retrieval";
import { evidenceSha256Bytes, evidenceUtf8Bytes } from "./canonical.js";

export const SOURCE_QUOTE_BOUNDS = {
  max_source_bytes: MAX_CANONICAL_BYTES,
  max_quote_bytes: EXACT_VERIFICATION_BOUNDS.max_excerpt_bytes,
} as const;

export interface SourceQuoteByteRange {
  readonly start: number;
  readonly end: number;
}

export type SourceQuoteResult = {
  readonly status: "MATCHED";
  /** Absolute UTF-8 byte offsets in source_bytes; end is exclusive. */
  readonly range: SourceQuoteByteRange;
  readonly exact_bytes: Uint8Array;
  readonly exact_text: string;
  readonly sha256: string;
} | { readonly status: "NOT_FOUND" | "AMBIGUOUS" | "INVALID_TEXT" };

// Unicode White_Space includes NBSP and line separators, but not BOM/zero-width format characters.
const WHITESPACE = /\p{White_Space}/u;
const WHITESPACE_ONLY = /^\p{White_Space}*$/u;
const collapseWhitespace = (text: string) => text.replace(/\p{White_Space}+/gu, " ");

function normalizedByteMap(text: string, base: number) {
  const normalized = collapseWhitespace(text);
  // Each normalized UTF-16 unit maps to its complete original UTF-8 code point/run.
  // A surrogate pair shares one byte span; a collapsed space covers the whole whitespace run.
  const starts = new Uint32Array(normalized.length);
  const ends = new Uint32Array(normalized.length);
  let byteOffset = base;
  let normalizedOffset = 0;
  let wasWhitespace = false;
  for (const character of text) {
    const code = character.codePointAt(0) ?? 0;
    const byteLength = code <= 0x7f ? 1 : code <= 0x7ff ? 2 : code <= 0xffff ? 3 : 4;
    const whitespace = WHITESPACE.test(character);
    if (whitespace && wasWhitespace) {
      ends[normalizedOffset - 1] = byteOffset + byteLength;
    } else {
      for (let unit = 0; unit < character.length; unit += 1) {
        starts[normalizedOffset] = byteOffset;
        ends[normalizedOffset] = byteOffset + byteLength;
        normalizedOffset += 1;
      }
    }
    byteOffset += byteLength;
    wasWhitespace = whitespace;
  }
  return { normalized, starts, ends };
}

/** Reusable input for matchSourceQuote: caller-admitted bytes plus a model quote. */
export interface MatchSourceQuoteInput {
  readonly source_bytes: Uint8Array;
  readonly quote: string;
  readonly allowed_byte_window?: SourceQuoteByteRange;
}

/**
 * Locate a model quote in caller-admitted normalized UTF-8 bytes. This proves byte correspondence
 * only: it performs no I/O, source admission, authorization, handle issuance or semantic verification.
 * Only nonempty Unicode whitespace runs are interchangeable; no trimming or other rewriting occurs.
 * A trusted optional window is searched as a slice, with offsets returned relative to the full source.
 * Invalid UTF-8, bounds, or an original matched excerpt over the existing excerpt limit are INVALID_TEXT.
 */
export async function matchSourceQuote(input: MatchSourceQuoteInput): Promise<SourceQuoteResult> {
  if (!(input.source_bytes instanceof Uint8Array) || typeof input.quote !== "string" ||
      input.source_bytes.byteLength === 0 || input.source_bytes.byteLength > SOURCE_QUOTE_BOUNDS.max_source_bytes ||
      input.quote.length === 0 || input.quote.length > SOURCE_QUOTE_BOUNDS.max_quote_bytes) {
    return { status: "INVALID_TEXT" };
  }
  const quoteBytes = evidenceUtf8Bytes(input.quote);
  if (quoteBytes.byteLength > SOURCE_QUOTE_BOUNDS.max_quote_bytes) return { status: "INVALID_TEXT" };
  const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
  // Same round-trip guard as narrowNativeSemExcerpt: TextEncoder must not repair lone surrogates.
  const bytes = new Uint8Array(input.source_bytes);
  const start = input.allowed_byte_window?.start ?? 0;
  const end = input.allowed_byte_window?.end ?? bytes.byteLength;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) ||
      start < 0 || end <= start || end > bytes.byteLength) return { status: "INVALID_TEXT" };
  let text: string;
  try {
    const source = decoder.decode(bytes);
    if (decoder.decode(quoteBytes) !== input.quote || WHITESPACE_ONLY.test(input.quote) ||
        WHITESPACE_ONLY.test(source)) return { status: "INVALID_TEXT" };
    // Fatal decoding also rejects window boundaries that cut a UTF-8 code point.
    text = start === 0 && end === bytes.byteLength ? source : decoder.decode(bytes.subarray(start, end));
  } catch {
    return { status: "INVALID_TEXT" };
  }
  const { normalized, starts, ends } = normalizedByteMap(text, start);
  const quote = collapseWhitespace(input.quote);
  const found = normalized.indexOf(quote);
  if (found < 0) return { status: "NOT_FOUND" };
  // Check overlapping matches too, and never prefer an exact-spelling occurrence over another match.
  if (normalized.indexOf(quote, found + 1) !== -1) return { status: "AMBIGUOUS" };
  const originalStart = starts[found];
  const originalEnd = ends[found + quote.length - 1];
  if (originalStart === undefined || originalEnd === undefined ||
      originalEnd - originalStart > SOURCE_QUOTE_BOUNDS.max_quote_bytes) return { status: "INVALID_TEXT" };
  const exactBytes = bytes.slice(originalStart, originalEnd);
  const exactText = decoder.decode(exactBytes);
  const sha256 = await evidenceSha256Bytes(exactBytes);
  return { status: "MATCHED", range: { start: originalStart, end: originalEnd },
    exact_bytes: exactBytes, exact_text: exactText, sha256 };
}
