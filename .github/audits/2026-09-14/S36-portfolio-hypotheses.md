# S36 — Persist questions, hypotheses, and the source portfolio

Baseline: `a2aca1277b0edbbed04de66e0d44e383e1b815ef`; ER-08/10. Input: S35's installed protocol and frozen authorized scope. Implement on current main. This is an implementation assignment, not an accepted feature.

## 1. Problem

Retrieved chunk counts do not represent questions, alternative explanations, missing source classes, or independence. The previous assignment also left an unsafe storage ambiguity: `assertAppendMutationMask` explicitly forbids changing `portfolio_ref` or `debt_refs` through APPEND. A CHECKPOINT event cannot be used to smuggle those changes into a live head.

## 2. Required change

Create one immutable, versioned planning manifest containing the QuestionGraph, required HypothesisCards, and SourcePortfolio. Bind its exact reference/digest to the initial W1 investigation before execution. Use existing W1 create/supersede and immutable Work R2 operations; do not introduce a planning database or general graph engine.

## 3. Documentation and exact entry points

[Architecture §§7.5–7.6](https://github.com/UnknownAlienHuman/eliot-research/blob/a2aca1277b0edbbed04de66e0d44e383e1b815ef/docs/architecture/ELIOT_RESEARCH.md), [actual W1 types](https://github.com/UnknownAlienHuman/eliot-research/blob/a2aca1277b0edbbed04de66e0d44e383e1b815ef/packages/research/src/ports.ts), [mutation masks](https://github.com/UnknownAlienHuman/eliot-research/blob/a2aca1277b0edbbed04de66e0d44e383e1b815ef/packages/research/src/ledger-commands.ts).

```sh
git grep -n -F '## 7.5. SourcePortfolio and coverage denominator' -- docs/architecture/ELIOT_RESEARCH.md
git grep -n -F 'portfolio or debt refs are immutable outside supersession' -- packages/research/src/ledger-commands.ts
git grep -n -e 'create(' -e 'supersede(' -- packages/research/src/investigation-service.ts packages/research/src/ports.ts
```

## 4. Ordered implementation checkpoints

**36.1 — Pure manifest builder.** Add the missing planning-manifest builder beside `packages/research/src/investigation-service.ts`; reuse the actual contract definitions exported by `@eliotr/contracts`. Inputs are the approved question/protocol, exact admitted source revisions, and recorded origin/family facts. Outputs contain questions and dependency edges, required hypotheses/falsifiers, represented/missing source classes, and explicit unknown independence. Questions depend on questions; this graph must not assert causality. A lookup has zero mandatory hypotheses and needs no planning-model call. If a manifest codec is missing, add one versioned codec in the existing contracts package, not three separate codecs or a new package.

**36.2 — Persist before create.** Write the manifest through the existing immutable Work R2 port, verify the digest/readback, then call the existing investigation create operation with the manifest reference in `portfolio_ref`. Do not set this field using APPEND. Failed W1 creation may leave an unreferenced staged object, but must not leave a partial investigation head; existing cleanup handles it. The input digest binds the exact manifest, protocol, and frozen scope.

**36.3 — Read and consume.** Resolve the persisted manifest at preparation and at the real stage factory in `apps/eliotr-core/src/research-stage-handlers.ts`. Branches read the same immutable manifest and retain their question/hypothesis references. Do not rebuild it from a lead-agent summary after restart. Register hypotheses through the existing HYPOTHESIS_RECORDED operation; do not reinterpret a model confidence score as a verifier decision.

**36.4 — Subsequent changes.** A genuinely new portfolio or changed initial debt set uses the existing explicit supersession operation coordinated with S40; the old investigation and its receipts remain readable. Runtime branch observations are separate immutable checkpoint payloads. They do not rewrite the initial portfolio. An additive migration is needed only if an actual missing reference field cannot be represented by the existing manifest/ref contract; never relax the APPEND mask to bypass this design.

Run `pnpm research:check`, `pnpm contracts:check`, and the existing `packages/research/src/ledger-commands.test.ts` through root Vitest. Add the service-level create/readback/restart case under `apps/eliotr-core/test/` and run it from that package with its actual Workers Vitest configuration. Root `pnpm test` alone does not run core Workers tests.

## 5. Acceptance criteria

- [ ] `two questions / shared premise / two rival hypotheses` round-trips through the manifest, W1, and stage input with identical IDs and bytes after restart.
- [ ] Ten copies of one origin produce one known family, not ten confirmations; unknown family identity remains unknown and missing required source classes remain visible.
- [ ] An unadmitted/foreign source, dependency cycle, stale W1 revision, wrong manifest digest, or lost acknowledgement cannot create an inconsistent head or duplicate the manifest's logical operation.
- [ ] A direct APPEND attempt changing portfolio/debt references still fails on both the TS builder and actual D1. Legitimate explicit supersession succeeds and retains old history.
- [ ] The branch integration test reads the real persisted manifest; a fixture that substitutes a different manifest must fail. Record implementing SHA, exact commands, and observed R2/W1 identities. Do not claim model-planning quality from this deterministic fixture.
