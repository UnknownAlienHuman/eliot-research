# S78 — M2 identity parity: finite consumer batches

Baseline a2aca127; F23/F26, ER-40/01/00. Preserve existing K1/K2a and canonical/vector primitives. This is pure identity parity, not runtime promotion (S89). The previous unspecified 'find active callers' and nonexistent verification alias are replaced below.

## 1. Problem

Independent canonical helpers do not necessarily share accepted inputs or errors. Runtime identities must preserve persisted bytes and domain separation. Existing Rust code is neither absent nor proof of complete integration.

## 2. Required change

Complete 78.1–78.6 using the named producers and retained independent fixture outputs. Work one row/consumer at a time. An already covered producer needs its actual fixture/caller reference, not a second implementation. Output contracts introduced by S35–S70 must include their new identity cases in their owning feature regression and the same relevant family; no second identity registry.

## 3. Documentation and actual commands

[Language §§3,6,8.3,10](https://github.com/UnknownAlienHuman/eliot-research/blob/a2aca1277b0edbbed04de66e0d44e383e1b815ef/docs/architecture/LANGUAGE_RUNTIME_CONTRACT.md), [Launch09 K2b](https://github.com/UnknownAlienHuman/eliot-research/blob/a2aca1277b0edbbed04de66e0d44e383e1b815ef/docs/implementation/launch-prs/09-rust.md), root package.json and current canonical/vector lib.rs exports.

```sh
cargo test --locked -p eliotr-canonical
cargo test --locked -p eliotr-test-vectors
pnpm rust:vectors
pnpm rust:boundaries
pnpm rust:wasm
```

For accepted family completion: `pnpm rust:check`. Its real rust:test runs nextest AND doctests. There is no rust:check-contracts or rust:nextest script; do not create aliases for them. Core tests below use `pnpm --dir apps/eliotr-core exec vitest run <test-paths>`; root pure tests use `pnpm exec vitest run <package-path>`. Do not run a full gate after every fixture edit. Native/Wasm parity is not a successful live deployment.

## 4. Ordered batches and exact consumers

| Batch | Producer boundary to cover | Independent observable oracle |
|---|---|---|
| 78.1 | Existing canonical JSON implementation exported by crates/eliotr-canonical/src/lib.rs; canonical_body vector family. | Canonical-body.v1 numeric subset, UTF-16 key ordering, escapes, malformed Unicode and size errors; literal expected bytes, not re-encoding by the same serializer. |
| 78.2 | Existing stable_id and owner-token primitives/vector families. | Domain separation, empty/changed inputs, exact persisted prefixes/truncation, malformed encoding and K1 invariants. |
| 78.3 | Existing residency_key plus packages/domain/src/owner-cutover.ts serialization and its admitted contract. | Complete owner/key/retention/source-set/view identity; equal bytes in another residency are not interchangeable. |
| 78.4 | Existing scope_snapshot_identity/K2a; packages/cloudflare-navigation/src/scope-service.ts and S08 request identity. | Full member order/set and scope/profile/expression identity. Preserve old K2a cases; new S99 metadata scope does not silently change old digests. |
| 78.5a | packages/platform-cloudflare/src/ingest-validation.ts canonicalJson and its staged bundle/session/completion/promotion callers. | Actual bundle/import replay IDs, manifest/hash outputs, changed revision/parser/policy conflicts. Core test/bundle-import-http.test.ts and test/ingest-service.test.ts. |
| 78.5b | packages/retrieval/src/structural-projector.ts canonical byte construction. | Persisted projection item-set/generation identities, stable replay and changed input negatives; core test/retrieval-generation-fences.test.ts and S52 promotion regression. |
| 78.5c | packages/retrieval/src/navigation-codec.ts canonicalJson and navigation-identity.ts. | SourceCard/DocumentMap/ProjectAtlas revision bytes and refs; core test/navigation-persistence.test.ts and test/structural-navigation-q1.test.ts. |
| 78.5d | packages/retrieval/src/query-codec.ts canonicalRetrievalJson, query-persistence.ts and service.ts (S28 removes its equivalent recursion). | Query/request/result/trace digest and exact errors; core test/research-query-retrieval.test.ts and test/research-trace-read.test.ts, plus root retrieval tests. |
| 78.6a | packages/cloudflare-evidence/src/canonical.ts: canonicalEvidenceJson, evidenceSha256, stableEvidenceId; its registry/resolution consumers exported by index.ts. | Exact EvidenceHandle/citation/map/resolution identities, including existing null/nonfinite/undefined handling only within each admitted domain; core test/research-citations-result.test.ts and test/research-citation-attempt-binding.test.ts. |
| 78.6b | packages/cloudflare-research/src/research-reference-manifest.ts, research-protocol-freeze.ts and research-evidence-freeze.ts, through their exported producers. | Exact manifest/protocol/freeze hashes and links; core test/research-reference-manifest.test.ts, test/research-protocol-freeze.test.ts and test/research-evidence-freeze.test.ts. |
| 78.6c | packages/cloudflare-artifacts/src/artifact-draft.ts and artifact-draft-verification.ts (encodeArtifactDraftVerification / encodeArtifactDraftVerificationV2), plus research materialization output. | V1/V2 stored body/verification/section references; core test/artifact-draft-store.test.ts, test/artifact-draft-reader.test.ts and test/research-verification-result-v2.test.ts. |
| 78.6d | packages/research/src/wiki.ts revision serialization and core wiki-owner-publication-guard.ts canonical-input validation. The guard is a validator, not automatically another serializer to delete. | Publication proposal/head/receipt bytes and exact rejection; core test/wiki-publication-store.test.ts and test/wiki-service.test.ts plus S04 edit regression. |
| 78.6e | packages/cloudflare-federation/src/federation-d1-common.ts and apps/eliotr-core/src/federation-service.ts canonical persisted request/result construction. | Independent seven-operation wire/storage fixtures; core test/federation-service.test.ts and test/federation-runtime-http.test.ts, then S61 independent encoding test. |
| 78.6f | packages/backup-o2/src/intent-digest.ts and its epoch/copy replay consumers; packages/cloudflare-ai/src/model-gateway-request.ts and the W3 fingerprint/output stores exported by cloudflare-research. | O2 replay/nonce intent bytes and W3 request/output fingerprints remain stable. Root packages/backup-o2 tests and core test/model-attempt-store.test.ts, test/research-model-fingerprint-store.test.ts, test/research-model-output-store.test.ts. |
| 78.6g | W1 command/ref encoding in packages/research/src/ledger-commands.ts and W2 request/receipt identity through the exported cloudflare-workflows executor. | Core test/investigation-ledger-commands-d1.test.ts, test/research-workflow.test.ts and test/research-workflow-recovery.test.ts preserve distinct W1/W2/W3 IDs and verbatim replay. |

The table specifies families and callers, not a demand to duplicate every listed codec in Rust. Trace each named producer to its shared primitive; record reuse where it already has byte-identical coverage. A distinct wire schema stays distinct even when sharing an algorithm. Runtime switching is S89; storage readers, crypto/platform I/O and SQL CAS remain at their specified layers.

For each row: (1) preserve accepted/invalid fixture bytes, including current version; (2) run the existing TS producer and pure native implementation; (3) add the missing Rust pure case using existing canonical primitives; (4) compare compiled Wasm and typed errors; (5) retain consumer regression and row result in existing Launch09. If an oracle currently runs through a helper, add the actual named producer output assertion rather than count a matching function name as coverage. No expected bytes generated by the implementation under test. A true TS bug needs an explicit corrected/versioned contract, not parity with the bug.

Numeric domains are per wire family: do not force canonical-body.v1's safe-integer subset onto every JSON record. Preserve valid legacy undefined/nonfinite/-0/error behavior where actually admitted; malformed JavaScript objects are not newly normalized into accepted wire data. Keep historical hashes and independent fixture origins.

## 5. Acceptance criteria

- [ ] All named batches/consumers are accounted for by actual TS→primitive→native/Wasm result, including explicit reuse, not an unbounded instruction to inventory later.
- [ ] Valid historical bytes/IDs/errors and K1/K2a remain stable; changed domain/revision/parser/profile and order/encoding/size negatives are detected.
- [ ] Actual linked producer/readback/replay tests still work. Pure native agreement alone does not prove a D1/HTTP caller.
- [ ] Real rust:vectors/boundaries/wasm and final rust:check pass; applicable #176 mutation debt is resolved/recorded by its existing gate, not a fabricated alias.
- [ ] Each row's function, fixture, implementing SHA and actual command/result is recorded in the original task/Launch09. Production authority remains TS until accepted S89 switch; no new registry, serializer framework or all-project rewrite.
