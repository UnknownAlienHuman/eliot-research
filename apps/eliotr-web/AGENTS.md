# ER-47 — React owner workspace rules

`apps/eliotr-web` is owned by ER-47 manager. ER-25 owns served legacy until cutover. ER-48 owns owner-client
extraction/legacy compatibility. ER-49 owns static checkpoint definitions and claim-history validation.

## Read before editing

A manager first reads `docs/agent-work/frontend-autonomous-manager-runbook.md`. A leaf reads only:

1. exact checkpoint in `docs/agent-work/frontend-owner-execution-map.md`;
2. `docs/agent-work/ER-47-owner-web-interface.md`;
3. `docs/agent-work/frontend-notebooklm-material-reference.md` for U1-R and rendered-product review;
4. `docs/agent-work/frontend-current-contract-amendment-2026-10-09.md` when named by the checkpoint;
5. affected catalog/story/scenario and exact client/DTO contract;
6. its exact claim after ER-49 acceptance.

Manager reads ER-49 result but never edits scheduler definitions or ER-48 claims. Registry never replaces
packet/execution map.

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

## Manager, leaf and claim boundaries

- One ER-47 manager owns direct-main context or single owner-authorized worktree/review branch.
- Manager context does not lift stop, expand ownership, satisfy prerequisites or authorize merge/deploy/account
  mutation.
- Leaf edits only exact checkpoint/claim paths and creates no branch/worktree/manifest/barrel/route root/new
  framework.
- Before ER-49, one frontend leaf maximum.
- After ER-49:
  - claim-introduction commit is a strict ancestor of source edits;
  - same-commit claim+source is prohibited;
  - each source commit has exactly one active covering claim in parent tree;
  - one active claim per checkpoint, one manager context per packet, disjoint parallel paths;
  - predecessor refs name checkpoint + ancestor commit and gate approval reference where required.
- ER-49 proves mechanics, not truth of human approval/test evidence; manager/operator validates substance.
- ER-47 never edits static registry or ER-48 claims.
- Manager serializes package-local integration and ER-00/24/26 handoffs.

ER-49 is optional for parallelism. Sequential one-manager/one-leaf mode remains valid.

## Autonomous manager behavior

When a durable owner comment authorizes a tranche, the manager selects and executes the next dependency-ready
checkpoint without asking whether to continue. It repairs routine compile/test/dependency/layout/a11y/CSP/visual
failures, prepares bounded B-U/B-C handoffs, reviews rendered output and advances until the tranche human gate.

The manager asks the owner only for U1-D, U2-X, a real contract/security/ownership conflict, or unauthorized
deploy/account/irreversible action. After two materially different failed approaches it writes a failure audit
and changes approach instead of adding another local patch. Progress comments are limited to tranche start, a
human gate, an exhausted hard blocker and tranche completion.

## Repository bootstrap

Workspace glob discovery is not integration.

- U1.1a creates only package-local manifests/config/dependency proposal.
- ER-00 B-U owns frozen lockfile, root TS refs, boundary rules/negatives, root scripts/tests and budgets.
- U1.1b starts from accepted B-U SHA and runs sibling Worker/config/routing parity probe.
- Package-local Vite/editor/story success before B-U releases nothing.
- Unknown workspace source package must fail root gates.

## Architecture

- React owns presentation; Worker owns authority.
- Data arrives only through `@eliotr/owner-api-client`, decoded from `unknown`.
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
8. Preserve request signal, route, session/lifecycle/deployment epochs after awaits.
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

The owner is shown the completed U5-X interface once. Internal library, token, screenshot and checkpoint
choices do not require owner interruption. No deployment, cutover or final merge follows without separate
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
- A future event/push protocol requires a new accepted versioned server contract and checkpoint; no ad hoc
  SSE/WebSocket/Agents channel is allowed.
- Exact document ranges use one immutable admitted representation: exact revision, strong validator/
  conditional, single untransformed range and length/digest/currentness recheck; otherwise bounded whole read.

## Query and mutation policy

- Every query consumes supplied `AbortSignal`.
- Protected keys include session/principal epoch and deployment generation.
- Logout/auth loss/revoke/purge/generation/pagehide cancels and **removes** protected Query/local data.
- No persisted Query/private disk cache.
- Global focus/reconnect/mount refetch/retries off; safe read classes opt in.
- Mutations `retry:false`; uncertain retry preserves original operation/body after readback.
- Unmount, poll stop or projection socket close is not server cancellation.

## Page lifecycle and bfcache

One root controller owns `pagehide`/`pageshow`. Shell contains pre-existing non-private privacy mask/inert guard.
On `pagehide`, synchronously set guard and close epoch before React/Query cleanup; then abort/pause/remove
protected state with no mutation/retry/settlement/new operation ID. Do not use `unload`.

Persisted `pageshow` remains masked from first restored paint until fresh no-store session/health/deployment
verification. Test mask before first frame/screenshot, not after React commit.

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

`cf init/dev/build/deploy` and generated `cloudflare.config.ts` are outside ER-47 authority. Wrangler + official
Vite plugin remain authority. Existing deploy script cannot consume Vite output unchanged.

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

Package-local build, claim, DOM snapshot, MCP response, click flow, screenshot, benchmark or Preview URL alone
is insufficient. Checkpoint satisfies temporal claim validation, B-U where applicable, typed tests, stories,
browser/visual/a11y/CSP/network/lifecycle/build/binding/performance evidence, named human gate and explicit
`PENDING` items.
