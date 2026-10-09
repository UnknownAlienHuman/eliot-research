# Browser client extraction inventory — ER-48

**Date:** 2026-10-08
**Baseline:** `3e6c25660c1ae515760e19d5f9e6b8a735795c4c`
**Owner:** ER-48
**Consumer:** ER-47 U3–U6
**Status:** static code inventory; extraction and tests are PENDING

This document identifies what can be reused, what must be adapted, and what must remain legacy-only across
`pwa-http-client`, `pwa-source-workspace`, and `pwa-research-workspace`. It exists to prevent two equally bad
migrations:

1. importing legacy package roots into React and dragging DOM/global-event behavior into the new app;
2. copying every request/decoder into `apps/eliotr-web` and maintaining a fourth wire implementation.

## 1. Current package facts

### `@eliotr/pwa-http-client`

- Declares `sideEffects: false` and has a small root barrel.
- `api.ts` owns strict envelope/problem/health parsing, response readers and request helpers.
- Request helpers call a private `notifyAuthorizationCleared()` that dispatches
  `window.dispatchEvent(new Event("eliotr:authorization-cleared"))` for selected auth-loss outcomes.
- `owner-session-api.ts` is layered on the same transport.
- Import-time behavior is mostly pure; request-time behavior is coupled to the legacy global event bus.

**Disposition:** retain algorithms/tests, replace hidden global notification with an injected client hook,
then provide a legacy adapter that emits the old event.

### `@eliotr/pwa-source-workspace`

The root exports all of the following together:

```text
API/decoder modules
browser file/import orchestration
DOM panels/renderers
HTML escaping helper
Markdown parser worker + DOM renderer
```

`package.json` declares the Markdown worker as a side effect and exposes almost everything only through the
root barrel. A React import from the root therefore has an unsafe/unstable dependency surface even if a
bundler later removes unused code.

**Disposition:** extract API/decoder/client functions into `@eliotr/owner-api-client`; keep panels and legacy
renderers as ER-25 compatibility; split the Markdown AST/parser from DOM rendering only if React needs it.

### `@eliotr/pwa-research-workspace`

- Root exports three panel families plus selected APIs.
- Subpath exports expose run/report/reauthorization/wiki API modules directly.
- API code is not consistently based on one transport; some files use the common client, while others issue
  direct `fetch` and repeat auth-loss event behavior.
- Package depends on the source workspace, so importing the root can transitively couple research to source
  DOM/rendering helpers.

**Disposition:** inventory and move request/decoder/value logic into the new client, remove duplicate fetch
stacks, leave panels/controls/download DOM behavior in legacy until React replacements are accepted.

### `pwa-knowledge-workspace`

ADR-0015 and the boundary allowlist name this package, but it is absent from the reviewed package tree,
`apps/eliotr-pwa/package.json`, and root TypeScript project references.

**Disposition:** mark it absent. Do not create an empty package to satisfy old prose. Actual Wiki/Connections
API modules are inventoried from their current real locations and moved under ER-48 if needed.

## 2. Source workspace classification

### A. Strong extraction candidates

These file families are expected to become client/decoder modules after confirming they have no DOM/global
listener/storage side effects:

| Current file | Target area | Required preservation |
|---|---|---|
| `bundle-import-api.ts` | `sources/import` | strict envelopes, generation, multipart/recovery identity |
| `bundle-recovery-api.ts` | `sources/import` | exact operation/file-manifest continuation |
| `document-reader-api.ts` | `sources/document` | pinned revision, byte bounds, currentness |
| `erasure-api.ts` | `sources/erasure` | mutation identity, unknown/reconciliation, typed closure state |
| `library-api.ts` | `sources/library` | bounded pages/cursors/generation/project scope |
| `library-readiness-api.ts` | `sources/readiness` | recorded vs active readiness, expected head/generation |
| `orientation-api.ts` | `sources/orientation` | scope/source identity, trace/coverage honesty |
| `navigation-expand-api.ts` | `sources/navigation` | exact structural route/currentness |
| `project-api.ts` | `sources/projects` | guarded mutation/readback and project revision |
| `raw-file-api.ts` | `sources/import` | exact file bytes/operation identity and limits |
| `source-namespace-api.ts` | `sources/namespaces` | owner-session/generation authority |
| `source-revisions-api.ts` | `sources/revisions` | immutable revision history and pagination |

Each candidate must be characterized before moving. “API” in a filename is not evidence of purity.

### B. Browser orchestration requiring explicit review

| Current file | Risk | Target decision |
|---|---|---|
| `bundle-import.ts` | File APIs, hashing/upload sequencing, mutable browser input | split pure manifest/state machine from UI file adapter; preserve exact retry/recovery identity |
| `bundle-input.ts` | browser `File`/directory normalization | keep as optional browser adapter if no DOM/persistence/global effects |
| `raw-file-version-view.ts` | likely mixes view/state with request inputs | extract value/command model only; React owns presentation |

Do not move large orchestrators unchanged merely because React can call them. Their lifecycle must accept
explicit cancellation/session dependencies and expose typed state rather than mutating elements.

### C. Legacy-only presentation

```text
bundle-import-panel.ts
erasure-panel.ts
library-panel.ts
library-readiness-panel.ts
orientation-panel.ts
project-panel.ts
raw-file-panel.ts
source-namespace-panel.ts
source-revisions-panel.ts
html.ts
```

These remain ER-25 compatibility until React equivalents and behavioral tests exist. Their DOM/event/focus
logic is not wrapped inside React effects.

### D. Markdown/parser boundary

Current reading code has valuable constraints:

- Markdown parser configured with raw HTML disabled;
- bounded source bytes;
- bounded AST nodes and depth;
- parser timeout/worker lifecycle;
- strict node validation;
- safe URL checking.

The current renderer still creates DOM nodes and belongs to legacy presentation.

Target split:

```text
owner-api-client or a small pure parser package
  versioned bounded Markdown AST types
  parser worker protocol
  parse/validate limits
  safe URL classification

@eliotr/ui
  React SafeMarkdown renderer over validated nodes
  citation controls from typed server data, not parsed links
```

No generated HTML crosses the boundary. Unknown AST nodes fail closed or degrade to escaped plain text.

## 3. Research workspace classification

### A. Strong extraction candidates

| Current file/family | Target area | Required preservation |
|---|---|---|
| `artifact-product-api.ts` | `studio/artifacts` | product/publication/mutation identity and strict readback |
| `research-changes-api.ts` | `research/changes` | bounded cursor/generation/currentness feed |
| `research-configuration-api.ts` | `research/configuration` | server-owned configuration/readiness and strict fields |
| `research-model-configuration-api.ts` | `connections/model` | provider/model state without credential disclosure |
| `research-run-api.ts` | `research/runs` | begin/history/status/sections/actions; remove duplicated transport/global event |
| `research-run-reauthorization-api.ts` | `research/evidence` | exact citation/artifact authorization and generation |
| `wiki-proposal-create-api.ts` | `studio/wiki` | exact proposal mutation/readback identity |

Subpath exports do not become the permanent React boundary. They are temporary source locations while
ER-48 produces one coherent package.

### B. Mixed/client-plus-presentation files

```text
research-run-report.ts
research-markdown-download.ts
artifact-product-controls.ts
research-run-connection.ts
```

For each file, split:

- pure value/manifest/download-byte construction;
- request/decoder behavior;
- DOM/Blob/download/focus/listener behavior.

Only the first two categories belong in the owner client. React owns control rendering, connection state
presentation, browser download trigger and focus restoration.

### C. Legacy-only panels

```text
research-run-panel.ts
research-changes-panel.ts
research-configuration-panel.ts
```

Their accepted behavior remains input to ER-47 tests, but their renderer/lifecycle is not reused.

## 4. API modules outside the three packages

The current PWA still contains real owner API modules/panels for Wiki, connections, grants, owner session,
MCP diagnostics, exhaustive workflow, provider keys, OAuth and other functions. ER-48 C0 must enumerate
those actual files and classify them before claiming a complete client.

No synthetic `knowledge-workspace` package is introduced. Move only implemented and consumed endpoints.
A disabled or planned UI control does not justify a client method.

Expected inventory groups:

```text
owner session and health
client/project grants
Wiki list/read/edit/proposal
artifact publication/edit/read
Google/Workspace transport status
MCP/client diagnostic observations
research provider/configuration/key state
exhaustive workflow status/actions
connections diagnostics
```

The owner API route/contract remains authoritative; the current file location does not define the final
package boundary.

## 5. Global event bus transition

The legacy app uses `eliotr:authorization-cleared`, `eliotr:health-lost`, `offline`, `online`, import/source
completion and other window events across many panels. React must not reproduce this bus.

### Target transport/session model

```text
OwnerApiClient instance
  ├── explicit fetch/base URL/timeouts
  ├── onAuthorizationLoss(observation)
  ├── caller AbortSignal
  └── no window/document/storage access

Legacy adapter
  └── maps authorization loss to the existing window event exactly once

React session controller
  ├── increments a session/authority epoch
  ├── cancels protected queries
  ├── removes protected query data
  ├── clears local protected view state
  └── navigates or shows re-auth action without reloading stale bytes
```

Concurrent failures must be coalesced into one authority transition for one observed epoch. A late failure
from an old epoch cannot clear a newly verified session.

Other legacy events are replaced by explicit Query invalidation/removal keyed to authoritative mutation
readback, not by a generic global bus.

## 6. Extraction sequence

### C0 — machine-readable inventory

Produce one table/JSON record per current module:

```text
path
exports
actual consumers
endpoint + method
request/response limit
strict decoder
session/generation axes
mutation/idempotency axes
uses window/document/navigator/storage/Worker/File/Blob
registers listener or dispatches event
classification: pure / browser adapter / renderer / obsolete
migration target and tests
```

Do not infer purity from naming or `sideEffects` metadata alone.

### C1 — transport/session seam

- introduce explicit transport factory/hook;
- keep accepted decoder/error behavior;
- legacy adapter emits the old event;
- add import-side-effect tests with missing DOM globals;
- prove concurrent auth failures and resumed-session race behavior.

### C2 — Sources

Move source API groups one bounded family at a time. Existing legacy panels switch to compatibility imports;
React does not consume the family until equivalence tests pass.

### C3 — Research/Studio/Connections

Move run/report/evidence/artifact/Wiki/connection API groups and remove duplicate direct fetch stacks. Do not
move DOM controls/download triggers with them.

### C4 — React adapters

ER-47 adds Query keys/options and UI command controllers over the client. The client itself remains
framework-free.

### C5 — legacy retirement

After cutover, remove panel/render packages and compatibility exports only when every consumer/test has an
explicit disposition. Keep the owner client and pure parser contract.

## 7. Static gates required during migration

- `apps/eliotr-web` cannot import `@eliotr/pwa-*`.
- `@eliotr/owner-api-client` cannot import React, TanStack Query, UI, DOM renderers or Cloudflare bindings.
- package import under Node with `window/document/navigator/storage` absent has no effect.
- no client source dispatches/listens to `eliotr:*` global events.
- only the legacy adapter may import the global-event bridge.
- no duplicated endpoint+decoder owner after a family moves.
- feature components cannot call `fetch` directly for owner APIs.
- root client exports are finite and renderer-free.
- bundle graph proves no legacy panel/Markdown DOM renderer in the initial React graph.

## 8. Verification matrix

For every moved family:

1. exact accepted fixture parity;
2. malformed/unknown/oversized/HTML/redirect response rejection;
3. 401 and selected access-denial transition;
4. policy/resource 403 that does **not** destroy owner session;
5. cancellation before/during body read;
6. deployment generation mismatch;
7. late response after navigation/session/generation change;
8. same-key replay and uncertain mutation reconciliation;
9. no private persistence;
10. legacy panel regression through compatibility adapter;
11. React Query lifecycle regression;
12. source/package/bundle budget impact.

C0/C1 are blockers for ER-47 feature API wiring. U1/U2 fixture-only presentation may proceed independently.
