# ADR-0016: React/Vite owner workspace and agent-visible UI development

- **Status:** accepted for owner-directed migration planning; source implementation remains paused until an
  explicit owner instruction names a checkpoint.
- **Date:** 2026-10-08.
- **Baseline reviewed:** `517723e3ee41d208bbc1e1696ed23070000a0150`.
- **Review pass:** 9 — owner-approved visual direction, owner usability, temporally enforced leaf claims,
  immutable byte-range representation, governed progressive UI, explicit bootstrap handoffs, permanent inert
  tombstone, no-registration rollback and attested Vite deployment bridge.
- **Ownership:** ER-47 presentation/claims; ER-48 owner-client/claims; ER-49 static scheduler/checker; ER-25
  served compatibility and bounded retirement-safe rollback preparation.
- **Runtime authority:** unchanged. Existing Worker, owner API, Access, D1/R2, Queues, Workflows, Durable
  Objects, AI Search, MCP and federation remain authoritative.

## Context

The owner application is nominally built by Astro, but Astro does not compose the product UI. An empty `#app`
is filled by imperative TypeScript HTML strings, selector-discovered controllers, global events, observers and
live DOM movement. Two global stylesheet generations compete for shell/panel/control behavior.

This is a legacy vanilla SPA packaged by Astro, not a component application. Further restyling preserves weak
component ownership, selector/event coupling, DOM reparenting, nested scroll and conflicting visual authority.
Eliot already has substantial backend/exact-evidence authority; it needs a coherent client, not a second
backend.

A component library and token file alone do not guarantee good design. The migration also needs an early
rendered visual-direction gate and direct owner acceptance of the primary loop; otherwise agents can build a
mechanically consistent but still generic or unusable interface.

## Decision

### 1. Target frontend

Create `apps/eliotr-web` with:

- React 19, strict TypeScript and Strict Mode;
- Vite 8 plus official `@cloudflare/vite-plugin`;
- React Router as client navigation, not SSR/backend;
- TanStack Query for in-memory read lifecycle only;
- Tailwind v4 as token-consuming syntax;
- one source-owned `@eliotr/ui` Material 3 product authority;
- stable Storybook CSF/catalog and Playwright acceptance.

Native HTML semantics are preferred for ordinary controls. Base UI is the starting shadcn-style composite
candidate; React Aria is a bounded comparison/fallback. U1 locks one external composite primitive family after
keyboard/focus/screen-reader/touch/CSP/browser tests. This does not justify wrapping correct native semantics.
A pane splitter stays behind `@eliotr/ui`; stable non-resizable panes are accepted when qualification fails.

The browser calls only the existing same-origin owner API through ER-48 and receives no Cloudflare binding,
provider credential, database authority or second authentication implementation.

Progressive Research remains a requirement, but not a mandate for one library/transport. Polling/status/
readback is the accepted baseline. A future versioned SSE/stream/Agents reader may accelerate public stages,
allowed tool events and report availability for one existing run identity. It cannot create/repeat a run,
mutate, establish completion or expose hidden chain-of-thought, prompts or provider payloads.

### 2. One Worker and one build identity

```text
React SPA
  │ same-origin HTTPS / separately approved public-event channel
  ▼
apps/eliotr-core
  ├── static assets + owner API
  ├── MCP/federation
  ├── D1/R2/Queues
  ├── Workflows/DO
  ├── AI Search/Workers AI/AI Gateway
  └── Access/observability
```

The Vite plugin receives existing Worker config through explicit `configPath` and emits client assets, Worker
modules and output configuration. Input Wrangler config, redirected deploy record and output config are
distinct identities.

The current deploy orchestrator uses an attested entrypoint with explicit `--no-bundle --config
wrangler.deploy.jsonc`; that bypasses Vite redirected output. U6 chooses exactly one bridge:

1. attest/deploy exact Vite output directly without rebuilding; or
2. pin redirected output and deploy from exact build root without legacy config override.

A Vite client build followed by unchanged legacy deploy is invalid. No second service, Pages project, API
Worker or database is introduced.

### 3. Safe local Cloudflare profile

Ordinary integrated development uses both:

```text
CLOUDFLARE_ENV=test
remoteBindings:false
```

A cross-platform preflight rejects wrong environment, remote/production resources, production routes/domains/
hooks/credentials and unapproved Workers AI/Browser/provider effects. Every binding is classified
`LOCAL_SIMULATION | FIXTURE | REMOTE_NONPROD | PENDING`. Storybook uses fixtures and no Worker plugin.

Worker Preview is not universal. D1/R2/KV/AI Search/Queue producers require dedicated non-production
resources; Workflow bindings target deployed workflow; Preview Workers cannot qualify Queue consumption;
service bindings do not automatically route to matching Previews. Unsupported paths use local fixtures or
serialized staging.

### 4. Ownership, scheduler and bootstrap

ER-25 stays served until cutover and is a compatibility baseline, not a completion prerequisite.

ER-47 and ER-48 are manager/reservation packets with empty coarse dependencies. ER-49 owns only static
checkpoint definitions/checker/tests. Managers own separate claim directories and cannot edit the registry or
each other's claims.

ER-49 validates structure, scope and Git history—not semantic truth:

- IDs/DAG and packet containment;
- canonical exact paths and manager-only/external gates;
- one manager context per packet and one active claim per checkpoint;
- disjoint active paths;
- predecessor checkpoint relationship and ancestor commit references;
- claim introduction as a strict ancestor of covered source edits;
- exactly one active covering claim in the parent of every leaf source commit;
- append-only handoff/recovery history.

Human/operator review still establishes that owner authorization is authentic, manager/external-gate approval
is valid and tests really passed. A claim/receipt cannot certify itself.

Before ER-49, maximum concurrency is one frontend manager plus one leaf. ER-49 is an optimization for safe
parallelism, not a product prerequisite; if it grows into a workflow engine/database/service, remain sequential
rather than building another product.

Direct main is default. The owner may authorize one manager worktree/review branch for a named packet/PR;
leaf agents create no additional branch/worktree/package root/manifest/barrel/route root/shared fixture. A
manager context or claim does not lift the implementation stop or authorize merge/deploy/account mutation.

Workspace globs do not establish root integration. ER-00 retains lockfile, root TS/test/lint/boundary/budget/
CI authority:

- C0.4 creates package-local owner-client skeleton;
- B-C registers it before C1;
- U1.1a creates package-local web/UI manifests/config and dependency proposal;
- B-U registers them/frozen tuple before U1.1b;
- package-local compilation before B-C/B-U is diagnostic only;
- unknown workspace source packages fail closed rather than being skipped.

### 5. Executable decomposition

```text
ER-49
C0 → B-C → C1
U1.1a → B-U → U1.1b → U1.2 → U1.3 → U1.4 → U1-D → U1.5
U2-S/R/T/C → U2-X

C2-L/R/N → C2-P; C2-I/D/E
C3-RC/RR/RP/RH → C3-R
C3-EM/EC → C3-E
C3-S/C

U3-P/I/D/E → U3-X
U4-R/M/E → U4-X
U5-S/C → U5-X
U6 deployment/retirement/safe rollback
U7 legacy + rollback-artifact removal; inert /sw.js remains
```

Feature leaves edit disjoint feature/pattern/story paths. Manager gates serialize route/query roots, catalog
entries and cross-feature browser acceptance. Missing DTO/route/event/byte-representation contract returns the
smallest handoff to ER-21/24; it never authorizes client-local schema or invented stream.

### 6. Visual direction and owner usability

U1-D is a manager-only gate after harness/primitive qualification and before production shell assembly. It
renders one coherent canonical state at desktop and phone widths, light/dark, long Russian/English and useful/
loading/degraded states. Owner-visible approval locks typography, density, tonal surfaces, navigation, pane
proportions, primary action hierarchy and token/primitive language.

Token swatches, isolated attractive components, generic shadcn/admin output, copied NotebookLM chrome, agent
self-approval or automatic baseline update cannot pass U1-D. Rejected alternatives are removed; later
shell-level changes require renewed explicit approval.

U2-X includes a no-hint owner walkthrough of the primary loop: project, source, question, exact evidence,
supported artifact and one Connections recovery. Confusion, repeated backtracking, accidental scope change or
undiscoverable controls return to U2. Automated clicks cannot replace owner usability acceptance.

### 7. Astro and rollback disposition

Astro is frozen for ordinary product evolution. No new design system, navigation shell, panel system, global
CSS layer or feature renderer belongs in legacy. Only bounded security/privacy/data-loss/release-blocking
repairs are allowed.

U6 builds/attests a retirement-safe legacy rollback artifact preserving accepted online behavior while
removing unconditional root `/sw.js` registration, never restoring old fetch/cache worker and including exact
browser-local retirement helpers. It is removed after rollback support window. Historical service-worker-
registering production artifact is not rollback.

### 8. Backend/router, MCP and Agents SDK

Hono is not part of this migration. It is an optional router, not source of Worker support; replacing routing
while replacing presentation combines unrelated migrations. Next/vinext, TanStack Start, React Router
full-stack and RSC are excluded.

Cloudflare Agents SDK is capability-scoped only: separately approved durable realtime/chat/RPC surface.
Ordinary reads/mutations remain strict owner API; governed Research remains Workflow/D1/receipt authority; MCP
remains authenticated boundary; canonical D1 state is not duplicated into generic agent state.

`@ai-sdk/react`/generic chat ownership is not baseline. It may enter B-U only after accepted event contract,
measured bundle/lifecycle value and proof that Eliot identity, strict decoding, cancellation, disclosure and
no-retry semantics remain.

### 9. Design-system decision

`packages/ui` owns Eliot Material 3 semantic roles, typography, spacing, shape, elevation, motion and density.
The catalog is allowed vocabulary, not permission to build an enterprise kit without consumers.

Material UI v9 is current, not rejected as obsolete. It is not selected because Emotion/`sx` creates a second
styling runtime, Eliot still needs its own semantic/product layer, governance would duplicate, and source-owned
primitives give tighter CSP/bundle/behavior control. Advanced MUI X surfaces are unnecessary, commercial or
alpha for baseline.

Feature code invents no local buttons/cards/colors/radii/shadows/scroll physics/status semantics. Native
scrolling/platform scrollbars are default.

### 10. Browser runtime, permanent tombstone and bfcache

React registers no service worker. Historical root `/sw.js` registration and `eliotr-shell-v1` require exact
update/unregister/readback migration.

`/sw.js` remains permanently as tiny no-cache inert tombstone:

- install `skipWaiting()`;
- activate deletes only enumerated legacy caches;
- no `clients.claim()`;
- no fetch handler;
- no current/rollback app registers it;
- long-dormant registrations can update later;
- URL is not reused for functional worker.

Standalone inbox stays fail-closed while a controller exists and uses exact browser-local update/unregister/
readback/reload. Only controller-null reload enables it.

Static Workers Assets cannot assume per-response nonce. Primitive/pane/Markdown dependencies run under actual
CSP; broad script/style weakening rejects dependency/mode.

On `pagehide`, one composition-root controller synchronously sets a pre-existing non-private root privacy mask
before React/Query cleanup. Persisted `pageshow` stays masked from first paint until fresh no-store session/
health/deployment verification; old responses cannot repaint private content.

### 11. Client-state, exact bytes and content rules

- Query functions consume signals and recheck route/session/lifecycle/generation after awaits.
- Protected keys carry principal/session/deployment epochs.
- Logout/auth loss/purge/revoke/generation/pagehide cancel and remove protected data; invalidation is
  insufficient.
- No persistent Query/private worker/database cache.
- Mutations never auto-retry; uncertain retry preserves exact operation/body/readback.
- Unmount/poll stop/stream close is not server cancellation.
- Duplicate/reordered/gapped/late progress cannot advance completion; reconnect never creates run.
- Exact byte ranges require one immutable admitted representation: exact revision, strong validator,
  endpoint-approved conditional, no multipart or transformed representation, and feature digest/currentness
  recheck. Otherwise use bounded whole-object read.
- No application HTML-string renderer, selector product state or live DOM reparenting.
- One audited SafeMarkdown path and typed citations.
- One native vertical scroll owner per pane.
- Unknown/sampled/stale/degraded/denied/failed remain distinct.
- Public stages/tool events/receipts/limitations are allowed; hidden reasoning is not.

### 12. Evidence and performance

Repository source, stable stories, catalog/registry, deterministic scenarios, Playwright traces/screenshots and
receipts are authoritative. MCP integrations are optional accelerators.

Visual evidence is layered, not combinatorial. Initial JS remains `<= 600 KiB gzip`. P1-P10 cover shell,
lists, progressive updates, lazy reports, evidence, panes, theme, authority clearing and bfcache. Optimization
requires reproduced traces and retained before/after evidence.

A receipt's presence is not proof of truth. Review binds it to exact build/environment and verifies semantic
claims. U1-D owner approval and U2-X owner walkthrough are explicit human gates alongside automation.

## Migration and completion

U0 freezes legacy/ownership. ER-49 enables safe parallelism. B-C/B-U bind package-local skeletons to root
authority. U1 proves stack/foundation and visual direction. U2 proves fixture UX and owner usability. Parallel
client/UI leaves plus manager gates deliver U3-U5. U6 builds/attests Vite graph and safe rollback, performs
permanent tombstone retirement, staging, switch and rollback. U7 removes Astro/product legacy and later
rollback artifact; `/sw.js` remains inert compatibility endpoint.

Permanent dual UI is prohibited.

Complete only when:

- one React workspace and one side-effect-free owner client serve accepted loop;
- one attested Vite graph contains client and existing Worker;
- ordinary dev cannot reach production effects;
- one UI authority passes CSP/a11y and U1-D approval;
- owner completes U2-X primary loop without hidden guidance;
- protected state cannot resurrect late or on first restored paint;
- exact byte reads bind to immutable admitted representation;
- progressive UI preserves one durable run/readback authority;
- ER-49 temporal claims/recovery make parallel work mechanically safe or sequential mode remains explicit;
- B-C/B-U/deploy bridge bind repository/release identities;
- permanent inert tombstone, controller-null inbox recovery and exact safe rollback pass;
- budgets/full release gates pass.

## Non-goals and pending proof

No backend rewrite/new database/generic Vectorize replacement/change to evidence/scope/idempotency/completion.
This ADR authorizes no source implementation, dependency installation, merge, deployment or account mutation.

Exact dependency resolution, B-C/B-U, ER-49 checker, U1-D/U2-X execution, immutable range contract, build graph,
event contract, CSP/browser behavior, safe rollback, permanent tombstone responses and deploy bridge remain
executable gates, not claims established by this ADR.

## Continuous owner authorization amendment — 2026-10-09

The owner has explicitly authorized one manager to execute F1-F4 continuously through U5-X. U1-R live
NotebookLM study is mandatory. U1-D and U2-X are internal quality gates, not owner stop points. Any earlier
sentence requiring owner approval at U1-D or an owner walkthrough at U2-X is superseded. The first required UI
review is the finished integrated interface after U5-X. Final merge, deployment, account mutation, cutover and
legacy removal remain separately authorized.
