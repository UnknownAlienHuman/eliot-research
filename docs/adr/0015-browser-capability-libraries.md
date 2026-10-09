# ADR-0015: Browser capability libraries

- Status: accepted for legacy PWA source organization; qualified by ADR-0016/0017 for the React migration.
- Date: 2026-10-04.
- Applicability review: 2026-10-08 against main `3e6c25660c1ae515760e19d5f9e6b8a735795c4c`.
- Scope: source organization of the existing static PWA and migration source material.

## Context

The legacy PWA contains source/library, research/evidence, and knowledge/connection features alongside
application composition. Keeping every feature in the application directory obscured capability boundaries
and exceeded source-maintainability budgets. The owner requested completion within the existing Cloudflare
deployment and Google Design interface.

## Decision

The following browser-only library roles were authorized for the legacy static build:

| Library role | Materialized package in reviewed main | Responsibility | Allowed internal dependencies |
| --- | --- | --- | --- |
| `pwa-http-client` | yes | bounded HTTPS envelopes, transport errors, owner-session decoding | `contracts` |
| `pwa-source-workspace` | yes | projects, source ingestion, library, document reading, erasure UI and legacy HTML helpers | `contracts`, `pwa-http-client` |
| `pwa-research-workspace` | yes | research configuration, runs, retrieval, evidence and changes UI | `contracts`, `pwa-http-client`, `pwa-source-workspace` |
| `pwa-knowledge-workspace` | **no** | proposed Wiki/connection diagnostics split | would have used `contracts`, `pwa-http-client`, `pwa-source-workspace` |

`pwa-knowledge-workspace` was an allowed target name, not evidence that a package exists. It was not present
in the reviewed main tree. Agents must not create it merely to make old prose true. Wiki and connection code
is inventoried from its actual current paths and moves through ER-48/ER-47 only when required by an accepted
slice.

For the legacy application, `apps/eliotr-pwa` remains the composition root for mounting, owner-session
lifecycle, navigation, theme and styles. A browser library is not a service or authority. It may request only
the authorized HTTPS API and may not import Worker/backend libraries, bindings, infrastructure credentials or
a second authentication implementation. The Source library may retain the existing bounded Markdown parser
and document-reading worker during compatibility migration.

The separate `/agent-inbox` entry stays standalone with its no-import/no-persistence constraints. Browser
library extraction must not couple its bundle/session to the owner workspace. Existing package/file/source-
byte budgets remain; tests stay with their capability, and compatibility exports may preserve current callers
while migration is incomplete.

## ADR-0016 migration qualification

ADR-0016 does not require preserving the legacy imperative rendering architecture.

- `pwa-http-client`, `pwa-source-workspace`, and `pwa-research-workspace` are migration source material, not
  approved React dependencies as package roots.
- ER-48 extracts one side-effect-free `owner-api-client` and retains legacy adapters until cutover.
- ER-47 imports only the new owner client/contracts plus `@eliotr/ui`; it does not wrap panel renderers,
  legacy HTML helpers, global events, styles or DOM ownership.
- The absent knowledge package remains absent unless a future separately accepted architecture gives it a
  real consumer and ownership reason.
- U7 may remove the compatibility browser packages after every caller/test is dispositioned; historical
  records retain the original package names.

## Validation

For legacy extraction, record exact moved files and byte-equivalence where behavior is unchanged. Compile the
affected packages/PWA, check finite imports, and run transport/source/research/inbox acceptance.

For React migration, use ER-48 characterization/extraction tests, ER-47 bundle-graph prohibition of legacy
roots, browser parity, and final U7 caller/removal inventory. Production bundle, responsive, CSP, lifecycle
and browser checks remain release criteria. No package is considered implemented because it appears in this
ADR.
