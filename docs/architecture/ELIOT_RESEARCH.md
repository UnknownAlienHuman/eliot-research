# Eliot Research: current architecture

Updated 2026-10-17. Selected target, not a claim that the implementation is complete.
This replaces the historical full-product specification for current development.
The owner's current instructions take precedence. [ADR-0019](../adr/0019-compact-refactoring.md)
records the scope reduction; [the implementation plan](../implementation/backend-entrypoints.md)
contains the remaining work. Do not restore discarded requirements from older documents.

## Product

A single-owner research application: keep sources, find and read them, ask questions,
produce cited answers/reports, maintain a Wiki, and exchange tasks/results with connected agents.
Library, Lens, Wiki, Inbox and explicit deep research remain useful product surfaces, not separate services.

The five delivery paths selected in [#377](https://github.com/UnknownAlienHuman/eliot-research/issues/377) are:

1. Project and sources → question → saved report with citations → reopen.
2. Upload project sources to managed search and observe their actual availability.
3. Review and publish a draft through Inbox.
4. Connect an agent and show its actual connection state.
5. Assign a task to that agent and read its result without duplicate dispatch.

Use the existing React/Vite application and owner API client. Astro is rejected;
its currently served assets are a cutover dependency, not a supported second frontend.
Preserve ordinary source/report downloads. Deferring a backup platform does not cancel file download.

## Runtime and modules

One `apps/eliotr-core` Cloudflare Worker serves API and static assets and composes existing
Queue, Workflow and ResearchSession bindings. D1 stores metadata and state; R2 stores file/report bytes.
AI Search or provider search supplies retrieval. Existing D1 Search is a projection to retain only
where an actual exact/lexical caller needs it, not a second indexing platform to develop.

| Responsibility | Existing homes | Keep together |
|---|---|---|
| Browser | `apps/eliotr-web`, `packages/ui`, `packages/owner-api-client` | One UI system, one query cache, one transport/decoder implementation |
| Sources and citations | `domain`, `cloudflare-raw-ingest`, `cloudflare-navigation`, `cloudflare-evidence` | Admission, stored revision, membership, exact source opening |
| Research | `research`, `cloudflare-research*`, `cloudflare-workflows` | One ordinary-answer path and one explicit deep path sharing context/model/result code |
| Models and agents | `cloudflare-ai`, `cloudflare-model-*`, `cloudflare-computer-agent` | Small adapters and existing task dispatch; no second agent scheduler |
| Reports and Wiki | `cloudflare-artifacts`, `cloudflare-wiki`, existing materializer | Stored content, citations, revision/head updates and Inbox publication |

These are responsibilities and existing locations, not a required package tree. Consolidate forwarding
packages into their actual owner. No new service, generic repository layer, event bus, graph engine or
per-capability crate is required. [Language ownership](LANGUAGE_RUNTIME_CONTRACT.md) remains TS/Rust/SQL.

## Sources, data and citations

A source belongs to the owner's Library and may be attached to multiple projects. Detaching it from
one project is not global deletion. An external import is a local snapshot with its origin recorded;
it does not transfer ownership of the upstream system.

Store source identity, revision, representation, R2 locator, size and useful metadata. Store project
membership separately. For new owner data, use ordinary IDs and direct locators, not a seven-domain
residency key. Existing locators may remain opaque strings; backfill a missing locator once rather than
retain a permanent old key-derivation engine. Do not merge independent lifecycles merely because bytes match.

A citation identifies an admitted source revision and a precise range in its stored representation.
The existing evidence resolver is the sole issuer/resolver of those references. A model-provided quote
or search URL is a candidate, not evidence. Match against source bytes and map to original coordinates;
ambiguous/missing matches stay uncited. Do not create a second citation registry, signature chain or proof store.
Keep an existing content checksum where it identifies/verifies real stored bytes; do not hash every record,
function argument, UI read or intermediate conclusion. An expected checksum is not an observed checksum.

D1 owns current metadata/head changes. R2 owns stored bytes, not a second state machine. Source revisions
and report revisions protect actual history; they do not require an event-sourced framework. Summary fields
are maintained by the same writers and read without rehydrating every referenced object.

Deletion is a normal authorized product operation with a small source-linked cleanup job when needed.
Track actual retained copies, search deletion and in-flight producers; report pending deletion honestly.
Respect real user retention choices, remove private cached/derived copies as applicable, and show a removed
citation as unavailable rather than silently substituting another revision. No cryptographic erasure
protocol, bilateral approval process or proof-of-deletion platform is required. This document deletes no data.

## Authentication and effects

Use Cloudflare Access and the existing ingress verifier for owner requests. Protect all entry routes;
a caller-supplied identity header is not proof of authentication. Connected agents retain the explicit
project/operation access needed by their selected interface, not implicit global owner privileges.
TLS, platform secrets, standard credential handling, input bounds and safe rendering remain.
Do not build custom encryption, key hierarchies, signed manifests or per-list authorization proof graphs.
Retire an old credential store only after needed secrets have been moved to the selected supported store.

Validate untrusted input once at its boundary. Internals use typed values and short ordinary functions.
Recheck only mutable state that can invalidate a write, cancellation, or an actual disclosure boundary.
Do not carry multi-client lease/qualification/deployment chains through every owner's list or draft read.

D1 uses prepared statements, unique/foreign-key constraints and short atomic expected-revision updates.
Keep dependent writes conditional on a successful update: zero changed rows is not a successful transition.
No model/HTTP/R2 call belongs inside the transaction. R2 uses native conditional writes where overwrite
would corrupt immutable input; reconcile an uncertain acknowledgement rather than assume absence.

Use the existing request/run/attempt IDs to prevent duplicate writes and paid calls. Reconnect never starts
another model invocation. Native retries do not make an arbitrary provider effect exactly-once: uncertain
provider outcome remains unknown until reconciled. Keep cancellation and a practical spend bound;
do not add another accounting, receipt-signing or distributed-transaction framework.

## Reads and ordinary answers

Owner lists use bounded indexed summary queries, without per-item R2 reads or model/grant requalification.
Load report content when opened and resolve source bytes when a citation is opened. Paginate actual data;
a bounded page or top-k result never implies completeness. Preserve a same-owner observed draft on a
transient failure, visibly stale; no prior observation means unavailable. Sign-out, principal change and
applicable deletion clear private state. Deployment changes alone do not erase the owner's draft.

Ordinary E0/E1 has four responsibilities, within the existing 4–5-step direction:

1. Validate and admit one request, capturing selected sources/model and the original attempt.
2. Prepare context once: whole selected sources when they fit, otherwise retrieval with explicit omissions.
3. Stream one synthesis through the existing provider transport. Text is provisional until saved.
4. Save answer, exact citations and useful summary once through existing report storage.

Token capacity, request bytes, checkpoint size and memory are different limits. Do not silently truncate
FULL context. Search readiness is not required to read already stored whole sources.
The [answer contract](../implementation/research-full-answer-v1.md) identifies the remaining integration.
An optional audit must not delay or erase an ordinary answer. Missing/invalid audit output means unverified.

E2/E3 explicitly enables deeper exploration, counter-search or verification when requested. Implement that
as one bounded Workflow/loop sharing ordinary primitives, not all historical executor generations.
ResearchSession projects progress and connection state; it is not another executor or canonical transcript.
On reconnect, return current run state/saved output. Replay of every provisional token is not a product requirement.

## Managed search, Wiki and agents

Use native indexing/ranking and the existing upload/membership delivery path. Remove S52's custom generation
registry, target manifests, promotion/rollback and proof layer from callers, not merely from the UI.
Retain project filtering and mapping from provider locators to admitted sources. A provider error is explicit;
it does not justify silently switching to another paid model or claiming that a corpus was searched fully.

Wiki/Inbox use existing artifact content and revision/head changes. A draft stays a draft until the selected
publication action; a model cannot approve itself. Keep useful edits, history and citations, without a second
Wiki database, generic artifact compiler DSL or mandatory independent verifier for each ordinary section.

Connected agents use existing task/MCP interfaces. Persist one task and its result in the existing lifecycle.
Google transport remains `gemini-mcp`. Full federation, cross-system source-owner transfer, Drive Exchange,
custom backup/restore execution and speculative connector frameworks are not current product scope.
A registered handler proves reachability, not that a feature must be supported forever. Retire unselected
routes and their exclusive code together; migrate any actual selected consumer to the surviving interface.

## Replacement and compatibility

The default is one current implementation. Change internal APIs and all their callers together; remove
old exports, wrappers, decoders, fixtures and obsolete documentation in the same coherent change.
An old test, an archived task or a hypothetical client is not a compatibility requirement.

Preserve actual sources, saved results and acknowledged user work, not every old way of producing them.
Prefer a one-time data conversion or a locator backfill. Drain/settle active old attempts before removing
their executors; displaying an old report does not require keeping its old execution graph. Any temporary
adapter belongs to a named observed consumer and leaves with that consumer's migration, not an indefinite promise.
Unknown deployment/data state blocks only a destructive migration, not independent source simplification.

Applied database migrations are history; merge alone does not make an unapplied prototype permanent.
Inspect the actual deployment ledger before changing the baseline. Unapplied/unreleased schema may be
simplified; deployed data needs an explicit migration, not a reset or a growing series of compensating patches.
React cutover preserves the standalone Inbox/recovery path, inert old `/sw.js` and a rollback artifact.
After switching callers, remove Astro source and obsolete clients; retaining an old artifact is not maintaining two UIs.

## What counts as progress

Working owner paths, fewer implementations, fewer runtime round trips, and less maintained source.
The working objective is below 100,000 authored application/library lines, not a quota to fill or a new CI gate.
Keep readable formatting. Moving code to Rust, another package, fixtures or generated files is not reduction.
Do not build a new audit/governance programme to enforce this document.

During implementation use scoped compilation/lint and minimal Clippy for changed Rust. Tests and product
acceptance follow the assembled product; existing automatic CI is not a claim that deferred work passed.
Measured performance and deployed-state evidence belong to the actual build, not architectural prose.

## Historical material

<a id="v29.1"></a>
The old v29.1 specification and its numbered ERC contracts are available in
[Git history](https://github.com/UnknownAlienHuman/eliot-research/blob/774e4f89b6266759161a10815840662455832395/docs/architecture/ELIOT_RESEARCH.md).
Old references to those sections describe that snapshot. They do not restore canceled product obligations.
No second copy of the old specification is added to the working tree.

Platform references checked 2026-10-17: [Access validation](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/),
[R2 conditional operations](https://developers.cloudflare.com/r2/api/workers/workers-api-reference/),
[D1 batch transactions](https://developers.cloudflare.com/d1/worker-api/d1-database/),
[Workflow retries](https://developers.cloudflare.com/workflows/build/sleeping-and-retrying/).
