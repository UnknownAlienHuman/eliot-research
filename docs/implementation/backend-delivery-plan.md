# Backend delivery plan

Current execution order, reconciled on 2026-10-02 against `main`
`6480186ea5ead7052e7122ec1b523713ddc97f21`.

The isolated [product integration checkpoint](product-resume-2026-10-02.md) records actual local COW/publication/restore checks and remaining code separately from live approval. The active result remains S92 integration, not release acceptance.

This is the volatile handoff and queue. Refresh `origin/main` and the active task before editing. [PR #292](https://github.com/UnknownAlienHuman/eliot-research/pull/292) preserves the original S01–S99 passports and negative acceptance criteria; it is not a second queue.

## Completion boundaries

Keep these states separate:

1. **code delivered at an exact SHA**;
2. **known residual code**;
3. **acceptance pending**;
4. **live qualified**.

The current phase is product code first: compilation, scoped lint, the depth-100 SQL compiler when relevant, and minimal Clippy for Rust changes. Broad behavioral/browser/native/mutation/live suites follow assembly. Deferred checks remain mandatory and must not be labelled `PASS`.

## Current active checkpoint — S92 local integration

92.1 is delivered (`8db894c6`): six browser-harness scenarios in
`tests/integration/browser/s92-intake.mjs` — owner identity (RS256),
local config readiness, project admission, read-policy grant, model D1
fail-closed, Library/Lens exact readback — registered as real `node:test`
assertions in `tests/integration/browser/library.spec.ts`. Honest states:
5 PASS + 1 PENDING_OWNER_D1B in the original checkpoint (live-model
execution was deferred). Scenario code uses the existing harness (`scripts/lib/local-*.mjs`,
`owner-e2e.mjs`) against in-memory SQLite seeded with the real migration
DDL; no new browser framework.

92.2-92.6 (delegation, products, continuity, COW, negatives) are delivered
in `e5c8ec47`; registration and the [local runbook / INPUT draft](../s92/README.md)
are delivered in `9c1e4788`. Reuse the six `s92-*.mjs` modules and their
`library.spec.ts` registrations; do not start a second harness. Delivery
of these scenarios does not establish their full acceptance: the runner
explicitly permits `BLOCKED`, `NOT_EXECUTED` and `PENDING_OWNER_D1B` outcomes.
The standalone `CloudflareArtifactCowAdapter` now implements section revision over
immutable D1/R2 DRAFT artifacts in `packages/cloudflare-artifacts/src/artifact-cow.ts`.
It validates the exact parent/spec/freeze/evidence boundary, reuses unchanged section object keys,
and commits a new revision with compare-and-swap. Five unit cases and a real local Workerd D1/R2
case verify immutable reuse, refusals and a concurrent one-winner commit.
This is a local engineering follow-up to merged main `6480186e` and the deployment fixes in
[draft PR #307](https://github.com/UnknownAlienHuman/eliot-research/pull/307).
Product composition still needs an authoritative section producer, evidence validators and export
assembler; ACCEPTED publication is still absent. The S92 COW source probe is not an accepted owner loop.
Resolve those product paths and inspect actual outcomes instead of treating a successful
process exit or standalone adapter as full S92 acceptance.

Focused local checks for this adapter: `pnpm exec vitest run packages/cloudflare-artifacts/src/artifact-cow.test.ts`
and `pnpm test:artifacts-worker`. The latter uses real local D1 migrations and R2;
it is included in `test:worker` and makes no live provider calls.

At this baseline, `node scripts/check-launch-code.mjs` reports disabled
required slices `ERASURE` and `RETRIEVAL`. The implementation registry
validates 43 `IMPLEMENTED_NOT_LIVE` contours and zero `LIVE_QUALIFIED`.
These counts and blockers are dated observations; refresh both commands.

The S92 done-state requires
`pnpm test:local-launch`, `test:local-owner`, `local:prepare`,
`local:smoke`, `test:owner-e2e`, `cf:types`, `build`, `cf:dry-run` and full
F on applicable CI platforms; unexecuted checks stay pending, never PASS.
D1(a) applies to the committed local draft: configuration and readiness
fail-closed only; live-model assertions remain `PENDING_OWNER_D1B` there.
The provider/fallback and historical token installation are already
recorded in [research-runtime-configuration.md](research-runtime-configuration.md).
Verify current installed profile, qualification, budget and data permission
before real calls; do not ask for the same provider/token decision again.

After S92: S94 staging, then S93/S95/S96 on the attested build, then S97
release acceptance. S94's local implementation and preparation do not
depend on a new A/B product decision. Its actual remote effects require
an approved isolated target and explicit deployment authorization; see
the bounded staging preparation below. No such authorization is supplied
by this plan or by the historical model/token installation.

## S37 / #229 — code delivered, do not restart

Task: [S37 / #229](https://github.com/UnknownAlienHuman/eliot-research/pull/229).

### What is in `main`

| SHA | Delivered |
|---|---|
| `c25df085` | Recovered the exact historical S37 patch, published strict branch contracts, removed the obsolete writable publisher and closed #299. |
| `b98ee60f` | Added one shared governed branch executor for `READ_AND_EXTRACT`, `ANALYZE_BRANCHES` and `COUNTER_SEARCH`, with exact scope/protocol/planning/W1/stage-five revalidation and receipt-based recovery. |
| `25be3164` | Registered `research-handlers.exploratory.v7`, connected the shared executor to the stage factory and started-attempt recovery, and retained fail-closed missing-handler behavior. |
| `d252eb69` | Bound research branches into EvidenceFreeze: exact committed v7/v8 branch reconciliation required before freeze; checkpoint, W2 attempt and request identity bound into manifest/freeze refs; unresolved contradictions and open ResearchDebt derived server-side; legacy v2 freeze bytes unchanged. Refs #229. |
| `70dc0965` | Hardened branch freeze lineage: reopen exact committed Stage7/Stage8 outputs before accepting Stage9 reconciliation; exact required-role coverage, nested branch identities, canonical contradiction derivation, one-to-one canonical OPEN debt per blocked role. |
| `16ced6eb` | Passed `branch_execution` deps (database, Work R2, committed stage-five reader, role model) from semantic composition into the workflow handler factory. |
| `a3930696` | Substantive model-backed execution for v7 branch roles: per-role model calls behind W3 admission, installed prompts, model-attempt/reservation ports. |
| `b5ea49df` | Settled W1 observations after v7 branch execution, wired into the session execute path. |
| `8250ff20` | Bound COUNTER to committed read-extract bytes, not analysis output. |
| `fb1c9167` | Branch-aware W3 spend admission for ANALYZE_BRANCHES/COUNTER_SEARCH (1/2): admission port branch-role awareness. |
| `bccd6037` | Branch-aware W3 spend admission for ANALYZE_BRANCHES/COUNTER_SEARCH (2/2): `admitBranchRole` spend-policy path and policy readers. |
| `05c3c3a1` | Gated W1 branch settling behind branch-execution handler generations, with a regression test for the legacy settling path. |
| `2d1d0ae6` | S37 branch-role unit tests: executor binding, output schema boundaries, preparation fail-closed. |
| `68678041` | S37 `model.roles` server wiring: per-role evidence packs derived only from the frozen stage-five pack (Variant A), deterministic manifest refs, roles assembled in the semantic server; registry contours. |
| `d6041be7`, `331a41b8` | Registered S37 subsystem contours in `implementation-status.json`: 43 exact contours, all `IMPLEMENTED_NOT_LIVE`, 0 `LIVE_QUALIFIED` (`scripts/check-implementation-status.mjs` exit 0). |
| `71348bb2` | T5-A erasure-restore live-gate trial runner (ingest/erase/absence-readback/purge-replay). |
| `0d796ba9` | T5-B prompt-injection trial runner (gate `T5-prompt-injection`). |
| `90f694d0` | T5-C failure-injection trial runner (gate `T5-failure-injection`). |
| `f067fe9c` | T5-D disclosure-audit trial runner (gate `T5-disclosure-audit`). |
| `178f7b25` | T6 representative-load trial runner (gate `T6-representative-load`). Gates enumerated in `tests/integration/live-gates.example.json` (13 gates). |
| `55c83038` | S96 live cost observer + settlement (`research-model-spend-observation`). |
| `b7b7d657` | S37 hardening (1/2): `admitBranchRole` role↔stage fail-closed binding in the spend policy; port-layer re-validation at write time. |
| `90dcfdff` | S37 hardening (2/2): migration `0095` adds the `role` column to `research_model_spend_admission` with a stage-tied CHECK, bound into the admission digest; new tests. |
| `8db894c6` | S92 92.1 intake scenarios + `library.spec.ts` registration (see active checkpoint above). |
| `a452494b` | Migration `0096` rebuilds model-spend admission for stages 8/9/12/13/14, preserves existing rows with a copy guard, and extends the W2 stage mapping. The old stage-8/9 widening packet is delivered. |

### Exact boundary

- `v7` (`research-handlers.exploratory.v7`) is the selected generation for new
  explicit-protocol admissions (`SERVER_OWNED_BRANCH_HANDLER_GENERATION` in
  `apps/eliotr-core/src/research-session.ts`); delegated computer-agent runs
  select `v8` (`SERVER_OWNED_EXTERNAL_AGENT_HANDLER_GENERATION`); idempotent
  replay keeps the previously stored handler generation; persisted `v5/v6`
  (and other prior generations) remain accepted and unchanged.
- Semantic composition passes `branch_execution` deps (database, Work R2,
  committed stage-five reader, navigation, ledger, role model) into the stage
  handler factory.
- EvidenceFreeze requires the exact committed v7/v8 branch reconciliation
  before freeze: a missing or inconsistent lineage fails closed
  (`WORKFLOW_AUTHORITY_STALE`), never falling back to the legacy path;
  contradiction refs are derived server-side; a canonical OPEN ResearchDebt is
  recorded per blocked role; legacy v2 freeze bytes are unchanged.
- The branch executor performs per-role model calls behind branch-aware W3
  spend admission (`admitBranchRole`) and settles W1 observations after
  execution, gated behind branch-execution handler generations; COUNTER binds
  committed read-extract bytes.
- `model.roles` is assembled in the semantic server from the installed
  `ELIOTR_MODEL_PROFILE_DEFINITION_JSON` model policy, evidence
  authority/resolver ports and the committed stage-five reader; per-role packs
  are filtered views of the frozen pack with exact frozen digests and
  receipts; absent `config.roles` means roles are not passed at all
  (fail-closed current behavior).
- T5-A/B/C/D and T6 trial runners are code-delivered; their attested/live
  gate runs are acceptance-pending, not PASS.
- S96 cost observer is code-delivered; live qualification is pending.

Do not describe S37 as live-qualified or acceptance-complete. The remaining
work is acceptance (assembly, S93 real-model quality), not code.

### Delivered S37 stage-8/9 repair

The old widening residual is repaired by `a452494b`,
`infra/d1/core/migrations/0096_research_model_spend_admission_branch_stages.sql`.
Its replacement table accepts stages 8/9/12/13/14 and requires a role only
for branch stages. The W2 trigger maps 8/9 to ANALYZE_BRANCHES/COUNTER_SEARCH;
copy verification, all admission triggers and the lookup index are retained.
The corresponding branch-stage tests are in `packages/cloudflare-research/src/`.
Do not change historical migration 0095 or implement another rebuild.
Remote application and exact-build native/live acceptance remain separate.

## Delivered checkpoints that must not be restarted

| Area | Delivered code boundary | Remaining boundary |
|---|---|---|
| Queue/audit reconciliation | `bf1ffa2e` | Selected residual tasks still need exact current-main disposition. |
| D1 depth compiler | `fc25ee02` | #294 dynamic-query coverage and native acceptance. |
| D1 authority/grant/control repair | `7d2bb36`, `d09def61` | Native test source is delivered in `apps/eliotr-core/test/research-authority-0084-acceptance.test.ts`; executed exact-build negative/replay/concurrency evidence is a separate obligation. |
| Full lint/error retention | `eaa4efa` | #296 focused fault/replay acceptance. |
| CI independent reporting/root selection | `a76acd98`, `a348adad` | Root selection/build repair is delivered; applicable exact-build execution remains pending. CI is manual-only. |
| S37 source/contracts/executor/factory | `c25df085`, `b98ee60f`, `25be3164`, `a452494b` | v7/v8 admission, freeze binding, substantive role execution, W1 settling, branch-aware budget, `model.roles` server wiring, admission hardening through `0096` and the 43-contour registry are delivered. Remaining assembly/real-model acceptance must not restart these implementations. |
| S29 immutable semantic configuration | `ccf500e8`, `d774d66a`, `2a5d6458` | Migration `0097`, immutable revision store, digest-checked Worker resolution and installer are delivered. Legacy JSON is an explicit compatibility path; mixed/partial revision identity fails closed. Operator installation/current qualification still need verification. |
| S34 qualification renewal | `5e1552d0` | `packages/cloudflare-research/src/research-model-qualification-renewal.ts` has same-key proof replay and in-process cross-operation single-flight. Do not reimplement it in the route provisioner or infer cross-isolate coordination from this local mechanism. |
| S92 scenario/setup source | `e5c8ec47`, `9c1e4788` | Actual owner/headless/storage/browser outcomes and unresolved COW/product paths remain S92 acceptance work. |
| Browser handshake / Windows gutter | `8b747991`, `4c897429` | #305/#298 are closed with source fixes; authenticated negatives and both OS viewport results still require their own exact-build evidence. |
| Rust vector parser kill tests | `4904b30a` | #106 is closed; four parser kill-test files are delivered. This does not establish a fresh complete mutation or Miri verdict; retain #176's remaining acceptance. |

Also reuse the already delivered project/client grants, machine HTTP/MCP readers and controls, owner historical reads, long-run authority, append-only project attachment, normalized bundle ingestion, runtime failure diagnostics and reconnect intent. Their exact lineages remain in #202–#205, #209, #211, #223–#225, #290 and #291. Open planning cards do not mean those systems are wholly absent.

## Queue after S92

Finish the active checkpoint before switching. Then resume this dependency order:

| Order | Tasks | Next product result |
|---|---|---|
| A | S29/#221 and S34/#226 delivered checkpoints; verified residuals in S10-S15, S31-S33, S98-S99 | Reuse the workspace-candidate admission gate (`37ba91eb`, `5e7ed589`), immutable semantic revision (`ccf500e8`, `d774d66a`, `2a5d6458`) and renewal replay/single-flight (`5e1552d0`). Finish verified selected-profile configuration/qualification and machine-path gaps without reimplementing those delivered mechanisms. |
| B | S21–S23 and remaining S38–S46 | Complete truthful procedure reporting, protocol execution, observations, freeze/debt/supersession, verifiers and product handlers on the shared Research engine. |
| C | S47–S61 | Complete source/navigation/index boundaries, requested coverage, artifacts/publication, Workspace candidate admission/readback and federation. Prioritize dependency-ready S50–S52 and S58/S59. |
| D | S62–S72 | Complete erasure closure, outbox/DLQ/reconciliation, backup/isolated restore, rollback, Steward and durable events. |
| E | S20/#212, S73–S77, #298/#305 | Complete human Library/Connections/artifact flows and Windows layout/session-aware browser fixtures after product assembly. |
| F | S78–S89, #106/#176 | Complete deterministic Rust families, versioned Wasm promotion and removal of superseded TypeScript authority family by family. |
| G | S18/#210, S30/#222, S90/#282, S91/#283 | Reconcile composition, implementation states, emitted artifacts/runtime budgets and D1 mutation boundaries. |

After code assembly: verify the delivered root-suite fixes (`168a29f6`, `df139b47`), #305 handshake and #298 geometry independently on the exact assembled build; run S92 before S94, then S93/S95/S96 and S97. Closed Issues do not replace pending acceptance evidence.

## Cross-cutting records - current state versus historical evidence

These are not permission to interrupt the active checkpoint unless they block its code:

Only #294 and #301 are open at the baseline above; refresh `gh issue list --state open`.

- #294 (open) - one calibrated depth-100 compiler is installed. The refreshed local run compiles 96 Core migration files, 22 views and 399 generic forms with zero failures, plus four Search migrations. This is not exhaustive application/dynamic-query or native authorization proof. The previously recorded 711-shape/64-unresolved-site inventory is historical, not a current census. Reproducible source-derived application and UPDATE-OF-sensitive coverage remains required.
- #301 (open) - retain original task/passport criteria and reconcile selected residuals against exact main. This handoff corrects known stale claims; it does not migrate all tasks or close every legacy obligation.
- #293/#295/#296/#297/#300/#304/#305 (closed) - retain delivered source and the distinct pending exact-build native, fault/replay, root/browser and CI evidence; do not recreate their repairs.
- #298 (closed 2026-10-01) - stable scrollbar gutter delivered in `4c897429`; viewport assertions remain unchanged. Closure is not a retained same-SHA Windows/Ubuntu browser result.
- #106 (closed 2026-10-01) - original canonical survivors were already zero historically; vector parser kill-test source is now delivered. #176 remains the Rust acceptance/debt passport: zero unexplained load-bearing survivors and zero timeouts, with fresh complete mutation and Miri results where required. Do not reopen an old caught-ratio threshold choice.
- #302 (closed) - public-text cleanup is separate from live endpoint disposition. The refreshed public-repo privacy checker still reports six existing hits in other files, including three historical hostname references and three generic Access template/fixture origins; closure is not a clean-tree result. Closure supplies no account-wide rename, Access change, migration or deployment permission.

#299 is complete. Do not reopen or recreate the S37 payload-recovery task.

## S93-S97 - settled requirements and bounded staging preparation

The original passports remain authoritative; no new product choice is needed to
implement their stated requirements. A/B labels in an old handoff are not an ADR.

| Task | Existing contract/source | Exact remaining boundary |
|---|---|---|
| [S94 / #286](https://github.com/UnknownAlienHuman/eliot-research/pull/286) | `scripts/deploy-cloudflare.mjs`, `scripts/lib/deployment-verification.mjs`, `infra/cloudflare/resources.json`, production-readiness Phase 7 and the shared [staging checklist](launch-prs/cloudflare-handoff.md) | Local negative/ordering preparation can proceed. `readDeploymentWorker` is only inventory/export readback; it does not independently attest the actual version, every binding, both schema ledgers, assets and Wasm. Complete that existing reader/receipt path before claiming S94. Actual apply requires isolated approved target and permission. |
| [S93 / #285](https://github.com/UnknownAlienHuman/eliot-research/pull/285) | Existing Golden corpus/runner and production-readiness Phase 9, architecture 19.2-19.5/19.8 | Prepare independent tuning/holdout labels locally. Actual per-product T2/T3 quality results require the attested model/prompt/index/config/corpus generations and approved data/budget. A controlled model response is not quality acceptance. |
| [S95 / #287](https://github.com/UnknownAlienHuman/eliot-research/pull/287) | `tests/integration/d1-write-readback-runner.ts`, T5-A/B/C/D runners, `gate-state.ts`, production-readiness Phases 8/10-12 | Probe source is delivered, not native qualification. Compose/run all applicable T4/T5 storage, security, erasure/restore/rollback and selected independent-client checks against S94; preserve denied/replay/unknown-effect results. Unselected Google clients add no gate. |
| [S96 / #288](https://github.com/UnknownAlienHuman/eliot-research/pull/288) | `tests/integration/t6-representative-load-runner.ts`, model spend observation/settlement, production-readiness Phase 13 | Run 5/20/50 readers, five sessions, ten queued jobs and two long Workflows; measure per-operation latency/errors/resources and actual usage/cost. Approved maximum spend, duration and stop rules precede live load; local simulation or estimates do not qualify it. |
| [S97 / #289](https://github.com/UnknownAlienHuman/eliot-research/pull/289) | Existing release checklist/receipt and production-readiness Phase 14 | Reconcile mandatory selected-profile Slices 0-6, production-critical Rust and S92-S96 evidence, then observe canaries and obtain explicit production approval. No universal correctness claim or merge/deploy permission follows from task closure. |

### Isolation is an operational prerequisite, not an A/B coding hold

The shared staging checklist already permits **a dedicated approved staging
account OR a separately reviewed isolated resource profile**. Neither the S94
passport nor an accepted ADR chooses an account for the operator. Architecture
16.3's clean-account restore rule is an erasure-aware restore requirement,
not a blanket new-account decision for all staging work.

The shipped foundation uses fixed names: Worker `eliotr-core`; D1
`eliotr-core`/`eliotr-search`; R2 `eliotr-evidence`/`eliotr-work`; Queue/DLQ
`eliotr-jobs`/`eliotr-dlq`. The canonical Wrangler configuration also binds
ResearchSession, `eliotr-research-workflow`, AI Search `eliotr`, the reasoning
and retrieval Gateways, and `eliotr_metrics`. Access must protect the exact
chosen ingress before application exposure. `ELIOTR_ENVIRONMENT=staging`
changes a runtime label, not these identities. The generated-config validator
requires the fixed Worker/D1 names; the provisioner verifies canonical resource
names. A suffix plus a deny-list is therefore proposed implementation work,
not an installed or owner-selected staging mode.

For a first trial, an already approved dedicated staging account is the path
compatible with the shipped names. If the operator selects same-account
isolation instead, review and implement the complete profile across provisioners,
bindings, Access, search/gateways, DO/Workflow and readback; do not hand-edit
generated config or merely append `-staging`. Neither path is selected here.

Before requesting final apply approval, prepare privately one exact main
SHA/tree/build and profile; account/resource/hostname/jurisdiction identities;
owner/service identities and secret references (reuse and verify installed
secrets, never request their values); both migration-ledger deltas, including
Core rebuild `0096` and semantic revision `0097` if absent; immutable config
installation/readback; maximum spend and stop conditions; disposable data,
cleanup and rollback scope. The rebuild preserves existing admissions with a
copy guard but still changes schema; label changes can collide with production
resources, and model/index/load work can spend money. No cost is measured by a
dry-run. Obtain authorization for that concrete bundle, then read-only
`cf:preflight:remote` and the existing guarded orchestrator; no raw Wrangler bypass.
The orchestrator additionally requires fresh usage-envelope `ADMITTED` evidence
and a same-process admission capability before remote mutation; an old receipt
or a `SEALED` result cannot authorize upload, migration or provider effects.

S94's own future T4/T6 receipts cannot be prerequisites for the first staging
deployment that produces them. Missing mandatory code, S92 acceptance, exact
attestation preparation, target approval and budget authorization are real
preconditions. They do not block independent local code/documentation work.

## Agent checkpoint protocol

Every active-task comment should state:

```text
Baseline: <exact main SHA>
Delivered before this checkpoint: <SHAs and boundaries>
Residual code: <one precise result>
Owned files: <exact paths>
Static verification: <commands actually run>
Acceptance deferred: <named tests/live work not run>
```

Publication rules:

- main only, no new worktree/task branch;
- one coherent checkpoint per commit;
- refresh `main` immediately before creating the commit;
- non-forced fast-forward only;
- verify the remote ref and published commit file list after the write;
- use `Refs #NNN` with the actual task;
- update the task discussion and this plan whenever the active boundary changes;
- never claim publication from a local patch, unattached blob or prepared manifest.

## Preserved scope and safety

Mandatory baseline remains v1 and Slices 0–6. [ADR-0007](../adr/0007-external-agents-and-cloudflare-evolution.md)
makes model providers, external agents and Google tools independent choices; Muse may replace Spark.
The currently recorded `gemini-mcp` release configuration is not a mandatory vendor choice. Explicit
`disabled` is valid for a Google-free release; configuration and registry must still agree. Unselected
integration gates do not block other work. S29/profile and S10–S13/S98–S99 client work implement the
remaining selection/adapter changes without redoing delivered services. The active checkpoint is S92 local integration; S37 code is delivered (acceptance pending).

No branch deletion, force push, pushed-history rewrite, live deployment, provider spending, hostname change or remote database migration is authorized by this plan.
