# D1 schema ownership

`core/migrations` is canonical compact state. `search/migrations` is a rebuildable exact/FTS safety
projection. One agent owns each migration sequence. Never edit an applied migration; add a numbered
migration and a compatibility/readback test. Model, HTTP, R2, Google, and AI Search calls are forbidden
inside D1 transactions.

## Expression-depth compiler guard

Run `pnpm d1:depth` (or `node infra/d1/check-expression-depth.mjs`) before publishing SQL changes.
It also starts `check:full`; `check:affected` is a deprecated alias for the full check.
Independent Ubuntu/Windows CI jobs run it without waiting for source budgets or behavioral suites. No
result is ignored or converted into a successful gate.

The build-time wrapper requires Python >=3.11 with SQLite >=3.45 (CI selects Python 3.13). It uses
the pinned TypeScript AST extractor from the frozen workspace install and Python stdlib SQLite;
there is no remote database or Worker runtime dependency. It sets
`SQLITE_LIMIT_EXPR_DEPTH=100` **before** applying both migration chains to separate empty databases.
An isolated compiler calibration checks that a 120-term trigger compiles at 1000, fails at 100,
and that removing the trigger restores compilation. A missing-table negative calibration also
proves the application compiler fails on invalid SQL. Statement caching is disabled.

`EXPLAIN` compiles INSERT, first-column UPDATE, all-column UPDATE and DELETE for every trigger-bearing
table. All-column UPDATE activates UPDATE OF guards. It also compiles every view SELECT and the
supported INSTEAD OF writes for writable views. Probe statements are never executed. Failures print
only the store, object/shape or migration filename and a bounded error category, not SQL or row data.
The same gate inventories application `prepare(...)` calls in Core and package source, evaluates
recoverable literals/registered variants without executing application code, and compiles them with
inert placeholder bindings. The extractor records a target for direct canonical receivers
`env.CORE_DB`, `env.SEARCH_DB`, `this.env.CORE_DB`, and `this.env.SEARCH_DB`, and for visible,
earlier same-function `const` aliases and alias chains rooted at `env.CORE_DB` or `env.SEARCH_DB`
through that function's `env` parameter. Alias resolution rejects mutated or shadowed bindings;
aliases from `this.env`, constructor fields, parameters, imports, `let`, destructuring,
conditional/factory expressions, and cross-function or call-site forwarding remain `unknown`.
Recovered aliases carry the
`resolved-local-const-alias` target status. The extractor records a literal `.bind(...)` argument count
when statically recoverable, otherwise `bindingArity` stays unknown. Unresolved SQL sites include a
stable classification, receiver target status, and bind-arity status. Shadowed names and unknown
branches cannot masquerade as recovered constants. Fixture-only files and explicitly named
`*-test-support.ts` sources are excluded from application SQL and reported separately.

Every recovered query is still compiled against both schemas for candidate diagnostics, but only its
recorded target schema can satisfy the application check. If that target rejects the query while the
other schema accepts it, the compiler reports `cross_schema_only` and fails. Unknown targets still get
both candidate compiles and are reported as `target_qualification=INCOMPLETE`; unknown target or arity
does not turn the depth-only gate into a false qualification claim. Set
`D1_DEPTH_STRICT_TARGETS=1` when invoking the wrapper to make any unknown target, unknown bind arity,
unresolved prepare site, or target-schema rejection fail closed. Without that option the gate remains
useful for expression-depth/schema compilation while explicitly reporting incomplete binding coverage.

Exit 1 means a schema or known-target application-query compilation failure (or incomplete target
coverage in strict mode); exit 2 means missing tooling or an invalid compiler setup.

## TypeScript route proof and optional classification details

The model-qualification HTTP route is selected through two provenance passes over one TypeScript
`Program`. The route-table entry and exact call edges are matched by checker symbol identity, then the
selected route is followed through the route-matching and fallthrough structure. A same-spelled but
unrelated route or an ambiguous path does not qualify a query target; unsupported or unresolved cases
remain unknown.

Set `D1_DEPTH_CLASSIFICATION_DETAILS=1` to emit one sanitized JSON classification record from the same
inventory and compiler invocation. The record contains source locations, target and binding metadata,
candidate-schema outcomes, counts, and allowlisted unresolved classifications. It omits SQL text,
receiver expressions, and row data. The setting does not launch another compiler or change the
default output when unset. It does not change the strict gate: an incomplete strict run still exits 1.

## October 6, 2026 assembled classification and native checkpoint

The owner stopped implementation after publishing source checkpoint
`557c081098e6459e89c4d78051cbef290a44ac9e`. #294 remains open for the production
prepared UPDATE OF source/target/trigger case; that extension was not implemented
or tested at the October 6 stop. The owner resumed on October 8; see the follow-up below.

## October 8 #294 continuation: production UPDATE OF source path

A focused invocation of the installed extractor now reports bounded positive callsite
evidence for this parameter-forwarded query without promoting its global target
classification. The source query is packages/cloudflare-workflows/src/failures.ts:248, and the current
production binding arity is 11. retainWorkflowFailure forwards the same database
parameter to recordWorkflowFailure; the Workflow application passes its typed
environment.CORE_DB, composed from this.env.CORE_DB by the Worker Workflow entry.
The output labels these observed paths positive-paths-only with exhaustive=false;
targetStore remains unknown, so this evidence does not claim every invocation or
reduce the saved 1,029-unknown aggregate count.

The command node infra/d1/test-update-of-source-coverage.mjs extracts that production
statement and runs the existing calibrated SQLite EXPLAIN compiler at depth 100 against
all 122 current Core migrations and all four Search migrations. SQLite 3.50.4 compiled
the statement against Core and selected the four installed UPDATE OF failure guards
from migration 0123. A schema-derived unrelated-column UPDATE selected none of those
guards; Search rejected the production statement because it does not own
research_workflow_run. The test does not execute a product UPDATE or read product
rows. It replaces the former synthetic-table trigger case; the full D1 inventory and
native D1 acceptance remain separate and pending.

The assembled checkpoint is based on `main` `65fcf3363c55ef738bbb15a55845a601b8369561`;
its published SHA is recorded in #294. Prepare-declaration classification and target provenance
share the existing TypeScript `Program`. Canonical Workers D1 declarations are resolved through the
installed SDK module and checked by declaration and receiver identity, including merged declarations.
This is static declaration evidence, not proof of a runtime database binding. A resolved
non-canonical declaration can still wrap D1; it is not classified as database-free.

The single installed strict depth-100 invocation used SQLite 3.50.4, passed calibration, and
reported 120 Core migrations, 147 tables, 24 views, four Search migrations, 613 schema shapes,
and 1,049 recovered application query variants across 1,020 files. It had zero application
compiler failures and zero known-target schema failures. All 20 previously proven target records
are unchanged. Strict qualification remains `INCOMPLETE`, exit 1: 1,029 unknown targets,
85 unknown binding arities, and 144 unresolved prepare occurrences. The general receiver pass
adds zero proven targets to this installed inventory. Mutation, escape, opaque calls and unsupported
flow remain unknown; conservative global aborts do not publish partial proof.

Every one of the 1,193 recovered or unresolved report rows has a closed declaration classification.
Recovered rows comprise 995 `workers-d1-database`, 22 `workers-d1-session`, and 32
`resolved-non-canonical`; unresolved rows comprise 100, six, and 38 respectively. The sanitized
report includes neither SQL nor receiver text. Declaration classification does not clear unknown
target, arity or SQL status, and candidate-schema compilation does not establish complete binding proof.

Focused fixtures passed for declaration classification, the existing extractor, general receiver
mutation/escape rejection, and source-derived UPDATE OF coverage. The UPDATE OF fixture uses the
actual extractor and existing compiler functions: a column-sensitive source update activates the
deep trigger at limit 100, an unrelated-column update compiles, and generic all-column versus
first-column probes retain the same distinction. SQL is extracted, not copied into a parallel checker.

One exact-source local workerd/D1 run covered ten model-attempt, qualification-summary, erasure
and projection/replay files: 67 of 68 tests passed. The new summary test failed because its negative
fixture incorrectly expected the dispatcher to use a substituted Search handle; production dispatch
rehydrates the Core handle. After correcting only that fixture, one invocation of the new file passed
1/1. The nine unchanged files retain their 67 passing cases; this is not a single 68/68 aggregate run.
The summary test exercises production stores with local transport, correct-schema rejection on the
reader and recorder, readback, lost write acknowledgement, immutable replay, foreign identity/hash
rejection and concurrent recorder replays after a committed record. It does not prove a race between
initial writers, cross-isolate dispatch or production D1. Runtime and migrations remain unchanged.

Scoped lint passed and the new test has no own TypeScript diagnostics. The Core test-project
typecheck still fails with 59 diagnostics in six other files. Their diagnostic identities were
unchanged before and after the summary-fixture correction; that comparison does not establish a
historical-main baseline. Overall test-project compilation remains unaccepted. The earlier local
15/15 delivery and 64/64 authority/ledger/Workflow/recovery receipts remain separate, with unchanged
source pins. No deployment, remote binding, provider request or backup operation occurred.

## Earlier October 6 reviewed source-cardinality checkpoint

The reviewed four-file source-cardinality checkpoint is based on `main`
`3d564187221b60f5e1950ba8f3ad6664aa6164a0` (published SHA recorded in #294). Its single calibrated
SQLite 3.50.4 depth-100 invocation scanned 120 Core migrations, 147 tables, 24 views, four Search
migrations, 613 schema shapes, and 1,049 application query variants across 1,020 files. Candidate
compilation had zero compile failures and zero target-schema failures. All 20 previously proven
target classifications are unchanged, including the three Core model-summary arities 1, 1, and 9.

SQL values and bind arities now use the same lexical invocation context. Fixed array shapes, stable
aliases, literal slice bounds, supported fixed fresh returns, and resolved rest-argument calls can
establish arity without counting SQL placeholders. Mutation, escape, unknown callers or values,
shadowed helpers, unsupported control flow and nonliteral slice bounds remain unknown. Nineteen
previously unknown query arities are resolved across 14 source locations. Broader caller enumeration
also exposes additional variants and unknown fallbacks; this is not a claim that every spread is known.

That strict report remains `INCOMPLETE`, exit 1: 1,029 targets are unknown, 85 binding arities
are unknown, and 144 prepare occurrences remain unresolved. The earlier route-proof checkpoint
`ed97d9655b22f9a9844815c7f5cd57f5a6f25fdd` reported 1,028 variants, 1,008 unknown targets, 79 unknown
arities and 130 unresolved occurrences; those counts are historical. Successful candidate compilation
does not establish complete target provenance or production D1 qualification. Backup/restore source
is inventoried without performing or developing canceled backup/restore operations. #294 remains open.

The additional source-bound local workerd/D1 delivery checkpoint passed 15/15 tests across three
files: four new delivery-replay cases, six existing Q1 cases, and five outbox-reconciler cases.
It verifies accepted-send ACK loss and retry, committed `SENT` with lost settlement ACK, concurrent
and expired inbox leases, stale-generation rejection, corrected handler retry and altered-payload
rejection. D1 state and receipts are read back through production stores; captured transport models
the local send/ACK boundary. This does not qualify physical Cloudflare Queue, DLQ or production D1.
Scoped lint passed and the new test has no TypeScript diagnostics, but the Core test-project typecheck
fails with 59 diagnostics in six other files; those diagnostics were not compared with a baseline run.
Compilation of the full test project remains unaccepted. Runtime and migration source remain unchanged; the earlier
64/64 authority/ledger/Workflow/recovery receipt is retained separately.

The compiler is the depth-100 check for #293/#294, **not full D1 emulation or behavioral acceptance**. It does
not prove authorization, concurrency, readback, native runtime limits or every dynamically constructed
application query. The real-workerd jobs and S91/S92 acceptance remain required. Migration 0084
repairs the reviewed chain; do not edit old migrations or raise the limit to make this pass.

## 0084 authority-chain repair

The forward migration decorrelates effective-scope/workflow/recovery lookups, compacts composite
identity equality and separates checkpoint invariants within one atomic trigger invocation. It keeps
legacy/delegated branches disjoint and preserves semijoin cardinality with DISTINCT where joins may
find multiple witnesses. No durable authorization cache, owner bypass, table rewrite or weaker expiry,
purge, revocation, receipt, CAS or cancellation predicate is introduced.

The actual Stop/Recover statements also use shallow same-operation joins. Their 18 fence bindings,
original-owner exception, independent owner-machine cancellation and effective-execution requirement
for recovery remain unchanged. Each join is pinned to the unique run operation; it cannot multiply
recovery reservations. The grant writer retains an insertion failure through exact readback: a matching
row reconciles a lost acknowledgement, while an unconfirmed write/read failure is a bounded 503 with
retryable=false. Proven no-match without a storage failure retains the existing 403. Internal causes
are not exposed through HTTP/MCP error text.

On the 2026-10-01 local checkpoint (Node 25.6.1 / TypeScript 6.0.3 / SQLite 3.50.4), the
depth-100 compiler checks 96 Core migrations, 94 trigger-bearing tables, 22 views and 399
generic statement shapes with zero failures. Search's four migrations compile. The installed
source extractor recovers 780 SQL expressions: Core compiles 739, Search compiles 69, and all
780 compile against at least one candidate schema. It explicitly records 100 unresolved sites
and seven fixture-only files; output lists at most 30 unresolved locations plus an omitted count.
These are compile-only observations, not product requests, native D1 qualification, binding-aware
target verification or exhaustive dynamic-SQL coverage. Native and integration/negative/concurrency
acceptance remain #294/S91/S92 work. The historical 711-query count is superseded by this
reproducible source inventory.
