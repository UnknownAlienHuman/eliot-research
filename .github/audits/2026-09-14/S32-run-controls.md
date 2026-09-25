# S32 — Expose Stop/Recover to owners and agents

Baseline: `a2aca127`; ER-21/24/25/36. Code dependencies: S14/#206 cancellation, S15/#207 recovery, and S13/#205 for MCP. These dependencies do not require closing future live checks. This is a planning assignment. The restriction concerns duplicate completed paid effects, not the first legitimate audit after recovery.

## 1. Problem

An endpoint alone does not give users control of a run. Closing a tab is not cancellation, and clicking Start again is not recovery. The previous blanket prohibition on additional model effects was too broad: committed SYNTHESIZE may still need its first AUDIT_CLAIMS stage.

## 2. Required change

Add Stop for ACTIVE runs and Recover for a server-confirmed recoverable failure to the existing Research panel/API client. MCP tools eliotr_research_cancel and eliotr_research_recover delegate to the same services; inputs are workflow_instance_id/idempotency_key, not caller-supplied authentication. Use exactly #206/#207's REST paths/status DTOs, not another DO-control API.

Show confirmed cancellation only after acceptance; an uncertain response has a distinct confirmation-pending state. Recovery continues the same run. Explicit reopen or a new investigation remains a different operation.

## 3. Documentation and exact search anchors

[Architecture 7.7.1–7.7.2](https://github.com/UnknownAlienHuman/eliot-research/blob/a2aca1277b0edbbed04de66e0d44e383e1b815ef/docs/architecture/ELIOT_RESEARCH.md); [stage factory](https://github.com/UnknownAlienHuman/eliot-research/blob/a2aca1277b0edbbed04de66e0d44e383e1b815ef/apps/eliotr-core/src/research-stage-handlers.ts).

```sh
git grep -n -F 'persist before notifying clients' -- docs/architecture/ELIOT_RESEARCH.md
git grep -n -F 'AUDIT_CLAIMS' -- apps/eliotr-core/src/research-stage-handlers.ts
```

## 4. Implementation approach

Reuse panel lifecycle/status decoding, the operation ID/action key, and MCP dispatcher. Sending a request must not optimistically show CANCELLED. After a lost response, retain the same action key and read status/receipts; do not issue a new Start or another recovery key while the outcome is unknown. Coalesce double-clicks, but server idempotency must remain independently correct.

Do not offer false recovery for cancelled, integrity-failed, or incompatible runs. The server supplies the reason and permitted next step; the client must not infer retryability from message substrings. Tools are not readOnly and preserve server idempotency. Late responses for old runs/revoked sessions cannot change the active view. Cancellation does not claim physical termination of an already dispatched provider call; it prevents subsequent authorized stages after canonical acceptance.

Compare paid effects per stage/operation. Never repeat committed synthesis. Permit a first unexecuted audit under its ordinary policy/reservation. Insufficient audit budget remains a budget outcome, not skipped verification or false completion. Ordinary status/readback calls invoke no model.

## 5. Acceptance criteria

- [ ] PWA/MCP start→stop→reload reaches confirmed CANCELLED; sending, 503, and lost response alone never count as confirmation.
- [ ] Recovery fixture: SYNTHESIZE=1/AUDIT=0 before failure becomes SYNTHESIZE=1/AUDIT=1 with the same run/synthesis hash. Total call count need not remain unchanged.
- [ ] Recovery replay, double-clicks, and lost responses after completion create no extra attempts, reservations, or runs.
- [ ] Read-only/foreign/revoked requests fail server-side; late responses cannot restore private views.
- [ ] Controls have accessible names and distinct pending/confirmed/blocked states. Record actual HTTP/D1/browser/MCP tests and exact SHA; no second control plane or client-faked success.
