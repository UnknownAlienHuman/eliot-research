# Implementation plan

Purpose and boundaries: [product manifesto](../architecture/ELIOT_RESEARCH.md).
Existing names and source locations: [code map](dependency-map.md). Technical details: [runtime notes](runtime-contract.md).
This plan explains what to write, where and what it replaces. It is not a second manifesto or an approval graph.
Source anchors were reconciled against `de88154e`; the ordinary execution chain was inspected again at
`ba344566` on 2026-10-18. Owner list/history/freshness paths were traced at `a5f53d0d` the same day.
Native search/upload code and current Cloudflare capabilities were reconciled at `68da28d8` on 2026-10-18.
EdgeQuake and Eliot's existing fusion/structural-navigation paths were reviewed at `cd67c1cb` the same day.
Targets below are not claims of completed runtime work.

## Choose a complete behavior, not a new foundation

Start from an owner action and follow browser → API → application → stored result. Implement the smallest
complete replacement with those callers. Remove the old logic, exports, decoders and obsolete fixtures in
that integration. Moving a wrapper or creating a parallel “clean” implementation is not completion.
“Reuse an existing owner” does not mean preserve its whole API/control chain. Extract the needed operation,
move its actual callers and delete obsolete preconditions; never manufacture freeze/proof records to satisfy
an old factory. Plain in-process data does not need another protocol or persistence layer.

Prioritize a usable source → answer → citation → reopen path and responsive existing screens. Client cleanup,
ordinary research and individual summary endpoints can proceed where their files do not overlap. Search work
is not a prerequisite for whole-source questions; tooling/data migrations do not block independent product work.
No prescribed line count, package count or full-family Rust migration defines success.

## 1. One browser client and one interface

**Where:** `apps/eliotr-web/src/app/runtime.ts`, `packages/owner-api-client/src/legacy/http.ts`,
`packages/owner-api-client/src/sources/import/raw.ts`, and callers in the two `packages/pwa-*-workspace` packages.

`createBoundApis` currently constructs a legacy adapter and a second OwnerApiClient. First let the methods
share one client/lifetime. Move the legacy-shaped callers to canonical methods, then delete the seam;
do not keep a wrapper as the final architecture. Raw upload and research-run APIs are separate small migrations.
Keep cancellation, disposal, errors and original mutation identity, not duplicate validation/protocol logic.

Assemble the existing React/Vite app with the existing Worker. Move the Core fixture imports in
`apps/eliotr-core/test/retrieval-q1-fixture.ts`; tests must not keep old browser packages alive.
Complete [the served-asset cutover](frontend-platform-migration.md), including standalone Inbox/recovery,
inert old `/sw.js` and a rollback artifact. Delete Astro and unused `pwa-*` source/dependencies after switching
callers and the served build. A rollback artifact does not require two maintained UI codebases.

**Result:** the selected owner journeys use the same client and served React app; replaced client protocols
and presentation code are gone. This requires actual integration, not just changing `assets.directory`.

## 2. One ordinary answer through the existing run/result path

**Where:** Core `research-run-service.ts`, `research-workflow.ts`, `research-session.ts`;
`packages/owner-api-client/src/research/runs/authority.ts` and its `research/session-projection/` adapter;
`packages/cloudflare-research-runtime/src/`, `packages/policy/src/context-compiler.ts`,
`packages/cloudflare-model-control/src/research-model-prompt.ts` and `packages/cloudflare-model-transport/src/`.

[The answer implementation](research-full-answer-v1.md) now identifies the actual obstructing functions.
The request compiler sets `stream: false`; a compatibility response reader buffers JSON; the inner-JSON
`answer_markdown` reader has no production caller found by symbol search; the Session send guard permits
only snapshot RPC replies. Adding a UI event handler or toggling one boolean cannot connect this chain.

Select ordinary execution before generation-dependent handler/checkpoint assembly. Use direct application
steps: capture input → prepare selected passages → stream one synthesis → save/reopen the result. Keep the
native Workflow and original paid-attempt identity, not a second scheduler or dummy deep-stage records.
Refactor the existing context/prompt functions to consume typed admitted passages without Stage 5/10 freeze
lineage, expiring manifests or per-candidate hashed receipts. Size the selected request without serializing
and hashing the entire growing envelope on every trial. Token capacity is not a byte count.
Choose the needed path before keyword/embedding work; “simple” must not execute deep-mode preparation first.
Share prepared source passages across streaming and saved output. Batch only genuinely required unique inputs,
and reuse existing bodies rather than repeatedly hydrating the same source. See [EdgeQuake's shared path](edgequake-donor.md).

The ordinary model output is Markdown with server-mapped passage labels, not escaped Markdown inside JSON
or a mandatory `material_claims` ledger. Align selected provider request validation, streaming decoding,
[Session delivery](research-session-projection-protocol.md), client display and existing report writers together.
No simulated streaming of a buffered answer; no new citation store. FULL/AUTO/FRAGMENTS select context, not
separate execution engines. Whole-source reads do not wait for search indexing.

Move model qualification to connection/selection: remove Core's `renew_qualifications` callback and new-run
markers/proof-expiry gates from the ordinary path, including their implementation in
`packages/cloudflare-research-configuration/src/research-qualification-renewal.ts`. Keep selected credentials,
model/transport, spend bounds and cancellation. Current settings cannot redirect an already admitted call.

Store completed public output once; a failed report save reuses that output, never invokes synthesis again.
Provisional delivery is transient and cannot create/cancel/retry a run or establish saved status. Reconnect
reads the existing run/report. [Failure handling](failure-model.md) replaces the old universal receipt chain.
For execution progress, use native Workflow event subscriptions rather than another polling/history loop;
token delivery remains distinct. Evaluate native byte-stream step results instead of duplicating temporary
checkpoints. [The native path](cloudflare-native-path.md) records APIs, retention and actual integration limits.

**Result:** ask → progressive text → saved report → exact citation → reopen. Remove ordinary-only factory,
inner-JSON and proof wrappers/fixtures with their callers. Retain only the explicitly requested deep behavior;
removing it from the ordinary path is not the same as deleting its code. No additional approval graph or
new foundational framework precedes this integration.

## 3. Lightweight owner lists and normal report/Wiki updates

[Owner read implementation](owner-read-paths.md) defines three independent changes with current source
anchors, writer/client changes and deletion boundaries:

- **Project/Library pages:** keep the owner's empty-project list distinct from the source-witness catalog.
  Replace owner-only policy/fingerprint reloads with direct ownership/deletion predicates and keyset paging.
  The catalog already avoids R2; its repeated D1/authority work is the target. Optional readiness is not access.
- **Run/report history:** query stored D1 summaries instead of scanning candidates, reconstructing historical
  checkpoints and reading R2 to recover locators. Capture positive project attribution; EXCEPT-only matches
  must not consume the candidate budget. Replace six client history versions with the current summary shape
  and real continuation, without hiding older saved work or re-running old executors.
- **Report reopening/freshness:** authorize stored content separately from optional source-head comparison.
  Share one server/client schema: exact change count, bounded detail sample, explicit truncation or UNKNOWN.
  C05/C10 are not fixed by raising one array cap. Access/deletion failures must never become an advisory success.

For an actual report/Wiki edit, update the existing content reference/head and its delivery intent atomically.
Keep SQL expected-state predicates: inspecting zero changed rows after commit cannot roll back companion writes.
Use revisioned writes for persisted text; render-only link decoration must not rewrite an old revision.
C06's cheap size/shape check precedes a requested verifier, never adding one to an ordinary answer.
When a selected derived finding or link is written, retain its exact supporting revision/range through the
existing artifact/Wiki owner. On source update/deletion, replace the affected contributor set, not a union that
restores deleted support. Never match provenance by substring or call a changed source list a repaired summary.
Opaque affected summaries need explicit stale/unavailable handling; follow the actual retention decision rather
than automatically delete every historical report or start a full-library model rebuild.

**Result:** lists read metadata, reports read saved content, citations read exact source bytes. No new cache
service, summary database, compatibility platform or universal read policy engine. Measure actual calls and
latency when exercising the assembled paths; this documentation does not establish a speedup.

## 4. Native managed search without a second control system

**Where:** `packages/cloudflare-ai/src/project-search.ts`; callers in run admission, project readiness and
`packages/cloudflare-research-runtime/src/research-retrieval-composition.ts`.

[The native path](cloudflare-native-path.md) defines the replacement and its limits. The inspected upload loop
sends each section to two instances and repeats it per project; the prose lane already uses native hybrid search.
Use one selected native retrieval configuration and remove the duplicate lane/fusion work where it is redundant.
Prefer one item per useful representation and native chunking, not section copies with repeated context wrappers.
`packages/retrieval/src/fusion.ts` already owns local fusion; retain it only for independent retained lists,
not a second fusion of native hybrid components. Reuse structural-navigation headings/ranges and bounded
source reads for context expansion. Graph-to-source lookup from EdgeQuake is a separate, task-specific option,
not a reason to add entity extraction, PostgreSQL/AGE or all graph modes to the ordinary path.

Keep canonical R2 content and D1 source/membership/deletion state. Use existing Items delivery; an R2-source feed
is an alternative, not a second feed for the same content. Native upload acknowledgement is not completed indexing.
Do not block whole-source questions on search readiness or run upload-and-poll during list/question reads.

A source can be indexed once only where the real filter expresses its selected scope. Metadata has a small field
budget, indexed strings have a prefix limit, and stored arrays are not filterable. Compact revision filters must
fit the actual binding; oversized overlapping scopes need an explicit partition/projection decision, not a sliced
source list or global top-k post-filter masquerading as complete project search. Preserve full D1 identity checks.

Remove generation-registry readiness/hashing/fences, then writer-exclusive code in
`packages/cloudflare-projection/src/core-managed-items.ts`, `core-managed-item-intent.ts` and
`core-managed-item-receipts.ts`, moving shared readers first. Keep necessary source delivery and exact citation
mapping. A native generated answer cannot silently replace the selected model or trigger a second synthesis.

**Result:** upload/search/readiness without `ai_search_generation_registry` as authority or duplicate indexing
without a demonstrated scope need. Do not drop applied data or declare a speedup before the assembled path runs.

## 5. Retire identities, integrations and executors that do not serve the product

These are independent assignments, not prerequisites for rewriting every subsystem.

| Existing cohort | Write/move | Remove with the moved callers |
|---|---|---|
| `packages/contracts/src/residency.ts`, `packages/domain/src/residency.ts`, `packages/platform-cloudflare/src/r2.ts` | Use ordinary source/revision/representation plus stored object locator for one ingest writer/reader, then its actual artifact/evidence consumers. Reuse locators or backfill once. | Seven-domain key derivation and exclusive transition/proof machinery; do not port it to Rust or rename every object. |
| `packages/contracts/src/owner-cutover.ts` and its transfer consumers | A local imported source retains its origin; selected connected-agent work uses existing task/MCP interfaces. | Unselected bilateral source-owner transfer, its adapters, codecs and vectors. |
| Core `backup-primary-composition.ts`, unused `packages/backup-o2` restore execution | Keep normal downloads, needed credentials and actual cleanup called by Core `erasure-runtime.ts`. | Unselected export/restore platform; do not drop shared cleanup by deleting both backup packages blindly. |
| Drive Exchange and general federation routes/adapters | Check real route/cron/Queue registrations; move actual selected consumers to surviving interfaces. Keep `gemini-mcp` and agent task/results. | Unselected registrations and exclusive code. Reachability alone does not make a feature required. |
| Old exploratory handler generations | Stop old admissions, settle real running attempts, read/convert saved results directly. | Superseded factories, dispatch branches, codecs and obsolete fixtures. An old completed report needs no historical executor. |

Change internal formats and callers together. No compatibility for unpublished prototypes or imagined clients.
Preserve actual data with one-time conversion when required. Inspect the deployed migration ledger before
altering applied schema; unknown live state blocks only the destructive change. Do not replace one proof-heavy
identity system with an equally large “simplification” service. C01/C02/C11 still require correct observation
of actual R2 writes wherever the retained product uses immutable input. For an actual Rust operation,
[the Wasm note](rust-kernel-abi-versioning.md) replaces universal envelopes and per-call version checks;
existing self-test exports are not product integration or a reason to port canceled mechanisms.

## 6. Finish removing development machinery independently

Frontend claim checker/diagnostic/self-tests, claims/registry, ER-49 and the provenance CI job are already
removed on this branch. Generic packet enforcement remains: `scripts/check-work-packets.mjs`, its command
and caller in `package.json`, `docs/agent-work/manifest.json` and fragments.
Retire it with the packet-parity helpers/cases in `scripts/test-boundary-negative.mjs` and the manifest/index
dependency in `scripts/check-docs-index.mjs`. Keep useful ordinary link checks, not mandatory recursive reading
or another ownership framework. Do not delete unrelated product checks or return a fake successful result.
Separately remove exact AST-layout requirements from `scripts/check-launch-code.mjs` with their fixtures;
readiness must describe selected working behavior. Tooling work never becomes the next release bureaucracy.

## Donor choices tied to actual replacements

[The maintained donor register](donors.md) covers all 68 original repositories plus user-selected EdgeQuake.
[Its scoped review](edgequake-donor.md) separates reusable operations, source-level counterexamples and
cold/warm benchmark conditions; no full donor audit or speedup is implied. Each entry
identifies inspected evidence, useful behavior, an Eliot destination and excluded machinery. Scoped source reads,
older evidence, README-only inspection and unavailable content are explicitly different; none is a whole-repo audit.

[The Cloudflare native path](cloudflare-native-path.md) selects native ingestion/retrieval, model-call boundaries,
progress/checkpoints and operation accounting. Use it before importing a donor's equivalent infrastructure.
DocsGPT/SurfSense inform prepare-once context, ThinkEx informs optional extraction failure handling, WeKnora
informs body-free lists/atomic edits, and Onyx/RAGFlow inform scoped locate/read. No new runtime is selected.
Check a specific source/license before literal reuse. Update this register instead of creating another landscape
or importing every donor feature. Rejected platforms are not a new backlog.

## Handoff and checks

Follow [AGENTS.md](../../AGENTS.md): scoped compile/lint and minimal Clippy during implementation; product tests
and acceptance after assembly. For retained C07/#378/#379 assertions, check actual case coverage when running
the product checks; remove canceled-behavior cases with their code rather than restore obsolete semantics.

The change is complete when its selected behavior works through real callers and its predecessor is gone.
In the PR name the removed responsibility/duplication, actual checks and any remaining data/deploy transition.
No new status registry, repeated audit diary, independent-review fiction or code-size success claim.
