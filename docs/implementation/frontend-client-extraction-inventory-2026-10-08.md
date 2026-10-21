# Historical owner-client extraction inventory — 2026-10-08

This inventory predates the current `@eliotr/owner-api-client`, shared React transport and live caller migrations. Its
ER-47/48 ownership and U3–U6 work assignments are historical, not current implementation instructions.

Use the [code map](dependency-map.md), [frontend cutover](frontend-platform-migration.md), live
`packages/owner-api-client` source and [React app rules](../../apps/eliotr-web/AGENTS.md). The retained principle is
one injected owner client, typed bounded methods, one authorization/session epoch and no feature-local `fetch`, global
auth event bus or duplicated decoders. Move remaining legacy callers with their real behavior, then delete their old
packages; do not recreate the old extraction matrix.

The original inventory remains in
[Git history](https://github.com/UnknownAlienHuman/eliot-research/blob/5dec2fae1a86b2a7cf7bb00703b6976665aab847/docs/implementation/frontend-client-extraction-inventory-2026-10-08.md).
