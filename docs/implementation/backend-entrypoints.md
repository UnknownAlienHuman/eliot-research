# Implementation and removal plan

Updated 2026-10-17. [Architecture](../architecture/ELIOT_RESEARCH.md) and [root rules](../../AGENTS.md)
govern the selected product. This is the current queue; old ER/S packets locate source, not prerequisites.
Pick one behavior with its callers and writers/readers, implement it, and delete the replaced code/exports/
fixtures in the same integration. Independent work proceeds without waiting for unrelated migrations.

The earlier [inventory](../../.github/audits/2026-10-17/README.md#source-footprint-and-reduction-evidence)
counted 283,671 authored application/library lines. The below-100,000 objective is not achieved by this
branch's documentation/tooling deletions. Count those separately; package moves, Rust ports, generated files
or minification are not application-source reduction. Preserve actual data, not hypothetical compatibility.

## 1. Remove obsolete development machinery

**Frontend claim system removed in this branch:** the checker, diagnostic, dedicated self-tests, registry,
claim JSON, ER-49 fragment/document, optional CI provenance job and UI harness history command.
The existing frontend product and visual jobs are unchanged. No substitute scheduler or claims schema.

**Next bounded tooling change:** remove `scripts/check-work-packets.mjs`, the root `work-packets:check`
command/call in `package.json`, `docs/agent-work/manifest.json` and packet JSON after reconciling their actual
callers. `scripts/test-boundary-negative.mjs` still invokes `proveWorkPacketParityFailsClosed` and mutates
ER-17 through `withWorkPacketMutation`; remove only those obsolete cases/helpers, not unrelated boundary checks.
`scripts/check-docs-index.mjs` also parses manifest/fragments and requires every packet in the index. Replace
that dependency with ordinary current-document link checks, not another ownership/reachability framework.
It also requires START-HERE links in roots that the compact rewrite no longer contains; reconcile the
navigation rule with actual entrypoints rather than report the old checker as passed or preserve fake links.
Remove obsolete fragment instructions and stale file mappings with these callers. Do not keep a success stub.

Separately simplify `scripts/check-launch-code.mjs`: selected behavior, not exact AST statement counts or
canceled feature flags, decides readiness. Delete source-shape fixtures with that interpreter; retain actual
product checks. Do not expand this into another analyzer, registry or full-repository rewrite.

## 2. Remove canceled search-generation authority

Move `packages/cloudflare-ai/src/project-search.ts` consumers in Core `research-run-service.ts`, project
readiness and `cloudflare-research-runtime/src/research-retrieval-composition.ts` to the configured native
search instance with existing source/project filters. Remove registry-based readiness and before/after
fences. Preserve source admission, membership, actual delivery and provider-locator/evidence mapping.

Then retire writer-exclusive code in `cloudflare-projection/src/core-managed-items.ts`,
`core-managed-item-intent.ts` and `core-managed-item-receipts.ts`, with exports/callers/fixtures.
Existing R2/D1 projection execution is still needed; do not delete that executor or shared record readers
without moving their actual use. Done: upload/search/new admission without `ai_search_generation_registry`
as authority. This is code retirement, not permission to drop stored data or applied migrations.

## 3. Remove per-run model qualification renewal

Change Core `research-run-service.ts`, `research-workflow.ts`, and selected consumers in
`cloudflare-research-configuration/src/research-qualification-renewal.ts` and
`cloudflare-research-runtime/src/research-semantic-server.ts`. Validate at connection/selection;
keep the original attempt's selected model/transport, credentials, spend bound and cancellation.
Remove renewal callbacks/markers and proof expiry/revocation gates from new owner executions.
Saved results need no model renewal. Do not add another configuration/accounting service or retry an
uncertain paid invocation under a new identity. Settle actual old running attempts, not imagined consumers.

## 4. Assemble one ordinary answer

Use [the answer contract](research-full-answer-v1.md). Align the actual admission schema, owner client,
context builder, prompt, stream extractor and materializer together. `research-run-request.v5` is occupied;
`answer_markdown` and deep `material_claims` are not interchangeable output formats.
Prepare once, stream one synthesis, save report/summary and exact citations using existing evidence/result
owners. Whole-source reads need no search-readiness gate. Honor token, byte, checkpoint and memory bounds.
Remove ordinary branch-plan/freeze/audit obligations and their now-unused bridges. Deep research stays explicit.
Done: ask → provisional text → saved report → citation open/reopen, reconnecting to the same paid attempt.
No new settings service, token journal, citation registry or shadow executor; no extra approval to implement
this already selected behavior. An unavailable independent reviewer is a review limitation, not a coding blocker.

## 5. Simplify one owner read at a time

Choose history, catalog, project guide or Wiki/Inbox, including its existing writer and client.
Maintain summary fields in the same writer; return a bounded indexed page without opening every R2 body
or rebuilding model/grant proof chains. Delete the superseded owner-path helpers. Keep actual interface
permissions, paging and honest stale/unavailable state; exact source checks occur at citation opening.
Record query/R2/request counts and latency separately from source-size savings. No new cache/summary service.

## 6. Consolidate clients, then cut over React

Separate assignments: share one client between `apps/eliotr-web/src/app/runtime.ts` and
`owner-api-client/src/legacy/http.ts`; migrate `pwa-source-workspace/src/raw-file-api.ts` callers to
`owner-api-client/src/sources/import/raw.ts`; migrate `pwa-research-workspace/src/research-run-api.ts`
callers to canonical owner-client run methods. Delete duplicate protocols/decoders and move common exports
once through the manager. Preserve cancellation, disposal, errors and mutation identity, not permanent wrappers.

Finish the existing integrated Worker/Vite artifact and selected feature wiring. Move imports in
`apps/eliotr-core/test/retrieval-q1-fixture.ts` rather than keeping old clients for a test.
Follow the [cutover contract](frontend-platform-migration.md): standalone Inbox/recovery, inert `/sw.js`,
actual served asset/config switch and rollback artifact. Then delete Astro, old controllers/styles and unused
`pwa-*` dependencies. The earlier 21,137-line PWA/client cohort is not a promised net deletion of every line.

## 7. Simplify source identity and unselected integrations

For one ingest writer/reader, start at `contracts/src/residency.ts`, `domain/src/residency.ts` and
`platform-cloudflare/src/r2.ts`; then move artifact/evidence-coordinate readers. Use source/revision/
representation and a stored R2 locator. Reuse/backfill locators once; do not rename all objects or merge
independent lifecycles because bytes match. Remove the seven-domain serializer and exclusive transition
receipts when their actual callers move. Do not port that machinery to Rust under another name.

Separately remove `contracts/src/owner-cutover.ts` with its unselected bilateral-transfer path.
Treat backup export/restore, Drive Exchange, general federation and old exploratory executors as separate
assignments: inspect actual route/cron/Queue registrations, move selected consumers and remove exclusive code.
Keep ordinary downloads, `gemini-mcp` and connected-agent task/results. Backup starts at Core
`backup-primary-composition.ts` and unused `backup-o2` restore execution; `erasure-runtime.ts` still uses
cleanup, so do not delete both backup packages wholesale. Migrate needed credentials and finish actual cleanup.
For old execution stop admissions and settle running attempts; [saved report reading](workflow-checkpoints.md)
does not require retaining its old executor. Delete obsolete handlers/codecs/fixtures rather than adding versions.

## 8. Reduce storage scaffolding on the changed path

Simplify that mutation's intermediary records and JSON-heavy views/triggers. Keep unique/FK constraints
and atomic expected-revision predicates; zero changed rows must not allow dependent publication/outbox
writes to commit. No network/model/R2 effect inside the D1 transaction, and no second revision/event engine.
Inspect the real migration ledger before altering applied schema. Unapplied prototypes may be simplified;
unknown live data blocks destructive migration only, not unrelated source deletion. No production reset.

## Retained correctness and donor references

[Source findings](../../.github/audits/2026-10-17/README.md) apply to retained behavior, not every old subsystem.
C01/C02/C11: conditional R2 input writes and exact bounded readback distinguish conflict from unavailable;
never use an expected checksum as an observation. C03: align 256-KiB HTTP input and the 64-KiB persisted
input/checkpoint boundary through compact references, not one raised constant or a universal compatibility layer.
C05/C10: shared freshness bounds and set membership; 65 changed sources must not break a 64-item decoder.
C06: local size/shape checks precede requested paid verification, without adding a verifier to ordinary answers.
C07/#378/#379: at final verification keep exact retained-case membership; delete canceled assertions with code.

The [pinned donor reconciliation](../../.github/audits/2026-10-17/README.md#donor-reconciliation) remains reference:
native Cloudflare primitives, WeKnora's narrow summary/atomic-update patterns, and prepare-once context from
DocsGPT/SurfSense. No duplicate index/planner/citation/ACL/agent framework. Open Notebook's multi-call flow
is not the one-call ordinary path and its prompt hint does not enforce a search-count bound.
Reopen the specific source and license before literal reuse; no new dependency is selected by this plan.

Implement first; scoped compile/lint and minimal Clippy during development. Product tests follow assembly;
existing automatic CI is separate. Report actual removals, checks, data transitions and limitations in the PR,
not another status manifest, approval graph, diary or unmeasured performance claim.
