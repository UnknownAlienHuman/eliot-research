# Browser side effects and mixed modules

**Baseline:** `0b7c307e9e7c267bda712e6ae41b87b555e9fc01`
**Claim:** `f956b8d2360657052c277938561df31b33602437` (history base `c37e56e0`)
**Method:** static scan for `document.`, `window.`, `createElement`, `querySelector`, `innerHTML`,
`dispatchEvent`, `addEventListener`, `navigator.`, `Worker`, `HTMLElement`. A zero-hit file is treated as
API-only only after reading it, never by filename.

## 1. The single blocking global coupling

`packages/pwa-http-client/src/api.ts:59`

`notifyAuthorizationCleared` dispatches a window Event named `eliotr:authorization-cleared`.

It is invoked from three conditions inside `requestApiWithStatuses` and `requestApiBytes`:

- `response.redirected`, `opaqueredirect`, or any 3xx status
- `response.status === 401`
- a 403 whose problem code starts with `ACCESS_`, decided by `isAuthorizationLoss`

Import time is pure. The coupling fires during ordinary request paths, so the client cannot be
described as browser-free today. C1 must inject the observation and keep this function inside the
legacy adapter so `apps/eliotr-pwa` behavior holds.

No direct `fetch` exists in `pwa-source-workspace` or `pwa-research-workspace`; both route through
`requestApi`, `requestApiBytes`, `requestApiText`, `requestApiWithStatuses`.
`pwa-research-workspace/src/research-run-report.ts` imports `renderReadingMarkdown` from
`pwa-source-workspace`, which couples research to a source DOM renderer.

## 2. Windows, storage, timers

No `localStorage`, `sessionStorage`, `indexedDB`, cookie read or `location.assign` appears in either
legacy package. The browser surfaces actually used are window event listeners, `navigator.onLine`,
`crypto`, `setTimeout` and the Worker constructor.

Window event producers: `pwa-http-client/src/api.ts`, `pwa-source-workspace/src/source-namespace-panel.ts`,
`source-revisions-panel.ts`, `raw-file-panel.ts`, `erasure-panel.ts`.

Window event consumers:

- `bundle-import-panel.ts`: `authorization-cleared`, `offline`, `pagehide`
- `source-namespace-panel.ts`: `offline`, `authorization-cleared`, `pagehide`
- `source-revisions-panel.ts`: `offline`, `authorization-cleared`
- `erasure-panel.ts`: `offline`, `authorization-cleared`, `health-updated`, `pagehide`, plus
  `eliotr:health-lost` on the app element

## 3. DOM token counts per file

Scan hits in `packages/pwa-source-workspace/src`. Zero is asserted, not assumed.

| File | Hits | Class |
|---|---|---|
`bundle-import-api.ts` | 0 | API only |
`bundle-recovery-api.ts` | 0 | API only |
`document-reader-api.ts` | 0 | API only |
`erasure-api.ts` | 0 | API only |
`library-api.ts` | 0 | API only |
`library-readiness-api.ts` | 0 | API only |
`navigation-expand-api.ts` | 0 | API only |
`orientation-api.ts` | 0 | API only |
`project-api.ts` | 0 | API only |
`raw-file-api.ts` | 0 | API only |
`source-namespace-api.ts` | 0 | API only |
`source-revisions-api.ts` | 0 | API only |
`bundle-input.ts` | 0 | browser adapter |
`bundle-import.ts` | 1 | browser adapter, `signal.addEventListener` |
`api.ts` | 0 | legacy barrel |
`owner-session-api.ts` | 0 | legacy barrel |
`html.ts` | 0 | renderer |
`library-readiness-panel.ts` | 0 | renderer |
`raw-file-version-view.ts` | 5 | mixed |
`reading-markdown.worker.ts` | 2 | parser |
`source-revisions-panel.ts` | 12 | renderer |
`bundle-import-panel.ts` | 15 | renderer |
`orientation-panel.ts` | 51 | renderer |
`project-panel.ts` | 33 | renderer |
`raw-file-panel.ts` | 38 | renderer |
`library-panel.ts` | 39 | renderer |
`erasure-panel.ts` | 37 | renderer |
`source-namespace-panel.ts` | 44 | renderer |
`reading-markdown.ts` | 26 | mixed |

Three zero hit files are not API clients: `html.ts` and `library-readiness-panel.ts` generate HTML
strings, and `raw-file-version-view.ts` mixes value logic with `HTMLElement` writes.

## 4. Crypto, timers and randomness

| Site | API | Intent |
|---|---|---|
`document-reader-api.ts:37` | `crypto.subtle.digest` | content digest recheck after read |
`raw-file-api.ts:133` | `crypto.subtle.digest` | file content digest |
`bundle-input.ts:42` | `crypto.subtle.digest` | bundle file digest |
`erasure-panel.ts:321` | `crypto.randomUUID` | idempotency key |
`source-namespace-panel.ts:454` | `crypto.randomUUID` | attempt key |
`bundle-import-panel.ts:32,41,106` | `crypto.randomUUID` | idempotency key reset |
`bundle-import.ts:134` | `Date.now` | expiry check |
`bundle-import-api.ts:72` | `Date.now` | expiry check |
`bundle-recovery-api.ts:49` | `Date.now` | expiry check |
`reading-markdown.ts:137` | `window.setTimeout` | parser timeout |

`crypto.subtle` stays inside the client because it is a Web API the client legitimately uses, not a
DOM dependency. `crypto.randomUUID` inside panels is an idempotency source that must become an injected
identity provider in the client; today it is generated in presentation code.

## 5. Worker, File and Blob

`packages/pwa-source-workspace/package.json` declares `sideEffects` containing
`./src/reading-markdown.worker.ts`.
`reading-markdown.ts:95` constructs a module Worker from `import.meta.url` and calls
`window.setTimeout`, `worker.postMessage`, `worker.terminate`, `document.createElement`,
`document.createDocumentFragment`, and a `WeakMap` keyed by `HTMLElement`.

`bundle-input.ts` uses `File`, `file.webkitRelativePath`, `Blob`, `blob.arrayBuffer` and
`NormalizedBundleManifestSchema.parse`. It never touches `window`, `document` or any listener, so it
is a browser adapter rather than DOM code and may move with the import group.

## 6. Endpoint map

| Endpoint | Used by |
|---|---|
`/api/v1/system/health` | `pwa-http-client` |
`/api/v1/system/session` | `pwa-http-client` |
`/api/v1/library/content` | `document-reader-api` |
`/api/v1/library/readiness` | `library-readiness-api` |
`/api/v1/library/revisions` | `source-revisions-api` |
`/api/v1/library/namespaces` and `/{id}/renew` | `source-namespace-api` |
`/api/v1/library/erasure`, `/prepare`, `/{operationId}` | `erasure-api` |
`/api/v1/ingest/raw`, `/{capture}/markdown`, `/{capture}/admission`, `/admission/{operation}` | `raw-file-api` |
`/api/v1/ingest/bundles/prepare`, `/commit`, `/discover`, `/{operationId}` | `bundle-import-api`, `bundle-recovery-api` |
`/api/v1/research/catalog` | `library-api` |
`/api/v1/research/orient`, `/trace/{id}` | `orientation-api` |
`/api/v1/research/navigation/expand` | `navigation-expand-api` |
`/api/v1/research/projects` | `project-api` |

Research endpoints are grouped in `migration-groups.md`. The `pwa-research-workspace` records in
`module-inventory.json` are marked secondary because a line accurate scan of that package is not in
this claim's evidence.

## 7. Absent package

`pwa-knowledge-workspace` is named in `docs/adr/0015-browser-capability-libraries.md` and as a legal
dependency in `scripts/check-boundaries.mjs`, but it does not exist in the tree. It must not be created
to satisfy stale prose or a stale allowlist entry.

## 8. Unverified in this claim

PENDING: runtime, install, typecheck and test results. PENDING: line accurate scan of
`pwa-research-workspace`. PENDING: exact export names for `project-api`, `source-namespace-api`,
`erasure-api` and `navigation-expand-api`. PENDING: whether an unkeyed digest authority is an
acceptable threat model.
