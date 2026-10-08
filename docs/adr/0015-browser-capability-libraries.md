# ADR-0015: Browser capability libraries

- Status: accepted for the owner-directed implementation assembly.
- Date: 2026-10-04.
- Scope: source organization of the existing static PWA.

## Context

The PWA contains source/library, research/evidence, and knowledge/connection features
alongside application composition. Keeping every feature in the application directory
obscures capability boundaries and exceeds its source-maintainability budget. The owner
requested completion of the product within the existing Cloudflare deployment and Google
Design interface.

## Decision

The following browser-only libraries may participate in the existing static asset build:

| Library | Responsibility | Allowed internal dependencies |
| --- | --- | --- |
| `pwa-http-client` | Bounded HTTPS envelopes, transport errors, owner-session decoding | `contracts` |
| `pwa-source-workspace` | Projects, source ingestion, library, document reading, erasure UI, shared HTML escaping | `contracts`, `pwa-http-client` |
| `pwa-research-workspace` | Research configuration, runs, retrieval, evidence, changes UI | `contracts`, `pwa-http-client`, `pwa-source-workspace` |
| `pwa-knowledge-workspace` | Wiki and connection diagnostics UI | `contracts`, `pwa-http-client`, `pwa-source-workspace` |

The application remains the composition root for mounting, owner-session lifecycle,
navigation, theme, and styles. A library is not a service or authority. It may request only
the existing authorized HTTPS API and may not import Worker/backend libraries, bindings,
infrastructure credentials, or a second authentication implementation. The Source library
may retain the existing `markdown-it` browser parser and its document-reading worker.

The separate `/agent-inbox` entry stays standalone, with its existing no-import and
no-persistence constraints. Browser library extraction must not couple its bundle or session
to the owner workspace. Existing package/file/source-byte budgets remain unchanged; tests
stay with their capability, and compatibility exports may preserve current callers during
the assembly.

## Validation

Record exact moved files and byte-equivalence of unchanged implementations. Compile the
affected libraries and PWA, check the finite import allowlist, then run existing transport,
source, research, and standalone-inbox acceptance checks after assembly. Production bundle
and responsive browser checks remain release criteria.
