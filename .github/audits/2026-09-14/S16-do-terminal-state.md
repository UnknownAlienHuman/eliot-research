# S16 — Make DO terminal state agree with the canonical outcome

Baseline: `a2aca127`; finding F12. P2: an internal DO path, not a reproduced user-facing race.

## 1. Problem

`ResearchSession.cancel` catches a D1 cancellation error as best effort and still saves CANCELLED. After external I/O, `execute` writes ENGINE_COMPLETED from an older snapshot. Unconfirmed cancellation success is visible in the code; the completion/cancellation interleaving still needs reproduction.

## 2. Required change

Remove unconfirmed success and make DO terminal state a monotone projection of the canonical D1 outcome. Do not move canonical authority from D1 into the DO.

## 3. Documentation and exact search anchors

[Architecture, section 7.7.1](https://github.com/UnknownAlienHuman/eliot-research/blob/a2aca1277b0edbbed04de66e0d44e383e1b815ef/docs/architecture/ELIOT_RESEARCH.md).

```sh
git grep -n -F 'persist before notifying clients' -- docs/architecture/ELIOT_RESEARCH.md
git grep -n -F 'best-effort' -- apps/eliotr-core/src/research-session.ts
```

## 4. Implementation approach

Identify actual callers first; do not assume this DO branch is the primary HTTP entry point. Pause execution at a controlled external await, issue cancellation, and then release completion. On a D1 error, reconcile using existing receipt readback. Return uncertain/error when canonical cancellation remains unconfirmed; never fabricate a receipt. An acknowledgement error followed by verified CANCELLED readback may legitimately return the confirmed outcome, consistently with S14.

After canonical settlement, update the DO projection through a short atomic comparison with its current state. A non-atomic reread followed by save does not fix the race. Do not hold a long DO lock across model/network I/O. Distinguish failed canonical cancellation from failure of best-effort native termination after D1 already confirmed cancellation.

## 5. Acceptance criteria

- [ ] Unconfirmed D1 cancellation never produces successful CANCELLED. A lost ACK with verified canonical readback returns the actual outcome.
- [ ] A canonical cancellation that won cannot be overwritten by late execution completion.
- [ ] Completion-first, cancellation-first, lost ACK, and restart converge on one D1 outcome.
- [ ] Foreign/stale callers fail; original operation/receipt IDs remain unchanged.
- [ ] Record caller reachability and interleaving tests with exact SHA. An unreachable or differently scoped path is not presented as a demonstrated live incident.
