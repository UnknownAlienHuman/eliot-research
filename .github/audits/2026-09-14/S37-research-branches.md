# S37 — Execute Research branches instead of recording their names

Baseline: `a2aca127`; ER-08/09/10/16. Inputs: #227/#228. Reuse counter-search #214. This is a bounded branch-execution work package with incremental checkpoints, not permission for a single whole-engine rewrite.

## 1. Problem

Branch scheduling remains open in the gap register. Individual synthesis/audit stages exist, but the selected profile needs actual SUPPORT, COUNTER, ALTERNATIVE, CHRONOLOGY, IMPLEMENTATION, LITERATURE, and SOURCE_AUDIT execution where required.

## 2. Required change

Execute required branches in the existing ResearchWorkflow/W1 ledger with actual READ_AND_EXTRACT and ANALYZE outputs. Start with a SUPPORT+COUNTER fixture. Reuse isolated branch prompts, resolved EvidencePacks, W3 attempts/reservations, and R2 outputs. Do not execute roles the protocol does not require.

## 3. Documentation and exact search anchors

[Architecture, sections 7.7–7.9](https://github.com/UnknownAlienHuman/eliot-research/blob/a2aca1277b0edbbed04de66e0d44e383e1b815ef/docs/architecture/ELIOT_RESEARCH.md).

```sh
git grep -n -F '## 7.8. Research branches' -- docs/architecture/ELIOT_RESEARCH.md
git grep -n -F 'Each expensive model call has a durable checkpoint.' -- docs/architecture/ELIOT_RESEARCH.md
```

## 4. Implementation approach

First implement branch identity/input/output persistence and one role through existing ports. Next integrate SUPPORT+COUNTER with deterministic reconciliation and failure recovery. Add the remaining required role handlers one at a time using that same contract; the work package is complete only when selected roles have real handlers and tests.

Derive branch IDs deterministically from the existing Investigation/protocol revision, role, and input identity. Each expensive call gets its own step/attempt, never a loop of paid calls inside one retryable step. Follow the existing canonical execution envelope (default 2, maximum 4, no nested fan-out), not new procedural quotas. Branches receive bounded relevant context and the reference manifest, not the entire lead-agent conversation.

Persist candidate claims, evidence references, unknowns, and lineage after each branch. RECONCILE deterministically preserves dissent and missing branches. Serialize W1 mutations with CAS; keep network I/O outside transactions. Deadline/cancellation prevents new dispatch while retaining completed output. UNKNOWN provider outcome does not authorize another branch attempt.

## 5. Acceptance criteria

- [ ] SUPPORT and COUNTER genuinely execute and their outputs enter the freeze; neither prompt includes unauthorized cross-scope context.
- [ ] One failed branch produces explicit debt/coverage limitations, not all-complete status.
- [ ] Crash/retry/concurrent callbacks do not duplicate outputs or charges; late evidence after freeze requires explicit reopen.
- [ ] Every required selected role has a real handler; unavailable mandatory roles leave their obligations explicitly blocked.
- [ ] Record actual W1/W2/W3/R2 and factory-readback tests with exact SHA. No new swarm/agent framework is introduced.
