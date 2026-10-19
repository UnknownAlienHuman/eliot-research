# Runtime integration notes

Read only for work at these boundaries. Product purpose lives in the
[manifesto](../architecture/ELIOT_RESEARCH.md); [the plan](backend-entrypoints.md) selects implementation;
[source lifecycle](source-lifecycle.md), [ordinary answer](research-full-answer-v1.md) and
[research presentation](research-session-projection-protocol.md) own their flows.

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
selection or a saved research report. Purge/redaction/deletion can make bytes unavailable. External clients are
rechecked at their current disclosure boundary.

A citation is the retained readable revision plus exact byte range and optional display coordinate. Opening it
authenticates the reader, loads that revision, applies current deletion/disclosure state and performs one bounded
range read. Never substitute the latest head. A checksum identifies observed stored bytes, not every authorization
or function call.

Neither a model nor a browser can mint a canonical citation. Generation resolves only labels from the server-owned
context map. Manual edits may preserve/remove existing refs and add refs obtained through an explicit server
source/citation selection path; the server still revalidates revision, representation, range bounds and current
access/deletion before saving. Quoted/display text is not authority.

## D1 and R2

D1 owns short metadata transactions. R2 owns immutable large bytes. There is no cross-product transaction and no
reason to simulate one with receipt graphs.

For source, public output or research-report bytes:

1. choose a deterministic immutable object key;
2. use conditional R2 create;
3. on uncertain acknowledgement, read that exact key and distinguish same bytes, conflict and unavailable;
4. commit the D1 pointer/head/result through one expected-state transaction;
5. leave an unreferenced object for bounded reconciliation/cleanup if D1 does not commit.

R2 conditional writes are atomic and reads are strongly consistent after a successful write. D1 `batch()` is one
SQL transaction: a failed statement rolls back the sequence. A successful zero-row `UPDATE` is not a failure, so
revision insert, head change and dependent result update must share predicates or an explicit aborting guard.
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

## Research-report access and reopening

Owner access checks the current authenticated owner, research-report ownership and deletion state. It does not replay
the original scope expression, credential generation, policy lease, deployment generation, stage lineage or
publication receipt. A connected client checks its current explicit report/operation/project grant.

Reopening:

1. reads the exact `research_report_revision` row;
2. loads the exact R2 object and verifies stored size/checksum;
3. returns origin, Markdown, compact citations and stable metadata;
4. computes source-head freshness separately and optionally;
5. opens a citation only through the source-revision/range reader.

A newer source head makes the report historical, not unauthorized. Freshness failure returns `UNKNOWN` without
hiding readable content. A purged/deleted report or failed report authorization remains unavailable. Do not expose
authorization receipts, policy authorities, acceptance receipts or reauthorization protocol generations in the
browser DTO.

## Research-report edits

Manual expected-head edits are ordinary request/application work:

1. authorize the current owner/report head;
2. validate one complete bounded Markdown body, expected head and citation references;
3. resolve each citation against retained representation/range bounds and current owner/deletion/disclosure;
4. reject unknown, inaccessible, malformed or out-of-range refs;
5. canonicalize/deduplicate accepted refs and derive the source-revision set;
6. conditionally create one immutable object;
7. insert `MANUAL_EDIT` with no origin operation and move the expected head atomically.

An explicitly selected AI revision uses the normal model-attempt owner, retains completed public Markdown, resolves
only its server label map, then writes `AI_EDIT` with the actual operation. It does not use the current
`artifact-section-revise` Workflow, REPORT witness renewal, COW child artifact or publication acceptance prerequisite.

## Native Agent–Workflow presentation

One `operation_id` names the canonical D1 run, its ResearchSession Agent and its research Workflow instance.
Admission persists D1 first, then invokes a server-only method on that Agent. The Agent validates the exact admitted
row and starts `RESEARCH_WORKFLOW` with `runWorkflow(..., { id: operation_id })`.

`ResearchWorkflow` extends `AgentWorkflow<ResearchSession, ...>`. Move the unrelated `EXHAUSTIVE_QUERY` branch to a
small direct `ExhaustiveQueryWorkflow`; do not pass fake Agent origin fields or retain mixed `workflow_kind` params.

Responsibilities remain distinct:

- D1 run/application state: request, authority, budget, cancellation, terminal phase and result ref;
- Workflow: durable execution and paid-effect retry boundaries;
- Agent state: bounded phase, public output offset and terminal report hint;
- Agent broadcasts: provisional public Markdown only;
- browser: ephemeral buffer and rendering.

At coarse phase changes, use durable `step.mergeAgentState()` / `step.updateAgentState()`. Use
`step.reportComplete()` / `step.reportError()` only after canonical D1 settlement. The SDK's tracked workflow row is
Agent↔Workflow correlation, not product history or result authority.

Public Markdown broadcasts are non-durable and may repeat. Batch them with explicit `from_byte`/`to_byte` ranges.
The client ignores a fully repeated range and marks a forward/overlap gap. Never persist every frame, replay a token
journal or derive completion from a broadcast.

The owner WebSocket is authenticated by the existing outer Access route and one bounded current-run ownership read.
Mark it readonly with the SDK hook. Expose no browser callable that starts/cancels/retries paid work: readonly blocks
state writes but cannot undo side effects performed before a callable writes state. Close connections at Access
expiry; reconnect repeats Access and D1 checks.

Do not replay investigation scope, historical source authority, handler generation or original credential/deployment
proofs merely to display progress. Actual source/citation/report reads enforce their own current deletion and
access/disclosure rules.

Remove the custom session bootstrap row, stage/final-receipt snapshot reconstruction, `connection.send` monkey-patch,
protocol suppression and call-only client wrapper after old runs settle. Use installed AgentClient state sync,
message events and reconnect. Do not use AIChatAgent/resumable chat storage; no transcript is selected.

## Queue and cancellation

Queue accelerates existing persisted work; it does not own a run. The authenticated D1 cancellation mutation remains
canonical. After that decision, the server may terminate the Agent-tracked Workflow. Workflow/Agent callbacks update
presentation only and cannot reverse or mint cancellation.

Ordinary execution chooses its path before old handler/checkpoint assembly. Explicit deep research uses one bounded
search/read/finish loop. Both use the same Agent-tracked Workflow bridge and research-report writer. Old executors
serve only already-admitted runs while they settle; completed research reports are read directly.

A slow/disconnected subscriber cannot block generation or save. Reconnect reads Agent presentation state and then
the canonical D1 status/result. It may receive only new provisional ranges with an explicit gap.

## Run status and owner lists

Status describes product behavior, not internal graph topology:

- run kind: ordinary or deep;
- phase: queued, preparing, generating, saving, completed, cancelled or failed;
- safe failure/cancellation;
- terminal result availability and research-report reference.

Do not expose `next_stage_index`, stage 18, handler generation, Agent workflow tracking rows or provider frames as
the durable contract. A temporary old-run adapter is removed after real old runs settle.

Owner lists read D1 metadata only: run ID, time, question, recorded state and research-report ref/title/summary.
Report bodies and citation bytes load on demand. Project attribution is captured at admission; do not infer it from
today's attachments or post-filter a bounded candidate page. Acceptance/publication status is not part of the list.

## Backup, deletion, erasure and orphan cleanup

The current backup inventory explicitly exports `artifact_head`, `artifact_revision`, artifact-draft tables,
`research_report_admission`, publication receipts/heads and section-revise runs. Those manifests, explicit table
specs, coherent-cut readers and restore fixtures are callers of the old schema. Update or remove them with report
cutover; do not keep dead tables because an exhaustive-inventory test still names them.

If the retained backup path remains selected:

- export `research_report` and `research_report_revision` plus the exact R2 object locator/checksum/size;
- restore immutable objects before their D1 references and re-establish heads/result associations through the new
  schema's ordinary integrity checks;
- never restore old acceptance receipts as current product state;
- classify retired artifact/admission/publication/COW tables as removed, not historical authority to recreate.

Logical deletion sets `research_report.deleted_at` (or the selected equivalent) and immediately removes the report
from owner/delegated reads. Physical R2 deletion is an existing erasure/retention operation over the exact object key:
respect current holds, record the real target, and remove bytes only after no live `research_report_revision`
references the key. The old publication-head `PENDING_REVALIDATION`/`REDACTED_DEPENDENCY` path disappears with the
publication system; source erasure can make a compact citation unavailable without deleting unrelated report prose
unless the actual erasure policy requires derived-content removal.

Orphan cleanup is not erasure. It may delete an object only after a grace period and a fresh D1 check proves no live
research-report revision references that exact key. It must not bypass an erasure hold or race a deterministic retry.
No report-specific erasure coordinator, closure ledger or backup platform is added.

## Migration and deletion

Inventory retained reports before changing schema. Convert each real saved report once, preserving stable identity/
revision where practical, body text, server-validated citations, originating operation, title, language and creation
time. Assign `GENERATED` to old generated reports, derive the source set from canonical citations and do not invent
operations for manual edits. Verify row/object counts and hashes, switch current server/client reads and writes, then
remove:

- `artifact_revision` report use;
- `artifact_draft_reservation`, `artifact_draft_head`, `artifact_draft_binding`, `artifact_draft_object` report use;
- `research_report_admission` and stage-17 report fences;
- report EvidenceFreeze/manifest/verification/residency objects;
- `artifact_publication_receipt`, `artifact_publication_head`, `artifact_publication_mutation_guard` and publication-
  only operation/outbox rows;
- artifact acceptance routes/client/UI/policy/readiness code;
- artifact section revise Workflow/COW/model/child-materialization code and tables;
- old backup/table-spec/restore entries and publication erasure invalidation tied only to that cohort;
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
[D1 batch transactions](https://developers.cloudflare.com/d1/worker-api/d1-database/),
[Workflow retry rules](https://developers.cloudflare.com/workflows/build/rules-of-workflows/),
[Agents with Workflows](https://developers.cloudflare.com/agents/runtime/execution/run-workflows/) and
[readonly Agent connections](https://developers.cloudflare.com/agents/runtime/lifecycle/readonly-connections/).
