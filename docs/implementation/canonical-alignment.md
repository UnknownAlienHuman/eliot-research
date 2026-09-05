# Canonical alignment — implementation gaps and corrections

Normative sources: **ELIOT_RESEARCH v29.1 (2026-08-28)**, **eliotr.language-runtime.v1 v1.0
(2026-09-01)** and accepted ADRs. Checked against application baseline `853fbe1` on 2026-09-05.
This is a scoped implementation review, not full conformance certification or new architecture.
The canonical documents have not been changed to accommodate incomplete code.

| Canonical requirement | Actual implementation / required correction |
|---|---|
| Product §§1.2, 12.3–12.12; ADR-0003: Day-0 ChatGPT Drive Exchange | Existing agent-start/#95 wording incorrectly treated Gemini MCP as a substitute. Corrected: Drive's OAuth/REST/cursor/freeze/reconciliation/publication adapters remain required and unfinished; one ChatGPT write transport. Gemini is only an optional candidate service helper. |
| §§12.6–12.10, 15.1: exact identity/readback and honest observations | Gemini v1 validator previously omitted target/read-version checks and accepted future observations/expiry equality/changed descriptors. Corrected with negative tests. Its unsigned self-reports still cannot prove issuance, consent, an actual Google call or write CAS; unsupported typed product states remain unverified. |
| §19: complete mandatory application before launch | Drive interfaces lacked an unfinished status entry and launch check ignored disabled products. Added explicit IN_PROGRESS registration and independent mandatory-slice blockers. Neither a green registry nor generic OBSERVED_MATCH is full conformance. |
| §§4.1–4.3 and Slice 1: ordinary raw-file fast path | PWA currently imports pre-normalized folders. Managed conversion -> qualification -> structural projection of raw uploads remains missing. Write bounded adapters and failure fixtures locally; do not add a document/OCR engine to the Worker or defer ordinary code to Cloudflare. |
| §§4.10, 6.6, 19: readiness after exact active-generation readback | History's RECORDED_ONLY display is a bounded metadata view, not active-index or EvidenceHandle qualification. Keep active-readiness work open; never infer readiness from admission or an old ready row. |
| Language §10: staged migration | M5 = Wasm/differential shadow; M6 = per-family authority promotion; M7 = removal of superseded TS. Correct the #97 task numbering. Narrow M2 helpers are not complete family parity. |
| Language §§8.2–8.3; product T4/T5/T6 | CDP/Chromium UI tests with controlled HTTP and separate local Worker tests do not satisfy the prescribed PWA Playwright/full real-storage user loop, provider qualification, restore, quality or load gates. Preserve these missing acceptance tests; no silent equivalence claim. |

## Next implementation boundaries

- **#95 / ER-18/19/20:** implement actual Drive adapters, one state family at a time. The optional
  ER-36 observation validator cannot become their source, identity or cursor authority.
- **#98 / ER-05/14/29/24/25:** raw-file managed conversion plus active readiness, projects, failure UI
  and the complete authenticated browser + local D1/R2 lifecycle. The current normalized importer,
  history and recovery remain reusable, not discarded or implemented twice.
- **#97:** finish uncovered current TS/native/Wasm parity, then normative M5/M6/M7 separately.
- **#96:** retain explicit release evidence for all mandatory products, including Drive and raw-file
  ingest. Account-only probes execute only after complete code and approved target isolation.

No provider upgrade, account action, new transport, runtime topology or domain identity is introduced
by this correction. TypeScript changes are bounded platform/transport bug fixes permitted by language
§10.1 before promotion; they do not grant new source or completion authority. Live gates remain
NOT_EXECUTED. Other unreviewed code is not certified by this document.
