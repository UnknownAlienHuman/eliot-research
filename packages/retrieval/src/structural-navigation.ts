import type {
  DocumentMapRevision,
  ScopeSnapshot,
  SourceCard,
  SourceRevision,
} from "@eliotr/contracts";
import { buildDocumentMap, buildSourceCard } from "./navigation-builders.js";
import {
  extractNormalizedMarkdownStructure,
  StructuralProjectionError,
} from "./structural-projector.js";
import {
  MAX_CANONICAL_BYTES,
  MAX_MAP_OBJECTS_PER_FIELD,
} from "./navigation-limits.js";
import {
  parseNavigationScopeSnapshot,
  parseQualifiedSourceRevision,
  sha256Hex,
  utf8Length,
} from "./navigation-codec.js";
import { NavigationError } from "./navigation-model.js";

export interface StructuralNavigationInput {
  readonly source_revision: SourceRevision;
  readonly scope_snapshot?: ScopeSnapshot;
  readonly normalized_markdown: string;
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

/** Truncate on Unicode code-point boundaries; never splits a surrogate pair. Byte ranges are untouched. */
function truncateCodePoints(value: string, maxCodePoints: number): string {
  const points = Array.from(value);
  return points.length > maxCodePoints ? points.slice(0, maxCodePoints).join("") : value;
}

/**
 * N1 honest structural derivation from exact admitted bytes.
 *
 * The caller loads one bounded admitted normalized artifact through the current
 * D1/R2 authority (purge, owner generation, residency,
 * scope membership, grant and policy are rechecked by D1NavigationStore on
 * put/get). This pure step binds those bytes to the expected SourceRevision
 * digests, derives stable sections with exact UTF-8 ranges, and delegates
 * identity to the existing ER-31 builders. This checkpoint accepts normalized
 * structure only; it never infers or promotes page, table-cell, code-symbol or
 * native coordinates from caller text.
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

  let extracted;
  try {
    extracted = extractNormalizedMarkdownStructure(input.normalized_markdown, MAX_MAP_OBJECTS_PER_FIELD);
  } catch (error) {
    if (!(error instanceof StructuralProjectionError)) throw error;
    const code = error.code === "PROJECTION_ITEM_LIMIT_EXCEEDED"
      ? "NAVIGATION_LIMIT_EXCEEDED"
      : error.code === "PROJECTION_OFFSET_INVALID"
        ? "NAVIGATION_ARTIFACT_INVALID"
        : "NAVIGATION_INPUT_INVALID";
    navigationFail(code, error.message);
  }
  const sectionRefs = await Promise.all(extracted.map(async (section) => {
    const digest = await sha256Hex(JSON.stringify({
      source_revision_ref: source.source_revision_ref,
      start: section.normalized_start_byte,
      end: section.normalized_end_byte,
      heading_path: section.heading_path,
    }));
    return `section-${digest.slice(0, 48)}`;
  }));
  const sections = extracted.map((section, index) => {
    const sectionRef = sectionRefs[index];
    const parent = section.parent_index === undefined ? undefined : sectionRefs[section.parent_index];
    if (section.parent_index !== undefined && parent === undefined) {
      navigationFail("NAVIGATION_ARTIFACT_INVALID", "section parent is absent");
    }
    return {
      section_ref: sectionRef,
      label: section.label,
      heading_path: [...section.heading_path],
      level: section.level,
      start: section.normalized_start_byte,
      end: section.normalized_end_byte,
      ...(parent === undefined ? {} : { parent_section_ref: parent }),
    };
  });
  if (new Set(sectionRefs).size !== sections.length) {
    navigationFail("NAVIGATION_ARTIFACT_INVALID", "derived sections repeat an identity");
  }
  const byRef = new Map(sections.map((section) => [section.section_ref, section] as const));
  for (const section of sections) {
    if (section.end <= section.start || section.start < 0 || section.end > markdownBytes) {
      navigationFail("NAVIGATION_ARTIFACT_INVALID", "section normalized byte range is invalid");
    }
    if (section.parent_section_ref !== undefined) {
      const parent = byRef.get(section.parent_section_ref);
      if (parent === undefined || parent.start > section.start || parent.end < section.end) {
        navigationFail("NAVIGATION_ARTIFACT_INVALID", "section parent range is invalid");
      }
    }
  }

  const unresolved = [
    "CODE_SYMBOL_COORDINATES_NOT_INFERRED",
    "PAGE_COORDINATES_NOT_INFERRED",
    "TABLE_CELL_COORDINATES_NOT_INFERRED",
  ];
  unresolved.push("COORDINATE_MAP_ABSENT_NATIVE_ANCHORS_UNAVAILABLE");

  const title = sections.find((section) => section.label !== "Preamble")?.label ?? `Source ${source.source_revision_ref}`;
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
        })),
        unresolved_structure: unresolved,
      },
    ],
  });

  return { sourceCard, documentMap, section_count: sections.length };
}
