import {
  DocumentMapRevisionSchema,
  EvidenceHandleSchema,
  IdentifierSchema,
  ProjectAtlasRevisionSchema,
  ResolvedEvidenceSchema,
  ScopeSnapshotSchema,
  SourceCardSchema,
  SourceRevisionSchema,
  type DocumentMapRevision,
  type EvidenceHandle,
  type ProjectAtlasRevision,
  type ResolvedEvidence,
  type ScopeSnapshot,
  type SourceCard,
  type SourceRevision,
  type VersionedRef,
} from "@eliotr/contracts";
import {
  FORBIDDEN_NAVIGATION_KEYS,
  MAX_CANONICAL_BYTES,
  MAX_CARD_AUTHORS,
  MAX_CARD_OUTLINE_ITEMS,
  MAX_CARD_TERMS,
  MAX_ATLAS_NODES,
  MAX_ATLAS_SOURCES,
  MAX_JSON_DEPTH,
  MAX_JSON_NODES,
  MAX_MAP_OBJECTS_PER_FIELD,
  MAX_MAP_TERMS,
  MAX_NODE_REFERENCES,
  MAX_SHORT_TEXT_BYTES,
  MAX_TEXT_BYTES,
} from "./navigation-limits.js";
import {
  NavigationError,
  type EvidenceHandleCandidateSupport,
  type NavigationErrorCode,
  type NavigationOnlySupport,
  type NavigationSection,
  type SectionEvidenceHandleRequest,
} from "./navigation-model.js";

type JsonValue = null | boolean | string | number | readonly JsonValue[] | JsonRecord;
interface JsonRecord { readonly [key: string]: JsonValue; }

export function fail(code: NavigationErrorCode, message: string): never {
  throw new NavigationError(code, message);
}

export function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function utf8Length(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

export function sameArray(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

export function uniqueSorted(values: readonly string[]): string[] {
  return [...new Set(values)].sort(compareText);
}

function uniqueStable(values: readonly string[]): string[] {
  return [...new Set(values)];
}

export function versionedRefKey(value: VersionedRef): string {
  return `${value.id}@${value.revision}`;
}

export function sameVersionedRef(left: VersionedRef, right: VersionedRef): boolean {
  return left.id === right.id && left.revision === right.revision;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseIdentifier(value: unknown, label: string): string {
  const parsed = IdentifierSchema.safeParse(value);
  if (!parsed.success || parsed.data !== parsed.data.trim() || /[\u0000-\u001f\u007f]/u.test(parsed.data)) {
    fail("NAVIGATION_INPUT_INVALID", `${label} is not a canonical identifier`);
  }
  return parsed.data;
}

export function parseText(value: unknown, label: string, maximumBytes = MAX_TEXT_BYTES, allowEmpty = false): string {
  if (
    typeof value !== "string" ||
    (!allowEmpty && value.length === 0) ||
    value !== value.trim() ||
    utf8Length(value) > maximumBytes ||
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value)
  ) {
    fail("NAVIGATION_INPUT_INVALID", `${label} is invalid or exceeds its byte ceiling`);
  }
  return value;
}

export function boundedArray<T>(values: readonly T[], maximum: number, label: string): readonly T[] {
  if (values.length > maximum) fail("NAVIGATION_LIMIT_EXCEEDED", `${label} exceeds its item ceiling`);
  return values;
}

function canonicalizeJsonValue(value: unknown, depth = 0, counter = { nodes: 0 }): JsonValue {
  counter.nodes += 1;
  if (depth > MAX_JSON_DEPTH || counter.nodes > MAX_JSON_NODES) {
    fail("NAVIGATION_LIMIT_EXCEEDED", "navigation JSON exceeds its structural ceiling");
  }
  if (value === null || typeof value === "boolean" || typeof value === "string") return value;
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) fail("NAVIGATION_INPUT_INVALID", "navigation JSON requires safe integers");
    return value;
  }
  if (Array.isArray(value)) return value.map((item) => canonicalizeJsonValue(item, depth + 1, counter));
  if (!isRecord(value)) fail("NAVIGATION_INPUT_INVALID", "navigation JSON contains a non-JSON value");
  const output: Record<string, JsonValue> = Object.create(null) as Record<string, JsonValue>;
  for (const key of Object.keys(value).sort(compareText)) {
    const item = value[key];
    if (item === undefined) continue;
    output[key] = canonicalizeJsonValue(item, depth + 1, counter);
  }
  return output;
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalizeJsonValue(value));
}

export function requireCanonicalSize(value: unknown): void {
  if (utf8Length(canonicalJson(value)) > MAX_CANONICAL_BYTES) {
    fail("NAVIGATION_LIMIT_EXCEEDED", "navigation artifact exceeds its canonical byte ceiling");
  }
}

export async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function assertNoEvidenceAuthority(value: unknown, depth = 0, counter = { nodes: 0 }): void {
  counter.nodes += 1;
  if (depth > MAX_JSON_DEPTH || counter.nodes > MAX_JSON_NODES) {
    fail("NAVIGATION_LIMIT_EXCEEDED", "navigation metadata exceeds its structural ceiling");
  }
  if (Array.isArray(value)) {
    value.forEach((item) => assertNoEvidenceAuthority(item, depth + 1, counter));
    return;
  }
  if (!isRecord(value)) return;
  for (const [key, item] of Object.entries(value)) {
    if (FORBIDDEN_NAVIGATION_KEYS.has(key)) {
      fail("NAVIGATION_ARTIFACT_INVALID", `navigation metadata may not carry ${key}`);
    }
    assertNoEvidenceAuthority(item, depth + 1, counter);
  }
}

export function parseQualifiedSourceRevision(value: unknown): SourceRevision {
  const parsed = SourceRevisionSchema.safeParse(value);
  if (!parsed.success) fail("NAVIGATION_INPUT_INVALID", "source revision failed strict validation");
  if (
    parsed.data.purge_state !== "LIVE" ||
    parsed.data.quality_state === "unqualified" ||
    parsed.data.normalized_artifact_ref === undefined
  ) {
    fail("NAVIGATION_SOURCE_NOT_QUALIFIED", "navigation requires a LIVE qualified normalized source revision");
  }
  return parsed.data;
}

export function parseNavigationScopeSnapshot(value: unknown): ScopeSnapshot {
  const parsed = ScopeSnapshotSchema.safeParse(value);
  if (!parsed.success) fail("NAVIGATION_INPUT_INVALID", "scope snapshot failed strict validation");
  const members = parsed.data.member_source_revision_refs;
  if (!sameArray(members, uniqueSorted(members))) {
    fail("NAVIGATION_INPUT_INVALID", "scope snapshot members are not unique canonical order");
  }
  return parsed.data;
}

export function canonicalNavigationObject(
  value: unknown,
  sourceRevisionRef: string,
  requireSectionRef: boolean,
): Readonly<Record<string, unknown>> {
  if (!isRecord(value)) fail("NAVIGATION_INPUT_INVALID", "navigation object must be a JSON object");
  assertNoEvidenceAuthority(value);
  const canonical = canonicalizeJsonValue(value);
  if (!isRecord(canonical)) fail("NAVIGATION_INPUT_INVALID", "navigation object canonicalization failed");
  if (
    canonical.source_revision_ref !== undefined &&
    canonical.source_revision_ref !== sourceRevisionRef
  ) {
    fail("NAVIGATION_SOURCE_MISMATCH", "navigation object points to another source revision");
  }
  if (
    canonical.navigation_authority !== undefined &&
    canonical.navigation_authority !== "NAVIGATION_ONLY"
  ) {
    fail("NAVIGATION_ARTIFACT_INVALID", "derived navigation object asserted evidence authority");
  }
  const output: Record<string, unknown> = {
    ...canonical,
    navigation_authority: "NAVIGATION_ONLY",
    source_revision_ref: sourceRevisionRef,
  };
  if (requireSectionRef) output.section_ref = parseIdentifier(output.section_ref, "section_ref");
  return output;
}

export function parseStringArray(
  values: readonly unknown[],
  label: string,
  maximum: number,
  identifiers: boolean,
  preserveOrder = false,
): string[] {
  boundedArray(values, maximum, label);
  const parsed = values.map((value) => identifiers
    ? parseIdentifier(value, label)
    : parseText(value, label, MAX_SHORT_TEXT_BYTES));
  return preserveOrder ? uniqueStable(parsed) : uniqueSorted(parsed);
}

export function parseSourceCardArtifact(value: unknown, expectedSourceRevisionRef?: string): SourceCard {
  const parsed = SourceCardSchema.safeParse(value);
  if (!parsed.success) fail("NAVIGATION_ARTIFACT_INVALID", "SourceCard failed strict validation");
  const card = parsed.data;
  if (expectedSourceRevisionRef !== undefined && card.source_revision_ref !== expectedSourceRevisionRef) {
    fail("NAVIGATION_SOURCE_MISMATCH", "SourceCard points to another source revision");
  }
  parseText(card.title, "SourceCard title", MAX_SHORT_TEXT_BYTES);
  parseText(card.abstract, "SourceCard abstract", MAX_TEXT_BYTES, true);
  const authors = parseStringArray(card.authors, "SourceCard authors", MAX_CARD_AUTHORS, false, true);
  const topics = parseStringArray(card.main_topics, "SourceCard topics", MAX_CARD_TERMS, true);
  const vocabulary = parseStringArray(card.controlled_vocabulary, "SourceCard vocabulary", MAX_CARD_TERMS, true);
  const sectionRefs = parseStringArray(card.important_section_refs, "SourceCard section refs", MAX_CARD_TERMS, true);
  const likelyUses = parseStringArray(card.likely_uses, "SourceCard likely uses", MAX_CARD_TERMS, false, true);
  if (
    !sameArray(authors, card.authors) || !sameArray(topics, card.main_topics) ||
    !sameArray(vocabulary, card.controlled_vocabulary) ||
    !sameArray(sectionRefs, card.important_section_refs) || !sameArray(likelyUses, card.likely_uses)
  ) {
    fail("NAVIGATION_ARTIFACT_INVALID", "SourceCard arrays are not unique canonical order");
  }
  boundedArray(card.outline, MAX_CARD_OUTLINE_ITEMS, "SourceCard outline");
  card.outline.forEach((item) => {
    assertNoEvidenceAuthority(item);
    requireCanonicalSize(item);
  });
  requireCanonicalSize(card);
  return card;
}

export function parseDocumentMapArtifact(value: unknown, expectedSourceRevisionRef?: string): DocumentMapRevision {
  const parsed = DocumentMapRevisionSchema.safeParse(value);
  if (!parsed.success) fail("NAVIGATION_ARTIFACT_INVALID", "DocumentMap failed strict validation");
  const map = parsed.data;
  if (expectedSourceRevisionRef !== undefined && map.source_revision_ref !== expectedSourceRevisionRef) {
    fail("NAVIGATION_SOURCE_MISMATCH", "DocumentMap points to another source revision");
  }
  const objectFields = [
    map.section_hierarchy,
    map.page_ranges,
    map.figures,
    map.tables,
    map.named_entities,
    map.dates_and_versions,
    map.external_citations,
  ];
  objectFields.forEach((items) => boundedArray(items, MAX_MAP_OBJECTS_PER_FIELD, "DocumentMap object field"));
  const sectionRefs = new Set<string>();
  map.section_hierarchy.forEach((item) => {
    const bound = canonicalNavigationObject(item, map.source_revision_ref, true);
    const sectionRef = parseIdentifier(bound.section_ref, "section_ref");
    if (sectionRefs.has(sectionRef)) fail("NAVIGATION_ARTIFACT_INVALID", "DocumentMap repeats a section_ref");
    sectionRefs.add(sectionRef);
  });
  objectFields.slice(1).forEach((items) => items.forEach((item) => {
    canonicalNavigationObject(item, map.source_revision_ref, false);
  }));
  const keyTerms = parseStringArray(map.key_terms, "DocumentMap key terms", MAX_MAP_TERMS, true);
  const highInformation = parseStringArray(
    map.high_information_section_refs,
    "DocumentMap high-information sections",
    MAX_MAP_TERMS,
    true,
  );
  if (!sameArray(keyTerms, map.key_terms) || !sameArray(highInformation, map.high_information_section_refs)) {
    fail("NAVIGATION_ARTIFACT_INVALID", "DocumentMap identifier arrays are not unique canonical order");
  }
  if (highInformation.some((sectionRef) => !sectionRefs.has(sectionRef))) {
    fail("NAVIGATION_ARTIFACT_INVALID", "DocumentMap high-information section is absent from its hierarchy");
  }
  const unresolved = parseStringArray(
    map.unresolved_structure,
    "DocumentMap unresolved structure",
    MAX_MAP_TERMS,
    false,
  );
  if (!sameArray(unresolved, map.unresolved_structure)) {
    fail("NAVIGATION_ARTIFACT_INVALID", "DocumentMap unresolved structure is not unique canonical order");
  }
  requireCanonicalSize(map);
  return map;
}

export function parseProjectAtlasArtifact(value: unknown): ProjectAtlasRevision {
  const parsed = ProjectAtlasRevisionSchema.safeParse(value);
  if (!parsed.success) fail("NAVIGATION_ARTIFACT_INVALID", "ProjectAtlas failed strict validation");
  const atlas = parsed.data;
  boundedArray(atlas.nodes, MAX_ATLAS_NODES, "ProjectAtlas nodes");
  const nodeIds = new Set<string>();
  let projectNodes = 0;
  for (const node of atlas.nodes) {
    if (nodeIds.has(node.node_id)) fail("NAVIGATION_ARTIFACT_INVALID", "ProjectAtlas repeats a node_id");
    nodeIds.add(node.node_id);
    if (node.kind === "PROJECT") projectNodes += 1;
    if (node.source_card_refs.length > MAX_NODE_REFERENCES || node.child_node_ids.length > MAX_NODE_REFERENCES) {
      fail("NAVIGATION_LIMIT_EXCEEDED", "ProjectAtlas node exceeds its reference ceiling");
    }
    const cardKeys = node.source_card_refs.map(versionedRefKey);
    if (new Set(cardKeys).size !== cardKeys.length || new Set(node.child_node_ids).size !== node.child_node_ids.length) {
      fail("NAVIGATION_ARTIFACT_INVALID", "ProjectAtlas node repeats a reference");
    }
    assertNoEvidenceAuthority(node.annotations);
    if (node.annotations.navigation_authority !== "NAVIGATION_ONLY") {
      fail("NAVIGATION_ARTIFACT_INVALID", "ProjectAtlas node is not marked navigation-only");
    }
  }
  if (projectNodes !== 1) fail("NAVIGATION_ARTIFACT_INVALID", "ProjectAtlas requires exactly one PROJECT root");
  for (const node of atlas.nodes) {
    if (node.child_node_ids.some((child) => !nodeIds.has(child))) {
      fail("NAVIGATION_ARTIFACT_INVALID", "ProjectAtlas references an unknown child node");
    }
  }
  const colors = new Map<string, "VISITING" | "VISITED">();
  const byId = new Map(atlas.nodes.map((node) => [node.node_id, node] as const));
  for (const root of atlas.nodes) {
    if (colors.get(root.node_id) === "VISITED") continue;
    const stack: { readonly node_id: string; readonly exit: boolean }[] = [
      { node_id: root.node_id, exit: false },
    ];
    while (stack.length > 0) {
      const frame = stack.pop();
      if (frame === undefined) break;
      if (frame.exit) {
        colors.set(frame.node_id, "VISITED");
        continue;
      }
      const color = colors.get(frame.node_id);
      if (color === "VISITING") fail("NAVIGATION_ARTIFACT_INVALID", "ProjectAtlas contains a child cycle");
      if (color === "VISITED") continue;
      colors.set(frame.node_id, "VISITING");
      stack.push({ node_id: frame.node_id, exit: true });
      const children = byId.get(frame.node_id)?.child_node_ids ?? [];
      for (let index = children.length - 1; index >= 0; index -= 1) {
        const child = children[index];
        if (child !== undefined) stack.push({ node_id: child, exit: false });
      }
    }
  }
  const contradictions = parseStringArray(atlas.contradiction_refs, "Atlas contradictions", MAX_MAP_TERMS, true);
  const degraded = parseStringArray(atlas.degraded_source_refs, "Atlas degraded sources", MAX_ATLAS_SOURCES, true);
  const gaps = parseStringArray(atlas.under_researched_areas, "Atlas gaps", MAX_MAP_TERMS, false);
  if (
    !sameArray(contradictions, atlas.contradiction_refs) ||
    !sameArray(degraded, atlas.degraded_source_refs) ||
    !sameArray(gaps, atlas.under_researched_areas)
  ) {
    fail("NAVIGATION_ARTIFACT_INVALID", "ProjectAtlas summary arrays are not unique canonical order");
  }
  boundedArray(atlas.recommended_reading_routes, MAX_NODE_REFERENCES, "ProjectAtlas reading routes");
  atlas.recommended_reading_routes.forEach((route) => {
    assertNoEvidenceAuthority(route);
    if (route.navigation_authority !== "NAVIGATION_ONLY") {
      fail("NAVIGATION_ARTIFACT_INVALID", "reading route is not marked navigation-only");
    }
  });
  requireCanonicalSize(atlas);
  return atlas;
}

export function extractNavigationSections(mapValue: unknown): readonly NavigationSection[] {
  const map = parseDocumentMapArtifact(mapValue);
  return map.section_hierarchy.map((item) => {
    const metadata = canonicalNavigationObject(item, map.source_revision_ref, true);
    const sectionRef = parseIdentifier(metadata.section_ref, "section_ref");
    const labelCandidate = metadata.label ?? metadata.title ?? metadata.heading ?? sectionRef;
    const label = parseText(labelCandidate, "section label", MAX_SHORT_TEXT_BYTES);
    const parent = metadata.parent_section_ref === undefined
      ? undefined
      : parseIdentifier(metadata.parent_section_ref, "parent_section_ref");
    const rawStart = metadata.normalized_start_byte;
    const rawEnd = metadata.normalized_end_byte;
    if ((rawStart === undefined) !== (rawEnd === undefined)) {
      fail("NAVIGATION_ARTIFACT_INVALID", "section has an incomplete normalized byte range");
    }
    let normalizedRange: { readonly start: number; readonly end: number } | undefined;
    if (rawStart !== undefined) {
      if (
        typeof rawStart !== "number" || typeof rawEnd !== "number" ||
        !Number.isSafeInteger(rawStart) || !Number.isSafeInteger(rawEnd) ||
        rawEnd <= rawStart || rawStart < 0
      ) {
        fail("NAVIGATION_ARTIFACT_INVALID", "section normalized byte range is invalid");
      }
      normalizedRange = { start: rawStart, end: rawEnd };
    }
    return {
      section_ref: sectionRef,
      source_revision_ref: map.source_revision_ref,
      label,
      ...(parent === undefined ? {} : { parent_section_ref: parent }),
      ...(normalizedRange === undefined ? {} : {
        normalized_start_byte: normalizedRange.start,
        normalized_end_byte: normalizedRange.end,
      }),
      metadata,
    };
  });
}

export function navigationOnlySupport(reasonCode = "EXACT_EVIDENCE_RESOLUTION_REQUIRED"): NavigationOnlySupport {
  return { kind: "NAVIGATION_ONLY", publication_eligible: false, reason_code: reasonCode };
}

export function evidenceHandleCandidateSupport(handle: EvidenceHandle): EvidenceHandleCandidateSupport {
  return {
    kind: "EVIDENCE_HANDLE_CANDIDATE",
    publication_eligible: false,
    reason_code: "EXACT_EVIDENCE_RESOLUTION_REQUIRED",
    handle_ref: handle.handle_ref,
  };
}

export async function requireResolvedEvidenceForPublication(
  candidate: unknown,
  expected: { readonly source_revision_ref: string; readonly scope_snapshot_ref: VersionedRef },
): Promise<ResolvedEvidence> {
  const parsed = ResolvedEvidenceSchema.safeParse(candidate);
  if (!parsed.success) {
    fail("NAVIGATION_PUBLICATION_SUPPORT_REQUIRED", "navigation output is not resolved publication evidence");
  }
  const evidence = parsed.data;
  if (
    evidence.handle.terminal_state !== "LIVE" ||
    evidence.handle.source_revision_ref !== expected.source_revision_ref ||
    !sameVersionedRef(evidence.handle.scope_snapshot_ref, expected.scope_snapshot_ref) ||
    utf8Length(evidence.exact_excerpt) !== evidence.handle.excerpt_byte_length ||
    await sha256Hex(evidence.exact_excerpt) !== evidence.handle.excerpt_sha256
  ) {
    fail("NAVIGATION_PUBLICATION_SUPPORT_REQUIRED", "resolved evidence does not match the requested source and scope");
  }
  return evidence;
}


export function parseEvidenceHandleCandidate(
  value: unknown,
  expected: SectionEvidenceHandleRequest,
  section?: NavigationSection,
): EvidenceHandle {
  const parsed = EvidenceHandleSchema.safeParse(value);
  if (!parsed.success) fail("NAVIGATION_ARTIFACT_INVALID", "EvidenceHandle candidate failed strict validation");
  const handle = parsed.data;
  if (
    handle.terminal_state !== "LIVE" ||
    handle.source_revision_ref !== expected.source_revision_ref ||
    !sameVersionedRef(handle.scope_snapshot_ref, expected.scope_snapshot_ref)
  ) {
    fail("NAVIGATION_SOURCE_MISMATCH", "EvidenceHandle candidate does not bind the requested source and scope");
  }
  if (
    section?.normalized_start_byte !== undefined &&
    handle.anchor.kind === "normalized_byte_range" &&
    (handle.anchor.start !== section.normalized_start_byte || handle.anchor.end !== section.normalized_end_byte)
  ) {
    fail("NAVIGATION_SOURCE_MISMATCH", "EvidenceHandle candidate does not bind the requested section range");
  }
  return handle;
}
