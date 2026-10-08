# R10 — Consistent Investigation ledger snapshot reads

Date: 2026-10-08  
Source baseline: `3e6c25660c1ae515760e19d5f9e6b8a735795c4c`  
Scope: backend ledger read correctness. Documentation task; runtime is not changed here.

## 1. Confirmed defect

Current `readSnapshot` performs two independent D1 calls:

```text
SELECT ledger head
→ SELECT every event for investigation
→ assert events.length === head.event_head
```

A valid concurrent append can commit between those reads:

```text
reader sees head.event_head = N
writer atomically commits event N+1 and head N+1
reader sees events 1..N+1
reader reports LEDGER_INPUT_INVALID
```

The stored ledger is valid. The reader assembled two different committed versions and mislabeled the result as corruption.

This is not a stale-replica-only problem. It can occur on a single primary because the two SELECTs are separate operations.

## 2. Cloudflare primitive and boundary

D1 already provides:

- single SQL statements;
- `batch()` as a sequential SQL transaction;
- Sessions/bookmarks for sequential consistency and read replication.

Do not add an ORM, lock service or custom snapshot database.

D1 Sessions alone are not the primary fix here. Sequential consistency allows a later query to observe a newer committed version. It does not make two arbitrary SELECTs one historical snapshot.

Official references:

- [D1 Database API / `batch()`](https://developers.cloudflare.com/d1/worker-api/d1-database/#batch)
- [D1 Sessions and sequential consistency](https://developers.cloudflare.com/d1/best-practices/read-replication/)

## 3. Preferred minimal fix

Ledger events are append-only and ordered by sequence. The head read already provides the exact event frontier that belongs to that head.

After reading head with `event_head = N`, read only:

```sql
SELECT *
FROM investigation_ledger_event
WHERE investigation_id = ?1
  AND sequence <= ?2
ORDER BY sequence ASC
```

Then require:

```text
exactly N rows
sequences exactly 1..N
all investigation_id equal head.investigation_id
```

A concurrent append of N+1 no longer contaminates the older but internally valid snapshot. Missing, duplicate or malformed events inside 1..N still fail closed.

This is preferable to a retry loop because:

- a retry can spin under sustained writes;
- it hides the actual snapshot contract;
- it can return a newer head than the caller intended;
- it needlessly increases D1 reads.

## 4. Alternative allowed implementation

A D1 `batch([selectHead, selectEvents])` transaction is acceptable only if the implementation and native acceptance prove both reads observe one intended snapshot and the resulting API does not complicate null-head handling.

Even with batch, the event query should be bounded by the decoded head frontier when feasible. Reading unbounded historical events is unnecessary work and makes future corruption/oversize handling harder.

Do not use `withSession()` as a fake transaction.

## 5. CODE — exact ownership

Primary files:

```text
packages/research/src/ports.ts
  LEDGER_SQL.selectEvents

packages/research/src/investigation-service.ts
  readSnapshot
  assertContiguous
```

Tests:

```text
packages/research/src/research.test.ts
apps/eliotr-core/test/investigation-ledger-d1.test.ts
```

### 5.1 SQL contract

Replace the unbounded read or add a clearly named statement:

```ts
selectEventsThroughHead:
  "SELECT * FROM investigation_ledger_event " +
  "WHERE investigation_id = ?1 AND sequence <= ?2 " +
  "ORDER BY sequence ASC"
```

Do not keep both paths without an explicit legacy-only caller.

Bind only a validated positive safe `head.event_head`. A newly created ledger must have at least one event under the current schema; historical exceptional shapes must use an explicit codec/migration, not a negative limit.

### 5.2 Snapshot reader

Target:

```ts
const headRow = await ...selectHead...
if (headRow === null) return null
const head = decodeHead(headRow)
const eventRows = await ...selectEventsThroughHead...
  .bind(investigationId, head.event_head)
  .all<EventRow>()
const events = ...decode...
assertContiguous(head, events)
return { head, events }
```

Capture `investigationId` and head frontier once. Do not re-read the caller-owned input after awaits.

### 5.3 Error semantics

Keep distinct:

```text
stored head/event malformed or a gap inside declared frontier
  → LEDGER_INPUT_INVALID / integrity failure

D1 read unavailable
  → LEDGER_SETTLEMENT_UNCERTAIN, retryable

head absent
  → null / not found according to caller contract

concurrent append after head read
  → valid older snapshot, not failure
```

Wrap unknown D1 read exceptions at the current domain boundary; do not expose raw SQL/driver messages.

## 6. Related idempotency-space defect is separate

The global `idempotency_key` uniqueness/read path can let two principals choose the same raw key and collide. That requires identity/schema/legacy design and belongs to its existing admission owner (C17/#233 or a separate coordinated slice).

Do not expand R10 into changing idempotency uniqueness, command writes or authority fences.

## 7. Acceptance

### Concurrent append

Use a deterministic interleaving fixture:

```text
read head N
append N+1 commits
read events through N
snapshot returns head N + events 1..N
```

No corruption error.

### Real corruption

- head N but event N missing → fail;
- sequence gap or duplicate inside 1..N → fail;
- event from another investigation → fail;
- malformed row → fail;
- head frontier greater than safe schema bound → strict decode fails.

### Read behavior

- event N+1 committed before head read → snapshot N+1;
- event N+1 committed after head read → snapshot N;
- repeated read after append may return newer snapshot;
- no infinite retry/spin;
- `readByIdempotency`, create readback, append replay and supersession readback all use the corrected reader.

### D1 native acceptance

Add a focused actual-D1 test or controlled wrapper that injects the append between the two calls. Unit fixtures must not claim transactional D1 acceptance if they merely return hardcoded arrays.

## 8. Code reduction / efficiency

The implementation should report:

```text
old unbounded event SQL removed
maximum rows avoided in concurrent/historical ledger case
number of D1 calls unchanged or reduced
no retry loop added
```

Do not introduce a general snapshot abstraction for one two-query read.

## 9. Verification

```sh
pnpm --filter @eliotr/research typecheck
pnpm exec eslint \
  packages/research/src/ports.ts \
  packages/research/src/investigation-service.ts \
  packages/research/src/research.test.ts
pnpm exec vitest run \
  packages/research/src/research.test.ts \
  apps/eliotr-core/test/investigation-ledger-d1.test.ts
```

If SQL changes affect the declaration scanner/depth policy, run the normal D1 scoped checks. No migration is expected because this changes a SELECT, not persisted schema.

## 10. Completion result

A ledger read returns one internally consistent prefix identified by the head it actually read. Concurrent valid append no longer masquerades as stored corruption, while real gaps/malformed rows still fail closed.
