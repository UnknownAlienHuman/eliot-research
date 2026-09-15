# S40 — Terminal dispositions, debts, and explicit Investigation reopening

Baseline: `a2aca127`; ER-08/10/21. Inputs: #227/#228/#229. Reuse existing coverage/freeze/ledger decisions.

## 1. Problem

ENGINE_COMPLETED does not establish inquiry completion. Unresolved debts need next probes, and evidence discovered after freeze cannot silently alter the previous report. Reopening creates a new investigation revision; it is not recovery of the previous run.

## 2. Required change

Connect persisted ResearchDebt to obligations/claims and terminal decisions. Implement explicit reopening with a new Investigation/EvidenceFreeze revision, revalidating changed material and affected dependencies while retaining reusable unchanged results.

Proposed POST `/api/v1/research/investigations/:id/reopen`: expected_revision, reason, admitted source revision references, optional approved protocol reference, and the existing Idempotency-Key header. The response links the previous artifact, new investigation revision, and new execution operation ID. Same-key replay cannot create another revision.

## 3. Documentation and exact search anchors

[Architecture, sections 7.9–7.11](https://github.com/UnknownAlienHuman/eliot-research/blob/a2aca1277b0edbbed04de66e0d44e383e1b815ef/docs/architecture/ELIOT_RESEARCH.md).

```sh
git grep -n -F '## 7.10. Research debts' -- docs/architecture/ELIOT_RESEARCH.md
git grep -n -F '## 7.11. Terminal dispositions and reopen' -- docs/architecture/ELIOT_RESEARCH.md
```

## 4. Implementation approach

Persist each unresolved obligation's kind, owner, blocking effect, next probe, review condition, expiry, and evidence references. A waiver requires explicit authority evidence and is not proof of support. Compute the existing nine CompletionDisposition values using current pure decision functions; do not introduce a tenth disposition to blur transport errors with research outcomes.

Unknown denominator forbids a scoped-absence claim, but does not automatically invalidate every narrow supported answer: evaluate the claimed scope and required obligations. Reopen requires fresh authorization and W1 CAS; its new freeze contains only authorized revisions and rechecks affected claims/debts/coverage. Preserve previous labels, bytes, and receipt references. Reuse sections only when their supporting dependencies remain valid under S53. Expose history/next actions through existing run/artifact UI/MCP surfaces, not another task system.

## 5. Acceptance criteria

- [ ] Supported narrow answers, complete-scope no-match, sampled no-match, failed acquisition, policy denial, budget stops, and unresolved contradictions produce their specified canonical outcomes/next probes.
- [ ] Post-freeze insertion without reopening fails.
- [ ] Explicit reopen creates exactly one new revision/run, while #207 recovery does not. Previous artifacts retain their hashes.
- [ ] Invalid verifier/waiver, stale CAS, foreign source, and duplicate requests cannot corrupt authority or create extra revisions.
- [ ] Test actual ledger→Workflow→API behavior and record exact SHA/results. Model output cannot assign authoritative completion by itself.
