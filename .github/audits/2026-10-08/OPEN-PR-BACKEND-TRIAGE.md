# Open PR backend triage — 2026-10-08

Repository snapshot: 76 open pull requests were returned by the current GitHub search. This file is a first-pass family disposition, not permission to close or delete branches. Source preservation PRs remain recoverable until their deltas are reconciled.

Source baseline used for code findings: `3e6c25660c1ae515760e19d5f9e6b8a735795c4c`.

## Status vocabulary

```text
ACTIVE_CORE
  required backend implementation or deterministic correctness work

ABSORBED
  acceptance/behavior belongs to a newer owner PR; do not implement a second path

READY_AFTER_CORE
  valid Eliot-specific feature, but depends on the core Research/retrieval/effect repairs

LATER_ACCEPTANCE
  staging, native, performance or release evidence after implementation assembly

OPTIONAL_PROFILE
  selected integration/product profile; not a mandatory backend blocker

OPTIONAL_KERNEL
  pure Rust/kernel optimization or parity work; not required to reproduce Cloudflare primitives

PRESERVATION_ONLY
  salvage source; never merge wholesale, reconcile individual deltas

UI_OWNER
  frontend/interface agent owns it

BLOCKED_REVIEW
  known unresolved defect or overlap inside the proposed change
```

## 1. Active backend core

These PRs form the current implementation graph and remain active:

```text
#209  R00 first-cause / citation-effect outcomes
#320  scoped AI Search prefilter (READY_AFTER_REBASE)
#321  bounded stream cleanup (READY_AFTER_REBASE)
#322  lane-order guard (READY_AFTER_SCOPED_CHECK)
#323  fusion tuple identity (land first or absorb in #242)
#324  AI Search response envelope task
#242  R02 managed hybrid / exact evidence / replay identity
#325  R03 branch-local retrieval and findings
#214  R04 counter-search
#326  R05 native external wait
#233  R06 ASK/BRIEF product compiler
#231  R07 controlled web acquisition
#330  R08 Cloudflare-native stage effect classes
#331  R09 common bounded stream reader integration
#332  R10 consistent ledger snapshot
#244  AI Search Items reconciliation/generation readiness
#256  Queue/DLQ ownership and business settlement
#264  AIChatAgent/WebSocket session transport
#285  Golden v2 / reproducible promotion
#328  bounded Golden source patch (BLOCKED_REVIEW until decoder bound)
#291  large-scope accounting and actual retrieval capacity
#263  native traces / first-cause diagnostics / Gateway controls
#261  disclosure/injection/security boundaries
#262  ownership/residency/cutover
#255  managed erasure closure
#282  emitted Worker/PWA budget gates
#268  mechanical formatting after #282
```

### Cloudflare allocation

- #320/#324/#242 use AI Search rather than adding another relevance engine.
- #330/#326 use Workflows rather than adding another workflow runtime.
- #256 uses Queue retry/DLQ rather than another delivery scheduler.
- #264 uses AIChatAgent/WebSocketChatTransport rather than a custom resume protocol.
- #231 uses Web Search + Markdown/Browser Run rather than another crawler/browser farm.
- #263 uses Workers Traces/AI Gateway controls rather than another observability platform.

## 2. Absorbed by newer owners

The following old PRs contain valid acceptance criteria but must not create parallel implementations:

| PR | Disposition | New owner / reason |
|---|---|---|
| #213 S21 stage truth | `ABSORBED` | #325 findings + #330 effect/stage policy + #263 presentation diagnostics distinguish substantive work from technical checkpoints. Keep its negative acceptance. |
| #215 S23 introductory fallback | `ABSORBED` | #242 explicitly removes document-head fallback mislabeled as LEX and preserves no-hit/coverage semantics. |
| #230 S38 lane verification | `ABSORBED_PARTIAL` | registration/verifier semantics remain unique Eliot work, but branch wiring and findings belong to #325/#214/#209. Integrate criteria through one shared contract owner. |
| #234 S42 COMPARE | `ABSORBED_PRODUCT` | one product-plan compiler in #233; COMPARE is a later profile, not a separate pipeline/runtime. |
| #235 S43 HYPOTHESIS_REVIEW | `ABSORBED_PRODUCT` | #233 product compiler + #325/#214 findings/counterevidence. |
| #236 S44 FACT_CHECK | `ABSORBED_PRODUCT` | #233 product compiler + existing claim audit/exact evidence. |
| #237 S45 PROJECT_VS_LITERATURE_AUDIT | `ABSORBED_PRODUCT` | #233 compiler + #325/#214 and artifact path. |
| #238 S46 DEEP_RESEARCH | `ABSORBED_PRODUCT` | core Research assembly; no second deep-research engine. |
| #241 S49 ProjectAtlas | `ABSORBED_PARTIAL` | orientation/navigation remains valid, but large-scope accounting is #291 and provider relevance #242. |
| #246 S54 publication | `ABSORBED_PARTIAL` | publication authority remains unique; product-specific report generation uses #233. Do not create another artifact engine. |
| #260 S68 Steward | `ABSORBED_OPTIONAL` | future candidate/reconciliation jobs only after #285 quality gates; no autonomous rewrite loop. |
| #210 S18 launch code checker | `ABSORBED_ACCEPTANCE` | final execution/readiness index plus #286–#289; no second release-gate system. |
| #222 S30 status consistency | `ABSORBED_DOCS` | current backend index/completion gate replaces copied status narratives; preserve historical state only. |

Do not close automatically. First update each body or final disposition record so the retained criteria point at the new owner. No branch deletion without explicit authorization.

## 3. Ready after core — unique Eliot functionality

These functions are not provided by Cloudflare and remain legitimate, but they should start only after the P0 core contracts settle:

```text
#232  research debt, terminal disposition and versioned reopen
#239  source qualification / normalized admission fidelity
#240  coordinate-bound structural navigation
#247  derived dependency/erasure propagation
#248  selective EvidenceAtoms
#249  source-grounded ArgumentMap
#259  code/index rollback with current authority
```

Rules:

- reuse SourceRevision, EvidenceHandle, product plan, current authority and generation lifecycle;
- do not add a graph database for #248/#249;
- AI-derived atoms/relations are candidates until exact admission/verification;
- rollback never resurrects erased or revoked material;
- no feature adds its own workflow, search engine, citation registry or artifact store.

## 4. Optional profiles/integrations

These are selected-profile capabilities, not mandatory blockers for the NotebookLM-like core:

```text
#250  Workspace external candidate admission
#251  Google artifact delivery/readback
#252  federation execution
#253  independent federation wire client
```

Disposition: `OPTIONAL_PROFILE`.

They become active only when the owner selects the external profile and its credentials/test environment. Missing selected-client live access is `NOT_EXECUTED`, not a core failure. Google I/O remains in the official connector; federation transport cannot strengthen Eliot authority.

## 5. Rust/kernel family

PRs:

```text
#270–#281
#176 mutation/promotion prerequisite
```

Disposition: `OPTIONAL_KERNEL`, with #280/#281 as umbrella ABI/promotion work.

Cloudflare remains the platform runtime. Rust may replace bounded pure domain algorithms only when:

```text
same validated input bytes
→ TS/native/Wasm differential parity
→ actual caller switch
→ old implementation removed
```

Rust does not replace:

```text
Workers fetch / AI Search / Workflows / Queues / D1 / R2 / DO
SQL CAS/currentness
provider/model effects
session transport
```

The ten narrowly named Rust PRs should not block backend core implementation. Before starting them, collapse overlapping assignments under #280/#281 and current language-contract ownership. A language percentage or duplicated pure implementation is not a result.

## 6. Later acceptance, not implementation blockers

```text
#283  D1 authority integration tests
#286  staging/deployment attestation
#287  native/live conformance
#288  workload/cost qualification
#289  release completion/canaries
```

Disposition: `LATER_ACCEPTANCE`.

They remain required before production release, but must not circularly block the staging/runtime implementation needed to execute them. Native/paid tests require explicit target/budget authorization.

## 7. UI ownership

```text
#329  React/Vite owner workspace migration
#212  report refresh behavior (criteria handoff to UI owner)
```

Disposition: `UI_OWNER`.

Backend supplies versioned APIs, currentness, progress/citation/artifact data parts and compatibility contracts. This audit does not edit visual design or interface documentation.

## 8. Preservation-only PRs

```text
#121  N1 integration bundle
#173  citation-resolution WIP
#174  coverage-result codec WIP
```

Disposition: `PRESERVATION_ONLY`.

Never merge wholesale. Reconcile each retained delta against current main as:

```text
already integrated / equivalent
superseded
missing and extracted into current owner PR
invalid or ownership-conflicting
```

Once all deltas have a recoverable disposition, the PR may be closed without deleting the branch. Branch deletion is a separate owner decision.

## 9. Missing per-PR work before completion

The family triage substantially reduces the queue, but final completion requires:

1. Update bodies/status of all absorbed PRs so agents do not implement duplicate pipelines.
2. Reconcile preservation PR deltas, at least citation/coverage findings, into #209/#285/#291 as applicable.
3. Collapse Rust tasks into an explicit optional post-core queue.
4. Mark staging/live/performance PRs as acceptance-only and non-blocking for source implementation.
5. Produce a final machine-readable/status table covering all 76 open PRs, including any omitted by this family pass.

## 10. Completion effect

This triage does not close PRs or claim code completion. Its result is an implementation queue where Cloudflare-native core repair is clearly separated from:

```text
unique Eliot semantics
optional products/integrations
optional pure-kernel optimization
later release evidence
preserved historical source
UI work
```

The backend audit may be declared prepared only after the remaining per-PR disposition updates and source-PR fixes in the main completion gate are finished.
