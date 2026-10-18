# Runtime integration notes

Read only for work at these boundaries. Product purpose lives in the
[manifesto](../architecture/ELIOT_RESEARCH.md); [the plan](backend-entrypoints.md) selects implementation;
[source lifecycle](source-lifecycle.md) and [ordinary answer](research-full-answer-v1.md) own their flows.

## Authentication and untrusted data

Authenticate owner requests through the existing Cloudflare Access/ingress verifier, including alternate routes.
Do not trust caller identity headers. Connected clients retain current project/operation disclosure checks.

Validate external request/provider data at entry and use typed values internally. Recheck mutable state only where
a write, cancellation, deletion or actual disclosure can change the result. Do not carry grant/deployment proof
chains through owner lists or private helper calls.

Source text is untrusted data. It cannot add tools, change scope/budget/model/system instructions, create citation
labels or authorize an effect. Keep prompts, reasoning, credentials and raw provider frames out of browser output.

## Source and citation lifetime

A run captures exact selected source revisions. A newer head or project detach does not rewrite an active owner's
selection or a saved report. Purge/redaction/deletion can make bytes unavailable. External clients are rechecked at
their current disclosure boundary.

A citation is the retained readable revision plus exact byte range and optional display coordinate. Opening it
authenticates the reader, loads that revision, applies current deletion/disclosure state and performs one bounded
range read. Never substitute the latest head. A checksum identifies observed stored bytes, not every authorization
or function call.

## D1 and R2

D1 owns short metadata transactions. R2 owns immutable large bytes. There is no cross-product transaction and no
reason to simulate one with receipt graphs.

For source, public output or report bytes:

1. choose a deterministic immutable object key;
2. use conditional R2 create;
3. on uncertain acknowledgement, read that exact key and distinguish same bytes, conflict and unavailable;
4. commit the D1 pointer/head/result through one expected-state transaction;
5. leave an unreferenced object for bounded reconciliation/cleanup if D1 does not commit.

R2 conditional writes are atomic and reads are strongly consistent after a successful write. D1 `batch()` is one
SQL transaction: a failed statement rolls back the sequence. A successful zero-row `UPDATE` is not a failure, so
revision insert, head change and dependent run/result update must share predicates or an explicit aborting guard.
No model, HTTP or R2 operation runs inside that D1 transaction.

Do not create operation intents, outbox rows, residency receipts or per-object readback receipts for an internal
same-Worker report save. Keep an outbox only when a real asynchronous consumer needs delivery. Store one checksum,
size and locator per retained object; do not duplicate the body or its digest through every layer.

## Provider execution and streaming

Use the existing model pin, route, operation and attempt identity. The selected paid-call path sets
`cf-aig-max-attempts: 1`; preserve one application attempt unless the exact provider offers a proven idempotent
continuation. Workflow retry is not permission to redispatch an uncertain provider call.

For ordinary answers, consume the selected provider stream incrementally, normalize public text/final usage and
retain completed public Markdown once. Require a valid terminal provider event. HTTP 200, socket EOF or browser
disconnect alone is not completion.

A failed browser delivery does not fail generation. A failed report save retries from the retained public output.
Raw provider payload logging stays disabled for private material. Semantic caching stays disabled unless exact
scope/model/settings isolation is established; reopening a report already avoids regeneration.

A Workflow step is individually retryable. Do not combine a non-idempotent provider invocation and report
publication in one retry unit. Generate/retain and save are separate durable responsibilities. A save retry must
read the retained output locator, not call the model again.

## Compact report storage

The target report has two D1 concepts and one R2 object:

```text
report
  report_id, owner_principal_ref, head_revision, deleted_at, created_at, updated_at

report_revision
  report_id, revision, run_id, title, summary, language,
  object_key, object_sha256, object_size,
  source_revision_refs_json, created_at

R2 report object
  Markdown, compact citation refs, bounded generation metadata
```

The report object is one bounded canonical envelope or equivalent single immutable object. Markdown headings are
presentation structure, not separate durable section objects. Export is derived from the same Markdown. Do not
persist ArtifactSpec, section contracts, EvidenceFreeze, AllowedReferenceManifest, verification receipts,
residency objects or deterministic export manifests for an ordinary report.

Saving a generated report:

1. read the retained completed public output and label map;
2. resolve only server-issued labels to compact citations;
3. encode and conditionally create the report object;
4. in one D1 transaction insert the immutable revision, conditionally advance the report head and attach the exact
   report reference to the originating run;
5. read back the revision/head/result before marking the run completed.

Editing creates a full new revision under the expected head. Reports are bounded documents; use a complete coherent
body rather than a section object graph. If AI assistance is selected, its provider attempt retains a complete new
Markdown output and then calls this same writer. It does not create a section COW Workflow or child artifact.

## Report state is not a truth certificate

A report revision may record origin metadata such as generated/edited and the producing model/run. It must not expose
`VERIFIED`, `ACCEPTED` or `PUBLISHED` as claims that the prose is true.

The base artifact schema separately contains a stored `PUBLISHED` status. The publication subsystem instead starts
from a DRAFT and adds owner acceptance decisions, verification/currentness arrays, operation receipts/outbox and a
publication head whose public disposition is `VERIFIED/ACCEPTED`. These are parallel status systems. Repository
search finds the `artifact.accepted` topic only at its producer. Remove the publication system during report cutover.

A completed report is usable immediately. User confidence comes from citations, visible limitations, freshness and
edits. Explicitly proposing content to Wiki/Inbox is a separate target-specific action. Do not replace publication
receipts with `accepted_at` or another badge absent a concrete product need.

## Report access and reopening

Owner report access checks the current authenticated owner, report ownership and report deletion state. It does not
replay the original scope expression, credential generation, policy lease, deployment generation, stage lineage or
publication receipt. A connected client checks its current explicit report/operation/project grant.

Reopening then:

1. reads the exact `report_revision` row;
2. loads the exact R2 object and verifies stored size/checksum;
3. returns Markdown, compact citations and stable metadata;
4. computes source-head freshness separately and optionally;
5. opens a citation only through the source-revision/range reader.

A newer source head makes the report historical, not unauthorized. Freshness failure returns `UNKNOWN` without
hiding readable content. A purged/deleted report or failed report authorization remains unavailable. Do not expose
authorization receipts, policy authorities, acceptance receipts or reauthorization protocol generations in the
browser DTO.

## Workflow, Queue and ResearchSession

One Workflow owns a run. Queue accelerates existing persisted work. ResearchSession carries authorized coarse
progress and provisional public text; it owns neither execution nor canonical output.

Ordinary execution chooses its path before old handler/checkpoint assembly. Explicit deep research uses one bounded
search/read/finish loop. Both save through the same report writer. Old executors serve only already-admitted runs
while they settle; completed reports are read directly.

A slow/disconnected subscriber cannot block generation or save. Do not persist every token/event. Reconnect reads
canonical status/result and may resume new provisional deltas with an explicit gap.

Report edits are not another Workflow by default. Manual expected-head writes are ordinary request/application
work. An explicitly selected AI revision uses the normal model-attempt owner and report writer, not the current
`artifact-section-revise` Workflow, REPORT witness renewal and child-materialization graph.

## Run status and owner lists

Status describes product behavior, not internal graph topology:

- run kind: ordinary or deep;
- phase: queued, preparing, generating, saving, completed, cancelled or failed;
- safe failure/cancellation;
- terminal result availability and report reference.

Do not expose `next_stage_index`, stage 18, handler generation or provider frames as the durable contract. A temporary
old-run adapter is removed after real old runs settle.

Owner lists read D1 metadata only: run ID, time, question, recorded state and report reference/title/summary.
Report bodies and citation bytes load on demand. Project attribution is captured at admission; do not infer it from
today's attachments or post-filter a bounded candidate page. Acceptance/publication status is not part of the list.

## Migration and deletion

Inventory retained reports before changing schema. Convert each real saved report once, preserving stable report
identity/revision where practical, body text, citations, originating run, title, language and creation time. Verify
row/object counts and hashes, switch current server/client reads and writes, then remove:

- `artifact_revision` report use;
- `artifact_draft_reservation`, `artifact_draft_head`, `artifact_draft_binding`, `artifact_draft_object` report use;
- `research_report_admission` and stage-17 report fences;
- report EvidenceFreeze/manifest/verification/residency objects;
- `artifact_publication_receipt`, `artifact_publication_head`, `artifact_publication_mutation_guard` and publication-
  only operation/outbox rows;
- artifact acceptance routes/client/UI/policy/readiness code;
- artifact section revise Workflow/COW/model/child-materialization code and tables;
- v1/v2/v3 report reauthorization DTOs and their fixtures.

Old acceptance receipts are conversion diagnostics at most; they do not become product state in the new schema.
Do not keep a fallback reader after conversion. Git history is the archive.

## Limits

Model token window, serialized request bytes, response bytes, Workflow step result size, R2 object size and Worker
memory are different limits. Reserve output capacity before filling context. FULL rejects overflow; it never silently
truncates. Whole selected sources can be read before search indexing finishes.

The earlier C03 256-KiB HTTP versus 64-KiB persisted-input mismatch is a source finding, not a desired limit. Align
the actual producer, stored locator and readers in the changed path.

Cloudflare references checked 2026-10-18:
[R2 conditional writes and consistency](https://developers.cloudflare.com/r2/reference/consistency/),
[R2 Workers API](https://developers.cloudflare.com/r2/api/workers/workers-api-reference/),
[D1 batch transactions](https://developers.cloudflare.com/d1/worker-api/d1-database/) and
[Workflow retry rules](https://developers.cloudflare.com/workflows/build/rules-of-workflows/).
