> **Legacy (pre-replacement).** This file describes the old system, kept only as donor and data-import material.
> It is not an instruction for current work — see [AGENTS.md](../../AGENTS.md) and `docs/`.

# domain

Pure domain logic: source identity and revisions, scope algebra, project membership, readiness state,
investigation and hypothesis state machines, coverage accounting.

- **Owns:** deterministic rules and invariants.
- **Must not own:** I/O, bindings, model calls, vendor SDKs.
