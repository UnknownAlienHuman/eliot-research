import type { LocatorCandidate } from "@eliotr/contracts";

export interface FusedCandidate {
  readonly candidate: LocatorCandidate;
  readonly fused_score: number;
  readonly contributing_lanes: readonly string[];
}

export interface FusionOptions {
  readonly reciprocal_rank_constant: number;
  readonly lane_weights: Readonly<Partial<Record<LocatorCandidate["lane"], number>>>;
  readonly maxPerSourceRevision: number;
  /**
   * Q3 source-family diversity cap. Applied after the per-source cap in
   * fused-score order; candidates beyond the cap are dropped (the caller
   * reports them as visible omissions). Absent means no family cap and the
   * pre-Q3 behavior is unchanged.
   */
  readonly maxPerFamily?: number;
  /**
   * Family identity for diversity. Defaults to the free-form
   * `metadata.source_family` string when present, otherwise the source
   * revision ref (which degrades to the per-source cap, never to a
   * cross-family merge). No contract change: metadata stays free-form.
   */
  readonly familyOf?: (candidate: LocatorCandidate) => string;
}

function defaultFamilyOf(candidate: LocatorCandidate): string {
  const raw = candidate.metadata["source_family"];
  return typeof raw === "string" && raw.length > 0 ? raw : candidate.source_revision_ref;
}

export function reciprocalRankFuse(
  candidatesByLane: ReadonlyMap<LocatorCandidate["lane"], readonly LocatorCandidate[]>,
  options: FusionOptions,
): readonly FusedCandidate[] {
  const aggregate = new Map<string, { candidate: LocatorCandidate; score: number; lanes: Set<string> }>();
  for (const [lane, candidates] of candidatesByLane) {
    const weight = options.lane_weights[lane] ?? 1;
    for (const candidate of candidates) {
      const key = `${candidate.source_revision_ref}:${candidate.canonical_section_id}`;
      const current = aggregate.get(key) ?? { candidate, score: 0, lanes: new Set<string>() };
      current.score += weight / (options.reciprocal_rank_constant + candidate.rank);
      current.lanes.add(lane);
      aggregate.set(key, current);
    }
  }
  const perSource = new Map<string, number>();
  const perFamily = new Map<string, number>();
  const familyOf = options.familyOf ?? defaultFamilyOf;
  return [...aggregate.values()]
    .sort((left, right) => right.score - left.score || left.candidate.candidate_id.localeCompare(right.candidate.candidate_id))
    .filter((entry) => {
      const count = perSource.get(entry.candidate.source_revision_ref) ?? 0;
      if (count >= options.maxPerSourceRevision) return false;
      perSource.set(entry.candidate.source_revision_ref, count + 1);
      if (options.maxPerFamily !== undefined) {
        const family = familyOf(entry.candidate);
        const familyCount = perFamily.get(family) ?? 0;
        if (familyCount >= options.maxPerFamily) {
          perSource.set(entry.candidate.source_revision_ref, count);
          return false;
        }
        perFamily.set(family, familyCount + 1);
      }
      return true;
    })
    .map((entry) => ({
      candidate: entry.candidate,
      fused_score: entry.score,
      contributing_lanes: [...entry.lanes].sort(),
    }));
}
