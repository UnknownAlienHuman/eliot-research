# S88 — Implement the product Wasm ABI and differential shadow

Baseline `a2aca127`; ER-40/24/00. The baseline kernel exports CI self-tests, not the product ABI. Start with an accepted identity family; completion of every S79–S87 family is not a prerequisite for proving the bridge.

## 1. Problem

An embedded-vector self-test does not establish real Worker marshalling, allocation bounds, or single execution of side effects. A TypeScript application caller must invoke the compiled portable kernel on runtime input.

## 2. Required change

Extend the existing kernel shell with the canonical UTF-8 byte-in/byte-out ABI and one shared TS adapter. Initially run differential shadow without changing the production owner. Both implementations evaluate the same observed facts; only one effect path executes.

## 3. Documentation and exact search anchors

[Language contract 6/8.3/10](https://github.com/UnknownAlienHuman/eliot-research/blob/a2aca1277b0edbbed04de66e0d44e383e1b815ef/docs/architecture/LANGUAGE_RUNTIME_CONTRACT.md).
```sh
git grep -n -F '## 6. TypeScript ↔ Rust/Wasm ABI' -- docs/architecture/LANGUAGE_RUNTIME_CONTRACT.md
```
[Cloudflare Rust integration](https://developers.cloudflare.com/workers/languages/rust/), rechecked 2026-09-15: imported Wasm is a WebAssembly.Module; standalone wasm-bindgen glue must be initialized accordingly. This documentation does not prove that the repository's pinned build already supports the proposed integration.

## 4. Implementation approach

Use a wasm-bindgen byte-array shell (`&[u8]` to `Vec<u8>`) and generated glue over the imported module in the existing TS Worker. Do not rewrite the Worker in workers-rs. Pin matching crate/CLI versions in the existing toolchain/lock; do not fetch latest tools at runtime.

Use only the named product exports in language section 6.3 and its shared versioned operation envelope. Memory/glue exports are implementation details, not additional domain operations. Validate wire size/version/digest before copying input into Wasm; enforce bounded decoding/allocation inside the kernel and validate output size/schema/digest before acceptance. Generated glue owns temporary pointers; no mutable pointer or Cloudflare object becomes domain API.

Run synchronously over immutable input. A trap invalidates the affected instance/operation; do not reuse possibly corrupted state or silently accept a permissive TS fallback. Record content-free mismatch evidence and block the affected authoritative mutation. TS remains reference until S89. Do not create a global duplicate cache of private source bytes.

## 5. Acceptance criteria

- [ ] Actual workerd invokes compiled Wasm on runtime input; TS/native/Wasm results, typed errors, and canonical bytes agree.
- [ ] Wrong version/digest/size, truncated input, traps, and repeated calls cannot leak data or corrupt subsequent operations; allocations are bounded and released.
- [ ] Shadow causes no duplicate model/network/D1 effects; mismatches cannot publish accepted output.
- [ ] Measure compressed Wasm plus glue, startup/heap, and per-family p50/p95 CPU against the same TS input; retain actual Worker/Rust test results and exact SHA.
- [ ] No second Worker, RPC service, alternate engine, or unverified runtime-promotion claim is introduced.
