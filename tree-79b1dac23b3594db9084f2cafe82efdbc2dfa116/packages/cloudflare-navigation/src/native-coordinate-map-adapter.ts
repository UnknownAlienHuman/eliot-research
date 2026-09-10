import type {
  CoordinateMap,
  DocumentMapRevision,
  SourceRevision,
} from "@eliotr/contracts";
import type { AdmittedCoordinateMap, D1NavigationStore } from "@eliotr/cloudflare-evidence";
import {
  buildDocumentMap,
  NavigationError,
  type DocumentMapFragment,
} from "@eliotr/retrieval";

interface SectionBounds {
  readonly start: number;
  readonly end: number;
}

function record(value: unknown): Readonly<Record<string, unknown>> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>>
    : null;
}

function sectionBounds(map: DocumentMapRevision): Map<string, SectionBounds> {
  const result = new Map<string, SectionBounds>();
  for (const item of map.section_hierarchy) {
    const object = record(item);
    if (object === null || typeof object.section_ref !== "string" ||
        typeof object.normalized_start_byte !== "number" || typeof object.normalized_end_byte !== "number") continue;
    if (!Number.isSafeInteger(object.normalized_start_byte) || !Number.isSafeInteger(object.normalized_end_byte) ||
        object.normalized_end_byte <= object.normalized_start_byte) continue;
    result.set(object.section_ref, {
      start: object.normalized_start_byte,
      end: object.normalized_end_byte,
    });
  }
  return result;
}

function sourceFragment(map: DocumentMapRevision): DocumentMapFragment {
  return {
    fragment_id: "existing-structural-document-map",
    source_revision_ref: map.source_revision_ref,
    section_hierarchy: map.section_hierarchy,
    page_ranges: map.page_ranges,
    figures: map.figures,
    tables: map.tables,
    named_entities: map.named_entities,
    dates_and_versions: map.dates_and_versions,
    external_citations: map.external_citations,
    key_terms: map.key_terms,
    high_information_section_refs: map.high_information_section_refs,
    unresolved_structure: map.unresolved_structure,
    ...(map.mappings_to_original_ref === undefined ? {} : { mappings_to_original_ref: map.mappings_to_original_ref }),
  };
}

function nativeTableFragment(
  map: CoordinateMap,
  mapObjectRef: string,
  sectionMap: ReadonlyMap<string, SectionBounds>,
): DocumentMapFragment {
  let unresolved = false;
  const tables = map.entries.map((entry) => {
    if (entry.anchor.kind !== "table_cell") {
      throw new NavigationError("NAVIGATION_ARTIFACT_INVALID", "coordinate map contains an unsupported anchor kind");
    }
    let section: SectionBounds | undefined;
    if (entry.section_ref !== undefined) {
      section = sectionMap.get(entry.section_ref);
      if (section === undefined) {
        throw new NavigationError("NAVIGATION_SECTION_NOT_FOUND", "coordinate map references an unavailable section");
      }
      if (entry.normalized_start_byte < section.start || entry.normalized_end_byte > section.end) {
        throw new NavigationError("NAVIGATION_ARTIFACT_INVALID", "coordinate map range is not fully contained by its section");
      }
    } else {
      unresolved = true;
    }
    return {
      coordinate_kind: "table_cell",
      table_id: entry.anchor.table_id,
      row: entry.anchor.row,
      column: entry.anchor.column,
      normalized_start_byte: entry.normalized_start_byte,
      normalized_end_byte: entry.normalized_end_byte,
      excerpt_sha256: entry.excerpt_sha256,
      ...(entry.section_ref === undefined ? {} : { section_ref: entry.section_ref }),
      navigation_precision: "table_cell",
      navigation_authority: "NAVIGATION_ONLY",
    };
  });
  return {
    fragment_id: "admitted-coordinate-map",
    source_revision_ref: map.source_revision_ref,
    tables,
    mappings_to_original_ref: mapObjectRef,
    ...(unresolved ? { unresolved_structure: ["COORDINATE_MAP_SECTION_RELATION_UNRESOLVED"] } : {}),
  };
}

/** Merge an admitted table-cell map into the existing navigation-only DocumentMap. */
export async function adaptCoordinateMapToDocumentMap(input: {
  readonly source_revision: SourceRevision;
  readonly structural_map: DocumentMapRevision;
  readonly admitted_map: AdmittedCoordinateMap;
  readonly generator_generation: string;
  readonly created_at: string;
}): Promise<DocumentMapRevision> {
  if (input.structural_map.source_revision_ref !== input.source_revision.source_revision_ref ||
      input.admitted_map.map.source_revision_ref !== input.source_revision.source_revision_ref) {
    throw new NavigationError("NAVIGATION_SOURCE_MISMATCH", "coordinate map and structural map use different source revisions");
  }
  const fragment = nativeTableFragment(input.admitted_map.map, input.admitted_map.map_object_ref, sectionBounds(input.structural_map));
  return buildDocumentMap({
    source_revision: input.source_revision,
    generator_generation: input.generator_generation,
    created_at: input.created_at,
    fragments: [sourceFragment(input.structural_map), fragment],
  });
}

/** Persist the merged map through the existing scope/currentness authority. */
export async function persistCoordinateMap(input: {
  readonly store: D1NavigationStore;
  readonly source_revision: SourceRevision;
  readonly structural_map: DocumentMapRevision;
  readonly admitted_map: AdmittedCoordinateMap;
  readonly generator_generation: string;
  readonly created_at: string;
}): Promise<DocumentMapRevision> {
  const map = await adaptCoordinateMapToDocumentMap(input);
  await input.store.putArtifact("DOCUMENT_MAP", map);
  return map;
}
