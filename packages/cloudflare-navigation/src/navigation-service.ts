import {
  VersionedRefSchema,
  type DocumentMapRevision,
  type ProjectAtlasRevision,
  type ScopeSnapshot,
  type SourceCard,
  type VersionedRef,
} from "@eliotr/contracts";
import {
  MAX_FOCUS_TERMS,
  MAX_FOCUS_TERM_BYTES,
  MAX_OMISSION_SAMPLE,
  MAX_ORIENTATION_CANDIDATES,
  MAX_ORIENTATION_SOURCES,
  NavigationError,
  evidenceHandleCandidateSupport,
  extractNavigationSections,
  navigationOnlySupport,
  parseDocumentMapArtifact,
  parseEvidenceHandleCandidate,
  parseIdentifier,
  parseNavigationScopeSnapshot,
  parseProjectAtlasArtifact,
  parseSourceCardArtifact,
  sameVersionedRef,
  versionedRefKey,
  type NavigationCentrality,
  type NavigationExpansionRequest,
  type NavigationExpansionResult,
  type NavigationOmission,
  type NavigationOmissionReason,
  type NavigationService,
  type NavigationStore,
  type OrientationRequest,
  type OrientationResult,
} from "@eliotr/retrieval";

function fail(code: NavigationError["code"], message: string): never {
  throw new NavigationError(code, message);
}

function utf8Length(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function parseVersionedRef(value: unknown, label: string): VersionedRef {
  const parsed = VersionedRefSchema.safeParse(value);
  if (!parsed.success) fail("NAVIGATION_INPUT_INVALID", `${label} failed strict validation`);
  return parsed.data;
}

function normalizeFocusTerms(values: readonly string[]): string[] {
  if (!Array.isArray(values) || values.length > MAX_FOCUS_TERMS) {
    fail("NAVIGATION_LIMIT_EXCEEDED", "focus_terms exceeds its item ceiling");
  }
  const terms = values.map((value) => {
    if (
      typeof value !== "string" ||
      value !== value.trim() ||
      value.length === 0 ||
      utf8Length(value) > MAX_FOCUS_TERM_BYTES ||
      /[\u0000-\u001f\u007f]/u.test(value)
    ) {
      fail("NAVIGATION_INPUT_INVALID", "focus_terms contains an invalid term");
    }
    return value.toLocaleLowerCase("und");
  });
  return [...new Set(terms)].sort(compareText);
}

function normalizeSourceClasses(values: readonly string[] | undefined): string[] {
  if (values === undefined) return [];
  if (!Array.isArray(values) || values.length > MAX_FOCUS_TERMS) {
    fail("NAVIGATION_LIMIT_EXCEEDED", "expected_source_classes exceeds its item ceiling");
  }
  return [...new Set(values.map((value) => parseIdentifier(value, "expected source class")))].sort(compareText);
}

function maximumSources(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_ORIENTATION_SOURCES) {
    fail(
      "NAVIGATION_INPUT_INVALID",
      `maximum_sources must be an integer in [1, ${MAX_ORIENTATION_SOURCES}]`,
    );
  }
  return value;
}

function scopeRef(scope: ScopeSnapshot): VersionedRef {
  return { id: scope.snapshot_id, revision: scope.revision };
}

function sameScopeSnapshot(left: ScopeSnapshot, right: ScopeSnapshot): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

async function storeCall<T>(label: string, operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof NavigationError) throw error;
    fail("NAVIGATION_STORE_FAILED", `${label} failed`);
  }
}

async function requireCurrentScope(
  store: NavigationStore,
  value: unknown,
): Promise<ScopeSnapshot> {
  const requested = parseNavigationScopeSnapshot(value);
  let rawCurrent: unknown;
  try {
    rawCurrent = await store.requireCurrentScopeSnapshot(requested);
  } catch {
    fail("NAVIGATION_SCOPE_NOT_CURRENT", "ScopeSnapshot currentness could not be established");
  }
  const current = parseNavigationScopeSnapshot(rawCurrent);
  if (!sameScopeSnapshot(requested, current)) {
    fail("NAVIGATION_SCOPE_NOT_CURRENT", "ScopeSnapshot currentness readback drifted from the request");
  }
  return requested;
}

function requireScopeMember(scopeMembers: ReadonlySet<string>, sourceRevisionRef: string): void {
  if (!scopeMembers.has(sourceRevisionRef)) {
    fail("NAVIGATION_SCOPE_MISMATCH", "source revision is outside the frozen ScopeSnapshot");
  }
}

async function loadAtlas(
  store: NavigationStore,
  projectRef: VersionedRef,
  scope: ScopeSnapshot,
  required: boolean,
): Promise<ProjectAtlasRevision | undefined> {
  const raw = await storeCall("ProjectAtlas read", () => store.getProjectAtlas(projectRef));
  if (raw === null) {
    if (required) fail("NAVIGATION_ARTIFACT_NOT_FOUND", "ProjectAtlas is unavailable");
    return undefined;
  }
  const atlas = parseProjectAtlasArtifact(raw);
  if (!sameVersionedRef(atlas.project_ref, projectRef)) {
    fail("NAVIGATION_SOURCE_MISMATCH", "ProjectAtlas belongs to another project revision");
  }
  if (!sameVersionedRef(atlas.scope_snapshot_ref, scopeRef(scope))) {
    fail("NAVIGATION_SCOPE_MISMATCH", "ProjectAtlas belongs to another ScopeSnapshot");
  }
  return atlas;
}

function decodeCardsBySource(
  rawValues: readonly unknown[],
  requestedSources: ReadonlySet<string>,
  scopeMembers: ReadonlySet<string>,
): Map<string, SourceCard> {
  if (rawValues.length > requestedSources.size) {
    fail("NAVIGATION_ARTIFACT_INVALID", "SourceCard store returned more rows than requested");
  }
  const cards = new Map<string, SourceCard>();
  const cardRefs = new Set<string>();
  for (const raw of rawValues) {
    const card = parseSourceCardArtifact(raw);
    if (!requestedSources.has(card.source_revision_ref)) {
      fail("NAVIGATION_SOURCE_MISMATCH", "SourceCard store returned an unrequested source revision");
    }
    requireScopeMember(scopeMembers, card.source_revision_ref);
    if (cards.has(card.source_revision_ref) || cardRefs.has(versionedRefKey(card.card_ref))) {
      fail("NAVIGATION_ARTIFACT_INVALID", "SourceCard store returned a duplicate identity");
    }
    cards.set(card.source_revision_ref, card);
    cardRefs.add(versionedRefKey(card.card_ref));
  }
  return cards;
}

function decodeCardsByRef(
  rawValues: readonly unknown[],
  requestedRefs: ReadonlySet<string>,
  scopeMembers: ReadonlySet<string>,
): Map<string, SourceCard> {
  if (rawValues.length > requestedRefs.size) {
    fail("NAVIGATION_ARTIFACT_INVALID", "SourceCard reference store returned more rows than requested");
  }
  const cards = new Map<string, SourceCard>();
  const sourceRefs = new Set<string>();
  for (const raw of rawValues) {
    const card = parseSourceCardArtifact(raw);
    const key = versionedRefKey(card.card_ref);
    if (!requestedRefs.has(key)) {
      fail("NAVIGATION_SOURCE_MISMATCH", "SourceCard reference store returned an unrequested card");
    }
    requireScopeMember(scopeMembers, card.source_revision_ref);
    if (cards.has(key) || sourceRefs.has(card.source_revision_ref)) {
      fail("NAVIGATION_ARTIFACT_INVALID", "SourceCard reference store returned a duplicate identity");
    }
    cards.set(key, card);
    sourceRefs.add(card.source_revision_ref);
  }
  return cards;
}

function decodeDocumentMaps(
  rawValues: readonly unknown[],
  requestedSources: ReadonlySet<string>,
  scopeMembers: ReadonlySet<string>,
): Map<string, DocumentMapRevision> {
  if (rawValues.length > requestedSources.size) {
    fail("NAVIGATION_ARTIFACT_INVALID", "DocumentMap store returned more rows than requested");
  }
  const maps = new Map<string, DocumentMapRevision>();
  for (const raw of rawValues) {
    const map = parseDocumentMapArtifact(raw);
    if (!requestedSources.has(map.source_revision_ref)) {
      fail("NAVIGATION_SOURCE_MISMATCH", "DocumentMap store returned an unrequested source revision");
    }
    requireScopeMember(scopeMembers, map.source_revision_ref);
    if (maps.has(map.source_revision_ref)) {
      fail("NAVIGATION_ARTIFACT_INVALID", "DocumentMap store returned a duplicate source revision");
    }
    maps.set(map.source_revision_ref, map);
  }
  return maps;
}

function atlasCardCentrality(atlas: ProjectAtlasRevision | undefined): Map<string, number> {
  const scores = new Map<string, number>();
  for (const node of atlas?.nodes ?? []) {
    if (node.kind === "PROJECT" || node.kind === "GAP") continue;
    for (const cardRef of node.source_card_refs) {
      const key = versionedRefKey(cardRef);
      scores.set(key, (scores.get(key) ?? 0) + 1);
    }
  }
  return scores;
}

function nodeKindWeight(kind: ProjectAtlasRevision["nodes"][number]["kind"]): number {
  switch (kind) {
    case "READING_ROUTE": return 40;
    case "TOPIC": return 30;
    case "SOURCE_FAMILY": return 20;
    case "VERSION":
    case "PERIOD": return 15;
    case "PROJECT": return 5;
    case "GAP": return 0;
  }
}

function atlasCandidateRefs(
  atlas: ProjectAtlasRevision,
  focusTerms: readonly string[],
  limit: number,
): VersionedRef[] {
  const ranked = atlas.nodes.map((node) => {
    const text = `${node.kind} ${node.label}`.toLocaleLowerCase("und");
    const focusScore = focusTerms.reduce((score, term) => score + (text.includes(term) ? 100 : 0), 0);
    return { node, score: focusScore + nodeKindWeight(node.kind) };
  }).filter((entry) => focusTerms.length === 0 || entry.score >= 100)
    .sort((left, right) => right.score - left.score || compareText(left.node.node_id, right.node.node_id));
  const ordered = ranked.length > 0
    ? ranked
    : atlas.nodes.filter((node) => node.kind === "READING_ROUTE" || node.kind === "PROJECT")
      .map((node) => ({ node, score: nodeKindWeight(node.kind) }))
      .sort((left, right) => right.score - left.score || compareText(left.node.node_id, right.node.node_id));
  const output: VersionedRef[] = [];
  const seen = new Set<string>();
  for (const { node } of ordered) {
    for (const cardRef of node.source_card_refs) {
      const key = versionedRefKey(cardRef);
      if (seen.has(key)) continue;
      seen.add(key);
      output.push(cardRef);
      if (output.length === limit) return output;
    }
  }
  return output;
}

function cardFocusScore(card: SourceCard, focusTerms: readonly string[]): number {
  if (focusTerms.length === 0) return 0;
  const title = card.title.toLocaleLowerCase("und");
  const abstract = card.abstract.toLocaleLowerCase("und");
  const topics = new Set(card.main_topics.map((value) => value.toLocaleLowerCase("und")));
  const vocabulary = new Set(card.controlled_vocabulary.map((value) => value.toLocaleLowerCase("und")));
  const classifiers = `${card.source_kind} ${card.document_role}`.toLocaleLowerCase("und");
  return focusTerms.reduce((score, term) => {
    if (topics.has(term)) score += 80;
    if (vocabulary.has(term)) score += 60;
    if (title.includes(term)) score += 40;
    if (classifiers.includes(term)) score += 20;
    if (abstract.includes(term)) score += 10;
    return score;
  }, 0);
}

function validateAtlasRoutes(atlas: ProjectAtlasRevision, scopeMembers: ReadonlySet<string>): void {
  for (const route of atlas.recommended_reading_routes) {
    const refs = route.source_revision_refs;
    if (refs === undefined) continue;
    if (!Array.isArray(refs) || refs.some((value) => typeof value !== "string" || !scopeMembers.has(value))) {
      fail("NAVIGATION_SCOPE_MISMATCH", "ProjectAtlas reading route escapes its frozen scope");
    }
  }
}

function omissionReason(
  sourceRef: string,
  candidateRefs: ReadonlySet<string>,
  cards: ReadonlyMap<string, SourceCard>,
  maps: ReadonlyMap<string, DocumentMapRevision>,
): NavigationOmissionReason {
  if (!candidateRefs.has(sourceRef)) return "NOT_SELECTED_BY_BOUNDED_METHOD";
  if (!cards.has(sourceRef)) return "SOURCE_CARD_MISSING";
  if (!maps.has(sourceRef)) return "DOCUMENT_MAP_MISSING";
  return "SOURCE_LIMIT";
}

async function orient(store: NavigationStore, request: OrientationRequest): Promise<OrientationResult> {
  const scope = await requireCurrentScope(store, request.scope_snapshot);
  const limit = maximumSources(request.maximum_sources);
  const focusTerms = normalizeFocusTerms(request.focus_terms);
  const expectedClasses = normalizeSourceClasses(request.expected_source_classes);
  const projectRef = request.project_ref === undefined
    ? undefined
    : parseVersionedRef(request.project_ref, "project_ref");
  const atlas = projectRef === undefined ? undefined : await loadAtlas(store, projectRef, scope, false);
  const scopeMembers = new Set(scope.member_source_revision_refs);
  if (atlas !== undefined) validateAtlasRoutes(atlas, scopeMembers);

  const candidateLimit = Math.min(MAX_ORIENTATION_CANDIDATES, Math.max(limit * 4, limit));
  const candidateSources: string[] = [];
  const candidateSet = new Set<string>();
  const cards = new Map<string, SourceCard>();

  if (atlas !== undefined) {
    const cardRefs = atlasCandidateRefs(atlas, focusTerms, candidateLimit);
    const requestedCardRefs = new Set(cardRefs.map(versionedRefKey));
    const rawCards = await storeCall("SourceCard reference batch read", () => store.getSourceCardsByRefs(cardRefs));
    const byRef = decodeCardsByRef(rawCards, requestedCardRefs, scopeMembers);
    for (const cardRef of cardRefs) {
      const card = byRef.get(versionedRefKey(cardRef));
      if (card === undefined || candidateSet.has(card.source_revision_ref)) continue;
      candidateSet.add(card.source_revision_ref);
      candidateSources.push(card.source_revision_ref);
      cards.set(card.source_revision_ref, card);
    }
  }
  for (const sourceRef of scope.member_source_revision_refs) {
    if (candidateSources.length === candidateLimit) break;
    if (candidateSet.has(sourceRef)) continue;
    candidateSet.add(sourceRef);
    candidateSources.push(sourceRef);
  }

  const missingCardRequests = candidateSources.filter((sourceRef) => !cards.has(sourceRef));
  if (missingCardRequests.length > 0) {
    const requestedSources = new Set(missingCardRequests);
    const rawCards = await storeCall("SourceCard batch read", () => store.getSourceCards(missingCardRequests));
    const decoded = decodeCardsBySource(rawCards, requestedSources, scopeMembers);
    decoded.forEach((card, sourceRef) => cards.set(sourceRef, card));
  }

  const centralityByCard = atlasCardCentrality(atlas);
  const rankedCards = [...cards.values()].sort((left, right) => {
    const focusDifference = cardFocusScore(right, focusTerms) - cardFocusScore(left, focusTerms);
    if (focusDifference !== 0) return focusDifference;
    const centralityDifference =
      (centralityByCard.get(versionedRefKey(right.card_ref)) ?? 0) -
      (centralityByCard.get(versionedRefKey(left.card_ref)) ?? 0);
    return centralityDifference !== 0
      ? centralityDifference
      : compareText(left.source_revision_ref, right.source_revision_ref);
  });
  const mapRequests = rankedCards.map((card) => card.source_revision_ref);
  const maps = mapRequests.length === 0
    ? new Map<string, DocumentMapRevision>()
    : decodeDocumentMaps(
      await storeCall("DocumentMap batch read", () => store.getDocumentMaps(mapRequests)),
      new Set(mapRequests),
      scopeMembers,
    );

  const representedCards = rankedCards.filter((card) => maps.has(card.source_revision_ref)).slice(0, limit);
  const representedRefs = representedCards.map((card) => card.source_revision_ref);
  const representedSet = new Set(representedRefs);
  const representedMaps = representedRefs.map((sourceRef) => maps.get(sourceRef))
    .filter((map): map is DocumentMapRevision => map !== undefined);
  const omittedRefs = scope.member_source_revision_refs.filter((sourceRef) => !representedSet.has(sourceRef));
  const omissionSample: NavigationOmission[] = omittedRefs.slice(0, MAX_OMISSION_SAMPLE).map((sourceRef) => ({
    source_revision_ref: sourceRef,
    reason: omissionReason(sourceRef, candidateSet, cards, maps),
  }));

  const degraded = new Set(atlas?.degraded_source_refs.filter((sourceRef) => representedSet.has(sourceRef)) ?? []);
  representedCards.forEach((card) => {
    const map = maps.get(card.source_revision_ref);
    if (card.quality_status === "degraded" || (map?.unresolved_structure.length ?? 0) > 0) {
      degraded.add(card.source_revision_ref);
    }
  });
  const representedClasses = new Set(representedCards.map((card) => card.source_kind));
  const missingClasses = expectedClasses.filter((sourceClass) => !representedClasses.has(sourceClass));
  const centrality: NavigationCentrality[] = representedCards.map((card) => ({
    source_revision_ref: card.source_revision_ref,
    score: centralityByCard.get(versionedRefKey(card.card_ref)) ?? 0,
  }));
  const routes = atlas?.recommended_reading_routes.length
    ? atlas.recommended_reading_routes
    : representedRefs.length === 0 ? [] : [{
      label: "Selected sources in deterministic orientation order",
      navigation_authority: "NAVIGATION_ONLY",
      source_revision_refs: representedRefs,
    }];

  return {
    ...(atlas === undefined ? {} : { atlas }),
    source_cards: representedCards,
    document_maps: representedMaps,
    represented_source_revision_refs: representedRefs,
    omitted_source_revision_refs: omissionSample.map((item) => item.source_revision_ref),
    omitted_source_revision_count: omittedRefs.length,
    omissions_truncated: omittedRefs.length > omissionSample.length,
    omissions: omissionSample,
    coverage_kind: omittedRefs.length === 0 ? "sampled_with_method" : "unknown",
    coverage_method: atlas === undefined ? "frozen_scope_order" : "atlas_focus_then_frozen_scope_order",
    degraded_source_revision_refs: [...degraded].sort(compareText),
    missing_source_classes: missingClasses,
    contradiction_refs: atlas?.contradiction_refs ?? [],
    centrality,
    recommended_reading_routes: routes,
    navigation_authority: "NAVIGATION_ONLY",
  };
}

async function oneCardBySource(
  store: NavigationStore,
  scopeMembers: ReadonlySet<string>,
  sourceRevisionRef: string,
): Promise<SourceCard> {
  requireScopeMember(scopeMembers, sourceRevisionRef);
  const decoded = decodeCardsBySource(
    await storeCall("SourceCard read", () => store.getSourceCards([sourceRevisionRef])),
    new Set([sourceRevisionRef]),
    scopeMembers,
  );
  const card = decoded.get(sourceRevisionRef);
  if (card === undefined) fail("NAVIGATION_ARTIFACT_NOT_FOUND", "SourceCard is unavailable");
  return card;
}

async function oneDocumentMap(
  store: NavigationStore,
  scopeMembers: ReadonlySet<string>,
  sourceRevisionRef: string,
): Promise<DocumentMapRevision> {
  requireScopeMember(scopeMembers, sourceRevisionRef);
  const decoded = decodeDocumentMaps(
    await storeCall("DocumentMap read", () => store.getDocumentMaps([sourceRevisionRef])),
    new Set([sourceRevisionRef]),
    scopeMembers,
  );
  const map = decoded.get(sourceRevisionRef);
  if (map === undefined) fail("NAVIGATION_ARTIFACT_NOT_FOUND", "DocumentMap is unavailable");
  return map;
}

async function expand(
  store: NavigationStore,
  request: NavigationExpansionRequest,
): Promise<NavigationExpansionResult> {
  const scope = await requireCurrentScope(store, request.scope_snapshot);
  const members = new Set(scope.member_source_revision_refs);
  switch (request.kind) {
    case "ATLAS_NODE": {
      const projectRef = parseVersionedRef(request.project_ref, "project_ref");
      const nodeId = parseIdentifier(request.node_id, "node_id");
      const atlas = await loadAtlas(store, projectRef, scope, true);
      if (atlas === undefined) fail("NAVIGATION_ARTIFACT_NOT_FOUND", "ProjectAtlas is unavailable");
      const node = atlas.nodes.find((candidate) => candidate.node_id === nodeId);
      if (node === undefined) fail("NAVIGATION_NODE_NOT_FOUND", "ProjectAtlas node is unavailable");
      const cardRefs = node.source_card_refs;
      const decoded = decodeCardsByRef(
        await storeCall("SourceCard reference batch read", () => store.getSourceCardsByRefs(cardRefs)),
        new Set(cardRefs.map(versionedRefKey)),
        members,
      );
      const cards = cardRefs.map((cardRef) => {
        const card = decoded.get(versionedRefKey(cardRef));
        if (card === undefined) fail("NAVIGATION_ARTIFACT_NOT_FOUND", "ProjectAtlas SourceCard is unavailable");
        return card;
      });
      return {
        kind: "ATLAS_NODE",
        atlas_ref: atlas.atlas_ref,
        node,
        source_cards: cards,
        source_revision_refs: cards.map((card) => card.source_revision_ref),
        support: navigationOnlySupport("ATLAS_NODE_REQUIRES_EXACT_SECTION_EVIDENCE"),
      };
    }
    case "SOURCE_CARD": {
      const sourceRef = parseIdentifier(request.source_revision_ref, "source_revision_ref");
      const card = await oneCardBySource(store, members, sourceRef);
      const rawMaps = await storeCall("DocumentMap reference lookup", () => store.getDocumentMaps([sourceRef]));
      const maps = decodeDocumentMaps(rawMaps, new Set([sourceRef]), members);
      const map = maps.get(sourceRef);
      return {
        kind: "SOURCE_CARD",
        source_card: card,
        ...(map === undefined ? {} : { document_map_ref: map.map_ref }),
        support: navigationOnlySupport("SOURCE_CARD_REQUIRES_EXACT_SECTION_EVIDENCE"),
      };
    }
    case "DOCUMENT_MAP": {
      const sourceRef = parseIdentifier(request.source_revision_ref, "source_revision_ref");
      const [card, map] = await Promise.all([
        oneCardBySource(store, members, sourceRef),
        oneDocumentMap(store, members, sourceRef),
      ]);
      return {
        kind: "DOCUMENT_MAP",
        source_card: card,
        document_map: map,
        sections: extractNavigationSections(map),
        support: navigationOnlySupport("DOCUMENT_MAP_REQUIRES_EXACT_SECTION_EVIDENCE"),
      };
    }
    case "SECTION": {
      const sourceRef = parseIdentifier(request.source_revision_ref, "source_revision_ref");
      const sectionRef = parseIdentifier(request.section_ref, "section_ref");
      const map = await oneDocumentMap(store, members, sourceRef);
      const section = extractNavigationSections(map).find((candidate) => candidate.section_ref === sectionRef);
      if (section === undefined) fail("NAVIGATION_SECTION_NOT_FOUND", "DocumentMap section is unavailable");
      const handleRequest = {
        scope_snapshot_ref: scopeRef(scope),
        source_revision_ref: sourceRef,
        section_ref: sectionRef,
      };
      const rawHandle = await storeCall(
        "section EvidenceHandle lookup",
        () => store.getEvidenceHandleForSection(handleRequest),
      );
      if (rawHandle === null) {
        return {
          kind: "SECTION",
          document_map_ref: map.map_ref,
          section,
          support: navigationOnlySupport(),
        };
      }
      const handle = parseEvidenceHandleCandidate(rawHandle, handleRequest, section);
      return {
        kind: "SECTION",
        document_map_ref: map.map_ref,
        section,
        evidence_handle: handle,
        support: evidenceHandleCandidateSupport(handle),
      };
    }
  }
}

// IMPLEMENTED_NOT_LIVE: ER-31 persisted Corpus Lens requires production scope composition and live D1 receipts.
export function createNavigationService(store: NavigationStore): NavigationService {
  return {
    async orient(request) {
      const pinned = { ...request, scope_snapshot: parseNavigationScopeSnapshot(request.scope_snapshot) };
      const result = await orient(store, pinned);
      await requireCurrentScope(store, pinned.scope_snapshot);
      return result;
    },
    async expand(request) {
      const pinned = { ...request, scope_snapshot: parseNavigationScopeSnapshot(request.scope_snapshot) };
      const result = await expand(store, pinned);
      await requireCurrentScope(store, pinned.scope_snapshot);
      return result;
    },
  };
}
