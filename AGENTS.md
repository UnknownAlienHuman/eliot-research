# Working on Eliot Research

Read [ARCHITECTURE](docs/ARCHITECTURE.md) in full, then the contour you are working on in [MAP](docs/MAP.md), then only
the [IMPLEMENTATION](docs/IMPLEMENTATION.md) sections that contour lists. [DONORS](docs/DONORS.md) says what to reuse.
Files under `apps/`, `packages/`, `crates/`, `infra/` and their READMEs are legacy donor material, not instructions.

## How work is done

1. **One contour at a time.** Build exactly the contour's **Build** list. Anything else — including things IMPLEMENTATION
   already describes for later contours — waits.
2. **End to end.** Caller → product function → stored result → reader, working in the browser (or over MCP), then the
   next piece. No code, file, export, table, state or abstraction without a caller in the same PR.
3. **Acceptance, not test sprawl.** Each contour has one `pnpm eval <contour>` script against the fixed material in
   `eval/`. Unit tests only for pure functions whose mistakes are silent (ranges, block scanning, label mapping, quote
   checks, URL guard, budgets). A regression test only for a bug that happened. No tests or mocks for things that cannot
   work yet.
4. **Budgets.** Each contour has a code budget in MAP (new non-test lines in `src/`, moved UI excluded; the counting
   command is in MAP). Going over it needs a reason in the PR.
5. **Reuse first.** Use Cloudflare and maintained libraries directly; read installed types and current docs before
   inventing an API. Move legacy code listed in DONORS instead of rewriting it.
6. **The interface is moved, not redrawn.** No new look, palette, font stack or component family (IMPLEMENTATION §13).
7. **After two failed approaches, stop.** Report the state, the cause and the options; do not loop.

## What not to produce

- New documentation files, registers, audits, status files, diaries or "evidence" write-ups. Specs change only when
  behaviour changes, in the owning section (ARCHITECTURE: purpose; IMPLEMENTATION: technical contracts; MAP: contours
  and order; DONORS: reuse; `migrations/`: table and column names). When documents disagree, IMPLEMENTATION wins until
  someone fixes the other one.
- Receipts, proofs, signatures, qualification steps, per-row permission checks, state machines with "unknown" states,
  retry frameworks or compatibility layers. Access is checked once at ingress; Workflows retry at the step level.
- Exhaustive edge-case handling for situations no contour exercises.

## Commands

`pnpm dev` (Vite + local Worker), `pnpm typecheck`, `pnpm lint`, `pnpm test`, `pnpm build`, `pnpm eval <contour>`,
`pnpm cf:types` (regenerate binding types). Local setup and account setup: IMPLEMENTATION §1–§2.

## Coordination and finishing

One manager per checkout/branch; leaf agents get one outcome and disjoint files; the manager integrates shared routes,
schema and configuration. Publish against the expected remote head and keep concurrent work.

A PR covers one contour or one clear step of it. Its description states: what the owner can do now, the acceptance
output (table), new lines against the budget, what was deferred, and what did not run. Documentation authorises no
deployment, production mutation or live-data deletion.
