# Rust/Wasm integration: a caller, not a compatibility platform

Apply the [language boundary](../architecture/LANGUAGE_RUNTIME_CONTRACT.md). This note supersedes the old
universal envelope/semver procedure; it does not itself change an exported function or stored bytes.

## Existing source is not a deployed product contract

At `ba344566`, `crates/eliotr-kernel-wasm/src/lib.rs` describes the default build as having no product ABI.
It exposes version/schema stamps and optional self-test exports. Constants/parsing live in
`crates/eliotr-canonical/src/abi_version.rs`; `scripts/check-rust-wasm.mjs` checks the current stamp/self-test
surface. Those metadata exports and vector checks are not proof of a Worker product caller.

## Implement one needed operation

Choose a useful pure operation and its actual TypeScript caller from the current task. Define only the data
that operation uses, bounded input/output, memory ownership and typed errors. Integrate the Rust function,
Wasm export, Worker loader and caller together; then remove the replaced TypeScript decision and its unused
bridge. Keep the existing stack, not a new Worker/service or one crate per function.

Do not port canceled residency, owner-transfer, proof or canonical-envelope machinery simply because vectors
exist for it. A pure packer/algorithm does not need a policy passport, current clock, per-call input/output
hashes or a network of schema generations. Existing internal code built and deployed together changes together.

If a loader can actually receive an independently built incompatible artifact, check its required interface
once at load time. Otherwise package the matching artifact with its Worker. Do not force every local call to
parse semantic versions or attach `operation_version`/`schema_generation`. Version a real persisted/external
boundary only when its consumers require it; an old prototype is not a permanent supported consumer.

## Remove the obsolete scaffold with its callers

When changing the Wasm surface, update the existing loader and `check-rust-wasm.mjs` expectation in that change;
the old rule allowing metadata exports only must not block a real product export. Delete unused stamp parsing,
compatibility exports and exclusive fixtures after checking actual imports. Do not add `_v2` beside `_v1`
solely because the old note prohibited replacement. No empty compatibility shim or successful self-test stub.

Preserve actual stored identities/bytes through an explicit conversion where necessary; changing local
function metadata does not require rewriting all stored content. Do not reinterpret old data silently.
During implementation use scoped compilation and minimal Clippy for the changed crate; product integration
checks follow assembly. No workspace-wide parity/coverage/ABI governance programme before writing the caller.
