# Rust deterministic kernel

This workspace implements the language ownership contract in
`docs/architecture/LANGUAGE_RUNTIME_CONTRACT.md`.

Migration phase M1 contains only:

- `eliotr-canonical`: pure bounded UTF-8 transport validation; no M2 canonical JSON authority yet.
- `eliotr-test-vectors`: one strict fixture format consumed by TypeScript, native Rust and Rust/Wasm.
- `eliotr-kernel-wasm`: portable shell and a feature-gated CI-only vector self-test.

The default Wasm build exposes no product ABI. The M1 scalar self-test exists only under the
`m1-self-test-export` feature so CI can execute the exact embedded corpus before the versioned M5 ABI is
defined.

Cloudflare bindings, network I/O, storage authority, clocks, randomness and environment reads do not
belong in pure crates. New authority moves into Rust only in the M2–M7 order and only after differential
fixtures prove byte-for-byte agreement.
