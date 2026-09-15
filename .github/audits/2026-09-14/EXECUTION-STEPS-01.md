# Execution steps 01 — stabilization, authorization, and headless ingestion

These are the ordered implementation checkpoints for the existing assignments S01–S34 and S98–S99. Read the linked PR's five-part specification for its documentation anchors and full negative cases. This guide supplies the execution sequence, actual starting points, and observable stopping condition; it is not another backlog or runtime framework. All paths below are relative to the repository and were checked against baseline `a2aca127`. Newly suggested regression files are explicitly marked **new**.

## Working commands and proof boundaries

Use the pinned Node/pnpm and frozen lockfile. Record PRE_TASK_SHA before the first code edit, not the old audit SHA. Work in current main without local worktrees; do not check out a planning branch or wholesale merge an old thematic implementation.

- **U:** `pnpm exec vitest run <package-or-PWA-test-path>` from the root. Root `vitest.config.ts` does **not** include core Worker tests.
- **W:** `pnpm --dir apps/eliotr-core exec vitest run <test-path>`; the core configuration uses the real local Cloudflare runtime, current D1 migrations, and `env.test`. A `node:sqlite` adapter is not a substitute for this command. A new integration regression belongs under `apps/eliotr-core/test/` and must be invoked here.
- **B:** `pnpm local:owner`; document-import changes also use `pnpm local:documents`. Run focused tests during edits, then the relevant full browser scenario once the task is integrated. Do not repeat the whole suite after every text change.
- **Finish:** task-specific commands below, affected typechecking, `pnpm check:affected -- --base=<PRE_TASK_SHA>`, and a short result in the owning PR: implementation SHA, exact command/exit result, original failing case, resulting durable IDs/hashes. Do not infer a global PASS from an affected PASS.

Authentication tests control the external signer/IdP, not application authorization. W1/W2/W3, D1, R2, and the actual application request chain remain real. An invented runtime field, command, or existing filename is not acceptable: proposed new files/DTOs are labeled as additions in the owning task. Keep source content, provider payloads, tokens and cookies out of test reports.

## S01 — boundaries · [#193](https://github.com/UnknownAlienHuman/eliot-research/pull/193)

1. Run `pnpm boundaries:check` and retain the exact five import specifiers. Start in `scripts/check-boundaries.mjs`, `packages/cloudflare-research/src/artifact-draft-reader.ts`, `research-qualification-prompt.ts`, and the two named coverage readers in `cloudflare-research-stages`.
2. For each import, check the exported symbol and package direction; correct an invalid dependency or register only an already legitimate missing subpath. No wildcard/ignore or artificial package split.
3. Run `pnpm boundaries:negative` and affected typechecking. **Done:** five original failures gone, forbidden reverse dependency and unknown subpath still fail. A later browser failure is a separate issue, not reason to weaken this fix.

## S02 — browser diagnostics · [#194](https://github.com/UnknownAlienHuman/eliot-research/pull/194)

1. In `tests/integration/browser/owner-e2e.mjs::preserveWorkerFailure`, retain the original assertion identity, phase and safe expected/actual fields instead of replacing them with a generic error.
2. Test nested causes, a token-bearing URL/header, source text, and an oversized value through the same output formatter. Never attach an unsanitized Error as a printable cause.
3. Run the existing failing upload scenario and hand S03 its exact assertion. **Done:** error remains nonzero, cleanup runs, private content stays redacted, and the actual cause is visible. Do not interpret `unknown:61` as 61 application errors.

## S03 — actual raw import · [#195](https://github.com/UnknownAlienHuman/eliot-research/pull/195)

1. Reproduce S02's diagnosis in `tests/integration/browser/raw-file-browser.mjs::runRawFileUploadOwnerScenario` and `apps/eliotr-pwa/src/raw-file-panel.ts`.
2. Take D1/R2 baseline before the action; wait for actual capture→processing→admission completion, not the obsolete `File saved` phrase. Keep production HTTP and storage in the test.
3. Reload and replay the same upload identity, then test failed admission. Run B plus `pnpm local:documents`. **Done:** one logical upload/admitted revision, correct Library source after reload, failure not presented as success. Change application code only for an independently reproduced application defect.

## S04 — Project/Wiki D1 regressions · [#196](https://github.com/UnknownAlienHuman/eliot-research/pull/196)

1. Call the actual `apps/eliotr-core/src/project-owner-service.ts` and Wiki owner-edit path after applying all core migrations in W; do not copy their SQL into a SQLite fixture.
2. Add commit and stale-CAS cases, checking head, receipt and outbox before/after. Add a deliberately over-deep expression to prove the test engine enforces D1's depth boundary.
3. **Done:** both real services execute successfully; stale state rolls back without partial writes. This is not a rewrite of all database tests; S91 covers the remaining families. Run W, `pnpm artifact:check`, and the relevant project/browser regression.

## S05 — deployment continuity · [#197](https://github.com/UnknownAlienHuman/eliot-research/pull/197)

1. In `scripts/lib/research-deployment-authority.mjs`, identify the exact retire/activate operation and its readers in `research_workflow_current`, `research-workflow.ts`, and `research-session.ts`.
2. Implement the selected reproducible backend-input compatibility fingerprint separately from build provenance. PWA assets are excluded; actual backend modules, schema/handler/config inputs and execution-affecting bindings are included. Preserve original run/receipt provenance and all non-deployment guards.
3. Test PWA-only A→B→A, a backend-changing B, and missing legacy fingerprint evidence. **Done:** identical-backend runs continue with original checkpoints; unknown compatibility is explicit, not automatically allowed. Run W plus `pnpm workflow:check` and `pnpm recovery:check`. Arbitrary backend upgrades/rollback are S67, not silently accepted here.

## S06 — owner session refresh · [#198](https://github.com/UnknownAlienHuman/eliot-research/pull/198)

1. Trace `research-session.ts::readResearchRunStatus` through `research-held-scope.ts` and `cloudflare-navigation/src/owner-historical-scope.ts`.
2. Authorize current reading by the verified principal and current permissions while retaining the original execution credential as provenance. Reuse historical reauthorization; do not modify issued JWTs or old SQL rows to match.
3. W fixture: same owner with two kid/iat pairs, foreign owner, expired JWT, explicit revoke. **Done:** same authorized history, no model call/new run, no access by ID alone. Execution beyond session expiry is S33.

## S07 — historical source revision · [#199](https://github.com/UnknownAlienHuman/eliot-research/pull/199)

1. Reuse the already committed historical-read correction and its current source-freshness readers; do not implement a second historical reader.
2. In W/B create source v1→report/Wiki→source v2, then open old body, nested section and citation. Compare v1 digests, not current-head text.
3. Revoke/purge one dependency and retry. **Done:** v1 remains exact and marked historical when authorized; true revocation/purge blocks disclosure. Local completion does not imply the unperformed native acceptance has passed.

## S08 — query replay identity · [#200](https://github.com/UnknownAlienHuman/eliot-research/pull/200)

1. Correct the replay branch in `research-session.ts` and persisted request identity in `packages/retrieval/src/query-persistence.ts`: compare the new canonical scope expression, not the old result's scope digest alone.
2. Preserve original frozen snapshots; do not freeze again just to compare requests. Legacy records lacking provable request identity return a clear conflict.
3. Run `pnpm retrieval:check` and W request tests. **Done:** identical replay returns identical trace/evidence with zero new effects; project A→B, selected-source change and changed query/product/limit under the same key conflict before writes.

## S09 — SEM wiring · [#201](https://github.com/UnknownAlienHuman/eliot-research/pull/201)

1. Add AI_SEARCH to the actual dependency type/constructor chain: `research-stage-handlers.ts`, `research-retrieve-branches.ts`, `research-retrieval-composition.ts`, and their server composition. Both direct environment and explicit dependency branches must carry it.
2. Through `createResearchStageHandlerFactory`, return a controlled SEM-only locator for a relevant tail passage; resolve it through actual D1/R2 evidence.
3. Test absent binding, outage, stale generation, foreign and purged hits. **Done:** SEM really executes in Research, and trace distinguishes actual SEM from degraded fallback. `pnpm retrieval:check`, `pnpm workflow:check`, W. S99 separately adjusts full-scope capacity.

## S10 — one service grant · [#202](https://github.com/UnknownAlienHuman/eliot-research/pull/202)

1. Implement exactly the selected shared `project_client_grant` DTO/table/authorizer in the passport. Start from verified HTTP/MCP actor construction and `cloudflare-navigation/src/orientation-authority.ts::createOwnerScopeAuthority`; a locator header is not authentication.
2. Add the additive D1 migration, strict decoder and current owner/delegation/namespace/spend ceilings. Keep one operation vocabulary shared with S31/S58/S98; permission does not itself implement an endpoint.
3. Test verified actor equivalence, substituted actor/grant, read-only versus ingest/attach/spend, revoke and regrant. **Done:** one authorization decision and schema, not an import-specific store or owner impersonation. Run `pnpm authority:check`, `pnpm model:admission:check`, contracts, W. S31 supplies owner issuance; S11/S12 wire operations.

## S11 — machine Research · [#203](https://github.com/UnknownAlienHuman/eliot-research/pull/203)

1. Carry S10's verified service context through the actual `research-session.ts` query/run/status handlers, orientation, preparation and semantic server. Changing ROUTES labels alone is insufficient.
2. Preserve current request DTO/idempotency, freeze, real principal attribution and authorized spend sponsorship. No owner_pwa substitution.
3. Independent HTTP client: query→run→status, repeat the POST, then cross-project/revoked/unfunded cases. **Done:** one run and correct state through W, with owner regressions unchanged. `pnpm research:check`, `pnpm workflow:check`, W.

## S12 — machine evidence · [#204](https://github.com/UnknownAlienHuman/eliot-research/pull/204)

1. Generalize authorization at existing `cloudflare-artifacts` draft/section/citation readers and core artifact reauthorization routes using S10, not cloned readers.
2. Preserve draft/accepted status, frozen revision, exact bytes and current policy checks before disclosure.
3. **Done:** owner and authorized service receive matching artifact/section/excerpt digests; foreign ID, revoked or purged dependency discloses nothing and reading makes zero model calls. Run `pnpm artifact:check`, `pnpm research:check`, W; publication/erase rights remain separate.

## S13 — Research MCP · [#205](https://github.com/UnknownAlienHuman/eliot-research/pull/205)

1. Extend the existing `packages/cloudflare-workspace-mcp/src/` dispatcher and tool definitions, located by `GEMINI_MCP_TOOLS`; wrap S11/S12 services rather than issuing browser requests.
2. Scoped catalog uses the same grant; long run returns a handle. Copy the HTTP DTO semantics, correct readOnly annotations, and candidate-only Google behavior.
3. **Done:** initialize→tools/list→catalog→run→status→report→citation works without cookies; HTTP/MCP IDs and hashes agree and repeat creates no run. W and existing MCP tests, plus `pnpm google:check`. S32 adds controls later.

## S14 — cancel · [#206](https://github.com/UnknownAlienHuman/eliot-research/pull/206)

1. Implement the specified `/api/v1/research/run/:workflow_id/cancel` contract in existing routes/HTTP/service: empty object, Idempotency-Key, existing status DTO.
2. Settle W2 cancellation with current authorization and D1 CAS/readback before confirming; native stop follows. Preserve confirmed D1 cancellation when native stop fails.
3. **Done:** confirmed cancel/repeat=200; completion already won=409; unresolved settlement=503. Test cancel before/during/after stage I/O and late completion, no next paid stage. `pnpm workflow:check`, `pnpm recovery:check`, W.

## S15 — recover · [#207](https://github.com/UnknownAlienHuman/eliot-research/pull/207)

1. Implement the specified `/recover` contract and one CAS winner using W2/W3 `recoverStartedAttempt`; distinguish paused, errored and completed native instances.
2. Recover persisted synthesis by exact receipt before allowing the next stage. Do not create a replacement run or blindly retry an UNKNOWN provider effect.
3. **Done:** controlled fixture changes SYNTHESIZE=1/AUDIT=0 to SYNTHESIZE=1/AUDIT=1, same synthesis hash and lawful audit reservation. Concurrent/repeated recovery adds no duplicate calls/restart actions. `pnpm recovery:check`, `pnpm workflow:check`, W; missing audit budget remains a real stop.

## S16 — DO terminal state · [#208](https://github.com/UnknownAlienHuman/eliot-research/pull/208)

1. Establish actual callers of `ResearchSession.execute/cancel`; reproduce the interleaving with a controlled external await. Do not claim a live incident from static shape alone.
2. Remove best-effort false success. Reconcile D1 and atomically update the short-lived DO projection; a reread followed by an unguarded save is not atomic.
3. **Done:** completion-first, cancel-first, failed cancellation ACK and eviction all agree with durable D1 state. No long network lock or second ledger. W plus workflow/recovery checks.

## S17 — actionable failures · [#209](https://github.com/UnknownAlienHuman/eliot-research/pull/209)

1. Trace `research-semantic-server.ts` configuration errors through Workflow attempts and status; retain the first failure rather than replacing it with AUTHORITY_STALE or a subsequent budget symptom.
2. Map existing typed families to safe code/stage/trace and true retryability; do not print provider/source payloads or install a logger framework.
3. **Done:** injected missing config/credential, expired proof, revoke, transient I/O and corrupt output remain distinguishable after replay. W and `pnpm recovery:check`; secret-bearing nested causes remain redacted.

## S18 — launch checker · [#210](https://github.com/UnknownAlienHuman/eliot-research/pull/210)

1. In `scripts/check-launch-code.mjs`, check mandatory selected-profile composition, including partial/conditional routes, rather than only the helper names unavailable/denied.
2. Use existing capability/registry declarations and negative fixtures: partial Wiki, missing handler, federation with and without required configuration. Separate code readiness from configured/live status.
3. **Done:** renaming a helper cannot conceal a blocker; complete code does not require future live receipts; unselected Drive OAuth is not mandatory. `pnpm launch:code`, `pnpm launch:registry`, relevant script tests. A missing repository secret is not proof of missing deployment configuration.

## S19 — transient PWA disconnect · [#211](https://github.com/UnknownAlienHuman/eliot-research/pull/211)

1. Separate network/health failure from explicit authorization loss at `apps/eliotr-pwa/src/main.ts::clearPrivateEvidence` callers.
2. Retain the current tab's unsent question and operation ID; hide/recheck protected response data under existing policy, with no implicit disk cache. Reconnect reads the old status, not POST run.
3. **Done:** offline/503 preserves intent, logout/revoke clears private state, stale replies cannot restore it. Focused PWA U tests followed by B; network reconnect causes zero new paid calls.

## S20 — targeted refresh · [#212](https://github.com/UnknownAlienHuman/eliot-research/pull/212)

1. Pass confirmed source/revision IDs from raw admission into `refreshAfterSourceAdmission`; compare with the report's actual dependency refs.
2. Unrelated source: no report reset. Related new head: refresh freshness/read authority and retain the historical body. Do not compare filenames or launch synthesis.
3. **Done:** two-project fixture preserves unrelated work, v1 remains exact after v2, duplicate events cause no repeated effects, purge still hides data. PWA U plus B.

## S21 — stage truth · [#213](https://github.com/UnknownAlienHuman/eliot-research/pull/213)

1. Classify actual outputs in `research-stage-handlers.ts`: substantive handler output, merged work with referenced output, or technical checkpoint only.
2. Show that classification through existing status/trace/UI; preserve legacy stage IDs and receipts. Do not invent 18 independent agents.
3. **Done:** replacing a substantive handler with `deterministicWorkflowStageBytes` fails the obligation-completion regression; real work performed outside its named stage retains credit. `pnpm workflow:check`, W and focused PWA U. Missing execution is implemented by S35–S46, not hidden here.

## S22 — counter-search · [#214](https://github.com/UnknownAlienHuman/eliot-research/pull/214)

1. Add a real COUNTER_SEARCH handler to the existing factory using S35's installed profile and existing retrieval/exact evidence resolver.
2. Persist retrieved contradictions and unsuccessful probes before reconciliation/freeze; share the result with S37 rather than executing a second search there.
3. **Done:** a tail-section contradiction reaches freeze and audit, while sampled no-hit remains inconclusive. Foreign/purged/cancel/replay negatives pass. `pnpm research:check`, `pnpm retrieval:check`, W; no crawler or mandatory counter-search for lookup.

## S23 — honest fallback · [#215](https://github.com/UnknownAlienHuman/eliot-research/pull/215)

1. Locate `selectedDocumentFallbackCandidates` and preserve its explicit fallback metadata into trace/EvidencePack rather than calling introductory sections lexical matches.
2. Compare exact/SEM results and intro fallback in a fixture with answer and counterexample in the tail. Relevant direct evidence must not be displaced by arbitrary intro.
3. **Done:** fallback is visible as orientation, never proves absence/completeness, and the answer is supported by the selected exact excerpt. `pnpm retrieval:check`, `pnpm golden:check`, W; no full-corpus LLM pass.

## S24 — multiline input · [#216](https://github.com/UnknownAlienHuman/eliot-research/pull/216)

1. Correct `research-session.ts::checkQuery` and PWA validation to preserve LF/CRLF/tab and exact question bytes under existing request/model envelopes.
2. Reject malformed Unicode before UTF-8 encoding, NUL, isolated CR and prohibited controls; never silently trim/normalize literals or substitute an arbitrary character cap.
3. **Done:** English/Russian multiline questions reach model preparation unchanged; LF→CRLF with same key conflicts, actual envelope max/max+1 and legacy short questions are tested. U, W and `pnpm contracts:check`.

## S25 — Wiki write/read parity · [#217](https://github.com/UnknownAlienHuman/eliot-research/pull/217)

1. Send BMP/emoji/NUL/lone-surrogate/ref boundary cases through `wiki-owner-edit-proposal.ts`'s supported writer and reader, with actual D1 migration 0064.
2. Fix a demonstrated accepted-write/unreadable-record case at the shared structural boundary. If the supported writer already rejects it, retain that regression rather than claim an exploit or add redundant SQL checks.
3. **Done:** accepted bytes round-trip; rejected input leaves no head/receipt/outbox; deliberately corrupted stored rows fail closed. W plus `pnpm artifact:check`. CAS/immutable/policy guards remain.

## S26 — Research screen · [#218](https://github.com/UnknownAlienHuman/eliot-research/pull/218)

1. Recompose existing PWA panels/CSS: source selector, central question/result, citation pane on selection. Do not replace framework or backend.
2. Move schema/generation/proof diagnostics to existing Connections/details, compact Recent work, and expose one clear blocked reason/action.
3. **Done:** question/scope/action visible at 1440×900 and usable on narrow screens; keyboard flow project→question→result→exact citation passes B. No fake READY, duplicate forms, or changed API semantics. S73–S75 complete the other screens.

## S27 — remove branch cap · [#219](https://github.com/UnknownAlienHuman/eliot-research/pull/219)

1. Remove numeric ceilings, dated reservations and count/age eviction from existing branch-hygiene helpers/config.
2. Preserve cleanup only for proven integrated branches, with open-PR/protected/default/head-SHA checks; closed-unmerged is not disposable.
3. **Done:** any PR count passes count-related checks; PR creation or head change cancels unsafe cleanup. Run existing hygiene negative/unit tests and align procedural docs. Do not delete user branches as a side effect of this task or replace the quota with another whitelist.

## S28 — one serializer duplicate · [#220](https://github.com/UnknownAlienHuman/eliot-research/pull/220)

1. Replace only `packages/retrieval/src/service.ts::canonicalJson`'s duplicated recursion with `query-codec.ts::canonicalRetrievalJson`.
2. Preserve the service's `RetrievalQueryError` mapping, original digest inputs and type-only import direction. Evidence serialization remains separate because its contract differs.
3. **Done:** existing bytes/digests/IDs/errors match, one recursive implementation is removed, no runtime cycle. `pnpm retrieval:check`, U retrieval tests, boundaries/typecheck. This is not a global search-and-replace of 26 serializers.

## S29 — immutable config · [#221](https://github.com/UnknownAlienHuman/eliot-research/pull/221)

1. Replace semantic JSON_0/_1 assembly in existing configuration loader with one immutable Work R2 reference/digest, using its current strict parser. Keep secrets in Worker secrets.
2. Define old-or-new transition, reject mixed authorities, and bind run provenance to the selected immutable revision. Cache immutable bytes only, never current grants.
3. **Done:** restart/rollback preserves frozen prompt/schema; missing/corrupt/wrong version fails before model dispatch; old format migrates explicitly. W, model-admission/workflow checks and deploy preflight fixture. No configuration service.

## S30 — current status and docs · [#222](https://github.com/UnknownAlienHuman/eliot-research/pull/222)

1. Compare existing `implementation-status.json`, `gap-register.md`, START-HERE and capability statements for owner import→retrieval→Research. Distinguish implementation, observed deployment, individual live case and full qualification.
2. Run `pnpm docs:index`; resolve the audit's ER-45/ER-46 indexing findings against the exact current diagnostic, without reclassifying optional work as mandatory. Also run `pnpm docs:links` and `pnpm docs:routes` for touched documents.
3. **Done:** entry documents and registry agree; zero qualified subsystems does not deny actual partial live evidence. Historical logs remain history. No additional status registry, fabricated counts, or qualification based on file existence.

## S31 — usable grant issuance · [#223](https://github.com/UnknownAlienHuman/eliot-research/pull/223)

1. Implement the passport's exact owner GET/PUT/DELETE under `/api/v1/research/projects/:project_id/client-grants` using S10's one DTO/table and existing project CAS/receipt pattern.
2. Add the small Connections form: create/list/revoke, explicit operations and namespace/spend ceiling. A configured Client ID is not a successful connection test.
3. **Done:** clean DB→owner API grant→signed service request works, revoke/regrant cannot revive old execution rights, overprivileged/CSRF/stale requests fail. W plus B; no manual SQL or second `/projects` namespace.

## S32 — client controls · [#224](https://github.com/UnknownAlienHuman/eliot-research/pull/224)

1. Add Stop/Recover to the existing run panel and MCP tools, calling exactly S14/S15 with unchanged run ID and action key.
2. Display pending/uncertain until server readback; preserve completed output and never infer retryability from message substrings.
3. **Done:** UI/MCP/GET agree after reload/lost response; synthesis is not repeated, first lawful audit is allowed, repeated clicks add no effects. PWA U, W and B. Native lifecycle proof remains S95.

## S33 — long-run authority · [#225](https://github.com/UnknownAlienHuman/eliot-research/pull/225)

1. Trace active `loadHeldResearchScope` callers and separate server-owned execution authorization from short owner-session/snapshot TTL. Keep original frozen membership and current upstream grant ceilings.
2. Refresh only the same operation's execution allowance within its authorized deadline; no stored browser JWT, new auth server, wider scope or adoption of new source heads.
3. **Done:** injected time just before/after session TTL permits the authorized run to continue without a tab; explicit upstream expiry/revoke/purge/cancel stops the next dispatch. W currentness/recovery tests, `pnpm workflow:check`, `pnpm authority:check`; history behavior remains S06/S07.

## S34 — model-proof renewal · [#226](https://github.com/UnknownAlienHuman/eliot-research/pull/226)

1. Connect the existing configuration readiness and qualification-renewal stores/handlers to the actual dispatch path; use the appropriate Gateway Run versus Read secret reference.
2. Fresh proof: zero renewal. Expiring proof: one currentness-checked, shared renewal attempt; exact route readback precedes promotion. Status GET remains model-free.
3. **Done:** concurrent requests share one renewal; missing credential, changed route, expired policy and UNKNOWN attempt remain distinct, with no blind paid repeat. W, `pnpm model:admission:check`, `pnpm recovery:check`. Saved evidence remains readable with valid read authorization even if model readiness fails.

## S98 — machine import and attachment · [#290](https://github.com/UnknownAlienHuman/eliot-research/pull/290)

1. Apply S10/S31's explicit ingest.bundle/namespace authorization to existing normalized bundle prepare/parts/complete/commit/status/recovery. Retain actual service attribution and original source owner.
2. Implement project.attach through existing `PUT /api/v1/research/projects/:project_id` and `UpdateProjectRequest`: unchanged title, superset of current members, exact expected revision. Authorize each new admitted source by namespace/owner ceiling; do not require it to already be a member.
3. **Done:** clean owner-issued grant→machine upload→append-only attach→query/run/citation works without browser/Google/SQL. Rename/detach/foreign/unadmitted/revoked/stale requests fail atomically; replay does not duplicate membership/outbox. Old runs do not expand. W, `pnpm ingest:check`, `pnpm authority:check`, `pnpm research:check`.

## S99 — full-project scope · [#291](https://github.com/UnknownAlienHuman/eliot-research/pull/291)

1. Separate actual full scope from preview64 and retrieval top16 in `cloudflare-navigation/src/scope-service.ts`, owner orientation, and `research-stage-handlers.ts::SERVER_RETRIEVAL_SCOPE_PROFILE`. The generic larger loader already exists; update every relevant binding/comparison, not one constant.
2. Carry the preserved full scope profile through Workflow/freeze/coverage and `owner-historical-scope.ts` readers; replace fixed LIMIT65 witness assumptions with bounded complete metadata enumeration. Do not fetch every source body into memory.
3. **Done:** projects with65/299 admitted sources retain all requested members and find the controlled passage beyond source64; old artifacts retain exact scope after refresh/source update. Real canonical envelope max/max+1 is explicit, no silent truncation or false completeness. W, retrieval/source/workflow checks, then S93 quality acceptance.
