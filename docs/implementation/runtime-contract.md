# Runtime contract

## One active Worker

`apps/eliotr-core` contains HTTP routing, static asset routing, Queue consumer, scheduled handler,
`ResearchSession` Durable Object, and `ResearchWorkflow`. Packages are linked libraries, not services.

## Request path

```text
authenticate → parse strict DTO → authorize purpose/scope → freeze ScopeSnapshot
→ call application service → persist mutation/receipt → read back → map typed response → emit metrics
```

The HTTP layer never contains evidence, policy, retrieval, research, or erasure semantics.

## Bounded data movement

- ordinary JSON request: 256 KiB maximum;
- semantic/MCP response: 512 KiB maximum;
- DO/Workflow message or step return: 64 KiB maximum;
- persisted live DO state: 256 KiB maximum;
- buffered R2 bytes: 8 MiB maximum;
- larger content: immutable object handle + digest + range/cursor.

## D1

Transactions contain compact deterministic reads/writes only. No network/model/R2 call occurs inside a
transaction. Canonical mutation and outbox intent commit together. Expected-revision CAS protects heads.

## R2

Stage → hash → readback → validate → D1 admission → conditional promotion. A staging object is not
evidence. Canonical content uses a new key; same key with different bytes is integrity failure.

## Queue/outbox

The Queue is accelerated delivery. Consumers load the persisted intent by ID, check idempotency,
checkpoint attempt state, and acknowledge only after durable receipt/readback. DLQ presence is an alert.

## Durable Object

Routing key is `principal_id + investigation_or_chat_id`. State contains connected clients, stream
cursor, pending approval IDs, and compact presentation state only. Persist before notifying.

## Workflow

One instance owns one research run, audit, report, exhaustive scan, reindex, backup, or restore check.
Every step checks cancellation/budget, reads bounded handles, performs at most one expensive call,
writes large output immediately, and returns a compact idempotent receipt.

## Managed retrieval

AI Search and D1 Search return locator candidates. Publication or model support requires exact resolver
readback against the admitted source revision and frozen scope. Top-k, reranking, or Workflow completion
cannot prove absence.
