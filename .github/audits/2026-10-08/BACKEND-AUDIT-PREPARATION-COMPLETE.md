# Backend audit and implementation preparation — COMPLETE

Date: 2026-10-08  
Audited source baseline: `3e6c25660c1ae515760e19d5f9e6b8a735795c4c`

```text
BACKEND_AUDIT_PREPARATION_COMPLETE
```

This marker means the backend architecture/code audit has a bounded, non-circular implementation handoff. It does **not** mean the product implementation, compiler checks, native Cloudflare qualification, paid model/search calls, staging or release acceptance is complete.

## 1. Cloudflare-first ownership is settled

### Cloudflare owns commodity platform behavior

```text
AI Search hybrid retrieval/rerank/filtering/context expansion
Web Search / Markdown / Browser Run provider transport
Workflows durability, retries, delay, timeout, sleep, waitForEvent/sendEvent
Queues redelivery, retry exhaustion, DLQ, concurrency and backlog metrics
AIChatAgent / WebSocketChatTransport resume and presentation history
AI Gateway routing/logging/platform spend controls
D1 / R2 / Durable Objects storage primitives
Workers Traces and infrastructure telemetry
```

### Eliot owns only missing semantic authority

```text
canonical SourceRevision and exact EvidenceHandle
scope / tenant / owner / residency / purge authority
source qualification, independence and currentness
request / invocation / output / generation identities
coverage / omission / no-hit / scoped-absence semantics
root question, branch question and hypothesis identity
counter-search, falsification and contradiction candidates
claim audit and exact citation outcomes
research debt, unknowns, terminal dispositions and reopen
versioned derived artifacts and publication authority
product plans and section-local evidence
unknown external-effect settlement
```

No Temporal/LangGraph/Dify/RAGFlow runtime, vector database, graph database, custom WebSocket protocol, custom DLQ runtime or second indexer is part of the required core.

## 2. Starting PR set is completely classified

The audit started with 76 open PRs. Every one has an explicit disposition in:

- `FINAL-PR-DISPOSITION-MATRIX.md`;
- `PRESERVATION-RECONCILIATION.md`;
- the updated/closed PR bodies.

Current GitHub search result after cleanup:

```text
open PRs = 65
closed without merge during this closure pass = 11
```

Closed as source-preserved/superseded:

```text
#121 #173 #174
```

Closed as absorbed criteria/profiles:

```text
#212 #213 #215 #234 #235 #236 #237 #238
```

No branch was deleted. No wholesale historical branch was merged.

## 3. Preservation branches are reconciled

### #173 citations

Current main already contains a stronger v2 result, handler/execution split, started-attempt recovery, shared committed-lineage owner and browser terminal regression.

### #174 coverage/report admission

The report-admission migration is byte-identical on main. Current v2 coverage removes the historical impossible condition and adds domain receipt validation, Stage15 lineage and complete-scope absence checks.

### #121 N1 bundle

Useful child deltas are present in later owners: ingestion readback, structural navigation/orientation, tests and provisioner success-path cleanup. Old status files, temporary validation placement and the seven-owner octopus merge are superseded. Current nonzero argument exits are deliberate and regression-tested.

Result:

```text
#121 SUPERSEDED_PRESERVE_ONLY
#173 SUPERSEDED_PRESERVE_ONLY
#174 SUPERSEDED_PRESERVE_ONLY
```

## 4. Concrete source blockers are resolved or bounded

### #320 AI Search frozen-scope filter

```text
head       55b5fedef3f9c5b4d7cca9c490739e24d611e0c8
merge base current main
ahead      2
behind     0
files      exactly 8 declared files
```

Current main was incorporated by a normal two-parent merge commit. No force-push. Workspace compiler/lint/Vitest remain implementation checks.

### #321 bounded stream cleanup

```text
head       fbef9fe3fcd28c434581206bd3c1bdd4f64f6a81
merge base current main
ahead      2
behind     0
files      exactly 2 declared files
```

Current main was incorporated by a normal two-parent merge commit. This is the predecessor for #331 caller migration/removal of private copies.

### #322 retrieval lane order

Current-main source patch, one ordered scan, no contract/schema/I/O change. Focused package checks remain implementation acceptance.

### #323 fusion compound identity

Current-main one-line source fix. It must land before, or be absorbed unchanged into, #242. #242 separately owns best-rank-per-identity inside one physical list.

### #328 Golden unknown decoder

```text
head       96ff0f1a5766a2b400b5f237968bb63d1d088150
production fa02efa0edf1f7beb9900d23845ad8cf8448ee0d
tests      96ff0f1a5766a2b400b5f237968bb63d1d088150
```

Missing/non-array/oversized observed-unknown containers now produce typed failures before iteration; sanitized values persist; adversarial `passed:true` cannot hide retained failures/collapses. Complete expected-case reconciliation remains correctly owned by #285.

## 5. New bounded implementation passports created

```text
#330 R08  Cloudflare-native effect classes and one execution owner
#331 R09  one bounded stream reader; delete weaker copies
#332 R10  D1 ledger event frontier bound to the head read
```

Existing PRs materially corrected:

```text
#264 S72  AIChatAgent/WebSocketChatTransport; session is presentation, not executor
#256 S64  Queue owns max_retries/DLQ; Eliot keeps business outbox/inbox settlement
#327       one ownership/index/handoff surface
```

## 6. High-value duplicate removals are explicit

Implementation is not complete unless it deletes or retires the duplicate, rather than wrapping both paths.

```text
vector-only managed Search + weak D1 phrase fallback + local double fusion
→ one scoped AI Search hybrid result + Eliot exact evidence/coverage

native Workflow step.do + full custom checkpoint engine for every stage
→ native retry for safe effects + Eliot attempt ledger only for unknown effects

ResearchWorkflow + ResearchSession 18-stage executor
→ ResearchWorkflow sole execution owner

manual external-task uncertainty/poll recovery as normal waiting
→ waitForEvent/sendEvent + D1 authoritative result

custom WebSocket resume/buffer/history
→ AIChatAgent/WebSocketChatTransport

Queue max_retries/DLQ + magic application attempt ceiling
→ Cloudflare terminal transport ownership + Eliot business settlement

four private full-body readers
→ one bounded platform reader; specialized streaming seek only where necessary

head read + later unbounded event history
→ immutable event frontier through the head actually read

COMPARE/HYPOTHESIS/FACT_CHECK/AUDIT/DEEP as separate runtimes
→ profiles of one product-plan compiler and shared Research machinery
```

Every implementation PR must report:

```text
migrated callers
removed duplicate functions/branches
legacy codec compatibility
net production LOC/bundle delta
D1/R2/provider call delta
```

## 7. Final non-circular implementation order

```text
#209 first-cause / citation outcomes / TS+SQL vocabulary

#321 → #331
#322 + #323
#324 + #320 → #242
#332 independently

#209 → #261 / #262 / #263 / #256
#242 + #209 → #325 → #214
#209 + #330 → #326
#209 + #330 → #264
#209 + #242 + #325 → #233
#233 → #246 → #247 → #255

#209 → #231 → #239 → #240 → #241
                    └→ #244
#239 + #240 → #248
#240 + #247 + #248 → #249

#328 → #285 deterministic expected-set / Golden v2
#282 → #268
```

Optional lanes do not block core:

```text
selected Workspace/Google/federation profiles  #250–#253
optional pure Rust/Wasm                         #270–#281, #176
UI replacement                                  #329
native/staging/load/release acceptance          #210, #222, #259, #283, #286–#289
```

## 8. First implementation wave

One integrator owns shared contracts/composition/migrations. One worktree per manager.

Recommended first assignments:

```text
Manager A  #209
Manager B  #321 then #331
Manager C  #322 + #323
Manager D  #324 then #320, then handoff to #242 integrator
Manager E  #332
Manager F  #282 emitted build budgets
```

Do not start #242 shared integration until #324/#320/#322/#323 are reconciled in its worktree. Do not start #325/#214/#233 shared contract edits in parallel under different managers.

## 9. Verification boundary

Completed during audit/preparation:

```text
full GitHub permission/capability check
source and PR ancestry/overlap review
Cloudflare official capability ownership review
pinned donor source review
preservation reconciliation
all-PR disposition matrix
bounded source correction in #328
non-forced current-main reconciliation of #320/#321
executable passports and implementation graph
```

Still pending during implementation:

```text
repository-pinned TypeScript/ESLint/Vitest
D1 expression-depth checks where SQL changes
Worker/Vite dry-run bundles
native Workflows / Queue / WebSocket / AI Search acceptance
provider/model quality and paid-effect qualification
staging/deployment/load/release evidence
```

No production deployment, paid provider call, Cloudflare resource mutation, main merge, branch deletion, backup operation or historical uncertain-run replay was performed by the audit closure.
