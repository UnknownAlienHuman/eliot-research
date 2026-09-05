# Implementation gap register

This register prevents agents from confusing broad architecture coverage with executable coverage.
It supplements the per-agent packets; it does not create a second ownership system. The dependency order,
production definition and final exit evidence are specified in
[`production-readiness-plan.md`](production-readiness-plan.md).

| Priority | Gap | Existing owner | Closure evidence |
|---|---|---|---|
| P1 | Deployment HTTP verification and release ordering are implemented but not live-qualified; complete binding/version attestation is still missing | ER-26, ER-27 | retain real generation-bound authenticated smoke, full binding/version readback and failure/redeploy receipts; see `deployment-audit-2026-09-04.md` |
| P1 | Generic federation boundary is implemented but not wired into the Worker composition root or live-qualified | ER-22, ER-24 | compose authenticated D1/R2 authority ports, expose routes, and retain mutual-auth/idempotency/range/cursor receipts |
| P1 | Rust deterministic-kernel M1 verification foundation is complete; M2–M7 authority migration remains open | ER-00, ER-01, ER-02, ER-03 and capability owners | M2 canonical identity/serialization parity; M3–M4 deterministic-domain migration; M5–M7 ABI promotion, shadow receipts, promoted Rust authority and superseded TypeScript removal |
| P1 | Exact erasure closure is implemented but not live-qualified across Cloudflare/provider/offsite paths | ER-28, ER-34 | remote R2/D1/AI Search/offsite deletion, blocked-lock, restart replay and restore purge-ledger receipts |
| P1 | Projection generations and readiness execution are implemented but not live-qualified | ER-05, ER-06, ER-15, ER-16, ER-24, ER-38 | remote pinned-R2 readback, D1 Search shadow activation/rollback, AI Search item readback, promoted managed generation and Queue replay receipts |
| P1 | Exact EvidenceHandle resolution and citation/output gating are implemented but not live-qualified | ER-07, ER-11, ER-13, ER-19, ER-21, ER-24, ER-39 | deployed Access grant, remote D1 Core/Search guard, checksum-bound R2 range readback, purge invalidation and end-to-end citation receipt |
| P1 | Governed bundle ingest and SourceAdmissionDecision are implemented but not live-qualified | ER-13, ER-14, ER-21, ER-24, ER-29, ER-37 | deployed owner/service prepare, real multipart R2 readback/promotion, remote guarded D1 commit, duplicate/lost-ACK and Queue projection receipts |
| P1 | Worker composition and Access dispatch are implemented but not live-qualified | ER-17, ER-21, ER-24, ER-26 | deployed owner JWT, service-token class denial/allow fixtures and remote D1 catalog readback |
| P1 | Gemini Spark MCP and Google orchestration are implemented but not live-qualified | ER-17, ER-18, ER-20, ER-24, ER-26, ER-36 | deployed `gemini-spark` Access token initialize/tools/list/tools/call plus disposable Workspace and gcloud action/readback receipts |
| P1 | D1 outbox, Queue inbox and projection acceptance are implemented but not live-qualified | ER-13, ER-15, ER-24 | remote Queue lost-ACK, duplicate delivery, poison message, DLQ and restart receipts |
| P1 | Research Workflow has contract stages but not governed execution | ER-09, ER-20, ER-24 | cancellation/budget at every checkpoint; evidence freeze and claim audit |
| P1 | Managed search response needs strict locator decoding before canonical resolution | ER-06, ER-07, ER-16 | oversized/malformed/fake-handle fixtures; exact resolver required |
| P1 | ScopeSnapshot authority is implemented but not composed into remote D1, principal grants or retrieval and is not live-qualified | ER-10, ER-24, ER-30 | compose the D1 repository, grants and retrieval gate; retain remote persistence/readback plus purge, deny and expiry invalidation receipts |
| P1 | Corpus Lens deterministic navigation is implemented but not persisted, composed into `research.orient`, or live-qualified | ER-06, ER-07, ER-24, ER-31, ER-39 | persist content-addressed SourceCard/DocumentMap/ProjectAtlas artifacts; compose current ScopeSnapshot and principal gates; retain remote D1 readback plus Atlas→section→resolved EvidenceHandle receipts |
| P1 | Minimum Wiki, Artifact Compiler, trace and change products are not composed | ER-11, ER-12, ER-21, ER-24 | immutable revision/head CAS, fully resolved citations, copy-on-write update and purge dependency invalidation |
| P1 | Drive cursor/OAuth/tamper flow remains non-live | ER-18, ER-19, ER-20, ER-26 | disposable append/import/readback/reconnect + historical-row tamper fixture |
| P2 | Backup/restore export exists only as design contour | ER-34 | clean-account restore with purge ledger applied before payload exposure |
| P2 | PWA screens are shells and lack session/error/offline behavior | ER-25 | owner flow, degraded provider state, evidence viewer and job reconnect tests |
| P2 | T2/T3 corpus is too small for generation promotion | ER-31, ER-32 | real RU/EN/code cases and adjudicated regression thresholds |
| P2 | T6 workload profile has not been measured | ER-35 | 5/20/50 readers, D1 contention, index throughput, cost and p95 receipts |

Rules:

1. Close the P0 authority and evidence path before adding advanced research products.
2. A live product gate cannot be replaced by a mock, typecheck, local Wasm run or dry-run.
3. A provider result remains a locator or candidate until the canonical readback path succeeds.
4. Update this table and `implementation-status.json` in the same change that removes or adds a scaffold.
5. `IMPLEMENTED_NOT_LIVE` means code and deterministic negative tests exist; it does not mean a platform round trip occurred.
6. `ACCEPTED`, Queue `ack()`, Workflow completion and research completion are independent states.
7. Google Workspace/gcloud success remains an untrusted transport observation until exact readback and ELIOT authority reconciliation.
8. Ingest `ADMITTED` requires a durable SourceRevision, exact promotion readback and projection outbox in the same guarded authority path.
9. An index hit or provider citation remains a locator until exact authorized R2 bytes produce a durable EvidenceHandle and resolution receipt.
10. AI Search `uploadAndPoll` completion remains shadow state until item readback and managed-generation promotion both succeed.
11. TypeScript and Rust may coexist during differential shadow migration, but permanent dual authority is prohibited.
12. SourceCard, DocumentMap, ProjectAtlas, reading routes and unresolved EvidenceHandle candidates are navigation-only and cannot satisfy publication support.
13. Production readiness requires the ordered exit evidence in `production-readiness-plan.md`, not merely an empty P0 list.
