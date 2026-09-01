# Contract compatibility policy

The compatibility registry is append-only. A current schema is identified by
`(export_name, schema_version, schema_generation)` and by its generation-specific `$id`.

## Change classes

- **INITIAL** — first published generated schema; it has no predecessor.
- **BACKWARD_COMPATIBLE** — old readers can safely interpret the new shape. Increment the family
  generation and point `supersedes_schema_id` to the previous entry.
- **BREAKING** — an old reader can reject or, worse, misinterpret the new shape. Increment the schema
  version, reset or explicitly advance the generation, and retain a migration note.
- **RETIRED** — the generation is no longer admitted as current. Retirement never deletes history.

Any generated JSON Schema byte change requires a new registry entry. Updating only the digest under an
existing version/generation is forbidden because it destroys reproducibility.

## Breaking changes

Treat a change as breaking when it can alter identity, authority, disclosure, retention, residency,
completion disposition, required evidence, effect permissions, or the meaning of an existing field.
Examples include removing or renaming a field, adding a required field, widening a closed enum, changing
a conditional invariant, weakening strict-object rejection, or changing canonical number/string rules.

An optional field is backward-compatible only when absence preserves the old meaning and old readers may
safely ignore it. Load-bearing optional fields normally require a new version or an explicitly gated
reader generation.

## Required evidence

Every schema change must include:

1. updated Zod and cross-field validation;
2. regenerated corpus and index;
3. an appended compatibility entry with a specific note;
4. canonical fixture review and a new fixture/digest when wire-visible bytes change;
5. positive JSON round-trip and negative unknown/forbidden-value tests;
6. T0/T1, plus T2/T3/T4/T5 where the changed contract affects models, retrieval, platform behavior,
   security, erasure or recovery.

Transport completion and research completion remain independent. A transport state such as `COMPLETED`
may never be added to `CompletionDispositionSchema` as a convenience mapping.
