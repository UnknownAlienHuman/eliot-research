# Runtime contract — OWNER_SINGLE

[ADR-0018](../adr/0018-owner-single-function-first-profile.md) and [ADR-0019](../adr/0019-compact-refactoring.md) govern new work. [Implementation router](backend-entrypoints.md) lists unfinished changes. One Cloudflare Worker hosts API, ResearchWorkflow and ResearchSession; React/Vite replaces the legacy PWA after cutover.

## Boundaries

- **Owner list/draft:** authenticate at ingress; bounded indexed summary read. No per-item model qualification, grant hydration or citation traversal. A missing observation is unavailable; the same owner's last observed value may be marked stale. Principal change, sign-out and purge invalidate protected state.
- **Citation open:** resolve the admitted revision, exact bytes/range/digest, current membership and purge state. Search locators and model quotes are not evidence.
- **Mutation/paid work:** validate cheap bounds first; capture original intent, selected model, spend and cancellation identity. Reconcile uncertain effects before retry. An expired execution grant does not erase historical owner-readable results.
- **External client:** retain its explicit authorization/disclosure boundary. OWNER_SINGLE is not a universal bypass.

## Data movement

| Existing boundary | Limit |
|---|---|
| Serialized JSON request | 262,144 UTF-8 bytes |
| Semantic/MCP response | 512 KiB |
| Workflow receipt | 64 KiB; large results via immutable handles |
| Persisted ResearchSession state | 256 KiB, presentation only |
| Buffered R2 Workflow object | 8 MiB |

C03 remains open: the research input/planning writer shares the 64-KiB receipt ceiling although HTTP allows 256 KiB. Current semantic context composition also caps context at 64 KiB. Token capacity, provider request bytes and aggregate memory are distinct; align producers, readers and compact receipts before advertising FULL context. See [full-source answer](research-full-answer-v1.md).

## State ownership

D1 owns canonical records, expected-revision updates and atomic mutation/outbox commitment. No network/model/R2 effects inside D1 transactions. R2 staging is not evidence: conditional immutable writes require exact readback; failure to observe means unknown, not absent or conflicting. C01/C02/C11 remain open in the [audit](../../.github/audits/2026-10-17/README.md).

Queue accelerates persisted outbox work, not authority. One ResearchWorkflow owns a research run; new E0/E1 targets prepare-once, one synthesis and save/cite within 4–5 durable steps, while explicit E2/E3 keeps deep execution. ResearchSession is a bounded connection/progress projection, never a second executor or result store. Preserve original paid-attempt identity and cancellation. See [checkpoint retirement](workflow-checkpoints.md).

Use native Cloudflare AI Search/provider retrieval with existing source membership and delivery. Never rebuild the canceled generation registry. Top-k is not completeness; exact evidence remains canonical R2/D1.
