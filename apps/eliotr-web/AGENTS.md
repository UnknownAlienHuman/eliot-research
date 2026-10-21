# React owner-web rules

`apps/eliotr-web` is the React/Vite target. Follow root [working rules](../../AGENTS.md), the
[current plan](../../docs/implementation/backend-entrypoints.md), [frontend cutover](../../docs/implementation/frontend-platform-migration.md)
and [Material guidance](../../docs/agent-work/frontend-material-agent-playbook.md). Historical ER packets,
claims, amendments and checkpoint names are source evidence only; they do not gate work.

## Ownership

- React presents the product; `apps/eliotr-core` remains the one backend authority.
- Browser data access goes through the injected `@eliotr/owner-api-client`. Components do not call `fetch`, import
  server packages, open Agent/WebSocket connections or recreate DTO decoders.
- TanStack Query owns read lifecycle; Router owns navigable selection; `@eliotr/ui` owns shared tokens,
  primitives and patterns.
- Do not create a second router, cache, API client, design system, transcript, service worker or local persistence
  layer for protected content.

Owner list/read decoders may tolerate additive fields where the current contract permits it. Mutations, citations
and operation identity remain strict. Never blindly replay an uncertain mutation.

## ResearchSession

[The delivery contract](../../docs/implementation/research-session-projection-protocol.md) owns this boundary.
Canonical run status/report remains HTTP/D1/R2. The current read-only projection may evolve into one bounded typed
phase/public-text channel over the existing authenticated Agent connection. It never becomes chat, history, tool
execution, model dispatch or canonical output.

Only the owner-client session adapter imports the Agent client. Components consume typed projection data. Missing,
stale or disconnected projection is degraded presentation, not cancellation or permission to restart a run.

## Security and lifecycle

Private source/report/evidence bytes do not enter browser storage. No prompts, reasoning, credentials, raw provider
frames, caller-authored citation authority or unsafe HTML. Markdown uses the existing bounded/sanitized renderer and
typed citations.

One root controller owns `pagehide`/`pageshow`. On `pagehide`, synchronously mask, close the lifecycle epoch, abort
reads, pause polling and remove protected Query/view state without allocating a mutation. Keep a restored page masked
until session/health/currentness reconciliation. Principal change, sign-out, revoke and purge clear protected state;
a deployment generation change alone preserves the same owner's permitted draft/last read with stale indication.

Keep same-origin transport, CSRF where required, reviewed CSP/referrer/frame/permissions/noindex/cache headers and
late-response guards. Ordinary local development uses the isolated test profile; do not connect production bindings
or perform deployment/account/data changes as an incidental UI task.

## UI quality

Use semantic tokens and existing catalog entries before adding a shared component. Keep one scroll owner per pane.
Preserve long RU/EN, keyboard, touch, reduced motion, contrast/themes and responsive behavior for the affected flow.
Do not imitate another product mechanically, add decorative status noise or introduce unmeasured virtualization.

## Completion

Implement a complete user outcome through real client methods and remove the replaced legacy caller/decoder in the
same integration. Compile/lint during implementation; assembled browser/product checks follow. A story, screenshot,
DOM snapshot or fixture alone is not integrated acceptance.
