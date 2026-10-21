# Historical browser-transport audit — 2026-10-08

This audit informed the current owner client but is no longer its specification. ER-48 assignments and the old
`pwa-http-client` baseline are dated evidence.

Use live `packages/owner-api-client`, the [code map](dependency-map.md), [runtime boundaries](runtime-contract.md),
[security checklist](security-checklist.md) and [React app rules](../../apps/eliotr-web/AGENTS.md). Preserve the real
properties already selected: same-origin bounded requests, manual redirects, explicit content/body limits, typed
failures, strict mutation identity/reconciliation, one authorization epoch, injected transport dependencies and
separate JSON/binary/range handling. Do not preserve the global browser event bus or duplicate transport/client
lifetimes merely because the predecessor audit named them.

The original audit remains in
[Git history](https://github.com/UnknownAlienHuman/eliot-research/blob/5dec2fae1a86b2a7cf7bb00703b6976665aab847/docs/implementation/frontend-transport-audit-2026-10-08.md).
