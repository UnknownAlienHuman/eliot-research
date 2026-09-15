# S37 — Execute and reconcile required Research branches

Baseline a2aca127; ER-08/09/10/16. Inputs: S35 installed protocol, S36 immutable planning manifest, S09 retrieval and S22 counter-search. Five sequential checkpoints implement one shared mechanism, not separate engines.

## 1. Problem

The actual stage factory can return technical bytes for READ_AND_EXTRACT/ANALYZE_BRANCHES. Synthesis/audit/citations/freeze/recovery already exist. A required role needs a real output, not another named placeholder.

## 2. Required change

One typed branch envelope/executor connects installed required roles to exact retrieval/read/analysis outputs and deterministic reconciliation before freeze. Reuse W1/W2/W3, model attempt/reservation ports and Work R2. No new agent SDK, workflow, queue or graph store.

## 3. Documentation, real entry points and tests

[Architecture §§7.7–7.9](https://github.com/UnknownAlienHuman/eliot-research/blob/a2aca1277b0edbbed04de66e0d44e383e1b815ef/docs/architecture/ELIOT_RESEARCH.md); apps/eliotr-core/src/research-stage-handlers.ts, research-workflow.ts and research-runtime-duration.ts; packages/research/src/ports.ts; packages/cloudflare-research/src/research-evidence-freeze-composition.ts; packages/cloudflare-research-stages/src/.

```sh
git grep -n -e 'createResearchStageHandlerFactory' -e 'recoverStartedAttempt' -- apps/eliotr-core/src/research-stage-handlers.ts
pnpm --dir apps/eliotr-core exec vitest run test/research-retrieve-branches.test.ts test/research-model-stage-handler.test.ts test/research-evidence-freeze.test.ts test/research-workflow-recovery.test.ts
pnpm contracts:check
pnpm typecheck
```

Add **NEW** apps/eliotr-core/test/research-branch-execution.test.ts and run it through the same core command. This replaces nonexistent research/workflow/model-admission/recovery package aliases. Control only provider responses; actual W1/W2/W3/R2 and factory must execute.

## 4. Ordered implementation

**37.1 — Contract and exact read.** Add the missing strict branch envelope in existing contracts and one handler in existing stage package. Identity binds investigation/protocol revision, role, question/hypothesis refs, frozen scope/input and prompt/schema generation. Output records exact evidence refs, candidate claims/support, unknowns/limitations and actual model receipt when used. READ_AND_EXTRACT resolves admitted bytes; URLs/snippets are not evidence.

**37.2 — SUPPORT/COUNTER.** One analysis executor with installed role prompts. SUPPORT proposes supported answers. COUNTER consumes S22 results exactly once and records contradictions/failed probes. Same bounded AllowedReferenceManifest, W3 budget/currentness/cancel discipline. Role cannot choose its own tools/verifier/scope. Protocol not requiring analysis makes no extra paid calls.

**37.3 — Other declared roles.** Through that executor: ALTERNATIVE produces rival/falsifier refs; CHRONOLOGY dated source-bound events/uncertainty; IMPLEMENTATION distinguishes spec/code/observed execution; LITERATURE distinguishes primary/secondary/origin; SOURCE_AUDIT records qualification/provenance/independence/precision limits. Each installed role has a positive and specific negative output fixture. Do not dispatch absent roles or create seven schedulers.

**37.4 — Settle/reconcile.** Stable branch/W3 IDs bind frozen inputs. Read existing attempt/result before dispatch; verify immutable R2 output after execution; append permitted W1 observations without rewriting protected portfolio/debt refs. Bound concurrency by existing canonical envelope, no nested fan-out. Reconcile by planned branch ID, retain counterevidence and unmet required roles. Identical repeated result is a no-op, conflicting result is an integrity failure; no duplicate can substitute for a missing branch.

**37.5 — Factory, duration and recovery.** Explicit dependencies connect actual server composition and READ_AND_EXTRACT/ANALYZE_BRANCHES/RECONCILE. Keep old handler generations and receipts; new required handler missing must fail, not fall through. The installed stage's duration/budget classification must include the paid branch I/O it now performs in research-runtime-duration.ts/Workflow; do not leave it on a technical-step timeout or raise every timeout blindly. Each expensive model call has its own existing W3 checkpoint. recoverStartedAttempt restores committed branch output before dispatch, even if a native wrapper restarted. Cancellation/deadline blocks new work; outside-scope or post-freeze evidence requires authorized S40 supersession, not implicit scope growth.

## 5. Acceptance criteria

- [ ] All required roles produce typed outputs through the shared actual factory; handler replaced by technical bytes is detected. Unrequired roles cost zero calls.
- [ ] Supporting source, tail contradiction and duplicate-origin fixture reach freeze with both sides and truthful independence.
- [ ] Crash after provider result/lost ACK/concurrent callback/repeated recovery yields one committed branch result, no repeated completed paid effect.
- [ ] Failed/missing role remains unmet; foreign/purged/cancelled/outside-frozen-scope output is not accepted. Stage duration/budget matches actual work without an uncheckpointed retry loop.
- [ ] Five implementing checkpoints retain exact tests/SHAs/branch/receipt IDs and per-role calls. Listed core tests plus the new integration run pass; real semantic quality remains S93, not manufactured by controlled responses.
