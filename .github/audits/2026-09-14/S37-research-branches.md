# S37 — Execute and reconcile the required Research branches

Baseline: `a2aca127`; ER-08/09/10/16. Inputs: S35's protocol, S36's immutable planning manifest, S09 retrieval, and S22 counter-search. This task has the five explicit implementation checkpoints below. They are sequential commits of one shared branch mechanism, not separate engines or an invitation to redesign scheduling.

## 1. Problem

The current `createResearchStageHandlerFactory` falls back to `deterministicWorkflowStageBytes` for READ_AND_EXTRACT and ANALYZE_BRANCHES. A named checkpoint therefore does not establish actual branch work. Synthesis, claim audit, citation resolution, freeze, and their recovery mechanisms already exist and must be reused.

## 2. Required change

Connect the installed protocol's required roles to real retrieval/read/analysis outputs and deterministic reconciliation before EvidenceFreeze. Reuse W1/W2/W3, existing model execution/reservation ports, and Work R2. No separate workflow, agent SDK, queue, graph database, or role-specific model engine is required.

## 3. Documentation and entry points

[Architecture §§7.7–7.9](https://github.com/UnknownAlienHuman/eliot-research/blob/a2aca1277b0edbbed04de66e0d44e383e1b815ef/docs/architecture/ELIOT_RESEARCH.md); [actual factory](https://github.com/UnknownAlienHuman/eliot-research/blob/a2aca1277b0edbbed04de66e0d44e383e1b815ef/apps/eliotr-core/src/research-stage-handlers.ts); `packages/research/src/ports.ts`, `synthesis-candidate.ts`, `evidence-freeze.ts`, `claim-audit.ts`; `apps/eliotr-core/src/research-evidence-freeze-composition.ts`.

```sh
git grep -n -F '## 7.8. Research branches' -- docs/architecture/ELIOT_RESEARCH.md
git grep -n -e 'createResearchStageHandlerFactory' -e 'recoverStartedAttempt' -- apps/eliotr-core/src/research-stage-handlers.ts
git grep -n -F 'Each expensive model call has a durable checkpoint.' -- docs/architecture/ELIOT_RESEARCH.md
```

## 4. Ordered implementation checkpoints

**37.1 — One branch contract and exact read output.** Add a branch handler module under the existing `packages/cloudflare-research-stages/src/` and export it through that package. Use existing contract refs and candidate-claim types; add only the missing strict branch envelope. Its identity binds investigation revision, protocol revision, role, question/hypothesis refs, frozen scope/input digest, and prompt/schema generation. Its immutable output records resolved evidence refs, candidate claims with evidence, limitations/unknowns, and model-attempt receipt when a model was used. READ_AND_EXTRACT first resolves admitted bytes using the existing exact resolver; search snippets or source URLs alone are not branch evidence.

**37.2 — SUPPORT plus COUNTER.** Implement one shared analysis executor with two installed role prompts. SUPPORT proposes supported answers; COUNTER consumes S22's actual counter-search candidates and records contradictions or unsuccessful probes. Both use the same bounded AllowedReferenceManifest and existing W3 budget/currentness/cancellation protocol. A branch role does not choose its own tools, verifier, or source scope. A plain lookup does not create either paid analysis branch unless its protocol requires it.

**37.3 — Remaining declared roles, using the same executor.** ALTERNATIVE returns rival explanation/falsifier refs; CHRONOLOGY returns dated, source-bound event/uncertainty items; IMPLEMENTATION distinguishes specification/code snapshot/observed execution; LITERATURE distinguishes primary/secondary evidence and source lineage; SOURCE_AUDIT returns qualification, provenance, independence, and precision limitations. Each has one golden positive and one role-specific negative fixture. Do not implement these as seven scheduler classes. Roles absent from the selected profile are not dispatched.

**37.4 — Settlement and reconciliation.** Derive stable branch and W3 operation IDs from the frozen identity. Before dispatch read the existing committed attempt/result; after execution verify immutable R2 readback and append an authorized W1 CHECKPOINT without mutating the head's protected portfolio/debt fields. Use the existing canonical concurrency envelope, with no nested fan-out. RECONCILE joins outputs by planned branch ID, retains contradictions and missing/failed branches, and feeds the existing freeze composition. An identical repeated result is a no-op; conflicting content for the same branch is an integrity conflict. A missing mandatory role makes its obligation unsatisfied, not completed.

**37.5 — Factory and recovery.** Add explicit handler dependency fields to `ResearchStageHandlerFactoryMode`; wire them in the actual server composition and dispatch READ_AND_EXTRACT/ANALYZE_BRANCHES/RECONCILE through the new handler. Preserve legacy handler generations and historical receipts. The new executable generation must explicitly reject a missing required handler instead of falling through to technical bytes. Each paid branch call has a W3 checkpoint; a wrapper retry never blindly repeats several calls. `recoverStartedAttempt` recovers committed branch outputs before any new dispatch. Cancellation/deadline blocks new work; post-freeze new evidence uses S40 reopen.

Use `pnpm research:check`, `pnpm workflow:check`, `pnpm model:admission:check`, and `pnpm recovery:check`. Add a focused `test/research-branch-execution.test.ts` under `apps/eliotr-core` and run from that package's Workers Vitest configuration. Keep controlled provider responses external to real W1/W2/W3/R2 storage.

## 5. Acceptance criteria

- [ ] Every role required by the selected profile produces the stated typed output through the one executor; substituting technical bytes for a required role fails the integration test.
- [ ] Fixture: supporting source + tail-section contradiction + duplicate-origin source. Freeze retains both sides and does not count the duplicate as independent support.
- [ ] Crash after a provider result, lost result ACK, two concurrent completion callbacks, and repeated recovery produce one committed branch output and no repeated completed paid attempt.
- [ ] Missing/failed mandatory branch remains explicit; currentness failure, foreign evidence, late cancellation, and evidence arriving after freeze cannot create accepted output.
- [ ] Stage factory input/output refs match persisted records. Record exact implementation SHAs for 37.1–37.5, commands/results, branch IDs, and model-call counts. Controlled branch fixtures prove orchestration, not real-model research quality; that is S93.
