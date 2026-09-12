# ER-13: D1 authority and migrations

**Slice:** 0
**Depends on:** ER-00, ER-01, ER-23
**Live gate:** remote D1 migration/readback when credentials are supplied; otherwise NOT EXECUTED

## Objective

Own non-disposable D1 Core authority, additive migrations, named repositories, expected-head/fence
semantics and atomic canonical mutation plus outbox. Model/provider/network calls never occur inside a
D1 authority transaction.

## Owned paths

- `packages/platform-cloudflare/src/bindings.ts`
- `packages/platform-cloudflare/src/d1.ts`
- `packages/platform-cloudflare/src/d1-outbox-authority.ts`
- `packages/platform-cloudflare/src/d1-outbox-authority.test.ts`
- `packages/platform-cloudflare/src/d1-outbox-store.ts`
- `packages/platform-cloudflare/src/d1-outbox-store.test.ts`
- `packages/platform-cloudflare/src/d1-inbox-store.ts`
- `packages/platform-cloudflare/src/d1-inbox-store.test.ts`
- `packages/platform-cloudflare/src/execution-lease.ts`
- `packages/platform-cloudflare/src/execution-lease.test.ts`
- `packages/platform-cloudflare/src/index.ts`
- `infra/d1/**`
- `apps/eliotr-core/test/investigation-ledger-d1.test.ts`
- `apps/eliotr-core/test/investigation-ledger-commands-d1.test.ts`
- `scripts/check-delivery-authority.mjs`

- `infra/d1/core/migrations/0042_wiki_publication.sql`
## Implemented contour

```text
OperationIntent strict decode
→ atomic operation_intent + digest-bound outbox batch
→ exact idempotency readback
→ generation-fenced producer lease
→ delivered / retry / dead-letter settlement
→ durable consumer inbox identity
→ generation-fenced operation execution lease
```

Core migrations now advance through:

```text
core-v1
0002 execution coordination
0003 inbox payload digest
0004 outbox delivery fence
core-v4-delivery-fenced
```

Worker readiness requires the exact current Core and Search generations. An older non-null schema is
blocked rather than treated as ready.

## Acceptance

- canonical intent and outbox insertion are atomic;
- idempotency key reuse with different intent/payload bytes fails;
- stale producer, inbox and execution fences cannot settle newer work;
- lost acknowledgement reconciles only against an exact terminal row;
- malformed 64-character non-hex digests fail at the D1 boundary;
- Queue consumers reload durable authority and never synthesize work from message payload alone.

## Mandatory negative boundary

Crash or lose the response after the authority batch/Queue send, then replay. Readback must return the
same intent/receipt and must not create a second authority mutation or projection job.

## Verification

```text
pnpm delivery:check
pnpm --filter @eliotr/platform-cloudflare test
pnpm check:boundaries
pnpm check:budgets
```

Remote D1 and Queue/DLQ receipts remain `NOT EXECUTED`; this packet is not `LIVE_QUALIFIED`.

## Additive navigation schema

The MCP client diagnostic checkpoint is allocated `0044_mcp_client_diagnostics.sql`.
It stores an owner-scoped, expiring challenge hash and one immutable observation from an
authenticated MCP call. The only persisted transition is `ISSUED` to `CONFIRMED`; expiration is
derived when reading or consuming an unused challenge. A confirmed observation remains historical
after challenge expiry. Owner credentials and the independently authenticated MCP actor are distinct
identities. Internal actor and credential fields are retained for server validation and are not public
status fields. This table grants no source access, operation execution, Google permission or model
qualification. ER-36 owns the consuming service and its integration proof. Remote migration and
readback remain `NOT_EXECUTED`.

The ER-24 research caller correction is allocated `0040_research_policy_authority_scope.sql`.
Independent scope policy authorities may coexist; each authority retains at most one ACTIVE policy
generation. Existing legacy bindings are preserved, and retired generations must not be reactivated by
a caller retry. Raw Luna owns this migration under the integrator's serialized ER-13 handoff.

The ER-28 erasure admission prerequisite is allocated `0039_erasure_admission_policy.sql` for explicit,
versioned destructive permissions and currentness/revocation readback. Source admission and read grants
are not erasure permission. Installation is a trusted operator boundary, with no public grant route;
this allocation grants no actor production access. ER-27 owns the actual Worker/D1 fixture
`apps/eliotr-core/test/erasure-admission-policy.test.ts`. Coordinator/HTTP integration and complete
backup absence proof remain separate acceptance requirements before enabling the ERASURE slice.

The ER-09 W3 pricing handoff is allocated `0038_research_model_pricing.sql` for immutable model pricing
snapshot storage. This allocation supplies no prices or budget approval. ER-27 owns
`apps/eliotr-core/test/research-model-pricing-store.test.ts`, including exact replay, conflict/corruption
refusal and lost-write-acknowledgement readback. Existing `budget_reservation` remains the reservation
authority; this migration must not create a competing reservation or payment receipt.

`0010_navigation_artifacts.sql` adds ER-31's scope-bound immutable navigation rows, insertion guards
and dependent-body deletion triggers. It changes no existing source/evidence authority, global schema
head, outbox semantics or enabled Worker route. Apply it with the other Core migrations before composing
the navigation service. `check-erasure-closure.mjs` executes the entire migration stream; the ER-31 local
Workers fixture exercises the actual table and trigger statements. Remote migration/readback is still
`NOT_EXECUTED`. Rollback disables the consuming code, not destructive rollback of additive tables.

## Stage15 citation recovery binding allocation

The configured exploratory research checkpoint reserves `0045_research_workflow_citation_binding.sql`
for an immutable internal link from the exact W2 Stage15 operation, attempt and request digest to a
canonical citation receipt and digest. Existing W2 authority and the receipt's exact active grant bind
scope and access identity. One historical receipt may be shared by distinct valid workflow operations;
receipt identity is not globally unique in the binding table. This additive schema does not advance
runtime readiness or activate public research recovery. Exact atomic persistence, current readback and
interruption acceptance remain required before the recovery path is accepted.
