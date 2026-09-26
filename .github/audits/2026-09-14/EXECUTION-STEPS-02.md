# Execution steps 02 — Research, products, integrations and operations

Ordered checkpoints for S35–S77; original five-part PRs retain the specified contracts, canonical anchors and additional negative cases. Use the corrected U/W/B/F commands in [steps 01](EXECUTION-STEPS-01.md), not guessed domain-name package scripts. Baseline a2aca127; retain working implementations on current main. Every path marked NEW is a required addition, not an existing test or a successful result.

## Shared boundaries

All products use packages/research, the existing model/evidence/stage services and core research-stage-handlers.ts. Products select installed versioned prompts/output schemas, not another engine or task ledger. Preserve legacy E0/E1/E2 request behavior. W1 protected portfolio/debt references cannot change via APPEND; CHECKPOINT does not rewrite acceptance/lineage. Initial immutable planning manifest precedes CREATE. Changed protected inputs use explicit supersession. W3 model attempts, W2 step receipts and W1 inquiry events keep their different identities.

W filenames below are relative to apps/eliotr-core and run with `pnpm --dir apps/eliotr-core exec vitest run <paths>`. U runs root-included pure/PWA tests; B is actual automated `pnpm test:owner-e2e`, never the interactive Access launch. Existing cases are regression starting points: a new product must add the specified actual HTTP/factory/storage scenario. Zero tests, mocked application success and migration compilation alone are not acceptance. Actual external model/client quality and native platform behavior remain S93/S95.

For all new product profiles, add one **NEW** core test file per task, `test/product-sNN.integration.test.ts` (NN=41–46), invoking the real shared run/factory and readers. Controlled provider output must not bypass parsing/audit/admission. Test the approved positive outcome, wrong scope, invalid output, lost response/replay, and exact persisted citations. This names the test addition rather than inventing an existing product command.

## S35 — inquiry protocol · [#227](https://github.com/UnknownAlienHuman/eliot-research/pull/227)

1. Add the passport's strict versioned profile reference in parseResearchRunRequest; old E0/E1/E2 decoding remains unchanged.
2. Resolve an installed ProtocolRegistry profile through existing research-protocol-freeze. Persist required verifier/certificate/grade/lane/source-mode/stop obligations before execution; bind protocol identity to replay.
3. W: test/research-session.test.ts test/research-protocol-freeze.test.ts test/investigation-ledger-commands-d1.test.ts; add lookup/review/architecture-decision distinctions and profile-substitution negatives. Run `pnpm contracts:check`. Done: actual saved obligations, not model-chosen authority or technical PLAN acceptance.

## S36 — initial planning manifest · [#228](https://github.com/UnknownAlienHuman/eliot-research/pull/228)

36.1 build the deterministic immutable QuestionGraph/SourcePortfolio/HypothesisCard seed from literal input, supplied hypotheses and admitted metadata. 36.2 exact Work R2 readback then W1 CREATE using portfolio_ref. 36.3 branches consume that exact ref. 36.4 changed protected input uses S40 supersession; later model refinements use W3 and validated checkpoint/hypothesis observations, never protected APPEND.

W: test/investigation-ledger-d1.test.ts test/investigation-ledger-commands-d1.test.ts test/research-protocol-freeze.test.ts; **NEW** test/research-planning-manifest.test.ts covers actual manifest readback/restart. Two rivals/shared premise survive; ten copies of one origin are not ten independent confirmations. Illegal mutation remains denied in TS and D1.

## S37 — shared branch executor · [#229](https://github.com/UnknownAlienHuman/eliot-research/pull/229)

37.1 define the passport's common typed envelope and exact source read. 37.2 SUPPORT/COUNTER use S22 once. 37.3 ALTERNATIVE/CHRONOLOGY/IMPLEMENTATION/LITERATURE/SOURCE_AUDIT use the same executor only when required by installed protocol. 37.4 settle each model output through W3/R2, record W1 observations and deterministically reconcile. 37.5 dispatch from actual factory and recover stored attempts. Do not loop uncheckpointed paid calls inside one retryable native step; include declared branch work in the installed timeout/budget policy.

W: test/research-retrieve-branches.test.ts test/research-model-stage-handler.test.ts test/research-evidence-freeze.test.ts test/research-workflow-recovery.test.ts; **NEW** test/research-branch-execution.test.ts asserts each role's real output and failed/missing debt. Done: role artifacts reach freeze, duplicates/restart reuse one output, handler-to-technical-stub mutation fails. No new swarm/queue/ledger.

## S38 — lanes and verifier · [#230](https://github.com/UnknownAlienHuman/eliot-research/pull/230)

Register hypotheses/metrics/verifier before relevant exposure through existing W1 LANE_REGISTERED/OBLIGATION_REGISTERED. Only the registered verified actor issues acceptance; later metric changes become declared deviation/supersession. Confirmatory/mixed runtime dispatch must reach the required real handlers, not the baseline legacy-only lane guard. W: test/investigation-ledger-commands-d1.test.ts test/research-protocol-freeze.test.ts test/research-workflow.test.ts; **NEW** test/research-lane-verifier.test.ts includes valid independent verifier, wrong actor, late registration and mixed-lane separation. Missing external verifier yields a named unmet obligation; never execute arbitrary user code inside Worker.

## S39 — acquisition · [#231](https://github.com/UnknownAlienHuman/eliot-research/pull/231)

Bind approved acquisition to source-mode/destination/disclosure/revision and one operation. Corpus-only returns without external request. Reuse capture/conversion/admission, checking every destination/redirect and rejecting private/auth/error/partial payloads. Retain raw/normalized identity, parser and coordinate precision. Admission does not expand frozen scope: an outside member remains pending for explicit subsequent authorized scope/supersession before evidence exposure. Same unchanged request cannot spawn an infinite chain of new runs.

W: test/raw-capture-http.test.ts test/raw-markdown-conversion-http.test.ts test/raw-normalized-admission-http.test.ts and **NEW** test/research-acquisition-scope.test.ts. Captured evidence exact-resolves only after admission and authorization; snippet/unsafe redirect/substitution/post-freeze insertion fails. Run `pnpm ingest:check` and `pnpm evidence:check`.

## S40 — debt/completion/reopen · [#232](https://github.com/UnknownAlienHuman/eliot-research/pull/232)

Compute the existing nine dispositions from obligations/coverage/debts/waiver authority using existing domain decisions. Persist runtime debts as immutable referenced observations, not forbidden head-ref APPEND. Implement the passport's versioned reopen through atomic old/new W1 supersession, preserving historical report and revalidating changed premises plus dependents; transient same-run recovery is S15.

W: test/investigation-ledger-commands-d1.test.ts test/research-run-status.test.ts test/research-changes.test.ts and **NEW** test/research-reopen.test.ts. Replay produces one new intended revision, changed input conflicts, old hashes stay exact. Unknown denominator cannot support absence and unresolved debt is not silently waived.

## S41 — ASK/BRIEF · [#233](https://github.com/UnknownAlienHuman/eliot-research/pull/233)

Install output profiles over existing synthesis/audit/artifact path; FAST_SEARCH stays model-free. ASK separates observation/inference/limitations; follow-up binds prior investigation/result revision rather than unbounded chat. BRIEF preserves units, conditions, dissent and unknowns. W new product-s41 plus test/research-claim-audit-stage.test.ts test/artifact-draft-reader.test.ts. Two-turn RU/EN fixture keeps scope/support; outside post-freeze sources require reopen. U package tests and real semantic quality S93 are distinct.

## S42 — COMPARE · [#234](https://github.com/UnknownAlienHuman/eliot-research/pull/234)

Freeze target refs and axes, then select a shared-engine output profile. Each material cell has value/unit/conditions/time/version and exact support or explicit unknown. Missing is not zero; conversion must be declared/reproducible and recommendation separate from observation. W new product-s42 plus test/research-citations-stage.test.ts test/research-report-admission.test.ts. Different populations/versions/units remain different, unsupported numeric or foreign target fails, replay preserves artifact.

## S43 — hypothesis review · [#235](https://github.com/UnknownAlienHuman/eliot-research/pull/235)

Read S36 cards; S37 support/counter/rival roles and S38 named verifier produce explicit falsifier/test/evidence/conditions/next probes. Preserve failed probes and losing alternatives, not model confidence as acceptance. W new product-s43 plus test/research-protocol-freeze.test.ts test/research-claim-audit-stage.test.ts. Rival/confound fixture cannot upgrade exploratory to confirmatory or unknown to universally false.

## S44 — fact check · [#236](https://github.com/UnknownAlienHuman/eliot-research/pull/236)

Preserve original input bytes/hash and exact claim spans; unresolved splitting remains visible, not omitted. Use existing retrieval→freeze→AUDIT_CLAIMS and verdict vocabulary; source-wide support is not support in an incorrectly selected excerpt. W new product-s44 plus test/research-claim-audit-input.test.ts test/research-claim-audit-result.test.ts test/research-citations-result.test.ts. Cover all canonical verdicts, weakening/omission/negation/quantity/population/version errors and exact replay. Semantic splitting quality also requires S93.

## S45 — project/literature audit · [#237](https://github.com/UnknownAlienHuman/eliot-research/pull/237)

Freeze project snapshot and literature portfolio, classify spec/code/runtime observation/primary/secondary claims. Through shared branches/artifact save claim→support/counterevidence/gap/severity/alternative/next-probe matrix. W new product-s45 plus test/research-evidence-freeze.test.ts test/artifact-draft-reader.test.ts. Obsolete spec/file existence/inaccessible code/no-hit cannot become proof of implementation or absence. No unsolicited mutation of audited repositories.

## S46 — DEEP · [#238](https://github.com/UnknownAlienHuman/eliot-research/pull/238)

Compose S35–S40/S22 outputs under existing DEEP profile. W new product-s46 plus test/research-workflow.test.ts test/research-workflow-recovery.test.ts test/research-report-admission.test.ts. One E2 fixture requires independent evidence/countersearch; one E3 needs preregistered evaluation and named verifier. Missing requirement remains explicit, not grade downgrade or 18/18 illusion. Recovery keeps each completed model effect single; exact citations survive. No second scheduler.

## S47 — extraction/admission · [#239](https://github.com/UnknownAlienHuman/eliot-research/pull/239)

Classify actual raw conversion and normalized bundle against current source-admission/qualification contract: original bytes, parser, taint, omissions and qualified maps persist before canonical commit/outbox. Pre-normalized bundles do not require default model reprocessing. W Raw import/Intake from steps01; extend valid/degraded/corrupt/over-limit declared-format cases and run `pnpm ingest:check`, then B. No silent truncation/partial canonical success/fabricated native accuracy. Actual converter quality recorded separately.

## S48 — exact navigation · [#240](https://github.com/UnknownAlienHuman/eliot-research/pull/240)

Bind native-coordinate-map-adapter and navigation-service to admitted revision/producer; normalized offsets plus only qualified native page/line/cell/region mappings. W: test/navigation-service.test.ts test/navigation-persistence.test.ts test/structural-navigation-q1.test.ts test/source-revisions.test.ts. Add Unicode/table/code/map corruption and foreign-neighbor negatives; B source→map→section→parent/neighbors→citation. Missing maps lower precision, not guessed coordinates. Run `pnpm evidence:check`.

## S49 — Atlas · [#241](https://github.com/UnknownAlienHuman/eliot-research/pull/241)

Use orientation-service/materialization and S99 metadata scope. Save immutable Atlas with exact SourceCard/DocumentMap refs and represented/omitted source members. W: test/orientation-http.test.ts test/orientation-resilience.test.ts test/navigation-persistence.test.ts. Shared-source projects remain isolated; relevant and omitted-source changes invalidate appropriate views, unrelated project does not reset. Atlas route is not evidence or permission; B validates readable navigation.

## S50 — LOCATE · [#242](https://github.com/UnknownAlienHuman/eliot-research/pull/242)

Preserve raw literal/negative/ID query and direct-first lookup; rewriting off by default. Existing planner combines exact/lexical/structural/SEM, section dedup, family diversity and selective reranking with separate generations. W: test/retrieval-ident-lex.test.ts test/retrieval-generation-fences.test.ts test/research-query-sem.test.ts test/structural-navigation-q1.test.ts. ID/quote/vague/tail/diversity produce authorized exact bytes and truthful lane trace. No duplicate BM25/embedding engine or top-k absence. Quality S93.

## S51 — exhaustive · [#243](https://github.com/UnknownAlienHuman/eliot-research/pull/243)

Existing exhaustive-query/workflow services bind complete frozen denominator and shards. Bounded ranges overlap safely, persist exact counts/digests/cursors, deduplicate identical delivery and reject conflicting duplicate results. W: test/exhaustive-query-service.test.ts test/exhaustive-workflow-output.test.ts test/research-query-exhaustive.test.ts test/research-exhaustive-sections.test.ts. Independent oracle covers tail/page/range boundaries; missing shards cannot become complete absence. Include S99, cancel/restart/purge; large results are R2 handles.

## S52 — index lifecycle · [#244](https://github.com/UnknownAlienHuman/eliot-research/pull/244)

Connect admitted outbox to existing channel builders/readiness receipts. A serves while B builds; activate only exact complete count/hash/generation/quality evidence with CAS, pin serving generation and preserve purge on rollback. W: test/retrieval-generation-fences.test.ts test/library-readiness.test.ts test/research-query-sem.test.ts test/outbox-reconciler.test.ts; **NEW** test/index-generation-promotion.test.ts exercises actual store/promotion, partial B, duplicate event and rollback. Run `pnpm projection:check` and `pnpm delivery:check`. Native AI Search readback is S95.

## S53 — REPORT/COW · [#245](https://github.com/UnknownAlienHuman/eliot-research/pull/245)

Implement existing ArtifactCompiler interface through current materialization/readers: ArtifactSpec→identified sections/evidence/premises→reconciliation→revision. Missing/unaudited output remains draft. A/B/C edit B reuses A/C only if all contract/residency/evidence/premise refs unchanged, then exact R2 readback and head CAS. W: test/artifact-draft-store.test.ts test/artifact-draft-reader.test.ts test/research-report-admission.test.ts; **NEW** test/artifact-cow-compile.test.ts covers real compiler/edit/concurrent/lost-ACK/partial/export. No second report engine.

## S54 — publication · [#246](https://github.com/UnknownAlienHuman/eliot-research/pull/246)

Apply existing publication domain/Wiki publisher to exact revision/freeze/material claims/section completeness/dependencies/current policy. D0–D3 distinguish editorial publication and factual acceptance; edited claims cannot inherit previous audit. W: test/wiki-publication-store.test.ts test/wiki-service.test.ts test/research-report-admission.test.ts and **NEW** test/report-publication-barrier.test.ts. Cropped/unsupported/stale/wrong-value/revoked cases fail before head CAS; concurrent/replayed publish produces one correct head. Explicit D1 promotion policy is not D2/D3 authority.

## S55 — dependencies · [#247](https://github.com/UnknownAlienHuman/eliot-research/pull/247)

Record source→Wiki→sections→managed copy ArtifactDependencyManifest, including omitted-source/premise refs, with canonical revision settlement/outbox. Ordinary update marks targeted freshness; purge/revoke denies/redacts. W: test/research-changes.test.ts test/artifact-draft-reader.test.ts test/wiki-service.test.ts; **NEW** test/derived-dependency-replay.test.ts verifies full chain, lost notice/restart/actor-scope cursor. WIKI/ARTIFACT lanes retain accepted state and original lineage, no self-citation independence. `pnpm delivery:check` and `pnpm erasure:check`. No promise to delete uncontrolled prior downloads.

## S56 — EvidenceAtoms · [#248](https://github.com/UnknownAlienHuman/eliot-research/pull/248)

Existing distillation contract accepts only authorized triggers, not blanket ingest calls. Decode candidates and verify exact spans/modality/units/time/conditions before atom admission and ATOM lane. **NEW** test/evidence-atom-admission.test.ts in W, plus test/research-reference-manifest.test.ts and test/research-query-retrieval.test.ts. Unsupported stronger paraphrase/negation loss/invented ref denied; accepted atom resolves exact original bytes, no independent-source inflation, idempotent trigger, purge respected. `pnpm evidence:check`; real semantics S93.

## S57 — ArgumentMap · [#249](https://github.com/UnknownAlienHuman/eliot-research/pull/249)

Reuse existing relation contract and immutable navigation storage for typed premise/claim/objection/source refs and distinct native/parser/model/human-reviewed precision. Bounded ARGUMENT traversal does not convert co-occurrence into cause/entailment. **NEW** test/argument-map-query.test.ts in W plus test/structural-navigation-q1.test.ts. Exact source opening, foreign/fabricated relation, cycles, replay and purge verified. No graph database/full-corpus compilation.

## S58 — Workspace intake · [#250](https://github.com/UnknownAlienHuman/eliot-research/pull/250)

Follow selected official-client export→plan/observation→service capture/read→conversion→admission/status using one S10/S31 grant and explicit namespaces. Conversion spend separate; no owner capture preseed. W Raw import plus test/workspace-mcp-candidate-store.test.ts and **NEW** test/workspace-service-intake.test.ts for the complete HTTP chain. Exact bytes produce one revision/outbox; actor/observation/digest/namespace/revoke/unfunded failures occur at actual boundaries. `pnpm gemini:check` and `pnpm ingest:check`; external Google action remains separate evidence, not a request-body assertion.

## S59 — Google delivery · [#251](https://github.com/UnknownAlienHuman/eliot-research/pull/251)

Bind artifact revision/destination/comparison representation to existing Workspace plan. Authorized official connector does Google I/O; update pins real object ID, creation retains actual provider ID and proven reconciliation capability. Native Doc representation cannot be compared to unrelated PDF/Markdown bytes. **NEW** test/workspace-artifact-delivery.test.ts in W plus test/workspace-mcp-candidate-store.test.ts and test/artifact-draft-reader.test.ts; `pnpm gemini:check`. Correct content/parent/labels read back; uncertain create is reconciled or remains UNKNOWN without blind duplication/new Research. Managed copy feeds S55; native action S95.

## S60 — federation execution · [#252](https://github.com/UnknownAlienHuman/eliot-research/pull/252)

Existing seven-operation contract/service binds reserved jobs/outbox to actual retrieval/Research, exact result bundles and cancellation. Preserve peer fence/scope/manifest and W2/W3 identity; pack/read-only does not need synthesis. W: test/federation-service.test.ts test/federation-runtime-http.test.ts test/outbox-reconciler.test.ts; add actual execution completion/replay/lost-ACK/restart/cancel/revoke cases. `pnpm delivery:check`. Transport complete cannot strengthen research PARTIAL/UNKNOWN and candidate output cannot mutate client authority.

## S61 — independent wire client · [#253](https://github.com/UnknownAlienHuman/eliot-research/pull/253)

Extend test/federation-runtime-http.test.ts or add **NEW** test/federation-independent-wire.test.ts under core, with fetch-based requests and independent fixture bytes, not server codec imports. All seven operations, signatures/fence/manifest/cursor/range/retention/truncation/revoke tested; deliberately injected server encoding error must fail the oracle. W new/existing federation tests and `pnpm contracts:check`. Local test is not authenticated external-peer qualification; no invented federation package script/client database.

## S62 — erasure request · [#254](https://github.com/UnknownAlienHuman/eliot-research/pull/254)

Wire prepareErasureForOwner and existing prepare/permission/execute/status to actual owner HTTP/PWA. Bind namespace/source/case/current permission; Research grant does not grant erase. W: test/erasure-admission-policy.test.ts test/erasure-runtime.test.ts test/erasure-coordinator.test.ts; add request/reload/stale/expired/changed-input assertions and B disposable-data control. Requested/UNKNOWN/BLOCKED is not PURGED. `pnpm erasure:check`.

## S63 — managed purge · [#255](https://github.com/UnknownAlienHuman/eliot-research/pull/255)

Enumerate managed original/normalized/Work/index/derived/copy/backup dependencies; fence late producers and collect exact object-version/domain absence evidence through existing adapters. Hold/outage never pretends deletion. W test/erasure-coordinator.test.ts plus **NEW** test/erasure-derived-closure.test.ts extending actual manifests/stores and all affected readers. Duplicate observations cannot fill a missing location, late replay cannot resurrect/delete foreign data. `pnpm erasure:check`, `pnpm delivery:check`; native deletion/retention evidence separate.

## S64 — delivery recovery · [#256](https://github.com/UnknownAlienHuman/eliot-research/pull/256)

Connect existing scheduled reconciler/outbox/leases/consumer/inbox. Re-read receipt/current authority before effects; poison follows existing bounded native retry/DLQ, corrected authorized replay preserves original identity. W test/outbox-reconciler.test.ts and **NEW** test/queue-delivery-replay.test.ts with actual local producer/consumer/storage. `pnpm delivery:check`. Missing delivery recovered; duplicates/lost ACK/crash/stale lease/revoke/purge produce one result, never blind repeated UNKNOWN model call. Native DLQ test S95.

## S65 — backup adapter · [#257](https://github.com/UnknownAlienHuman/eliot-research/pull/257)

Reuse O2 epoch/coherent-cut/offsite/encryption/nonce/replay; source ports export all current classified authority columns and R2 manifests with bounded parts. OffsiteCopyAdapter uses an approved concrete destination and verifies ciphertext plus authenticated plaintext readback. U `packages/backup-o2`, plus **NEW** W test/backup-source-ports-d1.test.ts. Fresh/upgrade/current-schema/concurrent/corrupt/lost-ACK/expiry/nonce cases cannot yield partial receipt. No new crypto/export system. A controlled destination is not proof of independent offsite failure domain; approved target credentials are genuinely external input, not architectural guesswork.

## S66 — purge-first restore · [#258](https://github.com/UnknownAlienHuman/eliot-research/pull/258)

Implement the existing pending restore port against an explicitly isolated non-serving target. Verify epoch/parts/schema, apply independent current purge/policy before exposure/index upload, restore allowed objects/heads then rebuild S52. **NEW** W test/backup-isolated-restore.test.ts, plus S65 source-port and test/erasure-coordinator.test.ts. Pre-purge epoch cannot restore later-purged visibility; unknown frontier/partial/corrupt/restart keeps readiness closed. Old credentials never become active; native RPO/RTO receipt separate, no implicit production restore.

## S67 — rollback · [#259](https://github.com/UnknownAlienHuman/eliot-research/pull/259)

Existing deploy/index switch verifies target build against current schema/config/handler/resources, then independent readback. Preserve source/artifact heads, purge and policy. W S05 continuity and S52 index-promotion tests, plus **NEW** tests/deployment-rollback-ordering.test.ts through U for orchestrator failures. Compatible A→B→A preserves old operation receipts; unknown compatibility does not delete/recreate runs. Wrong target/CAS/lost ACK safe. Native rollback separately authorized, never data-snapshot restore.

## S68 — Steward · [#260](https://github.com/UnknownAlienHuman/eliot-research/pull/260)

Existing steward.ts and scheduled handler run bounded deterministic cursor checks over actual freshness/hashes/delivery/backup/purge/routes/usage. New explicit trigger may produce a semantic candidate; QueryHint needs existing verifier/Golden comparison before activation. **NEW** W test/steward-scheduled-pass.test.ts plus test/outbox-reconciler.test.ts. Unchanged pass zero model calls, duplicate trigger one finding, stale Wiki not automatically published, unknown not healthy. No daemon/autonomous erase/permission expansion.

## S69 — security · [#261](https://github.com/UnknownAlienHuman/eliot-research/pull/261)

Trace actual policy/manifest/context/output from source to model and client. Add **NEW** W test/research-disclosure-boundaries.test.ts, reusing test/research-reference-manifest.test.ts test/research-claim-audit-input.test.ts test/research-citation-attempt-binding.test.ts. Cases: viewer≠model/client, in-flight revoke, forged actor/citation/tool, injected erase/exfiltrate, unsafe acquisition URL and nested secret errors. PWA XSS checked by B. Permitted paths still work; prohibited effects/disclosure absent. `pnpm contracts:check`, `pnpm evidence:check`, `pnpm erasure:check`, existing repository lint/CI checks; do not invent a secret/license scan result or blanket exclusion. Native T5 separate.

## S70 — source owner/residency · [#262](https://github.com/UnknownAlienHuman/eliot-research/pull/262)

Use domain source-ownership/owner-cutover/residency and actual admission adapters. Shared project membership is not duplicate ownership; equal bytes do not authorize cross-key/retention reuse. W test/source-admission-service.test.ts test/source-revisions.test.ts test/ingest-promotion-authorization.test.ts plus **NEW** test/source-owner-cutover-d1.test.ts. Bilateral exact source-set/view/fence transfer converges under restart; stale/unilateral/implicit unsaved import denied. `pnpm ingest:check` and `pnpm contracts:check`. No separate ownership service.

## S71 — observability · [#263](https://github.com/UnknownAlienHuman/eliot-research/pull/263)

Populate existing content-free metrics/readiness/Connections with actual operation/generation/trace/error/latency and recovery action. Unknown or missing sink is not zero/healthy. **NEW** W test/operational-readiness-metrics.test.ts using actual model/outbox/purge readers; U PWA and B diagnostic view. Duplicate metrics do not double-charge; budget exhaustion preserves authorized evidence reads. Secrets/prompt/source text absent from output. Configured alert/native control receipt separate; no monitoring/accounting backend.

## S72 — session events · [#264](https://github.com/UnknownAlienHuman/eliot-research/pull/264)

Implement specified authenticated route over existing ResearchSession/W2/change receipts, actor/run-bound cursor, persisted-before-notify and native hibernation. Frames hold status/refs, not corpus/token URL. **NEW** W test/research-session-events.test.ts plus test/research-session.test.ts test/research-changes.test.ts. Disconnect/eviction/lost event replay committed sequence, no new run; slow consumer resync bounded, revoked/foreign/stale/late completion denied. Native hibernation S95; no broker.

## S73 — Library/project UX · [#265](https://github.com/UnknownAlienHuman/eliot-research/pull/265)

One project selector/source list/import flow; distinguish capture/conversion/admission/readiness. Shared source and attach/detach/update/history use existing revisions/CAS. Independent per-file import outcomes, stable accessible controls. U `apps/eliotr-pwa`, W Raw import/Intake plus new project mutation tests from S04, then B. Empty→two projects→shared source→revision→Lens→Research works without SQL/duplicates; partial/stale/reload/denied states honest. Keyboard/mobile/dark/light screenshots required, not UI rewrite.

## S74 — Connections · [#266](https://github.com/UnknownAlienHuman/eliot-research/pull/266)

Separate server/model/agent grant/Workspace action using actual diagnostic/readiness APIs and S31 form. Display checked operation/time and exact correction. W Client/new grant/new proof renewal cases, `pnpm gemini:check`, U PWA and B. Status refresh is not paid qualification; ERC revoke not external Google-consent revoke. No unselected legacy OAuth requirement or secret values on screen.

## S75 — Wiki/report UX · [#267](https://github.com/UnknownAlienHuman/eliot-research/pull/267)

Clear draft/published/revision views with claims/citations/history and exact-revision edit/review/publish/export from S53/S54. U PWA, W Artifact/Wiki/new COW/publication cases then B. Browsing old revision does not change head; edited unsupported claim cannot inherit audit; partial export not complete. A/B/C→edit B→publish→v1/v2 preserves allowed hashes across reconnect. No new renderer/workflow library.

## S76 — readable formatting · [#268](https://github.com/UnknownAlienHuman/eliot-research/pull/268)

Pin the selected compatible local dev formatter; exclude immutable fixtures/migrations/generated bytes. First ResearchSession and model attempt/spend methods, then bounded product file batches. Mechanical change separate from behavior; literal/template/SQL values unchanged. Run formatter directly only after dependency installed, `pnpm typecheck`, relevant W Workflow/Model and U changed packages. No ignore/minify/package splitting to game LOC; S90 owns measured artifact/runtime budgets.

## S77 — shared text primitive · [#269](https://github.com/UnknownAlienHuman/eliot-research/pull/269)

Begin actual wiki-owner-edit-proposal.ts boundedText and reader; characterize byte/UTF-16 units, empty/NUL/surrogates/control rules and errors. Extract one pure primitive in existing lower layer with explicit units; change equivalent callers individually after differential cases, never normalize bytes or merge incompatible wire contracts. W S04 new edit case and test/wiki-publication-store.test.ts, U changed package, `pnpm contracts:check` and `pnpm boundaries:check`. Exact historical IDs/errors preserved, duplicated primitive actually removed. S28/S78 own canonical bytes; no validator DSL.
