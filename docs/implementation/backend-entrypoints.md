# Implementation plan

Purpose and boundaries: [product manifesto](../architecture/ELIOT_RESEARCH.md).
Existing names and source locations: [code map](dependency-map.md). Technical details: [runtime notes](runtime-contract.md).
This plan explains what to write, where and what it replaces. It is not a second manifesto or an approval graph.
Source anchors were reconciled against `de88154e`; targets below are not claims of completed runtime work.

## Choose a complete behavior, not a new foundation

Start from an owner action and follow browser → API → application → stored result. Implement the smallest
complete replacement with those callers. Remove the old logic, exports, decoders and obsolete fixtures in
that integration. Moving a wrapper or creating a parallel “clean” implementation is not completion.

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

**Where:** Core `research-run-service.ts` and `research-workflow.ts` under `apps/eliotr-core/src/`;
`packages/owner-api-client/src/research/runs/authority.ts`; `packages/cloudflare-research-runtime/src/`
(`research-workflow-application.ts`, `research-semantic-server.ts`, `research-synthesis-prompt.ts`, `research-answer-text.ts`).
Context already has `packages/policy/src/context-compiler.ts` and
`packages/cloudflare-model-control/src/research-model-prompt.ts`; use those owners rather than another planner.

Align one ordinary request and result through admission, context preparation, provider transport, parsing and
report materialization. `research-run-request.v5` already exists. The stream extractor expects `answer_markdown`;
the deep response's `material_claims` is not a substitute. Choose a coherent ordinary output shape and change
its real producer/readers together. [The answer note](research-full-answer-v1.md) covers the integration.

Prepare selected source material once, run one streamed synthesis, resolve citation candidates through the
existing `cloudflare-evidence` resolver, and save answer/citations/summary through existing report storage.
A quote matcher does not issue an EvidenceHandle and does not verify a conclusion's truth.
Apply FULL/AUTO/FRAGMENTS behavior with honest omissions and actual token/byte/memory bounds. Reconcile C03's
input/checkpoint representation along this path; do not copy the whole input into successive receipts.

Remove ordinary branch-plan, freeze, counter-search and mandatory audit dispatch. Retain explicitly selected
deep work as one bounded execution sharing context/model/result code, not all historical graph generations.
Reconnect observes the same attempt/result; no per-token durable journal, second executor or another run API.

**Model selection in the same path:** Core currently supplies `renew_qualifications`; its implementation is
in `packages/cloudflare-research-configuration/src/research-qualification-renewal.ts`. Move qualification to
connection/selection, capture the actual model/transport for the attempt and delete new-run renewal callbacks,
markers and proof-expiry gates. Keep credentials, cancellation, spend bounds and uncertain-effect recovery.
Changing current settings must not redirect an already admitted invocation to another paid model.

**Result:** ask → provisional answer → saved report → exact citation → reopen, without ordinary deep stages
or model requalification. Record real request/provider/save costs when exercising the assembled path.

## 3. Lightweight owner lists and normal report/Wiki updates

**Where:** `packages/cloudflare-navigation/src/catalog-service.ts` and the selected history/guide endpoint's
existing writer/client; `packages/cloudflare-wiki/src/` and `packages/cloudflare-artifacts/src/` for content/head updates.

Take one endpoint, not the entire navigation layer. Return an indexed summary page and maintain those summary
fields in its existing writer. Remove per-item R2 hydration and owner-path model/grant proof chains.
Do not invent another summary service, cache database or independently synchronized read model.
For freshness, align `source-revision-freshness.ts` in navigation with the current client decoder; replace
repeated linear membership scans with a set. More than 64 changed sources must not break an allowed larger scope.

For a selected report/Wiki mutation, update content reference, revision/head and its delivery intent atomically
through existing writers. Use the narrow WeKnora pattern below, not another artifact DSL/revision engine.
Keep SQL expected-state predicates; a zero-row update must not publish a success/outbox record.
C06's local shape/size check precedes a requested paid section verifier, never adding one to ordinary answers.

**Result:** list reads do not open every referenced object; normal edits have one clear write path and accurate
conflict handling. Check query/R2/request counts, not just code volume. Final behavior checks follow assembly.

## 4. Native managed search without a second control system

**Where:** `packages/cloudflare-ai/src/project-search.ts`; callers in run admission, project readiness and
`packages/cloudflare-research-runtime/src/research-retrieval-composition.ts`.

Use the configured native instance and current source/project filters. Remove generation-registry readiness,
hashing and before/after fences. Keep actual upload/membership delivery and mapping provider locators to admitted
sources. Upload acknowledgement and completed indexing are different observations; reflect actual item status.
Do not silently substitute provider-generated text for Eliot's selected synthesis/citation path.

Then delete writer-exclusive code from `packages/cloudflare-projection/src/core-managed-items.ts`,
`core-managed-item-intent.ts` and `core-managed-item-receipts.ts`, moving any actual shared reader first.
Retain the used R2/D1 projection delivery, not the canceled managed generation overlay.

**Result:** project upload/search/readiness works without `ai_search_generation_registry` as an authority.
Removing its code does not drop applied database tables or authorize deletion of source data.

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
of actual R2 writes wherever the retained product uses immutable input.

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

These are pattern references, not new dependencies. Pinned source is intentionally dated; API docs were
checked on 2026-10-17. Check the chosen source license before literal code reuse. A donor is useful when
it removes an identified Eliot implementation or supplies a selected missing behavior, not because it is popular.

| Source | Take / apply here | Do not bring along |
|---|---|---|
| [Cloudflare Items API](https://developers.cloudflare.com/ai-search/api/items/workers-binding/) | Native upload/status/list/delete for item delivery in task 4; remove the custom managed-generation authority. | A replacement promotion registry or upload-and-poll coordinator for every request; lost ACK still needs reconciliation. |
| [Cloudflare D1 batch](https://developers.cloudflare.com/d1/worker-api/d1-database/) | Existing atomic writers in task 3, with expected-revision predicates and dependent-write conditions. | ORM migration, transaction framework, or an assumption that zero affected rows abort a batch. |
| [Cloudflare R2 API](https://developers.cloudflare.com/r2/api/workers/workers-api-reference/) and [Workflow retry](https://developers.cloudflare.com/workflows/build/sleeping-and-retrying/) | Native conditional storage and durable execution through existing adapters in tasks 2/5. | Bespoke receipt/signature engine, duplicate scheduler, or automatic replay of an uncertain paid invocation. |
| [SurfSense `build_context` / `resolve_citations`](https://github.com/MODSetter/SurfSense/blob/7fb479c361414e1ffd180860eb0b5eb5afb0c4e3/surfsense_local/backend/modules/chat/prompt.py) | Group selected excerpts by source and map model-visible labels on the server in task 2. Reuse Eliot's context compiler and evidence resolver, including actual revision/range identity. | Its Python app, citation ID namespace, old-wrapper compatibility or regex as an injection boundary. An ordinal rewrite alone is not exact evidence. |
| [WeKnora `UpdateWithRevision` / `updateWikiPageRow`](https://github.com/Tencent/WeKnora/blob/005627b180c6c7509660b0a14401e463f48d53f8/internal/application/repository/wiki_page.go) | One transaction for the selected revision/update and explicit zero-row conflict handling in task 3; use existing D1 writers. | GORM, multi-dialect support, extra revision engine or enterprise policy topology. |

The [earlier donor record](../../.github/audits/2026-10-17/README.md#donor-reconciliation) remains optional reference.
DocsGPT overlaps the existing context preparation; no second planner is selected. Open Notebook's multi-call
Ask flow is not the ordinary one-call design. Do not turn rejected donor platforms into a new backlog.

## Handoff and checks

Follow [AGENTS.md](../../AGENTS.md): scoped compile/lint and minimal Clippy during implementation; product tests
and acceptance after assembly. For retained C07/#378/#379 assertions, check actual case coverage when running
the product checks; remove canceled-behavior cases with their code rather than restore obsolete semantics.

The change is complete when its selected behavior works through real callers and its predecessor is gone.
In the PR name the removed responsibility/duplication, actual checks and any remaining data/deploy transition.
No new status registry, repeated audit diary, independent-review fiction or code-size success claim.
