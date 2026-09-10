# Durable research stage checkpoints — W2a

`@eliotr/cloudflare-research` implements the D1/R2 checkpoint boundary, not the research product.
The public `ResearchWorkflow` remains fail-closed. No new Worker, model, endpoint or deployment is enabled.

## Execution

`createWorkflowCheckpointExecutor(CORE_DB, WORK_BUCKET, ports)` exposes `execute(request, principal,
handler)` and `cancel(operationId, principal)`. The request is strictly versioned as
`eliotr.workflow-stage.v1`; it pins the operation, Investigation revision, idempotency key, handler
generation and immutable input manifest with all six residency domains. The principal comes from
verified server authentication, never from the request body.

The first input must equal the W1 portfolio handle and input digest. Later inputs must equal the exact
preceding checkpoint output. All 18 canonical stages execute monotonically; a skipped stage, changed
input, stale revision, foreign credential or changed handler generation fails closed. The current grant must explicitly permit
`research`; purpose withdrawal is also checked inside the checkpoint transaction.

```text
current W1/scope/grant/policy/deployment/purge + residency + bounded budget check
→ durable unique attempt → one handler invocation → durable output intent
→ immutable conditional R2 PUT → checksum/length/residency/byte readback
→ one D1 batch: W1 CHECKPOINT command + stage receipt + notification outbox
→ exact persisted receipt and output readback → compact handle-only step result
```

The handler receives a detached request, bounded input bytes, attempt identity and pinned budget receipt.
The executor invokes it at most once per stage. W3 must supply a governed handler with at most one
expensive provider boundary; the executor does not inspect arbitrary handler internals or qualify billing.
Execution here is sequential. The existing 2/4/0 branch fan-out policy is unchanged; the branch scheduler
and exhaustive-job composition remain follow-up W2 work.

## Failure and recovery

A lost reservation ACK is reconciled against the exact attempt nonce before invoking the handler.
A lost R2/output-intent/checkpoint ACK is reconciled from persisted identity and exact bytes. `STARTED`
without a known durable output remains `WORKFLOW_EFFECT_UNCERTAIN`; it never invokes the handler again.
A missing or corrupted output is not regenerated. Deleting an uncertain attempt to permit a retry is forbidden.

Cancellation is durable and monotone. Transaction-time cancellation or authority withdrawal rolls back
the W1 advance, stage receipt and outbox together. Late/stale output cannot become an accepted checkpoint.
Replay rechecks access and residency but does not acquire a fresh spending reservation for completed work.

`authorizeResidency` and `checkBudget` are required trusted ports. Budget checks must be idempotent and
return the same reservation binding, with a maximum ten-minute grant. Expiry or changed authorization
stops continuation; renewal/uncertain-provider settlement requires W3, not silent replacement of a grant.
The caller must not expose these ports as user-supplied callbacks.

## Bounds and proof ceiling

R2 input/output objects are capped at 8 MiB; larger artifacts must be represented by bounded manifests.
Reads check size before allocation and verify conditional object identity and the actual SHA-256 bytes.
Step receipts are strict JSON, capped at 64 KiB, and contain handles rather than source/model text.

`ENGINE_COMPLETED` means only that all engine stages checkpointed. It does not close the Investigation,
accept an obligation, create evidence assurance or return a research CompletionDisposition. W4 owns those
independent decisions. The checkpoint notification is only a locator, not publication evidence.

## Integration and migration

Migration `0020_research_workflow_checkpoints.sql` adds three metadata tables, a current-authority view and
transaction guards. Existing W1 commands/migrations and the public readiness generation are unchanged. No backfill or launch-hold
removal occurs. Do not roll back by deleting attempts; keep the public composition disabled during rollback.

Before live composition, implement W3 budget/provider settlement, W4 governed stage handlers,
`research.workflow.checkpoint.v1` outbox locator resolution/session delivery, and explicit retention/erasure
and backup/restore closure for the new metadata and Work objects. These are not qualified by this slice.
Queued checkpoint notifications must not be routed to an unrelated existing consumer.

Language owner: TypeScript Cloudflare I/O, SQL storage authority; deterministic migration target:
`eliotr-research-core` (transitional reference, not promoted Rust authority). Versioned fixtures live in
`infra/workflows/checkpoint-vectors.v1.json` and execute in the real local workerd D1/R2 suite
`apps/eliotr-core/test/research-workflow.test.ts`. Controlled handlers test effect counts, not live model
quality or provider settlement. Live Cloudflare/provider qualification: `NOT_EXECUTED`.
