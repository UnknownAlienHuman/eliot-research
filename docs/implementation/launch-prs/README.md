# Launch implementation assignments

Authority: ELIOT_RESEARCH v29.1; LANGUAGE_RUNTIME_CONTRACT v1.0; accepted ADRs, including
[ADR-0006 Google external transport profiles](../../adr/0006-google-external-transport-profiles.md).

Read [`docs/START-HERE.md`](../../START-HERE.md) if you are new, then the current
[`backend-entrypoints.md`](../backend-entrypoints.md), and only then
[execution-contract.md](execution-contract.md). Each active PR/passport contains files, implementation
steps, gates and observable result conditions.

The table below is a **historical theme map, not the current status board or manager assignment list**.
PR numbers and checkpoint names age. Current dependency order and dispositions are owned by the backend
entry router and final PR matrix.

| Historical theme | Plan | Canonical coverage | Original first checkpoint |
|---|---|---|---|
| Library (#98, continuation of merged #89) | `01-library.md` | §§3–4,12.1,19.5; source/project/UI | L1 real-storage Playwright harness |
| Retrieval (#90) | `02-retrieval.md` | §§6,15.4–15.5,19.2–19.4; exact/lexical/semantic/exhaustive | Q1 import-fed D1 lane |
| Corpus Lens (#91) | `03-corpus-lens.md` | §§5.1–5.3,6.11,18 Slice 3; structure/Atlas | N1 coordinate-bound materialization |
| Research (#92) | `04-research.md` | §§7–8,14,19.3; Investigation/Workflow/session/model budget | W1 durable ledger |
| Federation (#93) | `05-federation.md` | §11,19.11; generic federation and optional ELIOT leaf | F1 authenticated runtime wiring |
| Wiki/reports (#94) | `06-wiki-reports.md` | §§5.4–5.5,9,19.6; Wiki/artifacts/atoms/arguments | P1 immutable publication storage |
| Google (#95) | `07-google.md` | §§12.3–12.10,13.4–13.6,19.7; selected Workspace MCP and legacy Drive Exchange | G1 owner configuration/begin |
| Recovery/release (#96) | `08-recovery.md` | §§10,13.7–13.8,15–16,19; Steward/erasure/restore/release | O1 shared probe/evidence runner |
| Rust (#97 closed; plan merged) | `09-rust.md` | language §§5–10; per-family M2–M7 | K1 missing identity parity |

These plans are requirements/history, not nine running agents. Current work uses one worktree per
manager and one bounded checkpoint per manager, as defined by `backend-entrypoints.md` and
`branch-discipline.md`. Do not resurrect old reserved branch names or merge historical theme trees.

## Historical dependency lessons still preserved

Checkpoint outputs, not whole PR numbers, release downstream work:

- governed normalized import can feed retrieval without a second normalization pipeline;
- exact evidence releases structural navigation and Research retrieval;
- ledger and immutable artifact storage can proceed independently until freeze/publication integration;
- federation transport is separate from executable Research;
- legacy Drive Exchange and selected Workspace MCP are separate profiles;
- staging/release acceptance follows complete local code and exact build identities;
- Rust promotion/removal happens per stable family only after actual caller parity.

Current detailed dependencies are in the
[final PR matrix](../../../.github/audits/2026-10-08/FINAL-PR-DISPOSITION-MATRIX.md).

## Release scope

Mandatory launch profile remains Slices 0–6. Specialist Slice 7, optional graph/native replacement,
optional Google/federation profiles and optional Rust promotion do not become unconditional core
blockers. Account-only observations follow [cloudflare-handoff.md](cloudflare-handoff.md) after complete
local code and explicit owner authorization.
