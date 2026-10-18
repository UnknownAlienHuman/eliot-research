# Runtime integration notes

Read only for a change involving these boundaries. Product scope lives in the
[manifesto](../architecture/ELIOT_RESEARCH.md); [the plan](backend-entrypoints.md) selects implementation.
These notes replace infrastructure details previously embedded in the manifesto.

## Place work at its actual boundary

Authenticate owner requests through the existing Cloudflare Access/ingress verifier, including alternate
entry routes; do not trust an asserted identity header. Connected clients retain their selected project/
operation access. Use platform/library TLS and secret handling, not a new credential cryptosystem.

Validate untrusted request/provider data at entry and use typed values internally. Recheck mutable state
only where a write, cancellation or actual disclosure can be invalidated. Do not pass the full model/grant/
deployment proof chain through every owner list. Keep private provider frames, reasoning and credentials
out of browser output; source text is data, not instructions or permission to perform another operation.

Owner lists read a bounded indexed summary page. Its existing writer updates needed summary fields in the
same change, without a new summary service/database. Open report bodies and citation bytes on demand.
Preserve the same owner's observed draft on transient failure with a stale indication; no observation means
unavailable. Sign-out/principal change and applicable deletion invalidate private state. Deployment renewal
alone is not identity loss. Detailed browser retirement belongs to [the cutover note](frontend-platform-migration.md).

## Storage and effects

Use source/revision/representation and a stored R2 locator. Keep existing locator strings or backfill them
once; do not rename all objects to simplify a key builder. Project detach is not source deletion.
An evidence reference resolves to that representation's actual passage; missing/ambiguous candidates stay
unresolved. Use content checksums where they identify real stored bytes, not as an envelope for every function.

D1 keeps prepared statements, unique/FK constraints and atomic expected-revision changes. Dependent
publication/outbox writes must require the successful update: zero changed rows is not a SQL failure.
Use the existing writer/batch and predicates, not an application-only preflight or a new transaction framework.
No model/HTTP/R2 call runs inside the D1 transaction. [D1 batch semantics](https://developers.cloudflare.com/d1/worker-api/d1-database/)
do not turn a zero-row update into a rollback automatically.

Use native R2 conditions where overwrite would corrupt immutable data. Reconcile a lost/uncertain write
acknowledgement with bounded actual observation; distinguish matching bytes, an observed conflict and
unavailability. Never substitute the expected checksum for an observed one. Reuse this narrow storage
operation rather than introduce signed receipts or another immutable-object service.

Use the existing run/operation/attempt IDs. Native Workflow retry does not make arbitrary paid HTTP effects
exactly-once. Recover the original attempt where possible or report an unknown outcome, rather than silently
invoke again under a new ID. Cancellation prevents new work; retain a practical spend bound.
Queue accelerates the existing persisted intent; ResearchSession projects the same Workflow's state.
It neither executes another graph nor stores a canonical transcript. [Execution retirement](workflow-checkpoints.md)
handles actual running attempts; completed reports use saved-result readers or one-time conversion.

## Limits are integration inputs, not product ideology

The source audit at `4e53d5e2` recorded 256-KiB research HTTP input against a 64-KiB persisted planning/
receipt boundary (C03). Do not treat that historical mismatch as a desired product limit or fix one constant
in isolation. Align the producer, stored input, compact receipt and readers; large inputs need a stored
reference rather than repeated embedded copies. Recheck actual constants in the changed path.

Model token capacity, provider-request bytes, response bytes, checkpoint size and aggregate memory are
different constraints. Bound the selected path; do not load an entire corpus, encode it repeatedly or silently
truncate FULL context. Whole admitted sources can be read without waiting for managed search indexing.
C01/C02/C11 storage observation and C05/C10 freshness bounds remain source findings until implementation,
not a mandate to retain unrelated audited subsystems. [Answer integration](research-full-answer-v1.md)
owns prompt/parser/materializer alignment. The existing
[TS/Rust/SQL note](../architecture/LANGUAGE_RUNTIME_CONTRACT.md) is implementation guidance, not an all-family port requirement.
