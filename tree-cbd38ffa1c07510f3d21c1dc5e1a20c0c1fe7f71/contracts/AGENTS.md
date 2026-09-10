# Agent ER-01 — contracts

<<<<<<< HEAD
Read `docs/agent-work/ER-01-versioned-contracts-and-schemas.md`. This package owns every public wire
shape, closed enum, schema identity and compatibility entry. Do not import platform code. Schemas are
strict: unknown load-bearing fields fail closed. A field change requires an explicit version or generation
decision, regenerated JSON Schema, canonical fixture review, compatibility note and T0/T1 tests.
=======
Read `docs/agent-work/ER-01-contracts.md`. Own every public wire shape/closed enum; no platform imports.
Strict schemas fail closed on unknown load-bearing fields. Field changes require protocol/generation bump,
fixture update, compatibility note, and T0/T1 tests.
>>>>>>> docs/agents-compaction-20260907
