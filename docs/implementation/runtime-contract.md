# Runtime integration notes

Read only for changes at these boundaries. Product purpose lives in the
[manifesto](../architecture/ELIOT_RESEARCH.md); [the plan](backend-entrypoints.md) selects implementation;
[source lifecycle](source-lifecycle.md) and [ordinary answer](research-full-answer-v1.md) own their flows.

## Authentication and untrusted data

Authenticate owner requests through the existing Cloudflare Access/ingress verifier, including alternate routes.
Do not trust caller identity headers. Connected clients retain current project/operation disclosure checks.

Validate external request/provider data at entry and use typed values internally. Recheck mutable state only where
a write, cancellation, deletion or actual disclosure can change the result. Do not pass a model/grant/deployment
proof chain through every owner list.

Source text is untrusted data. It cannot add tools, change scope/budget/model/system instructions, create citation
labels or authorize an effect. Keep prompts, reasoning, credentials and raw provider frames out of browser output.
Escaping the prompt envelope is useful but is not authorization.

## Source and citation lifetime

A run captures exact selected source revisions. A newer head or project detach does not rewrite an active owner's
selection or a saved report. Purge/redaction/deletion can make bytes unavailable. External clients are rechecked at
their current disclosure boundary.

A citation is the retained readable revision plus exact byte range and optional display coordinate. Opening it
authenticates the reader, loads that revision, applies current deletion/disclosure state and reads one bounded range.
Never substitute the latest head. Content checksums identify observed stored bytes, not every function call.

## D1 and R2

D1 keeps prepared statements, uniqueness/FK constraints and atomic expected-revision transitions. Dependent writes
must share the successful predicate; zero changed rows is not an SQL error and must not leave partial metadata.
No model/HTTP/R2 operation runs inside a D1 transaction.

Use native R2 conditional create for immutable data. Reconcile uncertain acknowledgement by observing the exact key
and distinguishing same bytes, conflict and unavailable observation. Never substitute the expected checksum for an
observed one or invent a signed-receipt service around a narrow storage operation.

Large immutable input/output is stored once behind a locator. Do not repeat source bodies, provider responses or
complete candidate lists in every Workflow checkpoint.

## Provider execution and streaming

Use the existing model pin, route, operation and attempt identity. Cloudflare AI Gateway supports request retries,
but Eliot's selected paid-call path currently sets `cf-aig-max-attempts: 1`; preserve that for ordinary/deep model
effects unless the exact provider offers a proven idempotent continuation. Workflow retry is not permission to
redispatch an uncertain provider call.

For ordinary answers, consume the selected provider stream incrementally, normalize public text/final usage and
retain completed public Markdown once. Require a valid terminal provider event. HTTP 200, socket EOF or a browser
disconnect alone is not completion.

A failed browser delivery does not fail generation. A failed report save retries from retained public output.
Raw provider payload logging stays disabled for private material. Semantic caching stays disabled unless exact
scope/model/settings isolation is established; reopening a saved report already avoids regeneration.

## Workflow, Queue and ResearchSession

One Workflow owns a run. Queue accelerates existing persisted work. ResearchSession carries authorized coarse
progress and provisional public text; it owns neither execution nor canonical output.

Ordinary execution chooses its path before old handler/checkpoint assembly. Explicit deep research uses one bounded
search/read/finish loop. Old executors serve only already-admitted runs while they settle; completed reports are
read directly.

A slow/disconnected ResearchSession subscriber cannot block generation or save. Do not persist every token/event.
Reconnect reads canonical status/result and may resume new provisional deltas with an explicit gap.

## Run status and retained result

Status describes product behavior, not internal graph topology:

- run kind: ordinary or deep;
- phase: queued, preparing, generating, saving, completed, cancelled or failed;
- safe failure/cancellation;
- terminal result availability and report reference.

Do not expose `next_stage_index`, stage 18, handler generation or a provider frame as the durable public contract.
A temporary old-run adapter is removed after active old runs settle.

Owner lists read bounded metadata. Report bodies and citation bytes load on demand. A freshness comparison is
optional information and cannot hide an otherwise readable report.

## Derived content

Report/Wiki text and supporting citations change through one expected-revision/head transition. Automatic link
decoration is render-time or a new revision. When a contributor changes/deletes, mark affected derived content
stale and refresh on explicit request, selected maintenance or next meaningful reuse. Threshold-based maintenance
also needs a maximum age.

## Limits

Model token window, serialized request bytes, response bytes, Workflow checkpoint size and Worker memory are
different limits. Reserve output capacity before filling context. FULL rejects overflow; it never silently truncates.
Whole selected sources can be read before search indexing finishes.

The earlier C03 256-KiB HTTP versus 64-KiB persisted-input mismatch is a source finding, not a desired limit.
Align the actual producer, stored locator/checkpoint and readers in the changed path.

C01/C02/C11 storage observation and C05/C10 freshness findings remain bounded retained-code work. They do not
justify preserving unrelated proof, generation or compatibility systems.
