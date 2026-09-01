# ER-40: Rust canonical identity and serialization

**Slice:** 0–1 migration infrastructure
**Depends on:** ER-00, ER-01, ER-02, ER-23
**Language phase:** M2
**Live gate:** none; differential shadow evidence only

## Objective

Extend the verified M1 deterministic kernel into the M2 owner for canonical bytes, stable
digests, stable IDs, and fixed-width generation identities. TypeScript/Cloudflare remains the
active product authority until a separately reviewed promotion packet names one canonical
family, its observation window, mismatch policy, rollback switch, and superseded owner.

## Owned paths

- `crates/README.md`
- `crates/eliotr-canonical/**`
- `crates/eliotr-test-vectors/**`
- `crates/eliotr-kernel-wasm/**`
- `fuzz/**`
- `scripts/check-rust-vectors.mjs`
- `scripts/check-rust-wasm.mjs`
- `docs/agent-work/ER-40-rust-canonical-identity-and-serialization.md`

## Read only

- `AGENTS.md`
- `Cargo.toml`
- `Cargo.lock`
- `rust-toolchain.toml`
- `deny.toml`
- `.config/nextest.toml`
- `.github/workflows/ci.yml`
- `.github/workflows/rust-deep-verification.yml`
- `package.json`
- `packages/contracts/**`
- `packages/domain/**`
- `docs/contracts/**`
- `docs/architecture/ELIOT_RESEARCH.md`
- `docs/architecture/LANGUAGE_RUNTIME_CONTRACT.md`
- `docs/implementation/toolchain.md`
- `docs/implementation/production-readiness-plan.md`
- `docs/implementation/gap-register.md`
- `tests/fixtures/**`
- `tests/golden-corpus/**`

## Architecture extracts

- language/runtime contract: M2 canonical bytes, stable identifiers, generation tokens, and
  differential promotion discipline;
- production-readiness plan: Phase 3;
- contracts and deterministic domain code: current TypeScript executable specification only;
- ER-23: golden-corpus and negative-harness requirements.

## Required implementation

- Define one bounded, versioned canonical JSON value model before accepting arbitrary product
  objects.
- Reject duplicate member names, unknown envelope fields, invalid UTF-8, non-canonical numeric
  forms, unsupported numeric ranges, invalid Unicode scalar sequences, and every configured
  resource overflow.
- Produce deterministic UTF-8 bytes with lexicographically ordered object keys and no locale,
  platform, clock, environment, randomness, I/O, or global mutable-state dependency.
- Add deterministic SHA-256 body digests, stable IDs, and fixed-width generation-token
  validation from explicit bytes.
- Port one narrowly named product-neutral vector family first; do not claim every product
  contract migrated.
- Execute exact committed vectors through the independent TypeScript reference, native Rust,
  and compiled Rust/Wasm.
- Keep M2 effect-free and shadow-only until a separate promotion packet authorizes one family.
- Preserve M1 frame, Wasm import/export, compressed-size, coverage, dependency, Miri, fuzz, and
  mutation gates.
- Keep source files below 600 lines and each crate below 10,000 source lines.

## Acceptance

- Frozen pnpm and Cargo graphs remain reproducible and repository-wide CI stays green.
- Canonical output bytes, SHA-256, stable ID, generation token, typed result, and typed error are
  identical in TypeScript, native Rust, and Rust/Wasm.
- Negative fixtures cover duplicate keys, ordering, Unicode and escapes, numeric boundaries,
  malformed syntax, unknown fields, and every explicit size/depth/member limit.
- Default Wasm exposes no product ABI; any verification export remains feature-gated and CI-only.
- No TypeScript authority is deleted and no product mutation consumes Rust output in this packet.
- Live Cloudflare, Google, provider, recovery, corpus, and workload receipts remain
  `NOT EXECUTED`.

## Mandatory negative boundary

Mutate the committed M2 corpus with duplicate members, unknown envelope fields, malformed or
non-canonical numbers, invalid escapes, excessive nesting/member/payload limits, and a digest
mismatch. Both independent parsers and the compiled Wasm verifier must reject the exact case
without logging or returning source content.

## Handoff contract

Produce:

- a bounded canonical JSON grammar and stable typed error vocabulary;
- deterministic canonical UTF-8 bytes;
- deterministic SHA-256 body digests, stable IDs, and generation-token validation;
- strict versioned M2 vectors evaluated by TypeScript, native Rust, and Rust/Wasm;
- retained mismatch-free shadow evidence for each implemented family;
- an explicit statement that M3–M7 and product-authority promotion remain open.

Do not broaden M2 into D1, R2, Queue, Workflow, provider, model, browser, or Cloudflare runtime
effects. Do not call a local differential pass a live receipt or a product-authority cutover.

## Active implementation slice — canonical-body.v1

This branch implements only the product-neutral M2 foundation:

- bounded canonical JSON for null, booleans, strings, safe integers, arrays and objects;
- object-key ordering by ECMAScript UTF-16 code units for parity with the current TypeScript
  authority, including an explicit astral/BMP divergent vector;
- deterministic SHA-256 over exact body bytes;
- fixed-width lowercase `g1_<sha256>` generation tokens;
- one strict corpus evaluated by independent TypeScript, native Rust and Rust/Wasm paths;
- expanded Miri/fuzz/mutation reach through the existing pure-crate verification jobs.

Floats, arbitrary product objects, existing wire-contract families, stable product IDs, shadow observation
receipts and authority promotion remain outside this slice. Live receipts remain `NOT EXECUTED`.
