import type { DocumentMapRevision, ProjectAtlasRevision, ScopeSnapshot, SourceCard, VersionedRef } from "@eliotr/contracts";

export interface NavigationStore {
  getSourceCard(sourceRevisionRef: string): Promise<SourceCard | null>;
  getDocumentMap(sourceRevisionRef: string): Promise<DocumentMapRevision | null>;
  getProjectAtlas(projectRef: VersionedRef): Promise<ProjectAtlasRevision | null>;
}

export interface OrientationRequest {
  readonly scope_snapshot: ScopeSnapshot;
  readonly project_ref?: VersionedRef;
  readonly focus_terms: readonly string[];
  readonly maximum_sources: number;
}

export interface OrientationResult {
  readonly atlas?: ProjectAtlasRevision;
  readonly source_cards: readonly SourceCard[];
  readonly document_maps: readonly DocumentMapRevision[];
  readonly represented_source_revision_refs: readonly string[];
  readonly omitted_source_revision_refs: readonly string[];
  readonly coverage_kind: "sampled_with_method" | "unknown";
}

export interface NavigationService {
  orient(request: OrientationRequest): Promise<OrientationResult>;
}
