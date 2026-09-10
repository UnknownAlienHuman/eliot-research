# Start an agent on a launch checkpoint

New to the repository? Read [`docs/START-HERE.md`](../../START-HERE.md) first; this file covers only
the launch-checkpoint procedure.

Start from current `main` plus the selected existing theme PR head. Task refresh changes documentation
only; it launches no agent, implements no missing feature, and authorizes no deployment.

Read [execution-contract.md](execution-contract.md), the selected numbered plan and its cited canonical
sections/ER packets. The plan's tests and good-result conditions are mandatory, not suggestions.

## Selecting a checkpoint

**Do not hardcode a wave of assignments into this document.** An earlier revision named three specific
first-wave tasks; all three were completed and merged while this file kept telling new agents to start
them. Derive the open work instead:

```bash
git fetch origin --prune && git log --oneline -15 origin/main
gh pr list --state open --limit 20        # which themes are open, and which are red
gh pr view <theme-PR> --json body         # unchecked boxes in the plan are the remaining work
pnpm check:implementation-status
```

An unchecked box in a theme plan is remaining work even when the surrounding package compiles. A
checked box plus a merged checkpoint PR is done. The dependency graph in [README.md](README.md) says
which checkpoint outputs release which downstream work — a blocked integration task never authorizes
a stub service; take an independent predecessor or report the precise missing dependency.

Concurrency is bounded by [`branch-discipline.md`](../branch-discipline.md), not by the number of open
themes: one agent holds one theme, one branch and one worktree at a time. The nine reserved branch
names in `infra/github/branch-hygiene.json` are planning reservations, not authorized parallel
worktrees. All UI belongs to ER-25; all shared code is integrator-serialized.

## Start/finish message an agent must post in its PR

```text
Claim: <checkpoint ID>, <ER owner>, base main=<SHA>, head=<SHA>
Files: <exact existing/new paths; shared-file owner approvals>
Inputs: <accepted predecessor commit/fixture/artifact references>
Tests: <named success, negative, race, restart and bound tests>
No account changes: true
```

At finish replace intent with evidence: commands, exit codes, before/after regression, durable identity
and expected/actual states, output SHA, contract/migration impact and unchecked follow-ups. No test count
alone closes a task. No secrets or source payloads in comments. Keep a theme draft until all its local
code acceptance passes; preserve live work separately as NOT_EXECUTED. An owner-requested partial merge
must keep the incomplete theme tracked rather than silently close it.

## Existing code agents must not duplicate

Library: normalized-folder upload, same-tab/reload/lost-ID recovery, namespace/read-policy local setup,
Library-to-metadata-Lens and recorded-only revision history are on main. #98 now owns their remaining
raw-file/project/active-readiness/error/full-browser acceptance.

Google: G1a REST/serializer, encrypted vault/D1 refresh and internal first OAuth admission are on main.
Use `drive-rest.md`, `drive-credentials.md`, `drive-oauth-admission.md` for the explicit
`drive-exchange` profile. Its Required Drive path stays IN_PROGRESS. The selected `gemini-mcp`
profile follows a separate Workspace admission/readback gate through Gemini Spark Connected Apps or
Google Antigravity and does not require the legacy custom OAuth path. The retained Gemini CLI installer
is legacy and unselected. Legacy first admission deliberately returns AUTHORIZING, not ACTIVE.

Rust: M1 plus narrow canonical JSON/SHA/generation/residency shadow primitives exist. They accept their
current schema domains (including safe-integer canonical-body rules), not every imaginable JSON value.
M5 is Wasm/shadow, M6 promotion and M7 superseded TS removal. The per-family checklist is
[09-rust.md](09-rust.md), merged to main; PR #97 is closed and is not the current reference.

## When account agents may start

They may implement test/probe runners locally now. They may NOT start provisioning/deploy to finish code.
O6/O7 in #96 and the shared handoff govern first complete staging; O8 governs production qualification.
`pnpm launch:code` currently must fail. All nine local code checklists, complete integrated user loops,
critical Rust promotion, full exact-head CI and an explicitly approved isolated target are required.
Real T4/T6 receipts are generated during/after that first staging trial, not fabricated beforehand.

Use the checkpoint dependency graph in README.md. A blocked integration task does not authorize a stub
service: take only an independent specified predecessor or report the precise missing dependency.
