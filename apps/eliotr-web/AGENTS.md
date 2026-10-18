# React owner-web rules

`apps/eliotr-web` is the React/Vite target. `apps/eliotr-pwa` remains served compatibility until the authorized
cutover. Follow [root instructions](../../AGENTS.md), [ADR-0019](../../docs/adr/0019-compact-refactoring.md),
the [current router](../../docs/implementation/backend-entrypoints.md), and the [Material UI playbook](../../docs/agent-work/frontend-material-agent-playbook.md).
The execution map identifies active slices; old ER-47/48/49 packets and claims are historical source maps,
not implementation gates.

## UI workflow

Work in the existing manager checkout. The manager assigns exact paths; parallel work uses disjoint paths and
the manager serializes shared roots, manifests, routes, barrels and integration. Do not create another
scheduler, claim registry, branch, worktree or framework. Root `AGENTS.md` and `START-HERE.md` govern task
assignment, scoped compile/lint and when assembled checks run; this file does not repeat those procedures.

For rendered UI, use the playbook and [live reference protocol](../../docs/agent-work/frontend-notebooklm-material-reference.md).
U1-R informs tokens and composition; U1-D is internal rendered review; U2-X is a fresh-context no-hint
usability review. Repair findings and continue through U5-X. The owner reviews the complete interface at
FINAL-UI. Prepare the integrated Vite/Worker bridge and rollback artifact within the authorized refactor;
perform deploy, account mutation, cutover or final merge only under the applicable existing authorization.

## Architecture

- React presents the product; the Worker is the authority. Browser data access goes through
  `@eliotr/owner-api-client`; TanStack Query owns read lifecycle and Router owns navigable selection.
- Owner list/draft reads validate known fields and tolerate additive fields (ADR-0018). Mutations and evidence
  retain strict versioned decoding. Query adapters do not duplicate decoders.
- `@eliotr/ui` owns shared tokens, primitives and patterns. Prefer native HTML for ordinary controls and one
  qualified external composite family. Do not create a second router, cache, API client, decoder or design system.
- Never import `@eliotr/pwa-*`. Components do not call `fetch`, import `agents/client`, open ResearchSession,
  or treat projection data as canonical progress. The only accepted projection is
  `eliotr.research-session-projection.v1`; canonical status/history/readback remains owner HTTP. No chat history,
  transcript, ad-hoc stream or model-authored evidence identity.
- Private source/report/evidence bytes are not persisted in browser storage. No service-worker registration.
  Deployment-generation renewal preserves the owner's draft; clear protected state on sign-out, principal
  change, revoke or purge. Never blindly retry mutations; preserve operation identity after readback.
- Keep request abort signals and route/session/lifecycle identity across awaits. Late or duplicate data cannot
  create runs, repeat mutations or invent completion. Loading, empty, offline, denied, stale, unknown,
  degraded and failed states stay distinct; expose only accepted public stages/receipts/limitations.
- Preserve exact evidence revision/representation/digest and currentness checks when opening citations.
  SafeMarkdown uses bounded validated AST and sanitized URLs; no legacy DOM renderer or unsafe HTML. No
  live feature-root reparenting. Give each pane one scroll owner; generic cards do not scroll.

## Page lifecycle and bfcache

One root controller owns `pagehide`/`pageshow` ([ADR-0017 §5](../../docs/adr/0017-owner-web-browser-runtime-and-tooling.md)).
On `pagehide`, synchronously mask with a non-private guard and close the lifecycle epoch, then abort reads,
pause polling and remove protected Query entries and report/evidence/source-byte views without mutation or new
operation ID. Retain only safe route IDs, permitted non-sensitive drafts, theme and validated pane geometry.
Keep the page masked while suspended. On persisted `pageshow`, keep the mask through session renewal and
health/currentness reconciliation; accept the prior deployment generation for owner reads and preserve the
draft and last known read across that renewal. Test the mask before the first restored frame.

## Rendering, scroll and CSP

No application `innerHTML`, template renderer, selector/MutationObserver product state or unaudited
`dangerouslySetInnerHTML`. Keep raw HTML disabled/sanitized and citations typed. Feature-authored inline visual
styles are prohibited; dependency styles require actual browser/CSP qualification. Do not weaken script CSP or
assume a static-SPA nonce. Ordinary development uses `CLOUDFLARE_ENV=test` and `remoteBindings:false`; reject
production/effectful bindings. Wrangler and the official Vite plugin remain the build authority.

## Product quality

Use semantic tokens and existing catalog entries; do not invent speculative shared components. Preserve long
RU/EN, keyboard, touch, reduced-motion, theme/high-contrast and responsive behavior in the relevant feature
acceptance. Rendered U1-D must be recognizably Eliot, not generic shadcn/admin or a NotebookLM copy. Avoid
unmeasured virtualization, decorative/custom scrollbars, status-banner duplication and unbounded report reads.
The [harness contract](../../docs/implementation/frontend-agent-harness.md) records the UI evidence boundaries.

## Completion

An isolated story, screenshot, DOM snapshot, MCP response or local fixture is not integrated UI acceptance.
Record actual behavior, applicable evidence and unresolved `PENDING` checks as directed by the root workflow.
