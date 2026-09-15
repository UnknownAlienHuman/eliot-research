# S36 — Persist questions, hypotheses and the source portfolio

Baseline a2aca127; ER-08/10. Input: S35 installed protocol and frozen authorized scope. Implement the current-main delta. This planning PR is not a completed feature.

## 1. Problem

Chunk counts do not preserve questions, rival explanations, missing source classes or independence. W1 assertAppendMutationMask forbids changing portfolio_ref/debt_refs via APPEND; CHECKPOINT cannot be used to bypass protected fields.

## 2. Required change

One immutable versioned planning manifest containing QuestionGraph, required HypothesisCards and SourcePortfolio, bound by exact ref/digest to initial W1. Reuse create/supersede and immutable Work R2; no planning database or graph engine.

## 3. Documentation and executable verification

[Architecture §§7.5–7.6](https://github.com/UnknownAlienHuman/eliot-research/blob/a2aca1277b0edbbed04de66e0d44e383e1b815ef/docs/architecture/ELIOT_RESEARCH.md), [W1 types](https://github.com/UnknownAlienHuman/eliot-research/blob/a2aca1277b0edbbed04de66e0d44e383e1b815ef/packages/research/src/ports.ts), [mutation masks](https://github.com/UnknownAlienHuman/eliot-research/blob/a2aca1277b0edbbed04de66e0d44e383e1b815ef/packages/research/src/ledger-commands.ts).

```sh
git grep -n -F 'portfolio or debt refs are immutable outside supersession' -- packages/research/src/ledger-commands.ts
pnpm contracts:check
pnpm exec vitest run packages/research/src/ledger-commands.test.ts
pnpm --dir apps/eliotr-core exec vitest run test/investigation-ledger-d1.test.ts test/investigation-ledger-commands-d1.test.ts test/research-protocol-freeze.test.ts
```

Add **NEW** apps/eliotr-core/test/research-planning-manifest.test.ts for the service-level scenario, or extend an equivalent existing case and record its exact path. Invoke it with the same core command after adding it. Root Vitest alone excludes core tests; root `pnpm test` DOES chain provisioner, root and core suites. There is no research:check script. No aliases, empty test selections or fake receipt fixtures.

## 4. Ordered implementation

**36.1 — Pure seed/manifest builder.** Beside existing research/investigation-service, consume literal question, explicit supplied subquestions/hypotheses, installed protocol requirements and exact admitted revision/origin/family facts. Produce question dependency edges, hypotheses/falsifiers where required, represented/missing source classes and unknown independence. Questions depending on questions do not imply source causality. Lookup requires no hypotheses or planning-model call. Add a strict versioned codec in existing contracts only if missing.

**36.2 — Persist before CREATE.** Immutable Work R2 write and exact readback precede existing investigation create with portfolio_ref. The request digest binds manifest, protocol and scope. Failed create leaves no partial head; an unreferenced staged object follows existing cleanup, not a new mutable planning store. Do not set portfolio_ref through APPEND.

**36.3 — Read/consume.** Preparation and actual research-stage-handlers factory resolve this exact stored manifest. Branches retain question/hypothesis IDs across restart rather than rebuilding from agent prose. Register hypotheses by existing HYPOTHESIS_RECORDED. Optional later model refinements execute through W3 after W1 exists and become validated referenced observations, not verifier certificates or protected head edits.

**36.4 — Changes.** Changed authorized portfolio/initial debts use S40 explicit atomic supersession; old investigation/receipts remain readable. Runtime branch observations are immutable checkpoint payloads. Add a migration only if the existing manifest/ref contract truly lacks a required field; never relax mutation masks as a shortcut.

## 5. Acceptance criteria

- [ ] Two questions/shared premise/two rival hypotheses round-trip through R2, W1 and real stage input with stable bytes/IDs after restart.
- [ ] Ten copies of one origin count as one known family; missing classes and unknown independence remain explicit.
- [ ] Foreign/unadmitted source, cycle, stale CAS, wrong digest and lost ACK cannot produce inconsistent head or duplicate logical operation.
- [ ] Illegal APPEND/CHECKPOINT protected-field mutation still fails in TS and actual D1; legitimate supersession preserves history.
- [ ] The integration scenario reads the stored manifest and detects substituted content; exact implementing SHA, commands and R2/W1 readback are recorded. Deterministic orchestration tests do not claim semantic planning quality or a live deployment.
