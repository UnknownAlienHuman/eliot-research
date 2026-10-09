# Final PR disposition matrix — Cloudflare-first backend preparation

Date: 2026-10-08\
Source baseline: `3e6c25660c1ae515760e19d5f9e6b8a735795c4c`\
Initial audit set: **76 open pull requests**\
After preservation/profile cleanup in this audit branch: **65 remain open**.

This matrix is an execution disposition, not a claim that runtime code, compiler checks, native Cloudflare acceptance or deployment has passed.

## Status vocabulary

| Status | Meaning |
|---|---|
| `READY_FIRST` | First shared dependency; implementation should start here. |
| `READY_INDEPENDENT` | Bounded implementation may proceed without waiting for another active feature. |
| `READY_AFTER_REBASE` | Source patch is valid in scope but must be reconciled to current main before checks; retained for future use. |
| `READY_AFTER_SCOPED_CHECK` | Branch is based on current main; run exact compiler/lint/focused checks before integration. |
| `BLOCKED_BY(...)` | Do not edit shared contracts until the named owner(s) settle. |
| `READY_AFTER_CORE` | Unique Eliot behavior, but not part of the first repair wave. |
| `OPTIONAL_SELECTED_PROFILE` | Implement only when the corresponding external client/profile is selected. |
| `OPTIONAL_KERNEL` | Pure Rust/Wasm work only; never replaces Cloudflare runtime/I/O. |
| `OPTIONAL_OPERATIONAL` | Useful operational feature after deterministic core and quality gates. |
| `LATER_ACCEPTANCE` | Native/staging/load/release evidence, not a missing core implementation. |
| `UI_OWNER` | Owned by the replacement owner-web/UI work. |
| `FINAL_STATUS_SYNC` | Update historical/current status only after implementation identities are known. |
| `AUDIT_INDEX` | Completed documentation/coordination handoff; not a runtime implementation PR. |
| `ABSORBED_CLOSED` | Criteria moved to named active owners; PR closed without merge. |
| `SUPERSEDED_CLOSED` | Current main contains a later implementation; historical branch preserved and closed. |

## Complete starting-set matrix

| PR | Disposition | Current owner / ordering | Do not duplicate |
|---:|---|---|---|
| #121 | `SUPERSEDED_CLOSED` | Reconciled in `PRESERVATION-RECONCILIATION.md` | Never merge the seven-owner octopus branch. |
| #173 | `SUPERSEDED_CLOSED` | Current citation v2/stage/runtime owners | Do not restore v1 whole-audit receipt. |
| #174 | `SUPERSEDED_CLOSED` | Current coverage v2/report-admission/artifact owners | Do not restore defective v1 count validation. |
| #176 | `OPTIONAL_KERNEL` | After #270/#280/#281 and real emitted budget #282 | Mutation evidence is not Cloudflare/product ownership. |
| #209 | `READY_FIRST` | Shared first-cause, citation outcomes and TS/SQL vocabulary | No second failure table/framework. |
| #210 | `LATER_ACCEPTANCE` | After active core composition stabilizes | Do not create another launch registry/gate system. |
| #212 | `ABSORBED_CLOSED` | #329 UI lifecycle + #247 dependency freshness | No legacy global refresh bus. |
| #213 | `ABSORBED_CLOSED` | #325 findings + #330 effects + #263 diagnostics | No separate stage-truth runtime. |
| #214 | `BLOCKED_BY(#209,#242,#325)` | Counter-search specialization after shared retrieval/branch contracts | No graph DB or second result hierarchy. |
| #215 | `ABSORBED_CLOSED` | #242 managed retrieval | No separate fallback subsystem. |
| #222 | `FINAL_STATUS_SYNC` | Resolve architecture frontmatter/current-state tuple after core identities | No new status registry or copied counters. |
| #230 | `BLOCKED_BY(#209,#332)` | Unique preregistration/named-verifier behavior after failure and ledger fixes | No verifier scheduler or self-certification engine. |
| #231 | `BLOCKED_BY(#209)` | Controlled discovery → capture → extraction → admission | No second source store/crawler/provider framework. |
| #232 | `BLOCKED_BY(#209,#233,#285)` | Debts, terminal disposition and versioned reopen after real products/gates | No silent post-freeze rewrite or replacement run. |
| #233 | `BLOCKED_BY(#209,#242,#325)` | One product-plan compiler for ASK/BRIEF and later profiles | No new answer queue/context/citation/artifact engines. |
| #234 | `ABSORBED_CLOSED` | COMPARE profile in #233 | No standalone comparison pipeline. |
| #235 | `ABSORBED_CLOSED` | HYPOTHESIS_REVIEW profile in #233/#325/#214 | No standalone hypothesis engine. |
| #236 | `ABSORBED_CLOSED` | FACT_CHECK profile in #233 + existing claim audit | No second claim verifier/report engine. |
| #237 | `ABSORBED_CLOSED` | PROJECT_VS_LITERATURE profile in #233/#325/#214 | No separate audit pipeline. |
| #238 | `ABSORBED_CLOSED` | DEEP_RESEARCH profile over shared runtime | No second deep-research framework. |
| #239 | `BLOCKED_BY(#231,#262)` | Qualified raw/normalized admission after acquisition and ownership fences | No embedded PDF/OCR platform in Worker. |
| #240 | `BLOCKED_BY(#239,#262)` | Coordinate/navigation adapters only after qualified producer identity | No guessed coordinates or new PDF engine. |
| #241 | `BLOCKED_BY(#240,#291)` | ProjectAtlas over exact navigation and honest large-scope accounting | No second scope freezer or search index. |
| #242 | `BLOCKED_BY(#209,#324,#320,#322,#323)` | One scoped AI Search hybrid path plus Eliot exact authority | No duplicate LEX/SEM provider fusion or new search engine. |
| #244 | `BLOCKED_BY(#239)` | Existing AI Search Items adapter/generation registry | No second indexer/scheduler/active-generation registry. |
| #246 | `BLOCKED_BY(#209,#233)` | Existing Artifact COW/publication owner after real product output | No bypass publisher or product-specific store. |
| #247 | `READY_AFTER_CORE` | After #246; source→derived dependency and replay semantics | No global event bus or self-citation authority. |
| #248 | `BLOCKED_BY(#239,#240)` | Selective EvidenceAtoms after qualified exact evidence | No blanket LLM ingest compilation/new store. |
| #249 | `BLOCKED_BY(#240,#247,#248)` | ArgumentMap over exact spans and existing relation ledger | No graph database or causality from co-occurrence. |
| #250 | `OPTIONAL_SELECTED_PROFILE` | Only if Workspace admission profile is selected | No owner impersonation or second importer. |
| #251 | `OPTIONAL_SELECTED_PROFILE` | Only if Google delivery profile is selected | No Worker Google secrets/blind recreate. |
| #252 | `OPTIONAL_SELECTED_PROFILE` | Only if federation execution is selected | No second Research runtime or stronger remote disposition. |
| #253 | `OPTIONAL_SELECTED_PROFILE` | After #252; independent wire client qualification | Do not share server codecs with verifier. |
| #255 | `BLOCKED_BY(#209,#247)` | Managed erasure closure after failure/dependency semantics | No blind delete ACK or claim about uncontrolled copies. |
| #256 | `BLOCKED_BY(#209)` | Cloudflare Queue owns retry exhaustion/DLQ; Eliot business settlement only | No magic application retry ceiling/second DLQ runtime. |
| #259 | `LATER_ACCEPTANCE` | After #244/#255; code/index rollback against current data authority | No data restore hidden inside code rollback. |
| #260 | `OPTIONAL_OPERATIONAL` | After #263/#285; bounded steward candidates only | No autonomous rewrite/self-publication/grant expansion. |
| #261 | `BLOCKED_BY(#209)` | Unique disclosure/injection/XSS/secret boundary work may then proceed | No new security framework or blanket exclusions. |
| #262 | `BLOCKED_BY(#209)` | Unique ownership/residency/cutover behavior may then proceed | No new ownership service or hash-based cross-residency reuse. |
| #263 | `BLOCKED_BY(#209)` | Native Workers Traces/Gateway readback + Eliot receipt correlation | No LangSmith/OTel backend/accounting journal duplication. |
| #264 | `BLOCKED_BY(#209,#330)` | AIChatAgent/WebSocketChatTransport presentation generation; coordinate #329 | No custom resume/buffer protocol or second executor. |
| #268 | `BLOCKED_BY(#282,#330,#264)` | Mechanical formatting after measured budgets and behavior ownership settle | No semantic fixes mixed with formatting. |
| #269 | `OPTIONAL_OPERATIONAL` | P2 differential consolidation after core | No generic validation framework or wire-contract conflation. |
| #270 | `OPTIONAL_KERNEL` | First optional identity-parity inventory after TS contracts stabilize | No blanket port of every codec. |
| #271 | `OPTIONAL_KERNEL` | After #270 and #262 owner transition contract | D1 remains final CAS/currentness authority. |
| #272 | `OPTIONAL_KERNEL` | After #270 and #291 scope contracts | No scope enumeration/I/O in kernel. |
| #273 | `OPTIONAL_KERNEL` | After #270/#261/#262 policy/residency facts | No auth/network/budget settlement in Rust. |
| #274 | `OPTIONAL_KERNEL` | After #270/#239 qualification contract | No native PDF/OCR engine. |
| #275 | `OPTIONAL_KERNEL` | After #270/#240/#244 structural projection | Managed Search/storage remain TS/Cloudflare. |
| #276 | `OPTIONAL_KERNEL` | After #270/#240/#291 exact evidence/coverage | Language change cannot strengthen completeness. |
| #277 | `OPTIONAL_KERNEL` | After #270/#230/#232/#246 research decisions settle | No second Research engine. |
| #278 | `OPTIONAL_KERNEL` | After #270/#255 erasure closure | External deletion/D1 effects remain TS. |
| #279 | `OPTIONAL_KERNEL` | After #270 and selected #252/#253 federation profile | No client canonical writes/transport in kernel. |
| #280 | `OPTIONAL_KERNEL` | After at least one selected ready pure family | One closed ABI, no dispatcher/platform handles. |
| #281 | `OPTIONAL_KERNEL` | After #280 and actual caller parity; remove replaced TS per family | No hidden dual authority/fallback. |
| #282 | `READY_INDEPENDENT` | Native Wrangler/Vite emitted build budget; prerequisite #268 and UI budget handoff | No source-line count presented as runtime optimization. |
| #283 | `LATER_ACCEPTANCE` | After implemented operations; actual D1 authority batches | No fake SQL copies/DatabaseSync/no-op tests. |
| #285 | `BLOCKED_BY(#328,assembled-products)` | Exact case manifest, Golden v2, metrics and holdout | No aggregate score hiding hard evidence/security failures. |
| #286 | `LATER_ACCEPTANCE` | Staging/build/binding/schema attestation after core and #282 | No deployment implied by planning. |
| #287 | `LATER_ACCEPTANCE` | After #286; native T4/T5 and selected client | No mock response-loss labelled live evidence. |
| #288 | `LATER_ACCEPTANCE` | After #286/#263/#282; load/latency/cost | No estimates labelled bills or live measurements. |
| #289 | `LATER_ACCEPTANCE` | Final release after #283/#285–#288 and selected profiles | No universal readiness claim. |
| #291 | `READY_AFTER_CORE` (accounting fix); `BLOCKED_BY(#320,#242)` (capacity proof) | Split actual preview accounting from managed-search capacity | No arbitrary limit increases or silent paid fan-out. |
| #320 | `READY_AFTER_SCOPED_CHECK` | Reconciled current-main scoped prefilter before AI Search top-k; head `55b5fedef3f9c5b4d7cca9c490739e24d611e0c8` | No global fallback or ACL-by-truncated prefix. |
| #321 | `READY_AFTER_SCOPED_CHECK` | Reconciled current-main bounded stream cleanup; head `fbef9fe3fcd28c434581206bd3c1bdd4f64f6a81`; predecessor #331 | No awaited hostile cancellation. |
| #322 | `READY_AFTER_SCOPED_CHECK` | Direct lanes must all precede SEM | No planner rewrite/framework. |
| #323 | `READY_AFTER_SCOPED_CHECK` | Land/absorb before #242; collision-free compound key | No persisted identity migration. |
| #324 | `READY_INDEPENDENT` | AI Search documented `query_kind: text` decoder compatibility | No multimodal expansion or permissive decoder. |
| #325 | `BLOCKED_BY(#209,#242)` | Branch-local question/retrieval/findings contract | No second model ledger/scheduler/result hierarchy. |
| #326 | `BLOCKED_BY(#209,#330)` | Native Workflow `waitForEvent`; D1 result remains authority | No normal-path polling/manual-recovery framework. |
| #327 | `AUDIT_INDEX` | Audit preparation complete; canonical router is `docs/implementation/backend-entrypoints.md` | No runtime implementation on this branch. |
| #328 | `READY_AFTER_SCOPED_CHECK` | Bounded observed-unknown decoder repair complete at `96ff0f1a5766a2b400b5f237968bb63d1d088150`; then release #285 deterministic work | Not a complete promotion gate; expected case set stays #285. |
| #329 | `UI_OWNER` | React/Vite replacement owner web UI and ER-48 client extraction | No backend rewrite/second Worker/Pages service. |
| #330 | `BLOCKED_BY(#209)` | Effect inventory may start; shared implementation after failure vocabulary | No wrapper over two surviving workflow engines. |
| #331 | `BLOCKED_BY(#321)` | Migrate complete-body callers and delete private copies | No generic HTTP framework. |
| #332 | `READY_INDEPENDENT` | Bound event read to head frontier in D1 ledger snapshot | No retry loop/lock/snapshot framework. |

## Non-circular implementation graph

```text
#209
├─ #261 / #262 / #263
├─ #256
└─ shared failure vocabulary for all later lanes

#321 → #331
#322 + #323
#324 + #320 → #242
#332 (independent)

#242 + #209 → #325 → #214
#209 + #330 → #326
#209 + #330 → #264
#209 + #242 + #325 → #233
#233 → #246 → #247 → #255

#209 → #231 → #239 → #240 → #241
                    └→ #244
#239 + #240 → #248
#240 + #247 + #248 → #249

#328 bounded decoder complete → scoped checks → #285 exact case-set / Golden v2
#282 emitted budgets → #268 mechanical formatting

optional client profiles #250–#253
optional Rust/Wasm #270–#281/#176
native/release acceptance #210/#222/#259/#283/#286–#289
```

There is no dependency from core correctness to optional Google/federation profiles, optional Rust promotion, frontend completion, production deployment or paid quality runs.

## Audit-preparation closure

The preparation blockers that existed in the earlier matrix revision are now resolved:

1. #328 has a bounded container decoder and adversarial regression source; repository-pinned checks remain implementation acceptance.
2. #320 and #321 are reconciled to current main without force-push and are no longer rebase blockers.
3. #322/#323 have bounded current-main source fixes; their focused checks remain implementation acceptance.
4. The complete handoff is published in #327 with marker `BACKEND_AUDIT_PREPARATION_COMPLETE`.
5. The current role-based entry point is `docs/implementation/backend-entrypoints.md`.

The remaining work is code implementation, compiler/lint/Clippy/focused checks, native Cloudflare qualification and release acceptance — not further architecture queue discovery.
