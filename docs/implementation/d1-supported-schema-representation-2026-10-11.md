# Source-derived D1 schema representation

This distinct control-plane version resolves the C29 representation boundary.
It does not establish native remote effect readiness, full S91/S52/S92 acceptance
or a release. Original Core 129 SQL files remain authoritative and unchanged.
The original cc9e8049-780b-4701-b840-544bd08f4e28 intent remains UNKNOWN forever;
never reapply it or repair its ledger manually.

## Protocols and exact byte authority

Migration intent/receipt v5 uses eliotr.d1-native-trigger-case-commentless.v1
transport. Its pending suffix alone is projected through quote-aware comment
deletion and then the existing depth-zero CASE parentheses
representation. Ordinary
installed Wrangler applies a per-intent mirror, preserving original config,
canonical migration paths, ordering and native bookkeeping. Historical files
are copied byte-exact. Original and effective file/full-stream pins remain
separate; the native Node invocation retains shell:false.

The schema manifest v2 and provenance v3 retain the complete raw source catalogue,
original migration pins, effective stream pins and pinned intent file. The
descriptor eliotr.d1-source-schema-representation.v1 permits exactly two SQL
byte variants per application object: its source raw bytes, and its source
commentless bytes. Both are generated from the source before reading remote
values. Either variant may have the same hash. Comment deletion preserves all
quoted/literal/identifier/operator bytes, spelling, whitespace and line endings
outside comments; unsafe adjacent token boundaries and unterminated constructs
reject. It inserts no separators and folds no case. Arbitrary added or changed
comments are not another accepted variant.

SQLite line comments terminate only at LF (ASCII 0x0a) or EOF; a bare CR remains
inside the comment. The terminating LF is retained as a separator. Removing
comments before CASE admission prevents hidden SQL after CR from becoming active
or reaching the legacy CASE tokenizer. The existing v4 CASE-only path is unchanged.
This rule follows [SQLite comment syntax](https://sqlite.org/lang_comment.html),
read on 2026-10-11, and is covered by an in-memory SQLite column/trigger regression.

The complete remote query retains its completeness sentinel and existing
SQLite-internal/native-ledger exclusions. Attestation v2 verifies exact
type/name/tbl_name/count/membership and one of those finite raw SQL variants,
then records a common represented catalogue pin. It also retains the complete
raw observed objects, raw observed catalogue hash and raw expected catalogue
hash. Extra, missing or altered objects reject the whole Core/Search attestation.
The old v1 manifest/attestation and v1-v4 migration raw semantics remain unchanged.

For v5's grouped object probes, before_sql_sha256/create_sql_sha256 pin the
source commentless representation, while additional before_raw_sql_sha256/
create_raw_sql_sha256 pin each original source schema definition. Absence has
both before hashes null. The observed raw SQL hash must equal one of the two
source-derived hashes and its represented hash must match; the v5 receipt retains
both. Pending commentless effects ordinarily collapse the two after variants.
Saved receipt validation requires these fields and prevents protocol downgrade,
transport substitution and UNKNOWN effect reapplication.

## Closed platform shapes from vendor source

The local source profile is workerd-source-local-bookmark-shape.v1
(_cf_METADATA, INTEGER key). The remote target profile is
workerd-source-kv-shape.v1 (_cf_KV, TEXT primary key, WITHOUT ROWID).
These are distinct shapes. Both constructor source hashes and literal hashes
are fixed in the descriptor. The full catalogue comparison includes the target
platform object; it does not exclude every _cf_ object. Changed, unknown, duplicate
or missing platform objects reject. A shape match does not identify the deployed
remote runtime version, bootstrap history or a public stability guarantee.

Source authority is workerd v1.20260926.1, read on 2026-10-11:

- [KV constructor, lines 64-79](https://github.com/cloudflare/workerd/blob/v1.20260926.1/src/workerd/util/sqlite-kv.c%2B%2B#L64-L79),
  source SHA256 f4b97e4f68510df8a63c982eacc0a9de69c1ec92e5609bfc0676611de3e33fe6.
- [Metadata constructor, lines 78-89](https://github.com/cloudflare/workerd/blob/v1.20260926.1/src/workerd/util/sqlite-metadata.c%2B%2B#L78-L89),
  source SHA256 d2bb1f60b6956186f094b28452fdc7a09e8b29eff29c590f08b24139820dcd8c.
- [Metadata purpose, lines 11-20](https://github.com/cloudflare/workerd/blob/v1.20260926.1/src/workerd/util/sqlite-metadata.h#L11-L20):
  simulated local D1 bookmark is not used in production. This does not declare
  the whole metadata facility interchangeable with KV.

## Qualification boundary

New pure byte/profile negatives and isolated SQLite/control-plane fixtures
exercise this version. Their API/process inputs are controlled; they do not
qualify native remote D1. Historical accepted suites, vendor-constructor
observations and unchanged Q/N results are retained without replay.
Scoped diagnostics, exact source review and the sole publisher's new source
integration precede any fresh authorized intent, full native producer or effect.
Do not turn a static source/observation diagnostic into a live acceptance receipt.
