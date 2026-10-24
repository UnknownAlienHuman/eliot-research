# Legacy predecessor contracts package

This package belongs to the predecessor application retained at
[`main@7c034569`](https://github.com/UnknownAlienHuman/eliot-research/tree/7c034569b908d3b03a8b821b7c537477a24b10f7).
It remains buildable only while old applications, migration readers and compatibility checks still consume its wire
shapes. It is not a dependency or architectural authority for the replacement root application.

Current replacement decisions live in [Architecture](../../docs/ARCHITECTURE.md),
[Implementation](../../docs/IMPLEMENTATION.md), [MAP](../../docs/MAP.md) and
[Donors](../../docs/DONORS.md). [MAP stage 0](../../docs/MAP.md#delivery-order) removes this package from active workspace
membership after its last decode/import consumers are traced. New `src/` code must not import `@eliotr/contracts` merely
to preserve the old layer structure.

## Predecessor responsibility

For the old application only, this package owns the Zod request/response shapes, dispositions, evidence handles, scope
expressions and generated registry inputs used by the existing `apps/*` and `packages/*` tree. Platform bindings and
vendor clients remain outside it. The generated files under [`docs/contracts`](../../docs/contracts/README.md) are legacy
structural interchange and migration fixtures; they do not move target product authority into a schema registry or Rust.

## Maintenance before retirement

Use these commands only when repairing a pre-cutover predecessor contract:

```bash
pnpm --filter @eliotr/contracts artifacts:write
pnpm --filter @eliotr/contracts artifacts:check
pnpm exec vitest run packages/contracts --reporter=verbose
```

Keep old Zod code, generated artifacts and compatibility history consistent for such a repair. Do not append replacement
schemas, qualification state or roadmap generations here, and do not treat a passing predecessor check as evidence that
the replacement compiles or works.
