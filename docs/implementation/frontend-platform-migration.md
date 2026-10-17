# Owner-web platform migration and cutover

**Current refactor authority:** [ADR-0019](../adr/0019-compact-refactoring.md) and
[`backend-entrypoints.md`](backend-entrypoints.md).
**UI acceptance details:** [owner-web delivery map](../agent-work/frontend-owner-execution-map.md).
**Runtime target:** React/Vite in `apps/eliotr-web`, served by the existing `apps/eliotr-core` Worker.

The Astro-built `apps/eliotr-pwa` remains the served compatibility UI until React cutover. Astro is not the new
product platform. Preserve legacy behavior and safe rollback obligations while replacing the browser
presentation and lifecycle; do not add a second frontend service, Worker, API authority, database or generic
agent-state authority.

Current implementation tasks follow the owner authorization and router, in one manager checkout/worktree. The
manager assigns exact allowed paths and acceptance evidence, permits parallel work only on disjoint paths, and
serializes shared manifests, routes, barrels, composition roots, fixtures, SQL, Worker and CI. No new scheduler,
checkpoint registry, JSON claim or claim-history ancestry is required. Historical ER-47/48 claims and ER-49
checker remain optional audit material only.

## Product and platform boundaries

`apps/eliotr-web` uses React/Vite, Router, in-memory Query state, `@eliotr/ui` and one owner client.
It calls the same-origin API in `apps/eliotr-core`; that existing Worker hosts static assets, HTTP/MCP
and the D1/R2/Queue/Workflow/DO/provider bindings.

React owns presentation. The Worker and existing API own authority. Browser code uses the side-effect-free owner
client, strict request/response contracts, and the current authentication, CSRF/ingress, idempotency, exact
evidence and mutation policies. Do not duplicate decoders, add a second session authority, or weaken endpoint
contracts to simplify the UI.

The selected web target is React/Vite, native HTML semantics first, one source-owned `@eliotr/ui` system, and
the existing owner client. No Hono/router replacement, Astro redesign, second styling/state/build/deploy system
or unapproved realtime transport is part of this migration. Research progress remains canonical HTTP polling,
status and readback unless a versioned public-event contract is separately accepted.

Ordinary integrated development uses `CLOUDFLARE_ENV=test` and `remoteBindings:false`. Local preflight rejects
production resources/effects. Static assets and Worker routes use one attested build identity; Vite build
success by itself is not evidence that the current deploy command serves those assets.

## UI quality and owner gates

- **U1-R:** inspect live NotebookLM and official current Material 3 / M3 Expressive guidance before selecting
  tokens or shell composition. Record private-data-free observations.
- **U1-D:** review the coherent Eliot composition at wide desktop and phone sizes, light/dark, long RU/EN, and
  useful/loading/degraded states before assembling the shell.
- **U2-X:** an independent fresh-context reviewer performs the no-hint project → source → question → exact
  evidence → supported artifact → Connections recovery journey. Repair material usability failures.
- **U5-X:** review the complete integrated Sources, Research/Evidence, Studio and Connections experience and
  retain focused browser, accessibility, visual, network and lifecycle evidence.
- **FINAL-UI:** the owner reviews the finished integrated interface after U5-X. Actual deploy, final merge
  and cutover require the owner's authorization for those actions; use it if already given.

During implementation, use scoped TypeScript compilation and lint for changed code. Do not run tests or browser
checks after every edit. After assembly, retain applicable component, API-client, browser, accessibility, CSP,
performance and supported local/staging evidence. Mark unexecuted native, staging, live and release checks
`PENDING`; a screenshot or isolated component result is not full acceptance.

## Browser lifecycle and security

- No service-worker registration in React or its rollback artifact; `/sw.js` remains the permanent inert,
  non-claiming, no-fetch tombstone required by ADR-0017.
- Preserve `/agent-inbox/` as a separate bundle and transport boundary. Its retirement helper acts only on the
  exact same-origin root `/sw.js` registration and remains fail-closed while a controller exists.
- Pagehide synchronously masks the page and closes its lifecycle epoch, then aborts pending reads and pauses
  polling without mutations or operation-ID allocation. A suspended page stays masked until session and health
  reconciliation.
- Under ADR-0018, deployment-generation change alone does not clear owner data. Accept previous-generation
  owner reads, renew/reconcile the session and retry reads while preserving the owner draft. Clear protected
  state on sign-out, principal change, revoke or purge.
- Keep mutation retry/idempotency semantics, ingress and CSRF defenses, request scoping and exact evidence
  validation unchanged. Citation bytes still bind to the admitted representation, validator, length, digest and
  currentness at open time.
- Never expose private bytes, provider payloads, prompts, hidden reasoning or fabricated completion/connectivity
  state. Keep safe Markdown/CSP and bounded rendering behavior.

## U6 deploy bridge and rollback

Prepare and verify the bridge and rollback artifact within the current refactor before FINAL-UI. Actual
production deploy/cutover follows that review and its action authorization. Choose one bridge that binds
the exact Vite client, Worker modules and redirected config to the existing Worker deployment. Deploy the exact
attested output without rebuilding, or pin and deploy the exact redirected output from its build root; the
unchanged legacy-config deploy after a Vite client build is invalid. Do not add a second Worker, Pages service
or database.

Before switching, prepare and attest an online legacy rollback that preserves accepted PWA behavior, removes
the root service-worker registration, includes the exact retirement helper where required, and serves the
permanent inert `/sw.js` tombstone. Never restore the historical fetch/cache worker or `eliotr-shell-v1`.
Verify static/API routing, response headers, registration/cache readback, controller-null inbox recovery,
first-paint bfcache privacy, rollback identity and the deployed asset output. Retain the tombstone for the
lifetime of the origin.

After the authorized cutover and rollback obligations, retire replaced legacy UI code within the already
authorized refactor; retire the rollback artifact only when its window closes. No further confirmation is
needed for that ordinary code cleanup. Production/account mutation, deploy, final merge, cutover and
destructive data operations require authorization for those actions.
