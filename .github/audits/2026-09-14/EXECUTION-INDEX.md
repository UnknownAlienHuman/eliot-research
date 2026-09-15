# Eliot Research — implementation entry point and complete audit coverage

**Existing work queue: S01–S99, PRs #193–#291. PR #292 holds this execution pack, not another implementation task.** Everything an implementing agent is asked to follow here is in English. Historical source audits are retained in their original language.

Reviewed application baseline: `main@a2aca1277b0edbbed04de66e0d44e383e1b815ef`; task refinement: 2026-09-15. Use current main for code, not the old audit tree. These documentation commits do not implement or deploy the product.

## 1. Start here: choose the next explicit checkpoint

The previous broad task descriptions now have concrete execution steps, starting files, data-flow boundaries, commands and stopping conditions. Each section links its original five-part PR specification.

| Execution guide | Exact tasks | Contents |
|---|---|---|
| [01 — Backend steps](EXECUTION-STEPS-01.md) | S01–S34, S98–S99 | CI/D1 fixes, continuity, shared service grants, query/run/read/MCP, cancel/recover, model lifecycle, full machine ingest and larger project scopes. |
| [02 — Research and product steps](EXECUTION-STEPS-02.md) | S35–S77 | W1 planning and branch checkpoints; every selected Research product; extraction/navigation/search; artifacts/Wiki; Workspace/federation; deletion/backup/restore/queues; complete PWA flows. |
| [03 — Rust and acceptance steps](EXECUTION-STEPS-03.md) | S78–S97 | Named pure-family checkpoints, explicit product ABI, actual caller promotion/removal, finite D1 test batches and final local/quality/native/load/release scenarios. |

The ranges are disjoint and cover all99 assignments. S98/S99 are deliberately placed in the early backend guide despite their late PR numbers. Do not mechanically execute numerical order.

**First executable unit:** S01. Reproduce the five named boundary failures, correct only those dependencies, keep negative tests, then record its implementing SHA. S02 can proceed independently when browser diagnosis is needed. Continue through the dependency-ordered checkpoints below. Do not spend the first run producing another general audit, new project plan, or replacement architecture.

### Read planning material without switching away from main

The specifications live in remote planning PRs; this does not require a local worktree or a branch checkout:

```sh
git status --short
git branch --show-current
git fetch origin refs/pull/292/head
git show FETCH_HEAD:.github/audits/2026-09-14/EXECUTION-INDEX.md
git show FETCH_HEAD:.github/audits/2026-09-14/EXECUTION-STEPS-01.md
```

Keep main as the working branch. Do not reset dirty user work. For an individual task, read its linked file through GitHub or fetch that PR's head and use `git show` for its known path, again without checkout. The three guides contain the actual sequential instructions and all task links. A documentation-only merge is not an implementation result.

### Test commands that must not be conflated

- Root `vitest.config.ts` covers package/PWA/test fixtures, **not** core Worker tests.
- Core `apps/eliotr-core/vitest.config.ts` uses actual local Cloudflare runtime and D1 migrations. Run its targeted tests using `pnpm --dir apps/eliotr-core exec vitest run <test-path>`.
- Use `pnpm exec vitest run <package-test-path>` for root pure/PWA tests. A passing node:sqlite fixture does not establish D1 compatibility.
- Use the specific research/retrieval/ingest/artifact/authority/workflow/recovery/Rust commands named in each checkpoint. Run focused tests while editing; full local owner/document acceptance is an integration checkpoint, not something to repeat after every sentence changed.
- At task completion, use `pnpm check:affected -- --base=<PRE_TASK_SHA>` against the commit immediately before the task, plus the task's actual-boundary tests and affected typechecking. A focused pass is not a whole-project release pass.

## 2. Target and scope

Finish mandatory selected-profile **v1, Slices0–6, gemini-mcp**, under these sources:

- [ELIOT_RESEARCH architecture29.1](https://github.com/UnknownAlienHuman/eliot-research/blob/a2aca1277b0edbbed04de66e0d44e383e1b815ef/docs/architecture/ELIOT_RESEARCH.md).
- [LANGUAGE_RUNTIME_CONTRACT1.0](https://github.com/UnknownAlienHuman/eliot-research/blob/a2aca1277b0edbbed04de66e0d44e383e1b815ef/docs/architecture/LANGUAGE_RUNTIME_CONTRACT.md), with the explicit scoped ABI amendment specified in S88 before its added exports are implemented.
- [ADR-0006](https://github.com/UnknownAlienHuman/eliot-research/blob/a2aca1277b0edbbed04de66e0d44e383e1b815ef/docs/adr/0006-google-external-transport-profiles.md), selected versus legacy Google transport.
- [Production readiness](https://github.com/UnknownAlienHuman/eliot-research/blob/a2aca1277b0edbbed04de66e0d44e383e1b815ef/docs/implementation/production-readiness-plan.md) and [existing execution contract](https://github.com/UnknownAlienHuman/eliot-research/blob/a2aca1277b0edbbed04de66e0d44e383e1b815ef/docs/implementation/launch-prs/execution-contract.md).

Retain one Worker/control plane, D1 Core/R2 canonical authority, rebuildable D1 Search/AI Search projections, TypeScript platform adapters, the documented pure Rust responsibilities, and SQL atomic invariants. Reuse existing Gateway, qualification/readback, Budget Governor, source ownership/residency, and model-effect recovery mechanisms. Do not replace them merely because their names appear often.

Do not introduce unselected legacy drive-exchange/custom OAuth, an obligatory Google Cloud project, client ELIOT runtime/database dependencies, optional Slice7 specialist products or optional Browser Rendering/R2 SQL as new baseline blockers. Basic scientific documents, tables and conversation exports still belong to the declared source-format/corpus requirements.

This is a complete plan for the **known selected v1 requirements and audited findings**. Completion means implemented behavior plus the specified evidence on an accepted version, not zero conceivable future defects or an assurance that no implementation reasoning will be necessary.

## 3. Agreed interfaces and corrections — do not redesign these

| Boundary | Selected implementation |
|---|---|
| Build versus execution compatibility | S05's reproducible backend-input fingerprint, separate from git/build provenance. PWA-only changes preserve runs; unknown backend transitions are not assumed compatible. S67 handles explicit rollback. |
| Service authority | S10's one project_client_grant DTO/table/authorizer, verified actor and owner ceiling. S31 owner CRUD stays under `/api/v1/research/projects/:project_id/client-grants`. No owner_pwa impersonation or private browser JWT. |
| Service ingest and attachment | S98 uses existing bundle operations with explicit namespace permission; project.attach is the existing guarded PUT with unchanged title and append-only membership, not another project API. |
| Cancel/recover | S14/S15's explicit REST contracts and existing status DTO; S32 PWA/MCP uses them unchanged. Confirmed cancellation, completed race and uncertain outcome remain distinct. |
| Paid recovery | Recover committed SYNTHESIZE without repeating it. A not-yet-executed AUDIT_CLAIMS is a legitimate first paid stage under its own budget. No blind retries of UNKNOWN effects. |
| W1 planning storage | The actual APPEND mask forbids portfolio/debt-ref changes. S36 persists the initial immutable planning manifest before CREATE. Runtime observations are checkpoint payloads; changed protected inputs use explicit S40 supersession, not relaxed SQL guards. |
| Research roles/products | One shared branch executor and existing W1/W2/W3, installed role/product profiles, exact evidence, freeze/audit/materialization. No individual scheduler or engine per role/product. |
| Legacy input | S35 preserves accepted unversioned E0/E1/E2 requests. New profile-reference input is explicitly versioned and strict. S24 preserves literal LF/CRLF bytes rather than silently normalizing request identity. |
| Corpus size | S99 fixes owner preview/factory/historical64-source assumptions using the existing larger scope loader and real byte/member envelopes. Top-k results are not the requested denominator. |
| Google external effects | S58 includes service capture/read/conversion before admission; S59 uses demonstrated official connector creation/readback capabilities. No invented provider idempotency, reserved IDs or Markdown-versus-PDF byte equality. |
| Rust starting point | Current workspace has three crates and specific existing canonical/vector primitives, not all intended pure families. Preserve implemented K1/K2a; add only missing documented families. |
| Rust ABI | S88 now gives a closed operation-to-export map. Preserve initial six exports, explicitly amend the contract for pure policy evaluation and structural projection before adding those two exports. No unbounded dispatcher or platform handles in Rust. |
| Duplication and formatting | S28 selects the actual retrieval serializer pair; incompatible serializers remain distinct. S77 shares only proven equivalent text primitives. S76 formats code; S90 measures emitted artifacts/runtime rather than rewarding minification or pointless file splitting. |
| Branches/procedures | S27 removes artificial cap/dated exceptions. Actual application changes stay in current main without local worktrees. Do not merge old thematic code branches wholesale or delete unmerged user work. |

### Boundaries that avoid new circular work

Initial W1 planning manifests are deterministic seeds built from the literal request, explicit user hypotheses/subquestions, installed profile requirements and admitted source metadata. Optional model-proposed refinements run only after W1 exists through W3, and are retained as validated checkpoint/hypothesis observations, not a rewrite of the initial protected portfolio. A genuinely changed authorized input set uses explicit supersession.

Acquiring and admitting a new source does not automatically expand an already frozen read scope. S39 must verify scope membership before exposing new evidence to a branch. A newly admitted source outside the frozen set is carried as a pending acquisition result into the explicitly authorized subsequent scope revision/supersession; it cannot be smuggled into the old run's EvidenceFreeze. S40 preserves the prior result and registered protocol/lane requirements. Repeated unchanged acquisition must not create an endless chain of replacement runs.

## 4. Work order and real dependencies

**A. Stabilize:** S01–S04, S17 as needed. **B. Complete the primary backend:** S05–S15/S31–S34/S98/S99. **C. Implement actual inquiry and source capabilities:** S21–S23/S35–S52. **D. Finish products/integrations/data lifecycle and UI:** S53–S77 with S26. **E. Complete documented pure families/actual ABI/runtime ownership and measured checks:** S78–S91. Ready family/adapter work can start earlier when its input contract is stable. **F. Accept the integrated version:** S92–S97.

```text
S10 -> S31
S10 -> S11 + S12 -> S13
S14 + S15 + S13 -> S32
S10 + S31 + normalized admission -> S98
S05 + S06 -> S33; S29 -> S34
S35 -> S36 -> S37
S35 + S09 -> S22 -> S37 integration
S35/S36 -> S38 -> S40
S37/S38/S39/S40 -> S46
S47 -> S48 -> S49; S47 -> S51/S52
S53 + S38 -> S54; S53 -> S55
S62 + S55 -> S63
S65 + S63 + S52 -> S66
S05 + S52 -> S67 (code/index rollback, not data restore)
ready S78 family -> S88 first real ABI call
accepted pure family + S88 -> that family's S89 switch/removal
implemented selected product including S98/S99 -> S92
S92 + local code/config/build readiness -> S94
S94 -> S93/S95/S96 -> S97
```

A dependency means its required code/interface and local regression exist, not that its entire card has already collected future live receipts. In particular, first staging does not wait for its own T4/T6 tests. The branch scheduler does not need all products implemented before the common branch contract, and the first Wasm call does not need every pure family.

S78 has six named identity checkpoints; S79–S87 use A/B/C/D family stages; S88 has four concrete bridge checkpoints; S89 repeats one finite caller-switch/removal unit per accepted family; S91 lists eight database batches; S92/S95 list concrete scenario batches. Do not ask another agent to invent those decompositions or attempt them as one enormous patch. Their original PR is the completion record across those explicit commits.

## 5. All consolidated audit findings are assigned

Source: the previously consolidated `eliot-research-consolidated-audit-2026-09-14.md` and the newly supplied [repository audit](https://github.com/UnknownAlienHuman/eliot-research/blob/a2aca1277b0edbbed04de66e0d44e383e1b815ef/docs/implementation/audit-2026-09-14.md). Historical input hashes retained from the previous audit index: consolidated `9460d84cb0da21a6ab4553dc573e79652c532da749532fbb1db9176f5359fad5`; supplied audit `230bd4c9cb762cf044db1c0ef7ced49b07837fec71f1e95ce557b337374e72e6`. These identify audit inputs, not software acceptance receipts.

| Finding | Assignment/result |
|---|---|
| F01 deployment-bound availability | S05 compatible deployment; S67 explicit backend/index rollback. |
| F02 JWT/session identity coupling | S06 current historical read; S33 execution allowance independent of browser lifetime. |
| F03 historical-read fix awaiting acceptance | S07 actual v1/v2 result/citation tests; S92/S95 local/native evidence. |
| F04 AI Search binding dropped | S09 both dependency paths and actual factory regression. |
| F05 replay ignores changed scope input | S08 canonical request expression identity and conflict before effects. |
| F06 technical stages counted as research | S21 truth; S22/S35–S46 substantive handlers and product obligations. |
| F07 introductory fallback/coverage | S23/S50–S52 exact search and exhaustive denominator; S93 quality. |
| F08 query/scope constraints | S24 explicit multiline bytes; S99 full scope beyond preview64. |
| F09 incomplete headless rights | S10–S13/S31/S32/S58/S60/S61/S98 actual service operations. |
| F10 incomplete public run lifecycle | S14/S15/S32 cancel/recovery through one API and clients. |
| F11 uniformly disabled retries | S15/S64 safe committed-output and transport recovery; S95 native checks. |
| F12 unconfirmed DO cancel/race | S16 actual interleaving and D1-authoritative state; S72 event replay. |
| F13 lost initial failure | S02 harness, S17 runtime, S71 safe operational diagnosis. |
| F14 wrong database test engine | S04 focused D1 cases; S91 exact remaining transaction batches. |
| F15 SQL/TS mismatch | S25 supported writer→readback, S77 exact text contracts, S91 runtime guards. |
| F16 excessive SQL structural logic | S04/S91 actual emitted SQL; preserve atomic identity/CAS/purge invariants. |
| F17 network failure wipes intent | S19 private intent/current authorization separation; S72 reconnect. |
| F18 unrelated source closes report | S20 exact source dependencies; S55 derived freshness. |
| F19 operator-console interface | S26/S73–S75 complete human task flows. |
| F20 red main verification | S01–S04/S76/S90–S92; no skipped assertions or false overall PASS. |
| F21 launch checker blind spots | S18 selected-profile composition; S94/S97 actual runtime/release evidence. |
| F22 contradictory readiness records | S30 current registry/docs; S97 actual version-specific release receipt. |
| F23 duplicate serialization/validation | S28 named equivalent pair, S77 primitive reuse, S78/S89 family identity ownership. |
| F24 unreadable lines/wrong budgets | S76 readable literals-preserving changes; S90 emitted build/runtime measurements. |
| F25 model config/route lifecycle overhead | S29/S34 targeted existing config/renewal; S71/S95 observed behavior. |
| F26 Rust not in runtime | S78–S89 explicit parity/ABI/caller switch/removal; retain existing #176 mutation debt. |

No row is marked FIXED merely because a task exists. The table establishes coverage and responsible execution, not evidence that the underlying application changed.

### Claude/Antigravity details and dispositions

AUTH-01/02/03 map to S05/S06/S33/S34, with session/scope/model-proof lifetimes separated. A new JWT does not itself delete a database row. D1-TEST/D1-LIMIT/D1-AUTH cases map to S04/S25/S91; local workerd D1 is not node:sqlite. The newly explicit S36 instruction preserves the actual W1 SQL mutation masks.

CI-01/GATE-01 map to S01–S04/S18/S90–S97. S30 specifically runs the real documentation-index diagnostic for the audit's ER-45/ER-46 issues; those four historical findings are not silently omitted or assumed still present.

DUP-01/OVR-05/RT-01 map to S28/S76–S78/S89/S90. Counts of occurrences do not establish distinct equivalent implementations or actual bundle size. RT-02/CONF-DR/AI-03 map to S29/S34/S71: retain canonical native Gateway/qualification controls and remove demonstrated integration overhead, not thousands of lines by assertion.

PIPE-DO-01 and PIPE-CFG-01 map to S16/S72/S94: prove actual reachability/interleaving and test required binding absence before partial work. FRONT-UI-01/03/04/05 map to S26/S73–S75/S92: actual selected-profile actions, meaningful button labels, stable accessible selectors and complete user flows. An expected OAuth redirect is not a missing button, and unselected legacy Google endpoints are not mandatory.

OVR-04 is addressed by finite named checkpoints, exact before/after regressions and current-main integration, not a new orchestration framework. OVR-01 and AI-03 are recorded as inspection/complexity observations, not established defects: existing-family/caller analysis under S77/S90 must distinguish justified interfaces from a demonstrated redundant algorithm. If no behavioral or maintenance defect is established, retain that disposition instead of inventing a deletion target. CONF-03 maps to S78–S89; CONF-04/S30/S97 require observed behavior, not file existence.

**Do not implement refuted fixes:** removing Budget Governor or the AI Search generation registry; treating model qualification layers as duplicate engines; making sampled no-hit prove complete absence; conflating W2 and W3 IDs; calling historical SQLITE_NOMEM today's CI cause; declaring no tests because a package has no local test folder; deleting35–40k lines from an incorrect codec count. Source constraints/triggers are explicitly part of LANGUAGE_RUNTIME_CONTRACT§7. Missing secrets in Git do not prove missing production configuration. workers.dev and direct main work were accepted choices, not defects.

## 6. Mandatory project coverage beyond the defect audit

| Requirement family | Existing tasks and acceptance |
|---|---|
| Platform, identity and atomic authority | S01/S05/S10/S27/S33/S69/S70/S90/S94; actual verified actors, bindings, CAS and currentness. |
| Sources, normalization, qualification, residency | S39/S47/S70/S82/S98; real bytes→admission/outbox and explicit failed/degraded extraction. |
| Corpus Lens, map, Atlas and profile semantics | S36/S48/S49/S56/S57/S73; exact navigation and explicit omissions. |
| Literal/structural/semantic/exhaustive retrieval | S08/S09/S23/S48/S50–S52/S84/S99; real serving generation, full requested scope, precise evidence and honest denominator. |
| Governed inquiry and all selected Research products | S21/S22/S35–S46/S53/S85; protocol/lane/obligations, real branch outputs, named verification, freeze/debts/disposition. |
| Artifact/Wiki/distillation/dependencies | S07/S25/S53–S57/S75; COW, exact accepted support, review tiers, history and targeted invalidation. |
| HTTP/MCP and independent federation | S10–S15/S31/S32/S60/S61/S72/S98; usable owner-issued machine permissions and actual ingress/run/output/control. |
| Selected Google transport | S58/S59/S74; actual external actions, byte/representation identity and demonstrable readback. |
| Model/route/budget lifecycle | S15/S29/S33/S34/S71/S81; explicit readiness, safe renewal, permitted spend and no repeated committed paid effects. |
| Privacy, security and prompt injection | S10/S25/S69/S70/S81/S95; actual viewer/model/client boundaries and no authority from untrusted prose. |
| Queue/DO/Workflow reliability | S14–S17/S32/S64/S72/S95; durable settlement, idempotent replay, bounded pressure and recovery. |
| Erasure, retention, offsite, restore, exit, rollback | S55/S62–S67/S86/S95; complete managed closure, purge-first restore and preserved current data authority. |
| Steward, diagnostics and spend visibility | S17/S68/S71/S74; content-free findings, candidate-only updates, no autonomous rewrite loops. |
| Language migration and native verifier | S78–S89, existing K1/K2a/#176; actual ABI and per-family production owner, not CI-only Rust. |
| Quality, UX, performance and release | S26/S73–S76/S90/S92–S97; one integrated build, adjudicated corpus, native observations, measured load and final canaries. |

## 7. Execution discipline without more bureaucracy

Follow the next listed checkpoint and its chosen interface. Reading the actual changing caller is implementation work, not permission to start another broad design exercise. If part of the required behavior is already present, retain it and add only the missing regression/wiring; do not rebuild source admission, backup encryption, canonical primitives, or the same model engine.

One checkpoint result consists of its code, focused positive/negative/replay test and durable readback. Shared schema/interface changes update producer and consumer together. Name PRE_TASK_SHA and the implementing commit. Keep input bounds, currentness, purge, immutable history and UNKNOWN effect semantics. Do not weaken tests to pass, silently promote partial work, or use source/model data as trusted control instructions.

After two equivalent failed approaches, record the exact command/error/state, distinguish the initial cause from consequences, and change the diagnostic approach. Do not retry unchanged forever, rewrite documentation to bless the failure, or create a new framework to hide it. A newly reproduced defect belongs in its existing owning task with a regression; a genuine new canonical requirement is identified explicitly instead of silently expanding scope.

### External inputs are configuration, not unspecified architecture

Reuse already approved working account/resource IDs, identities, selected connector, budgets and destinations. Local implementation/test preparation does not wait for live credentials. A truly absent live target, credential, independent peer, approved offsite failure domain or spend permission blocks only that live action and must be stated precisely. Never invent its value, fabricate its receipt or repeatedly ask for information already available through configuration/authorized tools.

Production traffic, destructive restore/erasure and real paid load remain within the actual owner's authorization. Tests use explicitly scoped disposable resources and idempotent cleanup. Review a real canary result under S97, not a self-issued statement by the implementing agent. Uncontrolled prior downloads cannot be erased remotely; an unobserved future bill cannot be measured now.

## 8. Completion

The execution plan covers the known selected scope and all audit dispositions above, with concrete units in the three guides. The final release is accepted only after those units produce the actual S92–S97 results on compatible identities, including S98/S99. The plan does not claim that documentation edits ran application tests or that software development has no uncertainty.

**Agent handoff:** Read this index and the guide for the next unmet checkpoint. Implement that checkpoint in current main using the linked existing specification and code entry points; retain working code, run the named focused/actual-boundary tests, and record the implementing SHA/result in its original PR. Continue through code dependencies without waiting for unrelated future live receipts. Do not create a new architecture, a new planning queue or a false success statement. Stop only for a precise unrecoverable conflict or genuinely unavailable authorization/input that affects the action being attempted; continue independent local work when safe.
