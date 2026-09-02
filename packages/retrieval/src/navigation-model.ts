import type {
  DocumentMapRevision,
  EvidenceHandle,
  ProjectAtlasRevision,
  ScopeSnapshot,
  SourceCard,
  SourceRevision,
  VersionedRef,
} from "@eliotr/contracts";

export type NavigationErrorCode =
  | "NAVIGATION_INPUT_INVALID"
  | "NAVIGATION_SOURCE_NOT_QUALIFIED"
  | "NAVIGATION_ARTIFACT_INVALID"
  | "NAVIGATION_SOURCE_MISMATCH"
  | "NAVIGATION_SCOPE_MISMATCH"
  | "NAVIGATION_LIMIT_EXCEEDED"
  | "NAVIGATION_SECTION_NOT_FOUND"
  | "NAVIGATION_PUBLICATION_SUPPORT_REQUIRED"
  | "NAVIGATION_SCOPE_NOT_CURRENT"
  | "NAVIGATION_ARTIFACT_NOT_FOUND"
  | "NAVIGATION_NODE_NOT_FOUND"
  | "NAVIGATION_STORE_FAILED";

export class NavigationError extends Error {
  public readonly code: NavigationErrorCode;

  public constructor(code: NavigationErrorCode, message: string) {
    super(message);
    this.name = "NavigationError";
    this.code = code;
  }
}

export interface NavigationStore {
  requireCurrentScopeSnapshot(scopeSnapshot: ScopeSnapshot): Promise<unknown>;
  getSourceCards(sourceRevisionRefs: readonly string[]): Promise<readonly unknown[]>;
  getSourceCardsByRefs(cardRefs: readonly VersionedRef[]): Promise<readonly unknown[]>;
  getDocumentMaps(sourceRevisionRefs: readonly string[]): Promise<readonly unknown[]>;
  getProjectAtlas(projectRef: VersionedRef): Promise<unknown | null>;
  getEvidenceHandleForSection(request: SectionEvidenceHandleRequest): Promise<unknown | null>;
}

export interface OrientationRequest {
  readonly scope_snapshot: ScopeSnapshot;
  readonly project_ref?: VersionedRef;
  readonly focus_terms: readonly string[];
  readonly expected_source_classes?: readonly string[];
  readonly maximum_sources: number;
}

export type NavigationOmissionReason =
  | "SOURCE_CARD_MISSING"
  | "DOCUMENT_MAP_MISSING"
  | "NOT_SELECTED_BY_BOUNDED_METHOD"
  | "SOURCE_LIMIT";

export interface NavigationOmission {
  readonly source_revision_ref: string;
  readonly reason: NavigationOmissionReason;
}

export interface NavigationCentrality {
  readonly source_revision_ref: string;
  readonly score: number;
}

export interface OrientationResult {
  readonly atlas?: ProjectAtlasRevision;
  readonly source_cards: readonly SourceCard[];
  readonly document_maps: readonly DocumentMapRevision[];
  readonly represented_source_revision_refs: readonly string[];
  /** Bounded sample. Use omitted_source_revision_count and omissions_truncated for complete accounting. */
  readonly omitted_source_revision_refs: readonly string[];
  readonly omitted_source_revision_count: number;
  readonly omissions_truncated: boolean;
  readonly omissions: readonly NavigationOmission[];
  readonly coverage_kind: "sampled_with_method" | "unknown";
  readonly coverage_method: "atlas_focus_then_frozen_scope_order" | "frozen_scope_order";
  readonly degraded_source_revision_refs: readonly string[];
  readonly missing_source_classes: readonly string[];
  readonly contradiction_refs: readonly string[];
  readonly centrality: readonly NavigationCentrality[];
  readonly recommended_reading_routes: readonly Readonly<Record<string, unknown>>[];
  readonly navigation_authority: "NAVIGATION_ONLY";
}

export interface NavigationOnlySupport {
  readonly kind: "NAVIGATION_ONLY";
  readonly publication_eligible: false;
  readonly reason_code: string;
}

export interface EvidenceHandleCandidateSupport {
  readonly kind: "EVIDENCE_HANDLE_CANDIDATE";
  readonly publication_eligible: false;
  readonly reason_code: "EXACT_EVIDENCE_RESOLUTION_REQUIRED";
  readonly handle_ref: VersionedRef;
}

export type NavigationSupport = NavigationOnlySupport | EvidenceHandleCandidateSupport;

export interface NavigationSection {
  readonly section_ref: string;
  readonly source_revision_ref: string;
  readonly label: string;
  readonly parent_section_ref?: string;
  readonly normalized_start_byte?: number;
  readonly normalized_end_byte?: number;
  readonly metadata: Readonly<Record<string, unknown>>;
}

export interface SectionEvidenceHandleRequest {
  readonly scope_snapshot_ref: VersionedRef;
  readonly source_revision_ref: string;
  readonly section_ref: string;
}

export type NavigationExpansionRequest =
  | {
    readonly kind: "ATLAS_NODE";
    readonly scope_snapshot: ScopeSnapshot;
    readonly project_ref: VersionedRef;
    readonly node_id: string;
  }
  | {
    readonly kind: "SOURCE_CARD";
    readonly scope_snapshot: ScopeSnapshot;
    readonly source_revision_ref: string;
  }
  | {
    readonly kind: "DOCUMENT_MAP";
    readonly scope_snapshot: ScopeSnapshot;
    readonly source_revision_ref: string;
  }
  | {
    readonly kind: "SECTION";
    readonly scope_snapshot: ScopeSnapshot;
    readonly source_revision_ref: string;
    readonly section_ref: string;
  };

export type NavigationExpansionResult =
  | {
    readonly kind: "ATLAS_NODE";
    readonly atlas_ref: VersionedRef;
    readonly node: ProjectAtlasRevision["nodes"][number];
    readonly source_cards: readonly SourceCard[];
    readonly source_revision_refs: readonly string[];
    readonly support: NavigationOnlySupport;
  }
  | {
    readonly kind: "SOURCE_CARD";
    readonly source_card: SourceCard;
    readonly document_map_ref?: VersionedRef;
    readonly support: NavigationOnlySupport;
  }
  | {
    readonly kind: "DOCUMENT_MAP";
    readonly source_card: SourceCard;
    readonly document_map: DocumentMapRevision;
    readonly sections: readonly NavigationSection[];
    readonly support: NavigationOnlySupport;
  }
  | {
    readonly kind: "SECTION";
    readonly document_map_ref: VersionedRef;
    readonly section: NavigationSection;
    readonly evidence_handle?: EvidenceHandle;
    readonly support: NavigationSupport;
  };

export interface NavigationService {
  orient(request: OrientationRequest): Promise<OrientationResult>;
  expand(request: NavigationExpansionRequest): Promise<NavigationExpansionResult>;
}

export interface SourceCardDraft {
  readonly title: string;
  readonly authors: readonly string[];
  readonly date?: string;
  readonly language: string;
  readonly source_kind: string;
  readonly document_role: string;
  readonly authority_hint: string;
  readonly abstract: string;
  readonly main_topics: readonly string[];
  readonly controlled_vocabulary: readonly string[];
  readonly outline: readonly Readonly<Record<string, unknown>>[];
  readonly important_section_refs: readonly string[];
  readonly likely_uses: readonly string[];
}

export interface SourceCardBuildInput {
  readonly source_revision: SourceRevision;
  readonly draft: SourceCardDraft;
  readonly generator_generation: string;
  readonly created_at: string;
}

export interface DocumentMapFragment {
  readonly fragment_id: string;
  readonly source_revision_ref: string;
  readonly section_hierarchy?: readonly Readonly<Record<string, unknown>>[];
  readonly page_ranges?: readonly Readonly<Record<string, unknown>>[];
  readonly figures?: readonly Readonly<Record<string, unknown>>[];
  readonly tables?: readonly Readonly<Record<string, unknown>>[];
  readonly named_entities?: readonly Readonly<Record<string, unknown>>[];
  readonly dates_and_versions?: readonly Readonly<Record<string, unknown>>[];
  readonly external_citations?: readonly Readonly<Record<string, unknown>>[];
  readonly key_terms?: readonly string[];
  readonly high_information_section_refs?: readonly string[];
  readonly unresolved_structure?: readonly string[];
  readonly mappings_to_original_ref?: string;
}

export interface DocumentMapBuildInput {
  readonly source_revision: SourceRevision;
  readonly fragments: readonly DocumentMapFragment[];
  readonly generator_generation: string;
  readonly created_at: string;
}

export interface ProjectAtlasBuildInput {
  readonly project_ref: VersionedRef;
  readonly scope_snapshot: ScopeSnapshot;
  readonly source_cards: readonly SourceCard[];
  readonly document_maps: readonly DocumentMapRevision[];
  readonly expected_source_classes?: readonly string[];
  readonly contradiction_refs?: readonly string[];
  readonly generator_generation: string;
  readonly created_at: string;
}
