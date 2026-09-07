# Start here

The single entry point for an agent joining Eliot Research. Read this file to the end before opening
anything else. It should take five minutes and it replaces guessing.

**Design rule for this file:** it records what does *not* age — read order, authority, procedure,
gates, discipline. Anything that ages (which checkpoint is next, what is merged, what is red) is
*derived by running a command*, never copied here. A previous entry document hardcoded a "first wave"
of three tasks; all three were completed and the document kept telling new agents to start them.
Do not reintroduce that pattern.

## 1. Orient by running, not by reading

Run these first, in the repository root. They answer "where is the project right now" in under a
minute, and they are authoritative in a way prose is not.

```bash
git fetch origin --prune && git log --oneline -5 origin/main
pnpm work-packets:check
pnpm check:implementation-status
gh pr list --state open --limit 20
gh issue list --state open
```

- `work-packets:check` prints the packet count, exclusive path claims and confirms the ownership DAG
  is acyclic and synchronized between `manifest.json` and the packet documents.
- `check:implementation-status` prints the exact contour census by state. **`LIVE_QUALIFIED: 0` means
  no part of this system has ever been proven against real Cloudflare or Google.** Treat every
  capability claim accordingly.

Then read [gap-register.md](implementation/gap-register.md) — the priority-ordered list of what is genuinely
missing — and [production-readiness-plan.md](implementation/production-readiness-plan.md) §0, which defines the only meaning
of "production-ready" that this project accepts.

## 2. Where authority lives

Read the narrow thing, not the master document. Rereading the architecture for ordinary work is
explicitly discouraged.

| Question | Authoritative source |
| --- | --- |
| What is the product, and who owns which state? | [ELIOT_RESEARCH.md](architecture/ELIOT_RESEARCH.md) — master; read only the sections your packet names |
| TypeScript vs Rust authority, ABI, migration milestones | [LANGUAGE_RUNTIME_CONTRACT.md](architecture/LANGUAGE_RUNTIME_CONTRACT.md) |
| A load-bearing decision that qualifies the above | [adr/](adr/) |
| Non-negotiable implementation boundaries | [AGENTS.md](../AGENTS.md) — root, plus the per-package ones |
| Who may edit which path | [manifest.json](agent-work/manifest.json) + [packets/](agent-work/packets/) |
| What a packet must deliver, including its negative case | [agent-work/](agent-work/)`ER-NN-*.md` |
| What is implemented vs merely compiling | [implementation-status.json](implementation/implementation-status.json) |
| What is still missing, by priority | [gap-register.md](implementation/gap-register.md) |
| Runtime limits and failure semantics | [runtime-contract.md](implementation/runtime-contract.md), [failure-model.md](implementation/failure-model.md) |
| Disclosure, taint, erasure and secret boundaries | [security-checklist.md](implementation/security-checklist.md) |
| Branch, worktree and PR rules | [branch-discipline.md](implementation/branch-discipline.md) |
| How to claim and finish a launch checkpoint | [execution-contract.md](implementation/launch-prs/execution-contract.md) |
| Pinned toolchain versions | [toolchain.md](implementation/toolchain.md) |

If a packet and the architecture conflict: **stop**, name the exact conflict, and change the shared
contract through ER-01/ER-00. Do not resolve it locally with a leaf-specific schema.

Every document in this repository is reachable from an index: [docs/README.md](README.md) for the
directories, [implementation/README.md](implementation/README.md) for the implementation guide, and
[agent-work/README.md](agent-work/README.md) for the packets. `node scripts/check-docs-index.mjs`
fails if a document, packet or `docs/` directory is unindexed, if an index link is broken, or if an
entry point stops pointing here. **If you add a document, add it to its index in the same change** —
an unindexed document is one nobody will find, which is the same as not writing it.

## 3. Pick exactly one piece of work

1. Read [agent-work/README.md](agent-work/README.md) and pick a **dependency-ready** packet, or read
   [launch-prs/README.md](implementation/launch-prs/README.md) and pick a numbered checkpoint inside one theme.
2. Confirm nobody else holds it: check the theme PR for an existing claim comment and check
   `git worktree list` and open PRs.
3. Post the claim block from [agent-start.md](implementation/launch-prs/agent-start.md) in the theme PR **before** editing.
4. Edit only your packet's `owned_paths`. If you need a file you do not own, that is a handoff, not
   permission.

One agent holds one packet, one branch, one worktree, one task at a time. Finish or explicitly hand
off before taking another.

## 4. Implement in this order

From `execution-contract.md` §3, condensed:

1. Reproduce the missing behaviour with a **failing test at the real boundary**. A fail-closed
   sentinel in the source is not permission to build a parallel stack next to it — find and reuse the
   existing port or adapter.
2. Implement the narrow transition, then its caller. Every mutation is
   Intent → Attempt → Receipt → Readback → Reconciliation. Canonical mutation and outbox intent commit
   together. **No HTTP, model, R2 or crypto effect inside a D1 transaction.**
3. Add negative tests and inspect the persisted row or object — not a mock call count. Cover duplicate
   delivery, stale CAS, purge/revocation, expiry, cancellation, restart, lost write response and
   concurrent replay.
4. Wire the tested path into the real Worker/API/PWA. A dead helper, a disabled button or a success
   fixture does not complete a user loop.
5. Update `implementation-status.json`, the gap register and the theme checklist **in the same change**
   that removes or adds a scaffold.

A lost acknowledgement is `UNKNOWN`. It is never permission to mint a replacement identity or to retry
a possibly-paid operation blindly.

## 5. Verify before you push

```bash
pnpm install --frozen-lockfile
pnpm check:affected
pnpm exec tsc -p apps/eliotr-core/test/tsconfig.json --pretty false
node scripts/check-docs-index.mjs   # if you added or moved a document or a packet
```

CI runs five jobs — `verify`, `rust`, `windows-tooling`, and `local-launch` on both Ubuntu and
Windows. `verify` alone runs contract fixtures, package boundaries plus their negative proof, source
budgets, work-packet ownership, branch hygiene, six authority fixtures, lint, typecheck, the full test
suites, the implementation-status registry, the PWA build, a Chromium Library test, local D1
preparation, binding-type generation and a Worker deployment dry-run.

Report results honestly. If `check:affected` stops early, say where and why, and do **not** report the
whole command as PASS. Put the commands and their exit codes in the PR body.

Pinned toolchain: Node ≥ 22.13, pnpm 11.23.0, Rust 1.98.0. Windows is a first-class CI target; long
paths and CRLF are real failure modes here, so prefer repository-relative paths and never hardcode a
workstation path into a committed file.

### Known local trap: `contracts:check` fails while CI is green

`check-contract-fixtures.mjs` hashes the **raw bytes on disk**. `.gitattributes` pins the byte-addressed
fixtures to `eol=lf`, but that attribute is applied at checkout — a worktree created before the pin, or
any stale checkout under `core.autocrlf=true`, still holds CRLF. Git reports the files as unmodified
because it normalizes on the fly, so the mismatch is invisible in `git status`:

```
tests/fixtures/contracts/eliotr.normalized.v1.yaml: expected 3a5f9fd2…, received 7fdfbb44…
tests/fixtures/contracts/source.owner-cutover.v1.yaml: expected b659806e…, received 248e02ec…
```

Fix the working copy, do not "fix" the fixture:

```bash
rm tests/fixtures/contracts/eliotr.normalized.v1.yaml tests/fixtures/contracts/source.owner-cutover.v1.yaml
git checkout -- tests/fixtures/contracts/
```

Never regenerate a byte-addressed fixture to make a hash match. That converts a checkout problem into a
contract change.

## 6. Branch, worktree and PR discipline

From `branch-discipline.md`, because these are the rules most often broken:

- **Ceiling: five counted non-default branches**, repository-wide. The nine reserved launch heads are
  exempt only while their own pull request is open.
- A branch with no open PR has a **24-hour TTL**, and the hourly `branch-hygiene` workflow evicts the
  oldest excess branches automatically. A branch that exists only on your disk is invisible to CI and
  protects nothing.
- **Push early.** Work that lives in one local worktree is one disk failure from gone, and its PR
  silently misrepresents the state of the theme.
- Never force-push, reset, or rewrite a pushed branch. Fix a bad commit message *before* the first
  push; afterwards you cannot.
- Incorporate current `main` by ordinary merge. Resolve conflicts, then re-run CI on the exact head.
- Delete a worktree when its task is done. Evidence belongs in commits, PRs, CI logs and named
  artifacts — never in an untracked scratch directory.

Theme PRs stay **draft** until every mandatory code acceptance item in their plan is complete. Work
reaches `main` through a separate, bounded `agent/checkpoint-<id>-integration-<date>` branch and its
own PR. Green CI on a theme draft is not permission to merge the theme.

One integrator serializes `composition-root.ts`, HTTP routes and `Env`, barrel files, package and
Cargo manifests, lockfiles, CI, generated bindings, the schema registry and migration numbers. ER-13
allocates migration numbers against current `main`; ER-00 owns the toolchain and locks; ER-21/ER-24 own
public DTOs, routes and runtime composition; ER-25 owns all PWA work; ER-27 owns `tests/integration/**`.
An unclaimed shared edit is not permission.

## 7. The four states, and what "done" means

| State | Meaning |
| --- | --- |
| `SCAFFOLD_FAIL_CLOSED` | The port exists but execution throws or returns an explicit pending response. It cannot mutate canonical state. |
| `IN_PROGRESS` | An owned packet is active. Merge still requires its negative acceptance case. |
| `IMPLEMENTED_NOT_LIVE` | Deterministic and recorded-fixture gates pass. **No platform round trip has occurred.** |
| `LIVE_QUALIFIED` | The implementation and its named live gate both have a retained receipt. |

None of these is satisfied by a mock, a local emulator, a typecheck, a dry-run, a provider's own
acceptance, a Queue `ack()`, a D1 change count or a Workflow completion. An index hit or a provider
citation stays a *locator* until authorized exact R2 bytes produce a durable `EvidenceHandle`.

## 8. Things that are never permission

- A compiling port, a final-shaped DTO or a passing typecheck is not an implemented feature.
- A green docs-only CI run is not feature completion.
- A branch name reserved in `infra/github/branch-hygiene.json` is a planning reservation, not an
  authorized parallel worktree.
- Google Workspace or `gcloud` success is an untrusted transport observation until exact readback and
  ELIOT reconciliation.
- Never invent a tenth `CompletionDisposition`. Transport completion and research completion are
  separate states, and `ENGINE_COMPLETED` is not a research disposition.
- Never rename a public field or enum, and never introduce permanent dual TypeScript/Rust authority
  for the same promoted decision.

## 9. Current state — snapshot, regenerate before trusting

Taken 2026-09-07 at `main` `c9744fa`. **This section ages; run the commands in §1 rather than
believing it.**

- Registry: 24 registered contours — 21 `IMPLEMENTED_NOT_LIVE`, 1 `IN_PROGRESS` (ER-19 Drive
  reconciler), 2 `SCAFFOLD_FAIL_CLOSED` (the public `ResearchWorkflow` and the `ResearchSession`
  Durable Object), 0 `LIVE_QUALIFIED`.
- Gap register: 0 P0, 18 P1, 5 P2.
- Landed so far: Wave 1 (K1 owner-token parity, Q1 D1 retrieval lane, G1 Google OAuth begin), K2a
  scope-snapshot identity parity, W1 durable Investigation ledger, O2 portable backup epoch, W2a
  research stage checkpoint kernel.
- Not composed as executable product: `research.run`, `research.query`, Wiki promotion, the artifact
  compiler, the ER-31 public API surface, and the production Drive cursor/OAuth path.
- Rust migration: M0–M1 complete; M2–M7 open.
- Nine launch themes are open as drafts. Check which are red before starting anything near them.
