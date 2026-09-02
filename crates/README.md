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

The product-neutral M2 corpora run independently through TypeScript, native Rust and compiled Rust/Wasm.
They are differential shadow infrastructure only: no product family consumes Rust output, no mutation is
duplicated, and no TypeScript authority has been removed.

## M2 ingest identity-family shadow slice

The committed `ingest-identities.v1` corpus binds the generic stable-ID kernel to every current
`stableIngestId` prefix/arity formula used by ingest admission and its queued projection handoff:

- `ingest(principal_ref, idempotency_key)` and `candidate(operation_id)`;
- `qualification(operation_id)` and
  `admission(operation_id, qualification_digest, decision)` for `ADMITTED`, `QUARANTINED` and
  `REJECTED`;
- ingest intent, attempt, receipt and idempotency identities;
- projection intent and idempotency identities derived during ingest commit;
- `outbox(projection_intent_id, "1")`.

Thirty-one committed cases cover the complete dependency chain, all currently admitted identifier
punctuation, part ordering and boundary separation, exact 256-character upstream identifier ceilings,
validation of representative outputs, malformed prefixes, invalid UTF-8, wrong digest length and
non-lowercase digest bytes. The same fixture bytes run through the independent JavaScript reference,
native Rust and compiled Rust/Wasm.

This corpus assumes inputs have already passed the current TypeScript `authorityIdentifier` and contract
validators. It does not move D1 uniqueness, idempotency replay, admission decisions, queue settlement,
projection dispatch, or any runtime effect into Rust.

## M2 projection identity-family shadow slice

The committed `projection-identities.v1` corpus binds the generic stable-ID kernel to every current
`stableProjectionId` prefix/arity formula used by projection execution:

- `projection(source_revision_ref, content_sha256, object_residency_key_digest, projector_profile)`;
- `source(source_revision_ref)` and `generation(projection_generation)` path tokens;
- `projection-execute(intent_id, intent_revision, projection_generation)`;
- D1 Search and managed-search completion receipts;
- `receipt-projection-terminal` for both `SUCCEEDED` and `PARTIAL` settlements.

Thirty-six committed cases cover a complete dependency chain, both terminal outcomes, exact field-order
sensitivity, content/residency/profile/readback changes, identifier punctuation, 256-character source,
profile and managed-generation ceilings, representative output validation, malformed prefixes, invalid
UTF-8, short digests and non-lowercase digest bytes. TypeScript, native Rust and compiled Rust/Wasm
execute the same fixture bytes.

The settlement digest is an already-admitted explicit input in this family. Canonical settlement-body
parity, source-token truncation for managed keys, D1 activation, provider readback, lease settlement and
all runtime effects remain TypeScript/Cloudflare authority.

## M2 `source.owner-cutover.v1` canonical golden slice

The first named contract corpus binds the generic kernel to the existing owner-cutover contract without
moving its schema or state-machine authority. Nine committed cases cover shuffled and idempotent FENCED
receipts, a RETIRED receipt with Unicode identifiers, duplicate root/nested keys, canonical receipt
digests, and the exact no-trailing-newline YAML fixture digest
`b659806e37a4bc60ea67b4416e35212f559213bbadb28618b7edcee686b9277e`.

The independent JavaScript reference, native Rust and Rust/Wasm execute the same bytes. This slice does
not validate Zod shape, authorization, owner fencing, generation collision, time ordering, or revision-set
closure; those remain with TypeScript and the later M3 contract/domain migration.

## M2 `object-residency-key.v1` serialization shadow slice

The first existing deterministic domain serializer is ported exactly: six non-empty identifiers, fixed
`sha256`, and a 64-byte lowercase digest are emitted as nine `/`-separated segments. Identifier components
use JavaScript `encodeURIComponent` semantics, including its unescaped `-_.!~*'()` alphabet, uppercase
percent triplets, UTF-8 Unicode encoding, and literal-percent double escaping.

The Rust boundary preserves `IdentifierSchema`'s 256 JavaScript UTF-16-unit ceiling and rejects invalid
UTF-8, empty fields, oversized fields, and malformed digests before serialization. The committed corpus
checks exact maximum output size, BMP/astral Unicode, reserved characters, domain-position separation and
all typed negative paths through JavaScript, native Rust and Rust/Wasm.

This slice does not move `residencyDomainsEqual`, `validateDeduplication`, storage placement, encryption,
retention, erasure or transition authority. Those remain TypeScript/M3+ responsibilities.

The default Wasm build exposes no product ABI and is inspected before the feature build can replace its
artifact. CI-only scalar verifiers exist under `m1-self-test-export`; they are not M5 product exports.

Cloudflare bindings, network I/O, storage authority, clocks, randomness and environment reads do not
belong in pure crates. New authority moves into Rust only in M2–M7 order and only after retained
byte-for-byte differential evidence and a separately reviewed promotion.
