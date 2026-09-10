import type { D1NavigationStore } from "@eliotr/cloudflare-evidence";
import { buildDocumentMap, buildSourceCard } from "@eliotr/retrieval";
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
