/**
 * Studio/Wiki shared value types.
 *
 * Moved from `apps/eliotr-pwa/src/wiki-api.ts` and
 * `packages/pwa-research-workspace/src/wiki-proposal-create-api.ts`. `WikiProposalRiskClass` is declared
 * exactly once here, because both originals declared the same union and a second declaration would drift.
 *
 * Payload schemas come from `@eliotr/contracts` and are never re-declared.
 */

import type {
  ArtifactRevision,
  VersionedRef,
  WikiPageRevision,
} from '@eliotr/contracts';

export type WikiProposalRiskClass =
  | 'D0_MECHANICAL'
  | 'D1_LOW_RISK_ADDITIVE'
  | 'D2_ANALYTICAL'
  | 'D3_AUTHORITY_SENSITIVE';

export const MAX_WIKI_PROPOSALS = 20;
export const MAX_WIKI_BODY_BYTES = 8 * 1024 * 1024;
export const MAX_TITLE_CHARS = 512;
export const MAX_EDIT_NOTE_CHARS = 4_096;
export const MAX_WIKI_EDIT_REQUEST_BYTES = 8_650_752;
export const WIKI_EDIT_TIMEOUT_MS = 10 * 60 * 1000;
export const WIKI_PUBLICATION_TIMEOUT_MS = 10 * 60 * 1000;

export const WIKI_PROPOSAL_LIST_PROTOCOL = 'eliotr.wiki-proposals.v1' as const;
export const WIKI_PROPOSAL_READ_PROTOCOLS = [
  'eliotr.wiki-proposal-read.v1',
  'eliotr.wiki-proposal-read.v2',
] as const;
export const WIKI_PROPOSAL_PROTOCOL = 'eliotr.wiki-proposal.v1' as const;
export const WIKI_PUBLICATION_PROTOCOL = 'eliotr.wiki-publication.v1' as const;

export type WikiProposalState = 'PROPOSED' | 'PUBLISHED';
export type WikiSourceFreshnessState =
  | 'CURRENT_REVISIONS'
  | 'PREVIOUS_REVISIONS'
  | 'UNKNOWN';

export interface WikiProposalSummary {
  readonly proposal_ref: VersionedRef;
  readonly page_ref: VersionedRef;
  readonly title: string;
  readonly page_type: WikiPageRevision['page_type'];
  readonly risk_class: WikiProposalRiskClass;
  readonly state: WikiProposalState;
  readonly created_at: string;
}

export interface WikiProposalListView {
  readonly protocol: typeof WIKI_PROPOSAL_LIST_PROTOCOL;
  readonly items: readonly WikiProposalSummary[];
  readonly has_more: boolean;
  readonly deployment_generation: string;
}

export interface WikiSourceFreshnessChange {
  readonly source_id: string;
  readonly saved_revision_ref: string;
  readonly head_revision_ref: string;
}

export interface WikiSourceFreshness {
  readonly state: WikiSourceFreshnessState;
  readonly checked_at?: string;
  readonly changed_sources: readonly WikiSourceFreshnessChange[];
}

export interface WikiProposalReadView {
  readonly protocol: (typeof WIKI_PROPOSAL_READ_PROTOCOLS)[number];
  readonly proposal_ref: VersionedRef;
  readonly page: WikiPageRevision;
  readonly risk_class: WikiProposalRiskClass;
  readonly state: WikiProposalState;
  readonly source_freshness: WikiSourceFreshness;
  readonly deployment_generation: string;
}

export interface WikiProposalBodyView {
  readonly text: string;
  readonly body_sha256: string;
  readonly byte_length: number;
  readonly deployment_generation: string;
}

/** Create-from-run and create-from-edit decode into the same protocol shape. */
export interface WikiProposalFromRunView {
  readonly protocol: typeof WIKI_PROPOSAL_PROTOCOL;
  readonly proposal_ref: VersionedRef;
  readonly page_ref: VersionedRef;
  readonly risk_class: WikiProposalRiskClass;
  readonly state: 'PROPOSED';
  readonly deployment_generation: string;
}

export type WikiEditProposalView = WikiProposalFromRunView;

export interface WikiPublicationView {
  readonly protocol: typeof WIKI_PUBLICATION_PROTOCOL;
  readonly page_ref: VersionedRef;
  readonly status: 'PUBLISHED';
  readonly reviewer_ref: string;
  readonly deployment_generation: string;
}

export interface ArtifactPublicationView {
  readonly revision: ArtifactRevision;
  readonly receipt: {
    readonly publication_ref: string;
    readonly artifact_ref: VersionedRef;
    readonly publication_revision: number;
    readonly manifest_sha256: string;
    readonly verification_set_sha256: string;
    readonly evidence_currentness_sha256: string;
    readonly acceptance_decision_ref: string;
    readonly acceptance_provenance_ref: string;
    readonly acceptance_decision_sha256: string;
    readonly principal_ref: string;
    readonly authorization_receipt_ref: string;
    readonly created_at: string;
  };
}

export interface ArtifactSectionRevisionView {
  readonly operation_id: string;
  readonly attempt_ref: string;
  readonly state: 'STARTED' | 'OUTPUT_RECORDED' | 'COMMITTED' | 'UNKNOWN' | 'CANCELLED';
  readonly draft?: {
    readonly artifact_ref: VersionedRef;
    readonly manifest_sha256: string;
  };
}
