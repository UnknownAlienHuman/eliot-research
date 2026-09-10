# Launch implementation assignments

Authority: ELIOT_RESEARCH v29.1; LANGUAGE_RUNTIME_CONTRACT v1.0; accepted ADRs.
Read [`docs/START-HERE.md`](../../START-HERE.md) if you are new, then
[execution-contract.md](execution-contract.md). Each theme plan contains small numbered checkpoints
with files, implementation steps, tests and observable pass conditions. Unchecked means not done, even
when the surrounding package compiles. Plans live on their named PR heads until merged.

The table below is the **theme map, not a status board.** PR numbers and checkpoint names age; the
"first local checkpoint" column records where each theme originally started, not what is open now.
Derive current status with `gh pr list --state open` and the theme's own checklist, as described in
[agent-start.md](agent-start.md).

| PR | Plan on its head | Canonical coverage | First local checkpoint |
|---|---|---|---|
| #98 (continuation of merged #89) | `01-library.md` | §§3–4,12.1,19.5; source/project/UI | L1 real-storage Playwright harness |
| #90 | `02-retrieval.md` | §§6,15.4–15.5,19.2–19.4; exact/lexical/semantic/exhaustive | Q1 import-fed D1 lane |
| #91 | `03-corpus-lens.md` | §§5.1–5.3,6.11,18 Slice 3; structure/Atlas | N1 coordinate-bound materialization |
| #92 | `04-research.md` | §§7–8,14,19.3; Investigation/Workflow/session/model budget | W1 durable ledger |
| #93 | `05-federation.md` | §11,19.11; generic federation and optional ELIOT leaf | F1 authenticated runtime wiring |
| #94 | `06-wiki-reports.md` | §§5.4–5.5,9,19.6; Wiki/artifacts/atoms/arguments | P1 immutable publication storage |
| #95 | `07-google.md` | §§12.3–12.10,13.4–13.6,19.7; required Drive Exchange | G1 owner configuration/begin |
| #96 | `08-recovery.md` | §§10,13.7–13.8,15–16,19; Steward/erasure/restore/release | O1 shared probe/evidence runner |
| Rust (#97 closed; plan `09-rust.md` merged to main) | `09-rust.md` | language §§5–10; M2–M7 per-family migration | K1 missing identity parity |

These are implementation queues, not nine running agents. Use the nine exact reserved names from
`infra/github/branch-hygiene.json`, not variant branches. #98 carries the unfinished Library acceptance;
#89 stays merged and is not reopened. Theme PRs target main, not a stacked speculative branch chain.

## Dependency graph without whole-PR cycles

Checkpoint outputs, not merely PR numbers, release downstream work:

- Existing governed normalized import can feed Q1 immediately; raw-file L2–L4 consumes the SAME
  Q1/projection contract, not a second normalization pipeline. L1 is independently implementable.
- Q2/Q3 exact evidence opens release N2/N3 structural navigation and W3 research retrieval.
- W1 ledger and P1 immutable section/head storage are independent. W4 freeze/audit releases P3/P4
  publication integration; W6 final materialization then consumes P2/P3. Do not make all #92 wait for
  all #94 while all #94 waits for all #92.
- F1/F2 reservation and authenticated reads reuse existing federation storage; F3 executable research
  consumes W3/W6. Generic bundle transport tests do not need a fabricated completed Investigation.
- G1/G2 reuse internal OAuth immediately; G3 reconnect and G4 provisioning release G5/G6 cursor import.
  G7 publication consumes P3 artifact/terminal receipts. Drive must not become a second source owner.
- O1/O2/O3 probe, backup and restore-local foundations can run independently. O4 full erasure closure
  and O7/O8 staging/production integrate every dependency family. Each theme supplies its own probe.
- K1–K5 run by stable family. K6/K7 promote/remove each family only after its current TS behavior,
  runtime tests and budgets are accepted; later semantics changes re-open that family's parity gate.

All PWA integration uses one ER-25 owner and L1 harness; shared API/schema/CI edits use one integrator.
No invented domain authority, permanent TS/Rust duplication or code-only LIVE_QUALIFIED label.

## Release scope

Mandatory launch profile is Slices 0–6. Specialist Slice 7, optional graph DB/native replacement and
optional Gemini service are not added as unconditional blockers. Required ChatGPT Drive Exchange is NOT
optional. See [agent-start.md](agent-start.md) for starting instructions and
[cloudflare-handoff.md](cloudflare-handoff.md) for account-only observations after complete local code.
