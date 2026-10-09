# Frontend owner execution map

**Status:** dispatch contract for ER-47 and ER-48; implementation remains paused until the owner authorizes one
named checkpoint or autonomous tranche.
**Reviewed main:** `00c85244d362aa89b2f146286a31dffc10a8ed98`.
**Scheduler owner:** ER-49
**Served compatibility baseline:** ER-25 / `apps/eliotr-pwa`
**Target:** one React owner workspace, one side-effect-free owner client, one existing Worker and one attested
production graph.
**Current contract amendment:**
[frontend-current-contract-amendment-2026-10-09.md](frontend-current-contract-amendment-2026-10-09.md)
**Autonomous manager:**
[frontend-autonomous-manager-runbook.md](frontend-autonomous-manager-runbook.md)

This is the bounded dispatch authority. Longer ADR/design/audit documents are conditional references, not a
context bundle for every leaf.

## 0. Checkpoint or tranche authorization

A durable owner comment may authorize one checkpoint or an autonomous tranche from the manager runbook. One
tranche authorization covers routine progression through its dependency-ready checkpoints and named
cross-owner handoffs. The manager does not request confirmation after every passing checkpoint; it stops at the
tranche human gate, a genuine authority/security/ownership blocker, or an unauthorized release/account action.

Leaf ownership remains checkpoint-sized. Tranche authorization changes continuation behavior, not path
ownership, prerequisite evidence, negative tests, merge authority or deployment authority.

## 1. Manager, leaf and claim semantics

ER-47 and ER-48 are manager/reservation packets. ER-49 owns static checkpoint definitions and mechanical
claim/history validation—not product implementation or substantive approval.

- One owner-authorized manager controls one ER-47 or ER-48 direct-main/worktree context.
- One leaf receives exactly one checkpoint ID, exact paths, named inputs and exit evidence.
- Leaves create no branch/worktree, package root, manifest, barrel, route root or shared fixture.
- Parallel work uses dependency-ready IDs, disjoint paths and one manager context per packet.
- One checkpoint ID has at most one `ACTIVE` claim.
- Manager gates serialize composition, barrels, routes/query roots, catalogs, manifests and handoffs.
- A leaf closes only its checkpoint, never a packet or product slice.
- Paths outside packet ownership require the smallest bounded handoff.
- A manager branch/claim never lifts stop or authorizes merge/deploy/account mutation.

ER-25 is a served compatibility baseline, not a completion prerequisite.

## 2. Static registry and temporal enforcement

ER-49 owns:

```text
docs/agent-work/frontend-owner-checkpoints.json
scripts/check-frontend-owner-checkpoints.mjs
scripts/test-frontend-owner-checkpoints.mjs
```

Managers own separate claims:

```text
ER-47 → docs/agent-work/frontend-owner-claims/ER-47/**
ER-48 → docs/agent-work/frontend-owner-claims/ER-48/**
```

A claim records immutable checkpoint/packet/manager/leaf/base/history/exact-path identity plus predecessor refs.
Claim introduction is a strict ancestor of covered source edits. Every source-edit commit has exactly one
active covering claim in its parent tree. Same-commit claim+source, unclaimed/out-of-scope edits, overlaps,
claim rewrite/deletion/recreation and unauthorized takeover fail.

Before ER-49 acceptance: maximum one frontend manager plus one leaf with an owner-visible claim table.
Afterward: every active leaf requires a valid prior claim and passing history checker. ER-49 verifies mechanics,
not truth of human approval or test evidence.

## 3. Coarse packet DAG and external bootstrap gates

```text
ER-47 depends_on: []
ER-48 depends_on: []
ER-49 depends_on: []
ER-25: served compatibility baseline
ER-00/ER-21/ER-24: bounded-handoff owners
```

### B-C — owner-client repository registration (`external_gate`, ER-00)

**Input:** accepted C0.1/C0.2 and C0.4 package-local skeleton.
**Scope:** lockfile, root TS reference, fail-closed boundaries/negative fixture and required root tests.
**Exit:** frozen install/root typecheck includes owner-client; unknown source package fails closed.
**Negative:** unregistered temporary workspace cannot escape ownership/import checks.

### B-U — owner-web/UI repository registration (`external_gate`, ER-00)

**Input:** accepted U1.1a manifests/configs and exact dependency proposal.
**Scope:** lockfile, root refs, boundaries/negative rules, scripts/tests and source/emitted budgets.
**Exit:** one supported React/Vite/Cloudflare tuple; production graph excludes test/MCP/profiling code.
**Negative:** missing registration, legacy/backend import or duplicate Wrangler/React authority fails before
feature work.

Source managers never edit ER-00 files temporarily.

## 4. ER-48 owner-client checkpoints

### C0 — inventory, characterization and package-local skeleton

| ID | Write scope | Result | Depends on | Mandatory negative |
|---|---|---|---|---|
| C0.1 | `packages/owner-api-client/inventory/**` | Module/export/endpoint/side-effect inventory including ResearchSession projection | — | mixed API touching DOM/global event is classified mixed |
| C0.2 | `packages/pwa-http-client/src/**/*.characterization.test.ts` | Freeze transport/problem/auth-loss/timeout/body behavior | C0.1 | HTML login, malformed UTF-8 and oversized body fail closed |
| C0.3 | source/research workspace `*.characterization.test.ts` | Freeze values/errors/mutation identity/currentness/admission/session behavior | C0.1 | late old-session response cannot be current success |
| C0.4 | manager-only owner-client manifest/tsconfig/index + local test config | Minimal renderer-free skeleton/export proposal | C0.1, C0.2 | import without DOM globals has no effect |

C0.4 claims no root integration before B-C.

### C1 — HTTP transport and session seam

| ID | Write scope | Result | Depends on | Mandatory negative |
|---|---|---|---|---|
| C1.1 | `owner-api-client/src/transport/path*.ts`, `headers*.ts`, tests | Same-origin path and legal `HeadersInit` policy | B-C, C0.2 | absolute/protocol-relative/backslash/encoded-parent/conflicting header rejected |
| C1.2 | `transport/body*.ts`, `problem*.ts`, tests | Bounded JSON/problem/whole/range readers | C1.1 | whole rejects 206; range rejects 200/bad validator/transformed representation |
| C1.3 | `transport/client*.ts`, `session/**`, tests | Injected fetch/timers/auth observation and distinct causes | C1.1, C1.2 | hostile cancel preserves error; no timer/listener leak |
| C1.4 | exact legacy HTTP adapters/tests | ER-25 transition over side-effect-free core | C1.3 | old-epoch failures emit once and cannot clear new session |

No feature endpoint moves before C1.

### C2 — Sources client leaves

All require C0.3, C1.4 and accepted ER-49 when parallel.

| ID | Target | Result | Mandatory negative |
|---|---|---|---|
| C2-L | `sources/projects-library/**` | Projects, membership, library and selection | foreign project/stale cursor/generation rejected |
| C2-R | `sources/readiness-revisions/**` | Readiness and immutable revisions | recorded state cannot become active readiness |
| C2-N | `sources/namespaces/**` | Namespace/bootstrap authority | no implicit/foreign namespace or generation substitution |
| C2-I | `sources/import/**` | Capture, explicit conversion/admission, continuation/recovery | no invented conversion request, scope expansion or fresh identity on uncertainty |
| C2-D | `sources/document/**` | Exact document bytes/navigation/coordinates | validator/encoding/length/digest/revision mismatch rejected |
| C2-E | `sources/erasure/**` | Erasure request/status/closure | partial/held erasure cannot appear complete |

**C2-P manager gate:** accepts C2-L/R/N and proves finite exports/no duplicate decoder.

### C3 — Research/Evidence/Studio/Connections client leaves

All require C0.3, C1.4 and accepted ER-49 when parallel.

| ID | Target | Result | Mandatory negative |
|---|---|---|---|
| C3-RC | `research/configuration/**` | Model/research readiness/configuration | configured, qualified and runnable remain distinct |
| C3-RR | `research/runs/**` | Run admission/status/control/history | poll/reconnect cannot create or repeat run |
| C3-RP | `research/session-projection/**` | Exact `AgentClient` callable adapter for `eliotr.research-session-projection.v1` | any args/chat/state/history frame fails; `get-messages` 410 is expected; no run/cancel/effect |
| C3-RH | `research/history-changes/**` | Run history and authenticated changes/currentness | unrelated change cannot invalidate report |
| C3-EM | `evidence/report/**` | Report manifest/sections/export inputs | failed required section blocks complete export |
| C3-EC | `evidence/citations/**` | Citation/evidence reauthorization and excerpt inputs | revoke/generation/digest/revision mismatch rejects bytes |
| C3-S | `studio/**` | Wiki and implemented artifact operations | regenerate is not edit; COW remains typed |
| C3-C | `connections/**` | Session/grant/provider/Google/client diagnostics | health/configuration cannot become Connected |

**C3-R manager gate:** accepts C3-RC/RR/RP/RH and proves:

- canonical HTTP status/history/readback owns detailed progress/failure/report state;
- ResearchSession is snapshot-on-request only;
- only no-arg `readResearchSessionProjection()` is sent;
- `get-messages` stays disabled with typed 410;
- missing/stale projection remains degraded until HTTP readback;
- one run, cancellation and completion authority exists.

**C3-E manager gate:** accepts C3-EM/EC and proves one report/evidence wire implementation.

## 5. ER-47 presentation checkpoints

### U1 — platform, foundation, harness and visual direction

| ID | Write scope | Result | Depends on | Mandatory negative |
|---|---|---|---|---|
| U1.1a | manager-only web/UI manifests, TS/Vite config and HTML | Package-local skeleton and dependency proposal | — | no second Worker/backend, legacy renderer or unpinned production dependency |
| U1.1b | manager-only candidate config/source and receipts | Frozen tuple, sibling Worker build and generated-route parity | B-U | wrong env/remote binding stops; agent/API/410/upgrade cannot fall through to SPA HTML |
| U1-R | manager-only private-data-free browser study/receipt | Current live NotebookLM + official M3/M3 Expressive observation matrix | U1.1b | old screenshots or generic component demos cannot substitute for live inspection |
| U1.2 | `packages/ui/src/tokens/**`, token catalog/tests | Provisional deterministic theme/type/shape/motion roles | U1-R | raw feature design literal fails |
| U1.3 | one primitive path + exact story | Required native-first primitives and one external composite family | U1.2 | focus/CSP/keyboard failure rejects candidate instead of mixing libraries |
| U1.4 | `scripts/ui-owner/**`, `tests/ui-owner/harness/**` | Catalog/design/binding/Storybook/Playwright/visual tooling + ER-49 invocation | ER-49, U1.1b-U1.3 | unsafe binding/claim overlap/CSP/auto-baseline acceptance fails |
| U1-D | canonical composition story, visual-direction tests, internal decision receipt | Manager-accepted coherent direction grounded in U1-R | U1.4 | swatches, generic admin dashboard or NotebookLM pixel copy cannot pass |
| U1.5 | `apps/eliotr-web/src/app/**`, `routes/**`, `query/**` | StrictMode shell, URL codecs, Query defaults and synchronous privacy lifecycle | U1-D | first/restored frame never exposes protected fixture bytes |

U1-R inspects the current live NotebookLM before token work. U1-D renders one coherent Eliot fixture at
1440 and 390, light/dark, long RU/EN and useful/loading/degraded states, records internal acceptance and
continues automatically. U1 connects no owner feature endpoint.

### U2 — fixture-complete product leaves

| ID | Write scope | Result | Depends on | Mandatory negative |
|---|---|---|---|---|
| U2-S | Sources fixture/pattern/story paths | Separate capture/conversion/admission/readiness/reader states | U1.2-U1.5 | admission cannot alter historical/current scope |
| U2-R | Research fixture/pattern/story paths | Question, polling progress, strict session snapshots, report/evidence states | U1.2-U1.5 | no-hit/budgets/snapshot/completion/acceptance remain distinct; no transcript |
| U2-T | Studio fixture/pattern/story paths | Saved report/Wiki/artifact states | U1.2-U1.5 | unavailable generators absent, not decorative disabled cards |
| U2-C | Connections fixture/pattern/story paths | Independent connection facts | U1.2-U1.5 | no Connected from health/configuration alone |
| U2-X | integrated fixture journey and receipts | Canonical viewport journey plus fresh-context independent audit | U2-S/R/T/C | keyboard/Back/long RU/narrow layout has no reparenting/nested scroll/trap |

U2-X uses a fresh-context tester for a no-hint project, source, question, exact evidence, supported artifact
and Connections recovery journey. It is an internal gate, not an owner stop.

### U3 — Sources real wiring

| ID | Scope | Depends on | Result / mandatory negative |
|---|---|---|---|
| U3-P | projects/library patterns/features/stories | C2-P, U2-S | Project/library/readiness/revisions; stale/foreign scope rejected |
| U3-I | import patterns/features/stories | C2-I, U2-S | Explicit capture/conversion/admission/recovery; no automatic bounds or scope mutation |
| U3-D | document patterns/features/stories | C2-D, U2-S | Exact reader/navigation/SafeMarkdown; no fabricated coordinates |
| U3-E | erasure patterns/features/stories | C2-E, U2-S | Partial/held/revoked destructive state never complete |

**U3-X:** serializes Sources roots/catalog and proves currentness, scope behavior, Back/focus, bundle, no direct
fetch and no legacy import.

### U4 — Research/evidence real wiring

| ID | Scope | Depends on | Result / mandatory negative |
|---|---|---|---|
| U4-R | run/progress/session patterns/features/stories | C3-R, U2-R | Polling owns progress; projection is explicit snapshot refresh only; no chat/history/replay |
| U4-M | report patterns/features/stories | C3-EM, U2-R | Manifest/lazy sections/export; failed required section blocks export |
| U4-E | evidence patterns/features/stories | C3-EC, U2-R | Citation/evidence/context; revoke/generation/coordinate mismatch fails closed |

**U4-X:** proves one durable run authority, strict projection union, expected history 410, canonical HTTP
reconciliation, lazy completeness, protected-state clearing and no hidden reasoning/transcript.

### U5 — Studio and Connections real wiring

| ID | Scope | Depends on | Result / mandatory negative |
|---|---|---|---|
| U5-S | Studio live patterns/features/stories | C3-S, U2-T | Only implemented actions; regenerate is not edit; COW typed |
| U5-C | Connections live patterns/features/stories | C3-C, U2-C | Server/session/grant/model/transport/client/run facts independent |

**U5-X:** serializes roots/catalog and proves unavailable products absent, no false connectivity and no secret
or provider payload disclosure. After U5-X, prepare the complete FINAL-UI owner review build. Do not enter U6
until the owner has reviewed the finished interface and separately authorized deployment/cutover work.

## 6. U6 deployment and rollback bridge

U6 is serialized ER-00/24/25/26 integration after U3-X/U4-X/U5-X and applicable client gates.

The current orchestrator deploys an attested prebuilt entrypoint with explicit legacy config. Prove exactly one
canonical Vite client+Worker path and extend the existing emitted/deployment/application-schema receipt family.
Do not rebuild after attestation or mix React assets with a separately built Worker.

Build one immutable retirement-safe legacy rollback artifact: accepted online behavior, no `/sw.js`
registration, no historical fetch/cache worker, exact retirement helper and permanent inert tombstone.

Negatives include stale redirect, wrong cwd/env, hidden rebuild, mixed graph, Worker-first route loss,
ResearchSession callable/history/upgrade SPA fallback, rollback byte mismatch/registration, restored
`eliotr-shell-v1`, controlled inbox before controller-null reload and protected bfcache paint.

U7 removes Astro production, legacy renderers/controllers/styles/client compatibility and later bounded rollback
artifact/command. It never removes or repurposes permanent inert `/sw.js`.

## 7. Stop conditions

A leaf stops when it needs an undelegated/shared/manager-gate path, absent endpoint/DTO/byte/projection contract,
second state/build/deploy authority, ambiguous currentness/replay/security semantics, unsupported binding or
unexecuted native/live proof.

The handoff names the exact blocker and smallest owner/gate. It never fills a gap with local schema, copied
decoder, fake fixture success, direct provider call, transcript or second deployment path. Routine compiler,
test, dependency, layout, accessibility or visual failures are repaired inside the authorized tranche and are
not reasons to ask the owner whether to continue.
