# S40 frozen debt and installed denominator source checkpoint

Date: 2026-10-10. Publication baseline: `1625394aa31905370af01bc6334fe7c3c6e7e0d0`.
Status: five-file source module accepted by independent Step review; publication pending.
PR [#232](https://github.com/UnknownAlienHuman/eliot-research/pull/232) remains open.

The Stage16 coverage guard previously required empty source-class and question-branch
requirements. Protocol freeze derives these fields from the installed protocol definition,
so valid `evidence_review` and `architecture_decision` denominators were rejected with
`WORKFLOW_AUTHORITY_STALE` before coverage could consume their frozen debts.

The guard now resolves the committed `profile_definition_ref` through the existing public
`installedInquiryProtocolDefinition` export. It compares exact, duplicate-free class and
branch sets and the definition's completeness-test reference. Unsupported definitions,
changed scope, partial requirements and duplicate requirements still fail closed.

This candidate also includes the previously prepared debt path as one coherent module:

- The coverage handler reads committed branch reconciliation and checks its exact debt refs
  and full OPEN snapshots against the freeze, including `next_probe`. It rereads those facts
  before returning output.
- The strict coverage.v3 codec retains the bounded debt snapshots and canonical bytes.
- The Stage17 audit reader binds those snapshots to the frozen reconciliation. It accepts
  legacy coverage.v2 only for a debt-free freeze.
- The run-result reader exposes the recorded debt snapshots.

The candidate preserves unknown coverage and `INCOMPLETE_COVERAGE`. It does not assign a
supported result or a complete-scope absence claim from the new protocol comparison. W1
APPEND mutation masks remain intact.

## Final owning source checks

The final independent read-only review compared all five module files with their frozen
copies and the publication baseline. Raw and canonical LF hashes matched. It accepted the
installed-definition guard, branchless compatibility and coherent debt writer/codec/readers
at source scope. Native lineage, terminal outcomes and versioned reopen remain separate
requirements; the review did not replay tests or qualify the full S40 stage.

TypeScript 6.0.3 checked the coverage handler and its test with the root strict compiler
options, Workers/Node types, dependency-source resolution and no emission: 958 source and
declaration files, zero diagnostics. This is an owning source-graph check. The unchanged
codec and downstream reader sources retain their earlier scoped compile/lint evidence.

Scoped ESLint passed for the final handler and test. The owning unit command was:

```sh
pnpm exec vitest run --config vitest.config.ts packages/cloudflare-research-stages/src/research-coverage-stage-handler.test.ts --reporter=verbose
```

All 14 cases passed: frozen debt/next-probe retention; post-freeze ref rejection; changed
debt-content rejection; both installed nonempty protocols; missing, duplicate and wrong
class/branch requirements; foreign completeness test, protocol and scope. The unit fixture
uses the actual installed catalog and accessor, with storage/context ports and result
encoding mocked. It does not prove the emitted coverage codec or native D1/R2 lineage.

A subsequent source review found that the new debt consumer unnecessarily called the
branch reader for a historical freeze with no branch findings. The existing freeze context
reader consults that port only when branch findings exist. Coverage now preserves that
branchless path only when the frozen debt-ref set is empty; a nonempty set without its
branch lineage still fails closed. The new owning cases ran separately:

```sh
pnpm exec vitest run --config vitest.config.ts packages/cloudflare-research-stages/src/research-coverage-stage-handler.test.ts -t branchless --reporter=verbose
```

Two new cases passed and the retained 14 cases were skipped. Final scoped compilation and
ESLint passed after the compatibility repair. There is no claim of a final 16-case rerun
or a native replay of a historical run.

The earlier Stage17 owning check exercised strict v3 debt codec/readback and strict v2
decoding with one passing filtered case. Its actual Stage17 fixture was debt-free. Those
retained results are not a nonempty committed-debt end-to-end acceptance claim.

The initial missing mock export, lint violations and negative-fixture literal typing error
were corrected; their failed outputs remain preserved separately from the passing results.
No build, provider call, deployment or previously passing native suite was repeated.

## Source identity and remaining acceptance

Canonical LF SHA-256 of the frozen candidate:

| Repository path | SHA-256 |
| --- | --- |
| `packages/cloudflare-research-stages/src/research-coverage-stage-handler.ts` | `9212ac695b784504b49ce99144aab1b46526ea1448a5804e3cfd42662f9c8628` |
| `packages/cloudflare-research-stages/src/research-coverage-stage-handler.test.ts` | `f6fe6a7c7971c960592c60aafdb25853cd0f7446eb4060355197184da3db2300` |
| `packages/cloudflare-research-stages/src/research-coverage-result.ts` | `44f206bf2a8b39875658913dbf7f3ed824bc98871e7b494eec43167a34797096` |
| `packages/cloudflare-research-stages/src/research-run-result-reader.ts` | `1ee68b6bb69b159a878439d496ecada0b67a7aae70d45c02680c2e3116fee29a` |
| `packages/cloudflare-research-stages/src/research-materialize-audit-reader.ts` | `a5c30e3c1fdbe974a6220a093ceb44627f5f57ad5e0a86de6d0a50458a4443a6` |

Remaining S40 acceptance: genuine nonempty committed branch/debt lineage through
Stage16→17; named terminal-case outcomes and next probes; versioned Investigation reopen
through fresh authorization, W1 supersession/CAS and one new Workflow; unchanged previous
artifact bytes and same-key replay; invalid verifier/waiver, stale CAS and foreign-source
negatives. Generic same-run recovery is not Investigation reopen.

No full S40, native pipeline, current build, live deployment or whole-project acceptance
is established by this source checkpoint.
