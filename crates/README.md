# Rust deterministic kernel

This workspace implements the language ownership contract in
`docs/architecture/LANGUAGE_RUNTIME_CONTRACT.md`.

## M1 verification foundation

- `eliotr-canonical` provides pure bounded UTF-8 transport validation.
- `eliotr-test-vectors` carries strict fixtures consumed by TypeScript, native Rust and Rust/Wasm.
- `eliotr-kernel-wasm` is the portable shell with feature-gated CI-only corpus verifiers.

The M1 vector protocol fails closed before allocation above these architecture-independent limits:

- complete UTF-8 frame: 1 MiB;
- cases per frame: 4,096;
- ASCII case identity: 128 bytes;
- decoded input or output field: 256 KiB;
- `max_bytes`: canonical unsigned 32-bit decimal.

## M2 canonical-body shadow slice

`eliotr-canonical` contains the bounded, product-neutral `canonical-body.v1` family: canonical JSON for
null/boolean/string/safe-integer/array/object values, exact SHA-256 body digests and fixed-width
`g1_<sha256>` generation-token validation. Object keys follow the current TypeScript authority's
ECMAScript UTF-16 code-unit order, including astral/BMP divergence cases.

## M2 stable-ID shadow slice

`stable-id.v1` reproduces the current TypeScript helper contract for the admitted bounded subset:

```text
preimage = prefix [NUL part]*
digest   = SHA-256(preimage)
id       = prefix + "-" + first_48_lowercase_hex(digest)
```

The prefix is 1–64 ASCII bytes using the existing identifier alphabet, at most 32 UTF-8 parts are
admitted, each part is at most 4 KiB, and the complete preimage is at most 64 KiB. Empty parts remain
significant. The direct parts API rejects embedded NUL so one logical input cannot have multiple
preimage interpretations.

Both M2 corpora run independently through TypeScript, native Rust and compiled Rust/Wasm. They are
differential shadow infrastructure only: no product family consumes Rust output, no mutation is
duplicated, and no TypeScript authority has been removed.

The default Wasm build exposes no product ABI and is inspected before the feature build can replace its
artifact. CI-only scalar verifiers exist under `m1-self-test-export`; they are not M5 product exports.

Cloudflare bindings, network I/O, storage authority, clocks, randomness and environment reads do not
belong in pure crates. New authority moves into Rust only in M2–M7 order and only after retained
byte-for-byte differential evidence and a separately reviewed promotion.
