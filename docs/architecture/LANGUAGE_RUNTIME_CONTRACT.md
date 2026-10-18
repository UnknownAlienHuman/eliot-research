# Language and runtime boundaries

Updated 2026-10-17. Apply the [current architecture](ELIOT_RESEARCH.md).
This replaces the old all-family port programme and universal hashed Wasm envelope.
It changes development requirements, not deployed ABI or stored data by itself.

| Language | Responsibility |
|---|---|
| TypeScript | Worker/React composition, platform bindings, I/O, routes, Workflows and currently active application logic |
| Rust | Selected pure algorithms/decisions with an actual product caller; no mandatory port of every rule |
| SQL | Schema, indexes, relational constraints and atomic expected-state changes |

Keep the existing stack and one Worker. A language preference does not require another service,
17 crates, a mirrored package hierarchy or two maintained implementations of the same decision.
At source baseline `4e53d5e2`, the existing Rust workspace has no Worker product ABI caller;
self-tests and vectors are not a completed integration.

## Rust and Wasm

Add a needed operation to a coherent existing module. Its input and output are the data it actually uses.
A pure function has no hidden network/filesystem/clock/randomness/Cloudflare state; pass such values only
when the operation needs them. Do not add policy snapshots or timestamps to unrelated calls.

A Wasm boundary needs a concrete function, bounded input/output, memory ownership and typed errors.
It does not need per-call `input_sha256`, `output_sha256`, `schema_generation`, a signed receipt,
a generic operation registry or a protocol for every local function. Keep versioning only at an actual
incompatible persisted/external ABI boundary; code built and deployed together changes together.

Implement the operation, bridge and real Worker caller in one integration and remove the replaced TS
decision and bridge copies there. Compile/lint during development; verify the assembled path before deployment.
Do not preserve old behavior solely to make obsolete fixtures pass. Existing persisted identities are
migrated deliberately rather than silently reinterpreted. No shadow execution or new parity framework.

Use safe Rust by default and the existing error conventions. Do not add a native verifier CLI, mutation
campaign, coverage percentage, Miri/semver gate or all-workspace test programme as a prerequisite to useful code.
Run scoped compilation and minimal Clippy for the actual changed crate during this implementation phase.

## TypeScript and SQL

Validate untrusted wire data at ingress; internal callers use typed values. Reuse the one owner client
and the existing provider adapters. Do not create an adapter/port/repository per function or wrap a library
without removing a concrete duplication. Platform types follow the installed toolchain, not a copied SDK.

Keep uniqueness, foreign keys and expected-revision predicates in D1. A pure preflight cannot replace an
atomic concurrency check. Keep dependent writes conditional on that check; no external effects in a D1 batch.
Do not duplicate a domain interpreter in JSON-heavy views/triggers, or add a table for each validation stage.
Applied migrations require a data-safe transition; unapplied prototypes are not immutable because they merged.

Secrets, Access verification and content checksums use supported platform/library primitives. No bespoke
cryptography or universal canonicalization/proof machinery. An unavailable read is unknown, not successful
verification. Consult [the implementation plan](../implementation/backend-entrypoints.md) for selected changes.
