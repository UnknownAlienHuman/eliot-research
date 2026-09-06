# Launch 03 / #91 — Structural Corpus Lens, not metadata-only orientation

Read execution-contract.md. Reviewed code f94bd7a. Canonical ELIOT_RESEARCH §§3,4.2–4.4,5.1–5.3,
5.3.1,6.5–6.7,6.11–6.12,13,15.4–15.5,18 Slice 3,19.2/19.5; language §§5–8.
Owners: ER-05 structural projection, ER-30 scopes, ER-31 navigation, ER-39 evidence; ER-21/24 API,
ER-25 PWA, ER-23 corpus, ER-27 integrated tests. No graph database, second corpus or implicit grants.

## Reuse and inputs

Use `packages/retrieval/src/navigation*.ts`, `packages/cloudflare-evidence/src/navigation-*.ts`,
`packages/cloudflare-navigation/src/{navigation-service,orientation-materialization,orientation-service}.ts`,
existing D1 navigation migrations and `apps/eliotr-core/test/navigation-*.ts`. Immutable navigation
storage, identity validation and owner metadata orientation already exist. Existing maps report missing
structure honestly; do not replace them with invented headings. #90 Q2/Q3 supplies exact opening and
query/trace for the full user loop; N1 can work on admitted normalized bundles before that integration.
ArgumentMap/EvidenceAtoms belong to #94 P5/ER-32, not a second implementation here.

## Ordered local checkpoints

### N1 — Materialize maps from admitted coordinate bytes (start here)

Files: ER-05 `packages/retrieval/src/projection.ts`; ER-31 builders/codec/service; current R2/evidence
read ports. Read exact normalized artifact and coordinate-map handles under current admitted revision,
owner, residency and ScopeSnapshot. Build stable section hierarchy, heading paths, native/normalized
anchors and explicit losses using existing identity functions. Persist SourceCard/DocumentMap through
existing immutable store; exact replay reuses it. Do not infer page/table/code coordinates from prose.
Tests: real local R2/D1 with nested sections, RU/EN/code/table, non-ASCII byte offsets, reordered headings,
missing/partial map, duplicate IDs, invalid parent/range, different bytes at same identity, max/max+1,
purge and owner change between load/save. PASS: every claimed exact coordinate resolves to its original
admitted bytes; unsupported coordinates are typed gaps; missing structure remains explicit; no duplicate
artifact or source grant after retries. All reads and traversal are bounded; no whole-corpus load.

### N2 — Connect orientation expansion to exact evidence (after N1 and #90 Q2/Q3)

Files: ER-31 navigation service, ER-24 orientation materialization/service, ER-21 versioned API additions,
ER-39 resolver. Route source -> map -> section/parent/neighbors -> exact open/verify through the same
current scope and grant. Preserve metadata-only behavior as a declared narrower profile; full structural
requests cannot silently downgrade and report success at higher precision. Persist provenance/trace
and explicit selected/omitted counts. A map entry is a locator until exact resolver acceptance.
Tests: authorized path plus revoked scope, stale map generation, old source head, corrupt excerpt hash,
parent expansion crossing disclosure boundary, missing section and expired cursor. PASS: returned
EvidenceHandle and receipt reopen the exact section; no map/preview is treated as citation support,
and old/private results cannot return after reauth/offline or policy withdrawal.

### N3 — ProjectAtlas with exact source-set accounting (after N1; integrated opening after N2)

Files: ER-31 navigation builders/service, ER-30 membership/snapshot authority and existing D1 store.
Construct immutable Atlas from allowed SourceCards/DocumentMaps, not top-k sampling disguised as a
complete corpus. Include version/membership closure, coverage and omissions. Preserve native,
deterministic, parser-derived, model-candidate and reviewed relation precision; use existing D1 relation
ledger contract, not a new graph service. Summaries remain navigation, not independent external evidence.
Tests: one source in two projects, UNION/INTERSECT/EXCEPT, expired membership, missing/oversized source
set, duplicate family, cycle/ambiguous relation and source appearing only in an omission record followed
by purge. PASS: eligible = represented + explicitly omitted for the declared denominator; no double
count or duplicated canonical original; invalidation reaches every dependent Atlas, including omissions.
A bounded partial Atlas labels its limits and cannot issue a completeness/absence conclusion.

### N4 — One full Library/Atlas browser loop and conformance probe (after N2/N3 and #98 L1)

Files: ER-25 existing Lens panels; proposed ER-27 `tests/integration/browser/lens.spec.ts` in L1 harness.
Open an admitted corpus, switch projects/scope, navigate Atlas -> source -> section -> pinned evidence,
inspect omissions/trace, restart and return to the same immutable artifact. Exercise budget stop,
missing map, policy revoke and purge during expansion. Use actual local Worker/D1/R2; only the external
issuer or optional model response may be controlled and labelled. No mocked application HTTP.
PASS: browser state matches durable identities and does not show stale private data; complete valid
maps have reproducible anchors, degraded maps show honest limitations, and text is safely escaped.
Add the same scenario to O1 shared probe runner with missing-input/wrong-generation/timeout tests.

## Verification and good result

Run the execution-contract command block, focused navigation/identity/persistence/orientation tests,
strict Worker fixtures, L1 Playwright suite and exact-head full CI. Retain each test's input manifest,
source/map/scope/Atlas digests and observed omission set. Required positives reproduce 100%; invalid
coordinates, hidden sources, illicit grants and purge-surviving navigation each have 0 acceptances.
Do not count successful storage-only tests as N4. Keep all N1–N4 unchecked until implemented and tested.

## Account-only acceptance after #96 O7

Use real R2/D1 and a representative long/mixed corpus; build and read back maps/Atlas from the exact
admitted input, then repeat the browser path with real Access. Retain independent hashes, membership
and invalidation receipts, bounded read/latency metrics and UI observations. Any generated summary
must preserve source lineage and its lower precision. No metadata-only fallback qualifies structural
Lens. Follow cloudflare-handoff.md #91; no partial live development or separate deployment entrypoint.
