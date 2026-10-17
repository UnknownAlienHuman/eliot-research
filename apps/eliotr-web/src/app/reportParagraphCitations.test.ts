import { describe, expect, it } from 'vitest';
import type { CitationAuditClaim, CitedEvidence, ReauthorizedCitedEvidence, VersionedRef } from '@eliotr/owner-api-client';
import { reportParagraphCitationNumbers } from './reportParagraphCitations';

const ref = (id: string, revision = 1): VersionedRef => ({ id, revision });
const positiveRef = ref('positive'), negativeRef = ref('negative');
const cited: readonly CitedEvidence[] = [
  { handle_ref: negativeRef, excerpt_sha256: 'b'.repeat(64) },
  { handle_ref: positiveRef, excerpt_sha256: 'a'.repeat(64) },
];
const claim = (id: string, text: string, support: readonly VersionedRef[],
  disposition: CitationAuditClaim['disposition'] = 'SUPPORTED'): CitationAuditClaim => ({
  claim_ref: ref(id), claim_text: text, claim_text_digest: 'c'.repeat(64), disposition,
  support_handle_refs: support, counterevidence_handle_refs: [],
});
const positive = claim('claim-positive', 'X improves Y.', [positiveRef]);
const negative = claim('claim-negative', 'It is false that X improves Y.', [negativeRef], 'CONTRADICTED');

describe('exact report paragraph citations', () => {
  it('keeps positive and negated paragraphs bound to their own audited sources', () => {
    const claims = [positive, negative];
    expect(reportParagraphCitationNumbers(positive.claim_text, claims, cited)).toEqual([2]);
    expect(reportParagraphCitationNumbers(negative.claim_text, claims, cited)).toEqual([1]);
    expect(reportParagraphCitationNumbers(negative.claim_text, [positive], cited)).toEqual([]);
  });

  it('normalizes whitespace without accepting extra assertions or stripped negation', () => {
    expect(reportParagraphCitationNumbers(' \tX  improves\nY.\r\n', [positive], cited)).toEqual([2]);
    expect(reportParagraphCitationNumbers('X improves Y. The trial was small.', [positive], cited)).toEqual([]);
    expect(reportParagraphCitationNumbers('X improves Y.', [negative], cited)).toEqual([]);
    expect(reportParagraphCitationNumbers('x improves Y.', [positive], cited)).toEqual([]);
    expect(reportParagraphCitationNumbers('X improves Y?', [positive], cited)).toEqual([]);
  });

  it.each(['X improves Y.', ' X\timproves\nY. '])('omits badges for ambiguous normalized claims: %s', text => {
    const ambiguous = claim('claim-other', text, [negativeRef], 'UNSUPPORTED');
    expect(reportParagraphCitationNumbers(positive.claim_text, [positive, ambiguous], cited)).toEqual([]);
    expect(reportParagraphCitationNumbers(positive.claim_text, [ambiguous, positive], cited)).toEqual([]);
  });

  it('matches historical audit refs to the original refs of authorized citations', () => {
    const authorized: readonly ReauthorizedCitedEvidence[] = [
      { original_handle_ref: positiveRef, handle_ref: ref('current-positive'), excerpt_sha256: 'a'.repeat(64) },
      { original_handle_ref: negativeRef, handle_ref: positiveRef, excerpt_sha256: 'b'.repeat(64) },
    ];
    expect(reportParagraphCitationNumbers(positive.claim_text, [positive], authorized)).toEqual([1]);
    expect(reportParagraphCitationNumbers(negative.claim_text, [negative], authorized)).toEqual([2]);
    const wrongRevision = claim('claim-wrong-revision', positive.claim_text, [ref(positiveRef.id, 2)]);
    expect(reportParagraphCitationNumbers(positive.claim_text, [wrongRevision], authorized)).toEqual([]);
  });

  it.each<CitationAuditClaim['disposition']>([
    'SUPPORTED', 'PARTIALLY_SUPPORTED', 'UNSUPPORTED', 'CONTRADICTED', 'NOT_VERIFIABLE_IN_SCOPE',
  ])('preserves the full %s audit and content while selecting quote locators', disposition => {
    const audited = claim('claim-audited', negative.claim_text, [negativeRef], disposition);
    const before = JSON.stringify({ audited, cited });
    expect(reportParagraphCitationNumbers(audited.claim_text, [audited], cited)).toEqual([1]);
    expect(JSON.stringify({ audited, cited })).toBe(before);
  });

  it('retains citation order, removes duplicate numbers, and invents no missing locator', () => {
    const audited = claim('claim-many', positive.claim_text, [positiveRef, negativeRef, positiveRef, ref('missing')]);
    expect(reportParagraphCitationNumbers(audited.claim_text, [audited], cited)).toEqual([1, 2]);
    expect(reportParagraphCitationNumbers(audited.claim_text, [audited], [])).toEqual([]);
  });

  it('leaves empty, unmatched, and counterevidence-only paragraphs without support badges', () => {
    expect(reportParagraphCitationNumbers(' \n\t', [claim('claim-blank', ' ', [positiveRef])], cited)).toEqual([]);
    expect(reportParagraphCitationNumbers('An unmatched claim.', [positive], cited)).toEqual([]);
    expect(reportParagraphCitationNumbers(positive.claim_text, [], cited)).toEqual([]);
    expect(reportParagraphCitationNumbers(positive.claim_text,
      [{ ...positive, support_handle_refs: [], counterevidence_handle_refs: [negativeRef] }], cited)).toEqual([]);
  });
});
