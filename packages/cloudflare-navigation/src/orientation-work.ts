import type { NavigationService, OrientationRequest, OrientationResult } from "@eliotr/retrieval";

/** Private phase accounting, never an ORIENT response or evidence/absence claim. */
export interface OrientationWorkReceipt {
  readonly protocol: "eliotr.orientation.work.v1";
  readonly frozen_members: number;
  readonly preview_candidates_examined: number;
  readonly provider_candidates_returned: 0;
  readonly metadata_candidates_ranked: number;
  readonly diversity_candidates_examined: 0;
  readonly exact_resolution_attempts: 0;
  readonly resolved_evidence: 0;
  readonly represented_sources: number;
  /** SourceCard does not carry source-family identity. */
  readonly represented_source_families: null;
  readonly family_measurement: "NOT_MEASURED";
  readonly omitted_count: number;
  readonly omitted_sample: readonly string[];
}

export interface OrientationWithWork {
  readonly navigation: OrientationResult;
  readonly work: OrientationWorkReceipt;
}

export type NavigationServiceWithWork = NavigationService & {
  orientWithWork(request: OrientationRequest): Promise<OrientationWithWork>;
};

export function orientationWorkReceipt(
  frozenMembers: number,
  candidateSources: readonly string[],
  rankedCandidates: number,
  navigation: OrientationResult,
): OrientationWorkReceipt {
  return Object.freeze({
    protocol: "eliotr.orientation.work.v1",
    frozen_members: frozenMembers,
    preview_candidates_examined: candidateSources.length,
    provider_candidates_returned: 0,
    metadata_candidates_ranked: rankedCandidates,
    diversity_candidates_examined: 0,
    exact_resolution_attempts: 0,
    resolved_evidence: 0,
    represented_sources: navigation.represented_source_revision_refs.length,
    represented_source_families: null,
    family_measurement: "NOT_MEASURED",
    omitted_count: navigation.omitted_source_revision_count,
    omitted_sample: Object.freeze([...navigation.omitted_source_revision_refs]),
  });
}
