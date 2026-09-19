# Execution steps 01 — backend, authorization and machine ingestion

Applies to S01–S34 and S98–S99. This revision corrects the test instructions, not the product scope. Read the linked five-part assignment for its selected DTO, canonical references and additional negatives. Baseline: `a2aca1277b0edbbed04de66e0d44e383e1b815ef`; implement on current main without local worktrees. Retain working code and do not merge old planning/code branches wholesale.

## Verified commands — read this before executing any passport

Verified against root package.json, root/core Vitest configurations, the tracked core test tree, and tests/integration/browser/library.spec.ts. A command's existence is not a claim that its tests passed. Earlier verification mnemonics in planning text are superseded by the real commands below; do not create dummy package scripts to satisfy prose.

| Label used by these guides | Actual command and meaning |
|---|---|
| U | `pnpm exec vitest run <explicit-root-test-paths>`; root includes packages/**/*.test.ts, apps/eliotr-pwa/**/*.test.ts, tests/**/*.test.ts and infra/ai-search/**/*.test.mjs. It does not include core Worker tests. |
| W | `pnpm --dir apps/eliotr-core exec vitest run <test/file.test.ts ...>`; core configuration runs the local Cloudflare test runtime and migrations. Listed paths below are relative to apps/eliotr-core. |
| B | `pnpm test:owner-e2e`; actual node:test assertions including runOwnerE2E and Chromium. For the specific full browser case: `node --test --test-name-pattern="L6 real-browser owner harness" tests/integration/browser/library.spec.ts`. |
| R | `pnpm rust:check`; actual aggregate: rust:boundaries, rust:vectors, rust:fmt, rust:clippy, rust:test, rust:deny, rust:wasm, rust:coverage. Select the relevant real subcommand while editing. rust:test includes nextest and doctests. |
| F | `pnpm check`; full repository gate, run at the integration checkpoint, not after every small edit. |

`pnpm local:owner` is an interactive Access/Worker/bridge launch, **not** an automated browser test. `pnpm test:local-owner` tests its helpers; `pnpm test:local-launch` checks isolation/preparation, not the complete browser scenario. `pnpm local:prepare` and `pnpm local:smoke` are actual local build/migration/boot checks. None establishes live platform qualification.

`check:affected` currently repeats the full check chain and does not implement --base selection. Do not pass --base to it or describe it as cheap. Record PRE_TASK_SHA using git rev-parse HEAD, select explicit tests below, run `pnpm typecheck`, and inspect `git diff --check`. Finish the integrated checkpoint with F. Later independent failures remain reported failures, not a focused PASS upgraded to release readiness.

Actual optional static/domain commands: `pnpm contracts:check`, `pnpm boundaries:check`, `pnpm boundaries:negative`, `pnpm budgets:check`, `pnpm work-packets:check`, `pnpm branch-hygiene:check`, `pnpm delivery:check`, `pnpm ingest:check`, `pnpm projection:check`, `pnpm evidence:check`, `pnpm erasure:check`, `pnpm gemini:check`, `pnpm launch:code`, `pnpm check:implementation-status`, `pnpm lint`. Actual build/type commands: `pnpm cf:types`, `pnpm build`, `pnpm cf:dry-run`. These static checks supplement actual runtime assertions, not replace them.

There are no baseline scripts named research:check, retrieval:check, source:check, workflow:check, recovery:check, authority:check, owner:check, model:admission:check, artifact:check, backup:check, google:check, golden:check, numeric:check, assurance:check, steward:check, federation:check, federation:client-fixture, launch:registry, docs:index, docs:links, docs:routes, local:documents, wrangler:dry-run, rust:nextest or rust:check-contracts. Do not execute these labels, invent aliases, or interpret their absence as an application failure. Use the exact W cases below, U cases supplied by the owning package, existing static checks and R. New acceptance code explicitly marked **NEW** must be implemented and directly invoked before it can count as evidence.

### Existing core starting cases

Each row is a finite baseline test selection, not a claim that it already covers the new feature. W expands to the command above. Extend the named test or add the explicitly named NEW scenario. Zero selected tests is a failure; do not use --passWithNoTests.

| Group | Existing W paths |
|---|---|
| Intake | test/bundle-import-http.test.ts test/ingest-service.test.ts test/source-admission-service.test.ts test/ingest-promotion-authorization.test.ts |
| Raw import | test/raw-capture-http.test.ts test/raw-markdown-conversion-http.test.ts test/raw-normalized-admission-http.test.ts |
| Scope | test/scope-service.test.ts test/scope-persistence.test.ts test/research-held-scope.test.ts test/orientation-http.test.ts |
| Query | test/research-query-retrieval.test.ts test/research-query-sem.test.ts test/research-exact-search.test.ts test/research-trace-read.test.ts |
| Workflow | test/research-session.test.ts test/research-run-status.test.ts test/research-workflow.test.ts test/research-workflow-recovery.test.ts |
| W1 | test/investigation-ledger-d1.test.ts test/investigation-ledger-commands-d1.test.ts |
| Model | test/model-attempt-store.test.ts test/model-attempt-handler.test.ts test/research-model-stage-handler.test.ts test/research-model-attempt-revalidator.test.ts test/research-model-gateway-runtime.test.ts |
| Evidence/report | test/research-reference-manifest.test.ts test/research-evidence-freeze.test.ts test/research-report-admission.test.ts test/research-claim-audit-stage.test.ts test/research-citations-stage.test.ts |
| Artifact/Wiki | test/artifact-draft-store.test.ts test/artifact-draft-reader.test.ts test/wiki-publication-store.test.ts test/wiki-service.test.ts test/research-changes.test.ts |
| Client | test/mcp-client-diagnostic-http.test.ts test/mcp-client-diagnostic-roundtrip.test.ts test/workspace-mcp-candidate-store.test.ts test/federation-runtime-http.test.ts test/federation-service.test.ts |
| Delivery/purge | test/outbox-reconciler.test.ts test/erasure-admission-policy.test.ts test/erasure-coordinator.test.ts test/erasure-runtime.test.ts |

Control only external IdP/provider responses. The application authorization, D1/R2 and requested service path must be real. Some existing tests intentionally exercise only a store/helper: extend them with the named HTTP/factory scenario rather than assuming the runner makes every mocked component real. A future test filename below is an addition, not a claim it exists now.

## S01 — boundaries · [#193](https://github.com/UnknownAlienHuman/eliot-research/pull/193)

Run `pnpm boundaries:check`, retain each exact failure, and inspect scripts/check-boundaries.mjs plus the named import/export. Fix the two artifact reauthorization subpaths, qualification/retrieval import and two domain coverage imports only by correct dependency direction or an exact legitimate subpath. No wildcard, scanner exclusion or artificial package. Run `pnpm boundaries:negative` and `pnpm typecheck`. Done: all five original failures disappear and forbidden reverse/unknown-subpath cases still fail.

## S02 — diagnostic cause · [#194](https://github.com/UnknownAlienHuman/eliot-research/pull/194)

Modify tests/integration/browser/owner-e2e.mjs::preserveWorkerFailure. Retain safe assertion/phase/location and redact expected/actual/cause before printing. Add focused node:test cases in the existing browser test module for nested errors, token URLs, source text and oversized values. Run those with node --test and their actual test-name filter, then B to capture S03's real failure. Never label interactive local:owner as this test. Done: nonzero failure with actionable original assertion, no leaked content and correct cleanup.

## S03 — real raw import · [#195](https://github.com/UnknownAlienHuman/eliot-research/pull/195)

In raw-file-browser.mjs::runRawFileUploadOwnerScenario take baseline D1/R2 state before upload; await actual capture/conversion/admission rather than obsolete File saved text. Preserve application HTTP/storage. Add reload/replay and admission-failure assertions. Run W Raw import, then B. Done: one upload identity/revision/outbox and exact Library content, failed admission never successful. Change app code only with its reproduced regression.

## S04 — Project/Wiki D1 · [#196](https://github.com/UnknownAlienHuman/eliot-research/pull/196)

Call core project-owner-service.ts and the Wiki owner-edit service against current migrations. Extend W Artifact/Wiki and add **NEW** test/project-owner-mutation-d1.test.ts for actual project membership update/CAS; **NEW** test/wiki-owner-edit-mutation-d1.test.ts calls the actual edit producer. Commit/readback plus stale CAS must leave consistent heads/receipts/outbox. A deliberately over-deep D1 expression demonstrates the tested engine. Run both new W files and `pnpm contracts:check`. No copied SQL/DatabaseSync substitution.

## S05 — deploy continuity · [#197](https://github.com/UnknownAlienHuman/eliot-research/pull/197)

Implement the passport's backend-input fingerprint in existing research-deployment-authority logic, separately from git/PWA provenance. Connect currentness view, dispatch and status; do not modify original run receipts or non-deployment guards. Extend W Workflow and test/model-deployment-registry.test.ts; add **NEW** test/research-deployment-continuity.test.ts for PWA-only A→B→A, backend-changing B and unknown legacy evidence. Done: identical backend continues the old run without duplicate effects; unknown compatibility remains explicit. General backend rollback is S67.

## S06 — owner reauthentication · [#198](https://github.com/UnknownAlienHuman/eliot-research/pull/198)

Trace readResearchRunStatus through held-scope and historical authorization. Separate current verified read permission from saved execution credentials. W: test/research-run-status.test.ts test/research-held-scope.test.ts test/artifact-draft-reader.test.ts. Add two kid/iat sessions of one owner plus expired, revoked and foreign negatives. Done: same authorized historical bytes with no model call/new run; no ID-only grant and no retroactive credential edits.

## S07 — source history · [#199](https://github.com/UnknownAlienHuman/eliot-research/pull/199)

Reuse existing historical-reader correction. W: test/source-revisions.test.ts test/artifact-draft-reader.test.ts test/wiki-service.test.ts test/research-changes.test.ts; add actual v1→saved report/Wiki→v2→old citation case, then B. Compare original v1 hashes, not latest head. Purge/revoke must deny disclosure; local results are distinct from later native acceptance.

## S08 — replay scope · [#200](https://github.com/UnknownAlienHuman/eliot-research/pull/200)

Bind request identity to canonical original scope expression in research-session.ts and retrieval/query-persistence.ts. Do not freeze again to compare; old records without provable request identity conflict. Extend W Query: same key/expression yields same result, project A→B/source replacement/GLOBAL→PROJECT/query/product/limit change conflicts before effects. Run `pnpm contracts:check`. Preserve old snapshots/digests.

## S09 — semantic wiring · [#201](https://github.com/UnknownAlienHuman/eliot-research/pull/201)

Carry AI_SEARCH in both dependency constructors through stage factory, retrieve branches and retrieval composition. W: test/research-retrieve-branches.test.ts test/research-query-sem.test.ts test/research-workflow.test.ts. A controlled SEM-only tail locator must be returned through the actual Research factory and exact R2 resolver. Test absent binding/outage/stale/foreign/purge. Done: real SEM invocation/trace, not another search system or claimed live-quality score.

## S10 — one service grant · [#202](https://github.com/UnknownAlienHuman/eliot-research/pull/202)

Implement the specified project_client_grant DTO/table/authorizer shared with S31/S58/S98. Verified issuer/subject, owner ceiling, namespace and separate spend restrictions are authoritative; locator header is not identity. Add **NEW** test/project-client-grants.test.ts and **NEW** test/project-client-auth-http.test.ts under core. Exercise real D1 CAS plus signed HTTP/MCP equivalence, foreign/revoked/regrant/read-only/import/spend cases. Run W new files, W Scope/Client and `pnpm contracts:check`. Do not create a second grant system.

## S11 — machine Research · [#203](https://github.com/UnknownAlienHuman/eliot-research/pull/203)

Wire that service actor through actual query/run/status, scope/orientation, semantic preparation and Workflow; changing ROUTES alone is insufficient. Extend W Query/Workflow and new service HTTP test from S10. Done: one authorized service run with original DTO/idempotency/real actor/spend attribution; replay once, mismatch/foreign/revoke/unfunded before model effects. Owner regression remains valid.

## S12 — machine evidence · [#204](https://github.com/UnknownAlienHuman/eliot-research/pull/204)

Generalize existing artifact/section/citation readers, no clone. W Artifact/Wiki plus test/research-citations-result.test.ts: authorized owner/service hashes agree; foreign ID, denied project and purged dependencies reveal no bytes. Reading causes zero model calls/mutations and preserves DRAFT/accepted/freshness labels. Shared source is not blanket access to another report.

## S13 — MCP Research · [#205](https://github.com/UnknownAlienHuman/eliot-research/pull/205)

Extend the current dispatcher found by GEMINI_MCP_TOOLS with thin scoped catalog/query/run/status/report/citation handlers using S10–S12. Add **NEW** test/mcp-research-roundtrip.test.ts using the real dispatcher/storage, not a preauthorized helper. Run W new file and existing Client group, plus `pnpm gemini:check`. Done: initialize→tools/list→catalog→run→read with HTTP-equivalent IDs, safe replay and honest annotations. No browser cookie or second server.

## S14 — cancel · [#206](https://github.com/UnknownAlienHuman/eliot-research/pull/206)

Implement the specified cancel URL, empty DTO and Idempotency-Key. Durable W2 cancellation precedes native stop. Extend W Workflow with cancellation before/during/after I/O, completion-first and lost-ACK readback; add HTTP assertions for 200 confirmed CANCELLED, 409 completion won, 503 uncertain. Native stop failure cannot undo confirmed D1 cancellation. No later paid stage after canonical cancel.

## S15 — recover · [#207](https://github.com/UnknownAlienHuman/eliot-research/pull/207)

One authorized CAS winner invokes the specified recover action using W2/W3 readback. Paused, errored and completed native states differ; never invent a replacement run or blind UNKNOWN retry. W Workflow/Model: before failure SYNTHESIZE=1/AUDIT=0; after legitimate recovery SYNTHESIZE=1/AUDIT=1 with unchanged synthesis receipt/hash and separate audit reservation. Repeat/concurrency adds no duplicate model/restart action; insufficient audit budget is a lawful stop.

## S16 — DO terminal race · [#208](https://github.com/UnknownAlienHuman/eliot-research/pull/208)

Prove caller reachability and controlled await interleaving in ResearchSession.execute/cancel; do not state a live race from shape alone. Remove unconfirmed success, reconcile D1, atomically update short DO projection. Extend test/research-session.test.ts and test/research-workflow-recovery.test.ts in W. Done: cancel-first/completion-first/eviction agree with D1; no long I/O lock or non-atomic reread/save.

## S17 — runtime failures · [#209](https://github.com/UnknownAlienHuman/eliot-research/pull/209)

Trace semantic config→model/stage failure→status; preserve the first typed cause and stage, not AUTHORITY_STALE for everything or a later budget symptom. W Model/Workflow with missing config/credential, expiry, revoke, transient read and corrupt output injections. Expose safe codes/retryability; redact nested provider/source/token data. No error framework.

## S18 — launch completeness · [#210](https://github.com/UnknownAlienHuman/eliot-research/pull/210)

Correct scripts/check-launch-code.mjs against selected-profile composition, including partial/conditional handlers; reuse current implementation registry. Add **NEW** tests/launch-code-regression.test.ts, invoked by U. Run `pnpm launch:code` and `pnpm check:implementation-status`; record remaining genuine blockers, not a pretend green. Complete-code fixture needs no future live receipts; unselected legacy Google OAuth is not mandatory.

## S19 — transient disconnect · [#211](https://github.com/UnknownAlienHuman/eliot-research/pull/211)

At clearPrivateEvidence callers separate temporary network loss from logout/revoke. Keep current-tab question/run ID; hide/revalidate protected response, no implicit disk cache. Extend PWA tests via U `apps/eliotr-pwa`, then B. Done: offline/503 reconnect reads the same run without upload/synthesis; logout/revoked/late old replies cannot restore private data.

## S20 — targeted source refresh · [#212](https://github.com/UnknownAlienHuman/eliot-research/pull/212)

Pass confirmed source/revision identities to refreshAfterSourceAdmission and compare actual dependencies. Unrelated imports leave report/input open; relevant update changes freshness, not historical bytes. U `apps/eliotr-pwa`, W test/research-changes.test.ts and B two-project scenario. Duplicated events cause no model rerun; purge remains enforced.

## S21 — meaningful stages · [#213](https://github.com/UnknownAlienHuman/eliot-research/pull/213)

Derive status/trace classification from actual stage factory/output references: substantive, merged substantive work, technical only. Preserve old checkpoint IDs. W test/research-workflow.test.ts test/research-retrieve-branches.test.ts and U PWA. Done: replacing a meaningful handler with technical bytes fails obligation completion. S35–S46 implement absent behavior; no 18-agent framework.

## S22 — counter-search · [#214](https://github.com/UnknownAlienHuman/eliot-research/pull/214)

Real COUNTER_SEARCH uses S35 installed profile and existing retrieval/exact evidence; persist contradictions/failed probes before reconciliation/freeze. Share output with S37, not duplicate the search. W test/research-retrieve-branches.test.ts test/research-evidence-freeze.test.ts test/research-claim-audit-stage.test.ts. Tail counterexample reaches report; sampled no-hit stays inconclusive. No external call in corpus-only mode.

## S23 — fallback · [#215](https://github.com/UnknownAlienHuman/eliot-research/pull/215)

Preserve selected_document_fallback metadata in trace/EvidencePack, not false LEX relevance. W test/research-query-retrieval.test.ts test/research-query-sem.test.ts test/research-trace-read.test.ts with answer/counterexample in tail. Relevant hit cannot be displaced by arbitrary intro. No completeness/absence from fallback and no whole-corpus model pass.

## S24 — multiline input · [#216](https://github.com/UnknownAlienHuman/eliot-research/pull/216)

Preserve LF/CRLF/tab/exact question bytes in checkQuery/PWA/model preparation; reject malformed Unicode, NUL, isolated CR and prohibited controls before encoding. W test/research-session.test.ts test/research-query-retrieval.test.ts, U PWA and `pnpm contracts:check`. Changed LF→CRLF with same key conflicts; actual envelope max/max+1 and old short queries pass. No silent trim or replacement arbitrary cap.

## S25 — Wiki write/read · [#217](https://github.com/UnknownAlienHuman/eliot-research/pull/217)

Use actual owner edit producer/reader with all migrations, not only 0064. Extend S04's NEW Wiki edit D1 case plus W test/wiki-publication-store.test.ts. BMP/emoji/NUL/surrogate/ref boundaries accepted by writer must round-trip; rejected requests leave no heads/receipts/outbox. If normal writer already denies, retain regression rather than invent exploit/redundant trigger. Preserve atomic CAS/policy/immutability.

## S26 — Research screen · [#218](https://github.com/UnknownAlienHuman/eliot-research/pull/218)

Recompose existing PWA panels/CSS: sources, central question/result, exact citation pane. Move schema/proof diagnostics into Connections/details; compact history. U `apps/eliotr-pwa` and B: primary action visible at 1440×900 and usable narrow/keyboard. No fake READY/new frontend framework; other screens are S73–S75.

## S27 — branch cap · [#219](https://github.com/UnknownAlienHuman/eliot-research/pull/219)

Remove ceiling/dated exceptions/count-age eviction, retain proven integrated/open-PR/default/protected/head-SHA safeguards. Run `pnpm branch-hygiene:check` and update procedural docs. Race with new PR or head change cancels cleanup. Do not delete unmerged user work or replace cap with a whitelist.

## S28 — serializer pair · [#220](https://github.com/UnknownAlienHuman/eliot-research/pull/220)

Replace only retrieval/service.ts::canonicalJson recursion with query-codec.ts::canonicalRetrievalJson. Preserve service RetrievalQueryError mapping, digest inputs and type-only reverse import. U `packages/retrieval`, W Query, `pnpm boundaries:check` and `pnpm typecheck`. Stored bytes/IDs/errors unchanged; incompatible evidence codec remains separate.

## S29 — immutable config · [#221](https://github.com/UnknownAlienHuman/eliot-research/pull/221)

Reuse strict parser and Work R2 readback for one non-secret config revision/ref/digest instead of split JSON assembly. Old-or-new transition rejects mixed sources; cache immutable bytes only. W Model/Workflow and `pnpm test:provisioners`. Wrong version/missing/corrupt config fails before dispatch; frozen prompt/schema and secret separation survive restart/rollback. No configuration service.

## S30 — status and documentation · [#222](https://github.com/UnknownAlienHuman/eliot-research/pull/222)

Reconcile actual owner import/retrieval/Research callers with existing registry/gaps/START-HERE and observed deployment. Run `pnpm check:implementation-status` and `pnpm work-packets:check`. Historical audit mentions documentation-index findings; locate the named scripts with git ls-files before invoking a direct node path. If those scripts are absent at the selected tree, record that fact and repair broken index entries/links by inspecting their tracked references; do not run invented docs:* aliases. Add a focused U regression only for an actual implemented document check. No optional profile promoted to mandatory, no new registry or file-existence-as-live proof.

## S31 — grant issuance · [#223](https://github.com/UnknownAlienHuman/eliot-research/pull/223)

Exact owner GET/PUT/DELETE under /api/v1/research/projects/:project_id/client-grants uses S10 DTO/store and existing project CAS. Add small Connections form, explicit operations/namespaces/spend; configured Client ID is not connection proof. W new grant/auth tests from S10 and B: clean DB→owner-issued grant→signed service request; revoked/regrant/stale/CSRF/overprivileged deny. No manual SQL/second project route.

## S32 — Stop/Recover clients · [#224](https://github.com/UnknownAlienHuman/eliot-research/pull/224)

PWA/MCP call S14/S15 unchanged ID/action key/status DTO. Show pending/uncertain until readback, not message-substring or optimistic cancel. U PWA, W Workflow and new MCP roundtrip, then B. Reload/repeated clicks cause no repeated completed synthesis; first legitimate audit remains permitted.

## S33 — execution lifetime · [#225](https://github.com/UnknownAlienHuman/eliot-research/pull/225)

Separate server execution allowance from browser/snapshot TTL at loadHeldResearchScope callers. Same frozen members, upstream grant ceiling and authorized deadline only; no browser token storage or new heads. W Scope/Workflow with times before/after TTL and true upstream expiry/revoke/purge/cutover/cancel. Authorized run survives without a tab; real revocation stops new dispatch and preserves permitted history.

## S34 — model renewal · [#226](https://github.com/UnknownAlienHuman/eliot-research/pull/226)

Connect existing readiness/renewal stores to dispatch with correct Run/Read credentials. W test/model-deployment-registry.test.ts test/research-model-gateway-runtime.test.ts test/research-model-attempt-revalidator.test.ts plus **NEW** test/research-proof-renewal-http.test.ts. Fresh proof makes zero renewal calls; concurrent expiry uses one authorized attempt and exact native-route readback. Status GET is model-free; UNKNOWN not blindly repeated. Saved evidence remains readable under valid rights.

## S98 — machine intake/attach · [#290](https://github.com/UnknownAlienHuman/eliot-research/pull/290)

Existing normalized bundle lifecycle uses S10/S31 ingest.bundle/namespace delegation and real service identity. Attach through guarded existing project PUT: unchanged title, superset membership, expected revision and independently authorized new admitted source. W Intake/new grant/new project mutation tests; add **NEW** test/machine-ingest-project-roundtrip.test.ts for clean owner grant→upload→attach→query/run/citation. Deny rename/detach/foreign/stale/revoke atomically. Replay creates no duplicate revision/outbox and old run scope never expands.

## S99 — larger project · [#291](https://github.com/UnknownAlienHuman/eliot-research/pull/291)

Use existing larger scope loader/profile through owner orientation, stage factory, freeze/coverage and historical reads; replace fixed witness LIMIT65 with bounded complete metadata. Preview64/top16 is not denominator. Extend W Scope/Query/Workflow and add **NEW** test/research-large-project-history.test.ts: 65/299 admitted sources, tail evidence, JWT/source update/history, one foreign or purged member, real envelope max/max+1. No corpus bodies in memory, silent truncation, second scope store or claimed semantic completeness. Later quality is S93.
