import type { LocatorCandidate, ProjectionItem } from "@eliotr/contracts";
import type { ManagedSearchPort, ProjectionSinkPort, RetrievalRequest } from "@eliotr/retrieval";
import type { AiSearchNamespaceLike } from "./bindings.js";

export interface AiSearchInstanceProfile {
  readonly id: string;
  readonly generation: string;
  readonly index_method: { readonly vector: boolean; readonly keyword: boolean };
  readonly fusion_method?: "rrf" | "max";
  readonly keyword_tokenizer?: "porter" | "trigram";
  readonly keyword_match_mode?: "and" | "or";
  readonly embedding_model?: string;
  readonly reranking: boolean;
  readonly max_num_results: number;
  readonly metadata_fields: readonly string[];
}

export interface AiSearchGenerationManifest {
  readonly namespace: string;
  readonly generation: string;
  readonly instances: readonly AiSearchInstanceProfile[];
  readonly active_head_expected_generation: string | null;
  readonly golden_set_result_ref?: string;
}

export interface AiSearchAdapter extends ManagedSearchPort, ProjectionSinkPort {
  readonly locator_only: true;
}

export interface AiSearchAdapterFactory {
  create(namespace: AiSearchNamespaceLike, manifest: AiSearchGenerationManifest): AiSearchAdapter;
}

export function projectionMetadata(item: ProjectionItem): Readonly<Record<string, string>> {
  return {
    source_revision_ref: item.source_revision_ref,
    canonical_section_id: item.canonical_section_id,
    projection_generation: item.projection_generation,
    instruction_taint: item.instruction_taint,
  };
}

export function mapAiSearchChunkToLocator(_request: RetrievalRequest, raw: unknown): LocatorCandidate {
  throw new Error(`ER-16 must implement strict AI Search response decoding; received ${typeof raw}`);
}
