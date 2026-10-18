# Runtime integration notes

Read only for changes involving these boundaries. Product scope lives in the
[manifesto](../architecture/ELIOT_RESEARCH.md); [the plan](backend-entrypoints.md) selects implementation and
[source lifecycle](source-lifecycle.md) owns intake/search/citation details.

## Place work at its actual boundary

Authenticate owner requests through the existing Cloudflare Access/ingress verifier, including alternate entry
routes; do not trust an asserted identity header. Connected clients retain their selected project/operation access.
Use platform/library TLS and secret handling, not a custom credential or cryptographic proof system.

Validate untrusted request/provider data at entry and use typed values internally. Recheck mutable state only where
a write, cancellation or actual disclosure can be invalidated. Do not pass a model/grant/deployment proof chain
through every owner list. Keep private provider frames, reasoning and credentials out of browser output.

Source text is untrusted data. It cannot add tools, expand scope, change budgets/system instructions or mint a
citation. Put stable application instructions before dynamic excerpts, generate citation labels on the server and
validate every model-selected action against runtime scope/capability. Escaping prompt envelope syntax is useful;
it is not the authorization boundary.

Owner lists read a bounded indexed summary page. Their existing writer updates needed summary fields in the same
change, without another summary service/database. Open report bodies and source bytes on demand. Preserve the same
owner's observed draft on transient failure with a stale indication; no prior observation means unavailable.
Sign-out/principal change and applicable deletion invalidate private state. Deployment renewal alone is not identity
loss. Browser retirement belongs to [the cutover note](frontend-platform-migration.md).

## Source revision and citation lifetime

A run captures exact selected source revision refs. A newer source head or project detach does not silently replace
those revisions for the owner. Purge/redaction/deletion can make them unavailable. An external connected client is
rechecked at its real project/operation disclosure boundary.

Use source/revision and the actual stored raw/readable locators. Keep existing locator strings or backfill them once;
do not rename all objects to simplify a key builder. Project detach is not source deletion. Search/index state is
derived and may be rebuilt without changing the source revision.

An ordinary citation is the retained readable revision plus exact UTF-8 byte range and optional display coordinate.
Opening it authenticates the reader, loads those bytes and validates the range. Missing/ambiguous/purged content is
unavailable; never substitute a newer revision. Keep a content checksum where it identifies real stored bytes, not
as an envelope for every function, authorization or response.

## Storage and effects

D1 keeps prepared statements, unique/FK constraints and atomic expected-revision changes. Dependent publication or
outbox writes require a successful update: zero changed rows is not a SQL error and does not automatically roll back
later statements. Use the existing writer/batch and predicates, not an application-only preflight or a new
transaction framework. No model/HTTP/R2 operation runs inside the D1 transaction.

Use native R2 conditional create where overwrite would corrupt immutable data. R2 evaluates conditional writes
atomically; a failed or uncertain acknowledgement is reconciled with bounded actual observation. Distinguish matching
bytes, an observed conflict and unavailability. Never replace an observed checksum with the expected value. Reuse
this narrow operation rather than signed receipts or another immutable-object service.

Cloudflare AI Search upload/indexing is asynchronous. Its per-item status is projection readiness, not canonical
source state. Direct readable-source operations do not wait for indexing. Provider snippets/scores locate candidates;
exact bytes and current disclosure come from D1/R2.

Use the existing run/operation/attempt IDs. Native Workflow retry does not make arbitrary paid HTTP effects
exactly-once. Recover the original attempt/output where possible or report unknown rather than silently invoke again.
Cancellation prevents new work; retain a practical spend bound. A failed report save retries the save from retained
output, not the model call.

Queue accelerates existing persisted work. ResearchSession projects the same Workflow's state; it neither executes
another graph nor stores a canonical transcript. Completed reports use saved-result readers or one-time conversion,
not their historical executor.

## Derived content and revisions

Persisted report/Wiki text and its supporting source refs change through one expected-revision/head transition.
Automatic link decoration is render-time or a new revision; it never rewrites old visible text by ID. Derived content
whose contributors changed is marked stale/unavailable until deliberately refreshed. A threshold-only background
refresh also needs a maximum age; otherwise rare changes can remain stale indefinitely.

Do not copy source bodies, every candidate or every token into checkpoints. Store a large immutable value once and
carry its locator. Compact state may retain unresolved questions, accepted citation refs, counters and the original
paid-output locator.

## Limits are integration inputs

The source audit at `4e53d5e2` recorded 256-KiB research HTTP input against a 64-KiB persisted planning/receipt
boundary (C03). Recheck actual constants in the changed path. Align producer, stored input, compact checkpoint and
readers; a large input uses a stored reference rather than repeated embedded copies.

Model token capacity, provider-request bytes, response bytes, checkpoint size and aggregate memory are different
constraints. Reserve answer/output capacity before filling context. Do not load an entire corpus, encode it
repeatedly or silently truncate FULL context. Whole admitted sources can be read without managed-search readiness.

C01/C02/C11 storage observation and C05/C10 freshness bounds remain source findings until implementation. They do
not justify retaining unrelated audited subsystems. The [ordinary answer](research-full-answer-v1.md),
[deep research](deep-research.md) and [TS/Rust/SQL note](../architecture/LANGUAGE_RUNTIME_CONTRACT.md) own their
specific integration; none requires an all-family port or compatibility platform.
