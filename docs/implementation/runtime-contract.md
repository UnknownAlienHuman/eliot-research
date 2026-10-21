# Runtime boundaries

Target contracts, not a claim that every predecessor has been replaced. The
[manifesto](../architecture/ELIOT_RESEARCH.md) owns purpose; [implementation](backend-entrypoints.md) owns work.
Use [source lifecycle](source-lifecycle.md), [ordinary answer/report](research-full-answer-v1.md),
[deep research](deep-research.md), [Wiki/Inbox](wiki-inbox.md) and
[session delivery](research-session-projection-protocol.md) for their concrete schemas and flows.
Do not duplicate those schemas in another cross-product contract.

## Access and source identity

Authenticate at the existing ingress verifier, including alternate routes; caller-supplied identity is not proof.
Owner reads check current ownership and deletion. Connected clients retain their current project/operation disclosure
boundary. Lists do not reconstruct historical grants, model qualification or deployment proof chains.

Source, report, proposal and tool text are untrusted data. They cannot add tools, change the selected scope/model/
budget, authorize effects or issue citations. The server resolves generated labels from its context map and validates
manual citation selections against retained revisions, representations, range bounds and current access/deletion.
Neither browser quotes nor search snippets become evidence by assertion.

A run keeps its selected revisions across newer heads and project detach. A citation opens its retained exact bytes,
never today's head. Purge/redaction can make it unavailable. A checksum identifies stored content, not truth or
permission. Saved reports remain readable when an optional freshness/search/model observation is unavailable.

## State and effects

| Fact | Owner |
|---|---|
| Source/report/page metadata, revision heads, Inbox decisions, run/attempt identity | Existing D1 application state |
| Immutable source, completed public model output and report/page bytes | R2 |
| Search candidates/index readiness | Disposable native search projection, not source authority |
| Durable research execution | One Workflow using the admitted run/attempt |
| Coarse progress and provisional text delivery | ResearchSession, never a second executor/transcript |

Use a deterministic key and native conditional create for immutable bytes. On uncertain acknowledgement, reconcile
that key as same bytes, conflict or unavailable. Then commit D1 pointers/heads/decisions in one short expected-state
transaction. No HTTP/model/R2 calls inside it. D1 zero-row UPDATE is not an error: dependent writes must share its
predicate or an aborting final guard. An unreferenced R2 object needs bounded retry/cleanup, not two-phase receipts.

An outbox exists only for real asynchronous delivery. Wiki publication already writes its change-feed row directly;
do not recreate its removed pseudo-outbox. Retry a failed save from retained output, not by rerunning generation.
Manual report/Wiki edits create a full expected-head revision without pretending to be a research/model operation.
Inbox acceptance records the owner's decision, not a certificate of truth.

## Model turns, recovery and delivery

Ordinary `lookup` dispatches before old inquiry/18-stage construction: prepare once → one streamed synthesis → save
report/citations → finish. Deep mode uses the same primitives in one bounded action-or-final loop. Initial tools are
`search` and `read`; final public text ends the loop. Saving/cancellation stay host-owned.

Capture route/model/operation/attempt before a paid call. Disable hidden SDK retries and provider fallback in the
selected turn; retain Gateway attempts at one. Durable execution is not exactly-once provider execution. Unknown
outcome remains the same attempt until reconciled, not an automatically purchased replacement.

Require a valid provider/SDK terminal event, not merely HTTP 200 or EOF. Persist one bounded completed public-output
object; do not persist each token, raw frame, prompt or reasoning trace. Deep tool results correlate by `(turn_id,
call_id)`, never completion order. Persist the normalized completed turn before its tool or report effect.

Session delivery is bounded and best-effort. Slow clients cannot block model consumption or saving. Disconnect is
not cancellation; reconnect reads the same canonical run and report, with an explicit provisional-text gap if needed.
A failed/partial turn does not become a complete report. Budget exhaustion does not silently buy a summarization call.

## Availability, limits and deletion

Status describes the operation and usable result, not stage numbers or historical handler generations. Owner lists
read indexed D1 metadata; bodies and citations load on open. Keep missing, denied, changed, partial and unavailable
observations distinct. A failed schema read is not proof that a database is empty or needs initialization.

Token window, request bytes, output bytes, receipt size, R2 object size and Worker memory are independent bounds.
Reserve answer capacity before packing context. FULL rejects overflow rather than truncating; whole-source reading
can bypass indexing. Current research HTTP remains 256 KiB; stored inputs/checkpoints use the bounded WorkflowObject
profile, while compact D1/step receipts retain their 64 KiB bound. Writers/readers agree on each actual limit.

Logical deletion hides the affected content immediately. Physical cleanup respects actual retention/holds and all
live references, including an accepted proposal reused by a Wiki revision. Orphan cleanup waits for a grace period
and fresh reference checks; it cannot race deterministic retry or resurrect deleted support. Reuse the existing
cleanup owner, not separate report/Wiki erasure engines. Portable-data readers move with their schema callers.

[Release and schema transitions](production-readiness-plan.md) governs destructive cutover and recovery. Stop affected
writers, preserve/convert real retained content and settle acknowledged paid work before dropping predecessors. An old
Worker bundle does not restore D1/R2. Keep actual source citations/results, not historical executors or fallback readers.
