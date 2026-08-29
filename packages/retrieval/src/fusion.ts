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
  return [...aggregate.values()]
    .sort((left, right) => right.score - left.score || left.candidate.candidate_id.localeCompare(right.candidate.candidate_id))
    .filter((entry) => {
      const count = perSource.get(entry.candidate.source_revision_ref) ?? 0;
      if (count >= options.maxPerSourceRevision) return false;
      perSource.set(entry.candidate.source_revision_ref, count + 1);
      return true;
    })
    .map((entry) => ({
      candidate: entry.candidate,
      fused_score: entry.score,
      contributing_lanes: [...entry.lanes].sort(),
    }));
}
