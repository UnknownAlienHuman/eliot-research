# domain

Pure domain logic: source identity and revisions, scope algebra, project membership, readiness state,
investigation and hypothesis state machines, coverage accounting.

- **Owns:** deterministic rules and invariants.
- **Must not own:** I/O, bindings, model calls, vendor SDKs.
