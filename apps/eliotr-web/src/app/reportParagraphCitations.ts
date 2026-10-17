import type { CitationAuditClaim, CitedEvidence, ReauthorizedCitedEvidence, VersionedRef } from '@eliotr/owner-api-client';

const words = (value: string): string => value.replace(/\s+/gu, ' ').trim();
const sameRef = (left: VersionedRef, right: VersionedRef): boolean =>
  left.id === right.id && left.revision === right.revision;

/** Quote locators only: ambiguous or partial claim text stays in the unchanged evidence rail. */
export function reportParagraphCitationNumbers(
  paragraph: string,
  claims: readonly CitationAuditClaim[],
  cited: readonly (CitedEvidence | ReauthorizedCitedEvidence)[],
): readonly number[] {
  const plain = words(paragraph);
  if (plain.length === 0) return [];
  let matched: CitationAuditClaim | undefined;
  for (const claim of claims) {
    if (words(claim.claim_text) !== plain) continue;
    if (matched !== undefined) return [];
    matched = claim;
  }
  if (matched === undefined) return [];

  const numbers = new Set<number>();
  for (const ref of matched.support_handle_refs) {
    const index = cited.findIndex(row => sameRef('original_handle_ref' in row ? row.original_handle_ref : row.handle_ref, ref));
    if (index >= 0) numbers.add(index + 1);
  }
  return [...numbers].sort((left, right) => left - right);
}
