import type {
  DocumentMapRevision,
  ScopeSnapshot,
  SourceCard,
  SourceRevision,
} from "@eliotr/contracts";
import { buildDocumentMap, buildSourceCard } from "./navigation-builders.js";
import {
  MAX_CANONICAL_BYTES,
  MAX_MAP_OBJECTS_PER_FIELD,
  MAX_SHORT_TEXT_BYTES,
} from "./navigation-limits.js";
import {
  parseNavigationScopeSnapshot,
  parseQualifiedSourceRevision,
  sha256Hex,
} from "./navigation-codec.js";
import { NavigationError } from "./navigation-model.js";

export interface StructuralNavigationInput {
  readonly source_revision: SourceRevision;
  readonly scope_snapshot?: ScopeSnapshot;
  readonly normalized_markdown: string;
  readonly coordinate_map_json?: string;
  readonly source_kind?: string;
  readonly generator_generation: string;
  readonly created_at: string;
}

export interface StructuralNavigationResult {
  readonly sourceCard: SourceCard;
  readonly documentMap: DocumentMapRevision;
  readonly section_count: number;
}

function navigationFail(code: NavigationError["code"], message: string): never {
  throw new NavigationError(code, message);
}

function utf8Length(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function headingOf(line: string): { level: number; title: string } | null {
  const match = /^(#{1,6})[ \t]+([^\r\n]+?)[ \t]*(?:\r?\n)?$/u.exec(line);
  if (match === null) return null;
  const marker = match[1];
  const title = match[2]?.trim();
  if (marker === undefined || title === undefined || title.length === 0) return null;
  return { level: marker.length, title };
}

interface FenceOpener {
  readonly char: "`" | "~";
  readonly length: number;
}

function parseFenceOpener(line: string): FenceOpener | null {
  const match = /^ {0,3}(`+|~+)/u.exec(line);
  if (match === null) return null;
  const run = match[1] ?? "";
  if (run.length < 3) return null;
  const char = (run[0] === "~" ? "~" : "`") as "`" | "~";
  // CommonMark: a backtick opener whose info string contains a backtick is not a fence.
  if (char === "`" && line.slice(match[0].length).includes("`")) return null;
  return { char, length: run.length };
}

function isFenceCloser(line: string, opener: FenceOpener): boolean {
  const match = /^ {0,3}(`+|~+)[ \t]*(?:\r?\n)?$/u.exec(line);
  if (match === null) return false;
  const run = match[1] ?? "";
  // CommonMark: closer matches the opener char, runs at least as long, carries no info string.
  return run[0] === opener.char && run.length >= opener.length;
}

/** Truncate on Unicode code-point boundaries; never splits a surrogate pair. Byte ranges are untouched. */
function truncateCodePoints(value: string, maxCodePoints: number): string {
  const points = Array.from(value);
  return points.length > maxCodePoints ? points.slice(0, maxCodePoints).join("") : value;
}

interface LineSpan {
  readonly text: string;
  readonly start: number;
  readonly end: number;
}

function splitLines(markdown: string): LineSpan[] {
  const result: LineSpan[] = [];
  let textStart = 0;
  let byteStart = 0;
  const encoder = new TextEncoder();
  for (let index = 0; index < markdown.length; index += 1) {
    if (markdown[index] !== "\n") continue;
    const text = markdown.slice(textStart, index + 1);
    const bytes = encoder.encode(text).byteLength;
    result.push({ text, start: byteStart, end: byteStart + bytes });
    textStart = index + 1;
    byteStart += bytes;
    if (result.length > 131072) navigationFail("NAVIGATION_LIMIT_EXCEEDED", "admitted lines exceed traversal bound");
  }
  if (textStart < markdown.length) {
    const text = markdown.slice(textStart);
    result.push({ text, start: byteStart, end: byteStart + encoder.encode(text).byteLength });
  }
  if (result.length === 0) navigationFail("NAVIGATION_INPUT_INVALID", "normalized Markdown has no bytes");
  return result;
}

interface DerivedSection {
  section_ref: string;
  label: string;
  heading_path: string[];
  level: number;
  start: number;
  end: number;
  parent_section_ref?: string;
  native_anchor?: Record<string, unknown>;
}

function parseCoordinateEntries(raw: string): unknown[] {
  if (utf8Length(raw) > MAX_CANONICAL_BYTES) {
    navigationFail("NAVIGATION_LIMIT_EXCEEDED", "coordinate map exceeds canonical byte ceiling");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    navigationFail("NAVIGATION_INPUT_INVALID", "coordinate map is not valid JSON");
  }
  if (!Array.isArray(parsed)) navigationFail("NAVIGATION_INPUT_INVALID", "coordinate map must be an array");
  if (parsed.length > MAX_MAP_OBJECTS_PER_FIELD) {
    navigationFail("NAVIGATION_LIMIT_EXCEEDED", "coordinate map exceeds object ceiling");
  }
  return parsed;
}

/**
 * N1 honest structural derivation from exact admitted bytes.
 *
 * The caller loads one bounded admitted normalized artifact plus its coordinate
 * map through the current D1/R2 authority (purge, owner generation, residency,
 * scope membership, grant and policy are rechecked by D1NavigationStore on
 * put/get). This pure step binds those bytes to the expected SourceRevision
 * digests, derives stable sections with exact UTF-8 ranges, and delegates
 * identity to the existing ER-31 builders. It never infers page, table-cell,
 * code-symbol or native coordinates from prose.
 */
export async function materializeStructuralNavigation(
  input: StructuralNavigationInput,
): Promise<StructuralNavigationResult> {
  const source = parseQualifiedSourceRevision(input.source_revision);
  if (input.scope_snapshot !== undefined) {
    const scope = parseNavigationScopeSnapshot(input.scope_snapshot);
    if (!scope.member_source_revision_refs.includes(source.source_revision_ref)) {
      navigationFail("NAVIGATION_SCOPE_MISMATCH", "source revision is outside the frozen scope");
    }
  }
  if (typeof input.normalized_markdown !== "string" || input.normalized_markdown.length === 0) {
    navigationFail("NAVIGATION_INPUT_INVALID", "normalized Markdown is empty");
  }
  if (input.normalized_markdown.length > MAX_CANONICAL_BYTES) {
    navigationFail("NAVIGATION_LIMIT_EXCEEDED", "normalized Markdown exceeds char ceiling before encoding");
  }
  const markdownBytes = utf8Length(input.normalized_markdown);
  if (markdownBytes > MAX_CANONICAL_BYTES) {
    navigationFail("NAVIGATION_LIMIT_EXCEEDED", "normalized Markdown exceeds canonical byte ceiling");
  }
  const observedSha = await sha256Hex(input.normalized_markdown);
  if (observedSha !== source.content_sha256) {
    navigationFail("NAVIGATION_SOURCE_MISMATCH", "admitted bytes differ from the pinned source content digest");
  }
  if (typeof input.generator_generation !== "string" || input.generator_generation.trim().length === 0) {
    navigationFail("NAVIGATION_INPUT_INVALID", "generator_generation is invalid");
  }
  if (!Number.isFinite(Date.parse(input.created_at))) {
    navigationFail("NAVIGATION_INPUT_INVALID", "created_at is not a valid timestamp");
  }
  const sourceKind = input.source_kind ?? "document";
  if (typeof sourceKind !== "string" || sourceKind.trim().length === 0 || sourceKind.length > 256) {
    navigationFail("NAVIGATION_INPUT_INVALID", "source_kind is invalid");
  }

  const lines = splitLines(input.normalized_markdown);
  const markdownByteLength = lines.length === 0 ? 0 : (lines[lines.length - 1]?.end ?? 0);

  interface HeadingMark {
    level: number;
    title: string;
    lineIndex: number;
    start: number;
  }
  const marks: HeadingMark[] = [];
  let inFence: FenceOpener | null = null;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (line === undefined) continue;
    if (inFence !== null) {
      if (isFenceCloser(line.text, inFence)) inFence = null;
      continue;
    }
    const opener = parseFenceOpener(line.text);
    if (opener !== null) {
      inFence = opener;
      continue;
    }
    const found = headingOf(line.text);
    if (found !== null) {
      if (utf8Length(found.title) > MAX_SHORT_TEXT_BYTES) {
        navigationFail("NAVIGATION_INPUT_INVALID", "heading exceeds short-text ceiling");
      }
      marks.push({ level: found.level, title: found.title, lineIndex: index, start: line.start });
    }
  }

  const sections: DerivedSection[] = [];
  const path: { title: string; level: number; refIndex: number }[] = [];
  async function sectionRef(start: number, end: number, headingPath: readonly string[]): Promise<string> {
    const digest = await sha256Hex(JSON.stringify({
      source_revision_ref: source.source_revision_ref,
      start,
      end,
      heading_path: headingPath,
    }));
    return `section-${digest.slice(0, 48)}`;
  }

  if (marks.length === 0) {
    const end = markdownByteLength;
    if (end <= 0) navigationFail("NAVIGATION_INPUT_INVALID", "normalized Markdown has no projectable bytes");
    sections.push({
      section_ref: await sectionRef(0, end, []),
      label: truncateCodePoints(`Source ${source.source_revision_ref}`, 256),
      heading_path: [],
      level: 1,
      start: 0,
      end,
    });
  } else {
    for (let markIndex = 0; markIndex < marks.length; markIndex += 1) {
      const mark = marks[markIndex];
      if (mark === undefined) continue;
      let end = markdownByteLength;
      for (let later = markIndex + 1; later < marks.length; later += 1) {
        const candidate = marks[later];
        if (candidate !== undefined && candidate.level <= mark.level) {
          const endLine = lines[candidate.lineIndex];
          if (endLine !== undefined) {
            end = endLine.start;
            break;
          }
        }
      }
      if (end <= mark.start) navigationFail("NAVIGATION_ARTIFACT_INVALID", "section byte range is invalid");
      while (path.length > 0 && (path[path.length - 1]?.level ?? 0) >= mark.level) path.pop();
      const headingPath = [...path.map((entry) => entry.title), mark.title];
      if (headingPath.length > 32) navigationFail("NAVIGATION_LIMIT_EXCEEDED", "heading path exceeds depth ceiling");
      const ref = await sectionRef(mark.start, end, headingPath);
      const parent = path.length === 0 ? undefined : sections[path[path.length - 1]?.refIndex ?? -1]?.section_ref;
      const derived: DerivedSection = {
        section_ref: ref,
        label: mark.title,
        heading_path: headingPath,
        level: mark.level,
        start: mark.start,
        end,
        ...(parent === undefined ? {} : { parent_section_ref: parent }),
      };
      path.push({ title: mark.title, level: mark.level, refIndex: sections.length });
      sections.push(derived);
    }
    // Preamble bytes before the first heading belong to an explicit preamble section.
    const firstStart = marks[0]?.start ?? 0;
    if (firstStart > 0) {
      const preambleRef = await sectionRef(0, firstStart, []);
      sections.unshift({
        section_ref: preambleRef,
        label: "Preamble",
        heading_path: [],
        level: 1,
        start: 0,
        end: firstStart,
      });
    }
  }

  if (sections.length === 0) navigationFail("NAVIGATION_INPUT_INVALID", "no sections derived from admitted bytes");
  if (sections.length > MAX_MAP_OBJECTS_PER_FIELD) {
    navigationFail("NAVIGATION_LIMIT_EXCEEDED", "derived sections exceed object ceiling");
  }
  const refSet = new Set(sections.map((section) => section.section_ref));
  if (refSet.size !== sections.length) {
    navigationFail("NAVIGATION_ARTIFACT_INVALID", "derived sections repeat an identity");
  }
  const byRef = new Map(sections.map((section) => [section.section_ref, section] as const));
  for (const section of sections) {
    if (section.end <= section.start || section.start < 0 || section.end > markdownByteLength) {
      navigationFail("NAVIGATION_ARTIFACT_INVALID", "section normalized byte range is invalid");
    }
    if (section.parent_section_ref !== undefined) {
      const parent = byRef.get(section.parent_section_ref);
      if (parent === undefined) navigationFail("NAVIGATION_ARTIFACT_INVALID", "section parent is absent");
      if (parent.start > section.start || parent.end < section.end) {
        navigationFail("NAVIGATION_ARTIFACT_INVALID", "section escapes its parent range");
      }
      if (parent.section_ref === section.section_ref) {
        navigationFail("NAVIGATION_ARTIFACT_INVALID", "section parents itself");
      }
    }
  }
  // Bounded cycle check over parent links.
  for (const section of sections) {
    const seen = new Set<string>([section.section_ref]);
    let current = section.parent_section_ref;
    let hops = 0;
    while (current !== undefined) {
      hops += 1;
      if (hops > sections.length) navigationFail("NAVIGATION_ARTIFACT_INVALID", "section hierarchy contains a cycle");
      if (seen.has(current)) navigationFail("NAVIGATION_ARTIFACT_INVALID", "section hierarchy contains a cycle");
      seen.add(current);
      current = byRef.get(current)?.parent_section_ref;
    }
  }

  let nativeExact = 0;
  let approximateGaps = 0;
  if (input.coordinate_map_json !== undefined) {
    const entries = parseCoordinateEntries(input.coordinate_map_json);
    const seenRanges = new Set<string>();
    for (const entry of entries) {
      if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
        navigationFail("NAVIGATION_INPUT_INVALID", "coordinate map entry must be an object");
      }
      const record = entry as Record<string, unknown>;
      if (record.source_revision_ref !== undefined && record.source_revision_ref !== source.source_revision_ref) {
        navigationFail("NAVIGATION_SOURCE_MISMATCH", "coordinate map points to another source revision");
      }
      const start = record.normalized_start_byte;
      const end = record.normalized_end_byte;
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) ||
        (end as number) <= (start as number) || (start as number) < 0 || (end as number) > markdownByteLength) {
        navigationFail("NAVIGATION_ARTIFACT_INVALID", "coordinate map range is invalid");
      }
      const key = `${String(start)}:${String(end)}`;
      if (seenRanges.has(key)) navigationFail("NAVIGATION_ARTIFACT_INVALID", "coordinate map repeats a range");
      seenRanges.add(key);
      const precision = record.precision === undefined ? "EXACT" : record.precision;
      if (precision !== "EXACT") {
        approximateGaps += 1;
        continue;
      }
      const target = sections.find((section) => section.start === start && section.end === end);
      if (target === undefined) {
        navigationFail("NAVIGATION_ARTIFACT_INVALID", "coordinate map range matches no exact section");
      }
      if (record.native_anchor !== undefined) {
        if (typeof record.native_anchor !== "object" || record.native_anchor === null || Array.isArray(record.native_anchor)) {
          navigationFail("NAVIGATION_INPUT_INVALID", "native anchor must be an object");
        }
        const nativeText = JSON.stringify(record.native_anchor);
        if (utf8Length(nativeText) > MAX_SHORT_TEXT_BYTES) {
          navigationFail("NAVIGATION_LIMIT_EXCEEDED", "native anchor exceeds short-text ceiling");
        }
        target.native_anchor = record.native_anchor as Record<string, unknown>;
        nativeExact += 1;
      } else {
        nativeExact += 1;
      }
      if (typeof record.section_ref === "string" && record.section_ref !== target.section_ref) {
        navigationFail("NAVIGATION_ARTIFACT_INVALID", "coordinate map section identity conflicts");
      }
    }
  }

  const unresolved = [
    "CODE_SYMBOL_COORDINATES_NOT_INFERRED",
    "PAGE_COORDINATES_NOT_INFERRED",
    "TABLE_CELL_COORDINATES_NOT_INFERRED",
  ];
  if (input.coordinate_map_json === undefined) {
    unresolved.push("COORDINATE_MAP_ABSENT_NATIVE_ANCHORS_UNAVAILABLE");
  } else if (nativeExact < sections.length) {
    unresolved.push("NATIVE_ANCHORS_PARTIAL_EXACT_ONLY");
  }
  if (approximateGaps > 0) unresolved.push("APPROXIMATE_COORDINATES_RECORDED_AS_GAP");

  const title = marks.length === 0 ? `Source ${source.source_revision_ref}` : (marks[0]?.title ?? `Source ${source.source_revision_ref}`);
  const outline = sections.filter((section) => section.level === 1).slice(0, 1024).map((section) => ({
    section_ref: section.section_ref,
    label: section.label,
  }));
  if (sections.filter((section) => section.level === 1).length > 1024) {
    navigationFail("NAVIGATION_LIMIT_EXCEEDED", "outline exceeds item ceiling");
  }

  const sourceCard = await buildSourceCard({
    source_revision: source,
    generator_generation: input.generator_generation,
    created_at: input.created_at,
    draft: {
      title: truncateCodePoints(title, 256),
      authors: [],
      language: "und",
      source_kind: sourceKind,
      document_role: "unclassified",
      authority_hint: "structural_derived",
      abstract: "",
      main_topics: [],
      controlled_vocabulary: [],
      outline,
      important_section_refs: [],
      likely_uses: ["source_selection"],
    },
  });

  const documentMap = await buildDocumentMap({
    source_revision: source,
    generator_generation: input.generator_generation,
    created_at: input.created_at,
    fragments: [
      {
        fragment_id: "structural-v1",
        source_revision_ref: source.source_revision_ref,
        section_hierarchy: sections.map((section) => ({
          section_ref: section.section_ref,
          label: section.label,
          ...(section.parent_section_ref === undefined ? {} : { parent_section_ref: section.parent_section_ref }),
          normalized_start_byte: section.start,
          normalized_end_byte: section.end,
          heading_path: section.heading_path,
          ...(section.native_anchor === undefined ? {} : { native_anchor: section.native_anchor }),
        })),
        unresolved_structure: unresolved,
      },
    ],
  });

  return { sourceCard, documentMap, section_count: sections.length };
}
