# contracts

Versioned wire and domain contracts shared by every other package, including the federation contract that
ELIOT Memory OS already owns.

- **Owns:** request and response shapes, dispositions, receipts, evidence handles, scope expressions,
  schema identities, canonical fixture metadata and compatibility history.
- **Must not own:** platform bindings, vendor clients, policy decisions or Rust domain authority.

## Public schema authority

Every exported Zod schema is discovered by `schema-registry.ts` and receives a stable family, version,
generation and URN. The committed Draft 2020-12 corpus under `docs/contracts/` is generated from that
runtime registry. Object contracts are closed; open maps must be represented explicitly with a record
schema rather than an omitted strictness decision.

Generated JSON Schema is the structural interchange artifact. Zod parsing and cross-field validators
remain authoritative for semantic refinements that JSON Schema cannot represent exactly.

## Commands

```bash
pnpm --filter @eliotr/contracts artifacts:write
pnpm --filter @eliotr/contracts artifacts:check
pnpm exec vitest run packages/contracts --reporter=verbose
```

`artifacts:write` does not rewrite compatibility history. A schema change must update its version or
family generation and append an explicit compatibility entry before artifact verification can pass.

The federation types are implemented against the existing ELIOT contract fixtures. The cloud side does
not invent a more convenient alternative shape.
