import {
  ProjectionItemSchema,
  SourceRevisionSchema,
  type ProjectionItem,
  type SourceRevision,
} from "@eliotr/contracts";

const DEFAULT_TARGET_BYTES = 32 * 1024;
const DEFAULT_MAX_BYTES = 64 * 1024;
const HARD_MAX_BYTES = 256 * 1024;
const MAX_ITEMS = 1024;
const MAX_CONTEXT_BYTES = 4 * 1024;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/u;

export interface ProjectionSpan {
  readonly item_key: string;
  readonly canonical_section_id: string;
  readonly normalized_start_byte: number;
  readonly normalized_end_byte: number;
}

export interface MarkdownProjectionResult {
  readonly items: readonly ProjectionItem[];
  readonly spans: readonly ProjectionSpan[];
  readonly item_set_digest: string;
  readonly markdown_sha256: string;
}

export interface MarkdownProjectionInput {
  readonly source_revision: SourceRevision;
  readonly title: string;
  readonly source_class: string;
  readonly markdown: string;
  readonly instruction_taint: ProjectionItem["instruction_taint"];
  readonly project_membership_ids: readonly string[];
  readonly projection_generation: string;
  readonly target_item_utf8_bytes?: number;
  readonly max_item_utf8_bytes?: number;
}

export type StructuralProjectionErrorCode =
  | "PROJECTION_INPUT_INVALID"
  | "PROJECTION_DOCUMENT_EMPTY"
  | "PROJECTION_ITEM_LIMIT_EXCEEDED"
  | "PROJECTION_ITEM_TOO_LARGE"
  | "PROJECTION_OFFSET_INVALID";

export class StructuralProjectionError extends Error {
  public readonly code: StructuralProjectionErrorCode;

  public constructor(code: StructuralProjectionErrorCode, message: string) {
    super(message);
    this.name = "StructuralProjectionError";
    this.code = code;
  }
}

interface TextPiece {
  readonly text: string;
  readonly start: number;
  readonly end: number;
  readonly heading_path: readonly string[];
}

function fail(code: StructuralProjectionErrorCode, message: string): never {
  throw new StructuralProjectionError(code, message);
}

function utf8Length(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function hex(input: ArrayBuffer): string {
  return [...new Uint8Array(input)]
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("");
}

async function sha256(value: string): Promise<string> {
  return hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
}

function assertIdentifier(value: string, label: string): void {
  if (!IDENTIFIER.test(value)) fail("PROJECTION_INPUT_INVALID", `${label} is invalid`);
}

function boundedInteger(value: number, label: string, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    fail("PROJECTION_INPUT_INVALID", `${label} is outside its allowed range`);
  }
  return value;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) fail("PROJECTION_INPUT_INVALID", "canonical JSON contains a non-finite number");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).filter((key) => record[key] !== undefined).sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
  }
  fail("PROJECTION_INPUT_INVALID", "canonical JSON contains a non-JSON value");
}

function splitLines(markdown: string): readonly { text: string; start: number; end: number }[] {
  const result: { text: string; start: number; end: number }[] = [];
  let textStart = 0;
  let byteStart = 0;
  for (let index = 0; index < markdown.length; index += 1) {
    if (markdown[index] !== "\n") continue;
    const text = markdown.slice(textStart, index + 1);
    const bytes = utf8Length(text);
    result.push({ text, start: byteStart, end: byteStart + bytes });
    textStart = index + 1;
    byteStart += bytes;
  }
  if (textStart < markdown.length) {
    const text = markdown.slice(textStart);
    result.push({ text, start: byteStart, end: byteStart + utf8Length(text) });
  }
  return result;
}

function splitOversizedLine(
  line: { readonly text: string; readonly start: number; readonly end: number },
  maxBytes: number,
  headingPath: readonly string[],
): readonly TextPiece[] {
  if (utf8Length(line.text) <= maxBytes) {
    return [{ text: line.text, start: line.start, end: line.end, heading_path: headingPath }];
  }
  const pieces: TextPiece[] = [];
  let textStart = 0;
  let byteStart = line.start;
  let bytes = 0;
  let index = 0;
  for (const character of line.text) {
    const width = utf8Length(character);
    if (bytes > 0 && bytes + width > maxBytes) {
      const text = line.text.slice(textStart, index);
      pieces.push({ text, start: byteStart, end: byteStart + bytes, heading_path: headingPath });
      textStart = index;
      byteStart += bytes;
      bytes = 0;
    }
    bytes += width;
    index += character.length;
  }
  if (bytes > 0) {
    pieces.push({
      text: line.text.slice(textStart),
      start: byteStart,
      end: byteStart + bytes,
      heading_path: headingPath,
    });
  }
  if (pieces.some((piece) => utf8Length(piece.text) > maxBytes)) {
    fail("PROJECTION_ITEM_TOO_LARGE", "an oversized line could not be split on UTF-8 boundaries");
  }
  return pieces;
}

function heading(line: string): { level: number; title: string } | null {
  const match = /^(#{1,6})[ \t]+([^\r\n]+?)[ \t]*(?:\r?\n)?$/u.exec(line);
  if (match === null) return null;
  const marker = match[1];
  const title = match[2]?.trim();
  if (marker === undefined || title === undefined || title.length === 0) return null;
  return { level: marker.length, title };
}

function pieces(markdown: string, maxBytes: number): readonly TextPiece[] {
  const result: TextPiece[] = [];
  const path: string[] = [];
  for (const line of splitLines(markdown)) {
    const found = heading(line.text);
    if (found !== null) {
      path.length = found.level - 1;
      path[found.level - 1] = found.title;
    }
    result.push(...splitOversizedLine(line, maxBytes, [...path]));
  }
  return result;
}

function chunkPieces(
  input: readonly TextPiece[],
  targetBytes: number,
  maxBytes: number,
): readonly TextPiece[] {
  const chunks: TextPiece[] = [];
  let current: TextPiece | null = null;
  for (const piece of input) {
    if (piece.text.length === 0) continue;
    const pieceBytes = utf8Length(piece.text);
    if (pieceBytes > maxBytes) fail("PROJECTION_ITEM_TOO_LARGE", "projection piece exceeds hard item size");
    const startsHeading = heading(piece.text) !== null;
    const currentBytes = current === null ? 0 : utf8Length(current.text);
    const headingChanged = current !== null &&
      JSON.stringify(current.heading_path) !== JSON.stringify(piece.heading_path);
    const shouldFlush = current !== null && (
      startsHeading ||
      headingChanged ||
      currentBytes + pieceBytes > maxBytes ||
      (currentBytes >= targetBytes && /(?:\r?\n){2}$/u.test(current.text))
    );
    if (shouldFlush && current !== null) {
      chunks.push(current);
      current = null;
    }
    current = current === null
      ? piece
      : {
        text: `${current.text}${piece.text}`,
        start: current.start,
        end: piece.end,
        heading_path: current.heading_path,
      };
  }
  if (current !== null) chunks.push(current);
  return chunks;
}

function contextHeader(title: string, headingPath: readonly string[]): string {
  const candidate = [title.trim(), ...headingPath].filter(Boolean).join(" › ");
  if (utf8Length(candidate) <= MAX_CONTEXT_BYTES) return candidate;
  let result = "";
  for (const character of candidate) {
    if (utf8Length(`${result}${character}`) > MAX_CONTEXT_BYTES) break;
    result += character;
  }
  return result;
}

export async function projectNormalizedMarkdown(
  rawInput: MarkdownProjectionInput,
): Promise<MarkdownProjectionResult> {
  let sourceRevision: SourceRevision;
  try { sourceRevision = SourceRevisionSchema.parse(rawInput.source_revision); }
  catch (cause) { fail("PROJECTION_INPUT_INVALID", `source revision failed strict validation: ${String(cause)}`); }
  assertIdentifier(rawInput.projection_generation, "projection_generation");
  assertIdentifier(rawInput.source_class, "source_class");
  if (typeof rawInput.markdown !== "string" || rawInput.markdown.length === 0) {
    fail("PROJECTION_DOCUMENT_EMPTY", "normalized Markdown is empty");
  }
  const targetBytes = boundedInteger(
    rawInput.target_item_utf8_bytes ?? DEFAULT_TARGET_BYTES,
    "target_item_utf8_bytes",
    1024,
    HARD_MAX_BYTES,
  );
  const maxBytes = boundedInteger(
    rawInput.max_item_utf8_bytes ?? DEFAULT_MAX_BYTES,
    "max_item_utf8_bytes",
    targetBytes,
    HARD_MAX_BYTES,
  );
  const membershipIds = [...new Set(rawInput.project_membership_ids)].sort();
  membershipIds.forEach((value) => assertIdentifier(value, "project membership ID"));
  const chunks = chunkPieces(pieces(rawInput.markdown, maxBytes), targetBytes, maxBytes)
    .filter((chunk) => chunk.text.length > 0);
  if (chunks.length === 0) fail("PROJECTION_DOCUMENT_EMPTY", "normalized Markdown has no projectable text");
  if (chunks.length > MAX_ITEMS) fail("PROJECTION_ITEM_LIMIT_EXCEEDED", "projection exceeds its item-count ceiling");

  const items: ProjectionItem[] = [];
  const spans: ProjectionSpan[] = [];
  for (const chunk of chunks) {
    if (chunk.end <= chunk.start || chunk.end - chunk.start !== utf8Length(chunk.text)) {
      fail("PROJECTION_OFFSET_INVALID", "projection offsets are not an exact UTF-8 range");
    }
    const sectionDigest = await sha256(canonicalJson({
      source_revision_ref: sourceRevision.source_revision_ref,
      start: chunk.start,
      end: chunk.end,
      heading_path: chunk.heading_path,
    }));
    const canonicalSectionId = `section-${sectionDigest.slice(0, 48)}`;
    const itemDigest = await sha256(canonicalJson({
      canonical_section_id: canonicalSectionId,
      projection_generation: rawInput.projection_generation,
    }));
    const itemKey = `projection-${itemDigest.slice(0, 48)}`;
    const item = ProjectionItemSchema.parse({
      item_key: itemKey,
      canonical_section_id: canonicalSectionId,
      source_revision_ref: sourceRevision.source_revision_ref,
      project_membership_ids: membershipIds,
      heading_path: [...chunk.heading_path],
      document_context_header: contextHeader(rawInput.title, chunk.heading_path),
      section_text: chunk.text,
      normalized_offset_map_ref: `normalized-bytes:${chunk.start}:${chunk.end}`,
      content_sha256: await sha256(chunk.text),
      instruction_taint: rawInput.instruction_taint,
      projection_generation: rawInput.projection_generation,
    });
    items.push(item);
    spans.push({
      item_key: itemKey,
      canonical_section_id: canonicalSectionId,
      normalized_start_byte: chunk.start,
      normalized_end_byte: chunk.end,
    });
  }
  const markdownSha = await sha256(rawInput.markdown);
  const itemSetDigest = await sha256(canonicalJson(items.map((item, index) => ({
    item_key: item.item_key,
    canonical_section_id: item.canonical_section_id,
    content_sha256: item.content_sha256,
    start: spans[index]?.normalized_start_byte,
    end: spans[index]?.normalized_end_byte,
  }))));
  return { items, spans, item_set_digest: itemSetDigest, markdown_sha256: markdownSha };
}
