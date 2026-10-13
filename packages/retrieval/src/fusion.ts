import type { LocatorCandidate } from "@eliotr/contracts";

export interface FusedCandidate {
  readonly candidate: LocatorCandidate;
  readonly fused_score: number;
  readonly contributing_lanes: readonly string[];
}

/** Conflicting locator authority is rejected before relevance can choose a representative. */
export class FusionIdentityConflictError extends Error {
  public constructor(
    public readonly source_revision_ref: string,
    public readonly canonical_section_id: string,
  ) {
    super("Ranked lists contain incompatible authoritative locator identities");
    this.name = "FusionIdentityConflictError";
  }
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
  readonly maxDiversityScanCandidates?: number;
  readonly onDroppedCandidate?: (
    candidate: LocatorCandidate,
    reason: "DUPLICATE_IDENTITY_IN_LIST" | "IDENTITY_DIGEST_CONFLICT" | "DIVERSITY_SCAN_LIMIT",
  ) => void;
}

function defaultFamilyOf(candidate: LocatorCandidate): string {
  const raw = candidate.metadata["source_family"];
  return typeof raw === "string" && raw.length > 0 ? raw : candidate.source_revision_ref;
}

function metadataKey(candidate: LocatorCandidate): string {
  return JSON.stringify(Object.keys(candidate.metadata).sort().map((key) => [key, candidate.metadata[key]]));
}

function compareRepresentatives(left: LocatorCandidate, right: LocatorCandidate): number {
  return left.rank - right.rank ||
    left.candidate_id.localeCompare(right.candidate_id) ||
    left.index_generation.localeCompare(right.index_generation) ||
    right.raw_score - left.raw_score ||
    left.preview.localeCompare(right.preview) ||
    metadataKey(left).localeCompare(metadataKey(right));
}

function requireCompatibleAuthority(candidates: readonly LocatorCandidate[]): void {
  const digests = new Set(candidates
    .map((candidate) => candidate.metadata["content_sha256"])
    .filter((digest): digest is string => typeof digest === "string"));
  const first = candidates[0];
  if (digests.size > 1 && first !== undefined) {
    throw new FusionIdentityConflictError(first.source_revision_ref, first.canonical_section_id);
  }
}

export function reciprocalRankFuse(
  candidatesByLane: ReadonlyMap<LocatorCandidate["lane"], readonly LocatorCandidate[]>,
  options: FusionOptions,
): readonly FusedCandidate[] {
  type Identity = {
    readonly key: string;
    readonly byLane: Map<LocatorCandidate["lane"], LocatorCandidate>;
  };
  const identities = new Map<string, Identity>();
  for (const [lane, candidates] of candidatesByLane) {
    const byIdentity = new Map<string, LocatorCandidate[]>();
    for (const candidate of candidates) {
      const key = JSON.stringify([candidate.source_revision_ref, candidate.canonical_section_id]);
      const rows = byIdentity.get(key) ?? [];
      rows.push(candidate);
      byIdentity.set(key, rows);
    }
    for (const [key, rows] of byIdentity) {
      requireCompatibleAuthority(rows);
      rows.sort(compareRepresentatives);
      const best = rows[0];
      if (best === undefined) continue;
      const identity = identities.get(key) ?? { key, byLane: new Map() };
      identity.byLane.set(lane, best);
      identities.set(key, identity);
      for (const duplicate of rows.slice(1)) {
        options.onDroppedCandidate?.(duplicate, "DUPLICATE_IDENTITY_IN_LIST");
      }
    }
  }
  const aggregate = new Map<string, {
    candidate: LocatorCandidate;
    score: number;
    representativeContribution: number;
    lanes: Set<string>;
  }>();
  for (const identity of identities.values()) {
    const entries = [...identity.byLane.entries()].sort(([left], [right]) => left.localeCompare(right));
    requireCompatibleAuthority(entries.map(([, candidate]) => candidate));
    for (const [lane, candidate] of entries) {
      const contribution = (options.lane_weights[lane] ?? 1) /
        (options.reciprocal_rank_constant + candidate.rank);
      const current = aggregate.get(identity.key) ?? {
        candidate,
        score: 0,
        representativeContribution: Number.NEGATIVE_INFINITY,
        lanes: new Set<string>(),
      };
      current.score += contribution;
      current.lanes.add(lane);
      if (
        contribution > current.representativeContribution ||
        (contribution === current.representativeContribution &&
          compareRepresentatives(candidate, current.candidate) < 0)
      ) {
        current.candidate = candidate;
        current.representativeContribution = contribution;
      }
      aggregate.set(identity.key, current);
    }
  }
  const perSource = new Map<string, number>();
  const perFamily = new Map<string, number>();
  const familyOf = options.familyOf ?? defaultFamilyOf;
  const ordered = [...aggregate.values()]
    .sort((left, right) =>
      right.score - left.score ||
      left.candidate.candidate_id.localeCompare(right.candidate.candidate_id) ||
      left.candidate.source_revision_ref.localeCompare(right.candidate.source_revision_ref) ||
      left.candidate.canonical_section_id.localeCompare(right.candidate.canonical_section_id) ||
      left.candidate.index_generation.localeCompare(right.candidate.index_generation),
    );
  const diversityScanLimit = options.maxDiversityScanCandidates ?? Number.MAX_SAFE_INTEGER;
  const selected: typeof ordered = [];
  let scanned = 0;
  for (const entry of ordered) {
    if (scanned >= diversityScanLimit) {
      options.onDroppedCandidate?.(entry.candidate, "DIVERSITY_SCAN_LIMIT");
      continue;
    }
    scanned += 1;
    const count = perSource.get(entry.candidate.source_revision_ref) ?? 0;
    if (count >= options.maxPerSourceRevision) continue;
    if (options.maxPerFamily !== undefined) {
      const family = familyOf(entry.candidate);
      const familyCount = perFamily.get(family) ?? 0;
      if (familyCount >= options.maxPerFamily) continue;
      perFamily.set(family, familyCount + 1);
    }
    perSource.set(entry.candidate.source_revision_ref, count + 1);
    selected.push(entry);
  }
  return selected.map((entry) => ({
    candidate: entry.candidate,
    fused_score: entry.score,
    contributing_lanes: [...entry.lanes].sort(),
  }));
}
