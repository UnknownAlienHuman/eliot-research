# Owner-web delivery and acceptance map

**Purpose:** preserve the product, browser and cutover acceptance for the React owner web.
**Current refactor authority:** [ADR-0019](../adr/0019-compact-refactoring.md) and
[`backend-entrypoints.md`](../implementation/backend-entrypoints.md).
**Served compatibility UI:** `apps/eliotr-pwa` until the accepted React cutover.
**Target:** `apps/eliotr-web` (React/Vite) with the existing Worker and owner API.

For detailed historical C/U/B feature-contract rows, consult the [full execution-map baseline at
`4e53d5e2`](https://github.com/UnknownAlienHuman/eliot-research/blob/4e53d5e2296e7f4ed3ed29cef2f049891c5d20c0/docs/agent-work/frontend-owner-execution-map.md).
That map is a reference for prior UX, transport and feature contracts, not an active queue, leaf limit, claim
protocol or prerequisite. The current acceptance points below remain active.

This map records the owner-web sequence and its quality gates. It is not a scheduler, task registry or claim
protocol. Use the current implementation router for active source tasks. Existing ER-47/ER-48 claims and
ER-49 checkpoint history remain optional historical audit material; new work creates no JSON claims and has no
Git-ancestry prerequisite.

## Work ownership

One authorized manager uses the existing checkout/worktree and assigns each task exact allowed paths, inputs,
acceptance evidence and a scoped verification command. Parallel work is allowed only on disjoint exact paths.
The manager serializes shared manifests, lockfiles, root references, routes/query roots, barrels, catalogs,
Worker composition, SQL, CI and common fixtures. Existing product/API/security owners retain their contracts;
the manager hands off a path outside the authorized scope instead of editing it.

The manager prepares the integrated build and rollback within the authorized refactor. Actual deploy,
production/account mutation, final merge and cutover require the owner's authorization for those actions;
reuse authorization already given. The old claim checker is optional historical audit.

## Owner-web sequence

### Visual direction and shell

- **U1-R:** inspect live NotebookLM and current official Material 3 / M3 Expressive behavior before selecting
  the shell or tokens. Record a private-data-free reference matrix and rendered observations.
- **U1-D:** manager reviews a coherent Eliot composition at desktop and phone widths, light and dark themes,
  long Russian and English text, and useful/loading/degraded states. Resolve the design direction before shell
  assembly.
- Build the React shell with one owner-client path, URL-owned navigation, in-memory query state and no service
  worker. Ordinary integrated development uses `CLOUDFLARE_ENV=test` and `remoteBindings:false`.

### Fixture journey and real features

- **U2-X:** a fresh-context reviewer completes the no-hint project → source → question → exact evidence →
  supported artifact → Connections recovery journey. Fix material wrong turns and continue.
- Wire Sources, Research/Evidence, Studio and Connections through the existing owner API/client contracts.
  Detailed Research status/history/readback remain canonical HTTP authority; any session projection stays a
  bounded snapshot. Do not invent chat history, stream contracts, endpoints, or completion authority.
- Verify exact evidence only when opened, mutations with their existing idempotency/readback behavior, and
  current ingress, request, disclosure, lifecycle and byte-representation contracts.

The active product scope remains projects/sources/question/report with exact citations and reopen; Cloudflare AI
Search or provider-native search for uploaded project sources; draft publication through Inbox; connected agents
and task assignment; and the existing Library, Lens, Wiki and explicit deep-research paths. Search uses the
provider's index/ranking, with bounded project filtering and honest partial/unavailable results; do not add the
canceled custom S52 index/generation machinery. Owner list/draft reads validate known fields
while tolerating additive fields and previous deployment generations, preserving the draft/last read as stale
through renewal. Clear protected data on sign-out or principal change. Mutations retain CSRF, idempotency, CAS,
no-auto-retry and uncertain-acknowledgement readback. Citation open resolves the admitted representation,
revision and digest through the evidence owner. Research progress uses HTTP status/history/readback; the optional
ResearchSession reader remains a strict, bounded read-only snapshot and never admits/replays/completes a run.

### Integrated interface and owner review

- **U5-X:** review the complete integrated interface, feature boundaries, route behavior, responsive layouts,
  keyboard/focus, loading/degraded/error states, network behavior and sensitive-data handling. Retain the
  bounded review evidence.
- **FINAL-UI:** show the finished integrated interface and evidence package to the owner for review. Internal
  U1-D/U2-X choices do not interrupt implementation; the owner review follows U5-X.

## Verification

During implementation, run scoped TypeScript compilation and lint for changed code. After assembly, run the
relevant component, API-client, browser, accessibility, CSP, performance and Worker integration checks for
changed behavior. Record exact commands, results and unexecuted native/staging/live gates as `PENDING`. A
screenshot, package build or isolated story alone does not establish feature acceptance. Do not run tests or
browser checks after every edit; full repository and release checks remain at their defined boundary.

## U6 — deploy bridge and compatibility retirement

Prepare and verify the build/deploy bridge and rollback artifact during the authorized refactor, before
FINAL-UI, so the owner reviews a concrete integrated result. Actual production deployment/cutover follows
final interface review and the owner's authorization for that action. Keep `eliotr-pwa` served until the
React/Vite output is attested and connected to the existing Worker's asset path. Use one build identity;
do not add a second Worker, Pages service or database.

Before switch, retain an accepted online legacy rollback artifact with no root service-worker registration.
Preserve the `/agent-inbox/` isolation and exact retirement helper. Keep `/sw.js` as the permanent inert,
no-fetch, non-claiming tombstone; neither React nor rollback registers it. Verify browser retirement/readback,
first-paint privacy behavior, response headers, safe rollback and the actual deployed output. Remove replaced
legacy UI code after cutover and rollback obligations are satisfied, within the already authorized refactor.

Deployment, account mutation, final merge, cutover and destructive data operations need their own action
authorization. Ordinary in-scope code retirement does not require another confirmation.
