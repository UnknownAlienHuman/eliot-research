# contracts

Versioned wire and domain contracts shared by every other package, including the federation contract that
ELIOT Memory OS already owns.

- **Owns:** request and response shapes, dispositions, receipts, evidence handles, scope expressions,
  schema identities, canonical fixture metadata and compatibility history.
- **Must not own:** platform bindings, vendor clients, policy decisions or Rust domain authority.

## Public schema authority

Every public Zod schema is discovered by the tooling-only registry and receives a stable family, version,
generation and URN. Import registry tooling explicitly from `@eliotr/contracts/registry`; the primary
`@eliotr/contracts` entrypoint does not evaluate JSON Schema generation in Worker or PWA product paths.
The committed Draft 2020-12 corpus under `docs/contracts/` is generated from that registry.

Object contracts are closed. Open maps must be represented explicitly with a record schema rather than
an omitted strictness decision. A schema ID is admitted only when it encodes the same family, export name,
version and generation as the surrounding registry entry.

Generated JSON Schema is the structural interchange artifact. Zod parsing and cross-field validators
remain authoritative for semantic refinements that JSON Schema cannot represent exactly.

## Commands

```bash
pnpm --filter @eliotr/contracts artifacts:write
pnpm --filter @eliotr/contracts artifacts:check
pnpm exec vitest run packages/contracts --reporter=verbose
```

`artifacts:write` rewrites only derived corpus, index and canonical-fixture files. It does not rewrite
compatibility history. A schema change must update its version or family generation and append an explicit
compatibility entry before artifact verification can pass.

The federation types are implemented against the existing ELIOT contract fixtures. The cloud side does
not invent a more convenient alternative shape.
