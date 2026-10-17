# ER-47 — React owner workspace rules

`apps/eliotr-web` is the React/Vite target UI. `apps/eliotr-pwa` remains served compatibility until the
authorized cutover. Use the compact implementation authority in [ADR-0019](../../docs/adr/0019-compact-refactoring.md)
and [the current router](../../docs/implementation/backend-entrypoints.md). The historical ER-47/48/49 packet
and claim files do not gate current implementation.

## Read before editing

A manager reads `docs/agent-work/frontend-material-agent-playbook.md` and
`docs/agent-work/frontend-autonomous-manager-runbook.md`. Each task receives exact paths, relevant contracts,
acceptance evidence and scoped commands. Parallel tasks may touch disjoint paths only; the manager serializes
shared roots, manifests, routes, barrels, fixtures and handoffs. A task reads only relevant sources:

1. exact task scope in the current implementation router;
2. the applicable sections of `docs/agent-work/frontend-material-agent-playbook.md`;
3. `docs/agent-work/ER-47-owner-web-interface.md`;
4. `docs/agent-work/frontend-notebooklm-material-reference.md` for U1-R and rendered-product review;
5. `docs/agent-work/frontend-current-contract-amendment-2026-10-09.md` when relevant;
6. affected catalog/story/scenario and exact client/DTO contract;
7. directly relevant implementation sources.

Do not create new JSON claims or ancestry receipts. The old registry/checker/claims are optional historical audit
material only; they do not replace task authorization or code review.

Conditional references:

| Work | Reference |
|---|---|
| Vite/build/local binding | `frontend-stack-validation-2026-10-08.md` |
| U6 build/deploy/rollback | `frontend-cutover-inventory-2026-10-08.md` |
| CSP/service worker/bfcache | ADR-0017 |
| owner API/query/projection | ER-48 + exact client family |
| product/tokens/U1-D/U2-X | `OWNER_WEB_UI.md` + `frontend-agent-harness.md` |
| performance | `frontend-performance-acceptance.md` |

Do not preload complete frontend corpus for a small checkpoint.

## Mandatory UI tool order

For UI implementation, use scoped compile/lint first. Do not run browser or test suites after every edit. At
assembled UI acceptance use: task scope → Material agent playbook → U1-R observations → Storybook
`docs-list`/`docs-show` → accepted catalog/story → implementation → real Chrome inspection → Storybook
`test-run` → scoped Playwright interaction/a11y/visual checks → receipt. Google Design MCP is mandatory for U1.2
proposals. Random design search and undocumented component props are prohibited.

## Manager and path boundaries

- One authorized manager works in the existing checkout/worktree and assigns exact allowed paths.
- Parallel tasks use disjoint paths; shared package/root integration points are serialized by the manager.
- Do not create a branch, worktree, manifest, barrel, route root or framework for process compliance.
- Manager ownership does not authorize merge, deploy, account mutation or cutover.
- Paths outside the authorized scope go through the smallest handoff to their existing owner.

## Autonomous manager behavior

When owner authorization covers the programme, the manager selects and executes the next ready task without
asking whether to continue. During implementation it repairs scoped compile/lint/dependency failures; after
assembly it repairs applicable test/layout/a11y/CSP/visual failures,
coordinates any necessary root integration with its owner, reviews rendered output and advances to the human gate.

The manager does not ask the owner at U1-D or U2-X. It asks only for a real contract/security/ownership
conflict, unavailable required authenticated browser after recovery attempts, unauthorized deploy/account/
irreversible action, or FINAL-UI after U5-X. After two materially different failed approaches it writes a failure audit
and changes approach instead of adding another local patch. Progress comments are limited to tranche start, a
human gate, an exhausted hard blocker and tranche completion.

## Repository integration

The existing React app and packages are registered in the workspace. When a task adds a workspace package or
changes root manifests, lockfile, TypeScript references, boundaries, scripts, budgets or CI, coordinate that
shared integration with its existing owner and verify the resulting root graph. No historical B-U receipt or
checkpoint is required for ordinary work in already registered packages.

## Architecture

- React owns presentation; Worker owns authority.
- Data arrives only through `@eliotr/owner-api-client`, decoded from `unknown`.
- For owner list/draft reads, validate known fields while tolerating additive fields as ADR-0018 specifies.
  Mutation requests and evidence-resolution contracts keep strict, versioned decoding.
- TanStack Query owns in-memory read lifecycle; URL/router owns navigable selection.
- `@eliotr/ui` owns tokens/primitives/patterns.
- Prefer native HTML semantics for ordinary controls; use one qualified external composite foundation.
- Private source/report/evidence bytes are not persisted.
- One future Vite graph contains client and existing Worker output.
- No service worker registration.
- Ordinary integrated dev selects test environment and denies remote bindings.

## Mandatory implementation rules

1. Search `@eliotr/ui`/catalog before adding a role.
2. Build only the active slice; no speculative enterprise kit.
3. Add stable CSF stories for every shared state.
4. Use semantic tokens; no arbitrary visual literal.
5. Separate client/query/view-model from components.
6. One scroll owner per pane; native platform scrolling by default.
7. Never reparent mounted feature roots responsively.
8. Preserve request signals and route/session/lifecycle identity after awaits. A deployment-generation change is
   not itself an authorization-loss or data-wipe event; follow ADR-0018 read renewal and compatibility behavior.
9. Loading, empty, offline, denied, stale, unknown, degraded and failed remain distinct.
10. IDs/hashes/traces appear only in bounded technical disclosure.
11. Show only accepted public stages/receipts/limitations; never hidden reasoning/prompts/provider payloads.
12. Test long RU/EN, keyboard, touch, reduced motion, themes/high contrast and named viewports.
13. Attach exact build/environment/binding and visual/performance evidence.
14. Unsupported native/Preview/staging/live checks stay `PENDING`.
15. Do not optimize without reproduced trace and before/after result.
16. Do not assemble the shell until U1-R evidence exists and the internal U1-D manager gate passes.
17. U2-X is a fresh-context no-hint internal usability audit. Fix failures and continue; do not interrupt the
    owner before the complete U5-X review build.

## Live reference, visual and usability gates

### U1-R

Open the current live NotebookLM in the available authenticated browser and execute
`frontend-notebooklm-material-reference.md`. Inspect actual Sources, Chat/Research, citations, Studio, panel,
scroll, focus, responsive and state behavior before choosing tokens or shell composition.

### U1-D

Render the canonical composition at 1440/390, light/dark, long RU/EN with useful, loading and degraded states.
The manager compares it to U1-R and current Material 3 / M3 Expressive, rejects generic shadcn/admin output,
selects one coherent direction and continues automatically to U1.5.

### U2-X

A fresh-context tester who did not implement the UI performs the no-hint project → source → question → exact
evidence → artifact → Connections journey. Record and fix wrong turns, backtracking, accidental scope changes
and undiscoverable controls, then continue to real feature wiring.

### Final owner review

The owner is shown the completed U5-X interface once. Internal library, token and screenshot choices do not
require owner interruption. No deployment, cutover or final merge follows without separate
authorization.

## Owner-client and ResearchSession boundary

- Never import `@eliotr/pwa-*`, including subpaths.
- Components/hooks never call owner API `fetch` directly.
- Client emits typed authorization observation; React owns epochs/state clearing and no legacy global event.
- Query adapters are thin and duplicate no decoder.
- New fields/endpoints first belong to authoritative contracts/API and ER-48.
- SafeMarkdown consumes bounded validated AST and never legacy DOM renderer.
- Canonical detailed Research progress uses owner HTTP polling/status/history/readback.
- Current ResearchSession is only `eliotr.research-session-projection.v1`: an ER-48 adapter calls
  `readResearchSessionProjection()` with no arguments and returns strict `ACTIVE | CANCELLED | ENGINE_COMPLETED`.
- Components/hooks never import `agents/client`, open ResearchSession directly or use generic chat state.
- No chat/state/history/MCP/other frame is sent; `get-messages` returning
  `410 SESSION_CHAT_HISTORY_DISABLED` is expected behavior.
- Projection is snapshot-on-request, not proactive streaming progress. Missing/stale projection stays degraded
  until canonical HTTP readback.
- Duplicate/gapped/late HTTP or projection data never allocates a run, repeats mutation or invents completion.
- A future event/push protocol requires a separately accepted versioned server contract and scoped task; no ad hoc
  SSE/WebSocket/Agents channel is allowed.
- Exact document ranges use one immutable admitted representation: exact revision, strong validator/
  conditional, single untransformed range and length/digest/currentness recheck; otherwise bounded whole read.

## Query and mutation policy

- Every query consumes supplied `AbortSignal`.
- Protected query state is scoped to the authenticated principal/session. A deployment-generation change
  renews/reconciles the session and retries reads without losing the owner's draft or clearing protected UI state.
- Sign-out/auth loss/principal change/revoke/purge cancels and **removes** affected protected data. Deployment
  generation renewal preserves the draft and does not itself clear protected UI state; pagehide masks the page
  and aborts pending reads while suspended.
- No persisted Query/private disk cache.
- Global focus/reconnect/mount refetch/retries off; safe read classes opt in.
- Mutations `retry:false`; uncertain retry preserves original operation/body after readback.
- Unmount, poll stop or projection socket close is not server cancellation.

## Page lifecycle and bfcache

One root controller owns `pagehide`/`pageshow`. Shell contains pre-existing non-private privacy mask/inert guard.
On `pagehide`, synchronously set the non-private guard and close the lifecycle epoch before React/Query cleanup;
then abort pending reads and pause polling without mutation, retry, settlement or new operation ID. Keep the
page masked while suspended. Do not treat deployment-generation change alone as a reason to delete owner data.

Persisted `pageshow` remains masked from first restored paint until session renewal and health/currentness
reconciliation. Accept the previous deployment generation for owner reads as specified by ADR-0018; retain the
owner's draft across that renewal. Clear protected data on sign-out, principal change, revoke or purge. Test the
mask before first frame/screenshot, not after React commit.

## Rendering, scroll and CSP

- No application `innerHTML`, template renderer or unaudited `dangerouslySetInnerHTML`.
- One audited Markdown path with sanitized/disabled raw HTML, safe URL and typed citations.
- No selector/MutationObserver product state or live DOM reparenting; root privacy guard is narrow safety
  exception with no product/private state.
- Generic cards never scroll; table/code/excerpt use named local horizontal scroll.
- Feature-authored inline visual styles prohibited; dependency computed styles need actual CSP qualification.
- Never weaken script CSP or document imaginary static-SPA nonce.

## Cloudflare development safety

Ordinary dev/integrated browser/generated preview:

```text
CLOUDFLARE_ENV=test
remoteBindings:false
```

Preflight rejects wrong env, remote/production resources, unapproved AI/Browser/provider effects, production
routes/domains/hooks/credentials. Every binding is local simulation, fixture, remote non-production or pending.
Storybook loads no Worker plugin. Local Explorer follows preflight only.

Do not introduce a competing `cf init/dev/build/deploy` toolchain or generated `cloudflare.config.ts`.
Wrangler + the official Vite plugin remain authoritative. The manager prepares the bridge through their
existing files within the current refactor, before FINAL-UI; the legacy deploy script cannot consume Vite
output unchanged. Running a production deploy command requires the owner's authorization for that action.

## React, primitive and performance

- Strict Mode; pure render/restartable effects/full cleanup.
- Replay must not duplicate network/model/storage/browser effects.
- Native-first, one external composite family after qualification.
- Splitter behind `@eliotr/ui`; static panes are fallback.
- Decode each accepted payload once and coalesce presentation without dropping canonical stages/receipts.
- Typing remains responsive during polling/projection refresh.
- Pane resize changes geometry only and persists settled value.
- Pagination before virtualization; virtualization requires measured/a11y proof.
- A 40-section report does not initially read/parse/render all sections.
- Profiling/test/MCP tooling stays absent from production graph.

## Forbidden

- legacy renderer/CSS wrapped in React;
- direct owner fetch, ad hoc stream or component decoder;
- direct Agents SDK import outside the accepted ER-48 projection adapter;
- chat/transcript UI invented from ResearchSession;
- second primitive/styling/state/build/run/deploy authority;
- fabricated connectivity/completeness/support/confidence;
- production resources in ordinary dev/Preview;
- unreviewed service worker/offline cache;
- decorative custom scrollbars/generic `overflow:auto` cards;
- speculative shared components;
- generic shadcn/admin visual direction accepted without U1-D;
- baseline auto-acceptance;
- onboarding copy used to excuse failed U2-X journey.

## Completion

Package-local build, DOM snapshot, MCP response, click flow, screenshot, benchmark or Preview URL alone is
insufficient. Acceptance uses applicable typed checks, stories,
browser/visual/a11y/CSP/network/lifecycle/build/binding/performance evidence, named human gate and explicit
`PENDING` items.
