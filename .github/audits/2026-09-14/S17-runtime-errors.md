# S17 — Preserve distinct Research runtime failure causes

Baseline: `a2aca127`; finding F13. Unlike S02, which covers the test harness, this task covers application runtime error mapping.

## 1. Problem

Semantic configuration/currentness helpers collapse different failures into WORKFLOW_AUTHORITY_STALE; other wrappers discard the original cause. In the recorded live incident, an initial OUTPUT_CORRUPT later appeared as a budget stop. This encourages repairing a secondary symptom instead of the original failure.

## 2. Required change

Preserve the original error type and stage through semantic preparation → Workflow → status response. Distinguish malformed configuration, missing credentials, expired proofs, actual revocation, transient I/O, and corrupt output using existing error families.

## 3. Documentation and exact search anchors

[Execution contract, section 5](https://github.com/UnknownAlienHuman/eliot-research/blob/a2aca1277b0edbbed04de66e0d44e383e1b815ef/docs/implementation/launch-prs/execution-contract.md).

```sh
git grep -n -F '## 5. What a good result is' -- docs/implementation/launch-prs/execution-contract.md
git grep -n -F 'configurationMissing' -- apps/eliotr-core/src/research-semantic-server.ts
git grep -n -F 'void message' -- apps/eliotr-core/src
```

## 4. Implementation approach

Repair the existing error mapping; do not add a logger framework or another catalog of hundreds of codes. Retain the first failure reason for each attempt and record later failures as consequences rather than replacements. Expose safe code/stage/trace_id and an appropriate recovery action. Never expose secret values, provider payloads, or source text. Naming a missing environment variable is acceptable; revealing its value is not. Retryability must reflect whether retrying that operation is actually safe.

## 5. Acceptance criteria

- [ ] Isolated injections of each listed cause produce distinguishable, safe results.
- [ ] Repeated status reads do not replace the original corrupt-output failure with a secondary budget failure.
- [ ] No secret or source body appears in message/cause/log/HTTP output.
- [ ] Fail-closed and UNKNOWN semantics remain intact; public CompletionDisposition is not expanded.
- [ ] Test the actual caller chain and record exact implementation SHA and before/after results.
