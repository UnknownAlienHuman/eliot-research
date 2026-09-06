# Cloudflare usage envelope (FIX1-B two-layer guard)

Live status: `NOT_EXECUTED` / `IMPLEMENTED_NOT_LIVE`. All evaluation below is
deterministic against mocked fixtures; no live Cloudflare usage aggregate has
been observed.

## What the envelope is

The envelope is 80% of each included Cloudflare quota. It is NOT a Cloudflare
hard cap: Cloudflare enforces its own limits, while this repository enforces
the smaller local admission boundary first and fails closed.

| Product | Included quota (100%) | Envelope (80%) |
|---|---|---|
| Workers requests (Workers Paid, monthly renewal) | 10,000,000 / mo | 8,000,000 / mo |
| Workers CPU time (Workers Paid, monthly renewal) | 30,000,000 ms / mo | 24,000,000 ms / mo |
| D1 storage / rows read / rows written (decimal GB) | 5 GB (5,000,000,000 B) / 25B / 50M | 4 GB (4,000,000,000 B) / 20B / 40M |
| R2 storage / Class A / Class B (R2 paid inclusions, decimal GB-mo) | 10 GB-mo / 1M / 10M | 8 GB-mo / 800K / 8M |
| Queues operations, 64,000-byte chunks + ~100 B overhead (retries + DLQ included) | 1,000,000 / mo | 800,000 / mo |
| Durable Objects req / GB-s / SQL reads / SQL writes / storage (decimal GB) | 1M / 400K / 25B / 50M / 5 GB | 800K / 320K / 20B / 40M / 4 GB |
| Workers AI neurons (daily UTC midnight reset) | 10,000 / day | 8,000 / day |
| AI Search instances / queries | exactly 5 / 25,000 / mo | exactly 5 / 20,000 / mo |
| Vectorize queried dims / stored dims | 50M / 10M per mo | 40M / 8M per mo |
| Access | one owner-only hostname app, 24 h session | contour (see below) |

Plan scope: this deployment budgets Workers Paid monthly inclusions + R2
paid inclusions. Free-tier daily limits are a separate optional profile and
must never be mislabeled as this envelope. Pricing GB/KB are decimal
(1 GB = 1,000,000,000 bytes; 1 KB = 1,000 bytes) unless a source below states
otherwise; byte conversions use `bytesFromDecimalGb` / `decimalGbFromBytes`.
Monthly windows approximate subscription-renewal months as UTC calendar
months; daily windows reset at UTC midnight. Wrong-window or reset-crossing
snapshots fail closed (SEALED/BLOCKED, never admitted).

Official sources (retrieved 2026-09-06; validated against Wrangler 4.127.1;
tests mock only observed response/pagination fields):

- https://developers.cloudflare.com/workers/pricing/ (workers req/CPU)
- https://developers.cloudflare.com/workers/platform/limits/ (workers limits)
- https://developers.cloudflare.com/d1/pricing/ (D1 storage/rows)
- https://developers.cloudflare.com/r2/pricing/ (R2 storage/ops)
- https://developers.cloudflare.com/queues/pricing/ (Queues 64 KB chunks)
- https://developers.cloudflare.com/durable-objects/pricing/ (DO/SQLite)
- https://developers.cloudflare.com/workers-ai/pricing/ (AI neurons/day)
- https://developers.cloudflare.com/ai-search/limits-pricing/ (AI Search 5/queries)
- https://developers.cloudflare.com/vectorize/pricing/ (Vectorize dims)

A value at or above 90% of its envelope is a near-limit advisory; anything
above the envelope blocks. `unknown` is never coerced to zero.

The `$1` billing alert, where configured, is generic advisory only. It never
admits, seals, or blocks provisioning: only the envelope evaluation and the
runtime ledger below are authority.

## Layer 1: usage preflight receipt

`scripts/check-cloudflare-usage-preflight.mjs` runs before any remote
mutation. It authenticates with the browser/Wrangler-OAuth profile only
(bearer in memory, redacted everywhere), verifies the active account, and
evaluates the account-wide aggregate, which already includes unrelated
(Gotham) consumption. It atomically writes the redacted admission receipt to
ignored `.eliotr-state/cloudflare-usage-admission-receipt.json` (temp file +
rename, mode 0600). Exact account values stay in ignored local state;
committed fixtures are fictional (`example.invalid`, fake hex IDs).

Decisions: `ADMITTED` (fresh, known, inside), `SEALED` (stale, wrong window,
or unknown metrics: zero/metadata-only provisioning may proceed, everything
below stays disabled), `BLOCKED` (malformed, wrong account, missing binding,
or over envelope: exit nonzero before the first mutation).

Unknown or unexposed metrics seal: ingestion, queue produce/consume,
Workflow/DO execution, Workers AI calls, AI Search index/query, and
Vectorize writes/queries stay disabled until a fresh authoritative aggregate
OR a controller-owned ledger plus inventory proof shows headroom. Sealed
state is never silently waived.

## Billing Usage v2 (Alpha, Restricted) source contract

`GET /accounts/{account_id}/billable/usage` returns FinOps FOCUS v1.3 rows
(one billable metric, one account, one day). Optional `from`/`to` ISO dates
travel together (max 31 days; omitted defaults start-of-month through today).
The provider always sends explicit `from`/`to` derived from the intended
account-bound interval — month start through start-of-today, never a future
month end — and parses ONLY documented fields: `BillingAccountId`,
`BillingAccountName`, `ChargeCategory`, `ChargeDescription`,
`ChargeFrequency`, `ChargePeriodStart` (inclusive), `ChargePeriodEnd`
(exclusive), `ConsumedQuantity`, `ConsumedUnit`, `x_BillableMetricId`,
`x_BillableMetricName` (plus tolerated optional cost/pricing/region/
subaccount/tags/product/zone fields, which never affect counters). Cost
fields may be absent until billing integration completes.

Fail-closed rules (all typed unknown, never zero):

- Every accepted row must carry exact `BillingAccountId` identity; missing
  or mismatched rows are `MALFORMED`/`ACCOUNT_MISMATCH` — identity is never
  inherited from the request or a top-level echo.
- Every accepted row must carry real `ChargePeriodStart`/`End` evidence
  inside the queried interval; missing, invalid, outside, future,
  overlapping-ambiguous, or incomplete (per-metric gapped) evidence is typed
  unknown. Window coverage is validated separately for every mapped metric:
  each metric admitted as authoritative must continuously cover the exact
  full queried window on its own intervals; intervals from another metric
  never bridge a gap. The retired synthetic `{metric,unit,value}` + `window_start` /
  `window_end` schema is rejected as `MALFORMED`.
- Mapping binds a reviewed `x_BillableMetricId` + `x_BillableMetricName` +
  `ConsumedUnit` triple to an envelope metric: the name is identity, never
  display text — no bare-metric fallback, no display-name-only mapping, no
  ID+unit fallback. Missing/substituted names and unknown triples fail
  closed; absent metrics stay unknown (never zero).
- `401`/`403`/`404`, malformed bodies, and partial intervals stay typed
  unknown with no entitlement claims. Receipts and failures carry status and
  window metadata only — never bodies, account IDs, bearers, or emails.

## Provenance enforcement and pagination completeness

A numeric enters a snapshot only through an authorized channel, recorded per
metric as enforced trust state:

- `authoritative_billing` only from the validated Usage v2 provider above;
- `authoritative_inventory` only for registry-authorized counts (AI Search
  instance count from `/ai-search/instances`), never billing counters;
- `analytics_nonbilling` (GraphQL) stays diagnostic metadata, never metrics
  — an injected analytics `workers_requests:42` keeps the aggregate unknown;
- `ledger_estimate` stays unknown (no complete account-bound ledger contract
  exists); missing/malformed/unknown-provenance/mismatched-coverage numerics
  stay unknown, as do wrong/missing account bindings, invalid windows,
  partial pagination, conflicting full-account reporters, and numeric-after-gap.

`fullAccount:true` requires proven completeness: cumulative counts must equal
a supplied stable `total_count` (drift rejects), coherent page echoes are
required where the API accounts totals, and D1-style pagination that
establishes a multi-page walk must keep echoing its stable metadata — a
missing page echo, `per_page`, count, `total_count`, or `total_pages` on a
later page fails closed instead of `fullAccount:true`. R2 cursor walks prove completion
only with an explicit empty terminal cursor (`PARTIAL_PAGINATION` when the
hop cap hits with a next cursor pending). AI Search termination is decisive
on its own shape (`result_info` or `pagination`, never forced D1 semantics):
a short page WITHOUT totals proves nothing (`PARTIAL_PAGINATION`, never
`fullAccount:true`), and totals present on page 1 then absent on a later
page fail closed — ambiguity never admits.

The live registry (`buildLiveProviderRegistry`) wires all four inventory
collectors plus the Usage v2 billing provider: the billing endpoint carries
account-bound `from`/`to` derived from the intended interval (month start
through start-of-today, never a future month end, never over 31 days) with
the reviewed triple mapping. A registry-level billing failure (no
entitlement etc.) gaps the declared billing covers, leaving those metrics
unknown rather than dropping the provider silently; billing never covers
`ai_search_instances`, so an outage cannot clobber the inventory count.

## Direct-provisioner denial

`BLOCKED` stops every provisioner mode before the first call. `SEALED`
additionally stops every direct apply path (core, AI Search, Access, AI
Gateways):
while sealed, no `POST`/`PUT`/`PATCH`/`DELETE`, Worker upload, or migration
may occur. Check-only inspection stays read-only metadata. The deploy
orchestrator requires `ADMITTED` before any remote mutation.

## Layer 2: runtime budget admission

`scripts/lib/cloudflare-budget-admission.mjs` gates individual operations:
atomic check-and-reserve against the envelope share minus a 5% safety
margin, daily fencing at UTC midnight, monthly fencing at the UTC month
boundary, retry/DLQ delivery accounting against Queue operations,
concurrency leases (default cap 4), and heavy-operation admission only on a
fresh `ADMITTED` receipt or a fresh ledger-plus-inventory proof. Denials are
non-secret; the caller must never invoke the billable binding when blocked.

## Exact deployment order

1. `scripts/provision-cloudflare-access.mjs` FIRST: creates/verifies the one
   owner-only hostname Access application (24 h session, WebSocket-compatible
   hostname contour; Worker-level Access stays prohibited) and persists the
   Cloudflare-generated AUD plus exact team origin in the ignored Access
   receipt.
2. `scripts/check-cloudflare-usage-preflight.mjs` (also auto-invoked at the
   top of the core, Access, and deploy entry points; `BLOCKED` aborts before
   the first mutation with zero remote effects).
3. `scripts/provision-cloudflare-core.mjs`: foundation D1/R2/Queues plus the
   generated deploy config. Fails without Access authority; rechecks the live
   Access binding read-only before the first foundation mutation.
4. `scripts/provision-ai-search.mjs`: the exactly 5 required instances
   (`private-prose-g2`, `private-literal-g2`, `wiki-g2`, `artifact-g2`,
   `web-capture-g2`); temporary cap 20,000 queries/mo until the envelope
   admits more.
5. `scripts/provision-ai-gateways.mjs`.
6. `scripts/deploy-cloudflare.mjs`: local gates, cross-product `--check-only`
   for every provisioner, apply, additive D1 migrations, exactly one Worker
   deploy, then inventory/export readback plus authenticated smoke.

The deploy orchestrator internally replays steps 3-5 in check-only then apply
order; Access-first is achieved by requiring the pre-existing Access receipt
(bootstrap step 1 directly). A missing Access or usage receipt seals the
Worker: no publicly usable `workers.dev` outside Access is ever produced
(`preview_urls=false`, alternative public routes prohibited).

## Resource allowlist (project-prefixed only)

Worker `eliotr-core`; D1 `eliotr-core`, `eliotr-search`; R2 `eliotr-evidence`,
`eliotr-work`; Queues `eliotr-jobs`, `eliotr-dlq`; AI Gateways
`eliotr-reasoning`, `eliotr-retrieval`; the five AI Search instance IDs
above. Provisioners address resources by exact name and never delete;
Gotham or otherwise unrelated inventory is counted by the envelope but never
mutated or included in generated config.

## Verification (node-direct, mocked, no live calls)

```text
node scripts/test-usage-envelope.mjs
node scripts/test-budget-admission.mjs
```

Cover: placeholder accept, wrong-account/stale/wrong-window/unknown/
over/near-limit handling, unrelated-usage aggregation, OAuth bearer
redaction, expired/missing credentials, no API-token fallback, atomic
concurrent admission, retry/DLQ/daily-monthly fencing, zero mutations and no
billable call on block, sealed-vs-activated heavy work, Access-first with no
exposed Worker on partial failure, Gotham allowlist protection, and receipt
schema/readback/digest plus atomic write. Live Cloudflare remains
`NOT_EXECUTED`.
