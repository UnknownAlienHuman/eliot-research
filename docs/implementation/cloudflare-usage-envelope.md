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
| Workers requests | 10,000,000 / mo | 8,000,000 / mo |
| Workers CPU time | 30,000,000 ms / mo | 24,000,000 ms / mo |
| D1 storage / rows read / rows written | 5 GiB / 25B / 50M | 4 GiB / 20B / 40M |
| R2 storage / Class A / Class B | 10 GB-mo / 1M / 10M | 8 GB-mo / 800K / 8M |
| Queues operations (retries + DLQ included) | 1,000,000 / mo | 800,000 / mo |
| Durable Objects req / GB-s / SQL reads / SQL writes / storage | 1M / 400K / 25B / 50M / 5 GiB | 800K / 320K / 20B / 40M / 4 GiB |
| Workers AI neurons | 10,000 / day | 8,000 / day |
| AI Search instances / queries | exactly 5 / 25,000 / mo | exactly 5 / 20,000 / mo |
| Vectorize queried dims / stored dims | 50M / 10M per mo | 40M / 8M per mo |
| Access | one owner-only hostname app, 24 h session | contour (see below) |

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
