# Legacy contract artifacts

This directory belongs to the predecessor application retained at
[`main@7c034569`](https://github.com/UnknownAlienHuman/eliot-research/tree/7c034569b908d3b03a8b821b7c537477a24b10f7).
It remains in the branch only while the predecessor workspace, tests and CI still consume its generated schemas and
fixtures. It is **not** canonical product documentation, target runtime authority or a roadmap for the replacement.

Current replacement decisions live in [Architecture](../ARCHITECTURE.md),
[Implementation](../IMPLEMENTATION.md), [MAP](../MAP.md) and [Donors](../DONORS.md).
[MAP stage 0](../MAP.md#delivery-order) traces the final consumers and removes the old contract/status checks together
with the active legacy workspace. Do not delete the generated files earlier: they may still be needed to decode and
verify predecessor data during migration.

## Retained predecessor fixtures

- `schema-corpus.v1.json` and `schema-index.v1.json` — generated structural schemas and identities;
- `compatibility-registry.v1.json` — predecessor compatibility history;
- `canonical-fixtures.v1.json` and `fixtures/` — exact legacy examples and digests;
- `compatibility.md` — historical predecessor policy, preserved through a pinned source link;
- `generate.mjs` — the predecessor generator used by `@eliotr/contracts`.

These artifacts describe old wire shapes. They do not require the replacement to keep the old registry, generations,
qualification programme, Rust canonicalization plan or compatibility bureaucracy. Target contracts are implemented at
the replacement's actual external boundaries and versioned only when a real compatibility requirement exists.

## Maintenance before retirement

Change or regenerate this directory only when repairing the predecessor before cutover. In that exceptional case, keep
`packages/contracts`, generated artifacts and compatibility history mutually consistent and use the old package commands:

```bash
pnpm --filter @eliotr/contracts artifacts:check
pnpm --filter @eliotr/contracts artifacts:write
```

Do not use those commands as acceptance for the replacement. A documentation-only change must not rewrite generated
fixtures, and new replacement work must not append entries to the legacy registry.
