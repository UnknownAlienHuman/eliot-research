# ER-47: React owner web interface

**Slice:** owner-interface migration
**Packet completion dependencies:** none
**Coordination inputs:** accepted current ER-00 workspace/toolchain, ER-21 owner APIs and ER-24 Worker composition; their whole packets need not be complete.
**Scheduler input:** ER-49 static registry/checker before parallel leaves.
**Compatibility baseline:** ER-25 remains served until accepted cutover; it is not a completion prerequisite.
**Architecture:** [ADR-0016](../adr/0016-react-cloudflare-owner-ui.md) and
[ADR-0017](../adr/0017-owner-web-browser-runtime-and-tooling.md)
**Leaf dispatch:** [frontend-owner-execution-map.md](frontend-owner-execution-map.md)
**Autonomous manager:** [frontend-autonomous-manager-runbook.md](frontend-autonomous-manager-runbook.md)
**Design authority:** [OWNER_WEB_UI.md](../design/OWNER_WEB_UI.md)

**Status:** ownership reservation and execution contract only. Source implementation remains paused until the
owner authorizes a named U checkpoint or an autonomous tranche containing it.

Within an authorized tranche the manager continues through dependency-ready U checkpoints without repeated
owner prompts. Checkpoint claims, packet ownership, human gates and release/account restrictions remain exact.

The packet DAG is intentionally empty. Exact bootstrap, scheduler, client-family, visual-direction, feature
and cutover prerequisites live in the leaf execution map; unrelated/live ER-00/21/24 obligations do not block
the reservation.

## Objective

Replace the Astro-wrapped imperative presentation with one React/Vite owner workspace while preserving the
existing Worker, owner API, exact-evidence, authorization, replay, storage and completion authority.

The result must be visually coherent, accessible, responsive under real workloads and inspectable through
ordinary repository files/CLI. React owns presentation/browser lifecycle, not backend or Research authority.
A technically consistent but generic, chaotic or owner-unusable UI is a failed migration.

Progressive Research remains a product requirement. The UI may render bounded public stages, allowed tool
events, receipts, limitations and incremental report availability from polling or a separately accepted
versioned reader. Transport never becomes another run/mutation/completion authority and never exposes hidden
reasoning, raw prompts or provider payloads.

## Owned paths

- `apps/eliotr-web/**`
- `packages/ui/**`
- `tests/ui-owner/**`
- `scripts/ui-owner/**`
- `docs/agent-work/frontend-owner-claims/ER-47/**`

These paths are reserved to one ER-47 manager. Leaves receive exact checkpoints/paths from the execution map.
The manager serializes package-local manifests, barrels, route/query roots, catalog and handoffs. ER-49 owns
static definitions/checker; ER-47 cannot edit ER-48 claims or scheduler authority. ER-00 owns root registration
and root-command/CI integration.

## Read only unless explicitly delegated

- `apps/eliotr-pwa/**`
- `apps/eliotr-core/**`
- `packages/owner-api-client/**`
- `packages/pwa-http-client/**`
- `packages/pwa-source-workspace/**`
- `packages/pwa-research-workspace/**`
- `packages/contracts/**`
- `packages/domain/**`
- `docs/agent-work/frontend-owner-checkpoints.json`
- `docs/agent-work/frontend-owner-claims/ER-48/**`
- D1, R2, Queue, Workflow, Durable Object, MCP and provider code
- `apps/eliotr-core/wrangler.jsonc`
- root package, lockfile, TypeScript, lint, CI, deployment and receipt files

ER-47 must not import a legacy browser package root/subpath, wrap a `mount...Panel()` renderer, copy a wire
decoder, issue feature owner-API `fetch` calls or open an ad hoc SSE/WebSocket/Agents channel.

## Fixed architecture

1. React 19, strict TypeScript and restartable Strict Mode behavior.
2. Vite plus official Cloudflare plugin builds client and existing Worker input.
3. React Router owns navigable selection; product codecs decode URL values.
4. TanStack Query owns in-memory read lifecycle only; no private persistent cache.
5. `@eliotr/ui` is the sole token/primitive/product-pattern authority.
6. Native HTML semantics are preferred for simple controls; one qualified external composite primitive family
   is locked after U1. Component-by-component library mixing is prohibited.
7. Sources, Research, Studio and Connections are stable destinations; evidence is contextual.
8. One existing Worker remains the only deployable application.
9. React registers no service worker.
10. Feature visibility never exceeds implemented server capability/current authorization.
11. Polling is a valid initial progress transport; a future event reader requires ER-21/24 authority and the
    same durable run/readback semantics.
12. U1-R studies the current live NotebookLM and official Material 3 / M3 Expressive before token/shell
    decisions. U1-D is an internal rendered-composition gate; token swatches or component demos are insufficient.
13. The manager continues through U5-X and requests owner review only for the finished integrated interface.

## Build and repository bootstrap boundary

Target graph:

```text
Vite client + existing Worker input
→ generated client assets + Worker modules + output config
→ one attestation + deploy identity
```

The current orchestrator deploys an attested entrypoint with explicit `--no-bundle --config
wrangler.deploy.jsonc`, so it does not consume Vite redirected output automatically. U6 implements one
explicit bridge; Vite assets plus unchanged legacy deploy script is invalid.

U1.1a is package-local only. Before U1.1b, ER-00 B-U registers manifests in frozen lockfile, root TS
references, fail-closed boundaries/negative fixture and applicable test/budget scripts. Direct Vite/editor
success before B-U is non-authority evidence.

During U1-U5 legacy stays release-authoritative. Root build/deploy/CI/config/receipt changes remain serialized
ER-00/24/26 ownership.

Before cutover, U6 creates one immutable retirement-safe legacy rollback artifact through ER-25/00/24/26:
accepted online legacy behavior, no root `/sw.js` registration, no historical fetch/cache worker, exact
retirement helper and permanent inert `/sw.js` tombstone. Historical production bytes are not post-retirement
rollback.

## Scheduler and evidence boundary

Before ER-49 acceptance, at most one frontend leaf runs. Afterward:

- every source-edit commit is covered by exactly one active claim committed in a strict ancestor;
- same-commit claim plus source edit is invalid;
- one checkpoint has one active claim;
- all ER-47 active claims share one owner-authorized manager context;
- parallel checkpoints have disjoint canonical paths and structurally valid predecessor references;
- ER-49 proves syntax, scope and ancestry, not the semantic truth of a human approval or test receipt;
- manager/operator review remains responsible for accepting evidence.

ER-49 remains optional for parallelism. Sequential one-manager/one-leaf work may continue if scheduler
implementation would become a general workflow product.

## Local Cloudflare boundary

Ordinary integrated development uses:

```text
CLOUDFLARE_ENV=test
remoteBindings: false
```

A cross-platform preflight inspects normalized input/output and rejects wrong/unset environment, any
remote/production resource identity, unapproved Workers AI/Browser/provider effect, production route/domain/
deploy hook or credential.

Each binding is classified `LOCAL_SIMULATION | FIXTURE | REMOTE_NONPROD | PENDING`. Storybook uses deterministic
fixtures and no Worker plugin.

## Remote state, progressive events and page lifecycle

- Query functions consume `AbortSignal` and recheck route/session/lifecycle/deployment epochs after awaits.
- Protected keys include relevant principal/session epoch and deployment generation.
- Logout, auth loss, revoke, purge, generation change and `pagehide` cancel reads and remove protected Query/
  view data; invalidation alone is insufficient.
- Mutations use `retry:false`; uncertain retry preserves exact operation/body after readback.
- Credentials, grants, prompts and source/report/evidence bytes never enter URL or browser persistence.
- Unmount, poll stop or event-stream close is not server cancellation.
- Duplicate/reordered/missing/late/old-epoch progress events cannot advance completion.
- Disconnect is `DEGRADED`/`UNKNOWN` until readback; reconnect never creates/repeats a run.

One composition-root controller owns page lifecycle. A pre-existing non-private root mask/inert guard is set
synchronously on `pagehide` before React/Query cleanup; then the epoch closes, reads/polling abort, optional
realtime pauses and protected state is removed without mutation/retry.

Persisted `pageshow` remains masked from first paint until fresh no-store session/health/deployment
verification. Only then may routes read protected content and clear the guard. A later React commit is not
first-paint proof.

## Rendering and interaction safety

- No application `innerHTML`, HTML template renderer or unaudited `dangerouslySetInnerHTML`.
- One audited SafeMarkdown path; raw HTML disabled/tightly sanitized; citations use typed server identities.
- No selector/MutationObserver product state or live DOM reparenting. The root privacy guard is the narrow
  lifecycle-security exception and carries no product/private state.
- Each pane owns one native vertical scroll context; generic cards never scroll.
- Tables/code/excerpts may use named local horizontal scrolling.
- No feature-authored arbitrary colors, spacing, radius, shadow, motion or inline visual styles.
- Public progress exposes stages, receipts, allowed tool events and limitations, never hidden reasoning.
- Unknown, sampled, degraded, denied, stale and failed remain distinct.

## Live NotebookLM / Material reference

U1-R follows `frontend-notebooklm-material-reference.md`. The manager opens the current live NotebookLM in the
available authenticated browser, records actual layout/state/interaction observations, and uses current
Material 3 / M3 Expressive guidance. Eliot must preserve the clarity of the reference while improving exact
evidence, scope/currentness, dark/high-contrast, responsive and visual identity.

## Primitive, visual and performance qualification

U1 builds only what shell/U2 need. Primitive/pane candidates pass keyboard, focus, screen-reader, touch,
remount, responsive, CSP and performance tests; stable non-resizable panes beat a broken splitter.

U1-D is a manager-only internal visual-direction gate between harness qualification and shell assembly. It
renders one coherent canonical product state at 1440 and 390 in light/dark with long Russian and English
content, compares it to U1-R and current Material guidance, selects one direction and removes rejected
alternatives. A generic shadcn dashboard, copied NotebookLM chrome, attractive isolated components or green
pixel tests do not pass. The manager continues to U1.5 without owner interruption.

Visual evidence is layered: stories own states; a small app set owns 1440/1024/768/390 geometry; most browser,
high-contrast, reduced-motion and error coverage is functional/a11y. Screenshot count/bytes are budgeted.

Initial JS remains `<= 600 KiB gzip`. P1-P10 measure shell, lists, progressive updates, lazy reports, evidence,
panes, theme, authority clearing and bfcache. Memoization, virtualization, workers, generic chat state or global
stores require reproduced traces and before/after receipts.

`@ai-sdk/react` is not baseline. It may enter B-U only after an accepted event contract, measured bundle/value
and proof that Eliot identity, decoding, cancellation, disclosure/currentness and no-retry semantics remain.

## Required order

```text
ER-49 registry/checker
U1.1a → B-U → U1.1b → U1-R → U1.2 → U1.3 → U1.4 → U1-D → U1.5
→ U2-S/U2-R/U2-T/U2-C → U2-X
→ U3-P/U3-I/U3-D/U3-E → U3-X
→ U4-R/U4-M/U4-E → U4-X
→ U5-S/U5-C → U5-X
→ serialized U6 deployment + permanent tombstone + safe rollback
→ U7 legacy/rollback-artifact removal; inert `/sw.js` remains
```

Matching ER-48 client leaves/gates precede U3-U5. Feature leaves never edit shared route/query roots or
catalogs; U3-X/U4-X/U5-X are manager-only integrations.

U2-X uses a fresh-context tester who did not implement the screen: select/create a project, add/select a
source, ask a question, open exact citation/evidence, save/open a supported artifact and locate/fix one
Connections problem. Confusion, repeated backtracking or undiscoverable actions return to U2. After internal
acceptance, the manager continues through U3-U5; the owner reviews the finished U5-X interface.

## Mandatory negative case

Bind a dev/Preview candidate to a production resource and hold a protected response across logout, generation
change or `pagehide`. The binding gate rejects the resource, and epochs plus synchronous root guard prevent the
old response/tree from appearing, including first restored paint.

Additional negatives include malformed/generation-mismatched envelopes, sampled no-hit, missing coordinates,
false connectivity, lazy/export failure, CSP violation, legacy worker resurrection, rollback re-registration,
controlled inbox before controller-null reload, missing permanent tombstone, bfcache flash, nested scroll/
reparenting, progress gap/reorder/replay, render storms, unapproved generic visual direction, unusable owner
journey, duplicate/overlapping/stale-takeover claims and unregistered workspace packages escaping root gates.

## Verification

```text
ER-49 scheduler/history receipt + one manager context + valid prior claim
B-U root-registration + unknown-package negative
frozen install + root/scoped typecheck/lint
component/stories interaction/a11y/CSP
U1-R live-reference evidence + U1-D internal rendered-direction acceptance
Playwright route/keyboard/network/overflow/page-lifecycle/first-paint
fresh-context no-hint U2-X audit receipt
progress gap/reconnect/readback/no-run-replay
bounded visual + P1-P10
safe Vite/workerd + binding preflight
supported Preview or serialized staging
legacy behavior + safe rollback + inbox-controller + permanent tombstone
JS/CSS/font/Worker/rollback budgets
ordered release acceptance
```

A package-local build, claim, component, story, screenshot, benchmark, Explorer trace or Preview URL never
establishes repository integration, aesthetic acceptance or `LIVE_QUALIFIED`.

## Handoff

Produce one presentation stack. Post-retirement rollback serves only the exact safe legacy artifact and cannot
restore registration, old fetch/cache worker or `eliotr-shell-v1`. Permanent dual UI is prohibited. Final
handoff lists removed renderers/styles/controllers, migrated tests, worker/inbox/bfcache disposition, rollback
artifact retirement, permanent tombstone identity and exact build/deploy/rollback commands.
