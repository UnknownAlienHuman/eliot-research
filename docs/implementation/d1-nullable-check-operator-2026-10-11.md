# Guarded D1 nullable CHECK validation — October 11, 2026

This ER-26 amendment adds nullable CHECK admission to the existing migration
operator. The unchanged published suffix is not remote-qualified. It changes
neither product SQL nor the normal Wrangler apply transport. Source publication, migration application, Worker
deployment and full release remain separate transitions.

The dependency graph pins Wrangler 4.143.1 exactly. Its local path uses a
statement splitter; remote `d1 migrations apply` appends the migration-ledger
INSERT and sends the whole normalized script as one `sql` string to D1 `/query`.
The retained installed-splitter/SQLite 3.51.2 check of all 129 Core migrations
and the nine-file suffix covers only the local parser/schema boundary.
It does not qualify the remote transport. The native trigger guard for
unparenthesized CASE is restored, with balanced BEGIN/CASE/END validation retained.
The existing backup parser-compatibility fixture and workers-sdk #4727 document
this restriction; the issue was closed as a duplicate, not as evidence of a fix.

The sole deployer attempted the unchanged suffix once on October 11, 2026.
Remote `/query` returned `incomplete input: SQLITE_ERROR [code: 7500]` on migration
0123. Intent `cc9e8049-780b-4701-b840-544bd08f4e28` remains UNKNOWN and must never
be reapplied. Subsequent SELECT-only readback observed all 47 schema objects and
the 120-name ledger unchanged. This does not identify the exact server parser
failure or establish general rollback guarantees. The failed request body was
sanitized out of the retained Wrangler log. A new intent alone cannot repair an
incompatible script. Historical migrations remain append-only; no SQL rewrite,
raw apply or manual ledger insertion is authorized by this amendment.

SQLite may validate an added CHECK against existing rows. Nullable constraints
are therefore classified `schema_constraint_validation`, including constraints
already recognized for migration 0117. This is not a metadata-only or scan-free
operation. Only same-column NULL-or-scalar predicates are recognized: the
existing positive-integer and fixed hexadecimal forms, JSON_VALID, equality to
one bounded literal, and an ordered bounded LENGTH interval. NOT NULL, DEFAULT,
subqueries, foreign-column references, arbitrary functions and extra expressions
remain rejected by the existing ALTER parser and its single predicate authority.

An intent with validation work must use
`eliotr.cloudflare-d1-migration-intent.v3`. It retains v2 grouped schema probes
and all existing account/config/database/suffix/SQL/bundle/deadline pins. Its
strict risk_review additionally contains `constraint_scan_bounds`, ordered by
lowercase table_name, with exactly the classifier-derived tables and total
validation_count for each. Each entry supplies a reviewed max_rows from 0 to
1000 and a validation_count from 1 to 64. These are operation-specific admission
bounds for small existing tables, not product quotas. The bound is explicit;
the operator does not derive or silently enlarge it from current data.

Immediately before normal apply, after exact target/ledger/schema preconditions,
the operator issues a SELECT-only count over a LIMIT max_rows+1 subquery for each
table. A saturated, missing, malformed, cancelled or mutating response stops
before apply. The corresponding versioned v3 receipt persists
constraint_scan_observations before the effect. Successful saved receipts require
complete matching PASS observations; receipt replay performs reconciliation and
does not repeat the effect. Existing timeout/cancellation/lost-ACK UNKNOWN and
new-intent continuation rules remain in force.

This readback bounds the observed admission state. It cannot prevent concurrent
growth after the read and does not cap actual validation cost atomically. The
risk review must cover that interval and the operation's runtime deadline; a
deadline does not prove cancellation of a started remote effect. The existing
Time Travel bookmark, exact source pins and full schema/ledger readback remain
required. No raw SQL/Wrangler bypass is introduced.

Required verification covers the remote-transport trigger preflight guard,
strict predicate
negatives, exact cost coverage, pre-effect overflow/unavailable/cancellation,
receipt tampering, no repeated apply, and the owning migration-operation suite.
Remote counts and actual migration/readback are the sole deployer's distinct
gate. Full S64, S92, provider qualification and project acceptance stay open.

References: [ADR-0009](../adr/0009-control-plane-deployment-and-runtime-cost-authority.md),
[D1 migrations](https://developers.cloudflare.com/d1/reference/migrations/),
[trigger parser report](https://github.com/cloudflare/workers-sdk/issues/4727),
[current remote /query report](https://github.com/cloudflare/workers-sdk/issues/15690),
[SQLite ADD COLUMN](https://www.sqlite.org/lang_altertable.html#alter_table_add_column).
