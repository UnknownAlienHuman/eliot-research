# Eliot Research — execution entry point and audit coverage

**99 existing assignments S01–S99 / PRs #193–#291. #292 is this execution pack, not a new implementation task.** Engineering instructions are English; original audits remain source material. This revision fixes inaccurate command and test guidance rather than creating another backlog.

Reviewed application baseline: `a2aca1277b0edbbed04de66e0d44e383e1b815ef`. Use current main when implementing; never reset working code to the audit baseline. Planning edits do not implement the application, run its test suite or deploy it.

## 1. Read the relevant guide, then execute the next checkpoint

| Guide | Tasks | Actual contents |
|---|---|---|
| [01 — Backend](EXECUTION-STEPS-01.md) | S01–S34, S98–S99 | Verified command semantics, existing core test selections, explicit new regressions, CI/D1/authority/recovery/API/MCP/ingestion/full scope. |
| [02 — Research and products](EXECUTION-STEPS-02.md) | S35–S77 | Protocol/W1/branches/verifiers, each Research product, sources/search/artifacts/Workspace/federation, erasure/backup/restore/operations/UI with concrete test entry points. |
| [03 — Kernel and acceptance](EXECUTION-STEPS-03.md) | S78–S97 | Finite codec consumers, pure Rust families/ABI/switches, exact D1 batches, genuine automated browser/quality/native/workload/release acceptance. |

These disjoint ranges contain S01–S99 exactly once. S98/S99 belong in the early backend phase despite late PR numbers. Each guide links its original five-part specification: problem, required change, exact canonical anchors, implementation and completion criteria. A NEW path is a proposed regression to implement, not a file already present. Reuse a sufficient existing equivalent and record its exact name instead of creating duplicate tests.

Start with **S01**, reproducing the actual current boundary failures. S02 is independent when browser diagnosis is needed. Do not spend the first work session creating another general audit or architecture plan. If the specified defect is already fixed, preserve the fix and establish the required regression rather than repeat the old edit.

### Read planning PRs while remaining on main

```sh
git status --short
git branch --show-current
git fetch origin refs/pull/292/head
git show FETCH_HEAD:.github/audits/2026-09-14/EXECUTION-INDEX.md
git show FETCH_HEAD:.github/audits/2026-09-14/EXECUTION-STEPS-01.md
```

No branch checkout/worktree is required. Fetch/read the linked task similarly or read it through GitHub. Do not reset dirty user work, merge old theme branches wholesale, or count a documentation-only merge as a software fix.

## 2. Correct verification contract — replaces obsolete command mnemonics

The previous pack incorrectly named absent scripts and confused manual startup with automated browser tests. The three guides and affected passports now use real commands and named test paths.

| Operation | Correct command / boundary |
|---|---|
| Root pure/PWA fixture | `pnpm exec vitest run <explicit-test-paths>`; does not include core Worker tests. |
| Actual local core runtime | `pnpm --dir apps/eliotr-core exec vitest run <test/file.test.ts ...>`; current Cloudflare plugin/migrations. Confirm the test calls real env databases/services, not a DatabaseSync substitute. |
| Automated owner browser | `pnpm test:owner-e2e`; tests/integration/browser/library.spec.ts actually invokes runOwnerE2E/Chromium and asserts receipts. |
| Exact original browser case | `node --test --test-name-pattern="L6 real-browser owner harness" tests/integration/browser/library.spec.ts`. The name is read from the real test, not invented. |
| Manual owner inspection | `pnpm local:owner`; starts Access/Worker/bridge and waits. It is not browser-test PASS. |
| Local launcher helpers | `pnpm test:local-launch`, `pnpm test:local-owner`; isolation/helpers, not complete product acceptance. |
| Local runtime prepare/smoke | `pnpm local:prepare`, `pnpm local:smoke`. |
| Types/build/deploy dry run | `pnpm cf:types`, `pnpm build`, `pnpm cf:dry-run`. |
| Golden fixture/adjudication | `pnpm exec vitest run tests/golden-corpus/golden-harness.test.ts`; fixture validity is distinct from real model/index quality. |
| Rust | Actual `pnpm rust:vectors`, `pnpm rust:boundaries`, `pnpm rust:wasm` and other declared subcommands; final `pnpm rust:check`. `pnpm rust:test` includes nextest and doctests. |
| Final repository gate | `pnpm check`; full gate at integrated checkpoints. Root `pnpm test` also chains provisioner, root Vitest and core tests, unlike root Vitest alone. |

**check:affected is currently a full-check alias, not a --base selector.** Do not pass a supposed base-filter flag or describe it as cheap. Record PRE_TASK_SHA for diff/review, select the guide's exact tests during editing, then typecheck and final integrated gate. Do not create empty aliases or another test orchestrator merely to make earlier prose executable.

The complete real-script list and existing W test groups are in guide01. Older comments and superseded guide revisions may still mention nonexistent research/authority/retrieval/artifact/backup/etc commands; they are not instructions to execute. The updated five-part S36/S37/S78/S88/S91 passports remove their explicit bad commands and, for S36, the incorrect claim about root pnpm test. Zero selected tests cannot count as passing; never use --passWithNoTests to conceal a typo or missing NEW scenario.

### What was statically checked in this correction

Reference data: root package.json blob `ea07aa43faafc68bdf28b1a5fd69ae6df7e48da0`, core test tree `bc86069fb67e817e4254e957669e13a05c914a05`, root/core Vitest configurations and actual library.spec.ts browser registration.

A local set comparison of the explicitly transcribed execution recipes against the fetched script/test inventories checked **36 invoked script names and 67 existing core test paths in 13 groups**: no unknown script or missing existing path in that checked set. S01–S99 range coverage has no omission/duplicate. NEW additions are intentionally excluded from existing-file claims. This is reference validation, not execution of repository tests, verification of every assertion's adequacy or an automatic parser of all historical PR comments.

## 3. Scope to finish

Mandatory selected **v1, Slices0–6, gemini-mcp** under:

- [Architecture29.1](https://github.com/UnknownAlienHuman/eliot-research/blob/a2aca1277b0edbbed04de66e0d44e383e1b815ef/docs/architecture/ELIOT_RESEARCH.md).
- [Language contract1.0](https://github.com/UnknownAlienHuman/eliot-research/blob/a2aca1277b0edbbed04de66e0d44e383e1b815ef/docs/architecture/LANGUAGE_RUNTIME_CONTRACT.md), with S88's explicit scoped export amendment before implementing the added exports.
- [ADR-0006](https://github.com/UnknownAlienHuman/eliot-research/blob/a2aca1277b0edbbed04de66e0d44e383e1b815ef/docs/adr/0006-google-external-transport-profiles.md), selected versus legacy transport.
- [Production readiness](https://github.com/UnknownAlienHuman/eliot-research/blob/a2aca1277b0edbbed04de66e0d44e383e1b815ef/docs/implementation/production-readiness-plan.md) and existing [execution contract](https://github.com/UnknownAlienHuman/eliot-research/blob/a2aca1277b0edbbed04de66e0d44e383e1b815ef/docs/implementation/launch-prs/execution-contract.md), subject to the owner's main-only work rule.

Retain one Worker, D1 Core/R2 canonical authority, rebuildable search, TS platform adapters, required pure Rust decisions and atomic SQL invariants. Reuse Gateway/Budget Governor/generation registry, source ownership/residency and model-effect reconciliation. Their presence is not proof of duplication.

Do not add unselected legacy Google OAuth/Cloud project, client ELIOT runtime/database, optional Slice7 specialist products or optional Browser Rendering/R2 SQL as baseline blockers. Ordinary scientific documents, tables and conversation exports remain within required source handling. Finishing the known selected version is not a guarantee against every future defect.

## 4. Agreed decisions and dependencies

| Boundary | Selected solution; no redesign needed |
|---|---|
| Deployment | S05 reproducible backend-input compatibility separate from git/PWA provenance; identical backend survives. Unknown backend transition not silently accepted. S67 explicit rollback, current purge/data preserved. |
| Service rights | S10 single project_client_grant/DTO/authorizer with verified actor and owner ceiling. S31 owner CRUD under /api/v1/research/projects/:project_id/client-grants. No owner_pwa impersonation/browser JWT. |
| Source write | S98 same grant plus explicit ingest.bundle/namespaces; project.attach uses existing guarded PUT, unchanged title and append-only members. Reading does not authorize writing/ownership transfer. |
| Run control | S14/S15 exact cancel/recover request/status semantics; S32 PWA/MCP reuse them. Saved SYNTHESIZE not repeated, first required AUDIT allowed with separate reservation. UNKNOWN not blindly replayed. |
| W1 planning | Immutable deterministic seed before CREATE, runtime observations as permitted checkpoint/hypothesis payloads. Protected portfolio/debt changes require S40 supersession; no relaxed APPEND mask. |
| Branches | S37 one typed executor and installed role profiles. Actual factory and stage-duration/budget classification must match new paid work; W3 checkpoints prevent repeated effects. |
| Acquisition | Capture/admission does not expand frozen scope. Outside-scope evidence waits for explicit authorized subsequent revision; unchanged acquisition cannot spawn endless replacement runs. |
| Larger corpus | S99 uses existing larger scope/profile, not a new database. Preview64/top-k is not denominator; real byte/member bounds and all atom policies still apply. |
| Input compatibility | S35 keeps legacy E0/E1/E2; versioned profile addition is strict. S24 preserves exact LF/CRLF, no silent query normalization. |
| Google | Official selected client does external I/O; S58 includes service capture/conversion, S59 compares a defined representation and reconciles only supported provider behavior. No invented idempotency or Markdown/PDF equality. |
| Kernel | Preserve existing canonical primitives. S78 has explicit consumer rows, S88 closed eight-export map with contract revision, S89 ten per-family caller switches/removals. No runtime RPC or silent TS fallback. |
| Code/procedure | S28/S77 only proven-equivalent reuse; S76 readable literals-preserving format; S90 real artifacts not source-size proxy; S27 removes artificial branch quota/dated exceptions. |

Order: A S01–S04 and S17 where needed. B S05–S15/S31–S34/**S98/S99**. C S21–S23/S35–S52. D S53–S77 plus S26. E S78–S91, starting a ready family earlier when its contract is stable. F S92–S97 actual integrated acceptance.

```text
S10 -> S31
S10 -> S11/S12 -> S13
S14/S15/S13 -> S32
S10/S31 + normalized admission -> S98
S05/S06 -> S33; S29 -> S34
S35 -> S36 -> S37
S35/S09 -> S22 -> S37 integration
S35/S36 -> S38 -> S40
S37/S38/S39/S40 -> S46
S47 -> S48 -> S49; S47 -> S51/S52
S53/S38 -> S54; S53 -> S55
S62/S55 -> S63
S65/S63/S52 -> S66
S05/S52 -> S67
ready S78 row -> S88 first real call
accepted family + S88 -> its S89 switch/removal
implemented product including S98/S99 -> S92
S92 + local code/config/build readiness -> S94
S94 -> S93/S95/S96 -> S97
```

Dependency means needed code/interface and local regression, not every future live receipt on a broad card. The first staging cannot require its own T4/T6 results. The first ABI call need not wait for every Rust family; the branch contract need not wait for every product. Shared routes/schemas/migrations/locks are integrated coherently on main, not by competing writers. No new quotas or universal orchestration system.

## 5. Complete consolidated audit mapping

Source basis: previously consolidated F01–F26 audit and the [supplied Claude/Antigravity audit](https://github.com/UnknownAlienHuman/eliot-research/blob/a2aca1277b0edbbed04de66e0d44e383e1b815ef/docs/implementation/audit-2026-09-14.md). Source observations and historical counts are not software acceptance evidence. This table assigns implementation and tests, not FIXED status.

| Finding | Owning tasks and required result |
|---|---|
| F01 deployment availability coupling | S05 continuity, S67 explicit backend/index rollback. |
| F02 session credential coupling | S06 historical read, S33 server execution lifetime. |
| F03 historical-read fix unaccepted | S07 v1/v2/citation, S92 local and S95 native. |
| F04 missing AI Search binding | S09 both constructor paths and real factory regression. |
| F05 wrong scope replay identity | S08 canonical original expression conflict before effects. |
| F06 technical stages counted as inquiry | S21 truthful output; S22/S35–S46 real protocol/role/product handlers. |
| F07 intro fallback/coverage | S23/S50–S52 relevant retrieval and exact denominator; S93 quality. |
| F08 input/scope ceilings | S24 exact multiline input and S99 full project beyond preview. |
| F09 incomplete headless access | S10–S13/S31/S32/S58/S60/S61/S98 genuine service onboarding/operations. |
| F10 missing public run lifecycle | S14/S15/S32 one cancel/recovery API and clients. |
| F11 retries disabled uniformly | S15/S64 safe read/transport/committed-result recovery, S95 native. |
| F12 false DO cancellation/race | S16 reproduce and reconcile D1; S72 durable events. |
| F13 lost failure cause | S02 harness, S17 runtime, S71 content-free diagnostic origin. |
| F14 wrong DB test environment | S04 exact D1 regressions; S91 complete named transaction batches. |
| F15 SQL/TS validation mismatch | S25 supported writer/readback, S77 primitives, S91 actual DB. |
| F16 excessive SQL structural logic | S04/S91 real emitted SQL, preserving atomic identity/CAS/purge. |
| F17 network wipes user work | S19 transient intent handling and S72 reconnect. |
| F18 unrelated admission resets report | S20 exact dependency event and S55 targeted freshness. |
| F19 operator-console UI | S26/S73–S75 full human flows, real B assertions. |
| F20 red main verification | S01–S04/S76/S90–S92, correct commands/no skip or false global PASS. |
| F21 launch checker blind spots | S18 selected composition, S94/S97 actual deployment/readiness. |
| F22 inconsistent status records | S30 current truth and S97 accepted version receipt. |
| F23 repeated serialization/validation | S28 exact pair, S77 shared primitive, S78/S89 real family ownership. |
| F24 unreadable lines/source proxies | S76 formatting and S90 actual artifact/runtime measurement. |
| F25 model config/route overhead | S29/S34 existing config/renewal repaired; S71/S95 observation. |
| F26 Rust absent from runtime | S78–S89 parity/ABI/actual callers/removal; existing #176 mutation debt retained. |

### Original audit statuses are not flattened

AUTH-01/02/03 map to S05/S06/S33/S34, separating browser/snapshot/execution/model-proof lifetimes. A new JWT does not itself delete a DB row. D1-TEST/LIMIT/AUTH map to S04/S25/S91; actual local workerd D1 differs from DatabaseSync. A weaker trigger alone does not prove normal writer exploit. S16 must reproduce the claimed DO interleaving/reachability rather than call an untested risk a live incident.

CI-01/GATE-01 map to real commands and S01–S04/S18/S90–S97. Historical documentation-index findings ER-45/46 are handled by S30 against tracked scripts/entries, not fictitious docs:* aliases. DUP-01/OVR-05/RT-01 map to S28/S76–S78/S89/S90; occurrence counts do not establish equivalent functions or compressed runtime size.

RT-02/CONF-DR/AI-03 map to targeted config/renewal/diagnostic work S29/S34/S71, not deletion of managed-service adapters by LOC. PIPE-DO/CFG map to S16/S72/S94 actual caller/binding tests. FRONT-UI/03/04/05 map to S26/S73–S75/S92 human actions, labels, stable selectors and correct selected transport; expected OAuth redirect/unselected legacy route is not automatically missing functionality.

OVR-04 is addressed by finite checkpoints and regression/readback, not more frameworks. OVR-01/general protocol counts and AI layer counts remain complexity observations pending demonstrated duplicate behavior. CONF-03 requires actual Rust owner; CONF-04 requires observed behavior, not file presence.

Do not implement refuted or overbroad fixes: deleting Budget Governor/AI Search generation registry; merging W2/W3 IDs; treating layered model qualification as duplicate engines; upgrading sampled no-hit into absence; calling old SQLITE_NOMEM today's failure; declaring no tests because a package lacks local test files; deleting tens of thousands of lines from an incorrect codec count; removing all SQL atomic guards. Missing secrets in Git do not establish missing deployment configuration. workers.dev and main-only work were accepted choices. The supplied audit's unsafe blanket recommendations are narrowed by actual canonical contracts and supported-path experiments, not copied blindly.

## 6. Mandatory project coverage beyond individual defects

| Required family | Work and outcome |
|---|---|
| Platform/identity/atomic authority | S01/S05/S10/S27/S33/S69/S70/S90/S94: verified actors, bindings, currentness/CAS. |
| Ingest/qualification/residency | S39/S47/S70/S82/S98: real bytes→admission/outbox; candidate/failed extraction not evidence. |
| Lens/maps/Atlas/profile semantics | S36/S48/S49/S56/S57/S73: source-bound navigation and explicit omissions. |
| Literal/structural/semantic/exhaustive | S08/S09/S23/S48/S50–S52/S84/S99: active generation/full scope/exact bytes/honest denominator. |
| Governed inquiry/products | S21/S22/S35–S46/S53/S85: protocols, lanes, roles, verifiers, freeze, debts and outcomes. |
| Artifact/Wiki/distillation | S07/S25/S53–S57/S75: COW, claim support, review tiers/history/dependencies. |
| HTTP/MCP/federation | S10–S15/S31/S32/S60/S61/S72/S98: owner-issued machine rights, source import, execution/read/control. |
| Selected Google | S58/S59/S74: actual action and appropriate byte/representation readback. |
| Model/budget lifecycle | S15/S29/S33/S34/S71/S81: safe renewal/UNKNOWN and no repeated completed payment. |
| Security/privacy | S10/S25/S69/S70/S81/S95: distinct view/model/client disclosure and no authority from prose. |
| Queues/DO/Workflow | S14–S17/S32/S64/S72/S95: durable settlement, bounded replay/cancel/recovery. |
| Erasure/retention/offsite/restore/exit | S55/S62–S67/S86/S95: managed closure, independent approved backup, purge-first restore/rollback. |
| Steward/operations | S17/S68/S71/S74: content-free findings and candidate-only updates without mutation loops. |
| Language/native verifier | S78–S89 and K1/K2a/#176: real compiled ABI and per-family single runtime owner. |
| UX/quality/performance/release | S26/S73–S76/S90/S92–S97: one integrated build, independent corpus/native observations/T6 and canary. |

## 7. How to finish a checkpoint

Read only the next relevant guide section, its selected five-part contract and actual current caller. Implement the missing delta, run the named positive/negative/replay tests, inspect real rows/bytes/IDs, record PRE_TASK_SHA plus implementing SHA and exact result in the owning PR. Shared interfaces update producers/consumers together. NEW tests/tools belong to their owning task and must be wired into an actual runner. No file-existence, compile-only, zero-test or self-declared receipt completion.

After two equivalent failed approaches retain command/error/observed state, separate root cause from subsequent symptoms and change the diagnostic strategy. Do not repeatedly deploy to diagnose a locally reproducible failure, weaken assertions or alter documentation to bless broken behavior. A discovered defect belongs to the existing relevant task with regression; a genuine new requirement must be explicitly identified, not silently expand optional scope.

### Necessary external inputs, not more unspecified design

Reuse already approved working account/resources, identities, selected connector, budgets and destinations. Missing actual secret/target/independent peer/offsite failure-domain evidence blocks only its live action, not unrelated local implementation. Do not guess values, fabricate provider receipts or repeatedly ask for available configuration. Real paid load, destructive restore/erasure and production traffic stay within owner authorization and disposable target boundaries. Current data policy precedes restored disclosure. Uncontrolled downloaded copies and future monthly bills cannot be promised as remotely erased/already measured.

## 8. Definition of project completion

The queue is intended to finish the known selected v1 and the mapped audit, not stop at a repaired prototype. Closing implementation cards alone is insufficient: S92 actual local product, S93 real quality, S94 attested deployment, S95 native/security/client failure conformance, S96 measured workload and S97 accepted release/canary must pass on compatible identities, including S98/S99 and required Rust families.

When those criteria genuinely pass, the selected v1 can be closed as delivered. This does not mean software can never have another defect. At the time of this planning correction application tests/native qualification were **NOT_EXECUTED**; only source/specification/reference checks and documentation writes were performed.

**Agent handoff:** begin with the next unmet checkpoint, normally S01. Follow the linked real commands and exact existing/NEW test entries, implement on current main, preserve working code and record evidence. Continue through technical dependencies without waiting for unrelated future live receipts. Do not make another planning queue or redesign the agreed stack. Stop only for a precise unresolved conflict or genuinely unavailable authorization/input affecting the attempted action; continue independent safe local work.
