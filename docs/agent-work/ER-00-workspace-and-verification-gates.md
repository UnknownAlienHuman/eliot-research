# ER-00: Workspace and verification gates

**Slice:** 0
**Depends on:** none
**Live gate:** none

## Objective

Own the repository bootstrap and migration M1 without moving product authority prematurely. This packet
keeps the TypeScript/Cloudflare application intact while introducing a pinned Rust deterministic-kernel
workspace, shared differential vectors, and mechanical merge/deep-verification gates.

## Owned paths

- `package.json`
- `pnpm-workspace.yaml`
- `pnpm-lock.yaml`
- `tsconfig.json`
- `tsconfig.base.json`
- `eslint.config.mjs`
- `vitest.config.ts`
- `.editorconfig`
- `.npmrc`
- `.gitignore`
- `.github/**`
- `Cargo.toml`
- `Cargo.lock`
- `rust-toolchain.toml`
- `deny.toml`
- `.config/nextest.toml`
- `crates/README.md`
- `crates/eliotr-canonical/**`
- `crates/eliotr-test-vectors/**`
- `crates/eliotr-kernel-wasm/**`
- `fuzz/**`
- `scripts/check-boundaries.mjs`
- `scripts/test-boundary-negative.mjs`
- `scripts/check-budgets.mjs`
- `scripts/check-contract-fixtures.mjs`
- `scripts/check-work-packets.mjs`
- `scripts/check-rust-boundaries.mjs`
- `scripts/check-rust-vectors.mjs`
- `scripts/check-rust-wasm.mjs`
- `docs/agent-work/manifest.json`
- `docs/agent-work/ER-00-workspace-and-verification-gates.md`
- `docs/implementation/toolchain.md`
- `docs/implementation/production-readiness-plan.md`
- `docs/implementation/gap-register.md`
- `scripts/check-implementation-status.mjs`

## Read only

- `README.md`
- `IMPLEMENTATION.md`
- `docs/architecture/ELIOT_RESEARCH.md`
- `docs/architecture/LANGUAGE_RUNTIME_CONTRACT.md`
- `docs/implementation/branch-discipline.md`
- `docs/implementation/implementation-status.json`
- every other packet document used by the exact manifest-parity check

## Architecture extracts

- language/runtime contract: principles, target layout, M1, CI, portability and unsafe policy
- production-readiness plan: Phase 2 / M1
- implementation entry point: workspace, package boundaries, source budgets and frozen installs

## Required implementation

- Preserve the frozen pnpm/TypeScript/Cloudflare workspace and existing deterministic gates.
- Pin Rust, Cargo resolver, Wasm target, nextest, deny, llvm-cov, Miri, fuzz and mutation tools.
- Introduce only the M1 crates: bounded UTF-8 transport validation, strict shared vectors and a portable
  Rust/Wasm shell.
- Execute the exact committed vector bytes through TypeScript, native Rust and compiled Rust/Wasm.
- Keep the default Wasm build free of product ABI exports; the scalar M1 self-test is feature-gated.
- Enforce pure-core exclusions for I/O, clocks, environment, randomness and platform runtime imports.
- Compare every packet document's `## Owned paths` section exactly against the machine scheduler.
- Run merge-blocking format, lint, native tests, doctests, dependency policy, Wasm, size and coverage
  gates; schedule pinned Miri, fuzz and mutation jobs.
- Update readiness documentation without claiming M2 canonical JSON or any live qualification.

## Acceptance

- `pnpm install --frozen-lockfile` and both Cargo lockfiles are reproducible.
- `pnpm work-packets:check` rejects any manifest/document ownership drift and any overlap or DAG error.
- The ER-17 production and test paths agree exactly across both scheduler representations.
- `pnpm boundaries:negative` injects a forbidden import and proves the existing boundary gate fails.
- Strict malformed/unknown/duplicate vector cases fail in both TypeScript and Rust parsers.
- `cargo fmt --all --check` passes.
- `cargo clippy --workspace --all-targets --all-features --locked -- -D warnings` passes.
- `cargo nextest run --workspace --all-features --locked` and Rust doctests pass.
- `cargo deny check` passes.
- The workspace builds for `wasm32-unknown-unknown`; the feature-gated Wasm self-test executes with zero
  imports and stays within the compressed M1 budget.
- Deterministic-core coverage is at least 90% with branch instrumentation.
- No TypeScript authority is removed, no product route changes, and no live platform gate is implied.

## Mandatory negative boundary

Create a temporary `node:fs/promises` import inside `packages/domain`, run the real package-boundary gate,
and prove it exits nonzero before deleting the fixture. Mutate the shared fixture protocol, error code and
case identity and prove both strict parsers reject the malformed frame.

## Handoff contract

Produce:

- frozen TypeScript and Rust toolchain registry;
- exact packet-document/scheduler parity gate;
- M1 Cargo workspace and lockfiles;
- strict versioned vector corpus consumed by TypeScript, native Rust and Rust/Wasm;
- merge-blocking Rust CI plus pinned scheduled Miri/fuzz/mutation verification;
- updated readiness record that leaves M2–M7 and all live receipts explicitly open.

The PR must state contract/generation impact, exact commands, negative-case results, Wasm size, coverage,
and live receipts (`NOT EXECUTED`). Do not mark M1 complete with a missing lockfile, skipped target,
unbounded parser, mocked Wasm execution, or product ABI/authority promotion.
