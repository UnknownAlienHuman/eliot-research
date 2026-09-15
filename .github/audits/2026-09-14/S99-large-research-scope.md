# S99 — Use the complete authorized project scope, not only the first 64 sources

Baseline `a2aca127`; F08, ER-30/24/31. Reverification distinguishes the generic scope service, which already supports larger membership envelopes, from narrower owner ORIENT/Research/historical adapters. At the reviewed baseline the generic limits include 50,000 snapshot members, 1,000 selected IDs, and a 2 MiB canonical envelope. These different constraints are not a single universal capacity promise. Do not build another scope store or index.

## 1. Problem

Research invokes owner orientation using a smaller scope profile; historical readers also use a 64-member default and a fixed 65-row witness. Preview/top-k limits must not silently cap the entire requested project.

## 2. Required change

Separate navigation-preview budget, retrieval-result count, and the full frozen authorized membership. Carry the existing larger scope loader/profile through Research launch, Workflow retrieval/freeze/coverage, and report/historical reads. A paginated UI must not silently turn an explicit full-project request into its first page.

## 3. Documentation and exact search anchors

[Scope service](https://github.com/UnknownAlienHuman/eliot-research/blob/a2aca1277b0edbbed04de66e0d44e383e1b815ef/packages/cloudflare-navigation/src/scope-service.ts); [Architecture section 7.5](https://github.com/UnknownAlienHuman/eliot-research/blob/a2aca1277b0edbbed04de66e0d44e383e1b815ef/docs/architecture/ELIOT_RESEARCH.md).
```sh
git grep -n -F 'DEFAULT_MAX_SNAPSHOT_MEMBERS' -- packages/cloudflare-navigation/src/scope-service.ts
git grep -n -F '## 7.5. SourcePortfolio and coverage denominator' -- docs/architecture/ELIOT_RESEARCH.md
```

## 4. Implementation approach

Reuse scope-service options, profile binding, and bounded membership/authority queries; do not replace every 64 constant with an arbitrary large number. ORIENT preview is not the sole source of complete membership. Freeze the authorized metadata set, not all document bodies. Preserve every atom/policy check and the original scope expression.

Historical reauthorization uses the recorded scope profile and bounded paged witness rather than a fixed LIMIT 65. Original member references and ownership stay unchanged. Requests exceeding the existing actual canonical byte/member envelope receive an explicit limit outcome and scope-partition guidance; do not silently truncate or invent another manifest protocol.

Reuse S51 exhaustive sharding and S36 portfolio semantics. Top-k retrieval does not establish complete absence, and larger scope does not require one model call per document. Preserve compatibility with existing 64-source artifacts and immutable IDs.

## 5. Acceptance criteria

- [ ] Projects with 65 and 299 actually admitted sources start with full authorized membership recorded; UI pages and top-16 retrieval do not silently reduce the requested denominator.
- [ ] A relevant answer/counterexample beyond the first 64 sources is available through the appropriate retrieval/exhaustive scenario; trace distinguishes requested scope from retrieved subset without claiming semantic completeness.
- [ ] JWT refresh/source update/history tests preserve original membership and exact references; foreign members, revoke/purge, and incompatible profiles fail safely.
- [ ] No whole-corpus body buffering, second store/index, or arbitrary blanket limit increase; test actual envelope boundaries and legacy compatibility.
- [ ] Retain actual local ingest→project→run→report→history tests, exact SHA/config/input sizes, and subsequent representative quality results under #285.
