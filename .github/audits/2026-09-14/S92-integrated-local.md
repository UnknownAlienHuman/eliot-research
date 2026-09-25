# S92 — Prove the integrated owner and headless product loop on one build

Baseline `a2aca127`; ER-27/25/24/00. This is aggregate local acceptance after required paths are integrated, not a substitute for their focused regression tests. Reuse the existing Playwright/core runtime and an independent fetch/MCP client; introduce no new testing framework.

## 1. Problem

Passing individual helpers does not prove that sources, projects, grants, retrieval, research, reports, and citations work together. Infrastructure assertions alone also do not establish usable human workflows.

## 2. Required change

Refactor the existing owner-e2e into short scenario modules with shared setup/cleanup and preserved security negatives. Run owner and machine paths against the same exact build/config/schema: initial setup→source→project→query/run→report→citation→edit/publication→history→revoke/purge. Include S98/S99 headless ingest and larger project scope.

## 3. Documentation and exact search anchors

[Execution contract 4–5](https://github.com/UnknownAlienHuman/eliot-research/blob/a2aca1277b0edbbed04de66e0d44e383e1b815ef/docs/implementation/launch-prs/execution-contract.md).
```sh
git grep -n -F 'D1/R2/runtime, crypto, transactions' -- docs/implementation/launch-prs/execution-contract.md
```

## 4. Implementation approach

Control only external identity/provider responses; execute actual application HTTP, D1/R2, local Queue/DO, and compiled Wasm paths. The owner issues machine grants through the application API, not preseeded successful authority rows. Verify source admission/revision/readiness, product-specific fixtures, exact citations, and local Workspace/federation contracts.

Exercise JWT refresh, compatible deployment, source update, network loss/reconnect, cancellation, and transient recovery. Each scenario records expected durable IDs/effects/digests, safe phase labels, and actual failure evidence. Preserve separation between local provider-controlled tests and native hibernation/provider-settlement qualification in S95. Do not suppress failure with catch-success, skip, or inflated timeouts. Avoid recreating the entire suite as another monolithic scenario file.

## 5. Acceptance criteria

- [ ] Owner UI and independent headless clients complete applicable paths without manual SQL or borrowed owner cookies; authorized artifact/citation hashes and dispositions agree.
- [ ] Reload/replay/recovery never duplicate imports, runs, or already completed paid stages. A legitimate first subsequent audit is accounted for separately.
- [ ] Revoked, purged, foreign, late, and corrupt responses do not disclose data; authorized historical v1/v2 reads remain exact.
- [ ] The final SHA passes the applicable frozen-install, check:affected, schema/type, build/dry-run, local-smoke/owner, and Linux/Windows browser checks using actual repository commands.
- [ ] Record exact build/config/schema and commands/results. An unrelated remaining failure still prevents an overall PASS; this assignment does not certify the product before execution.
