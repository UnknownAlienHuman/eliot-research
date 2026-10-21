# Wiki and Inbox: one proposal path, one page history

Checked 2026-10-21 against `main@4655df4d`. This owns remaining Wiki/Inbox replacement work. Product purpose remains
in the [manifesto](../architecture/ELIOT_RESEARCH.md); [the plan](backend-entrypoints.md) owns sequencing;
[compact citations](source-lifecycle.md) and [runtime boundaries](runtime-contract.md) own shared boundaries.

## Product result

```text
saved research-report revision
→ create one Inbox proposal
→ owner opens it
→ accept unchanged, edit-and-apply, or reject
→ one Wiki page revision becomes current
```

```text
owner creates or edits a Wiki page
→ one complete expected-head revision
→ reopen exact Markdown and citations
```

The model may prepare content; only the owner applies it. An accepted Wiki revision is selected knowledge, not a
certificate that every statement is true.

## Foundations already merged

Do not reopen these as new implementation work:

- Owner proposal list/read use direct owner-scoped metadata; R2 body loads only when opening one proposal.
- Server, owner client and React use keyset continuation over `(created_at, proposal_id)`; `has_more` is no longer a
  first-page-only flag.
- `wiki_publication_outbox`, its head reference, pending index, trigger staging role and special change-reader joins
  are removed. Publication commits the real owner-visible change-feed row directly.
- Runtime Wiki auto-promotion and its proof/policy types are removed; owner decision is the only current publish path.

Those changes simplify the current predecessor but do not yet consolidate its two page stores or remove the
proposal-authority/review/evidence machinery.

## Remaining predecessor

Current runtime still has:

- initial `wiki_revision/wiki_head` plus `wiki_publication_revision/wiki_publication_head`;
- proposal authority, review/integrity receipts, evidence maps, dependency/coverage gates and publication witness;
- `wiki_owner_edit_binding` and a direct-edit path that creates another proposal/review;
- generic `WikiPublicationPort`/publisher and duplicate old client protocol families;
- backup/erasure/table inventories coupled to both old page families.

`wiki-proposal-from-research-run.ts` still reconstructs old Workflow/artifact proof history rather than reading one
compact research report. These names locate code to replace; they are not permanent product concepts.

## Selected state

Use Wiki-specific state, not a generic content/proposal platform:

```text
wiki_page
  page_id, owner_principal_ref, head_revision,
  deleted_at, created_at, updated_at

wiki_page_revision
  page_id, revision,
  origin_kind: REPORT_REUSE | MANUAL_EDIT,
  origin_report_id, origin_report_revision,
  accepted_proposal_id,
  page_type, title,
  object_key, object_sha256, object_size,
  source_revision_refs_json,
  editor_principal_ref, created_at

wiki_inbox_proposal
  proposal_id, owner_principal_ref,
  source_report_id, source_report_revision,
  target_page_id, expected_head_revision,
  page_type, title,
  object_key, object_sha256, object_size,
  source_revision_refs_json,
  state: PENDING | ACCEPTED | REJECTED,
  accepted_page_revision,
  idempotency_key, created_at, decided_at
```

The first producer is a saved research report. Do not add a polymorphic origin registry, generic proposal bus,
automatic memory extraction or implicit connected-agent Wiki authority.

A proposal/page revision uses one bounded immutable R2 object with Markdown, compact citations, visible limitations
and small origin metadata. `wiki_page.head_revision` is the only current-page pointer; proposal state is not another
page head.

## Proposal from a report

Change React report/Studio actions, owner client methods, Core routes, `wiki-proposal-from-research-run.ts` and the
compact report reader together.

Server operation:

1. authenticate the owner and read the exact non-deleted report revision;
2. load and verify its one R2 object;
3. copy selected Markdown and canonical citations;
4. derive source revisions from citations;
5. conditionally create one deterministic proposal object;
6. insert one idempotent `PENDING` proposal bound to owner and exact target head;
7. read back row/object before returning.

Do not replay the producing Workflow, coverage stage, scope lease, claim audit or artifact proof graph. A failed D1
insert leaves an unreferenced object for deterministic retry/guarded cleanup, not a proposal outbox.

## Inbox list and open

Keep the merged owner-scoped keyset contract. Default list returns `PENDING`; optional filters may expose decided
history. Summary rows contain proposal/target/source-report refs, title/type/state/times and accepted page ref. The
list performs one bounded D1 read—no R2, freshness, citation validation or historical scope replay.

Opening one proposal authenticates current ownership, loads its exact object and verifies stored size/checksum.
Freshness is separate advisory metadata. Cursor data is bounded untrusted position; every page reapplies owner/filter
predicates.

## Owner decisions

### Accept unchanged

Reuse the proposal object. In one D1 transaction:

1. require owned `PENDING` proposal;
2. require exact expected page head, or page absence for create;
3. insert immutable page revision referencing the proposal object;
4. create/advance `wiki_page.head_revision`;
5. set proposal `ACCEPTED` with exact revision/time;
6. append one owner-visible Wiki change to `research_change_feed`.

All dependent writes share a successful predicate or explicit aborting guard. A zero-row CAS is a conflict. Repeating
an already accepted proposal returns its existing revision; unknown acknowledgement reconciles by proposal/page
reads, never a duplicate revision.

### Edit and apply

Validate complete bounded Markdown/title/type and server-resolve citations. Create one edited object, then use the
same decision transaction. Do not create another proposal, integrity receipt or review receipt.

### Reject

One expected-state update performs `PENDING → REJECTED`; no page revision or publication event.

## Direct owner edit

Direct create/edit bypasses Inbox. Validate one full body and citations, conditionally create one object, insert one
`MANUAL_EDIT` revision, expected-head CAS and direct change-feed row. Decoration is render-time or a new revision;
never a blind in-place page-ID update.

A later selected AI-assisted edit uses the ordinary model-attempt owner then the same page writer. It does not gain a
Wiki-specific Workflow, judge or proof system.

## Data conversion and deletion

Before destructive migration, inspect both old page/head families, proposal rows, referenced R2 objects and retained
owner-edit/publication evidence needed only to map data.

Convert once:

1. verify referenced bodies/objects;
2. map every distinct page revision to one new object/revision;
3. deduplicate identical `(page_id, revision, bytes)` entries;
4. stop a page-local conversion when the same identity has different bytes;
5. map `PROPOSED → PENDING`, `PUBLISHED → ACCEPTED` and bind accepted proposals to converted revisions;
6. preserve owner, title/type, time, canonical citations and source-report origin;
7. verify counts, heads, decisions and opens;
8. switch server/client/React/backup/erasure/change-feed callers;
9. remove both old schemas and fallback readers in the same completed cutover.

Do not migrate policy/coverage/review receipts as current authority. After cutover delete publication authority,
review/integrity admissions/readers, giant evidence maps, dependency/coverage gates, owner-edit binding/graph,
`wiki_publication_*`, old `wiki_revision/wiki_head`, publication-only operation records, generic publisher/port,
historical owner-scope helpers, duplicate clients/DTOs and cohort-only fixtures.

Keep compact citations, expected-head conflict, idempotent proposal creation, uncertain-outcome reconciliation,
page history and the real change feed.

## Backup, erasure and cleanup

Move selected backup/restore/table specs to the three new tables plus exact object locator/checksum/size. Logical
page deletion hides content immediately. Existing erasure target/hold/purge owns physical removal after no live
revision references the key.

Rejected/unreferenced proposal cleanup is not erasure: wait for a grace period and fresh reference check. An accepted
proposal object remains because a Wiki revision references it. Do not add a Wiki-specific erasure engine.

## Completion

Complete when real callers demonstrate proposal creation from a compact report, multi-page Inbox list/open, all three
decisions, direct expected-head edit, read-based reconciliation, retained-data conversion and backup/erasure updates;
then both old page stores and proof/review/edit-proposal cohorts are physically gone.

During implementation run scoped compile/lint. Product tests and deployment/data acceptance follow assembly. This
document does not claim the remaining cutover is complete.
