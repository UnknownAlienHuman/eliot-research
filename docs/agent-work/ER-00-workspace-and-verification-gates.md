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
- `packages/cloudflare-federation/package.json`
- `packages/cloudflare-federation/tsconfig.json`
- `packages/cloudflare-federation/AGENTS.md`
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
- `scripts/check-boundaries.mjs`
- `scripts/test-boundary-negative.mjs`
- `scripts/check-budgets.mjs`
- `scripts/check-contract-fixtures.mjs`
- `scripts/check-work-packets.mjs`
- `scripts/check-rust-boundaries.mjs`
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
- every other packet document

## Architecture extracts

- language/runtime contract: principles, target layout, M1, CI, portability and unsafe policy
- production-readiness plan: Phase 2 / M1
- implementation entry point: workspace, package boundaries, source budgets and frozen installs

## Required implementation

- Preserve the frozen pnpm/TypeScript/Cloudflare workspace and existing deterministic gates.
- Pin Rust, Cargo resolver, Wasm target, nextest, deny, llvm-cov, Miri, fuzz and mutation tools.
- Introduce only the M1 crates: bounded UTF-8 transport validation, strict shared vectors and a portable
  Rust/Wasm shell.
- Bound the shared frame, case count, case identity and decoded payloads before allocation; represent
  `max_bytes` as one canonical unsigned 32-bit value in TypeScript, native Rust and Rust/Wasm.
- Execute the exact committed vector bytes through TypeScript, native Rust and compiled Rust/Wasm.
- Inspect the default Wasm artifact before the feature build overwrites it; keep it free of product ABI
  exports and keep the scalar M1 self-test feature-gated.
- Enforce pure-core exclusions for I/O, clocks, environment, randomness and platform runtime imports.
- Run merge-blocking format, lint, native tests, doctests, dependency policy, Wasm, size and coverage
  gates; schedule pinned Miri, fuzz and mutation jobs.
- Update readiness documentation without claiming M2 canonical JSON or any live qualification.

## Acceptance

- `pnpm install --frozen-lockfile` and both Cargo lockfiles are reproducible.
- `pnpm work-packets:check` rejects owned-path overlaps, unknown dependencies, duplicate IDs, and DAG cycles.
- `pnpm boundaries:negative` injects a forbidden import and proves the existing boundary gate fails.
- Unknown protocol/error codes, duplicate IDs, blank rows, over-limit frames/cases/IDs/payloads and
  architecture-dependent numeric values fail in both TypeScript and Rust parsers.
- `cargo fmt --all --check` passes.
- `cargo clippy --workspace --all-targets --all-features --locked -- -D warnings` passes.
- `cargo nextest run --workspace --all-features --locked` and Rust doctests pass.
- `cargo deny check` passes.
- The default `wasm32-unknown-unknown` artifact has zero runtime imports and no `eliotr_*` export; the
  feature-gated self-test artifact exposes only the test symbol, executes the exact corpus and stays
  within the compressed M1 budget.
- Deterministic-core coverage is at least 90% with branch instrumentation and a frozen Cargo graph.
- No TypeScript authority is removed, no product route changes, and no live platform gate is implied.

## Mandatory negative boundary

Create a temporary `node:fs/promises` import inside `packages/domain`, run the real package-boundary gate,
and prove it exits nonzero before deleting the fixture. Mutate the shared fixture protocol, error code,
case identity, blank-line discipline and every explicit resource limit and prove both strict parsers
reject the malformed frame.

## Handoff contract

Produce:

- frozen TypeScript and Rust toolchain registry;
- M1 Cargo workspace and lockfiles;
- bounded, strict, versioned vector corpus consumed by TypeScript, native Rust and Rust/Wasm;
- merge-blocking Rust CI plus pinned scheduled Miri/fuzz/mutation verification;
- updated readiness record that leaves M2–M7 and all live receipts explicitly open.

The PR must state contract/generation impact, exact commands, negative-case results, Wasm size, coverage,
and live receipts (`NOT EXECUTED`). Do not mark M1 complete with a missing lockfile, skipped target,
unbounded parser, mocked Wasm execution, or product ABI/authority promotion.

## Completion evidence — 2026-09-01

Implementation commit `9e9a4d6bbfd5f2a67427714e7adfb9d71eb6c296` passed exact-head CI run `33522427515`:

- legacy TypeScript/Cloudflare verification, PWA build, binding generation and Worker dry-run passed;
- Rust format, Clippy, 28/28 native tests, doctests and dependency/source policy passed;
- the default Wasm artifact was 363 raw / 258 gzip bytes with zero imports and no product ABI;
- the feature-gated self-test artifact was 8,790 raw / 4,142 gzip bytes with zero imports;
- coverage was 99.60% lines, 96.75% branches, 100% functions and 97.38% regions;
- `Cargo.lock` and the excluded `fuzz/Cargo.lock` were consumed with `--locked`;
- Cloudflare, Google, provider, recovery and workload receipts were `NOT EXECUTED`.

M1 is complete. M2 canonical JSON/identity, M3–M4 domain authority, M5 ABI promotion and M6–M7
shadow/cutover/removal remain open. TypeScript/Cloudflare remains the active product authority.

## Post-M1 ownership handoff

M1 completion evidence is retained above. After M1 closed, the deterministic kernel, shared
vectors, Wasm shell, fuzz contour, and vector/Wasm verification scripts moved to **ER-40** for
the ordered M2 canonical identity and serialization migration. ER-00 continues to own the
repository-wide toolchain, lockfiles, CI composition, and integration gates. A change requiring
both ownership domains must be split or explicitly coordinated; permanent dual ownership is
prohibited.
