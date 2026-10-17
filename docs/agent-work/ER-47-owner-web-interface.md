# ER-47: React owner web interface

**Status:** historical feature and acceptance reference. Current scope/order comes from [the implementation router](../implementation/backend-entrypoints.md) and manager assignment; ER-49 claims and checkpoints are not gates.
**Target:** React/Vite owner UI in `apps/eliotr-web`; the Astro/PWA remains served compatibility until authorized cutover.
**Architecture:** [ADR-0016](../adr/0016-react-cloudflare-owner-ui.md), [ADR-0017](../adr/0017-owner-web-browser-runtime-and-tooling.md), [ADR-0018](../adr/0018-owner-single-function-first-profile.md), [ADR-0019](../adr/0019-compact-refactoring.md).
**UI behavior and review:** [execution map](frontend-owner-execution-map.md), [Material playbook](frontend-material-agent-playbook.md), [manager runbook](frontend-autonomous-manager-runbook.md), [harness](../implementation/frontend-agent-harness.md), [OWNER_WEB_UI](../design/OWNER_WEB_UI.md).

## Objective

Replace the Astro-wrapped imperative presentation with one React/Vite owner workspace while retaining the existing Worker and its owner API, evidence, authorization, mutation and completion authority. Use the execution map and design documents for feature behavior; this packet is not a second UI specification.

## Owned paths

- `apps/eliotr-web/**`
- `packages/ui/**`
- `tests/ui-owner/**`
- `scripts/ui-owner/**`
- `docs/agent-work/frontend-owner-claims/ER-47/**`

These are historical packet paths, not current locks. Current tasks receive exact paths from the manager. Shared manifests, routes, barrels and integration are coordinated through the root workflow.

## Build and rollback boundary

The target is one Vite client plus the existing Worker. The current orchestrator deploys an attested entrypoint with explicit `--no-bundle --config wrangler.deploy.jsonc`; it will not consume redirected Vite output automatically. The refactor must prepare an explicit bridge and verify its output/config integration. Vite assets passed to the unchanged legacy deploy script are not a valid release path.

Before FINAL-UI, prepare one immutable, retirement-safe legacy rollback artifact through the existing ER-25/00/24/26 homes. Preserve accepted online legacy behavior, no root `/sw.js` registration, no historical fetch/cache worker, the exact retirement helper and a permanent inert `/sw.js` tombstone. Historical production bytes are not a post-retirement rollback. Deployment and cutover follow their applicable existing authorization; ordinary in-scope code retirement follows cutover and rollback obligations.

During ordinary local development use `CLOUDFLARE_ENV=test` and `remoteBindings:false`. Local preflight rejects remote/production identities and unapproved effectful bindings; Storybook uses fixtures without the Worker plugin. See the root workflow for check timing.

## Browser lifecycle and deployment renewal

Deployment-generation change alone is not authorization loss and does not clear the owner's draft or last known read. Preserve them, mark stale when appropriate, and reconcile/retry reads under ADR-0018. Sign-out, principal change, revoke or purge removes affected protected state.

Follow [ADR-0017 §5](../adr/0017-owner-web-browser-runtime-and-tooling.md): the root lifecycle controller synchronously masks on `pagehide` and closes the epoch, then aborts reads, pauses polling and clears protected Query/report/evidence/source-byte views without mutation, retry or new operation. Retain only safe route IDs, permitted non-sensitive drafts, theme and validated pane geometry. Keep the page masked while suspended; reveal protected content after persisted-`pageshow` reconciliation. A deployment-generation change alone preserves the owner's draft and last known read; it does not trigger that cleanup.

Preserve the core client/React boundary: no legacy browser package import, direct feature `fetch`, copied wire decoder, or ad-hoc SSE/WebSocket/Agents channel. The client reports bounded authorization observations; React owns session/lifecycle epochs and protected-view cleanup. Canonical Research progress remains HTTP status/history/readback; any accepted projection is read-only and cannot create a run or completion.

## Performance reference

The initial JavaScript budget is **600 KiB gzip**. [Frontend performance acceptance](../implementation/frontend-performance-acceptance.md) owns P1–P10 measurement references for shell startup, lists, progressive updates, lazy reports, evidence, panes, theme, authorization clearing and bfcache. Optimize only from a reproduced trace and before/after evidence; preserve bounded report loading and responsive interaction.

## Product acceptance

The current required UI areas and journeys live in the [execution map](frontend-owner-execution-map.md). Keep U1-R/U1-D visual direction, U2-X usability and U5-X integrated review as described by the canonical UI docs; FINAL-UI is the owner's review of the complete interface. Browser verification occurs at assembled acceptance, not after each edit. Mark unsupported native, Preview, staging or live checks `PENDING`.
