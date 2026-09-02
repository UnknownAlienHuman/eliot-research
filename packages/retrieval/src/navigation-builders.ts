import {
  DocumentMapRevisionSchema,
  ProjectAtlasRevisionSchema,
  SourceCardSchema,
  VersionedRefSchema,
  type DocumentMapRevision,
  type ProjectAtlasRevision,
  type SourceCard,
  type VersionedRef,
} from "@eliotr/contracts";
import {
  MAX_ATLAS_NODES,
  MAX_ATLAS_SOURCES,
  MAX_CARD_AUTHORS,
  MAX_CARD_OUTLINE_ITEMS,
  MAX_CARD_TERMS,
  MAX_MAP_FRAGMENTS,
  MAX_MAP_OBJECTS_PER_FIELD,
  MAX_MAP_TERMS,
  MAX_NODE_REFERENCES,
  MAX_SHORT_TEXT_BYTES,
  MAX_TEXT_BYTES,
  VERSION_TOKEN,
} from "./navigation-limits.js";
import type {
  DocumentMapBuildInput,
  DocumentMapFragment,
  ProjectAtlasBuildInput,
  SourceCardBuildInput,
} from "./navigation-model.js";
import {
  boundedArray,
  canonicalJson,
  canonicalNavigationObject,
  compareText,
  fail,
  parseDocumentMapArtifact,
  parseIdentifier,
  parseNavigationScopeSnapshot,
  parseQualifiedSourceRevision,
  parseSourceCardArtifact,
  parseStringArray,
  parseText,
  parseProjectAtlasArtifact,
  requireCanonicalSize,
  sha256Hex,
  uniqueSorted,
  versionedRefKey,
} from "./navigation-codec.js";

export async function buildSourceCard(input: SourceCardBuildInput): Promise<SourceCard> {
  const source = parseQualifiedSourceRevision(input.source_revision);
  const generator = parseIdentifier(input.generator_generation, "generator_generation");
  const authors = parseStringArray(input.draft.authors, "authors", MAX_CARD_AUTHORS, false, true);
  const mainTopics = parseStringArray(input.draft.main_topics, "main_topics", MAX_CARD_TERMS, true);
  const vocabulary = parseStringArray(
    input.draft.controlled_vocabulary,
    "controlled_vocabulary",
    MAX_CARD_TERMS,
    true,
  );
  const important = parseStringArray(
    input.draft.important_section_refs,
    "important_section_refs",
    MAX_CARD_TERMS,
    true,
  );
  const likelyUses = parseStringArray(input.draft.likely_uses, "likely_uses", MAX_CARD_TERMS, false, true);
  const outline = boundedArray(input.draft.outline, MAX_CARD_OUTLINE_ITEMS, "outline")
    .map((item) => canonicalNavigationObject(item, source.source_revision_ref, false));
  const body = {
    source_revision_ref: source.source_revision_ref,
    source_content_sha256: source.content_sha256,
    title: parseText(input.draft.title, "title", MAX_SHORT_TEXT_BYTES),
    authors,
    ...(input.draft.date === undefined
      ? {}
      : { date: parseText(input.draft.date, "date", MAX_SHORT_TEXT_BYTES) }),
    language: parseIdentifier(input.draft.language, "language"),
    source_kind: parseIdentifier(input.draft.source_kind, "source_kind"),
    document_role: parseIdentifier(input.draft.document_role, "document_role"),
    authority_hint: parseIdentifier(input.draft.authority_hint, "authority_hint"),
    abstract: parseText(input.draft.abstract, "abstract", MAX_TEXT_BYTES, true),
    main_topics: mainTopics,
    controlled_vocabulary: vocabulary,
    outline,
    important_section_refs: important,
    likely_uses: likelyUses,
    quality_status: source.quality_state,
    generator_generation: generator,
    created_at: input.created_at,
  };
  requireCanonicalSize(body);
  const digest = await sha256Hex(canonicalJson({ protocol: "eliotr.source-card.v1", ...body }));
  const { source_content_sha256: _sourceContentSha256, ...contractBody } = body;
  return parseSourceCardArtifact(SourceCardSchema.parse({
    card_ref: { id: `source-card-${digest.slice(0, 48)}`, revision: 1 },
    ...contractBody,
  }), source.source_revision_ref);
}

function mergeNavigationObjects(
  fragments: readonly DocumentMapFragment[],
  field: keyof Pick<DocumentMapFragment,
    "section_hierarchy" | "page_ranges" | "figures" | "tables" | "named_entities" |
    "dates_and_versions" | "external_citations">,
  sourceRevisionRef: string,
  requireSectionRef: boolean,
): readonly Readonly<Record<string, unknown>>[] {
  const output = new Map<string, Readonly<Record<string, unknown>>>();
  for (const fragment of fragments) {
    const values = fragment[field] ?? [];
    boundedArray(values, MAX_MAP_OBJECTS_PER_FIELD, `DocumentMap ${field}`);
    for (const value of values) {
      const object = canonicalNavigationObject(value, sourceRevisionRef, requireSectionRef);
      const identity = requireSectionRef
        ? parseIdentifier(object.section_ref, "section_ref")
        : canonicalJson(object);
      const prior = output.get(identity);
      if (prior !== undefined && canonicalJson(prior) !== canonicalJson(object)) {
        fail("NAVIGATION_ARTIFACT_INVALID", `DocumentMap ${field} contains a conflicting identity`);
      }
      output.set(identity, object);
    }
  }
  return [...output.entries()].sort(([left], [right]) => compareText(left, right)).map(([, value]) => value);
}

function mergeFragmentStrings(
  fragments: readonly DocumentMapFragment[],
  field: keyof Pick<DocumentMapFragment,
    "key_terms" | "high_information_section_refs" | "unresolved_structure">,
  identifiers: boolean,
): string[] {
  const values = fragments.flatMap((fragment) => fragment[field] ?? []);
  return parseStringArray(values, `DocumentMap ${field}`, MAX_MAP_TERMS, identifiers);
}

export async function buildDocumentMap(input: DocumentMapBuildInput): Promise<DocumentMapRevision> {
  const source = parseQualifiedSourceRevision(input.source_revision);
  const generator = parseIdentifier(input.generator_generation, "generator_generation");
  boundedArray(input.fragments, MAX_MAP_FRAGMENTS, "DocumentMap fragments");
  if (input.fragments.length === 0) fail("NAVIGATION_INPUT_INVALID", "DocumentMap requires at least one fragment");
  const fragments = [...input.fragments].sort((left, right) => compareText(left.fragment_id, right.fragment_id));
  const fragmentIds = fragments.map((fragment) => parseIdentifier(fragment.fragment_id, "fragment_id"));
  if (new Set(fragmentIds).size !== fragmentIds.length) {
    fail("NAVIGATION_INPUT_INVALID", "DocumentMap fragment_id values must be unique");
  }
  fragments.forEach((fragment) => {
    if (fragment.source_revision_ref !== source.source_revision_ref) {
      fail("NAVIGATION_SOURCE_MISMATCH", "DocumentMap fragment points to another source revision");
    }
  });
  const mappingRefs = uniqueSorted(fragments.flatMap((fragment) =>
    fragment.mappings_to_original_ref === undefined ? [] : [fragment.mappings_to_original_ref]));
  if (mappingRefs.length > 1) fail("NAVIGATION_ARTIFACT_INVALID", "DocumentMap fragments disagree on original mapping");
  const sectionHierarchy = mergeNavigationObjects(fragments, "section_hierarchy", source.source_revision_ref, true);
  const unresolved = mergeFragmentStrings(fragments, "unresolved_structure", false);
  if (source.quality_state === "degraded" && unresolved.length === 0) {
    unresolved.push("source parser quality is degraded");
  }
  const body = {
    source_revision_ref: source.source_revision_ref,
    source_content_sha256: source.content_sha256,
    section_hierarchy: sectionHierarchy,
    page_ranges: mergeNavigationObjects(fragments, "page_ranges", source.source_revision_ref, false),
    figures: mergeNavigationObjects(fragments, "figures", source.source_revision_ref, false),
    tables: mergeNavigationObjects(fragments, "tables", source.source_revision_ref, false),
    named_entities: mergeNavigationObjects(fragments, "named_entities", source.source_revision_ref, false),
    dates_and_versions: mergeNavigationObjects(fragments, "dates_and_versions", source.source_revision_ref, false),
    external_citations: mergeNavigationObjects(fragments, "external_citations", source.source_revision_ref, false),
    key_terms: mergeFragmentStrings(fragments, "key_terms", true),
    high_information_section_refs: mergeFragmentStrings(fragments, "high_information_section_refs", true),
    unresolved_structure: uniqueSorted(unresolved),
    ...(mappingRefs[0] === undefined ? {} : { mappings_to_original_ref: parseIdentifier(mappingRefs[0], "mappings_to_original_ref") }),
    generator_generation: generator,
    created_at: input.created_at,
  };
  const sectionRefs = new Set(sectionHierarchy.map((section) => parseIdentifier(section.section_ref, "section_ref")));
  if (body.high_information_section_refs.some((sectionRef) => !sectionRefs.has(sectionRef))) {
    fail("NAVIGATION_ARTIFACT_INVALID", "high-information section is absent from the merged hierarchy");
  }
  requireCanonicalSize(body);
  const digest = await sha256Hex(canonicalJson({ protocol: "eliotr.document-map.v1", ...body }));
  const { source_content_sha256: _sourceContentSha256, ...contractBody } = body;
  return parseDocumentMapArtifact(DocumentMapRevisionSchema.parse({
    map_ref: { id: `document-map-${digest.slice(0, 48)}`, revision: 1 },
    ...contractBody,
  }), source.source_revision_ref);
}

interface AtlasGroup {
  readonly kind: "TOPIC" | "SOURCE_FAMILY" | "VERSION" | "PERIOD";
  readonly label: string;
  readonly cards: readonly SourceCard[];
}

type AtlasNode = ProjectAtlasRevision["nodes"][number];

interface BuiltAtlasGroup {
  readonly root: AtlasNode;
  readonly nodes: readonly AtlasNode[];
}

const ATLAS_GROUP_KINDS: readonly AtlasGroup["kind"][] = [
  "TOPIC",
  "SOURCE_FAMILY",
  "VERSION",
  "PERIOD",
];

const ATLAS_GROUP_DIRECTORY_LABEL: Readonly<Record<AtlasGroup["kind"], string>> = {
  TOPIC: "Topic index",
  SOURCE_FAMILY: "Source-family index",
  VERSION: "Version index",
  PERIOD: "Period index",
};

function addGroup(map: Map<string, SourceCard[]>, key: string, card: SourceCard): void {
  const existing = map.get(key);
  if (existing === undefined) map.set(key, [card]);
  else existing.push(card);
}

function sortedCardRefs(cards: readonly SourceCard[]): VersionedRef[] {
  return [...cards]
    .sort((left, right) => compareText(left.source_revision_ref, right.source_revision_ref))
    .map((card) => card.card_ref);
}

async function atlasNodeId(kind: string, label: string): Promise<string> {
  const digest = await sha256Hex(`eliotr.atlas-node.v1\0${kind}\0${label}`);
  return `atlas-node-${digest.slice(0, 48)}`;
}

function partition<T>(values: readonly T[], size: number): T[][] {
  const output: T[][] = [];
  for (let offset = 0; offset < values.length; offset += size) {
    output.push(values.slice(offset, offset + size));
  }
  return output;
}

async function buildAtlasGroupNodes(
  group: AtlasGroup,
  centrality: ReadonlyMap<string, number>,
): Promise<BuiltAtlasGroup> {
  const cards = [...group.cards].sort((left, right) =>
    compareText(left.source_revision_ref, right.source_revision_ref));
  const sourceRefs = cards.map((card) => card.source_revision_ref);
  const centralitySum = sourceRefs.reduce(
    (sum, sourceRef) => sum + (centrality.get(sourceRef) ?? 0),
    0,
  );
  const rootId = await atlasNodeId(group.kind, group.label);
  const cardPartitions = partition(cards, MAX_NODE_REFERENCES);
  if (cardPartitions.length <= 1) {
    const root: AtlasNode = {
      node_id: rootId,
      label: group.label,
      kind: group.kind,
      source_card_refs: sortedCardRefs(cards),
      child_node_ids: [],
      annotations: {
        centrality_sum: centralitySum,
        navigation_authority: "NAVIGATION_ONLY",
        source_revision_refs: sourceRefs,
      },
    };
    return { root, nodes: [root] };
  }

  const leaves = await Promise.all(cardPartitions.map(async (partitionCards, index) => {
    const partitionRefs = partitionCards.map((card) => card.source_revision_ref);
    const partitionIdentity = canonicalJson(partitionCards.map((card) => card.card_ref));
    return {
      node_id: await atlasNodeId(
        group.kind,
        `${group.label}\0reference-partition\0${index + 1}\0${partitionIdentity}`,
      ),
      label: `${group.label} — partition ${index + 1}/${cardPartitions.length}`,
      kind: group.kind,
      source_card_refs: sortedCardRefs(partitionCards),
      child_node_ids: [],
      annotations: {
        atlas_role: "REFERENCE_PARTITION",
        centrality_sum: partitionRefs.reduce(
          (sum, sourceRef) => sum + (centrality.get(sourceRef) ?? 0),
          0,
        ),
        group_node_id: rootId,
        navigation_authority: "NAVIGATION_ONLY",
        partition_count: cardPartitions.length,
        partition_index: index + 1,
        source_revision_refs: partitionRefs,
      },
    } satisfies AtlasNode;
  }));
  const root: AtlasNode = {
    node_id: rootId,
    label: group.label,
    kind: group.kind,
    source_card_refs: [],
    child_node_ids: leaves.map((node) => node.node_id).sort(compareText),
    annotations: {
      atlas_role: "REFERENCE_DIRECTORY",
      centrality_sum: centralitySum,
      navigation_authority: "NAVIGATION_ONLY",
      partition_count: leaves.length,
      source_revision_count: sourceRefs.length,
      source_revision_refs: sourceRefs.slice(0, MAX_NODE_REFERENCES),
      source_revision_refs_truncated: sourceRefs.length > MAX_NODE_REFERENCES,
    },
  };
  return { root, nodes: [root, ...leaves] };
}

async function buildAtlasDirectoryNodes(groupRoots: readonly AtlasNode[]): Promise<AtlasNode[]> {
  const directories: AtlasNode[] = [];
  for (const kind of ATLAS_GROUP_KINDS) {
    const roots = groupRoots.filter((node) => node.kind === kind)
      .sort((left, right) => compareText(left.node_id, right.node_id));
    const rootPartitions = partition(roots, MAX_NODE_REFERENCES);
    for (let index = 0; index < rootPartitions.length; index += 1) {
      const rootsInPartition = rootPartitions[index] ?? [];
      const childNodeIds = rootsInPartition.map((node) => node.node_id).sort(compareText);
      const label = rootPartitions.length === 1
        ? ATLAS_GROUP_DIRECTORY_LABEL[kind]
        : `${ATLAS_GROUP_DIRECTORY_LABEL[kind]} ${index + 1}/${rootPartitions.length}`;
      directories.push({
        node_id: await atlasNodeId(
          kind,
          `group-directory\0${kind}\0${canonicalJson(childNodeIds)}`,
        ),
        label,
        kind,
        source_card_refs: [],
        child_node_ids: childNodeIds,
        annotations: {
          atlas_role: "GROUP_DIRECTORY",
          child_group_count: childNodeIds.length,
          group_kind: kind,
          navigation_authority: "NAVIGATION_ONLY",
          partition_count: rootPartitions.length,
          partition_index: index + 1,
        },
      });
    }
  }
  return directories;
}

export async function buildProjectAtlas(input: ProjectAtlasBuildInput): Promise<ProjectAtlasRevision> {
  const projectRef = VersionedRefSchema.parse(input.project_ref);
  const scope = parseNavigationScopeSnapshot(input.scope_snapshot);
  const generator = parseIdentifier(input.generator_generation, "generator_generation");
  boundedArray(scope.member_source_revision_refs, MAX_ATLAS_SOURCES, "atlas scope members");
  boundedArray(input.source_cards, MAX_ATLAS_SOURCES, "atlas source cards");
  boundedArray(input.document_maps, MAX_ATLAS_SOURCES, "atlas document maps");
  const scopeMembers = new Set(scope.member_source_revision_refs);
  const cards = input.source_cards.map((card) => parseSourceCardArtifact(card));
  const cardByRevision = new Map<string, SourceCard>();
  const cardRefKeys = new Set<string>();
  for (const card of cards) {
    if (!scopeMembers.has(card.source_revision_ref)) {
      fail("NAVIGATION_SCOPE_MISMATCH", "SourceCard is outside the frozen atlas scope");
    }
    if (cardByRevision.has(card.source_revision_ref) || cardRefKeys.has(versionedRefKey(card.card_ref))) {
      fail("NAVIGATION_ARTIFACT_INVALID", "atlas input repeats a SourceCard identity");
    }
    cardByRevision.set(card.source_revision_ref, card);
    cardRefKeys.add(versionedRefKey(card.card_ref));
  }
  const mapByRevision = new Map<string, DocumentMapRevision>();
  for (const mapValue of input.document_maps) {
    const map = parseDocumentMapArtifact(mapValue);
    if (!scopeMembers.has(map.source_revision_ref)) {
      fail("NAVIGATION_SCOPE_MISMATCH", "DocumentMap is outside the frozen atlas scope");
    }
    if (mapByRevision.has(map.source_revision_ref)) {
      fail("NAVIGATION_ARTIFACT_INVALID", "atlas input repeats a DocumentMap source revision");
    }
    mapByRevision.set(map.source_revision_ref, map);
  }
  const represented = [...cardByRevision.keys()]
    .filter((sourceRef) => mapByRevision.has(sourceRef))
    .sort(compareText);
  const representedCards = represented.map((sourceRef) => cardByRevision.get(sourceRef))
    .filter((card): card is SourceCard => card !== undefined);
  const representedSet = new Set(represented);
  const omitted = scope.member_source_revision_refs.filter((sourceRef) => !representedSet.has(sourceRef));

  const topicGroups = new Map<string, SourceCard[]>();
  const familyGroups = new Map<string, SourceCard[]>();
  const versionGroups = new Map<string, SourceCard[]>();
  const periodGroups = new Map<string, SourceCard[]>();
  for (const card of representedCards) {
    card.main_topics.forEach((topic) => addGroup(topicGroups, topic, card));
    addGroup(familyGroups, card.source_kind, card);
    card.controlled_vocabulary.filter((term) => VERSION_TOKEN.test(term))
      .forEach((version) => addGroup(versionGroups, version.toLowerCase(), card));
    const year = /^\d{4}/u.exec(card.date ?? "")?.[0];
    if (year !== undefined) addGroup(periodGroups, year, card);
  }
  const groups: AtlasGroup[] = [
    ...[...topicGroups.entries()].map(([label, groupCards]) => ({ kind: "TOPIC" as const, label, cards: groupCards })),
    ...[...familyGroups.entries()].map(([label, groupCards]) => ({ kind: "SOURCE_FAMILY" as const, label, cards: groupCards })),
    ...[...versionGroups.entries()].map(([label, groupCards]) => ({ kind: "VERSION" as const, label, cards: groupCards })),
    ...[...periodGroups.entries()].map(([label, groupCards]) => ({ kind: "PERIOD" as const, label, cards: groupCards })),
  ].sort((left, right) => compareText(`${left.kind}:${left.label}`, `${right.kind}:${right.label}`));
  if (groups.length > MAX_ATLAS_NODES - 3) fail("NAVIGATION_LIMIT_EXCEEDED", "atlas grouping exceeds its node ceiling");

  const centrality = new Map<string, number>(represented.map((sourceRef) => [sourceRef, 0] as const));
  for (const group of groups) {
    const increment = Math.max(1, group.cards.length - 1);
    group.cards.forEach((card) => centrality.set(
      card.source_revision_ref,
      (centrality.get(card.source_revision_ref) ?? 0) + increment,
    ));
  }
  const nodes: AtlasNode[] = [];
  const groupRoots: AtlasNode[] = [];
  for (const group of groups) {
    const built = await buildAtlasGroupNodes(group, centrality);
    nodes.push(...built.nodes);
    groupRoots.push(built.root);
  }
  const auxiliaryRootIds: string[] = [];

  const expectedClasses = parseStringArray(
    input.expected_source_classes ?? [],
    "expected_source_classes",
    MAX_CARD_TERMS,
    true,
  );
  const representedClasses = new Set(representedCards.map((card) => card.source_kind));
  const missingClasses = expectedClasses.filter((sourceClass) => !representedClasses.has(sourceClass));
  const underResearched = [
    ...missingClasses.map((sourceClass) => `missing source class: ${sourceClass}`),
    ...(omitted.length === 0 ? [] : [`navigation artifacts unavailable for ${omitted.length} frozen source revision(s)`]),
  ];
  if (underResearched.length > 0) {
    const gapNode: AtlasNode = {
      node_id: await atlasNodeId("GAP", canonicalJson(underResearched)),
      label: "Coverage gaps",
      kind: "GAP",
      source_card_refs: [],
      child_node_ids: [],
      annotations: {
        missing_source_classes: missingClasses,
        navigation_authority: "NAVIGATION_ONLY",
        omitted_source_revision_count: omitted.length,
        omitted_source_revision_refs: omitted.slice(0, MAX_NODE_REFERENCES),
        omissions_truncated: omitted.length > MAX_NODE_REFERENCES,
      },
    };
    nodes.push(gapNode);
    auxiliaryRootIds.push(gapNode.node_id);
  }

  const routeCards = [...representedCards].sort((left, right) => {
    const score = (centrality.get(right.source_revision_ref) ?? 0) - (centrality.get(left.source_revision_ref) ?? 0);
    return score !== 0 ? score : compareText(left.source_revision_ref, right.source_revision_ref);
  }).slice(0, Math.min(64, MAX_NODE_REFERENCES));
  const routeId = `reading-route-${(await sha256Hex(canonicalJson(routeCards.map((card) => card.source_revision_ref)))).slice(0, 48)}`;
  const recommendedRoutes: Readonly<Record<string, unknown>>[] = routeCards.length === 0 ? [] : [{
    label: "Central sources first",
    navigation_authority: "NAVIGATION_ONLY",
    rationale: "deterministic shared-topic and source-family centrality",
    route_id: routeId,
    source_card_refs: routeCards.map((card) => card.card_ref),
    source_revision_refs: routeCards.map((card) => card.source_revision_ref),
  }];
  if (routeCards.length > 0) {
    const routeNode: AtlasNode = {
      node_id: await atlasNodeId("READING_ROUTE", routeId),
      label: "Central sources first",
      kind: "READING_ROUTE",
      source_card_refs: routeCards.map((card) => card.card_ref),
      child_node_ids: [],
      annotations: {
        navigation_authority: "NAVIGATION_ONLY",
        route_id: routeId,
        source_revision_refs: routeCards.map((card) => card.source_revision_ref),
      },
    };
    nodes.push(routeNode);
    auxiliaryRootIds.push(routeNode.node_id);
  }

  let groupRootIds = groupRoots.map((node) => node.node_id).sort(compareText);
  if (groupRootIds.length + auxiliaryRootIds.length > MAX_NODE_REFERENCES) {
    const directories = await buildAtlasDirectoryNodes(groupRoots);
    nodes.push(...directories);
    groupRootIds = directories.map((node) => node.node_id).sort(compareText);
  }
  const childIds = [...groupRootIds, ...auxiliaryRootIds].sort(compareText);
  if (childIds.length > MAX_NODE_REFERENCES || nodes.length + 1 > MAX_ATLAS_NODES) {
    fail("NAVIGATION_LIMIT_EXCEEDED", "atlas hierarchy exceeds its bounded node fanout");
  }
  const rootId = await atlasNodeId("PROJECT", `${projectRef.id}@${projectRef.revision}`);
  nodes.unshift({
    node_id: rootId,
    label: `Project ${projectRef.id}`,
    kind: "PROJECT",
    source_card_refs: sortedCardRefs(representedCards).slice(0, MAX_NODE_REFERENCES),
    child_node_ids: childIds,
    annotations: {
      coverage_kind: omitted.length === 0 ? "sampled_with_method" : "unknown",
      navigation_authority: "NAVIGATION_ONLY",
      omitted_source_revision_count: omitted.length,
      omitted_source_revision_refs: omitted.slice(0, MAX_NODE_REFERENCES),
      omissions_truncated: omitted.length > MAX_NODE_REFERENCES,
      represented_source_revision_count: represented.length,
      represented_source_revision_refs: represented,
      root_source_card_refs_truncated: represented.length > MAX_NODE_REFERENCES,
      scope_member_count: scope.member_source_revision_refs.length,
    },
  });

  const degraded = uniqueSorted(represented.filter((sourceRef) => {
    const card = cardByRevision.get(sourceRef);
    const map = mapByRevision.get(sourceRef);
    return card?.quality_status === "degraded" || (map?.unresolved_structure.length ?? 0) > 0;
  }));
  const contradictionRefs = parseStringArray(
    input.contradiction_refs ?? [],
    "contradiction_refs",
    MAX_CARD_TERMS,
    true,
  );
  const draft = {
    project_ref: projectRef,
    scope_snapshot_ref: { id: scope.snapshot_id, revision: scope.revision },
    nodes,
    contradiction_refs: contradictionRefs,
    degraded_source_refs: degraded,
    under_researched_areas: uniqueSorted(underResearched),
    recommended_reading_routes: recommendedRoutes,
    generator_generation: generator,
    created_at: input.created_at,
  };
  requireCanonicalSize(draft);
  const identityDigest = await sha256Hex(canonicalJson({ protocol: "eliotr.project-atlas.identity.v1", ...draft }));
  const atlasRef = { id: `project-atlas-${identityDigest.slice(0, 48)}`, revision: 1 };
  const digest = await sha256Hex(canonicalJson({ protocol: "eliotr.project-atlas.v1", atlas_ref: atlasRef, ...draft }));
  return parseProjectAtlasArtifact(ProjectAtlasRevisionSchema.parse({ atlas_ref: atlasRef, ...draft, digest }));
}

