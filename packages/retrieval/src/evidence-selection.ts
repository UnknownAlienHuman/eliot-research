import type { LocatorCandidate } from "@eliotr/contracts";

/**
 * Research evidence preference over the already bounded fusion output. Give
 * each canonical source its first ranked locator before spending slots on extras.
 * Locators remain untrusted: every selected item still needs exact resolution.
 */
export function sourceDiverseEvidenceOrder(
  ranked: readonly LocatorCandidate[],
): readonly LocatorCandidate[] {
  const represented = new Set<string>();
  const first: LocatorCandidate[] = [];
  const extra: LocatorCandidate[] = [];
  for (const candidate of ranked) {
    if (represented.has(candidate.source_revision_ref)) extra.push(candidate);
    else {
      represented.add(candidate.source_revision_ref);
      first.push(candidate);
    }
  }
  return [...first, ...extra];
}
