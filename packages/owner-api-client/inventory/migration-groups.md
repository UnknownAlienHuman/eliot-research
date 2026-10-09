# Migration grouping for the owner API client

**Baseline:** `0b7c307e9e7c267bda712e6ae41b87b555e9fc01`
**Claim:** `f956b8d2360657052c277938561df31b33602437` (history base `c37e56e0`)
**Owner paths, ER-48:** `packages/owner-api-client/**`, `packages/pwa-http-client/**`,
`packages/pwa-source-workspace/**`, `packages/pwa-research-workspace/**`,
`docs/agent-work/frontend-owner-claims/ER-48/**`.

## 1. Decision rule

A module is pure only when the DOM token scan is zero and reading it confirms no `window`,
`document`, listener, storage, Worker or timer use. Filenames and the declared `sideEffects`
metadata are not evidence.

## 2. Groups for U3 wiring, Sources first

### G1 transport and session seam, C1, blocks the rest

`pwa-http-client/src/api.ts`, `pwa-http-client/src/owner-session-api.ts`

Two modules with one goal. Replace `notifyAuthorizationCleared` with an injected
`onAuthorizationLoss` observation on a client object, keep every exported decoder, bound, status
policy and error vocabulary unchanged, and leave window event emission in the legacy adapter.

Acceptance: import under Node with no `window` creates no effect, one dispatched event per epoch,
and a late old epoch observation cannot clear a newly verified session.

### G2 Sources library and readiness, C2-L and C2-R

`library-api.ts`, `library-readiness-api.ts`, `source-revisions-api.ts`

Move with no change beyond importing the new transport. Panels switch to compatibility imports and
React consumes nothing until equivalence tests pass.

### G3 Sources projects and namespaces, C2-L and C2-N

`project-api.ts`, `source-namespace-api.ts`

Both carry guarded mutations. The namespace group is the only Sources group that reads session state
directly, so it must land after G1.

### G4 Sources import, capture and admission, C2-I

`bundle-import-api.ts`, `bundle-recovery-api.ts`, `raw-file-api.ts`, `bundle-input.ts`,
`bundle-import.ts`

`bundle-import.ts` already accepts an injected transport and uses `Date.now` expiry checks rather than
a global clock, so it is the natural extraction shape. `bundle-input.ts` is a browser adapter over
`File` and `Blob` with no DOM access.

Keep capture, conversion, admission, readiness and scope as five distinct states. Never auto select
or auto add an admitted source to the current or historical run scope.

Split `raw-file-version-view.ts`: value and copy helpers move to `sources/import`, and
`renderSourceVersionTarget` stays legacy.

### G5 Sources document, navigation and orientation, C2-D

`document-reader-api.ts`, `navigation-expand-api.ts`, `orientation-api.ts`

`document-reader-api` owns the immutable representation contract: exact revision header, deployment
generation, content length, and SHA-256 digest. Without a strong validator and conditional support the
feature uses bounded whole read, never a range fallback. `navigation-expand` imports
`orientation-api`, so the pair moves together.

### G6 Sources erasure, C2-E

`erasure-api.ts`

Two mutations plus a status read. Partial, held, quarantined or revoked erasure can never present as
complete. Idempotency identity currently originates in the erasure panel `crypto.randomUUID` and must
become an injected identity provider.

## 3. Groups for later wiring, C3

### G7 Research runs and configuration, C3-RC, C3-RR, C3-RH

`research-configuration-api.ts`, `research-model-configuration-api.ts`, `research-run-api.ts`,
`research-changes-api.ts`

Canonical HTTP status, history and readback remain the authority for progress, failure and report
reconciliation. `research-run-api` must drop its duplicated transport and global event behavior.

### G8 Studio, wiki and connections, C3-S and C3-C

`artifact-product-api.ts`, `wiki-proposal-create-api.ts`, `artifact-product-controls.ts`,
`research-run-connection.ts`, `research-markdown-download.ts`

Split each mixed file. Pure value, manifest and byte construction enter the client, while DOM control,
download trigger and focus restoration stay legacy until React equivalents are accepted.

### G9 Research session projection, C3-RP

See `research-session-projection.md`. The `AgentClient` callable adapter is the only transport
specific submodule and must not leak into HTTP only consumers or UI components.

## 4. Legacy only, never moved

```text
pwa-source-workspace:
  library-panel.ts, source-namespace-panel.ts, project-panel.ts, orientation-panel.ts,
  erasure-panel.ts, raw-file-panel.ts, bundle-import-panel.ts, source-revisions-panel.ts,
  library-readiness-panel.ts, raw-file-version-view.ts render half, html.ts,
  reading-markdown.ts DOM half, reading-markdown.worker.ts DOM coupled entry

pwa-research-workspace:
  research-run-panel.ts, research-changes-panel.ts, research-configuration-panel.ts,
  research-model-configuration-panel.ts, research-run-report.ts DOM half,
  research-markdown-download.ts trigger half, artifact-product-controls.ts DOM half
```

Their accepted behavior is input to ER-47 tests. Their renderer and lifecycle are never wrapped inside
React effects.

## 5. Legacy barrels preserved, not deleted

`pwa-source-workspace/src/api.ts` and `owner-session-api.ts` are one line `export * from
"@eliotr/pwa-http-client"` re-exports consumed by the legacy app. They stay until every consumer has
been repointed past them. Afterward `index.ts` silently omits moved exports. Wholesale barrel removal
is not part of any group above.

## 6. ER-00 B-C handoff, registration is not in ER-48

Writing `packages/owner-api-client/**` does not integrate it. ER-00 must add the lockfile entry, root
TypeScript references, a `check-boundaries.mjs` row, root scripts and an unknown package negative test
before C1 relies on root gates. The current allowlist for `packages/pwa-http-client` is
`@eliotr/contracts` only, so the new package needs its own row with the same or narrower allowlist.

## 7. Ordering

```text
C0.1 inventory
  then C0.2 transport characterization
  then C0.3 source and research characterization
  then C0.4 package local skeleton
  then ER-00 B-C registration
  then C1 seam
  then G2 and G3
  then G4 and G5
  then G6
  then ER-47 U3
  then G7, G8 and G9
  then C5 retirement after U6
```

C0 and C1 block real API wiring. U1 and U2 fixture presentation proceeds independently.

## 8. PENDING in this claim

PENDING: runtime, install, typecheck and test results. PENDING: exact export names for `project-api`,
`source-namespace-api`, `erasure-api` and `navigation-expand-api`. PENDING: line accurate scan of
`pwa-research-workspace`. PENDING: ER-49 and manager claim status for any leaf beyond C0.1.
