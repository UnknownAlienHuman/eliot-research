# S41 — Implement ASK/BRIEF as products, not renamed REPORT output

Baseline: `a2aca127`; ER-08/10/11/25. Inputs: #227/#232. Preserve existing synthesis, audit, and readers.

## 1. Problem

The bounded document-to-DRAFT REPORT path does not establish grounded iterative ASK or BRIEF that preserves conditions, disagreements, and unknowns.

## 2. Required change

Implement two approved product profiles over the same run engine. ASK produces an answer, evidence-backed conclusions separated from inference/assumptions, and next questions. BRIEF preserves key findings/numbers with units/conditions, source positions, disagreements, limitations, and unknowns. Select profile references through #227. Use an explicit versioned mapping between public product names and internal execution enums; do not rename historical enums.

## 3. Documentation and exact search anchors

[Architecture, section 7.12](https://github.com/UnknownAlienHuman/eliot-research/blob/a2aca1277b0edbbed04de66e0d44e383e1b815ef/docs/architecture/ELIOT_RESEARCH.md).

```sh
git grep -n -F '## 7.12. Research products' -- docs/architecture/ELIOT_RESEARCH.md
```

## 4. Implementation approach

Use installed prompt/output schemas and Artifact sections. Every material statement retains its ClaimAuditItem and exact handles. A follow-up ASK references the previous inquiry/artifact revision and the currently authorized scope. Do not resend unbounded chat history or treat the previous answer as a primary source. Reuse verified evidence when no new facts are introduced; new sources after freeze use #232's explicit reopen. PWA/MCP show the same persisted result. Direct FAST_SEARCH remains free of reasoning-model calls.

## 5. Acceptance criteria

- [ ] English/Russian ASK→follow-up retains concrete evidence and uncertainty; BRIEF retains units, conditions, dissent, and negative findings.
- [ ] A number absent from the cited excerpt is unsupported, not invented.
- [ ] Scope changes, reauthorization, and restart do not mix projects; citations open the recorded revision.
- [ ] Product output contracts differ substantively, not only in their heading.
- [ ] Record local controlled-model chain tests and exact SHA. Later T3 real-generation quality acceptance is explicitly separate.
