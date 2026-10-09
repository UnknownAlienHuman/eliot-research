# Owner web platform migration — executable route

**Status:** accepted implementation plan; documentation-only at baseline
`517723e3ee41d208bbc1e1696ed23070000a0150`.
**Review:** 2026-10-08, pass 9.
**Runtime:** unchanged. `apps/eliotr-pwa` remains served; `apps/eliotr-core` remains the only Worker.
**Implementation stop:** remains until the owner authorizes a named checkpoint or autonomous tranche.

## 1. Authority and reading order

1. [frontend-owner-execution-map.md](../agent-work/frontend-owner-execution-map.md) — exact C/U/B/ER-49 DAG;
2. [frontend-autonomous-manager-runbook.md](../agent-work/frontend-autonomous-manager-runbook.md) — tranche continuation, defaults, review and stop rules;
3. [ADR-0016](../adr/0016-react-cloudflare-owner-ui.md) — platform/ownership decision;
4. [ADR-0017](../adr/0017-owner-web-browser-runtime-and-tooling.md) — CSP, permanent tombstone and bfcache;
5. [ER-47](../agent-work/ER-47-owner-web-interface.md) — React/UI manager;
6. [ER-48](../agent-work/ER-48-owner-api-client-extraction.md) — owner-client manager;
7. [ER-49](../agent-work/ER-49-frontend-leaf-scheduler.md) — static scheduler/claim-history validator;
8. [OWNER_WEB_UI.md](../design/OWNER_WEB_UI.md) — product/design authority;
9. stack validation, transport audit, agent harness, performance acceptance and cutover inventory.

A leaf reads its execution-map block, packet, one specialist section and exact source—not the whole frontend
corpus.

## 2. Why replacement is required

The current owner UI is a vanilla-TypeScript SPA packaged by Astro:

```text
index.astro → empty #app → HTML strings → imperative controllers/selectors/events/observers
             → live DOM movement → two competing global CSS generations
```

Another restyle preserves missing component ownership, selector/event coupling, DOM reparenting, nested
scroll, conflicting visual authority and poor agent inspectability.

The migration replaces presentation/browser lifecycle only. Worker/API, D1/R2, Workflows, exact evidence,
authorization, idempotency and completion authority remain.

## 3. Target and supplied-proposal disposition

```text
apps/eliotr-web
  React 19 + strict TypeScript + Vite
  React Router + in-memory TanStack Query
  @eliotr/ui + owner-api-client
             │ same-origin owner API
             ▼
apps/eliotr-core
  existing Worker + Assets/API/MCP/federation
  D1/R2/Queues/Workflows/DO/AI Search/AI Gateway
```

No second frontend service, Pages project, API Worker, database or generic agent state authority.

| Concern | Decision |
|---|---|
| View/build | React 19 + Vite 8 + official Cloudflare plugin |
| Navigation/reads | React Router SPA + memory-only TanStack Query |
| Styling/UI | Tailwind v4 syntax + one source-owned `@eliotr/ui` Material 3 system |
| Primitives | native semantics first; Base UI candidate vs React Aria for one external composite family |
| Review/tests | stable CSF catalog + Playwright + bounded visual receipts + explicit human gates |
| Progressive Research | polling/readback baseline; optional versioned public-event reader through ER-21/24 |
| Realtime | Agents SDK only for separately approved durable surface |

Retained from supplied proposal: React/Vite, progressive tool/result UI, citations and source-owned components.
Rejected/deferred: Hono rewrite, generic Vectorize-only RAG, raw chain-of-thought, generic chat authority,
immediate Tiptap and unimplemented generator grid. `@ai-sdk/react` is not baseline; it requires B-U review and
proof that Eliot identity/cancellation/replay/disclosure remain authoritative.

## 4. Ownership and scheduler

### ER-47

```text
apps/eliotr-web/**
packages/ui/**
tests/ui-owner/**
scripts/ui-owner/**
docs/agent-work/frontend-owner-claims/ER-47/**
```

### ER-48

```text
packages/owner-api-client/**
packages/pwa-http-client/**
packages/pwa-source-workspace/**
packages/pwa-research-workspace/**
docs/agent-work/frontend-owner-claims/ER-48/**
```

### ER-49

```text
docs/agent-work/frontend-owner-checkpoints.json
scripts/check-frontend-owner-checkpoints.mjs
scripts/test-frontend-owner-checkpoints.mjs
```

Existing owners retain root integration (ER-00), API (ER-21), Worker composition (ER-24), served legacy/safe
rollback preparation (ER-25), deploy (ER-26) and integration evidence (ER-27).

ER-47/48/49 have empty coarse dependencies. Exact dependencies are leaf/external gates.

Before ER-49: one frontend manager + one leaf maximum. After ER-49:

- every source-edit commit has exactly one active covering claim in its parent tree;
- a claim-introduction commit is a strict ancestor of covered source edits; same-commit claim+source fails;
- one checkpoint ID has one active claim;
- one owner-authorized manager context per packet;
- parallel IDs are dependency-ready with disjoint exact paths;
- predecessor refs name checkpoint and reachable ancestor commit; manager/external gates also name an approval
  reference;
- ER-49 validates structure/scope/ancestry, not whether a human approval or test result is substantively true;
- blocked/abandoned/superseded claims remain append-only and replacement needs owner-authorized handoff.

ER-49 is an optimization for safe parallelism. If it becomes a general workflow system, stay sequential.
Claims/branches do not lift implementation stop or establish readiness.

## 5. Repository bootstrap gates

Workspace globs do not establish root integration. Root TS references, boundary allowlists, lockfile, scripts,
tests, budgets and CI remain explicit ER-00 authority.

### B-C — owner-client registration

```text
C0.1/C0.2 + C0.4 package-local skeleton
→ frozen lock/root TS/boundary/negative registration
→ C1
```

Unknown workspace source package must fail closed instead of being skipped.

### B-U — owner-web/UI registration

```text
U1.1a package-local manifests/config + exact dependency proposal
→ frozen tuple/root references/boundaries/tests/budgets
→ U1.1b
```

Package-local typecheck or direct Vite build before B-C/B-U is diagnostic only.

## 6. Safe local Cloudflare profile

Ordinary integration uses:

```text
CLOUDFLARE_ENV=test
remoteBindings:false
```

Preflight rejects wrong environment, `remote:true`, production resources/routes/domains/hooks/credentials and
unapproved Workers AI/Browser/provider effects. Bindings are labeled:

```text
LOCAL_SIMULATION | FIXTURE | REMOTE_NONPROD | PENDING
```

Assets/D1/R2/Queues/DO/Workflows use local simulation where supported; Workers AI, Vectorize and AI Search use
fixtures or separately approved non-production profile. Storybook has no Worker plugin. Local Explorer is
after preflight only.

## 7. Browser state, exact bytes, progressive events and content safety

- Queries consume `AbortSignal` and recheck route/session/lifecycle/deployment epochs.
- Logout/auth loss/revoke/purge/generation change/pagehide cancel and remove protected state.
- No persisted private Query/service-worker/browser-database cache.
- Mutations never auto-retry; uncertain retry preserves operation/body and reconciles through readback.
- No HTML-string renderer, selector/MutationObserver product state or live DOM reparenting.
- One audited SafeMarkdown path; typed citations; native pane scrolling.
- Exact range bytes require admitted revision/object identity, strong validator, endpoint-approved conditional,
  single range, untransformed representation and post-read digest/currentness recheck. Otherwise use bounded
  whole-object read.
- Public progress shows bounded stages/tool events/receipts/limitations, never prompts/provider payloads/hidden
  reasoning.
- Polling is valid. Event readers need strict version/frame/rate/sequence/resume/currentness bounds and
  authoritative readback after gaps/reconnect. Reconnect creates no run or mutation.
- React and rollback register no service worker.
- Synchronous non-private root guard masks pagehide/bfcache before React cleanup; pageshow remains masked from
  first paint until fresh verification.
- Static SPA claims no imaginary nonce; actual dependencies must pass CSP.

## 8. Evidence layers

| Layer | Establishes | Does not establish |
|---|---|---|
| stories | component states/interactions | Worker/API behavior or product design acceptance |
| fixture app | route/product UX | platform conformance or owner usability by itself |
| local Vite/workerd | same-origin local integration | deployment |
| safe Preview | supported isolated deploy paths | Queue consumer/full Workflow/external effects |
| serialized staging | Queue/Workflow/Access/OAuth/provider behavior | production acceptance |
| production | exact release canary | unexecuted quality claims |

No screenshot, benchmark, MCP response, Explorer trace or Preview URL alone is completion.

## 9. Ordered implementation

### ER-49

Create static definitions/checker/tests. Reject bad IDs/DAG/scope/path, manager-gate misuse, foreign/future
predecessors, multiple managers, duplicate/overlapping claims, incomplete history, same-commit claim+source,
unclaimed/out-of-scope source edits, claim rewrite/deletion and unauthorized takeover.

### C0 → B-C → C1

```text
C0.1 inventory
C0.2 transport characterization
C0.3 source/research characterization
C0.4 package-local skeleton
B-C root registration
C1 path/headers/body/problem/range-validator/client/session + legacy auth adapter
```

### U1.1a → B-U → U1.1b → U1-R → U1.2 → U1.3 → U1.4 → U1-D → U1.5

- exact package/config and dependency proposal;
- root registration/frozen tuple;
- sibling Worker build and normalized config parity;
- **U1-R:** current live NotebookLM browser study plus official Material 3 / M3 Expressive reference matrix;
- provisional deterministic tokens;
- minimum native-first controls and one external composite family;
- catalog/design/binding/Storybook/Playwright/visual/performance harness + ER-49 invocation;
- **U1-D:** internal coherent desktop/phone, light/dark, long RU/EN direction acceptance;
- StrictMode shell, URL codecs, Query defaults and first-paint lifecycle mask.

No owner feature endpoint is connected in U1. Token swatches, isolated components, generic shadcn layout or
agent self-approval do not pass U1-D.

### U2 fixture leaves

```text
U2-S Sources fixtures
U2-R Research/progress/report/evidence fixtures
U2-T Studio fixtures
U2-C Connections fixtures
→ U2-X integrated fixture journey + no-hint owner walkthrough
```

U2-X uses a fresh-context independent tester for project/source/question/exact-evidence/artifact/Connections
recovery. Confusion, repeated backtracking or accidental scope changes return to U2. After internal acceptance,
the manager continues through U3-U5 without owner interruption.

### C2 Sources client leaves

```text
C2-L projects/library/selection
C2-R readiness/revisions
C2-N namespaces
→ manager gate C2-P
C2-I import/recovery
C2-D exact document/navigation/range representation
C2-E erasure
```

Each claim names exact legacy compatibility files and leaves one maintained decoder.

### C3 Research/Evidence/Studio/Connections client leaves

```text
C3-RC configuration
C3-RR runs/status/control
C3-RP optional public-progress reader
C3-RH history/changes
→ manager gate C3-R

C3-EM report manifest/sections/export
C3-EC citations/exact evidence
→ manager gate C3-E

C3-S Studio/Wiki/artifacts
C3-C Connections
```

If no server event contract exists, C3-RP closes `NOT_APPLICABLE` and polling remains.

### U3 Sources real wiring

```text
U3-P projects/library/readiness/revisions
U3-I import/recovery
U3-D exact reader/navigation
U3-E erasure
→ manager-only U3-X route/query/catalog/integration gate
```

U3-X proves currentness, Back/focus, immutable byte representation, bundle and no direct fetch/legacy import.

### U4 Research/evidence real wiring

```text
U4-R composer/run/control/progress
U4-M manifest/lazy sections/export
U4-E citations/exact evidence
→ manager-only U4-X route/query/catalog/integration gate
```

U4-X proves one durable run authority, progress/readback reconciliation, bounded 40-section behavior, export
completeness, protected-state clearing and no hidden reasoning.

### U5 Studio/Connections real wiring

```text
U5-S implemented Studio/Wiki/artifact actions
U5-C truthful Connections facts
→ manager-only U5-X route/query/catalog/integration gate
```

Unavailable products are absent; health never proves Connected.

### U6 canonical build, staging and safe rollback

U6 is serialized ER-00/24/25/26 integration after U3-X/U4-X/U5-X.

Choose one production bridge:

1. attest/deploy exact Vite output without rebuild; or
2. pin redirected output and deploy from exact build root without legacy `--config`.

Reject stale redirect/wrong cwd/environment mismatch/hidden configuration/rebuild/graph mismatch.

Before switching, build one attested rollback artifact:

```text
accepted legacy behavior
- root service-worker registration
- historical fetch/cache worker
+ exact inbox/owner retirement helper
+ permanent inert /sw.js tombstone
```

U6 owns inbox relocation/controller-null recovery, permanent no-fetch/non-claiming tombstone, first-paint
bfcache/header acceptance, safe Preview, external staging, switch and rollback without rebuild. Historical
service-worker-registering build is not rollback.

### U7 legacy and rollback-artifact removal

After accepted U6:

- remove Astro from production and later remove bounded rollback artifact/command;
- remove legacy controllers/renderers/global styles/compatibility exports after disposition;
- update budgets/diagrams/status/runbooks;
- retain `/sw.js` permanently as inert no-cache tombstone for long-dormant registrations.

Permanent dual UI is prohibited.

## 10. Verification

```text
work-packets + docs index
ER-49 DAG/claim/source-history/recovery mutation tests
B-C/B-U frozen root-registration evidence
scoped/root TS/ESLint/tests
stories interaction/a11y/CSP
U1-D rendered direction + owner approval
Playwright route/keyboard/network/overflow/page lifecycle/first paint
U2-X no-hint owner walkthrough
range validator/representation/currentness negatives
progress gap/reconnect/readback/no-run-replay
bounded visual + P1-P10
safe Vite/workerd config parity
supported Preview or serialized staging
legacy behavior + no-registration rollback + inbox controller + permanent tombstone
client/CSS/font/Worker/rollback budgets
pnpm check:full + S92/S94/S93/S95/S96/S97
```

Unexecuted checks remain `PENDING`.

## 11. Completion

Complete only when:

- one React workspace and one side-effect-free owner client serve accepted loop;
- one exact Vite graph contains client and existing Worker;
- normal dev cannot reach production effects;
- one UI authority passes CSP/a11y after U1-R and internal U1-D acceptance;
- fresh-context U2-X passes and the owner later reviews the complete U5-X interface;
- exact bytes bind to immutable admitted representation;
- protected state cannot reappear late or on first restored paint;
- progressive UI preserves one durable run/readback authority;
- ER-49 temporal claims make parallel work mechanical or sequential mode remains explicit;
- B-C/B-U/deploy bridge bind repository/release identities;
- permanent inert tombstone, controller-null inbox recovery and exact safe rollback pass;
- budgets/full release gates pass.

After PR #329 is merged, durable Issue #335 authorizes F1-F4 source implementation through U5-X in one manager
program. This plan does not authorize final merge, deployment, provider/account mutation, cutover or legacy
removal.
