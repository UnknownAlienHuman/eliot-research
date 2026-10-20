# Runtime integration notes

Read only for work at these boundaries. Product purpose lives in the
[manifesto](../architecture/ELIOT_RESEARCH.md); [the plan](backend-entrypoints.md) selects implementation;
[source lifecycle](source-lifecycle.md), [ordinary answer](research-full-answer-v1.md) and
[Wiki/Inbox](wiki-inbox.md) own their flows.

## Authentication and untrusted data

Authenticate owner requests through the existing Cloudflare Access/ingress verifier, including alternate routes.
Do not trust caller identity headers. Connected clients retain current project/operation disclosure checks.

Validate external request/provider data at entry and use typed values internally. Recheck mutable state only where
a write, cancellation, deletion or actual disclosure can change the result. Do not carry grant/deployment proof
chains through owner lists or private helper calls.

Source, report and proposal text are untrusted data. They cannot add tools, change scope/budget/model/system
instructions, create citation labels or authorize an effect. Keep prompts, reasoning, credentials and raw provider
frames out of browser output.

## Source and citation lifetime

A run captures exact selected source revisions. A newer head or project detach does not rewrite an active owner's
selection, saved research report, Wiki proposal or Wiki page. Purge/redaction/deletion can make bytes unavailable.
External clients are rechecked at their current disclosure boundary.

A citation is the retained readable revision plus exact byte range and optional display coordinate. Opening it
authenticates the reader, loads that revision, applies current deletion/disclosure state and performs one bounded
range read. Never substitute the latest head. A checksum identifies observed stored bytes, not every authorization
or function call.

Neither a model nor a browser can mint a canonical citation. Generation resolves only labels from the server-owned
context map. Manual report/Wiki edits may preserve/remove existing refs and add refs obtained through an explicit
server selection path; the server revalidates revision, representation, range bounds and current access/deletion
before saving. Quoted/display text is not authority.

## D1 and R2

D1 owns short metadata transactions. R2 owns immutable large bytes. There is no cross-product transaction and no
reason to simulate one with receipt graphs.

For source, public output, research-report, Wiki proposal or Wiki-page bytes:

1. choose a deterministic immutable object key;
2. use conditional R2 create;
3. on uncertain acknowledgement, read that exact key and distinguish same bytes, conflict and unavailable;
4. commit the D1 pointer/head/result/decision through one expected-state transaction;
5. leave an unreferenced object for bounded reconciliation/cleanup if D1 does not commit.

R2 conditional writes are atomic and reads are strongly consistent after a successful write. D1 `batch()` is one
SQL transaction: a failed statement rolls back the sequence. A successful zero-row `UPDATE` is not a failure, so
revision insert, head change and dependent result/proposal/change-feed writes must share predicates or an explicit
aborting guard. No model, HTTP or R2 operation runs inside that D1 transaction.

Do not create operation intents, outbox rows, residency receipts or per-object readback receipts for an internal
same-Worker save. Keep an outbox only when a real asynchronous consumer needs delivery. Store one checksum, size and
locator per retained object; do not duplicate the body or its digest through every layer.

## Provider execution and streaming

Use the existing model pin, route, operation and attempt identity. The selected paid-call path sets
`cf-aig-max-attempts: 1`; preserve one application attempt unless the exact provider offers a proven idempotent
continuation. Workflow retry is not permission to redispatch an uncertain provider call.

For ordinary answers, consume the selected provider stream incrementally, normalize public text/final usage and
retain completed public Markdown once. Require a valid terminal provider event. HTTP 200, socket EOF or browser
disconnect alone is not completion.

A failed browser delivery does not fail generation. A failed research-report save retries from the retained public
output. Raw provider payload logging stays disabled for private material. Semantic caching stays disabled unless
exact scope/model/settings isolation is established; reopening a report already avoids regeneration.

A Workflow step is individually retryable. Do not combine a non-idempotent provider invocation and report save in
one retry unit. Generate/retain and save are separate durable responsibilities. A save retry must read the retained
output locator, not call the model again.

## Compact research-report storage

The target has two research-specific D1 concepts and one R2 object:

```text
research_report
  report_id, owner_principal_ref, head_revision,
  deleted_at, created_at, updated_at

research_report_revision
  report_id, revision,
  origin_kind: GENERATED | MANUAL_EDIT | AI_EDIT,
  origin_operation_id,
  title, summary, language,
  object_key, object_sha256, object_size,
  source_revision_refs_json, created_at

R2 research-report object
  Markdown, compact citation refs, bounded generation/edit metadata
```

Do not call these tables generic `report`/`content`: the product is a research report, and a generic content platform
would recreate the abstraction being removed.

Origin constraints are closed and local:

- `GENERATED` and `AI_EDIT` require a real `origin_operation_id`;
- `MANUAL_EDIT` forbids it;
- each non-null origin operation belongs to one research-report revision;
- no generic origin registry, polymorphic target table or fake run for a manual edit.

The R2 object is one bounded canonical envelope or equivalent single immutable object. Markdown headings are
presentation structure, not separate durable section objects. Export is derived from the same Markdown. Do not
persist ArtifactSpec, section contracts, EvidenceFreeze, AllowedReferenceManifest, verification receipts,
residency objects or deterministic export manifests for a research report.

Saving a generated/AI-edited revision:

1. read the retained completed public output and server label map;
2. resolve only issued labels; reject/leave unresolved unknown labels;
3. canonicalize/deduplicate accepted citation refs and derive `source_revision_refs_json` from them;
4. encode and conditionally create the research-report object;
5. in one D1 transaction insert the immutable revision, conditionally advance `research_report.head_revision` and
   attach the exact revision to the originating operation;
6. read back revision/head/result before marking that operation completed.

Saving a manual edit uses the same object/revision/head writer without an operation attachment. Before encoding, the
server resolves every submitted citation ref through the actual source reader and derives the source set; the
browser cannot supply an authoritative source list, arbitrary byte range or quote.

A failed D1 transaction after successful R2 create leaves an unreferenced immutable object. The deterministic retry
may adopt the same bytes; bounded cleanup may remove an old orphan. Do not add distributed transaction emulation,
receipts or a report outbox.

## Research-report state is not a truth certificate

A revision records origin (`GENERATED`, `MANUAL_EDIT`, `AI_EDIT`) and, when applicable, the producing operation/model.
It must not expose `VERIFIED`, `ACCEPTED` or `PUBLISHED` as claims that the prose is true.

The base artifact schema separately contains a stored `PUBLISHED` status. The publication subsystem instead starts
from a DRAFT and adds owner acceptance decisions, verification/currentness arrays, operation receipts/outbox and a
publication head whose public disposition is `VERIFIED/ACCEPTED`. These are parallel status systems. Repository
search finds `artifact.accepted` only at its producer. Remove the publication system during report cutover.

A completed research report is usable immediately. User confidence comes from citations, visible limitations,
freshness and edits. Explicitly proposing content to Wiki/Inbox is a separate target-specific action. Do not replace
publication receipts with `accepted_at` or another badge absent a concrete product need.

## Research-report access and edits

Owner access checks current authenticated ownership and deletion state. It does not replay the original scope,
credential generation, policy lease, deployment generation, stage lineage or publication receipt. A connected client
checks its current explicit report/operation/project grant.

Reopening reads the exact revision row/object, verifies size/checksum, returns Markdown/citations/metadata, computes
freshness separately and opens citations through the source reader. A newer source head makes the report historical,
not unauthorized. Freshness failure returns `UNKNOWN` without hiding readable content.

Manual expected-head edits authorize the current owner/head, validate complete bounded Markdown and canonical
citations, conditionally create one object, insert `MANUAL_EDIT` and move the head atomically. An explicitly selected
AI revision uses the normal model-attempt owner, retains completed Markdown and writes `AI_EDIT`; it does not use the
artifact section-COW Workflow or acceptance platform.

## Wiki and Inbox state

Wiki is owner-selected reusable knowledge. Inbox is a review queue for changes proposed from a saved research report.
The first selected state is:

```text
wiki_page
  page_id, owner_principal_ref, head_revision,
  deleted_at, created_at, updated_at

wiki_page_revision
  page_id, revision,
  origin_kind: REPORT_REUSE | MANUAL_EDIT,
  origin_report_ref, accepted_proposal_id,
  page_type, title,
  object_key, object_sha256, object_size,
  source_revision_refs_json,
  editor_principal_ref, created_at

wiki_inbox_proposal
  proposal_id, owner_principal_ref,
  source_report_ref,
  target_page_id, expected_head_revision,
  page_type, title,
  object_key, object_sha256, object_size,
  source_revision_refs_json,
  state: PENDING | ACCEPTED | REJECTED,
  accepted_page_revision,
  idempotency_key, created_at, decided_at
```

This is deliberately not a generic proposal/event/content framework. No polymorphic origin registry or implicit
connected-agent Wiki authority.

A proposal object and a page-revision object have the same bounded payload shape: Markdown, compact citations,
visible limitations and small origin metadata. Accepting unchanged reuses the proposal object; it does not copy R2
bytes or create a manifest/evidence map.

## Inbox reads and decisions

Inbox list is one owner-scoped keyset-paginated D1 summary query. It does not open R2, calculate freshness, replay
historical scopes or validate every citation. Opening one proposal reads one exact object and verifies size/checksum.

Accept unchanged performs one D1 transaction:

1. require owner + `PENDING` proposal;
2. require exact expected Wiki head (or no page for expected zero);
3. insert immutable page revision referencing the proposal object;
4. create/advance `wiki_page.head_revision`;
5. set proposal `ACCEPTED` with exact revision/time;
6. insert the real Wiki change row directly into `research_change_feed`.

A zero-row head CAS must abort the transaction. Repeating an already accepted proposal returns its existing revision.
A rejected proposal cannot be accepted. Unknown acknowledgement is reconciled by proposal/page reads.

Edit-and-apply validates one complete edited body and server-resolves its citations, conditionally creates one object,
then uses the same acceptance transaction. Reject performs only `PENDING → REJECTED` and creates no page revision or
change-feed publication.

Direct owner create/edit bypasses Inbox and writes one `MANUAL_EDIT` full-body revision under expected-head CAS.
The model may prepare a proposal; only the owner can apply it. Optional audit/freshness can be displayed but cannot
become a mandatory publication proof chain.

## No Wiki publication proof platform

Remove the current parallel Wiki systems after retained-data conversion:

- `wiki_revision/wiki_head` from the initial schema;
- `wiki_publication_revision/wiki_publication_head` from the runtime publication schema;
- `wiki_publication_authority`, owner publication guard/witness, review admissions and review/integrity receipts;
- evidence maps, dependency/coverage requirements and scope/source fingerprint replay for private owner reads;
- `wiki_owner_edit_binding` and edit-proposal provenance graph;
- operation receipts and both outboxes used only to publish Wiki revisions;
- `WikiPublicationPort`, generic publisher and unused runtime auto-promotion.

`wiki_publication_outbox` has no delivery worker in the inspected runtime; its insert trigger creates a
`research_change_feed` row. Insert that real row directly in the head transaction. Add a Queue/outbox only when a
real external consumer exists.

## Workflow, Queue and ResearchSession

One Workflow owns a research run. Queue accelerates existing persisted work. ResearchSession carries authorized
coarse progress and provisional public text; it owns neither execution nor canonical output.

Ordinary execution chooses its path before old handler/checkpoint assembly. Explicit deep research uses one bounded
search/read/finish loop. Both save through the same research-report writer. Old executors serve only already-admitted
runs while they settle; completed research reports are read directly.

Wiki proposal creation from a saved report and Wiki owner decisions are normal request/application operations, not
new Workflows. A slow/disconnected browser cannot create a duplicate decision; idempotency and read reconciliation
belong to the proposal/page state.

## Run status and owner lists

Status describes product behavior, not internal graph topology:

- run kind: ordinary or deep;
- phase: queued, preparing, generating, saving, completed, cancelled or failed;
- safe failure/cancellation;
- terminal result availability and research-report reference.

Do not expose `next_stage_index`, stage 18, handler generation or provider frames as the durable contract. Owner lists
read D1 metadata only. Report/Wiki/proposal bodies and citation bytes load on demand. Acceptance/publication proof
status is not part of any list.

## Backup, deletion, erasure and orphan cleanup

Backup/table-spec/restore code is a schema caller. Move selected portable state to:

- `research_report` and `research_report_revision`;
- `wiki_page`, `wiki_page_revision` and `wiki_inbox_proposal`;
- exact R2 object locator/checksum/size.

Do not keep old artifact/Wiki tables because an exhaustive inventory names them. Restore immutable objects before
D1 references and re-establish heads/result/proposal decisions through the new schema's ordinary integrity checks.
Old acceptance/review receipts are not restored as current product state.

Logical report/page deletion immediately hides content. Physical R2 deletion uses the existing exact
erasure target/hold/purge lifecycle after no live revision references the key. Source erasure may make compact
citations unavailable without deleting unrelated prose unless actual policy requires derived-content removal.

Proposal/orphan cleanup is not erasure. It waits for a grace period and performs a fresh D1 reference check. An
accepted proposal object is retained because a Wiki revision references it. Cleanup never races deterministic retry
or bypasses an erasure hold. No report- or Wiki-specific erasure coordinator is added.

## Migration and deletion

Inventory retained report and Wiki rows before changing schema. For Wiki, inspect both old page/head families and
proposal state. Convert identical page identities once; when the same page/revision has different bytes, stop that
page's migration and report the conflict rather than choosing silently.

Map old `PROPOSED → PENDING` and `PUBLISHED → ACCEPTED`, preserve actual page bodies/citations/origins, verify rows,
objects, heads and opens, then switch server/client/UI/backup/erasure/change-feed callers. Remove old schemas and
fallback readers in the same completed cutover. Git history is the archive.

## Limits

Model token window, serialized request bytes, response bytes, Workflow step result size, R2 object size and Worker
memory are different limits. Reserve output capacity before filling context. FULL rejects overflow; it never silently
truncates. Whole selected sources can be read before search indexing finishes.

Research HTTP, immutable R2 objects and compact receipts have separate bounds. The HTTP JSON envelope remains
256 KiB; initial run payloads and protocol checkpoints use the existing bounded WorkflowObject/R2 profile; only
compact D1/step receipt documents use the 64 KiB receipt profile. Writers and readers enforce the same object bound.

Cloudflare references checked 2026-10-18:
[R2 conditional writes and consistency](https://developers.cloudflare.com/r2/reference/consistency/),
[R2 Workers API](https://developers.cloudflare.com/r2/api/workers/workers-api-reference/),
[D1 batch transactions](https://developers.cloudflare.com/d1/worker-api/d1-database/) and
[Workflow retry rules](https://developers.cloudflare.com/workflows/build/rules-of-workflows/).
