# Public contract artifacts

`packages/contracts/src` is the runtime authority for public wire structure and semantic validation.
Registry tooling is exported separately through `@eliotr/contracts/registry`, so normal Worker and PWA
imports do not construct the schema corpus. This directory contains deterministic, reviewable artifacts
derived from that tooling boundary.

## Committed artifacts

- `schema-corpus.v1.json` — one Draft 2020-12 document for every public Zod schema;
- `schema-index.v1.json` — stable schema identity, family, version, generation, structural class and
  SHA-256 of each compact canonical JSON Schema document;
- `compatibility-registry.v1.json` — append-only compatibility history;
- `canonical-fixtures.v1.json` — exact committed normative fixture paths and byte digests;
- `compatibility.md` — the change and migration policy.

Every generated object schema with declared properties must be closed with
`additionalProperties: false`. Explicit record/map schemas remain open only through a declared
`additionalProperties` value schema. Registry identities fail closed when the URN disagrees with the
entry's family, export name, version or generation.

## Authority boundary

Generated JSON Schema is a structural interchange artifact. It does not replace Zod `superRefine`,
`packages/contracts/src/validation/cross-field.ts`, or any domain invariant. Cutover agreement,
coverage closure, research disposition, erasure closure and similar semantic rules must still pass the
runtime validators.

No artifact in this directory moves canonical serialization or domain authority into Rust. M2 starts
only after this registry is merged and its fixture identities are available for differential tests.

## Regeneration

```bash
pnpm --filter @eliotr/contracts artifacts:check
pnpm --filter @eliotr/contracts artifacts:write
```

`artifacts:write` rewrites derived corpus/index/fixture files but deliberately refuses to invent or
rewrite compatibility history. A schema change must first make an explicit version/generation decision
and append the corresponding compatibility entry.

`--bootstrap` is reserved for the initial ER-01 publication and must not be used after
`compatibility-registry.v1.json` exists.
