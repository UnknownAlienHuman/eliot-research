import type {
  DocumentMapRevision,
  EvidenceHandle,
  ProjectAtlasRevision,
  ScopeSnapshot,
  SourceCard,
  SourceRevision,
  VersionedRef,
} from "@eliotr/contracts";
import {
  buildDocumentMap,
  buildProjectAtlas,
  buildSourceCard,
  type NavigationStore,
} from "@eliotr/retrieval";
import { describe, expect, it } from "vitest";
import { createNavigationService } from "./navigation-service.js";

const NOW = "2026-09-02T12:00:00.000Z";
const LATER = "2026-09-03T12:00:00.000Z";
const A = "a".repeat(64);
const B = "b".repeat(64);

function sourceRevision(ref: string, quality: SourceRevision["quality_state"] = "standard"): SourceRevision {
  return {
    source_revision_ref: ref,
    source_id: `source-${ref}`,
    source_namespace_id: "namespace-1",
    source_owner_system_id: "owner-system-1",
    source_owner_generation: `owner-${ref}`,
    ownership_mode: "immutable_import",
    content_sha256: A,
    object_residency_key_digest: B,
    normalized_artifact_ref: `normalized/${ref}.json`,
    captured_at: NOW,
    parser_profile_generation: "parser-1",
    quality_state: quality,
    purge_state: "LIVE",
  };
}

function scope(memberRefs: readonly string[]): ScopeSnapshot {
  const members = [...memberRefs].sort();
  return {
    snapshot_id: "scope-snapshot-1",
    revision: 1,
    resolved_scope_expression: { kind: "PROJECT", project_id: "project-1" },
    participant_generations: { "participant-1": "generation-1" },
    member_source_revision_refs: members,
    source_owner_generations: Object.fromEntries(members.map((ref) => [ref, `owner-${ref}`])),
    policy_authority_ref: "policy-1",
    disclosure_closure_digest: A,
    purge_ledger_revision: 1,
    digest: B,
    created_at: NOW,
    expires_at: LATER,
  };
}

async function card(source: SourceRevision, title: string, sourceKind = "paper"): Promise<SourceCard> {
  return buildSourceCard({
    source_revision: source,
    draft: {
      title,
      authors: ["Ada"],
      date: "2026-09-02",
      language: "en",
      source_kind: sourceKind,
      document_role: "primary",
      authority_hint: "qualified",
      abstract: `${title} covers memory and retrieval.`,
      main_topics: title.toLowerCase().includes("memory") ? ["memory"] : ["general"],
      controlled_vocabulary: ["v1.2"],
      outline: [{ section_ref: "intro", label: "Introduction" }],
      important_section_refs: ["intro"],
      likely_uses: ["orientation"],
    },
    generator_generation: "navigation-g1",
    created_at: NOW,
  });
}

async function documentMap(source: SourceRevision): Promise<DocumentMapRevision> {
  return buildDocumentMap({
    source_revision: source,
    fragments: [{
      fragment_id: "fragment-1",
      source_revision_ref: source.source_revision_ref,
      section_hierarchy: [{
        section_ref: "intro",
        label: "Introduction",
        normalized_start_byte: 0,
        normalized_end_byte: 10,
      }],
      key_terms: ["memory"],
      high_information_section_refs: ["intro"],
    }],
    generator_generation: "navigation-g1",
    created_at: NOW,
  });
}

class MemoryNavigationStore implements NavigationStore {
  public current = true;
  public driftCurrentReadback = false;
  public scopeChecks = 0;
  public artifactReads = 0;
  public readonly cards = new Map<string, SourceCard>();
  public readonly maps = new Map<string, DocumentMapRevision>();
  public readonly atlases = new Map<string, ProjectAtlasRevision>();
  public readonly handles = new Map<string, EvidenceHandle>();

  public constructor(public readonly scopeSnapshot: ScopeSnapshot) {}

  public async requireCurrentScopeSnapshot(): Promise<unknown> {
    this.scopeChecks += 1;
    if (!this.current) throw new Error("stale scope");
    return this.driftCurrentReadback
      ? { ...structuredClone(this.scopeSnapshot), digest: A }
      : structuredClone(this.scopeSnapshot);
  }

  public async getSourceCards(sourceRevisionRefs: readonly string[]): Promise<readonly unknown[]> {
    this.artifactReads += 1;
    return sourceRevisionRefs.flatMap((ref) => {
      const value = this.cards.get(ref);
      return value === undefined ? [] : [structuredClone(value)];
    });
  }

  public async getSourceCardsByRefs(cardRefs: readonly VersionedRef[]): Promise<readonly unknown[]> {
    this.artifactReads += 1;
    const requested = new Set(cardRefs.map((ref) => `${ref.id}@${ref.revision}`));
    return [...this.cards.values()].filter((cardValue) =>
      requested.has(`${cardValue.card_ref.id}@${cardValue.card_ref.revision}`))
      .map((cardValue) => structuredClone(cardValue));
  }

  public async getDocumentMaps(sourceRevisionRefs: readonly string[]): Promise<readonly unknown[]> {
    this.artifactReads += 1;
    return sourceRevisionRefs.flatMap((ref) => {
      const value = this.maps.get(ref);
      return value === undefined ? [] : [structuredClone(value)];
    });
  }

  public async getProjectAtlas(projectRef: VersionedRef): Promise<unknown | null> {
    this.artifactReads += 1;
    return structuredClone(this.atlases.get(`${projectRef.id}@${projectRef.revision}`) ?? null);
  }

  public async getEvidenceHandleForSection(request: {
    readonly scope_snapshot_ref: VersionedRef;
    readonly source_revision_ref: string;
    readonly section_ref: string;
  }): Promise<unknown | null> {
    this.artifactReads += 1;
    return structuredClone(this.handles.get(
      `${request.scope_snapshot_ref.id}@${request.scope_snapshot_ref.revision}:` +
      `${request.source_revision_ref}:${request.section_ref}`,
    ) ?? null);
  }
}

async function populatedStore(): Promise<{
  readonly store: MemoryNavigationStore;
  readonly atlas: ProjectAtlasRevision;
  readonly cardA: SourceCard;
  readonly cardB: SourceCard;
  readonly cardC: SourceCard;
  readonly mapA: DocumentMapRevision;
  readonly mapB: DocumentMapRevision;
}> {
  const snapshot = scope(["revision-a", "revision-b", "revision-c", "revision-d"]);
  const store = new MemoryNavigationStore(snapshot);
  const sourceA = sourceRevision("revision-a");
  const sourceB = sourceRevision("revision-b", "degraded");
  const sourceC = sourceRevision("revision-c");
  const [cardA, cardB, cardC, mapA, mapB] = await Promise.all([
    card(sourceA, "General architecture"),
    card(sourceB, "Memory retrieval"),
    card(sourceC, "Peripheral source"),
    documentMap(sourceA),
    documentMap(sourceB),
  ]);
  [cardA, cardB, cardC].forEach((value) => store.cards.set(value.source_revision_ref, value));
  [mapA, mapB].forEach((value) => store.maps.set(value.source_revision_ref, value));
  const atlas = await buildProjectAtlas({
    project_ref: { id: "project-1", revision: 1 },
    scope_snapshot: snapshot,
    source_cards: [cardA, cardB],
    document_maps: [mapA, mapB],
    expected_source_classes: ["legal", "paper"],
    contradiction_refs: ["contradiction-1"],
    generator_generation: "navigation-g1",
    created_at: NOW,
  });
  store.atlases.set("project-1@1", atlas);
  return { store, atlas, cardA, cardB, cardC, mapA, mapB };
}

describe("ER-31 Corpus Lens navigation service", () => {
  it("orients through an Atlas while reporting every bounded omission honestly", async () => {
    const { store, cardB } = await populatedStore();
    const result = await createNavigationService(store).orient({
      scope_snapshot: store.scopeSnapshot,
      project_ref: { id: "project-1", revision: 1 },
      focus_terms: ["memory"],
      expected_source_classes: ["legal", "paper"],
      maximum_sources: 1,
    });

    expect(result.represented_source_revision_refs).toEqual([cardB.source_revision_ref]);
    expect(result.coverage_kind).toBe("unknown");
    expect(result.coverage_method).toBe("atlas_focus_then_frozen_scope_order");
    expect(result.omitted_source_revision_count).toBe(3);
    expect(result.omissions).toEqual([
      { source_revision_ref: "revision-a", reason: "SOURCE_LIMIT" },
      { source_revision_ref: "revision-c", reason: "DOCUMENT_MAP_MISSING" },
      { source_revision_ref: "revision-d", reason: "SOURCE_CARD_MISSING" },
    ]);
    expect(result.degraded_source_revision_refs).toEqual(["revision-b"]);
    expect(result.missing_source_classes).toEqual(["legal"]);
    expect(result.contradiction_refs).toEqual(["contradiction-1"]);
    expect(result.navigation_authority).toBe("NAVIGATION_ONLY");
    expect(JSON.stringify(result)).not.toMatch(/all_sources_covered|publication_eligible/u);
  });

  it("fails before any artifact read when ScopeSnapshot currentness is stale or drifts", async () => {
    const stale = await populatedStore();
    stale.store.current = false;
    await expect(createNavigationService(stale.store).orient({
      scope_snapshot: stale.store.scopeSnapshot,
      focus_terms: [],
      maximum_sources: 1,
    })).rejects.toMatchObject({ code: "NAVIGATION_SCOPE_NOT_CURRENT" });
    expect(stale.store.artifactReads).toBe(0);

    const drift = await populatedStore();
    drift.store.driftCurrentReadback = true;
    await expect(createNavigationService(drift.store).orient({
      scope_snapshot: drift.store.scopeSnapshot,
      focus_terms: [],
      maximum_sources: 1,
    })).rejects.toMatchObject({ code: "NAVIGATION_SCOPE_NOT_CURRENT" });
    expect(drift.store.artifactReads).toBe(0);
  });

  it("expands Atlas to card, map, section and only an unresolved EvidenceHandle candidate", async () => {
    const { store, atlas, cardB } = await populatedStore();
    const service = createNavigationService(store);
    const topicNode = atlas.nodes.find((node) =>
      node.kind === "TOPIC" && node.source_card_refs.some((ref) => ref.id === cardB.card_ref.id));
    expect(topicNode).toBeDefined();
    if (topicNode === undefined) throw new Error("missing topic node");

    const atlasResult = await service.expand({
      kind: "ATLAS_NODE",
      scope_snapshot: store.scopeSnapshot,
      project_ref: { id: "project-1", revision: 1 },
      node_id: topicNode.node_id,
    });
    expect(atlasResult.kind).toBe("ATLAS_NODE");
    expect(atlasResult.support.publication_eligible).toBe(false);

    const cardResult = await service.expand({
      kind: "SOURCE_CARD",
      scope_snapshot: store.scopeSnapshot,
      source_revision_ref: "revision-b",
    });
    expect(cardResult.kind).toBe("SOURCE_CARD");
    if (cardResult.kind !== "SOURCE_CARD") throw new Error("unexpected expansion kind");
    expect(cardResult.document_map_ref).toBeDefined();

    const mapResult = await service.expand({
      kind: "DOCUMENT_MAP",
      scope_snapshot: store.scopeSnapshot,
      source_revision_ref: "revision-b",
    });
    expect(mapResult.kind).toBe("DOCUMENT_MAP");
    if (mapResult.kind !== "DOCUMENT_MAP") throw new Error("unexpected expansion kind");
    const intro = mapResult.sections.find((section) => section.section_ref === "intro");
    expect(intro).toBeDefined();
    if (intro === undefined) throw new Error("missing intro section");

    const handle: EvidenceHandle = {
      handle_ref: { id: "evidence-1", revision: 1 },
      source_namespace_id: "namespace-1",
      source_owner_generation: "owner-revision-b",
      source_revision_ref: "revision-b",
      scope_snapshot_ref: { id: "scope-snapshot-1", revision: 1 },
      anchor: { kind: "normalized_byte_range", start: 0, end: 10 },
      excerpt_sha256: A,
      excerpt_byte_length: 10,
      object_residency_key_digest: B,
      source_assurance_ceiling: "EXACT",
      materializer_assurance_ceiling: "EXACT",
      terminal_state: "LIVE",
      created_at: NOW,
    };
    store.handles.set("scope-snapshot-1@1:revision-b:intro", handle);
    const sectionResult = await service.expand({
      kind: "SECTION",
      scope_snapshot: store.scopeSnapshot,
      source_revision_ref: "revision-b",
      section_ref: "intro",
    });
    expect(sectionResult.kind).toBe("SECTION");
    if (sectionResult.kind !== "SECTION") throw new Error("unexpected expansion kind");
    expect(sectionResult.evidence_handle).toEqual(handle);
    expect(sectionResult.support).toMatchObject({
      kind: "EVIDENCE_HANDLE_CANDIDATE",
      publication_eligible: false,
      reason_code: "EXACT_EVIDENCE_RESOLUTION_REQUIRED",
    });
  });

  it("rejects a section handle bound to another scope and a store row outside the request", async () => {
    const { store } = await populatedStore();
    store.handles.set("scope-snapshot-1@1:revision-a:intro", {
      handle_ref: { id: "evidence-wrong-scope", revision: 1 },
      source_namespace_id: "namespace-1",
      source_owner_generation: "owner-revision-a",
      source_revision_ref: "revision-a",
      scope_snapshot_ref: { id: "other-scope", revision: 1 },
      anchor: { kind: "normalized_byte_range", start: 0, end: 10 },
      excerpt_sha256: A,
      excerpt_byte_length: 10,
      object_residency_key_digest: B,
      source_assurance_ceiling: "EXACT",
      materializer_assurance_ceiling: "EXACT",
      terminal_state: "LIVE",
      created_at: NOW,
    });
    await expect(createNavigationService(store).expand({
      kind: "SECTION",
      scope_snapshot: store.scopeSnapshot,
      source_revision_ref: "revision-a",
      section_ref: "intro",
    })).rejects.toMatchObject({ code: "NAVIGATION_SOURCE_MISMATCH" });

    const outsideCard = await card(sourceRevision("revision-z"), "Outside frozen request");
    store.getSourceCards = async () => [structuredClone(outsideCard)];
    await expect(createNavigationService(store).orient({
      scope_snapshot: store.scopeSnapshot,
      focus_terms: [],
      maximum_sources: 4,
    })).rejects.toMatchObject({ code: "NAVIGATION_SOURCE_MISMATCH" });
  });
});
