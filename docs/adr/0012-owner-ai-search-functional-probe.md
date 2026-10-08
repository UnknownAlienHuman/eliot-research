# ADR-0012: Owner-scoped AI Search functional observation

- Status: accepted for the owner-directed free functional checkpoint.
- Date: 2026-10-03.
- Scope: one native managed locator and exact evidence resolution.

## Context

The owner has deferred cognitive and retrieval-quality evaluation. A shadow
generation therefore cannot be promoted by inventing a GoldenCorpus receipt.
The functional checkpoint still needs to observe the deployed managed adapter
resolving a real indexed source into exact admitted evidence.

Cloudflare's [2026-10-01 announcement](https://developers.cloudflare.com/changelog/post/2026-10-01-ai-search-generally-available/)
and [pricing documentation](https://developers.cloudflare.com/ai-search/platform/limits-pricing/)
state that AI Search billing starts on 2026-11-01 and that its Workers AI
embedding/reranking calls are included in AI Search usage. Generation and query
rewriting are separate model operations. This diagnostic uses neither.

## Decision

1. Expose an authenticated owner-only functional observation, separate from
   ordinary Research queries and generation qualification. It accepts one
   project, one source, one bounded query and an idempotency key. The server
   resolves the current source and intersects project membership with that
   selected source; a caller cannot supply a locator or revision witness.
2. Pin the declared private shadow profile and generation before and after the
   operation. Revalidate current owner, scope, source, purge and evidence
   authority. Resolve the provider result through the existing exact evidence
   resolver. Provider text cannot become independent evidence.
3. Claim an immutable START record in the work bucket before the native call.
   Only a proven first creator may issue one Search request. A reused claim or
   uncertain write permits no further query. Preserve an uncertain outcome as
   UNKNOWN; never retry a possibly completed provider effect.
4. Retain a separate immutable terminal receipt with exact readback. It contains
   bounded identities, digests and outcome metadata, without the raw query or
   source excerpt. Its functional reference has no GoldenCorpus, promotion,
   active-generation or restoration authority.
5. Reject the operation from 2026-10-31T00:00:00Z, one day before the announced
   billing start. Continuing it after that conservative cutoff requires a
   separately reviewed cost authority. This is no exemption for other model,
   acquisition, provisioning or bulk indexing operations.

## Acceptance boundary

A successful observation proves that one deployed managed locator resolves into
current exact evidence for the named scope. It does not establish recall,
ranking quality, absence, completeness, READY state, an active generation or
full S1 qualification. Those claims retain their normal acceptance gates.
