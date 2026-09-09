import {
  readAdmittedNormalizedManifest,
  readAdmittedNormalizedMarkdown,
  type D1NavigationStore,
} from "@eliotr/cloudflare-evidence";
import {
  buildDocumentMap,
  buildSourceCard,
  materializeStructuralNavigation as deriveStructuralNavigation,
  NavigationError,
} from "@eliotr/retrieval";
import type { ScopeSnapshot } from "@eliotr/contracts";
import type { OrientationSource } from "./orientation-authority.js";
import { ORIENTATION_PROFILE } from "./orientation-input.js";

/** This fallback asserts only admitted metadata. It does not invent summaries or structural coordinates. */
export async function materializeMetadataNavigation(store: D1NavigationStore, snapshot: ScopeSnapshot,
  sources: readonly OrientationSource[]): Promise<void> {
  const refs = sources.map((source) => source.revision.source_revision_ref);
  const existingCards = await store.getSourceCards(refs);
  const existingMaps = await store.getDocumentMaps(refs);
  const cardSources = new Set(existingCards.map((card) => (card as { source_revision_ref: string }).source_revision_ref));
  const mapSources = new Set(existingMaps.map((map) => (map as { source_revision_ref: string }).source_revision_ref));
  const batch: Parameters<D1NavigationStore["putArtifacts"]>[0][number][] = [];
  for (const source of sources) {
    if (!cardSources.has(source.revision.source_revision_ref)) {
      batch.push({ kind: "SOURCE_CARD", artifact: await buildSourceCard({ source_revision: source.revision,
        generator_generation: ORIENTATION_PROFILE, created_at: snapshot.created_at,
        draft: { title: source.title, authors: [], language: "und", source_kind: source.authority.source_class,
          document_role: "unclassified", authority_hint: "metadata_only", abstract: "", main_topics: [],
          controlled_vocabulary: [], outline: [], important_section_refs: [], likely_uses: ["source_selection"] } }) });
    }
    if (!mapSources.has(source.revision.source_revision_ref)) {
      batch.push({ kind: "DOCUMENT_MAP", artifact: await buildDocumentMap({ source_revision: source.revision,
        generator_generation: ORIENTATION_PROFILE, created_at: snapshot.created_at,
        fragments: [{ fragment_id: "metadata-only", source_revision_ref: source.revision.source_revision_ref,
          unresolved_structure: ["STRUCTURE_NOT_MATERIALIZED", "METADATA_ONLY_NO_SOURCE_SPANS"] }] }) });
    }
  }
  for (let start = 0; start < batch.length; start += 64) await store.putArtifacts(batch.slice(start, start + 64));
}

export interface StructuralNavigationMaterializationDependencies {
  readonly evidence_bucket: R2Bucket;
  readonly generator_generation?: string;
}

export interface StructuralNavigationMaterializationResult {
  readonly source_revision_ref: string;
  readonly section_count: number;
  readonly replay_safe: true;
}

/** Materialize structural maps from one admitted source at a time under the existing D1 scope fence. */
export async function materializeStructuralNavigation(
  store: D1NavigationStore,
  snapshot: ScopeSnapshot,
  sources: readonly OrientationSource[],
  dependencies: StructuralNavigationMaterializationDependencies,
): Promise<readonly StructuralNavigationMaterializationResult[]> {
  if (sources.length > 4096 || new Set(sources.map((source) => source.revision.source_revision_ref)).size !== sources.length) {
    throw new NavigationError("NAVIGATION_LIMIT_EXCEEDED", "structural navigation source set exceeds its bounded identity limit");
  }
  const generator = dependencies.generator_generation ?? "structural-navigation-v1";
  const results: StructuralNavigationMaterializationResult[] = [];
  for (const source of sources) {
    await store.requireCurrentScopeSnapshot(snapshot);
    const manifest = await readAdmittedNormalizedManifest(dependencies.evidence_bucket, source.authority);
    const content = await readAdmittedNormalizedMarkdown(dependencies.evidence_bucket, source.authority);
    if (manifest.content_size !== content.size_bytes) {
      throw new NavigationError("NAVIGATION_SOURCE_MISMATCH", "admitted normalized manifest and content sizes disagree");
    }
    const derived = await deriveStructuralNavigation({
      source_revision: source.revision,
      scope_snapshot: snapshot,
      normalized_markdown: content.markdown,
      source_kind: source.kind,
      generator_generation: generator,
      created_at: snapshot.created_at,
    });
    await store.putArtifacts([
      { kind: "SOURCE_CARD", artifact: derived.sourceCard },
      { kind: "DOCUMENT_MAP", artifact: derived.documentMap },
    ]);
    await store.requireCurrentScopeSnapshot(snapshot);
    results.push({ source_revision_ref: source.revision.source_revision_ref, section_count: derived.section_count, replay_safe: true });
  }
  return results;
}
