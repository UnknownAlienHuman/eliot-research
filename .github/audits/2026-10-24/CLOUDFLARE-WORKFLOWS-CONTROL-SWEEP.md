# Cloudflare Workflows control and recovery sweep

**Reviewed:** 2026-10-24. **Branch baseline:**
[`d3312180`](https://github.com/UnknownAlienHuman/eliot-research/tree/d3312180bd3c0276af95ecef701f14b18980ebd0).

This continuation checks current Cloudflare Workflows documentation, changelogs, release notes and the linked Cloudflare
engineering posts against Eliot's durable-job contract. It focuses on the operations most likely to duplicate paid work,
lose compensations or erase the only remaining execution evidence: step identity, rollback, restart, terminate, delete,
retention, subscriptions and same-Worker declarations. It is source review, not a deployed Workflow exercise.

## Findings

| # | Evidence and interpretation | Owning correction |
|---|---|---|
| 111 | A Workflow is dynamically executed as its code encounters steps. A deterministic step name is the durable cache key for the recorded step result. Unawaited steps may execute in parallel. Cloudflare specifically warns that `Promise.race()` and `Promise.any()` around Workflow steps can produce nondeterministic cached results, because losing branches continue and the first value observed by JavaScript need not be the value later recovered from durable step state. | Treat step identity and order as a versioned protocol. Store `workflow_contract_version` with every admitted job. Use stable names derived only from frozen inputs and deterministic iteration order. Use bounded `Promise.all()` only for independent read/compute branches whose complete result set is consumed. Do not place paid model calls, writes, approvals or cleanup inside `Promise.race()`/`Promise.any()`. A changed step name, occurrence order or output reader requires an active-instance inventory and an old/new compatibility exercise before deployment. |
| 112 | Saga rollback is compensation after the Workflow itself fails; catching an error and continuing does not trigger it. Eligible handlers run in reverse **step-start** order, not completion order. A failed `step.do()` may participate with `output: undefined`. Rollback handlers have their own retries/timeouts. If one rollback handler remains failed after its retries, Workflows records that failure, stops the remaining rollback chain and the instance settles errored. | Eliot does not add blanket rollback handlers to canonical R2/D1 publication, accepted pages, retained research or historical identity. Use rollback only for an explicitly provisional external reservation that has a safe idempotent inverse. The handler must tolerate missing output, use the same recorded effect/compensation identity and write its outcome to the existing D1 effect row. `compensation_failed` remains visible and owner-reconcilable; it is never reported as cancelled/clean. Later handlers cannot be assumed to have run. |
| 113 | `pause()` and `resume()` manage scheduling, but resume may queue behind the concurrency limit. `terminate()` normally stops without rollback; `terminate({ rollback: true })` runs eligible compensators first, and a terminated instance cannot resume. `restart()` may restart from the beginning or one named/count/type step: earlier cached results are reused while the selected step and every later step run again. `delete()` removes stored instance state and stops a running instance without rollback; code after self-delete does not run. | Product **Stop** first commits cancellation in D1 and lets the Workflow cooperatively stop after saving useful partial output. Forced terminate is an exceptional owner operation; rollback is requested only for a job profile whose provisional compensators are documented and tested. Eliot exposes no ordinary `restart`: it can rerun paid or mutating tail effects while reusing an incompatible prefix. Explicit Retry creates a newly admitted job/instance with frozen inputs and a new identity. `delete` is not cancellation; it is owner-only retention cleanup after D1/R2 outputs, effects and compensation state are reconciled. |
| 114 | New paid-plan Workflows default to seven-day completed/errored instance retention; older Workflows keep their prior setting, the paid maximum remains 30 days and Free remains three days. Retention can be set in configuration and per instance. `WorkflowInstance.subscribe()` first replays retained historical instance events and then emits live events, but subscriptions exist only while native instance state remains retained. | Declare a seven-day Workflow retention explicitly instead of inheriting an account-creation-date default. Native events/subscriptions drive the open progress view only. D1 job status, effect rows and R2 partial/final output remain reopen/history authority after native state expires or is deleted. Reconnecting subscribers must deduplicate/reduce replayed events into a view; they do not append product activity again. Longer native retention is an explicit diagnostic exception with a storage-cost reason, not a substitute for product persistence. |
| 115 | A Workflow defined by the same Worker can now be declared in the Worker `exports` map and invoked through `ctx.exports`. A duplicate `workflows` binding is unnecessary; if both forms are present, their name, class and settings must match. Export configuration can own schedules, limits and default retention. | Declare `IngestWorkflow`, `ResearchWorkflow` and `CleanupWorkflow` once in `exports` and call them through a small `ctx.exports` launcher passed by the transport composition layer. Do not expose raw Workflow handles to product functions or duplicate the same Workflow in `workflows` bindings. Add an external binding only if the Workflow is intentionally moved to a different Worker, with a separately reviewed trust/deployment boundary. |
| 116 | Cloudflare's engineering description says each instance Engine is the control plane's source of truth. Creation stores instance metadata on that Engine and uses background work plus Durable Object alarms with at-least-once execution to complete startup. The redesigned list operation is cursor-consistent, but the engineering internals are not an application exactly-once contract. | Retain Eliot's caller-chosen stable instance ID, pre-created `start_pending` D1 job and `get`/status reconciliation after an uncertain create acknowledgement. Neither a missing list entry nor a repeated client request authorizes another ID. Do not build an Eliot scheduler or registry around Cloudflare's internal SousChef/Gatekeeper design; only public binding/status behavior is relied upon. |
| 117 | Workflows support 10,000 steps by default and up to 25,000 when configured. `sleep` and `waitForEvent` are billable step operations. Batch creation and deletion APIs improve administration throughput but do not add per-job authorization, idempotency or product persistence. | Set a deliberately lower explicit `limits.steps` for each Eliot Workflow from its bounded algorithm and measure actual step/storage usage. Adaptive research also enforces D1 call/token/time/step counters and a no-progress stop; a platform maximum is not the product budget. Do not batch-create owner jobs: each needs its own admitted D1 row and immutable input. Batch delete is owner maintenance only after terminal-state/output/effect reconciliation, never an automatic history cleanup. |
| 118 | Current Vite plugin `1.65.0` incorporates local Workflow runtime fixes for disposing step results and for ordering native state deletion against recreation of the same instance ID. This confirms that local delete/recreate behavior has changed across tooling releases and that an emulator success is version-bound. | Stage 0 pins one compatible Wrangler/Vite/runtime set and adds a local delete/recreate regression using a disposable ID. Do not use a different global Wrangler to interpret local Workflow state, and do not treat local lifecycle behavior as production acceptance. The package remains a candidate until the replacement lockfile compiles and the same lifecycle cases are exercised against an isolated deployed Workflow. |

## Selected control policy

| Operation | Eliot meaning |
|---|---|
| Create | D1 `start_pending` row and immutable input first; stable caller-selected instance ID; reconcile uncertain acknowledgement |
| Step retry | Native retry only for safe reads or idempotent effects under the same recorded operation/effect identity |
| User Stop | Commit cancellation, stop admitting effects, save useful partial output, then settle visibly |
| Force terminate | Owner-only incident action; no implicit rollback |
| Terminate with rollback | Owner-only and only for a profile with tested provisional compensators |
| Retry job | New admission, job and Workflow instance; old state remains historical |
| Restart instance | Not exposed as a product action |
| Delete instance | Owner retention cleanup after product state/effects are reconciled; never product history deletion |
| Rollback handler | Idempotent compensation for a provisional external reservation, not transaction rollback for retained Eliot data |
| Subscription | Replayed/live progress projection during native retention; never product authority |

## Required implementation checks

```text
workflow exports are declared once and called through ctx.exports
explicit workflow contract version, step limit and retention
stable step name/type/count across re-entry and compatible deployments
no paid/mutating step under Promise.race or Promise.any
failed step rollback with undefined output
one rollback failure stops later compensators and remains visible
cooperative Stop after partial output
forced terminate with and without rollback
restart is unavailable through UI/API/MCP
instance delete cannot erase D1/R2 history or unresolved effects
subscription reconnect replays without duplicate product activity
retention expiry reopens from D1/R2 without regeneration
create acknowledgement loss reconciles the same stable instance ID
local delete/recreate and isolated deployed lifecycle tests use the pinned toolchain
```

## Verification boundary

The current Workflows Workers API, trigger/lifecycle, retry/rollback, deterministic-step, subscriptions, retention and
limits documentation was inspected together with the 2026 rollback, control-plane and workflow-diagram engineering posts
and the latest relevant Workers SDK releases. No Workflow was created, paused, resumed, restarted, terminated, rolled
back, deleted or allowed to expire. No rollback failure, subscription replay, create-ack loss, local delete/recreate or
mixed-code deployment was exercised. Those checks remain owned by the durable-job implementation slice.