# Toolchain contract

This file is the implementation authority for repository bootstrap. Leaf agents must not upgrade or
replace these tools inside their packets. Toolchain changes belong to **ER-00** and require regenerated
lockfiles plus all repository gates.

## Pinned baseline

### TypeScript and Cloudflare

| Tool | Version / minimum | Reason |
|---|---:|---|
| Node.js | `>=22.13.0` | Satisfies the runtime floor of the pinned ESLint 10 release. |
| pnpm | `11.23.0` | TypeScript workspace and lockfile owner. |
| TypeScript | `6.0.3` | Latest compiler line accepted by the pinned `typescript-eslint` peer range. |
| typescript-eslint | `8.68.0` | Flat-config TypeScript lint integration. |
| ESLint | `10.9.1` | Repository lint engine. |
| @eslint/js | `10.0.1` | Published flat JavaScript config package. |
| Wrangler | `4.127.1` | Worker build, generated binding types, dry-run, migrations and deploy. |
| @cloudflare/vitest-plugin | `1.1.0` | Workers runtime integration tests. Do not restore the retired pool package. |
| @cloudflare/workers-types | `5.20260827.1` | Compile-time Worker API declarations. Generated binding types remain authoritative for `Env`. |
| Vite | `8.2.2` | PWA build. |
| Vitest | `4.1.10` | Node and browser-independent unit harness. |
| Zod | `4.4.3` | Strict wire validation; load-bearing objects use `.strict()`. |

TypeScript 7 is intentionally **not** admitted yet. The pinned `typescript-eslint` release declares a
TypeScript peer range below 6.1; choosing TypeScript 7 would make the dependency graph unsupported before
product code runs.

### Rust deterministic kernel

| Tool | Version | Gate |
|---|---:|---|
| Rust | `1.98.0` | Workspace MSRV, build, format, lint and native-test compiler. |
| Verification nightly | `nightly-2026-08-31` | Branch-aware coverage plus scheduled Miri and fuzz verification. |
| Cargo resolver | `3` | Edition-2024 workspace feature resolution. |
| target | `wasm32-unknown-unknown` | Portable embedded kernel target. |
| cargo-nextest | `0.9.143` | Native workspace test runner. |
| cargo-deny | `0.20.2` | Advisory, license, duplicate and source policy. |
| cargo-llvm-cov | `0.9.0` | Branch-aware deterministic-core coverage. |
| cargo-fuzz | `0.13.2` | Scheduled fuzz harness. |
| libfuzzer-sys | `0.4.13` | Exact fuzz target runtime dependency. |
| cargo-mutants | `27.1.0` | Scheduled mutation gate. |

The stable workspace has no third-party runtime dependencies in M1. `fuzz/` is an excluded, separately
locked harness so `libfuzzer-sys` cannot enter the product dependency graph. Internal path dependencies
carry exact `=0.1.0` requirements; the dependency policy continues to deny wildcard requirements.

Stable Rust remains authoritative for product compilation. The pinned nightly is invoked explicitly only
where the requested verification feature is nightly-only; it does not change the workspace MSRV or release
compiler.

Merge CI installs the three stable Cargo utilities from their pinned GitHub releases through
`taiki-e/install-action` pinned to commit `1ed6d7be6168f6c9046541087ff549b6bc581fdf`, with checksum
verification enabled and fallback installation disabled. CI then verifies each executable's exact version.
Official GitHub actions are commit-pinned to `actions/checkout` `3d3c42e5aac5ba805825da76410c181273ba90b1`
(`v7.0.1`) and `actions/setup-node` `820762786026740c76f36085b0efc47a31fe5020` (`v7.0.0`).

## M1 scope guard

M1 creates the workspace and proof machinery only:

- `eliotr-canonical` owns bounded, allocation-free UTF-8 transport validation, not canonical JSON;
- `eliotr-test-vectors` owns the strict shared fixture frame;
- `eliotr-kernel-wasm` proves the same fixture bytes execute under native Rust and
  `wasm32-unknown-unknown`;
- TypeScript remains the product authority until the M2–M7 differential promotion sequence.

The fixture frame has one cross-runtime resource contract: 1 MiB complete UTF-8 frame, 4,096 cases,
128-byte ASCII case IDs, 256 KiB decoded input/output fields and canonical unsigned 32-bit `max_bytes`.
Rust and TypeScript reject every overflow before payload allocation or semantic execution.

The feature-gated `eliotr_m1_verify_embedded_vectors_v1` symbol is a CI-only scalar self-test. It is not a
product ABI operation and is absent from the default build. CI inspects the default artifact before the
feature build overwrites the target path, then permits only the self-test symbol in the second artifact.
Both artifacts must have zero runtime imports and remain under the compressed M1 budget. Rust 2024
requires the self-test's `no_mangle` attribute to be acknowledged as unsafe; the adapter contains no
unsafe block or memory access. Pure crates use `#![forbid(unsafe_code)]`.

## Bootstrap

```bash
corepack enable
corepack prepare pnpm@11.23.0 --activate

rustup toolchain install 1.98.0 \
  --profile minimal \
  --component clippy \
  --component llvm-tools-preview \
  --component rustfmt \
  --target wasm32-unknown-unknown
rustup default 1.98.0

rustup toolchain install nightly-2026-08-31 \
  --profile minimal \
  --component llvm-tools-preview

cargo install cargo-nextest --version 0.9.143 --locked
cargo install cargo-deny --version 0.20.2 --locked
cargo install cargo-llvm-cov --version 0.9.0 --locked

pnpm install --frozen-lockfile
cargo metadata --all-features --locked --format-version 1 > /dev/null
cargo metadata --manifest-path fuzz/Cargo.toml --locked --format-version 1 > /dev/null
pnpm check
pnpm cf:types
pnpm cf:dry-run
```

No bootstrap or dry-run command authorizes a live deployment.

## Verification registry

| Command | Meaning |
|---|---|
| `pnpm boundaries:negative` | Prove boundary/budget gates on space/Unicode/#/% checkout paths; reject forbidden imports, unregistered pending state and work-packet drift. |
| `pnpm rust:boundaries` | Enforce pure-core dependency/runtime exclusions and synthetic negatives. |
| `pnpm rust:vectors` | Parse and execute the bounded committed corpus through the TypeScript reference. |
| `pnpm rust:fmt` | Check `rustfmt` without mutation. |
| `pnpm rust:clippy` | Lint every target and feature with warnings denied. |
| `pnpm rust:test` | Run native tests with nextest plus Rust documentation tests. |
| `pnpm rust:deny` | Enforce advisory, license, duplicate and source policy. |
| `pnpm rust:wasm` | Inspect the default artifact, then execute and inspect the feature-gated self-test artifact. |
| `pnpm rust:coverage` | Use the pinned nightly to enforce at least 90% line coverage with branch instrumentation and `--locked`. |
| `pnpm rust:check` | Run every M1 Rust merge gate. |
| `pnpm check` | Run TypeScript/Cloudflare gates and `pnpm rust:check`. |

`.github/workflows/rust-deep-verification.yml` additionally runs pinned Miri, fuzz and mutation jobs on a
weekly schedule or explicit dispatch. A scheduled gate failure remains a failure; it is never converted
to `NOT EXECUTED`.

## Windows verification scope

The `windows-tooling` CI job runs the real boundary and source-budget checks, their negative fixtures,
and deployment HTTP/ordering tests on a native Windows runner with CRLF checkout line endings. A
synthetic checkout uses spaces, Cyrillic, Japanese, `#` and `%`, and invokes the gate from an unrelated
working directory. Filesystem roots use `fileURLToPath`, not URL `pathname`; diagnostics use repository
`/` separators. Fixture edits are restored byte-for-byte and CI rejects a dirty checkout.

This closes portability of these Node tooling checks, not the complete local startup or live platform
path. The bootstrap example above uses Bash syntax; PowerShell must adapt line continuations and output
redirection. Building the PWA, applying both local D1 migration streams, authenticating and configuring
remote-only bindings are still required before a usable local application session. Linux remains the
full TypeScript/Worker/Rust verification runner; no Windows Rust/Worker qualification is implied.

## Upgrade rule

A toolchain update is one atomic ER-00 change:

1. change root/leaf pins together;
2. regenerate `pnpm-lock.yaml`, `Cargo.lock`, and `fuzz/Cargo.lock`;
3. regenerate Wrangler binding types when the Cloudflare toolchain changes;
4. run contract, boundary, budget, branch-hygiene and work-packet checks;
5. run lint, project-reference typecheck, unit and Workers integration tests;
6. run all Rust merge gates and the minified Wrangler dry-run;
7. record exact versions and generation impact in the PR.

No leaf packet may add a second compiler, linter, test runner, package manager, Cloudflare deployment
entrypoint, or mutable authority implementation.
