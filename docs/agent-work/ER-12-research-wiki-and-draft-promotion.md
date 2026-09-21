# ER-12: Research Wiki and draft promotion

**Slice:** 2
**Depends on:** ER-10, ER-13, ER-14
**Live gate:** none

## Objective

Implement this capability without redesigning neighboring contracts. The packet owns no authority
outside the paths below.

## Owned paths

- `packages/research/src/wiki.ts`
- `packages/domain/src/publication.ts`

- `apps/eliotr-core/src/wiki-publication-store.ts`
- `apps/eliotr-core/src/wiki-publication-store-support.ts`
- `apps/eliotr-core/test/wiki-publication-store.test.ts`
- `apps/eliotr-core/src/wiki-service.ts`
- `apps/eliotr-core/test/wiki-service.test.ts`
- `apps/eliotr-core/test/wiki-owner-edit-parity.test.ts`
## Read only

- `packages/contracts/src/publication.ts`
- `packages/policy/**`

## Architecture extracts

- §9.4–9.6

## Required implementation

- Implement immutable Wiki revision publication followed by D1 expected-head CAS and outbox.
- Validate statement labels, evidence map, counterpositions, coverage, limitations and dependency closure.
- Implement D0–D3 risk-tiered Draft Inbox; only policy-authorized D0/D1 may auto-promote.

## Acceptance

- No active update without CAS.
- D2/D3 never auto-promote.
- R2 readback/hash precedes D1 head mutation.

## Mandatory negative boundary

Race two publishers against one expected head; exactly one becomes active and the loser receives typed conflict.

## Handoff contract

Produce:
- Wiki proposal/publisher
- draft classifier/promotion
- dependency invalidation

The PR must state contract/generation impact, migration/backfill impact, exact commands, negative-case
result, live receipts (or `NOT EXECUTED`), and any follow-up packet. Do not mark this packet complete
with placeholders, TODO authority paths, mocked live gates, or a stronger disposition than observed.


## Owner-edit Unicode and reference boundaries

The supported owner-edit writer and review/replay readers share the existing
`parseInput`/`parseMetadata` text rules: title at most 512 UTF-16 code units,
edit note at most 4096 code units, no NUL or unpaired surrogate. The note may
be empty. Valid BMP/non-BMP, combining characters, quotes, tabs and newlines
are preserved, not normalized or truncated. The edited body additionally
has an 8 MiB UTF-8 envelope. These are distinct units, not a shared SQL
character count.

The public `WikiPageRevision` identifier envelope remains 256 characters;
the internal object-reference validator permits at most 512 ASCII
characters matching its safe-reference alphabet and rejects `..` and
backslashes. The wider internal allowance does not widen the public DTO.
References in owner-edit metadata originate from a validated canonical
published base; the edit request cannot choose a replacement base evidence
reference.

Migration 0064 is an immutable storage-binding guard, not a standalone
Unicode/reference validator. SQLite `length()` does not express the
JavaScript UTF-16 ceiling or the complete safe-reference predicate. The
supported writer rejects the wider-but-invalid values before writing an
owner-edit binding. Do not label the SQL predicate alone a reachable
writer/reader defect, or relax the reader to accommodate invalid state.

`wiki-owner-edit-parity.test.ts` exercises actual local Workers D1/R2 and
current owner authorization: publish a base, propose an edit, read and
review it, publish through the guarded head/outbox transaction, and replay
without new effects. Boundary cases include BMP/non-BMP maxima, combining
characters, malformed text/references, the exact body-byte envelope,
read-only legacy-JSON decoding and out-of-band object corruption. Invalid
inputs and corrupt readback cannot advance the tested head or outbox;
owner edits retain UNRESOLVED labels and do not acquire research evidence
strength. Local fixture authority is not a live publication or model
qualification receipt. No historical migration or public wire schema is
changed by these regressions.


## S04 Wiki mutation runtime regression

The same real-runtime parity file also races two actual owner-edit publishers by
committing a competing service call immediately before the loser's native D1 batch.
The winner's revision, head, outbox, change-feed event, proposal states and R2 manifest
remain exact after the loser receives `WIKI_HEAD_CONFLICT`; replay adds no mutation.
A stale edit is rejected before additional proposal/binding/object writes. A lost
binding acknowledgement reconciles from the real D1 row without a duplicate insert.
The `d1-mutations` CI job runs this file with the Project runtime regressions on Linux
and Windows, using the complete existing migrations without modified triggers.

Published base-input construction runs in the existing per-test fixture hooks,
not inside the timed owner-edit assertion. The database and objects are reset
for each case; production calls, replay/race assertions and default test/hook
deadlines remain unchanged. This keeps fixture construction distinct from the
operation under test on slower native Windows runners.

The targeted CI command uses `--no-file-parallelism` for these two migration-heavy
files. Each case retains isolated D1/R2 state and the explicit transaction races;
this only serializes independent runtime pools, not competing application writes.
The full Worker-suite configuration and test/hook deadlines are unchanged.

For the competing-publication case, the two unpublished owner-edit inputs are
created through the real writer in a scoped fixture hook. The timed assertion
still executes both actual publications at the controlled pre-batch race point
and verifies every canonical row, receipt, manifest digest and replay outcome.
