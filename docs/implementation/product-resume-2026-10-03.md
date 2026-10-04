# Owner configuration and functional integration checkpoint — 2026-10-03

Baseline: published `main` source `e6da93c` (2026-10-03).
Status: integration in progress; this document is not release acceptance.

## Product changes under integration

- The owner can browse the Cloudflare Workers AI catalog and save an exact
  project model configuration revision. Selection preserves provider, billing
  mode, credential alias, transport constraints and qualified model identities.
  A missing selection blocks a new run without blocking saved-document reading.
- Owner template v2 separates durable configuration choices from current access,
  scope, cancellation and execution authority. V1 keeps its original expiry
  rules. See [ADR-0010](../adr/0010-project-model-revisions-and-run-authority.md).
- New Research runs capture the selected configuration before Workflow creation.
  Recovery and historical COW reuse the originating snapshot. Migrations
  `0104`–`0106` implement capture, explicit qualification revocation and immutable
  project configuration history with owner/generation/CAS fences.
- Managed OAuth MCP uses a verified human identity and one current project.
  Bounded exact document reading is independent of search projection availability.
  Headless service-token diagnostics retain their separate protocol. The native
  maintenance transition preserves PWA Access separately; see
  [ADR-0014](../adr/0014-maintenance-managed-oauth-mcp-transition.md).
- Offsite backup now retains authenticated encrypted object bodies and verifies
  the exact body/digest on read. Migration `0107` adds target-bound restore
  intent, attempt and receipt storage; these control records are not portable
  backup data. Production restore target/admission composition remains pending.
- Guarded maintenance keeps D1 migration application separate from Worker
  deployment. The narrow AI Search binding transition is defined by
  [ADR-0011](../adr/0011-maintenance-ai-search-binding-bootstrap.md); it cannot
  create resources or enable other slices.
- An owner-only AI Search functional probe intersects one project with one
  selected current source and resolves one native shadow locator through the
  exact evidence reader. Immutable START/terminal records prevent a repeated
  provider call after an uncertain effect. Its result carries no qualification
  authority; see [ADR-0012](../adr/0012-owner-ai-search-functional-probe.md).
  A new HTTP scope snapshot can make a reused request return UNKNOWN without
  issuing another query; receipt replay requires the original pinned scope.
- Project configuration import persists the canonical semantic revision before
  selecting its immutable configuration. The empty-table constraint repair in
  `0108` uses short D1-compatible GLOB predicates and refuses nonempty tables;
  see [ADR-0013](../adr/0013-empty-semantic-revision-constraint-repair.md).

## Observed checks

These results describe the local integration snapshot, not an attested deployed
build. The final source SHA and necessary checks must be recorded after assembly.

| Check | Observed result |
| --- | --- |
| Workspace TypeScript build | PASS |
| Whole-tree ESLint | PASS at the prepublication checkpoint |
| Root Vitest suite | 175 files, 1615 tests PASS |
| Core native Worker suite | Initial run: 104 files passed, 11 failed, 1 skipped; 828 passed and 21 failed tests. Follow-ups: five corrected files / 13 tests PASS, three further files / 33 tests PASS, session file / 15 tests PASS. Native current-dispatch scenario PASS: completes the Workflow, materializes verified evidence and reopens/replays without another model call |
| PWA build | PASS |
| Generated binding types | PASS; generated file retained outside tracked product sources |
| Worker dry run | PASS; gzip upload approximately 816 KiB |
| PWA emitted JavaScript | Conservative sum of all emitted JS gzip 208,676 bytes, below the 600 KiB initial-JS target |
| Repository boundaries and eight negative boundary fixtures | PASS |
| Privacy large-line regression and full privacy scan | PASS |
| Depth-100 SQL compilation | PASS for 107 Core migrations / 472 statements, including the empty-table repair |
| D1 migration application and reconciliation | All five intended migration applications succeeded. The earlier `UNKNOWN` receipt remains unchanged. A fresh read-only reconciliation verified all 52 expected schema objects; the migration ledger had no pending names and reported `ALREADY_APPLIED`, with zero apply attempts and zero writes |
| Native COW/owner-loop final cases | 7/7 PASS on `e6da93c`; a unique attestation was observed |
| `check:affected` | FAIL on source-maintainability budgets: 22 counted violations versus 18 at the October 3 integration baseline (`78c6595`), or four additional threshold crossings; no full-release pass |
| Live Workers AI access | One direct bounded GLM-5.3-Flash response observed; not a Research run |
| AI Search metadata | Private namespace and five exact empty Built-in instances created and read back; no READY, indexed-content or evidence claim |
| Managed OAuth Access application | Separate owner-only `/mcp` application created and read back with a 24-hour session; existing PWA application remains at 168 hours. Worker variables and client OAuth connection are still pending |
| Native Cloudflare MCP operator connection | Supported App Server OAuth login completed; three tools available, including `execute`. A fresh process completed the supported GET-only Access verification and emitted the standard managed-OAuth receipt |

The emitted-size observations do not measure Worker CPU/heap/startup, production
asset delivery or the full S90 resource matrix. Private operator observations
and browser captures remain outside the public repository. The final native
scenario passed with a background Workerd request-cancellation warning; a live
functional run is still required. The full Core suite was not rerun.

## Remaining functional acceptance

1. Perform the guarded Worker candidate deployment and exact readback. D1
   migration application and readback are recorded above; the earlier
   `UNKNOWN` receipt remains unchanged.
2. Use fresh current owner approval, source admission and bounded real model
   qualification. Old route approvals, expired source evidence and prior-model
   receipts cannot be relabelled for the new tuple.
3. Observe normal source admission/outbox projection, actual indexed/readback
   counts and one owner-scoped managed locator resolving into exact evidence.
   This functional observation does not promote a shadow generation. Full S1
   retains its golden-set and qualification gates, deferred with quality testing.
4. Complete the real Managed OAuth client connection and its project/document/
   search/run/citation path. The owner-approved Access app and native Cloudflare
   operator readback are verified; the deployed Research client connection
   remains to be completed.
5. Complete one free, owner-scoped Worker-backed Research run through real
   REPORT output and reopen. Verify the functional owner document-to-DRAFT/reopen
   path on the final build, then perform the responsive workspace changes and
   browser comparison. Quality, cognitive and load testing remain deferred.

The owner permits only free bounded functional checks. Cognitive, quality and
load testing is deferred. Full S92–S97 acceptance, disabled slices and production
restore closure remain separate outstanding criteria.

## 2026-10-04 integration checkpoint

- Separate post-upload reconciliation reached `AUTHORITY_SYNCED_POSTUPLOAD_RECONCILED` at 04:19 UTC; ten assets, owner health,
  capability state and exact current D1 authority were verified. The standard asset-readback failure remains; no standard
  deployment receipt or full deployment PASS is claimed.
- Deterministic README import (no AI) admitted a new head; exact 12,688-byte R2 content matched the repository digest.
  Project revision 3 preserves two entries and adds the README. Live FAST_SEARCH returned the exact 3,103-byte excerpt,
  matching trace and `SAMPLED` scope. Exact/lexical checks are ready; semantic was not requested, currentness `NOT_VERIFIED`.
- SDK predecessor-fingerprint CAS and reactivation target-existence gate passed an offline SQLite audit. Native CF Dynamic
  Route SDK request-port and `--gateway-transport cloudflare-mcp` installer preserve Wrangler D1; focused checks 10/10 with
  the MCP fixture and full TypeScript passed. No model calls were made.
- Public Research MCP DCR callback/single-resource configuration are fixed; one conformant native registration returned
  201, but native OAuth completion failed (provider-compatibility cause unconfirmed). MCP acceptance remains open; Report
  was not executed.
- The Sources / center Report / right context composition awaits final review and browser QA. Prior 35-file / 328-test results precede
  the last bounded label/layout correction and are not final UI acceptance.
- Only free bounded functional checks remain authorized; quality/load are deferred. Last recorded source-budget result:
  22 findings vs 18 baseline, not rechecked here. Full-release gates and production restore remain unaccepted; no new ADR
  authority or overall completion is claimed.

## 2026-10-04 live acceptance checkpoint

- Standard normal Worker deployment PASS: version and 11 assets were read back, and authority rotation was verified.
- The snapshot-currentness fix and one guarded, balanced D1 repair passed. Core Readiness is VERIFIED; the original capture
  bytes and capture time were preserved.
- Native Cloudflare MCP transport recorded two real GLM qualifications as LIVE. Candidate and proof records are staged in
  D1 without global promotion.
- Import and Report remain NOT EXECUTED: local assembly normalization and missing CSRF consumed the 15-minute proof
  window. Historical expired proofs remain preserved; renewal is pending.
- Native Research OAuth remains uncompleted; an Access-allowed log does not establish OAuth success. The source-budget
  check remains 22 FAIL, and broader release, ERASURE and RETRIEVAL remain open. Cognitive, quality and load testing remain
  explicitly deferred.

## 2026-10-04 live functional checkpoint — 07:35 UTC

This is a later, bounded checkpoint. Earlier checkpoint sections remain intact as historical observations; they are not rewritten or reused as current authority. The statements below apply only to the items and times explicitly listed here.

- Product fix `f85bff6874defd04b35161725f035ca4f7a09714` removes the legacy JSON overlay from selected-project readiness. One focused regression, Core typecheck, scoped lint, and an independent read-only audit passed.
- The normal Worker deployment at 07:23 UTC completed as version 65. All 11 asset readbacks matched that version, and authority rotation passed. This maintenance deployment is not a full release: the source-budget gate remains FAIL at 22 findings, and Erasure and Retrieval remain disabled.
- Renewed LIVE proofs remain bound to the same immutable candidates. Project configuration import created revision 1 at 06:57 UTC; a fresh readiness check for the selected configuration passed at 07:24 UTC.
- One actual PWA run was created and accepted at 07:27 UTC. It reached `ANALYZE_BRANCHES`. At 07:34 UTC, a `GET` status read surfaced `WORKFLOW_STAGE_OUT_OF_ORDER`, with stage 8 expected next; an answer was unavailable. The run did not produce an available Report artifact. Q1, Report, and reopen acceptance remain NOT ACCEPTED.
- Native Research OAuth remains incomplete after the provider returned `invalid_request` for a malformed consent request. No successful native client authorization is claimed.
- Cognitive, quality, and load testing remain deferred. Do not infer model calls or a completed report from run creation or stage progress.

## 2026-10-04 local integration checkpoint

- Full native step-7 output matches the committed D1 predecessor byte for byte. A migration-backed regression reproduces a false stage-order rejection when Worker time is ahead of D1 and the requested lease is exactly ten minutes. The rejected live insert retained no expiry, so its specific failed predicate remains unproven.
- Fresh workflow leases are now bounded by both Worker and D1 clocks. Existing cached grants, persisted attempts, recovery rules, stage durations, and the migration's ten-minute cap remain unchanged. The focused lease regression, unified Core typecheck, and independent source audit passed.
- Run admission and semantic binding were extracted without changing selected-project capture for new runs or immutable snapshot replay for existing operations. Independent review caught and corrected an optional-role regression and a declaration-order error before publication; the final source audit passed.
- The PWA presents one failed-run headline and retains diagnostic fields in Run details, including when a draft is available. Its focused tests, typecheck, lint, and independent source audit passed; browser verification of the new assets is still pending.
- Development tooling now uses Wrangler 4.143.1 and Cloudflare Vitest plugin 1.3.2. A frozen install and actual installed-version checks passed. Compatible patched transitive dependencies were updated; the previously identified unpatched advisory remains open.
- These are local integration results, not a completed live scenario. The original run remains failed without an answer. Changed backend fingerprints cannot resume it under the existing compatibility policy; do not rewrite its snapshot or fingerprint. A new run requires deployment of the fix and current qualification proofs. Q1, Report, and reopen acceptance remain NOT ACCEPTED.

## 2026-10-04 project readiness checkpoint — 10:40 UTC

These observations apply to deployed source `2f47196507011bf9d75e71808a0d11d0a9acd44f`, not to later local edits.

- The development toolchain seal now records Wrangler 4.143.1 and the Cloudflare Vitest plugin 1.3.2. Focused seal checks and independent source review passed. This seal is not proof of remotely served Worker bytes.
- Version 66 was uploaded, but the normal deploy stopped on an initial asset content mismatch. That failure remains preserved. One separate, guarded post-upload reconciliation rotated D1 authority to the candidate and read back all 11 assets, owner health/capabilities, the unchanged AI Gateway profile, migration ledger and schema. No standard deployment receipt or full deployment PASS was created for this version.
- Fresh project search returned the frozen README's exact 3,103-byte excerpt and persisted a matching `SAMPLED` scope. This does not establish complete coverage or managed semantic retrieval.
- Two bounded current-Worker GLM 5.3 Flash qualifications completed. A native read-only D1 join confirmed both provider dispatches as `COMPLETED` with the approved observed model and durable output references. They are functional transport/schema observations, not cognitive or answer-quality acceptance.
- The unchanged immutable V7 candidates received current qualification proofs. One owner expected-revision-1 CAS import selected project configuration revision 2. At 10:35 UTC, project readiness returned `ready`, `QUALIFICATION_PROOFS_CURRENT`, with qualification expiry 11:28:54.685 UTC recorded as provenance. The selected immutable V2 configuration retains its exact proof identities; model-proof calendar expiry alone does not block new runs. Legacy/V1 active-route expiry checks remain. The old proofs and configuration revision are not rewritten.
- The browser can reload and read the PWA, but mouse dispatch remains unavailable while the Codex Browser pane is not displayed. No new Run was submitted. Default Library-wide readiness is separate from the verified selected-project readiness; the project must be selected through the owner interface.
- The prior failed Run remains unchanged. A new Run, saved Report DRAFT, exact citation/source reading and reopening the same artifact remain NOT ACCEPTED. Native Research OAuth, source budgets, production restore and broader release gates remain open. Cognitive, quality and load testing remain deferred.

## 2026-10-04 functional run and local integration checkpoint — 11:10 UTC

- Opening the Codex Browser pane restored DOM interaction and screenshots. The owner selected the intended project, read its frozen README, and submitted one bounded functional question through the PWA using the qualified GLM 5.3 Flash configuration. The run did not produce an answer: owner status and the native Workflow instance report an errored execution at stage 10, RECONCILE, with `WORKFLOW_EFFECT_UNCERTAIN`. Diagnosis is in progress; no retry, recovery or snapshot rewrite has been performed.
- The PWA subsequently requested reconnection and retained the input and run reference while clearing private responses. The Connections page still reports server readiness. The cause of this client state is not established; server readiness does not prove that the failed run has recovered.
- Catalog, source revision, namespace lease and navigation adapters now live in the existing Cloudflare navigation library, with Core compatibility facades and an explicit erasure-policy port. Public protocols and SQL remain unchanged. The owned 25-file snapshot passed focused typecheck, lint, package boundaries, independent source review and 47 tests across five affected suites.
- The Research history disclosure now reads “Recent work · Saved runs and drafts”; its 12 existing view tests passed. The change adds no state tracking or network behavior and has not been deployed.
- The frozen offline install passed. The required `pnpm check:affected` ran once and stopped at 18 source-budget failures after the preceding SQL/contract/boundary checks passed. Its later broad checks did not run; full-check acceptance remains open.
- Report DRAFT, citation/source and same-artifact reopen acceptance remain NOT ACCEPTED. Research MCP authorization is being checked against official documentation. No Cloudflare support message was sent. The free functional-only constraint and deferred cognitive, quality and load tests remain in force.

Correction to the earlier general expiry description: the owner V2 path validates exact saved candidate/proof/observation bindings and explicit revocation under the versioned configuration policy. New V2 runs pin that saved selection and bypass calendar-only qualification renewal; authority, source scope, spend and material configuration checks still apply. This is verified against the supplied owner instructions and source paths, not a new live run using an expired proof.

## 2026-10-04 native Workflow diagnosis checkpoint

A read-only Cloudflare API request returned HTTP 200 for the exact failed instance
`run-2b607e3c7569b95f26d35af2e4250c90fe5920143bfefc3e` of
`eliotr-research-workflow`. Its version is
`c4e79fa9-562e-43fc-9d92-0a8c91b77d6f`, and its status is `errored`.
The failed step is `w2-stage-10-RECONCILE-1`, with one attempt from
10:58:27.539 to 10:58:29.819 UTC. Both instance and step expose only
`WorkflowCheckpointError: WORKFLOW_EFFECT_UNCERTAIN`.

This establishes the failed native step, not its underlying exception. The older
stage-8 instance log and the later scope invalidation do not establish this
failure's cause. No instance retry, recovery, model call or remote mutation was
performed for this diagnosis. Normal Run, Report DRAFT, citation/source and reopen
acceptance remain open.
