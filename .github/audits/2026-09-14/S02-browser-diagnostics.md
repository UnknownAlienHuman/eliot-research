# S02 — Preserve the root cause of owner-browser acceptance failures

P1. Owner: ER-27; shared tooling: ER-00. Parent: #98. Baseline: `a2aca1277b0edbbed04de66e0d44e383e1b815ef`. Findings: F13/F20. Technically independent of S01; integrate changes sequentially on current main without local worktrees. This assignment is not an implemented fix or deployment authorization.

## 1. Problem

`preserveWorkerFailure` in `tests/integration/browser/owner-e2e.mjs` creates an Error containing only a safe classification and runtime snapshot. The meaningful assertion and its expected/actual values are lost. CI points to the raw-upload helper call near line 6037 without retaining the precise cause. `unknown:61` does not mean 61 application errors.

## 2. Required change

Preserve the original assertion's safe identity, phase, source location, and bounded expected/actual values for explicitly permitted test data. Retain an observable cause chain without letting the formatter/test runner print tokens or private source content. Do not change application behavior, timeouts, retries, or whether the test succeeds.

## 3. Documentation and exact search anchors

[Execution contract, section 5](https://github.com/UnknownAlienHuman/eliot-research/blob/a2aca1277b0edbbed04de66e0d44e383e1b815ef/docs/implementation/launch-prs/execution-contract.md): before/after, expected/actual, and secret-free evidence.

```sh
git grep -n -F '## 5. What a good result is' -- docs/implementation/launch-prs/execution-contract.md
git grep -n -F 'preserveWorkerFailure' -- tests/integration/browser/owner-e2e.mjs
```

## 4. Implementation approach

Extend the existing diagnostic wrapper and tests; do not introduce a logging framework. Retain a stable assertion identifier or phase, with bounded cause depth/string length and an explicit set of safe fields. Do not attach an unprocessed Error as `cause` when the runner would print it verbatim. Use synthetic assertion/nested-error cases to prove that the cause survives, and secret-bearing/large values to prove redaction. Reproduce the original raw-upload scenario once on the same application code and give S03 the resulting precise failure.

## 5. Acceptance criteria

- [ ] Output identifies the original assertion and safe expected/actual values, or explicitly explains their redaction.
- [ ] Tokens, cookies, Authorization values, token-bearing URLs, and private content are absent from logs, stack/cause output, and test artifacts.
- [ ] Failure remains non-zero and cleanup still runs.
- [ ] No timeout/retry increases and no removed raw-upload assertions.
- [ ] Attach focused-test results, exact implementation SHA, and the reproduced diagnosis. Behavioral repair belongs to S03.
