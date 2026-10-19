# Wiki and Inbox: one proposal path, one page history

Checked 2026-10-18 against Eliot source at `19cf0b9d`. This is the implementation contract for Wiki and Inbox.
It describes selected replacement work, not completed runtime behavior. Product purpose remains in the
[manifesto](../architecture/ELIOT_RESEARCH.md); the [implementation plan](backend-entrypoints.md) owns sequencing;
[compact citations](source-lifecycle.md) and [runtime boundaries](runtime-contract.md) remain authoritative.

## Product result

Wiki is retained owner knowledge. Inbox is a bounded review queue for proposed Wiki changes.
They are not a publication-compliance platform.

Selected journeys:

```text
saved research report
→ propose selected content to Inbox
→ owner reads the proposal
→ accept unchanged, edit-and-apply, or reject
→ one Wiki page revision becomes current
```

```text
owner creates or edits a Wiki page
→ one complete expected-head revision
→ page reopens with exact citations
```

The model may prepare a proposal. It cannot accept its own proposal. An accepted Wiki revision is owner-selected
content, not a certificate that every statement is true. Citations, visible limitations and optional freshness carry
the useful epistemic information.

## What the current code actually does

| Current source | Observed behavior | Selected replacement |
|---|---|---|
| `packages/cloudflare-wiki/src/wiki-service.ts` | Listing 20 proposals reconstructs historical scope/source authority per row and rechecks all rows; the route accepts no cursor although it returns `has_more`. | One owner-scoped D1 summary query with keyset continuation. Body/freshness load only when opened. |
| `wiki-proposal-reauthorization.ts` | Owner reads can freeze/reauthorize scopes, compare source-owner/participant generations and rebuild a source fingerprint. | Current owner + proposal/page deletion/state. Source availability is checked when a citation is opened, not to list private drafts. |
| `wiki-proposal-from-research-run.ts` | Reopens the old 18-stage result, EvidenceFreeze, coverage, dependency manifest, sections and receipts, then writes body plus a second giant evidence map. | Read one compact `research_report_revision`, copy selected Markdown/citations into one immutable Wiki proposal object. |
| `wiki-review-admission.ts` | Publication requires a reconstructed claim audit, coverage proof, dependencies and an immutable review receipt. | Owner review is the decision. Optional audit metadata may be displayed; it never becomes a mandatory runtime gate. |
| `wiki-owner-edit-proposal.ts` and `wiki-owner-edit-review-admission.ts` | A direct owner edit becomes another proposal, evidence map, binding, integrity receipt, review receipt and publication. | Direct owner edit writes one full Wiki revision under expected-head CAS. No Inbox round trip. |
| `packages/research/src/wiki.ts` | Generic publisher validates evidence/coverage/dependencies, writes a manifest and requires `commitHeadAndOutbox`; unused runtime auto-promotion remains. | Small concrete proposal/read/accept/reject/edit operations in `cloudflare-wiki`; delete the proof-oriented port and `autoPromote`. |
| `wiki-publication-store.ts` and migration `0042` | Proposal, authority, immutable revision, second head, operation records, global outbox, Wiki outbox and mutation guard are committed together. | One proposal row/object; one page revision/head transaction. Direct change-feed insert replaces the fake Wiki outbox. |
| migrations `0001` and `0042` | `wiki_revision/wiki_head` coexist with the runtime `wiki_publication_revision/wiki_publication_head`. | Inventory and convert both into one current Wiki schema, then remove both predecessors. |
| `StudioPanel.tsx` | Pending and published proposals share one list; owner edits create more proposals; publication receipts are retained in browser mutation state. | Separate Inbox proposals from current Wiki pages. Reconcile an uncertain accept by rereading proposal/page state. |

Names above locate the predecessor. They are not permanent concepts.

## Selected state

Use Wiki-specific tables, not a generic content framework:

```text
wiki_page
  page_id
  owner_principal_ref
  head_revision
  deleted_at
  created_at
  updated_at

wiki_page_revision
  page_id + revision
  origin_kind: REPORT_REUSE | MANUAL_EDIT
  origin_report_id + origin_report_revision       # required only for REPORT_REUSE
  accepted_proposal_id                            # required only for accepted Inbox work
  page_type
  title
  object_key + object_sha256 + object_size
  source_revision_refs_json
  editor_principal_ref
  created_at

wiki_inbox_proposal
  proposal_id
  owner_principal_ref
  source_report_id + source_report_revision
  target_page_id
  expected_head_revision                         # 0 means create
  page_type
  title
  object_key + object_sha256 + object_size
  source_revision_refs_json
  state: PENDING | ACCEPTED | REJECTED
  accepted_page_revision
  idempotency_key
  created_at
  decided_at
```

The first selected Inbox producer is a saved research report. Do not add a polymorphic origin registry, generic
proposal bus or implicit connected-agent Wiki authority. A later selected connected-task producer must name its real
caller and access boundary before extending this closed schema.

Each Wiki/proposal object is one bounded immutable R2 value containing Markdown, compact citation refs, visible
limitations and small origin metadata. No evidence map, dependency closure object, section ledger, review receipt or
publication manifest is stored.

`wiki_page_revision` is immutable. `wiki_page.head_revision` is the sole current-page pointer. Proposal state is not
another page head.

## Proposal from a research report

Change together:

- React report/Studio actions;
- owner client Wiki create/read methods;
- Core Wiki routes and composition;
- `packages/cloudflare-wiki/src/wiki-proposal-from-research-run.ts`;
- the compact research-report reader and citation resolver.

The browser sends the exact report revision, target page (or new-page intent), expected Wiki head, title and page type.
It never sends report bytes, an authoritative source set or arbitrary citation ranges.

Server operation:

1. authenticate the owner and read the exact non-deleted research-report revision;
2. load and verify its one R2 object;
3. select/copy the requested Markdown and already canonical compact citations;
4. derive the source-revision set from those citations;
5. encode one bounded Wiki proposal object;
6. create the deterministic R2 key conditionally;
7. insert one `PENDING` proposal bound to owner/idempotency key and exact target head;
8. read back the row/object before returning.

The proposal preserves its source report reference for navigation. It does not replay the producing Workflow,
coverage stage, scope lease, model qualification, claim audit or artifact proof objects. A newer source head makes the
proposal historical; it does not silently rewrite its citations.

A failed D1 insert after R2 creation leaves an unreferenced object for deterministic retry or later guarded cleanup.
Do not add a proposal outbox or two-phase receipt protocol.

## Inbox list and proposal read

The Inbox default query returns `PENDING` proposals only. Optional state filters may show accepted/rejected history.
Use keyset pagination over `(created_at, proposal_id)` with `limit + 1` and a bounded cursor. The cursor is query
position, not authority.

A summary row contains only:

```text
proposal id, target page/head, source report ref,
title, page type, state, created/decided time, accepted page ref when present
```

The list is one bounded D1 metadata read. It does not:

- open R2;
- reauthorize historical source scopes;
- calculate source freshness;
- reconstruct the report/Workflow;
- validate every citation;
- skip stale rows after consuming the page budget.

Opening one proposal authenticates the current owner, reads its exact row/object, verifies stored size/checksum and
returns Markdown/citations. Optional source freshness is separate. `has_more` without a continuation is not a usable
contract; replace server, owner client and React query together rather than adding another protocol generation.

## Accept, edit-and-apply, reject

### Accept unchanged

The proposal object already has the exact Wiki page payload. Acceptance needs no new R2 write.

In one short D1 transaction:

1. require the proposal to be `PENDING` and owned by the current owner;
2. require `wiki_page.head_revision` to equal `expected_head_revision` (or require no page when expected is zero);
3. insert immutable `wiki_page_revision` pointing to the proposal object;
4. insert/create or conditionally advance `wiki_page.head_revision`;
5. set the proposal to `ACCEPTED` with the exact page revision and decision time;
6. append one `WIKI_PUBLISHED`/selected Wiki-change row directly to `research_change_feed`.

The expected-head mutation and every dependent write must share a successful predicate or an explicit aborting guard.
D1 `batch()` rolls back on a failed statement; a successful zero-row update is not failure by itself. A stale head is
a conflict, never partial acceptance.

A retry/reread of the same accepted proposal returns the existing accepted page revision. A rejected proposal cannot
be accepted. An uncertain acknowledgement is reconciled by reading proposal state and page head—not by creating a
second revision.

### Edit and apply

The owner may alter title, page type, complete Markdown and citation refs before applying. The server validates the
bounded body and re-resolves every submitted citation against retained representation/range bounds and current
owner/deletion/disclosure. It derives the source set; browser text and quoted strings are not authority.

Create one immutable edited object, then perform the same D1 acceptance transaction pointing the page revision to
that object. Do not create an edit proposal, integrity receipt, review receipt or another Inbox item.

### Reject

One owner-scoped expected-state update changes `PENDING → REJECTED` and records decision time. It creates no page
revision and no change-feed publication event. The immutable proposal object becomes cleanup-eligible only after a
grace period and a fresh reference check.

## Direct Wiki create and edit

Direct owner create/edit bypasses Inbox:

1. authenticate current page ownership (or new-page intent);
2. validate complete bounded Markdown/title/type and server-resolve citations;
3. conditionally create one immutable object;
4. in one D1 transaction insert a `MANUAL_EDIT` revision and create/advance the expected page head;
5. append the selected Wiki change-feed row directly.

Zero affected head rows is a conflict. No in-place body/provenance rewrite. Automatic link decoration is render-time
or a new expected-head revision. Do not copy WeKnora's page-ID-only auto-link/meta updates.

If AI-assisted Wiki editing is later selected, it uses the normal model-attempt owner to produce completed Markdown,
then calls this same revision writer. It does not receive a Wiki-specific Workflow, claim judge or publication proof
system.

## Access, citations and source changes

Owner page/proposal reads check current authenticated ownership and deletion/state. They do not replay the original
scope snapshot, credential generation, policy lease, deployment generation or source-owner generations.

A connected client receives no Wiki access unless a selected interface grants the specific page/operation. Do not
turn a service task into workspace ownership.

Compact citations are validated when a proposal/revision is written and when a passage is opened. Source deletion or
redaction may make a citation unavailable. A newer source revision makes the Wiki page historical, not unauthorized.
Derived-content erasure follows the actual selected policy; it is not implemented by a universal scope invalidation
chain.

## Change feed: no fake outbox

`wiki_publication_outbox` has no delivery worker or state transition in the inspected runtime. Its insert trigger
creates a `research_change_feed` row. Therefore it is a staging table for another D1 insert, not a real asynchronous
outbox.

Write the change-feed row directly in the page-head transaction and remove:

- `wiki_publication_outbox`;
- its pending index and delivery-state contract;
- the outbox-to-change-feed trigger;
- outbox refs from Wiki heads/readbacks;
- tests that require an unconsumed outbox.

If a future real external consumer needs asynchronous delivery, add the existing Queue/outbox pattern for that
concrete consumer. Do not preserve a fake queue in advance.

## Data conversion

Before destructive migration, inspect deployed rows and R2 objects from both Wiki generations:

- `wiki_revision` / `wiki_head`;
- `wiki_publication_proposal`;
- `wiki_publication_revision` / `wiki_publication_head`;
- owner-edit bindings and publication authority only as conversion evidence.

Convert actual retained data once:

1. read and verify referenced body/manifest objects;
2. map each distinct page revision to one new Wiki object/revision;
3. deduplicate identical `(page_id, revision, bytes)` rows across the two old schemas;
4. stop and report a page-local conflict when the same identity has different bytes—never silently prefer one;
5. map `PROPOSED → PENDING`, `PUBLISHED → ACCEPTED` and bind accepted proposals to the converted page revision;
6. preserve owner, title/type, creation time, canonical citations and source-report origin where available;
7. verify row/object counts, page heads, proposal decisions and citation opens;
8. switch current routes, clients, React Wiki/Inbox, backup and erasure readers;
9. remove the predecessor in the same release once the conversion is verified.

Do not migrate policy/coverage/review receipts as current product authority. They may appear in a bounded conversion
log and then disappear with the old schema. No fallback reader remains after conversion.

## Backup, erasure and cleanup

Move backup manifests/table specs/restore fixtures to `wiki_page`, `wiki_page_revision` and
`wiki_inbox_proposal` plus their exact R2 locator/checksum/size. Inventory tests are callers to update, not a reason to
keep both old Wiki schemas.

Logical page deletion immediately hides the page. Physical object removal uses the existing erasure target/hold/purge
lifecycle after no live page revision references the key. Rejecting a proposal is not physical deletion.

Proposal/orphan cleanup waits for a grace period and rechecks that no proposal or page revision references the exact
object key. It never races deterministic retry or bypasses an erasure hold. No Wiki-specific erasure engine is added.

## Physical deletion cohort

After conversion and caller cutover, delete:

- `wiki_publication_authority` and owner publication guard/witness machinery;
- research/owner-edit review admission, proof readers and immutable review/integrity receipts;
- giant evidence maps, dependency-closure and coverage prerequisites for Wiki publication;
- `wiki_owner_edit_binding` and edit-proposal provenance graph;
- `wiki_publication_revision`, `wiki_publication_head`, `wiki_publication_outbox`;
- obsolete `wiki_revision` / `wiki_head` predecessor rows/schema;
- operation intent/attempt/receipt and outbox rows used only by Wiki publication;
- `WikiPublicationPort`, `createWikiPublisher`, risk-class auto-promotion and `autoPromote` when no real caller remains;
- historical scope reauthorization/fingerprint helpers used only by owner Wiki reads;
- duplicate PWA Wiki clients, old DTO generations and cohort-only fixtures;
- old backup/table-spec/erasure/change-feed entries tied to removed tables.

Keep the React Inbox/Wiki product behavior, compact citations, expected-head conflict, idempotent proposal creation,
uncertain-outcome reconciliation and actual research change feed.

## Donor and platform decisions

- **WeKnora:** take expected-version writes, atomic revision transition and body-free history. Reject GORM topology,
  COUNT+OFFSET and blind page-ID auto-link/meta mutation.
- **NotebookLM/Gemini Notebook:** take explicit source-grounded saved material and deliberate reuse. Reject implicit
  memory extraction or another knowledge store.
- **Cloudflare D1:** one failed statement rolls back a `batch`; explicitly turn stale/zero-row head changes into a
  failure so dependent writes cannot commit.
- **Cloudflare R2:** conditional create is atomic and successful writes are immediately readable; use one object and
  exact readback, not receipt graphs.

No donor code or dependency is imported.

## Completion

Complete when real callers demonstrate:

1. Inbox lists more than 20 proposals through a real cursor without per-row scope reconstruction.
2. Opening one proposal reads one exact object; optional freshness failure does not hide it.
3. Accept unchanged reuses the proposal object and atomically commits revision/head/proposal/change feed.
4. Edit-and-apply writes one object and one page revision without another proposal/review receipt.
5. Reject creates no page revision.
6. Direct owner edit uses expected-head CAS and preserves the prior revision.
7. An uncertain accept is reconciled by reads and never duplicates a revision.
8. Report-to-Wiki reuse reads the compact report, not old Workflow/artifact proof history.
9. Both old Wiki schemas and the publication/review/outbox machinery are removed after verified conversion.
10. Backup, erasure and change-feed readers use only the new Wiki state.

During implementation run scoped TypeScript compile/lint. Product tests and acceptance follow assembly. Report only
checks actually executed and deployed-data migration status; this document is not runtime completion.

Cloudflare references checked 2026-10-18:
[D1 batch transactions](https://developers.cloudflare.com/d1/worker-api/d1-database/),
[R2 conditional operations](https://developers.cloudflare.com/r2/api/workers/workers-api-reference/) and
[R2 consistency](https://developers.cloudflare.com/r2/reference/consistency/).
