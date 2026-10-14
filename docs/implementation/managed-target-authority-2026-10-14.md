# Managed target authority — October 14, 2026

Source integration `aade65a24804f66407ba22d7b410d99980899401` combines the
membership revision and current assignment-head changes with their manifest
consumer. It is not a deployment or a generation-promotion receipt.

Project title edits advance metadata CAS and the orientation cache once while
preserving membership identities. Migration 0142 records the independent
membership head. Migration 0143 maintains one current assignment head from each
immutable event in the same D1 mutation. Required-set pages use that indexed
head instead of regrouping historical events. Its one-time backfill still
requires review against the actual deployed event count before application.

The manifest's internal protocol is `eliotr.managed-target-desired-items.v2`.
It carries the exact v2 required-set `target_fence`; metadata project revision
is excluded from stable desired-item identity. Fresh source and shadow checks
remain required before immutable root publication. The public export surface
is preserved; extracted type/error declarations retain their original bytes.

Verification on this composition: owning projection/navigation/Core/backup
TypeScript and scoped ESLint passed; the combined Core schema has zero depth
failures. Twelve changed/new manifest cases passed, including a title-only
interleaving and an assignment-change denial. The unchanged legacy-profile
denial was retained from its earlier passing execution. Two actual local Core
D1/R2 tests passed for exact normalized bytes and missing-byte denial. The
worker tests use local bindings and do not qualify live Access or AI Search.
The earlier 14 native target-fence cases and large-history/current-head query
plan are retained; unchanged passing cases were not replayed for receipts.

#360's per-page history-scan defect is resolved at this source/local scope.
#356 still requires the promoter's explicit writer drain. #359's later product
comment asks for a stable owner opt-in in place of exposing physical provider
identity; that follow-up remains open. #363–#368 retain their registry,
canonical storage and resumable-capacity acceptance requirements. Remote
0142/0143 application and final source deployment have not run.
