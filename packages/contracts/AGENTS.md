# Agent ER-01 — contracts

Read `docs/agent-work/ER-01-versioned-contracts-and-schemas.md`. This package owns every public wire
shape, closed enum, schema identity and compatibility entry. Do not import platform code. Schemas are
strict: unknown load-bearing fields fail closed. A field change requires an explicit version or generation
decision, regenerated JSON Schema, canonical fixture review, compatibility note and T0/T1 tests.
