# Product integration checkpoint, 2026-10-02

This is an isolated development checkpoint. Remote main was refreshed at `6480186ea5ead7052e7122ec1b523713ddc97f21`. Only PR #306 had applicable merge authorization. No other PR was merged, no live deployment or provider spending was performed, and no credentials were created.

## Settled decisions

- [#298](https://github.com/UnknownAlienHuman/eliot-research/issues/298) and [#106](https://github.com/UnknownAlienHuman/eliot-research/issues/106) are closed. Their source repairs do not replace exact-build browser or Rust acceptance.
- [#294](https://github.com/UnknownAlienHuman/eliot-research/issues/294) remains open for dynamic-query coverage and native acceptance. The depth-100 compiler passes recovered SQL but explicitly reports unresolved prepare sites.
- [#301](https://github.com/UnknownAlienHuman/eliot-research/issues/301) remains the ordered queue with complete task criteria. Existing v7 selection/composition/freeze wiring and #299 recovery must be reused.
- S94 A/B is not an unresolved product decision. The existing [staging checklist](launch-prs/cloudflare-handoff.md) permits a dedicated approved account or a separately reviewed isolated resource profile. Same-account preflight requires different D1/R2 resource IDs; this is not permission to apply a deployment.
- [ADR-0007](../adr/0007-external-agents-and-cloudflare-evolution.md) keeps providers, external agents and Google clients independently selectable. S95 does not impose an unselected Gemini client.
- S93 quality preparation is independent local work. S96 live load requires bounded approved spending. S97 requires exact release evidence and explicit production approval.

## Integrated source boundaries

This branch combines the owner publication checkpoint from [#313](https://github.com/UnknownAlienHuman/eliot-research/pull/313), portable recovery checkpoint from [#314](https://github.com/UnknownAlienHuman/eliot-research/pull/314), COW source `8657037470814fd0d03b556db57512bde357bdd7`, and COW fixture checkpoint `8c150f4a`. All remain draft development, not live qualification.

- Core REPORT admission persists the full owner/source/policy/spend witness before the dedicated COW W2. The server model admission derives separate SYNTHESIZE and independent-verification quotes from installed rules, pins route/prompt/schema, checks current source and grant authority, and binds model input digest to immutable intent. UNKNOWN gives no retry permission.
- Migration 0100 now validates the actual canonical `{request, attempt_ref}` envelope for W3 admission. COMMITTED additionally requires a real CAS-written DRAFT child with the original spec/freeze/scope and exact manifest readback hash. An absent child or invented manifest hash is denied.
- Historical freeze readback follows only the exact committed COW parent chain back to the original REPORT. It bounds traversal to 32 ancestors and checks immutable spec/freeze/scope/owner identity, canonical request bytes and child manifest receipts. Historical credentials remain provenance. Both successful W3 replay paths revalidate current authority before output reads and enforce exact byte size/digest; UNKNOWN is classified before successful-output checks and never permits a new model call.
- W3 spend admission now serializes the actual `{request, attempt_ref}` envelope from the canonical public run request and exact attempt identity. Its revalidator independently checks public run bytes, persisted attempt bytes and the original run digest. Native verification exposed this distinction; neither immutable run bytes nor request digests were changed.
- [e5003529](https://github.com/UnknownAlienHuman/eliot-research/commit/e5003529) delivered exact child materialization through the existing draft writer. Migration 0102 permits only the dedicated child intent/reservation with the original REPORT policy decision, immutable spec/freeze/scope and exact W2 attempt/request binding. Original REPORT intent/outbox bytes remain unchanged; finalized-child readback tolerates later head advance without a second write.
- Core now composes the owner section-revise HTTP route with the existing W2, current owner/source authorization, historical draft/freeze/citation readers, installed semantic policy and governed W3 model runtime. A restarted request looks up deterministic W2 before a new REPORT witness. OUTPUT_RECORDED with an exact finalized child reconciles before constructing producer/model ports; COMMITTED reads still require current rights/purge authority. UNKNOWN returns its durable classification without model preparation.
- Fresh REPORT execution permission and current model EvidencePack remain separate from original spec/freeze/dependency-manifest/handle provenance. Historical handles retain their original scope and grant references after exact current bytes, coordinate map, owner generation, source identity and residency checks. A final original-handle read rejects a handle-only terminal transition during resolution. Native composition exposed a strict residency-schema mismatch in the section producer: it now validates the full template and separates the old content digest before assigning new object digests, preserving all residency domains. The bounded installed export composition supports Markdown only; other export formats remain pending.
- Owner HTTP acceptance creates separate immutable publication authority. Repeating the same request reuses the receipt, while DRAFT stays DRAFT. Invalid V2 bytes and later purge deny publication/read; accepted heads retain their immutable receipts.
- Portable backup explicitly includes publication receipts/heads, COW W2/W3 admission histories and model/budget COW locators. Unknown tables or columns still fail closed; live credentials and grants remain excluded, with immutable historical grant provenance exported separately.
- Backup erasure inventory reads immutable O2 receipts and bounded local manifest parts, verifies the exact source/revision/owner generation, and selects only matching epochs. It requires one-to-one canonical epoch and receipt linkage plus committed copy authority. Missing, mismatched or PENDING authority blocks the result; the reader never promotes an epoch to VERIFIED.
- Cloudflare target attestation lives in `@eliotr/cloudflare-backup`, alongside the provider adapter. O2-only `@eliotr/backup-o2` owns manifest/crypto verification. Preflight bounds accumulated plaintext to 8 MiB and returns only `PREFLIGHT_VERIFIED_NO_WRITES`. A later purge rejects before offsite reads or target writes.

## Verification and honest limits

- Earlier focused Workerd/D1/R2 component checks: dedicated COW W2 2/2; owner REPORT admission 2/2; owner HTTP publication 2/2. The COW readback test proves absent-child and wrong-hash negatives as well as a real child commit and immutable replay. HTTP verifies ACCEPTED/replay/read, purge denial and corrupted V2 refusal.
- New native integration checks: REPORT materialization/replay/original-freeze readback/wrong-scope refusal and incompatible COW-child authority refusal pass 1/1, with the positive two-child lineage case explicitly TODO. The actual W3 model-admission fixture passes 2/2: separate installed REPORT admissions/quotes/reservations for synthesis and independent verification, real D1/R2 settled outputs and immutable replay with no new route/prompt work; an invoked lost acknowledgement persists W2/W3 UNKNOWN and permits no repeated provider effect or new admission. The injected local gateway provides no live provider or S93 evidence.
- Backup suite: first default 5-second run had 115 PASS and 2 timeout failures. Repeating at a local test-harness timeout of 20 seconds passed 117/117. This changes no production or acceptance threshold. After placing target attestation in its platform package, the Cloudflare backup suite passed 21/21 (12 preflight and 9 transport checks).
- Earlier Core TypeScript, focused ESLint, import boundaries and complete canonical table/column inventory passed. Current bounded integration: `pnpm --filter @eliotr/core typecheck`, `pnpm exec eslint` over the exact changed TypeScript files (including `test/artifact-cow-http.test.ts`), and `pnpm d1:depth` pass. Depth-100 SQL compilation passes 872 recovered sites with 111 explicitly unresolved dynamic/non-SQL prepare sites; Core has 101 migrations, 23 views and 444 migration statements with zero failures. It is not exhaustive query acceptance. A sandbox compiler setup failure was followed by a successful local compiler run; neither schema nor limits changed.
- The integrated backup scope and actual SQLite/O2 producer fixtures pass 13/13 in two files. They create A-rev1, A-rev2 and B-only epochs through the real O2 producer, verify immutable persisted drafts and parts, and exercise missing/mismatched/PENDING canonical-link refusal. This does not prove a positive canonical VERIFIED inventory path.
- Focused executor tests pass 2/2 on the combined branch: raced durable success with a revoked grant performs no output read; durable UNKNOWN performs no provider call, output read or new preparation.
- Broad source budgets have inherited failures and this combined branch also grows existing oversized packages. No limit was increased and no broad budget PASS is claimed. Local controlled model responses never qualify S93 or live provider behavior.
- GitHub workflows are manual. An empty status rollup or zero runs is NOT EXECUTED, not CI PASS. No workflow dispatch was requested.

- Focused native HTTP command: `pnpm --filter @eliotr/core exec vitest run test/artifact-cow-http.test.ts --reporter=verbose`. Final three-case file passes 3/3 on actual Workerd/D1/R2 (103.38 seconds). The targeted finalized-child recovery case passes 1/1: controlled synthesis and independent verification settle, child CAS finalizes before an injected W2 commit interruption, and a distinct-time replay with unavailable semantic/model configuration reconciles to COMMITTED with no new provider call or R2 put. Original REPORT intent/outbox, COW request/witness bytes and original Work R2 object digests remain unchanged. The final run also verifies revoked authority while OUTPUT_RECORDED leaves reconciliation pending with no new provider/R2 effects, a saved-handle redaction during current resolution is rejected while the fresh grant remains unchanged, and invoked lost acknowledgement persists UNKNOWN with immutable replay and no duplicate effect. Earlier fixture failures were corrected without relaxing current authority; the native producer residency failure was repaired as described above.

## Owner controls and publication integration checkpoint

Work continued on the existing Cybertech checkout on local `main`, from parent-reviewed main `f62dbad1`. No worktree or new PR was created. The existing handoff name is used only for normal GitHub file exchange; the parent retains review/merge ownership. The four-file Core/route/DTO prerequisite is published at [87d6a1b4](https://github.com/UnknownAlienHuman/eliot-research/commit/87d6a1b4); it carries pending acceptance, not a full S92 claim.

The minimal claim-label producer link is separately published for parent review at [cc019697](https://github.com/UnknownAlienHuman/eliot-research/commit/cc019697).

The PWA now uses the existing strict section-revise and explicit owner-accept routes, opens the exact finalized child through saved-draft reauthorization, refreshes saved history, and separately reads the persisted publication status on reopen. Stable mutation identities bind the exact parent/section or draft/publication CAS across retry and reload. UNKNOWN only rechecks its durable outcome and never promises automatic settlement. ACCEPTED and SUPERSEDED reports cannot be accepted again from that control; current-rights/purge/deployment loss clears private report content. Canonical saved revisions remain DRAFT and immutable; the publication receipt supplies the owner status.

The missing current-publication read is a bounded owner-only composition of the existing draft reauthorization, head/receipt locator and publication validator. It verifies that the requested draft is current and rereads both heads, including disposition and the no-publication case. The receipt DTO includes the three acceptance-provenance fields already present on the wire. Missing publication uses the existing ARTIFACT_PUBLICATION_NOT_FOUND code; an owner/purge-hidden artifact 404 is preserved as a refusal rather than displayed as absent acceptance.

Actual joined native execution found the COW producer's placeholder statement labels were keyed by claim kinds rather than exact claim IDs. The existing producer now projects labels from its translated independent-verifier results under each exact normalized claim identity. Supported observation, interpretation and recommendation retain SOURCE_SUPPORTED, DERIVED_INFERENCE and EDITORIAL_RECOMMENDATION respectively. Supported assumptions remain HYPOTHESIS, preserving the existing publication gate's refusal. No publication-policy/SQL guard, historical REPORT witness, source bytes or CompletionDisposition was relaxed. Native projector coverage exercises supported observation and supported assumption; interpretation/recommendation and the remaining disposition branches were not independently executed in this checkpoint. Claim kind remains existing normalized candidate metadata evaluated by the existing independent-verifier dimensions; no new kind-attestation contract or live semantic-quality qualification is claimed.

Executed before the final review regressions: `pnpm --filter @eliotr/core test -- test/artifact-cow-http.test.ts test/artifact-owner-loop-http.test.ts --maxWorkers=1` passes 5/5 on actual native Workerd D1/R2 (184.00 seconds overall; 162.21 seconds tests). This joins the actual PWA transport decoders to Core HTTP with an injected controlled provider and existing owner verifier, checks crash/replay before model setup, two sequential verified child CASes, exact publication CAS refusal and readback, later-head replay, historical SUPERSEDED reads, current ACCEPTED reads, original object/witness immutability, revoked read-policy refusal and REDACTED source-dependency refusal without new model/R2/publication effects. It is not a browser or process-restart run. Final `pnpm --filter @eliotr/core test -- test/artifact-owner-loop-http.test.ts --maxWorkers=1` passes 4/4 (226.89 seconds overall; 215.41 seconds tests), including both review-requested regressions: a supported assumption remains HYPOTHESIS and acceptance refuses with ARTIFACT_PUBLICATION_NOT_READY and zero publication receipts; a real D1 transition of the same head to PENDING_REVALIDATION after the producer read returns ARTIFACT_PUBLICATION_STALE/409 with unchanged identity/revisions, receipt count, provider-call count and Work R2 puts. The existing three-case COW file also passes in the combined run. After adding direct exact-claim-key and SOURCE_SUPPORTED observation assertions, `pnpm --filter @eliotr/core test -- test/artifact-owner-loop-http.test.ts --maxWorkers=1 --testNamePattern="reconciles a crashed child"` passes 1/1 (three intentionally unselected cases; 100.00 seconds overall, 81.21 seconds tests). The full four-case file passed before those two additional assertions; no skipped case is counted as PASS in the targeted rerun.

Core/PWA TypeScript compilation, exact edited-file ESLint, dependency boundaries and PWA static build passed during assembly. The build retains its existing large-chunk warning; no bundle-budget PASS is claimed. `pnpm d1:depth` passes with 873 recovered application SQL statements, 0 failures, 111 dynamic/unresolved sites; the current-head query is compiled at depth 100. Full affected/broad/browser/live suites and manual CI were not run under the owner's bounded compile/scoped/native checkpoint instruction.

Independent Luna/max read-only review approved this bounded checkpoint with no blocking wire-decoding, private-content clearing or CAS/authority issue; the reviewer made no edits and ran no tests. Parent review/merge remains the next boundary.

The earlier accepted-artifact process-restart attempt was PENDING; the exact local browser/restart run at f057befb recorded below now supersedes that limit for the controlled accepted-child fixture. The existing `owner-e2e.mjs` restart path uses stable Wrangler D1/R2 persistence, but its local profile has no controlled AI binding. The installed `@cloudflare/vitest-plugin@1.1.0` accepts Worker-level options and does not forward Miniflare's root resourcePersistencePath, so separate native CLI processes do not preserve those stores by configuration alone. No plugin patch, parallel harness, production injection seam or artificial persistence proof was added. Native read/replay in this checkpoint must not be represented as actual process restart or a real browser session.

## Stage17 fresh original draft labels

The bounded follow-up from parent baseline `bc67d913` reuses the existing normalized Stage13 candidate and committed Stage14 audit reader. Fresh audited REPORT drafts now key statement labels by exact normalized claim IDs and project the existing audit dispositions with `claims.kind`; the existing COW projection was moved unchanged into a small shared library helper. The draft writer checks one-to-one claim ref/revision, text/digest, evidence refs and normalization binding before writes. Configured required-kind/UNRESOLVED placeholders keep their existing format. No-audit legacy drafts keep their prior labels, while committed Stage17 replay and finalized-draft recovery retain stored bytes and receipts.

The publication gate is unchanged. Acceptance remains separate from verified research completion: for example, its existing UNSUPPORTED/HYPOTHESIS pair is permitted, while a SUPPORTED assumption projected as HYPOTHESIS is refused by the existing SUPPORTED-label rule. No audit verdict is promoted to SOURCE_SUPPORTED merely to obtain acceptance; incomplete coverage and unknown completion remain unchanged.

The source checkpoint [6d434388](https://github.com/UnknownAlienHuman/eliot-research/commit/6d434388) passed Core compilation, scoped edited-file lint and boundaries. A controlled document-class supported audit is composed from the existing actual synthesis/VERIFY/AUDIT/coverage services; no committed receipt is fabricated. Final focused execution:

- `pnpm --filter @eliotr/core test -- test/artifact-stage17-owner-http.test.ts test/research-report-admission.test.ts --reporter=verbose --maxWorkers=1`: **5 PASS, 1 existing TODO**, 115.01 seconds. Fresh original REPORT accepts directly with exact audited claim-ID SOURCE_SUPPORTED labels; repeat acceptance returns HTTP200 and the same receipt. Committed Stage17 replay invokes no handler, with identical receipt and every Work R2 object digest. The legacy no-audit case retains exact saved output bytes and receipts. Independent fresh fixtures for revoked read policy and REDACTED source each refuse publication read, reauthorization and repeat acceptance404 without new draft/publication/model/R2 effects. Claim revision, text digest, normalization binding and duplicate-claim corruption refuse before writes. Actual source-requirement failure remains UNSUPPORTED/HYPOTHESIS and is accepted under the unchanged disclosure gate.
- `pnpm --filter @eliotr/core test -- test/artifact-owner-loop-http.test.ts --reporter=verbose --maxWorkers=1 --testNamePattern="reconciles a crashed child|keeps a supported assumption"`: **2 selected PASS, 2 intentionally unselected**, 61.71 seconds. The existing native COW path still reconciles a finalized crashed child before producer/model, accepts two exact CAS children and preserves history. A SUPPORTED assumption remains HYPOTHESIS and publication is refused with no receipt. This is shared-mapper coverage, not a Stage17-specific assumption-kind execution.
- `pnpm --filter @eliotr/core typecheck`, scoped ESLint over the edited TypeScript files, `node scripts/check-boundaries.mjs`, `node scripts/check-implementation-status.mjs` and `git diff --check`: PASS. Registry remains 43 IMPLEMENTED_NOT_LIVE and zero LIVE_QUALIFIED. `pnpm d1:depth`: PASS at SQLite depth100, 873 recovered application SQL sites, zero failures, 111 explicitly unresolved dynamic/non-SQL sites.

Initial native failures were test expectations: duplicate acceptance is HTTP200; UNSUPPORTED/HYPOTHESIS is permitted by the current gate; D1 aggregate changes include trigger writes; and restoring a read-policy state does not revive scope snapshots invalidated by the existing migration0011 trigger. Final revoke/purge checks use independent accepted fixtures and exact canonical-key UPDATE RETURNING readback, with no trigger or authority reset. Interpretation/recommendation and the remaining disposition branches were not independently executed in this Stage17 checkpoint. Browser and actual process restart were pending at that Stage17-native checkpoint; the later local browser/restart evidence is recorded below. Broad/full checks, remaining TODO and live qualification remain pending and parent-owned. No gate, CompletionDisposition, deployment or live/provider qualification was changed.

## S92 original REPORT run browser checkpoint

Parent executed `node tests/integration/browser/owner-e2e.mjs --owner-artifact` at exact [f057befb12896c6cd84d9a4cd927a066e4bb7648](https://github.com/UnknownAlienHuman/eliot-research/commit/f057befb), exit0. Its final local receipt records browser, distinct Worker-PID restart, current read-policy revocation, independent source-row REDACTED/read refusal and unchanged model effects after restart as PASS. The run transports actual controlled native Workerd D1/R2 snapshots into stable local Wrangler persistence and reads exact accepted-child receipts/section bytes before and after restart. This is a fresh synthetic fixture; source_purge is a REDACTED row/read-denial check, not full erasure or live qualification. `run_reopen` remained explicitly PENDING. The retained Cybertech log is `C:\Users\kleym\Documents\Codex\2026-10-02\task-2\owner-artifact-f057befb12896c6cd84d9a4cd927a066e4bb7648.log` with its exitcode sibling.

The bounded follow-up extends that same native export/collector/browser sequence with a separate original REPORT profile. The existing test-only `originalReport` helper now exposes the canonical Stage12–17 path before the COW fixture's historical-clock advancement and policy retirement. Its real final W2, original revision1, audit, coverage and admission bytes are retained. Native preflight requires run-status200, ENGINE_COMPLETED/next_stage_index18, an exact Stage17 answer ref and the original run locator in history. The existing collector identifies original storage through exact REPORT admission/draft binding instead of an accepted-child receipt. The PWA scenario opens the run, explicitly accepts, reopens and restarts a distinct Worker over the same D1/R2, requiring identical status/receipt/section/blob readback and unchanged model effects. Current source rules and publication CAS remain unchanged. Parent owns the separate history-list repair.

Final controlled execution is recorded at exact clean published source [42c15ecbe3418e4c410c1dcb12111ac9df346101](https://github.com/UnknownAlienHuman/eliot-research/commit/42c15ecb). The checkout stayed unchanged throughout the browser run.

- Original native preflight through the existing snapshot collector with profile `original-report`: **1/1 PASS**, exit0, 29.72 seconds. It observed actual ENGINE_COMPLETED/next_stage_index18, original revision1, the exact Stage17 answer/run-history binding and two controlled model calls. Retained log: `C:\Users\kleym\AppData\Local\Temp\eliotr-original-native-20261002-074312.log` and its exitcode sibling.
- `node tests/integration/browser/owner-e2e.mjs --owner-artifact`: **PASS**, exit0. Its three real native fixture exports each pass 1/1. The final `eliotr.owner-artifact-browser.v1` receipt marks browser, restart, current_rights, source_purge, run_reopen and model_after_restart PASS. The original REPORT is opened from canonical run history, explicitly accepted through the exact scoped confirmation, reopened, and opened again after a distinct Worker PID restarts against the same persistent D1/R2. Exact run status/Stage17 ref, publication receipt, section headers/digest/body and every original immutable R2 blob are checked; model receipt counts remain unchanged. Original acceptance adds its real publication receipt without changing the original draft/model/blob checkpoint. Accepted-child restart and the independent exact read-policy revoke/source-row REDACTED cases also pass. Retained log: `C:\Users\kleym\AppData\Local\Temp\eliotr-owner-original-42c15ecbe3418e4c410c1dcb12111ac9df346101.log` and its exitcode sibling.
- The four browser rounds account for 31/31, 31/31, 39/39 and 32/32 requests/responses, with zero failed requests, page errors or unobserved finished service-worker HTTP. The fresh original REPORT round explicitly checks the two exact publication absence responses as 404/ARTIFACT_PUBLICATION_NOT_FOUND and expects only their two exact Chromium console lines; the other rounds require zero console errors. Three new action names/five exact edges and the exact author GET200 are registered in the existing strict ledger. No global dialog confirmation or broad console/network suppression was added.
- During source assembly, `pnpm --filter @eliotr/core typecheck`, scoped ESLint over the owned TypeScript/browser files, Node syntax checks, dependency boundaries and `git diff --check` pass. `pnpm d1:depth` passes at depth100 with 873 recovered sites, zero failures and 111 unresolved dynamic/non-SQL sites. The subsequent browser-only amendments pass scoped ESLint, syntax and whitespace checks. Independent Luna/max and parent read-only reviews found no remaining blocker in the fixture/browser changes; reviews are not runtime evidence.

Earlier clean-SHA browser attempts stopped at strict action registration (934c6544) and the expected fresh-publication console404 check (16db307f). Their partial execution is not counted as full PASS. The final run at 42c15ecb supersedes those local failures. source_purge remains a REDACTED row/read-denial check, not full erasure. Overall S92, broad/full/affected checks, other disposition branches, remaining TODO, parent-owned history-list repair and live-provider qualification remain pending. No trigger reset, completed-receipt fabrication, new harness, deployed credentials, live provider call or production qualification is introduced.

## Remaining critical path

The bounded Core section-revise/runner recovery composition is connected and uses the dedicated child authority already delivered at e5003529. Focused native HTTP verification is recorded above; this does not complete S92. The controlled native synthesis -> independent verification -> child CAS -> owner ACCEPTED/readback path, positive two-child historical-freeze traversal, later-head HTTP recovery and revoke/purge refusal are exercised above. The controlled accepted-child and original REPORT browser/process restarts now pass locally at 42c15ecb as recorded above; overall S92 and live-provider qualification remain pending. Renewal or late settlement after the pinned fresh REPORT permit/budget expires is unverified; existing expiry guards remain intact. The historical-expiry fixture advances JavaScript Date beyond the original immutable scope expiry while an initially longer-lived current read policy and a fresh REPORT scope stay live. SQLite unixepoch/julianday remains on the native runtime clock; both current REPORT expiry fences remain live. This expiry fixture does not prove actual wall-clock expiration; distinct local Worker-process restarts are recorded separately above.

Restore preflight is not disaster recovery. O2 offsite copy currently transports the 15 encrypted manifest parts and R2 object inventory, not R2 payload bytes. Missing code includes authenticated bounded payload transport, exact current purge/terminal-target/backup-obligation reconciliation before writes, canonical VERIFIED backup_epoch linkage, and a coherent WORK_BUCKET manifest-part sink that avoids self-inventory drift. Missing or ambiguous archive authority must continue to block BackupRestorePath; never fabricate VERIFIED rows or traffic readiness.

After those code gaps, S94/S93/S95/S96/S97 need an exact approved isolated target and their own native/live evidence. Current instructions prohibit live apply, spending and new credentials; the next engineering steps need no new A/B choice.

## Owner session lease integration checkpoint (2026-10-02)

The owner's requested session behavior is automatic read-lease refresh after verified
Cloudflare owner login or reconnect. The existing identity GET remains read-only;
the PWA invokes the existing namespace renewal POST with exact catalog generation.
Every existing same-owner ACTIVE policy shorter than the verified JWT is eligible,
including a still-valid shorter lease. Initial grants, revoked or missing policy,
changed ownership/admission and delegated-client authority retain their existing
boundaries. The workspace chooser and Research execution remain explicit.

Implementation is split among three Luna/max agents with disjoint write ownership:
Core renewal and native HTTP checks, PWA session/catalog lifecycle, and immutable
history/SQL receipt proof. The root owns documentation and publication. The session
checkpoint starts from [0f1b7215](https://github.com/UnknownAlienHuman/eliot-research/commit/0f1b7215)
on the existing exchange branch; no new branch, worktree or PR is created.

Lease refresh must atomically record the verified owner session and exact old/new
policy tuple beside the existing fenced CAS, then read back the applied receipt.
Historical reads retain their original snapshot and R2 bytes. A lease event cannot
waive an arbitrary member policy-closure mismatch: proof must reconstruct the old
policy tuple against current source authority and match the original closure.
Semantic events, current revocation, owner/admission drift and purge still deny.
The existing delegated-grant revocation trigger is retained.

Compilation, scoped lint, depth-100 SQL and focused signed-session/native
HTTP/history/PWA checks are pending during assembly. Full S92, the inherited
source-budget failures, Linux CI and real deployed login/relogin remain separate
pending acceptance. No deployment, live write, paid call or manual CI dispatch is
part of this checkpoint.

First reviewable session checkpoint: the PWA client uses the existing strict
session/catalog/renew endpoints; the Core receipt/history integration remains in
assembly and is not qualified by the client checks. PWA `typecheck` and scoped
ESLint over its five changed source files and `tests/library.test.ts` pass.
`pnpm exec vitest run --config vitest.config.ts tests/library.test.ts -t "verified owner namespace resume lifecycle"`
passes 4 tests with 7 unrelated existing tests skipped. These controlled transport
checks exercise expired and still-valid shorter leases, all eligible workspaces,
covered-lease no-op, same-session coalescing, stale credential/deployment completion,
exact 409 readback and malformed success receipts. They do not establish actual
browser login/relogin, multiple live tabs, native historical REPORT reopening or
live Cloudflare acceptance. The prior publication-fixture 404 browser failure at
0f1b7215 also remains unresolved in this checkpoint.

### Canonical checkout continuation

The old writers stopped and published all nine unfinished source files at
`0fd055b23a4db047670dbabe079d7714f68d64d6`. The canonical Cybertech checkout
was first fast-forwarded to reviewed remote main `2a26cce4`, then to that exact
saved exchange head on local main. Remote main was not advanced. The existing
`agent/product-resume-20261002` branch remains the parent-reviewed exchange;
no additional branch, worktree, credentials, deployment or live renewal was made.

The first bounded follow-up preserves `EVIDENCE_SOURCE_NOT_LIVE` as a typed
draft-read denial and supplies the exact structured
`404/ARTIFACT_PUBLICATION_NOT_FOUND` for the synthetic unpublished draft's
publication endpoints. Node syntax, exact-file ESLint and whitespace checks pass.
Current-migration native purge-race and mounted browser proof remain pending;
these static checks do not qualify the complete session feature.

Parent review also identified per-snapshot history fanout and unbounded window
work in the saved SQL design. The three owner-requested Luna/max workers are
finishing disjoint backend, PWA and shared-history checkpoints under one
serialized validation lane. Earlier test results are not current-head evidence.

The bounded PWA continuation connects verified-session expiry to the existing
global private-data clear and refreshes Library, Projects and saved Research
history after the same session's namespace check completes. Creation now uses
an authoritative catalog readback before selecting a usable workspace. Manual
renewal controls and related instructions are removed. The callbacks retain
session, deployment, health, expiry and disposal fences; restoring access does
not select a source, open a report or start Research. Two small source helpers
separate session lifecycle and existing health-error classification to retain
the source-file budget.

This PWA source checkpoint is saved independently while the atomic renewal and
shared-history integration are still in assembly. Compilation, scoped lint,
mounted lifecycle tests and current-migration native history proof are pending
at publication. The publication-absence fixture now uses the API's required
`application/json` MIME type. The draft-reader test adds the known terminal
source denial while retaining the unknown-authority 503 control; native proof
remains pending. No live session, lease, report or deployment is changed.

The PWA source follow-up at `b6671db3` passes PWA typecheck, exact-file ESLint,
publication fixture syntax and scoped whitespace checks. The root then took
over the unsaved history integration. Its minimal shared history records one
event per policy transition and one immutable sequence floor per snapshot;
indexed policy identities and transition endpoints replace snapshot/login
fanout and window scans. Original policies are reconstructed at capture time,
including leases expired at replay time. Original bytes, fresh member-source
authorization, explicit revocation and the existing semantic-change denial
remain separate from lease renewal. The receipt prepare, exact policy CAS and
APPLIED promotion now share one D1 batch. Focused native and mounted functional
checks are pending on this saved integration checkpoint.

### Verified repository checkpoint

The ordinary owner REPORT and the mounted PWA lifecycle both pass on published
`2876576eb48582bdcb6ddcb8fa389b8e434798f8`. This supersedes the pending functional
results above. The original REPORT test reads metadata and exact section bytes
before renewal, renews its existing still-active shorter policy through the public
POST, and reopens the same metadata and identical bytes with the new credential.
The original REPORT intent/outbox and model-attempt count stay unchanged.

The server's post-renewal 410 came from a second exact member-policy-closure
comparison in the artifact reader. The historical scope service had already
reconstructed the original policy hashes, but the reader still rejected the
lease-dependent hash change. Its narrow exception now requires the original
owner grant and a durable APPLIED receipt/history witness after the snapshot's
immutable floor, with no semantic change or PREPARED receipt. All other scope
identity comparisons, current navigation/source authorization, revocation and
purge checks remain. The separate late-purge error classification uses the
existing typed authority mapper; unknown errors retain retryable 503.

The default mounted browser driver confirms authoritative workspace creation
readback, renewal of two shorter ACTIVE leases to the verified session expiry,
Library/Projects/history recovery, no automatic selection/report opening/run/query,
saved report section/citation/evidence reopening, JWT-expiry global private clearing,
and a released late history callback remaining fenced. Both exact unpublished
draft publication paths return structured 404 with application/json. Existing
browser regressions also pass. Driver corrections use exact current endpoints
and section buttons, await actual session/configuration readiness, and preserve
the established offline run-identity continuity while still clearing report bytes.
JWT expiry clears the run identity as well.

Commands and evidence for the parent-reviewed PR:

| Source checkpoint | Command | Result |
| --- | --- | --- |
| 2876576e | Focused native command below | PASS: 5 tests, 28 skipped, 2 files; exit 0, 60.99s |
| 5a2248b1 | `pnpm --filter @eliotr/core exec vitest run test/source-namespace-read-scope-renewal-http.test.ts test/artifact-draft-reader.test.ts --reporter=verbose --maxWorkers=1` | PASS: 25 tests, 2 files; exit 0, 29.89s |
| 2876576e | `pnpm test:library-browser` | PASS: default mounted Chromium driver; exit 0 |
| ae71911d, unchanged PWA source through 2876576e | `pnpm build:pwa` | PASS: static PWA build; exit 0 |
| 2876576e | `pnpm typecheck` | PASS: repository TypeScript build; exit 0 |
| 2876576e | `pnpm exec tsc -p apps/eliotr-core/test/tsconfig.json --pretty false` | PASS: native test compilation; exit 0 |
| 2876576e | Exact-file ESLint over the 23 changed TS/mjs files from 0fd055b2; Node syntax checks for both browser fixture files; `git diff --check 0fd055b2 HEAD` | PASS; exit 0 |
| 2876576e | `pnpm check:affected` | FAIL: SQL depth 100, contract hashes, boundaries and negative boundary checks PASS, then 18 source-budget violations; exit 1 |
| 2876576e | `pnpm build:worker` | PASS: local Wrangler minified dry-run; 3373.96 KiB raw / 779.24 KiB gzip; exit 0 |

```text
pnpm --filter @eliotr/core exec vitest run test/owner-session-history-http.test.ts test/research-run-status.test.ts --reporter=verbose --maxWorkers=1 --testNamePattern 'reopens an original REPORT|reopens an actual synthesized, audited and materialized research-handlers.exploratory.v3 draft after login|denies foreign owners, service tokens|does not turn explicit original-grant revocation|does not revive explicitly revoked original grants'
```

The five current-checkpoint tests include the original REPORT renewal/reopen,
actual v3 synthesis/audit/materialization/login plus its late-purge denial, and
foreign-owner/service and explicit original-grant revoke denials. Earlier failed
fixture runs are superseded by these saved-checkpoint results.

Read-only inspection of handoff Git blobs confirms the same 18 over-limit areas
already existed at 0fd055b2. Their measurements are not all unchanged: the touched
artifact reader grows from 870 to 902 lines; Core and PWA package totals remain
over their limits. No limits were raised and no violation was waived. The chained
gates after source budgets did not execute. Full S92, complete CI, live Access
login/relogin and live migration/deployment qualification remain pending. No Rust
source changed, and no live lease, report, grant, credentials or deployment was
mutated. No implementation status was promoted to LIVE. The existing exchange
branch is published for the parent to review/merge; remote main is parent-owned.

### Bounded reader and independent-gate follow-up

The next source checkpoint is `4633062e51a62957f1ca2b466aad14f32b972016`,
published only to the existing `agent/product-resume-20261002` exchange. Remote
main remains `2a26cce4e121181f39f8d539f723540f55db4250`. Commit `0d053b56`
changes only the renewal fixture's mocked issuer to an explicit example hostname,
fixing its newly discovered privacy-scan failure without changing the scanner.
Commit `4633062e` mechanically extracts the reader's contracts/error, immutable
object readback, and scope fingerprint helpers. The core is now 576 physical
lines; helpers have 94, 231 and 45 lines. Extracted function bodies and the
retained SQL/call sequence match ed400819; there is one error-class definition
and the existing core export re-exports that binding.

The source scanner's exact limits remain 600 physical lines/file, 10,000 source
lines/package, 614,400 Worker source bytes, and 2,097,152 PWA source bytes. It
counts TS/TSX/JS/MJS under package/app `src`, including colocated tests. It does
not measure emitted artifacts or startup/heap/CPU. No limit or check was weakened.

| Source area | Handoff 0fd055b2 | ed400819 | 4633062e |
| --- | ---: | ---: | ---: |
| cloudflare-ai/dynamic-route-qualification.ts | 617 lines | 617 | 617 |
| cloudflare-ai/dynamic-route-rest-codec.ts | 684 | 684 | 684 |
| cloudflare-ai/model-gateway-response.ts | 609 | 609 | 609 |
| cloudflare-artifacts/artifact-draft-reader-core.ts | 870 | 902 | 576, within limit |
| cloudflare-erasure/inventory.ts | 673 | 673 | 673 |
| cloudflare-research/model-attempt-store.ts | 706 | 706 | 706 |
| cloudflare-research/research-owner-qualification-renewal.ts | 601 | 601 | 601 |
| cloudflare-research/research-report-admission.ts | 603 | 603 | 603 |
| cloudflare-research-stages/research-claim-audit-input.ts | 644 | 644 | 644 |
| contracts/schema-registry.test.ts | 634 | 634 | 634 |
| core/http.ts | 859 | 859 | 859 |
| core/research-semantic-composition.ts | 711 | 711 | 711 |
| core/wiki-publication-store.ts | 628 | 628 | 628 |
| cloudflare-ai package | 13,432 lines | 13,432 | 13,432 |
| cloudflare-research package | 25,670 | 25,670 | 25,670 |
| core package | 33,435 | 33,455 | 33,455 |
| pwa package | 16,667 | 16,760 | 16,760 |
| Worker source bytes | 1,667,487 Git-blob bytes | 1,698,536 Windows-tree bytes | 1,698,536 Windows-tree bytes |

The Worker byte measurements are different representations, so they do not
establish a like-for-like growth delta. Both exceed the same cap. All 18 failing
areas existed at the handoff; the reader extraction removes one, leaving 17.
The PWA source measures 936,778 bytes, within its source-byte cap. The extracted
artifact package measures 4,818 source lines, within the 10,000-line cap.
AGENTS and the scanner distinguish
these maintainability heuristics from S90 release targets: compressed Worker
at most 4 MiB and initial PWA JavaScript at most 600 KiB gzip, plus runtime/load
measurements. The mandatory aggregate and CI source-budget job still enforce
the source limits. No documented standing budget waiver was found.

The previously skipped independent gates were executed on ed400819:
`work-packets:check`, `branch-hygiene:check`, `delivery:check`, `ingest:check`,
`projection:check`, `evidence:check`, `erasure:check`, `gemini:check`, and
`check:implementation-status` all exit 0. Packet coverage is 46 packets and
561 exclusive claims; branch-hygiene fixtures pass 17 tests without cleaning
actual branches. The registry remains 43 IMPLEMENTED_NOT_LIVE and zero
LIVE_QUALIFIED. An additional `launch:code` run exits 1 because required ERASURE
and RETRIEVAL slices are disabled; no slice was enabled by this task.

On the 4633062e source candidate, `pnpm typecheck`, exact-file ESLint over the
26 changed TS/mjs files from 0fd055b2, native test compilation
(`pnpm exec tsc -p apps/eliotr-core/test/tsconfig.json --pretty false`), and
`pnpm build` all exit 0. The Worker build is a local minified dry-run:
3373.98 KiB raw / 779.33 KiB gzip. These emitted measurements are distinct from
the failing raw-source scan.

Full `pnpm lint` exits 1 with 533 errors and four warnings. Of these, 522 errors
and all warnings are in 25 ignored local/generated files: 24 files under
`.eliotr-state` and generated `apps/eliotr-pwa/public/agent-inbox/app.js`.
The remaining 11 errors are in six tracked files unchanged from 0fd055b2:
`computer-agent-connection-store.ts`, `computer-agent-route-readiness.ts`,
`build-agent-inbox.mjs`, `research-external-branch-analysis.ts`,
`external-model-secret-store-codec.mjs`, and `s92-continuity.mjs`. The ESLint
configuration and lint command are also unchanged. No touched feature file is
among the findings. This is source classification, not proof that the historical
handoff ran lint. No ignored user state was removed and no lint rule was relaxed.

`pnpm test:provisioners` initially exits 1 at the new renewal fixture hostname's
privacy scan. After 0d053b56, the scan and mocked provisioner runner pass, then
the separate deployment-ordering fixture exits 1 at
`Generated deployment semantic configuration drift (ELIOTR_RESEARCH_SEMANTIC_CONFIG_JSON_0)`.
Its explicit static fixture is merged with the default ignored local runtime
configuration. The implicated tracked deploy/test/config-loader files are
unchanged from 0fd055b2. The drift guard remains intact; the ignored configuration
was not inspected for content or edited. The skipped local-owner gate was then
run independently and passes all 36 tests on the combined source candidate.

Every Cargo subgate was attempted independently on ed400819 after `rust:check`
stopped at its first boundary failure:

| Command | Result |
| --- | --- |
| `pnpm rust:boundaries` / first step of `pnpm rust:check` | FAIL, exit 1: abi_version.rs lacks module-level forbid unsafe attribute |
| `pnpm rust:vectors` | PASS, exit 0 |
| `pnpm rust:fmt` | FAIL, exit 1: formatting in kill_s10_case_id, kill_s10_ssi_model and kill_s10_stable_id_parser tests |
| `pnpm rust:clippy` | FAIL, exit 101: 10 expect_used/panic/single_match findings in kill_s10_ssi_model, kill_s10_ssi_parser and kill_s10_stable_id_parser tests |
| `pnpm rust:test` | PASS, exit 0: nextest workspace/all-features/locked and all workspace doctests |
| `pnpm rust:deny` | PASS, exit 0 |
| `pnpm rust:wasm` | PASS, exit 0: default 138 raw / 135 gzip bytes, self-test 1,619,213 raw / 79,478 gzip bytes, zero imports |
| `pnpm rust:coverage` | PASS, exit 0: pinned nightly branch-aware run meets the 90% line threshold; exact percentage not extracted |

All five Rust failure-source files and the boundary checker have identical blobs
at 0fd055b2 and ed400819. That establishes inherited source conditions, not a
historical passing or failing run. Rust remains failed despite the other passing
subgates. Automatic approval review rejected the proposed one-line
`#![forbid(unsafe_code)]` edit to abi_version.rs as outside this bounded feature
scope, citing a standing no-Rust-changes restriction. No edit was applied and no
alternate path was attempted. The reviewer applied the earlier bounded task
scope as a no-Rust restriction; no blanket Rust-edit prohibition was found in
repository AGENTS or the language/runtime contract. The parent explicitly directed continuation in
authorized files without retrying that rejected edit.

The combined source checkpoint is `10b305e5bf072275269bc89f2467cb0da9f332bb`.
Its final narrow commit adds O2's explicit classification/column specs for the
four tables introduced by migration 0103: lease receipt (21 columns), policy
event (22), policy identity (6), and snapshot baseline (5). All 54 columns are
portable scope provenance. Live `scope_read_policy` remains NOT_A_BACKUP and
unknown tables/columns still fail closed. This fixes a real feature integration
gap discovered by the first full root run; no active access is transferred.
The backup package is 9,881 source lines, within its cap. No status promotion or
restore/live qualification claim accompanies this change.

| Source checkpoint | Command | Result |
| --- | --- | --- |
| 4633062e, before backup coverage fix | `pnpm test:root --maxWorkers=2` | FAIL, exit 1: 1548 PASS / 5 FAIL; 160 PASS / 3 FAIL files; 55.54s |
| 10b305e5 source candidate | `pnpm typecheck`; exact-file ESLint over all 29 changed TS/mjs files from 0fd055b2 | PASS, exit 0 each |
| 10b305e5 source candidate | `pnpm test:root --maxWorkers=2` | FAIL, exit 1: 1552 PASS / 1 FAIL; 162 PASS / 1 FAIL files; 55.99s; all four new backup failures fixed |
| 4633062e reader source, unchanged by backup-only 10b305e5 | `pnpm test:worker` | FAIL, exit 1: Core 729 PASS / 66 FAIL / 7 SKIP / 1 TODO tests; 81 PASS / 23 FAIL / 1 SKIP files; 967.73s; chained artifact suite skipped |
| 10b305e5 | `pnpm test:local-owner` | PASS, exit 0: 36 tests, 8.11s |
| 10b305e5 | `pnpm test:artifacts-worker` | PASS, exit 0: both complete native artifact files, 2 tests, 37.07s |
| 10b305e5 | `pnpm --filter @eliotr/core exec vitest run test/source-namespace-read-scope-renewal-http.test.ts test/artifact-draft-reader.test.ts --reporter=verbose --maxWorkers=1` | PASS, exit 0: 25 tests, 2 files, 41.86s |

The one remaining root failure is unchanged
`packages/research/src/research-question-migration.test.ts:63`: raw schema SQL
retains CRLF from working-tree 0016 and LF from 0069. The trigger bodies match
after newline representation; migration 0103 does not touch ledger guards. No
existing guard assertion or user working-tree SQL file was normalized to hide it.

The full Core result is preserved as failed, without inferring a historical run
from identical source blobs. Representative failures include a navigation fixture
that never applies 0103, preexisting artifact-batch FK failures whose exact FK
was not identified, one model-attempt timeout, and Workflow preparation/storage
failures. No direct 0103 cause was established for these inspected entries. The
full log has no per-test success output for the changed reader/history files;
their acceptance comes from the explicit focused commands instead. Further old
failure classification stopped at the parent's direction. The full Core failure
still blocks a green mandatory gate.

The five-case primary history command shown above was rerun on 10b305e5:
four PASS, one FAIL, 28 skipped, exit 1, 90.82s. The actual v3
materialization/relogin and the three foreign/revoke denials pass. Original REPORT
hits its existing 30,000ms test timeout (34.80s reported); this is retained as a
failure rather than weakening the deadline. The one isolated retry below also
exits 1 at the same timeout: one failed test, 40.38s run / 35.02s test time.
No test deadline was raised. Original REPORT acceptance is therefore blocked
on the current source checkpoint; its earlier 2876576e PASS is historical.

```text
pnpm --filter @eliotr/core exec vitest run test/owner-session-history-http.test.ts --reporter=verbose --maxWorkers=1 --testNamePattern 'reopens an original REPORT'
```

The final `pnpm check:affected` on 10b305e5 exits 1: exact depth-100 SQL compile,
normative contract hashes, package boundaries and all negative boundary checks
PASS, then source budgets FAIL on the same 17 remaining violations in the table.
The later chained gates do not run in that aggregate; every one was separately
attempted as recorded above. The aggregate is not presented as passing.

Complete local logs are retained under the existing temporary validation folder
`C:/Users/kleym/AppData/Local/Temp/eliotr-gates-ed400819/`: provisioner initial and
post-fixture logs, candidate static/build logs, full root/Core logs, backup
candidate static/root log, independent owner/artifact log, reader-renewal log,
primary-history log, isolated original-report log, and final check-affected log.
The folder name identifies the starting stage; per-row source SHAs above
identify the actual checked source. Earlier Cargo/independent-gate outputs are
recorded in the tool transcript and this command/result inventory.

Merge criteria remain separate from later qualification. This is a concrete
source checkpoint for parent review, with the touched reader budget fixed and
the new backup integration gap fixed. A green mandatory merge gate is still
blocked by current original REPORT timeout, the 17 source-budget violations, full lint failures, local provisioner
fixture/config isolation, the root SQL-newline snapshot failure, full Core native
failures, and Rust boundaries/fmt/Clippy. No documented waiver was found and no
CI run was requested. Neither a local emulator nor a passing focused test closes
those failures. The parent owns the merge decision and remote main.

Live/release qualification is still later work: full S92 local acceptance,
then approved isolated S94 staging, S93 provider/profile receipts and budget,
S95 exact-build security/restore evidence, S96 5/20/50-reader load with approved
spend/stop rules, and S97 retained release receipts/T0-T6/production approval.
The controlled PWA driver is client-only acceptance; its passing 2876576e result
remains applicable to unchanged PWA source, not a live Access login or deployment
receipt. GET system/session remains read-only. No live lease, grant, report,
provider/model spend, migration, deployment, manual CI, user settings or
credentials was mutated, and no implementation status was promoted.

### Functional recovery after parent checkpoint 8fce2caa

The parent normalized only SQLite schema-text line endings in the root migration
test at 8fce2caa. Its three cases, scoped lint and typecheck PASS locally; the
migration bytes and structural/guard assertions remain unchanged.

Root reproduced revoked cached-query replay returning a storage-uncertainty
error. The result store already reports invalidation and missing historical
identity as typed retrieval errors; the HTTP service discarded those errors in
its unconditional load catch. The service now preserves their existing typed
mapping and retains fail-closed uncertainty for unknown failures. No grant,
result bytes, policy, or scope mutation was added. Three catalog/source tests
were also aligned with the current explicit-delegated-project rejection code;
the service reads remain rejected with 403 before SQL.

Validation: `pnpm typecheck` and scoped ESLint PASS. The complete native files
`research-query-replay.test.ts`, `catalog-service.test.ts`, `index.test.ts`, and
`source-revisions.test.ts` PASS: 49 tests, four files, 41.77s, one worker. This
includes revoke/expiry/purge, legacy identity, corruption, exact replay/no-write,
foreign-owner, and cursor/current-authority cases. Before-fix repros and final
outputs are retained in `eliotr-provisioner-and-shared-repros-8fce2caa.log` and
`eliotr-fixture-checkpoint-and-query-replay-8fce2caa.log` under OS temp. The full
Core suite and aggregate merge gate have not yet been rerun for this change.

The next fixture checkpoint replaces manually selected navigation/scope DDL
with the complete current Core migration chain on isolated reset bindings.
Navigation sources now have their current head and exact read policy; grant
inserts name base columns explicitly. The PROJECT resilience fixture records
the authenticated project owner. Production authority and migrations are not
changed. Native complete files PASS: navigation 18/18 in 27.24s; scope persistence
12/12 plus orientation resilience 12/12 in 26.11s. Revocation, corruption,
expiry, lost acknowledgements, concurrent writes and post-read races remain
covered. Scoped lint and typecheck PASS.

Deployment ordering now selects a deterministic, explicitly named runtime
configuration in a validated OS-temp directory and derives all semantic
transport vars from that fixture. It cleans up only that exact temp-root child;
semantic drift still blocks migration/upload before any simulated mutation.
The full `pnpm test:provisioners` PASS, including local-owner 36 cases; after
moving the cleanup validation into a helper for `no-unsafe-finally`, scoped
lint and the direct ordering script PASS all 12 groups on 3c376dbc. An intervening
direct run correctly refused uncommitted production execution inputs before
the replay source checkpoint was committed; that guard was not bypassed.
All deployment calls in this test are harnessed: live Cloudflare NOT_EXECUTED.

Logs: `eliotr-functional-groups-8fce2caa.log`,
`eliotr-navigation-related-and-fk-8fce2caa.log`, and
`eliotr-final-fixtures-and-change-repro-3c376dbc.log` under OS temp.
These focused results close only the identified fixture failures. Further Core
groups, REPORT timing diagnosis, source budgets, broad lint, Rust and live
qualification remain open; there is no passing aggregate gate claim.

The next focused fixture checkpoint preserves the current retrieval fallback:
an authorized projected document can supply bounded, exact LEX context when
direct text matching misses. Tests now assert the pinned source revision,
excerpt and SAMPLED coverage; a real empty owner PROJECT tests genuine NONE.
SEM drift/unpromoted cases still discard SEM and retain independently admitted
LEX context. Full retrieval/SEM/change files PASS: 18 cases, 24.23s. The change
feed test uses a canonical empty GLOBAL_LIBRARY scope and exact revocable grant.

Artifact draft fixtures now freeze a canonical empty PROJECT snapshot instead
of inventing its ID. Migration 0060's change-feed trigger references that
snapshot through 0043's foreign key; the missing snapshot caused the atomic
draft batch to roll back. All eight complete artifact storage cases PASS,
including rollback, lost acknowledgement, concurrency and immutable replay.
Neither migration nor production admission rules were changed.

Admission fixtures use the production owner installer with explicit local,
zero-spend configuration. They do not qualify a route or execute paid models;
native background Workflows are terminated after durable admission. Current
HTTP input identity and reference-manifest files PASS 14 and two cases. All
four held-scope cases PASS after using the actual owner profile and a valid
conflicting profile candidate (a different version retains its 64-source SQL
ceiling). Foreign/revoked/currentness/idempotency negatives remain unchanged.

Wiki positive fixtures now admit an actual owner scope and current policy and
deployment, then publish through the public owner service, which builds the
currentness witness itself. Arbitrary reviewer strings are no longer accepted
as publication authority. The complete storage/service files PASS seven cases,
including missing authority, exact objects, one CAS winner, replay and corrupt
body rejection. Production guards and witness construction are unchanged.
Scoped Core compilation and lint PASS for these files and helpers.

Focused logs under OS temp: `eliotr-retrieval-and-change-fixtures-a979c765.log`,
`eliotr-artifact-workflow-admission-groups-a979c765.log`,
`eliotr-held-scope-profile-fix-a979c765.log`,
`eliotr-workflow-wiki-and-held-repros-a979c765.log`, and
`eliotr-wiki-workflow-and-continuation-a979c765.log`. Earlier failed attempts
remain recorded; the final held-scope run is four PASS and the Wiki run seven
PASS. Workflow continuation diagnostics, older session assumptions, REPORT
timing and the broader gates remain in progress.
