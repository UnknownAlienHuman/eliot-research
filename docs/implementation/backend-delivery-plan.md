# Backend delivery plan

Baseline: `ddf5979b64e2da8b611715271b5358b18cc4427f`. Work directly in current `main`; no worktrees, wholesale merges of planning branches, or unrequested cloud deployments. The owner requested implementation of the difficult domain/control-plane work, with broad testing, UI polish and mechanical cleanup delegated to the local agent.

The existing [99-task index](https://github.com/UnknownAlienHuman/eliot-research/pull/292) remains the requirement map. This document is the implementation order and handoff, not a replacement backlog. The supplied consolidated audit is evidence to verify, not permission to remove policy, evidence, Budget Governor or atomic SQL protections indiscriminately.

## Implementation order

1. **Operation identity and lifetime — S08, S16, S14/S15, S05/S33.** Fix replay binding before widening access or extending run lifetime. Preserve durable cancellation and terminal-state ordering before adding more model branches. Then separate compatible deployments and server execution authority from browser-session lifetime. Existing S06 historical read reauthorization is retained. No stored result, receipt, source revision or operation identity is rewritten to make a check pass.
2. **One delegated machine principal — S10/S31, S11/S12/S13, S98/S99.** One owner-issued project grant and exact operation vocabulary. Wire the real HTTP/MCP request path, normalized intake, append-only project attachment and complete authorized scope. Never impersonate `owner_pwa` or use a browser token as machine identity.
3. **Executable Research — S09/S21/S22, S35–S46.** Connect managed retrieval to the real Workflow first. Implement protocol/planning/freeze/debt/verifier decisions and one shared checkpointed branch executor. No role-specific engines, unconditional model fan-out, or technical checkpoint counted as a scientific procedure.
4. **Persisted products and integrations — S47–S61.** Complete admission/navigation/index generation boundaries, compiler/publication/dependency decisions and the selected Workspace/federation paths. Reuse existing converters, exact evidence resolver and managed Cloudflare services.
5. **Data and execution safety — S62–S72.** Complete erasure closure, delivery reconciliation, coherent backup/isolated restore, rollback, bounded Steward and event/currentness behavior. External parameters are needed only for the corresponding actual live action, not to write the code.
6. **Single deterministic runtime owner — S78–S89.** Port only stabilized domain families, retain exact legacy bytes, prove one actual Wasm boundary, then switch one caller family at a time and remove its replaced TS implementation. Do not freeze an unfixed TS bug as normative parity.

Within each phase, an existing dependency is reused rather than rewritten. Independent wiring fixes may precede a larger migration when they are needed to exercise the same real path. A task is not closed because its Markdown was merged or one helper compiled.

## Division of work

**This implementation:** domain decisions, strict request binding, authorization/currentness, transactional settlement, real application composition, and narrow regressions needed to establish that the critical change is safe. Record the actual result, not an anticipated PASS.

**Local agent:** full Linux/Windows/core/browser suites, fixture expansion, mutation/load/quality/native-platform qualification, UI tasks S19/S20/S26/S73–S76, source-budget/documentation cleanup, and final S92–S97 acceptance. Do not replace real D1 tests with DatabaseSync or change assertions merely to get green output. Existing commands and proof boundaries are in PR #292.

Paid-effect/authentication/cancellation changes still need a focused negative/replay test before push. The owner's delegation of broad testing is not a waiver of correctness or permission to disable safeguards.

## Checkpoint ledger

- S01 boundary repair and S06 historical reading: already on baseline main. Their earlier focused results are recorded in PRs #193 and #198; full/live acceptance is separate.
- Next: S08 query replay must compare the requested canonical scope expression with the persisted one, without creating a replacement snapshot or widening scope.
- Subsequent completed checkpoints will be recorded here and in their existing planning PRs with implementation commits and the local agent's remaining acceptance work.

## Completion boundary

The target is the known mandatory v1/Slices 0–6 with `gemini-mcp`. Completion requires both implemented paths and the existing final acceptance in S92–S97. Do not label every PR complete after a code-only pass. Preserve explicit pending live configuration, independent client, offsite destination and release approval requirements; do not fabricate credentials or receipts.
