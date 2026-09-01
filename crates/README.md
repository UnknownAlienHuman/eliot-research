# Rust deterministic kernel

This workspace implements the language ownership contract in
`docs/architecture/LANGUAGE_RUNTIME_CONTRACT.md`.

Migration phase M1 contains only:

- `eliotr-canonical`: pure bounded UTF-8 transport validation; no M2 canonical JSON authority yet.
- `eliotr-test-vectors`: one strict fixture format consumed by TypeScript, native Rust and Rust/Wasm.
- `eliotr-kernel-wasm`: portable shell and a feature-gated CI-only vector self-test.

The vector protocol fails closed before allocation above these architecture-independent limits:

- complete UTF-8 frame: 1 MiB;
- cases per frame: 4,096;
- ASCII case identity: 128 bytes;
- decoded input or output field: 256 KiB;
- `max_bytes`: canonical unsigned 32-bit decimal.

The default Wasm build exposes no product ABI and is inspected before the feature build can replace its
artifact. The M1 scalar self-test exists only under the `m1-self-test-export` feature so CI can execute
the exact embedded corpus before the versioned M5 ABI is defined.

Cloudflare bindings, network I/O, storage authority, clocks, randomness and environment reads do not
belong in pure crates. New authority moves into Rust only in the M2–M7 order and only after differential
fixtures prove byte-for-byte agreement.

## M2 canonical-body shadow slice

`eliotr-canonical` now also contains the bounded, product-neutral `canonical-body.v1` family: canonical
JSON for null/boolean/string/safe-integer/array/object values, exact SHA-256 body digests and fixed-width
`g1_<sha256>` generation-token validation. Its committed vectors run independently through TypeScript,
native Rust and Rust/Wasm. This is differential shadow infrastructure only: no product contract consumes
these outputs and no TypeScript authority has been removed.

Object keys follow the current TypeScript authority's ECMAScript UTF-16 code-unit order, including astral/BMP divergence cases.
