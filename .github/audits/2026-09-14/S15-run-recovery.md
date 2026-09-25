# S15 — Recover a run without repeating paid synthesis

Baseline: `a2aca127`; ER-09/21/24. Proposed API aligned with #206. This assignment does not implement the endpoint.

## 1. Problem

A transient VERIFY read failure after committed SYNTHESIZE should be recoverable within the same run. Total paid-call count need not remain unchanged: a not-yet-executed AUDIT_CLAIMS legitimately runs for the first time. Prevent duplicates of completed work; do not disable required auditing to satisfy a test.

## 2. Required change

Add POST `/api/v1/research/run/:workflow_id/recover` with `{}` and existing Idempotency-Key. Return existing ResearchRunStatus with HTTP 200 once the canonical outcome or recovered ACTIVE state is confirmed; retryable 503 for uncertain settlement; 409 for canonical CANCELLED, incompatible state, or an unjustified retry of an UNKNOWN provider effect. An already completed run returns 200 with its original status and no execution. Foreign/nonexistent runs share 404; revoked authorization is 403; malformed or unknown input fields are 400. Use the existing run service, not another job engine.

## 3. Documentation and exact search anchors

[Architecture, section 7.7.2](https://github.com/UnknownAlienHuman/eliot-research/blob/a2aca1277b0edbbed04de66e0d44e383e1b815ef/docs/architecture/ELIOT_RESEARCH.md); [execution contract, section 3](https://github.com/UnknownAlienHuman/eliot-research/blob/a2aca1277b0edbbed04de66e0d44e383e1b815ef/docs/implementation/launch-prs/execution-contract.md).

```sh
git grep -n -F 'A lost ACK is UNKNOWN' -- docs/implementation/launch-prs/execution-contract.md
git grep -n -F 'recoverStartedAttempt' -- apps/eliotr-core/src packages/cloudflare-research/src packages/cloudflare-research-stages/src
```

[Cloudflare Workers API](https://developers.cloudflare.com/workflows/build/workers-api/): resume applies to paused instances; ordinary restart resets intermediate state, while the documented restart-from-step form preserves earlier results. Check the actual API against pinned runtime/types; do not silently upgrade dependencies. This external documentation is not proof that the repository's current runtime supports every form.

## 4. Implementation approach

Authorize the owner or explicit recover delegation under #202. Reuse W2/W3 attempt state and recoverStartedAttempt. Before native lifecycle actions, read canonical attempt/output/receipt state and classify safe read retry, committed-output recovery, or UNKNOWN upstream outcome. Concurrent recovery requests must select one action through existing attempt/CAS discipline, not issue concurrent restarts. Repeated Idempotency-Key returns the same action's currently confirmed outcome, never a replacement run.

Choose the native lifecycle action using actual engine status. D1/R2 remain authoritative: committed stages recover from receipts without model calls even if native intermediate state was reset. Recovery cannot remove revocation/cancellation or change scope, freeze, handler, or operation ID. Use #197's incompatibility decision; S33 handles authority lifetime separately. Legitimate subsequent model stages still require ordinary spend policy, quote, and reservation, not a second accounting system.

## 5. Acceptance criteria

- [ ] Controlled fixture before the read failure: SYNTHESIZE=1 committed, AUDIT=0, with qualification/configuration fixed. After recovery: SYNTHESIZE=1 with unchanged hash/receipt, AUDIT=1 with its own valid reservation, and the same run reaches a lawful outcome.
- [ ] Concurrent/repeated recovery and lost ACK do not duplicate synthesis, audit, or restart actions; replay after completion creates no new charge.
- [ ] UNKNOWN provider effects remain unresolved until provable readback. Invalid, cancelled, revoked, or corrupt state is not classified as a transient retry.
- [ ] Insufficient budget for the first audit produces the ordinary constrained outcome; required audit is not skipped to obtain completion.
- [ ] Retain actual D1/R2 rows/objects, HTTP tests, exact SHA, and results. Authorized native Cloudflare lifecycle acceptance is separate from controlled-provider tests. S32 exposes these same actions in PWA/MCP.
