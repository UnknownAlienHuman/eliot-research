---
title: "Eliot Research production readiness plan"
protocol: "eliotr.production-readiness.v1"
version: "1.0"
date: 2026-09-01
status: "normative execution plan"
baseline_commit: "4e15fadfb3cf40285bdb55112abe5d91fc8af7b3"
authority: "ordered closure plan for declaring Eliot Research production-ready"
target: "production-ready v1"
---

# Eliot Research production readiness plan

## 0. What `production-ready` means

Eliot Research may be called **production-ready** only when all mandatory conditions below are true.
A green unit-test run, a local Wrangler dry-run, a successful provider request, or a deployed Worker by
itself is not production readiness.

```text
production-ready =
  mandatory product paths implemented
  + production-critical Rust authority migration completed
  + real Cloudflare and Google/provider round trips retained as receipts
  + T0–T6 gates passed for the enabled product profile
  + security, erasure, backup, restore, observability and rollback proven
  + owner PWA and API user loops usable end to end
```

### Mandatory launch profile

The v1 production launch includes architecture Slices **0–6**:

- platform and authority foundation;
- source ingest and evidence-grade retrieval;
- minimum Wiki and federation;
- Corpus Lens and persisted scopes;
- governed investigations and Research Workflow;
- claim audit, artifact materialization and dependency tracking;
- security, erasure, recovery and operational hardening.

Slice 7 specialist profiles are optional after launch unless explicitly enabled in the release profile.
Browser Rendering, R2 Data Catalog/SQL and other optional Cloudflare products are not readiness blockers
unless a selected production feature depends on them.

### Mechanical release rule

Production release is blocked while any of the following is true:

- a mandatory route or authority path remains `SCAFFOLD_FAIL_CLOSED` or `IN_PROGRESS`;
- a required contour is only `IMPLEMENTED_NOT_LIVE`;
- any P0 or P1 row remains in `gap-register.md` for the selected launch profile;
- TypeScript and Rust both remain permanent authority for the same promoted domain decision;
- a live gate is represented only by a mock, local emulator, typecheck, dry-run, provider acceptance,
  Queue acknowledgement, D1 change count, or Workflow completion;
- an overdue erasure case, unresolved material citation, schema drift, unknown denominator, partial index
  generation, secret exposure, or untested rollback exists.

## 1. Current baseline

Baseline: `main@4e15fadfb3cf40285bdb55112abe5d91fc8af7b3`.

### Implemented but not live-qualified

- Cloudflare Access-protected HTTP dispatch and owner catalog;
- deterministic immutable ScopeSnapshot persistence and currentness authority;
- deterministic Corpus Lens SourceCard/DocumentMap/ProjectAtlas orientation with explicit omissions;
- governed normalized-bundle ingest and SourceAdmissionDecision;
- D1 outbox, Queue inbox, retry and ACK discipline;
- deterministic projection execution and generation activation;
- exact EvidenceHandle and citation-resolution paths;
- exact erasure closure and purge ledger;
- Gemini Spark MCP planning and Google orchestration boundary.

### Still unavailable or not composed

- ER-31 public Worker API composition and automatic navigation materialization;
- `research.query`;
- `research.run` and the governed Research Workflow;
- Wiki proposal/promotion and dependency tracking;
- artifact compilation, trace and change products;
- production Drive cursor/OAuth/tamper path.

### Not yet proven on the real platform

- production Cloudflare resource provisioning and deployed smoke;
- remote D1/R2 authority readback;
- Queue duplicate/redelivery/DLQ behavior;
- Durable Object hibernation/reconnect;
- Workflow retry/resume/cancellation/budget behavior;
- managed AI Search generation promotion and locator-to-evidence path;
- Google Workspace, Drive and gcloud exact write/readback;
- external federation provider execution;
- clean-account backup restore with purge-ledger replay;
- representative T2/T3 corpus quality and T6 workload results.

### Language migration state

`eliotr.language-runtime.v1` M0 and M1 are complete. M2–M7 are not complete. The current TypeScript
domain code remains the active transitional executable specification; no product authority moved to Rust
during M1.

## 2. Ordered critical path

The numbered phases below are the implementation order. Work may run in parallel only where the stated
dependencies permit it. Each phase closes only when its exit evidence is retained in the repository or
in an immutable named release receipt.

## 3. Phase 1 — keep the source of truth accurate

**Owners:** ER-00, integration owner.

- [x] Establish the language/runtime contract.
- [x] Enforce one-task/one-branch discipline and automated branch cleanup.
- [ ] Replace stale README claims with the current implementation state.
- [ ] Link this plan from `README.md`, `IMPLEMENTATION.md`, `implementation-status.md` and
      `gap-register.md`.
- [ ] Make every implementation PR update both `implementation-status.json` and `gap-register.md` when
      a contour changes state.
- [ ] Prohibit release notes from claiming `LIVE_QUALIFIED` without a retained live receipt reference.

**Exit evidence**

- repository status documents agree with machine-readable implementation state;
- no mandatory gap exists only in prose or only in source code;
- `pnpm check` remains green.

## 4. Phase 2 — establish the Rust verification foundation (M1)

**Owners:** ER-00, ER-01, Rust migration owner.

**Status:** COMPLETE on 2026-09-01. Implementation evidence commit `9e9a4d6bbfd5f2a67427714e7adfb9d71eb6c296` passed CI run
`33522427515` with both the legacy TypeScript/Cloudflare job and the Rust M1 job successful. This closes only
the verification foundation: M2–M7 and every live platform/provider receipt remain open.

Create the initial workspace without changing the active TypeScript Worker entrypoint:

```text
Cargo.toml
rust-toolchain.toml
deny.toml
.config/nextest.toml
crates/eliotr-test-vectors
crates/eliotr-canonical
crates/eliotr-kernel-wasm
```

- [x] Pin the Rust toolchain and `wasm32-unknown-unknown` target.
- [x] Add `cargo fmt --check`.
- [x] Add Clippy for all targets/features with warnings denied.
- [x] Add `cargo nextest`, documentation tests and `cargo deny`.
- [x] Add release Wasm build and compressed-size reporting.
- [x] Add branch-aware coverage for deterministic core crates.
- [x] Add scheduled Miri, fuzz and mutation-test jobs for critical pure crates.
- [x] Create one versioned fixture format consumed by TypeScript, native Rust and Rust/Wasm.
- [x] Enforce `#![forbid(unsafe_code)]` in pure crates.
- [x] Enforce that pure crates cannot import Cloudflare, network, filesystem, process, hidden clock or
      random-state dependencies.

**Exit evidence**

```text
cargo fmt --all --check
cargo clippy --workspace --all-targets --all-features --locked -- -D warnings
cargo nextest run --workspace --all-features --locked
cargo test --doc --workspace --all-features --locked
cargo deny check
cargo build --workspace --target wasm32-unknown-unknown --release --locked
cargo +nightly-2026-08-31 llvm-cov --package eliotr-canonical --package eliotr-test-vectors --all-features --locked --branch --fail-under-lines 90 --text
```

The existing TypeScript Worker must still pass all current CI and Wrangler dry-run gates.

Retained deterministic evidence on `9e9a4d6bbfd5f2a67427714e7adfb9d71eb6c296`:

- 28/28 native Rust tests passed; formatting, Clippy, doctests and `cargo deny` passed;
- default Wasm: 363 raw / 258 gzip bytes, zero imports, no product ABI;
- feature-gated self-test Wasm: 8,790 raw / 4,142 gzip bytes, zero imports;
- coverage: 99.60% lines, 96.75% branches, 100% functions and 97.38% regions;
- the separately excluded fuzz dependency graph is frozen in `fuzz/Cargo.lock`;
- Cloudflare, Google, provider, recovery and workload receipts: `NOT EXECUTED`.

## 5. Phase 3 — migrate canonical identity and serialization (M2)

**Owners:** ER-01, ER-02, Rust canonical/identity owners.

- [ ] Implement canonical JSON/body serialization in Rust.
- [ ] Implement stable IDs, SHA-256 body rules and generation-token validation in Rust.
- [ ] Port owner-cutover, residency, operation, receipt and handle golden vectors.
- [ ] Run every vector through TypeScript, native Rust and compiled Wasm.
- [ ] Require byte-for-byte output, digest, result and typed-error parity.
- [ ] Add property tests for map ordering, unknown fields, Unicode, numeric boundaries and duplicate
      identity fields.
- [ ] Run Rust/Wasm in shadow mode without changing canonical state.
- [ ] Promote one canonical family at a time and remove its superseded TypeScript authority.

**Exit evidence**

- no canonical body or stable ID has two permanent owners;
- all differential fixtures pass;
- bundle, startup and Wasm-memory budgets pass;
- rollback instructions exist for each promoted family.

## 6. Phase 4 — migrate deterministic domain authority (M3–M4)

**Owners:** ER-02, ER-03 and the owning capability packets.

Move pure decisions, not Cloudflare I/O:

- [ ] source-owner and source-lifecycle state machines;
- [ ] scope algebra;
- [ ] policy, disclosure, residency, retention and qualification invariants;
- [ ] SourceAdmissionDecision logic;
- [ ] projection and precision-ceiling algorithms;
- [ ] EvidenceHandle, citation and CoverageReceipt logical invariants;
- [ ] erasure, federation and Research Workflow disposition logic;
- [ ] claim-audit and completion-disposition rules.

Every operation receives explicit time, generation, policy and observed-state inputs. Rust performs no
D1, R2, Queue, Workflow, provider or model effect.

**Exit evidence**

- native Rust, Wasm and transitional TypeScript fixtures agree;
- critical pure crates satisfy the coverage threshold or document an approved exception;
- fuzz/property/mutation tests cover state transitions and impossible dispositions;
- TypeScript may reject malformed transport input but cannot strengthen a Rust decision.

## 7. Phase 5 — promote the Wasm kernel and remove duplicate authority (M5–M7)

**Owners:** ER-00, ER-24, capability owners.

- [ ] Implement the versioned canonical-byte ABI from `eliotr.language-runtime.v1`.
- [ ] Add bounded Wasm allocation and typed-error mapping.
- [ ] Run deterministic shadow comparisons without duplicating external effects.
- [ ] Persist content-free mismatch receipts and fail closed on divergence.
- [ ] Measure bundle size, startup, memory and p50/p95 CPU.
- [ ] Promote Rust results capability by capability.
- [ ] Add a rollback switch for every promotion.
- [ ] Remove superseded TypeScript domain implementations after the observation window.
- [ ] Update `implementation-status.json` to name the Rust authority owner.

**Exit evidence**

- no production-critical domain decision has permanent dual authority;
- TypeScript remains the sole Cloudflare control plane;
- Rust/Wasm remains effect-free and portable;
- Worker limits remain within the architecture budgets.

## 8. Phase 6 — close all fail-closed mandatory product code

### 8.1 Federation — ER-22

- [ ] Replace `FederationImplementationPendingError` with a durable service.
- [ ] Bind submission to principal, immutable scope, policy, generation, canonical request digest and
      idempotency key.
- [ ] Persist request, job, attempts, cancellation, results and receipts in D1/R2 authority.
- [ ] Implement `submit`, `status`, bounded `result` cursor/range reads and monotone `cancel`.
- [ ] Keep provider completion, transport completion and research completion separate.
- [ ] Reject forged provider citations and over-strong absence/completeness dispositions.
- [ ] Register exact erasure dependencies.

### 8.2 Persisted scopes — ER-10/ER-30

- [x] Wire deterministic `UNION`, `INTERSECT` and `EXCEPT` evaluation to an immutable
      ScopeSnapshot repository contract with created/exact-replay/readback semantics.
- [x] Bind snapshot digest to exact revisions, owner generations, member-policy closure, purge-ledger
      revision, disclosure closure, client fence and expiry.
- [x] Implement deterministic currentness checks and exact invalidation.
- [ ] Compose principal grants and the remote D1 ScopeSnapshot repository.
- [ ] Prevent retrieval, evidence resolution and research execution from using an unfrozen scope.

### 8.3 Managed retrieval and Corpus Lens — ER-06/ER-07/ER-16/ER-31

- [ ] Strictly decode AI Search output as locator candidates only.
- [ ] Reject oversized, malformed and fake-handle provider fields.
- [ ] Implement exact, lexical, semantic, literal and structure lanes with bounded degradation.
- [ ] Keep D1 FTS fallback operational when managed search is degraded.
- [ ] Recheck owner generation, policy, scope and purge state after retrieval.
- [x] Implement deterministic orientation without treating top-k as completeness proof.
- [x] Persist immutable scope-bound navigation artifacts and provide request-scoped D1 navigation
      composition with local identity, authorization-race and purge tests.
- [ ] Compose production scope/policy observations, grant issuance and materialization into public
      `research.orient`; implement the QueryResult/evidence/trace contract and `research.query`.
- [x] Implement SourceCard, DocumentMap and ProjectAtlas with explicit omissions and coverage limits.

### 8.4 Governed Research Workflow — ER-08/ER-09/ER-10

- [ ] Replace the Workflow skeleton with the complete monotone stage machine.
- [ ] Persist Investigation, protocol, obligations, hypotheses, branches and checkpoints.
- [ ] Check cancellation and budget before and after every expensive boundary.
- [ ] Persist model/provider output before acknowledging the call.
- [ ] Prove retry after lost acknowledgement does not execute or pay twice.
- [ ] Require Evidence Freeze before synthesis and explicit reopen for later evidence.
- [ ] Execute counter-search, claim audit and coverage accounting.
- [ ] Return one of exactly nine honest `CompletionDisposition` values.
- [ ] Keep Workflow `COMPLETED` separate from research completion.

### 8.5 Wiki and artifact materialization — ER-11/ER-12

- [ ] Implement immutable Wiki revisions with expected-head CAS.
- [ ] Implement proposal, review, promotion and dependency closure.
- [ ] Implement Artifact Compiler with copy-on-write section updates.
- [ ] Require complete citation-resolution receipts before publication.
- [ ] Make purge invalidate or mark dependent sections pending revalidation.
- [ ] Enable `research.artifact`, `research.wiki.propose`, `research.trace` and `research.changes`.

### 8.6 Required ChatGPT Drive Exchange — ER-18/ER-19/ER-20; optional Gemini ER-36

- [ ] Finish exact Drive schema provisioning and generation activation.
- [ ] Implement append/import/readback/reconnect and cursor reconciliation.
- [ ] Detect historical-row mutation and tamper.
- [ ] Store refresh tokens encrypted and expose `REAUTH_REQUIRED` without losing canonical artifacts.
- [ ] Implement the mandatory Day-0 ChatGPT Drive Exchange from canonical §§12.3–12.12 and ADR-0003;
      interface-only ports and the optional Gemini planner do not satisfy this item.
- [ ] Select exactly one active ChatGPT write transport; a future qualified native app replaces Drive,
      rather than adding a simultaneous writer. No accepted ADR currently replaces Drive with Gemini.
- [ ] When the optional Gemini service is explicitly selected, separately qualify Access/MCP and exact
      Workspace/gcloud action readbacks. Self-reported v1 observations cannot substitute for these gates.
      Preserve existing mutual-exclusion guards until the reviewed production profile is composed.

### 8.7 Owner PWA — ER-25

- [ ] Implement persistent Library, Investigation and Evidence panels.
- [ ] Add projects/sources, ingest progress, readiness, retrieval, evidence viewer, Wiki, reports and jobs.
- [ ] Preserve typed API problems, trace IDs and retryability.
- [ ] Show health, freshness, coverage, omissions, policy denial, budget stop and connector degradation.
- [ ] Implement WebSocket/job reconnect and bounded offline behavior.
- [ ] Add Playwright tests for complete owner loops and degraded dependencies.
- [ ] Keep PWA initial JavaScript within the architecture gzip budget.

**Phase exit evidence**

- no mandatory product route returns `IMPLEMENTATION_SLICE_PENDING`;
- no mandatory source marker remains `SCAFFOLD_FAIL_CLOSED` or `IN_PROGRESS`;
- unit, property, negative and migration fixtures pass;
- optional Slice 7 routes remain explicitly disabled rather than partially implemented.

## 9. Phase 7 — provision a real staging environment

**Owners:** ER-17, ER-26, platform owner.

Provision by exact name and read back:

```text
1 Worker + Static Assets
2 D1 databases
2 R2 buckets
1 Queue + DLQ
1 ResearchSession Durable Object
1 ResearchWorkflow
1 AI Search namespace and versioned instances
2 AI Gateways
1 Access application family
1 Analytics Engine dataset
scheduled triggers
```

Google staging requires:

```text
one project
one dedicated test account
one exact exchange spreadsheet and folder
Workspace/gcloud OAuth or ADC as selected
```

- [ ] Create least-privilege Cloudflare and Google credentials.
- [ ] Put secrets only in approved secret storage.
- [ ] Run `pnpm cf:preflight:remote`.
- [ ] Provision create-or-verify resources; reject profile drift.
- [ ] Apply additive D1 migrations before incompatible code activation.
- [ ] Deploy one staging Worker generation and retain the deployment receipt.
- [ ] Verify generated bindings, routes, DO/Workflow exports and exact resource IDs.
- [ ] Confirm staging contains no production data.

**Exit evidence**

- staging deployment receipt;
- exact Cloudflare resource inventory;
- migration readback;
- authenticated health/capability smoke;
- rollback target retained.

## 10. Phase 8 — execute T4 live platform conformance

**Owners:** ER-27 plus each capability owner.

Run real, disposable, retained fixtures:

- [ ] owner Access JWT allow and deny;
- [ ] service-principal allow-list and class-boundary denial;
- [ ] D1 write, CAS conflict, transaction rollback, restart and readback;
- [ ] R2 multipart upload, immutable promotion, conditional range read and digest verification;
- [ ] Queue duplicate delivery, lost ACK, retry, poison message and DLQ;
- [ ] Durable Object hibernation, reconnect and persist-before-notify;
- [ ] Workflow checkpoint retry, lost ACK, cancellation, budget stop and resume;
- [ ] D1 Search shadow activation and rollback;
- [ ] AI Search upload, item readback, generation promotion, canary query and deletion;
- [ ] AI Search locator resolved through exact authorized R2 bytes into EvidenceHandle;
- [ ] ingest prepare/upload/commit through deployed HTTP and Access;
- [ ] exact erasure deletion and absence readback across all selected locations;
- [ ] federation submit/status/result/cancel through a real provider adapter;
- [ ] Gemini MCP and selected Google transport exact mutation/readback/reconnect.

**Exit evidence**

Every required `IMPLEMENTED_NOT_LIVE` entry becomes `LIVE_QUALIFIED` only with a retained receipt reference.
Failures remain explicit and do not silently reduce the test profile.

## 11. Phase 9 — build and adjudicate the real T2/T3 corpus

**Owners:** ER-23, ER-31, ER-32.

- [ ] Add representative Russian and English documents.
- [ ] Add repositories/code, tables, long documents, conversation exports and mixed-quality sources.
- [ ] Adjudicate exact, phrase, literal, semantic, structure, multi-project and exhaustive cases.
- [ ] Include stale revision, purge, unsupported precision, prompt injection and absent-answer cases.
- [ ] Define promotion thresholds by product, not one blended retrieval score.
- [ ] Measure false positive, false negative, locator resolution and citation accuracy.
- [ ] Require T2/T3 before parser, embedding, reranker, prompt or index-generation promotion.
- [ ] Retain rollback generations after promotion.

**Exit evidence**

- versioned corpus with adjudication records;
- explicit thresholds and forbidden regressions;
- selected production index/model/parser generations pass;
- no completeness or absence claim exceeds the frozen denominator.

## 12. Phase 10 — execute T5 security, privacy and failure hardening

**Owners:** ER-03, ER-17, ER-28, ER-33, ER-34.

- [ ] Threat-model every owner, service, MCP, Google and federation boundary.
- [ ] Prove source instructions cannot gain system, tool or policy authority.
- [ ] Prove side-effect tools are absent from research generation.
- [ ] Verify disclosure, inference, source/task and client policies independently.
- [ ] Verify logs and metrics reject credentials, prompt bodies, source text and evidence excerpts.
- [ ] Exercise stale generation, dual writer, cutover failure, cross-residency dedup and key-reuse cases.
- [ ] Exercise model/provider/Drive/AI Search/Queue/D1/R2 outages and degraded-state behavior.
- [ ] Exercise blocked legal hold, partial purge, restart and exact absence proof.
- [ ] Revoke and reconnect OAuth/Access credentials.
- [ ] Run dependency, secret, license and vulnerability audits for TypeScript and Rust.

**Exit evidence**

- T5 report with retained negative fixtures;
- no critical/high unresolved security finding;
- overdue erasure and unresolved disclosure violations block release;
- documented incident and credential-rotation procedures.

## 13. Phase 11 — implement backup, restore and disaster recovery

**Owners:** ER-34, platform owner.

- [ ] Define immutable backup epochs for D1, R2 manifests, configuration and required receipts.
- [ ] Exclude ephemeral Queue, DO and projection state from authority assumptions.
- [ ] Preserve current purge-ledger revision with every backup epoch.
- [ ] Restore into a clean account/environment.
- [ ] Apply the current purge ledger before any restored payload can be exposed.
- [ ] Rebuild D1 Search and AI Search from canonical authority.
- [ ] Verify erased content does not reappear.
- [ ] Verify Investigation, Wiki, artifact, source and receipt heads.
- [ ] Measure and approve RPO/RTO.
- [ ] Test Worker/index rollback independently from data restore.

**Exit evidence**

- clean-account restore receipt;
- purge-ledger replay receipt;
- RPO/RTO measurement;
- tested rollback and disaster runbook.

## 14. Phase 12 — establish observability, SLOs and spend controls

**Owners:** ER-17, ER-26, ER-35.

- [ ] Publish content-free metrics for auth denial, latency, D1 conflict, outbox age, retries, DLQ,
      projection readiness, index drift, citation failure, provider degradation and erasure deadlines.
- [ ] Create owner-visible health and incident snapshots.
- [ ] Alert on stale generations, missing connectors, overdue erasure, DLQ growth and uncertain settlement.
- [ ] Activate AI Gateway budgets/routes and Cloudflare spend limits.
- [ ] Define SLOs and error budgets for owner API, ingest, retrieval, evidence open, research jobs and
      external transports.
- [ ] Verify 100% sampling for security, erasure and DEEP/AUDIT/REPORT failures without content leakage.
- [ ] Record per-run usage and cost without storing prompts or source content in telemetry.

**Exit evidence**

- dashboards and alert routes exercised;
- spend-limit and budget-stop receipts;
- operational owner can identify and diagnose a failed user loop without direct database access.

## 15. Phase 13 — execute T6 workload and performance qualification

**Owners:** ER-35 and platform owners.

Measure at least:

```text
5 / 20 / 50 concurrent read agents
5 interactive Research sessions
10 queued ingestion/projection jobs
2 concurrent long Research Workflows
```

- [ ] Measure p50/p95/p99 latency, CPU, memory and cost by operation.
- [ ] Measure D1 contention, CAS conflicts and overloaded/retry behavior.
- [ ] Measure R2 and AI Search throughput and generation-promotion duration.
- [ ] Measure Queue lag, redelivery and DLQ behavior.
- [ ] Measure DO/WebSocket reconnect and Workflow checkpoint overhead.
- [ ] Compare promoted Rust/Wasm operations with the transitional TypeScript baseline.
- [ ] Verify compressed Worker ≤ 4 MiB, startup ≤ 400 ms, first-party heap target ≤ 32 MiB and PWA
      initial JavaScript ≤ 600 KiB gzip.
- [ ] Establish capacity limits and explicit overload responses.

**Exit evidence**

- reproducible T6 report;
- approved capacity envelope and cost model;
- no hidden unbounded loop, corpus load, response or persisted session state;
- p95/SLO and spend targets pass for the selected production profile.

## 16. Phase 14 — production launch

**Owners:** release owner, ER-26, ER-27.

- [ ] All mandatory P0 and P1 gaps are closed.
- [ ] All mandatory implementation entries are `LIVE_QUALIFIED` with receipt references.
- [ ] Rust M1–M7 is complete for production-critical deterministic authority.
- [ ] T0–T6 gates pass for the selected release generations.
- [ ] Release checklist and security checklist are complete.
- [ ] D1 migrations and backfills are applied and read back.
- [ ] AI Search generation is promoted with retained rollback generation.
- [ ] Production Access, secrets, budgets and spend limits are active.
- [ ] DLQ is empty and overdue erasure count is zero.
- [ ] Deployment generation, configuration fingerprint and rollback target are recorded.
- [ ] Canary user loops pass:
  - ingest one source;
  - retrieve and reopen exact evidence;
  - run one governed investigation;
  - publish one Wiki page or artifact with fully resolved citations;
  - submit and read one federation job;
  - exercise the selected Google transport;
  - execute a disposable erasure and verify absence;
  - restore a clean disposable environment without resurrecting erased data.
- [ ] Observe the canary window and approve production head explicitly.

**Production declaration**

The release receipt must name:

```text
Worker generation
D1 schema generations
R2 residency profiles
D1 Search generation
AI Search instance/profile/generation
Rust kernel schema and Wasm digest
PWA asset digest
Access application/audience
Google transport generation
provider route fingerprints
T2/T3/T4/T5/T6 report references
rollback targets
```

Only after this receipt is complete may the repository and product state say `production-ready`.

## 17. After launch — optional specialist profiles

Slice 7 capabilities are separate promotions:

- code intelligence;
- scholarly metadata;
- conversation episodes;
- structured-data profiles;
- optional Browser Rendering or large tabular infrastructure.

Each requires its own measured benefit, exact-handle behavior, security review, corpus thresholds,
operational cost and rollback. No optional profile may weaken the base production contract.

## 18. Recommended next PR sequence

The immediate sequence from the current baseline is:

1. **ER-00 / M1:** Cargo workspace, Rust CI and shared test vectors.
2. **ER-01/02 / M2:** canonical JSON, digests, IDs and generation tokens.
3. **ER-22:** durable generic federation implementation.
4. **ER-30:** persisted immutable ScopeSnapshot authority.
5. **ER-06/16/31:** strict managed-search decoding and Corpus Lens query/orientation.
6. **ER-09:** governed Research Workflow and durable checkpoints.
7. **ER-11/12:** minimum Wiki and Artifact Compiler.
8. **ER-18/19/20:** mandatory ChatGPT Drive code and real qualification; **ER-36:** optional Gemini service qualification when selected.
9. **ER-25:** complete owner PWA loops.
10. **ER-26/27:** staging deployment and T4 live conformance.
11. **ER-23/31/32:** T2/T3 real corpus and generation promotion.
12. **ER-28/33/34:** T5, erasure/offsite paths and clean restore.
13. **ER-35:** T6 workload/cost qualification.
14. **Release:** canary, rollback verification and production readiness receipt.

The Rust migration and remaining product code may proceed in parallel, but neither track may be omitted
from the final production declaration.

## Local-first launch checkpoint — 2026-09-05

The active owner metadata orientation/trace loop is implemented through PWA -> HTTP -> explicit D1
read policy -> frozen scope/grant -> immutable navigation -> durable result/trace. This does not close
the full query, investigation, federation, Wiki, Rust promotion or live launch gates above.
`local:prepare` builds assets and applies both local migration streams; `local:dev` is loopback-only.
The deploy orchestrator now rejects known pending mandatory product paths before any remote effect.
This negative guard is not a substitute for complete source audit or T0–T6 exit evidence.
