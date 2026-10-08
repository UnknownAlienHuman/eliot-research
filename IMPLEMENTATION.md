# Implementation entry point

The repository is under active implementation and is not production-ready.

Start with:

1. [`docs/START-HERE.md`](docs/START-HERE.md) — the repository router and authority order.
2. [`docs/implementation/backend-entrypoints.md`](docs/implementation/backend-entrypoints.md) — the
   current backend wave, one-worktree-per-manager protocol, integrator path and review checklist.
3. The assigned PR/passport, owning ER packet and only the architecture sections named by that packet.

Do **not** use `docs/implementation/backend-delivery-plan.md` as the current queue. It records the paused
October 6 checkpoint and remains historical evidence.

## Current execution model

- one worktree per manager;
- one bounded checkpoint per manager at a time;
- one named integrator serializes shared contracts, composition, migrations, manifests, barrels,
  lockfiles, generated bindings and CI;
- no force-push over concurrent work;
- code first during assembly: compile and scoped lint, plus minimal Clippy for Rust;
- broad tests/native/live acceptance after assembled product code, unless the active PR requires a
  narrow reproduction;
- every unexecuted gate is `PENDING`, never implied `PASS`.

## Essential authorities

- [Current backend entry points](docs/implementation/backend-entrypoints.md)
- [Final PR disposition matrix](.github/audits/2026-10-08/FINAL-PR-DISPOSITION-MATRIX.md)
- [Cloudflare/Eliot ownership](.github/audits/2026-10-08/CLOUDFLARE-NATIVE-OWNERSHIP.md)
- [Backend audit completion marker](.github/audits/2026-10-08/BACKEND-AUDIT-PREPARATION-COMPLETE.md)
- [Implementation status](docs/implementation/implementation-status.json)
- [Gap register](docs/implementation/gap-register.md)
- [Work-packet ownership](docs/agent-work/README.md)
- [Product architecture](docs/architecture/ELIOT_RESEARCH.md)
- [Language/runtime ownership](docs/architecture/LANGUAGE_RUNTIME_CONTRACT.md)
- [Branch/worktree discipline](docs/implementation/branch-discipline.md)
- [Scoped verification](docs/implementation/scoped-verification.md)
- [Production readiness](docs/implementation/production-readiness-plan.md)

## Completion standard

A checkpoint is not complete because a DTO exists, a package compiles, a provider returned 200, a
Workflow reached a terminal state or a wrapper was added.

The implementation must identify:

```text
migrated callers
removed duplicate functions/branches/engines
legacy codec compatibility
net production LOC/bundle delta
D1/R2/provider-call delta
negative/replay/lost-ACK/bound evidence
remaining compiler/test/native/live gates
```

Every mutation retains:

```text
Intent → Attempt → Receipt → Readback → Reconciliation
```

A production declaration still requires the complete ordered acceptance in the production-readiness
plan. Backend audit preparation is complete; implementation and release acceptance are not.
