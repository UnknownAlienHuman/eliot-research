# S81 — Port policy, disclosure, residency, and budget decisions to pure Rust

Baseline `a2aca127`; ER-03/40. Use the language contract's eliotr-policy/eliotr-residency targets and accepted #202/#261/#262 semantics. This task groups related pure decision checkpoints; it does not introduce independently competing authorizers. Runtime promotion remains separate.

## 1. Problem

Correct policy serialization does not establish correct evaluation. Migration must preserve denial order, taint/effect ceilings, retention constraints, and independent model/client disclosure permissions.

## 2. Required change

Port the existing pure fixed-order evaluator, ObjectResidencyKey admissibility/reuse decision, and deterministic Budget Governor decisions. Native Gateway calls, durable reservations, JWT verification, encryption I/O, and database mutations remain in TypeScript/platform adapters. Do not replace the existing budget system.

## 3. Documentation and exact search anchors

[ER-03](https://github.com/UnknownAlienHuman/eliot-research/blob/a2aca1277b0edbbed04de66e0d44e383e1b815ef/docs/agent-work/ER-03-policy-disclosure-and-injection-boundary.md); [Language contract 3/10](https://github.com/UnknownAlienHuman/eliot-research/blob/a2aca1277b0edbbed04de66e0d44e383e1b815ef/docs/architecture/LANGUAGE_RUNTIME_CONTRACT.md).
```sh
git grep -n -F 'Implement fixed-order policy evaluation' -- docs/agent-work/ER-03-policy-disclosure-and-injection-boundary.md
```

## 4. Implementation approach

Pass validated principal/source/task/client/inference/retention/license/purge facts, receipt references, observed time, usage, and quote explicitly. Preserve existing numeric units; avoid floating-point cost drift. Unknown load-bearing facts fail closed. Permission to view cannot strengthen model/client permission; a caller boolean cannot replace a declassification receipt.

Equal content hashes across different residency, encryption-key, or retention domains do not authorize physical reuse. Preserve issuer/grantor/grantee distinctions. Run identical versioned inputs through TS/native/Wasm, comparing exact decisions and errors. Pure code performs no network, clock, global-state, or platform I/O, and cannot authenticate an unverified input by itself. Exhausted model budgets must still permit independently authorized exact-evidence reads. SQL retains final transactional checks.

## 5. Acceptance criteria

- [ ] Positive/negative policy-axis fixtures agree on decision, reason, evaluation order, and receipt identity; Rust never returns stronger authority.
- [ ] Cross-residency/key reuse, hidden inference disclosure, late revocation, quote overflow, and missing context are rejected; viewer-only and permitted budget-stop reads remain correct.
- [ ] Property/mutation checks detect removal of load-bearing restrictions; applicable pure Rust gates pass.
- [ ] Preserve SQL enforcement and record exact functions, fixtures, SHAs, and results. S88/S89 separately establish actual Worker shadow/promotion; this task does not prove that by itself.
