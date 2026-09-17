# S62 — Authorize an erasure request and expose its durable status

Baseline: `a2aca1277b0edbbed04de66e0d44e383e1b815ef`; ER-28/24/25. Permission production, erasure services, and the coordinator already exist. Reuse them. This assignment performs no deletion.

## 1. Problem

Erasure code and a button do not prove a complete authorized user flow. ERASURE is declared disabled and the registry retains incomplete caller/coordinator wiring. A request must create one ErasureCase and report the actual outcome, not merely successful submission.

## 2. Required change

Connect existing prepare → permission → execute → status through owner HTTP and the existing PWA panel. This task completes coordinator initiation/observation; S63 covers closure across all derived managed copies.

## 3. Documentation and exact search anchors

[ER-28](https://github.com/UnknownAlienHuman/eliot-research/blob/a2aca1277b0edbbed04de66e0d44e383e1b815ef/docs/agent-work/ER-28-privacy-erasure-and-purge-closure.md), Required implementation and Mandatory negative boundary; canonical ErasureCase.

```sh
git grep -n -F '## Mandatory negative boundary' -- docs/agent-work/ER-28-privacy-erasure-and-purge-closure.md
git grep -n -F 'prepareErasureForOwner' -- apps/eliotr-core/src
```

## 4. Implementation approach

Use erasure-owner-prepare.ts, erasure-owner-service.ts, erasure-owner-status.ts, current DTOs, and the coordinator. Permission is bound to the authorized owner and exact namespace/source/scope; ordinary Research delegation does not grant erase. Bind request, permission, and case through existing idempotency identity. Submission is not PURGED. Do not manually reset grants/purge ledgers or introduce another deletion queue. Use existing PENDING/BLOCKED/completion status without expanding Research CompletionDisposition.

## 5. Acceptance criteria

- [ ] Owner HTTP/PWA confirms the exact source, creates one case, and reads status against local Worker/D1/R2. Replay/reload creates no second case.
- [ ] Foreign sources, unauthorized services, stale/expired permission, and changed input under the same key are rejected before deletion.
- [ ] Lost ACK reconciles the original case. BLOCKED/UNKNOWN are never labeled PURGED and expose a safe reason/next action.
- [ ] Source content and credentials remain absent from logs.
- [ ] Record before/after rows, exact SHA, and erasure/browser tests. This assignment does not authorize deleting production data.
