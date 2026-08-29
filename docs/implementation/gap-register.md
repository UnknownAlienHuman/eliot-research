# Implementation gap register

This register prevents agents from confusing broad architecture coverage with executable coverage.
It supplements the per-agent packets; it does not create a second ownership system.

| Priority | Gap | Existing owner | Closure evidence |
|---|---|---|---|
| P0 | Ingest admission/promotion is not wired end-to-end | ER-13, ER-14, ER-15, ER-24, ER-29 | real R2 stage/hash/readback, D1 source revision + outbox, Queue projection receipt and lost-ACK reconciliation |
| P0 | EvidenceHandle resolution is not connected to every citation/output path | ER-07, ER-11, ER-19, ER-22 | index-only citation impossible; stale/purged/digest-mismatch negatives |
| P0 | Erasure coordinator intentionally throws | ER-28 | exact closure, blocked-retention case, provider/index/backup absence verification |
| P0 | Federation service intentionally throws | ER-22 | idempotent async job, cursor/range read, less-assertive disposition mapping |
| P1 | Worker composition and Access dispatch are implemented but not live-qualified | ER-17, ER-21, ER-24, ER-26 | deployed owner JWT, service-token class denial/allow fixtures and remote D1 catalog readback |
| P1 | Queue consumer application handler is still a shell | ER-15, ER-24 | lost-ACK replay, duplicate delivery, poison message and DLQ reconciliation |
| P1 | Research Workflow has contract stages but not governed execution | ER-20, ER-24 | cancellation/budget at every checkpoint; evidence freeze and claim audit |
| P1 | Managed search response needs strict locator decoding before canonical resolution | ER-18, ER-19 | oversized/malformed/fake-handle fixtures; exact resolver required |
| P1 | Scope algebra persistence is not wired to the deterministic evaluator | ER-10, ER-30 | immutable snapshot digest, purge-ledger binding and invalidation fixtures |
| P1 | Drive cursor/OAuth/tamper flow remains non-live | ER-19, ER-20, ER-26 | disposable append/import/readback/reconnect + historical-row tamper fixture |
| P2 | Backup/restore export exists only as design contour | ER-34 | clean-account restore with purge ledger applied before payload exposure |
| P2 | PWA screens are shells and lack session/error/offline behavior | ER-25 | owner flow, degraded provider state, evidence viewer and job reconnect tests |
| P2 | T2/T3 corpus is too small for generation promotion | ER-31, ER-32 | real RU/EN/code cases and adjudicated regression thresholds |
| P2 | T6 workload profile has not been measured | ER-35 | 5/20/50 readers, D1 contention, index throughput, cost and p95 receipts |

Rules:

1. Close the P0 authority and evidence path before adding advanced research products.
2. A live product gate cannot be replaced by a mock, typecheck, or dry-run.
3. A provider result remains a locator or candidate until the canonical readback path succeeds.
4. Update this table and `implementation-status.json` in the same change that removes a scaffold.
5. `IMPLEMENTED_NOT_LIVE` means code and deterministic negative tests exist; it does not mean a platform round trip occurred.
