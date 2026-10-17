# ER-47: React owner web interface

**Slice:** owner-interface migration
**Packet completion dependencies:** none
**Coordination inputs:** accepted current ER-00 workspace/toolchain, ER-21 owner APIs and ER-24 Worker composition; their whole packets need not be complete.
**Coordination:** current refactor work follows ADR-0019 and the owner-web execution map; ER-49 is historical audit material.
**Compatibility baseline:** ER-25 remains served until accepted cutover; it is not a completion prerequisite.
**Architecture:** [ADR-0016](../adr/0016-react-cloudflare-owner-ui.md) and
[ADR-0017](../adr/0017-owner-web-browser-runtime-and-tooling.md)
**Leaf dispatch:** [frontend-owner-execution-map.md](frontend-owner-execution-map.md)
**Autonomous manager:** [frontend-autonomous-manager-runbook.md](frontend-autonomous-manager-runbook.md)
**Material UI procedure:** [frontend-material-agent-playbook.md](frontend-material-agent-playbook.md)
**Design authority:** [OWNER_WEB_UI.md](../design/OWNER_WEB_UI.md)

**Status:** historical feature and acceptance contract. Current refactor tasks are assigned by the manager from
the implementation router; no named U checkpoint or claim is a prerequisite.

The manager uses one checkout, assigns exact paths and keeps parallel work disjoint. The manager serializes shared
composition points. Product acceptance below remains applicable where selected work touches it; deployment,
cutover and account or production actions retain their separate authorization boundaries.

The historical packet DAG is empty. The execution map preserves product acceptance; the current implementation
router and manager assignment determine task order and scope. Existing ER-00/21/24 contracts remain owned by
their current owners and are consulted when the selected work touches them.

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

These are the historical ER-47 ownership paths. Current assignments use the implementation router and manager's
exact-path task scope. Parallel tasks may edit disjoint paths; serialize package manifests, barrels, route/query
roots, catalog and handoffs. ER-49's registry/checker and claim files are optional historical audit material.
Root registration and root-command/CI integration remain with their current owners.

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

These are shared integration homes, not permanent packet locks. The manager may assign their exact paths
under the current authorized router, including preparation of the build bridge and rollback before review.
Serialize those edits with other tasks; actual deploy/cutover still needs its action authorization.

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

Compile and lint the affected scope during implementation. Root registration, lockfile, TypeScript references,
boundaries and scripts are integrated by the current owner when needed; a package-local build is not final
integration evidence. Tests and browser/UI acceptance run after assembly, not after every edit.

During U1-U5 legacy stays release-authoritative. Prepare and verify root build/deploy/CI/config/receipt
integration before the finished review build; the manager serializes these shared ER-00/24/26 homes.

During preparation, create one immutable retirement-safe legacy rollback artifact through the existing
ER-25/00/24/26 homes, before FINAL-UI and actual cutover:
accepted online legacy behavior, no root `/sw.js` registration, no historical fetch/cache worker, exact
retirement helper and permanent inert `/sw.js` tombstone. Historical production bytes are not post-retirement
rollback.

## Scheduler and evidence boundary

Use one manager checkout. Parallel tasks are allowed only for disjoint exact paths; the manager serializes shared
files and integrates the result. No JSON claims, Git ancestry, ER-49 acceptance or leaf caps are required for
current work. The old checker can be run as an optional historical audit and does not validate product behavior.

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
- Protected keys include the authenticated principal/session epoch.
- Logout, auth loss, revoke, purge, principal change and `pagehide` cancel reads and remove protected
  Query/view data; invalidation alone is insufficient. Deployment-generation change alone does not clear owner
  data: preserve the draft and last known read with stale indication and retry, as defined by ADR-0018.
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

`@ai-sdk/react` is not baseline. It may enter only after an accepted event contract, measured bundle/value
and proof that Eliot identity, decoding, cancellation, disclosure/currentness and no-retry semantics remain.

## Required order

The labels below preserve the former UI sequence as a useful map of product acceptance. They are not a claim,
checkpoint or implementation prerequisite. For current assignments, use the implementation router. Keep shared
route/query roots and catalogs serialized with the manager; test the integrated journey after assembly.

U1-R/U1-D visual direction → U2-X no-hint journey → feature wiring and integrated bridge/rollback preparation
→ U5-X integrated review → FINAL-UI owner review → authorized U6 deployment/cutover → code retirement
within the authorized refactor after rollback obligations are satisfied.

U2-X uses a fresh-context tester who did not implement the screen: select/create a project, add/select a
source, ask a question, open exact citation/evidence, save/open a supported artifact and locate/fix one
Connections problem. Confusion, repeated backtracking or undiscoverable actions return to U2. After internal
acceptance, the manager continues through U3-U5; the owner reviews the finished U5-X interface.

## Mandatory negative case

Bind a dev/Preview candidate to a production resource and hold a protected response across logout, principal
change or `pagehide`. The binding gate rejects the resource, and epochs plus synchronous root guard prevent the
old response/tree from appearing, including first restored paint. Across deployment-generation renewal, retain
the owner draft/last read as stale, accept prior-generation owner reads and reconcile without replaying writes.

Additional product/security checks include malformed strict mutation/evidence envelopes, sampled no-hit, missing coordinates,
false connectivity, lazy/export failure, CSP violation, legacy worker resurrection, rollback re-registration,
controlled inbox before controller-null reload, missing permanent tombstone, bfcache flash, nested scroll/
reparenting, progress gap/reorder/replay, render storms, unapproved generic visual direction, unusable owner
journey and unregistered workspace packages escaping root gates. Claim-history negatives belong only to optional
ER-49 audit; additive owner read fields and previous deployment-generation reads follow ADR-0018.

## Verification

```text
During implementation: scoped TypeScript compilation and lint for changed code.
After assembly: applicable component/API/client tests, U1-R/U1-D, browser/Playwright and accessibility checks,
U2-X journey, progress readback/no-run-replay, visual/security/CSP/performance checks and local binding preflight.
Before U6: supported deploy-path, legacy behavior, safe rollback, inbox/controller and permanent tombstone acceptance.
At release: remaining ordered release acceptance. Record unrun checks as PENDING; do not run browser/tests for every edit.
```

A package-local build, claim, component, story, screenshot, benchmark, Explorer trace or Preview URL never
establishes repository integration, aesthetic acceptance or `LIVE_QUALIFIED`.

## Handoff

Produce one presentation stack. Post-retirement rollback serves only the exact safe legacy artifact and cannot
restore registration, old fetch/cache worker or `eliotr-shell-v1`. Permanent dual UI is prohibited. Final
handoff lists removed renderers/styles/controllers, migrated tests, worker/inbox/bfcache disposition, rollback
artifact retirement, permanent tombstone identity and exact build/deploy/rollback commands.
