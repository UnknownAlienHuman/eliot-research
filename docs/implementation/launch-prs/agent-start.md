# Start an agent on a launch checkpoint

New to the repository? Read [`docs/START-HERE.md`](../../START-HERE.md) first; this file covers only
the launch-checkpoint procedure.

For backend work, select the current dependency-ready card in
[backend-entrypoints.md](../backend-entrypoints.md), then the owner-resumed delivery plan and active
passport. Numbered launch plans preserve historical requirements and do not override that queue or
current ownership. The current owner-web authorization is recorded in START-HERE and its execution map.

Start from current `main`; read the selected existing theme PR as a specification, not a branch to merge. A
task refresh changes documentation only; it launches no agent, implements no missing feature, and authorizes
no deployment.

Read [execution-contract.md](execution-contract.md), the selected numbered plan and its cited canonical
sections/ER packets. The plan's tests and good-result conditions are mandatory, not suggestions.

## Selecting a checkpoint

**Do not hardcode a wave of assignments into this document.** An earlier revision named three specific
first-wave tasks; all three were completed and merged while this file kept telling new agents to start them.
Derive open work instead:

```bash
git fetch origin --prune && git log --oneline -15 origin/main
gh pr list --state open --limit 20
gh pr view <theme-PR> --json body
pnpm check:implementation-status
pnpm work-packets:check
```

An unchecked box in a theme plan is remaining work even when the package compiles. A checked box plus an
accepted checkpoint is done. The dependency graph in [README.md](README.md) says which outputs release
which downstream work. A blocked integration task never authorizes a stub service; take an independent
predecessor or report the precise dependency.

Follow [`branch-discipline.md`](../branch-discipline.md): one active checkpoint per agent. Owner-directed
source implementation is on current `main` without extra worktrees/task branches unless the owner explicitly
requests a review PR, as with documentation-only UI platform PR #329. There is no branch-count quota or
reservation list.

Frontend ownership is now explicit:

- **ER-25** owns the served legacy PWA, accepted behavior and critical pre-cutover repair only;
- **ER-47** owns new React owner-web/UI/test/harness paths;
- **ER-48** owns extraction of the side-effect-free owner API client and legacy browser-package compatibility;
- root manifests, Worker config, CI, deployment and cutover files remain integrator-serialized.

Do not use old “all UI belongs to ER-25” instructions to patch the legacy presentation or to edit ER-47/48
paths. Run `pnpm work-packets:check` and read the selected packet’s exact `owned_paths`.

## Start/finish message an agent must post

```text
Claim: <checkpoint ID>, <ER owner>, base main=<SHA>, head=<SHA>
Files: <exact existing/new paths; shared-file owner approvals>
Inputs: <accepted predecessor commit/fixture/artifact references>
Tests: <named success, negative, race, restart and bound tests>
No account changes: true
```

At finish replace intent with evidence: commands, exit codes, before/after regression, durable identity,
expected/actual states, output SHA, contract/migration impact and unchecked follow-ups. No test count alone
closes a task. No secrets/source payloads in comments. Keep a theme draft until its local code acceptance
passes; preserve live work as `NOT_EXECUTED`. An owner-requested partial merge retains incomplete work rather
than silently closing it.

## Existing code agents must not duplicate

Library: normalized-folder upload, same-tab/reload/lost-ID recovery, namespace/read-policy local setup,
Library-to-metadata-Lens and recorded-only revision history are on main. #98 owns remaining raw-file/project/
active-readiness/error/full-browser acceptance.

Google: G1a REST/serializer, encrypted vault/D1 refresh and internal first OAuth admission are on main. Use
`drive-rest.md`, `drive-credentials.md`, `drive-oauth-admission.md` for explicit `drive-exchange`. Selected
`gemini-mcp` follows separate Workspace admission/readback and does not require legacy custom OAuth. Legacy
first admission deliberately returns AUTHORIZING, not ACTIVE.

Rust: M1 plus narrow canonical JSON/SHA/generation/residency shadow primitives exist. They accept current
schema domains, not every possible JSON value. M5 is Wasm/shadow, M6 promotion and M7 superseded TS removal.
Use [09-rust.md](09-rust.md); closed PR #97 is not current authority.

Owner web: do not improve legacy layout/CSS/renderers. ADR-0016/0017, ER-47/48 and
`frontend-platform-migration.md` govern the replacement. Implementation remains paused until the owner
explicitly resumes a named U/C checkpoint or autonomous tranche. A tranche manager then continues without
per-checkpoint prompts until its named human gate or hard blocker.

## When account agents may start

They may implement local test/probe runners when their checkpoint is authorized. They may not provision or
deploy merely to finish code. O6/O7 in #96 and the shared handoff govern first complete staging; O8 governs
production qualification. `pnpm launch:code` must currently fail. Local code checklists, integrated user
loops, critical Rust promotion, exact-head CI and an approved isolated target are required.

Real T4/T6 receipts are generated during/after the first staging trial, not fabricated beforehand. Use the
checkpoint dependency graph. A blocked integration task does not authorize a stub service.
