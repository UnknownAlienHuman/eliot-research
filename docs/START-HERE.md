# Start here

The single entry point for an agent joining Eliot Research. Read this file to the end before opening
anything else. It should take five minutes and it replaces guessing.

**Design rule for this file:** it records what does *not* age — read order, authority, procedure,
gates, discipline. Anything that ages (which checkpoint is next, what is merged, what is red) is
*derived by running a command*, never copied here. A previous entry document hardcoded a "first wave"
of three tasks; all three were completed and the document kept telling new agents to start them.
Do not reintroduce that pattern.

## Current work entry

Use [backend-delivery-plan.md](implementation/backend-delivery-plan.md) for the current ordered queue
and [#292](https://github.com/UnknownAlienHuman/eliot-research/pull/292) for the original S01–S99 contracts.
Launch theme PRs are historical traceability umbrellas, not a second queue. The owner's current
code-delivery phase in that plan takes precedence over the test-first/full-suite-per-push procedure
below; final acceptance requirements remain unchanged. Do not assume an unnamed local agent runs them.

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
- `check:implementation-status` prints the exact contour census by state. **`LIVE_QUALIFIED: 0` means no contour has complete registered live-qualification evidence.**
  It does not erase limited, dated live observations. Distinguish recorded historical observations
  from current deployment evidence and do not claim complete qualification from either alone.

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

1. Follow the earliest dependency-ready code item in [backend-delivery-plan.md](implementation/backend-delivery-plan.md),
   then read its original S passport through #292 and its owned packet in [agent-work/README.md](agent-work/README.md).
   Use [launch-prs/README.md](implementation/launch-prs/README.md) for legacy obligation mapping, not a duplicate queue.
2. Confirm nobody else holds it: check the theme PR for an existing claim comment and check
   `git worktree list` and open PRs.
3. Post the claim block from [agent-start.md](implementation/launch-prs/agent-start.md) in the theme PR **before** editing.
4. Edit only your packet's `owned_paths`. If you need a file you do not own, that is a handoff, not
   permission.

One agent holds one packet/checkpoint at a time. Work directly on `main`, with no additional
worktrees or task branches, under the owner's instruction. Finish or explicitly hand off before taking another.

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

[CI](../.github/workflows/ci.yml) is currently manual-only (`workflow_dispatch`); code checkpoints
must not re-enable push/PR triggers or dispatch the assembled-product suites without authorization.
`verify` is the mandatory aggregate: every dependency must succeed, including both source-budget OS
jobs. Failed, cancelled or skipped jobs cannot turn it green. It retains the existing check name.

`source-budgets` and `d1-expression-depth` run independently on Ubuntu/Windows. `root-tests` uses
`pnpm test:root:list` for non-executing discovery and `pnpm test:root` for the complete root Vitest
configuration, with no directory allowlist and no success on zero selected tests. `verify-checks`
runs privacy, contracts, boundaries, ownership, authority fixtures, lint, typecheck, provisioners,
`pnpm test:worker`, registry checks, PWA build/browser checks, local preparation, binding generation
and the deployment dry-run. Independent steps require setup success, not unrelated gate success;
browser and dry-run steps still require their actual build/preparation prerequisites.

The `research-screen`, `local-launch`, `research-semantic` and `d1-mutations` Ubuntu/Windows matrices,
plus `rust` and `windows-tooling`, remain. The d1-mutations matrix intentionally repeats root
`query-persistence.test.ts` on both OSes; it is a focused cross-platform regression, not another
complete root suite. Worker tests retain their own Cloudflare configuration; federation is included
by the root configuration, and its existing package command retains root semantics.

Local `pnpm test` selects provisioners, the same complete root suite and the separate Worker suite.
`pnpm check:affected` aliases the full `pnpm check`; it is not base-aware or a changed-file selector.
These local aggregate commands remain fail-fast. A failed command leaves later checks unexecuted,
not passed; CI's independent reporting does not change that local result. Record exact SHA,
commands and exit codes in the task discussion. Code-first versus final acceptance remains defined
by the [delivery plan](implementation/backend-delivery-plan.md).

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

- Work directly on `main`; do not create implementation branches or additional worktrees.
- There is no numeric branch ceiling, age-based eviction, or named reservation list.
- Preserve default/protected branches and all open PR heads. Closed-but-unmerged work is not disposable.
- Cleanup requires exact-head ancestry in the current default branch, refreshed protection/PR checks,
  and an expected-SHA conditional deletion. A changed head must survive.
- Never rewrite pushed history. Publish bounded, tested commits; reconcile a concurrent main advance
  before publication instead of forcing the reference.
- Record results in the existing theme PR and commits. A planning PR is not evidence of implemented code.

Theme PRs stay **draft** until every mandatory code acceptance item in their plan is complete.
Do not merge stale theme heads or close them for docs-only CI. Record each direct-main checkpoint's
exact commit, tests and remaining acceptance separately.

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
| `IMPLEMENTED_NOT_LIVE` | Deterministic and recorded-fixture gates pass. **This state does not establish complete live qualification.** |
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

## 9. What actually blocks the product — ask the repository, not a document

The first version of this section carried a dated snapshot of the registry counts. It was stale
within four hours, which is exactly the failure this file warns about in its header. The counts are
not repeated here. Get them from the source:

```bash
pnpm launch:code                    # what stops this being deployable, by name
pnpm check:implementation-status    # contour census by state
gh pr list --state open             # which themes are red or conflicted
```

**`pnpm launch:code` is the one to run first.** It exits non-zero with `LIVE_DEPLOY_BLOCKED` followed
by the exact list of disabled required slices, uncomposed public routes and named blockers. That list
is the code-composition backlog. It does not replace the known-defect queue or establish runtime
correctness: a composed route can still fail SQL compilation or violate its behavioral contract.

Two things are worth understanding before you read that list:

- **An implemented contour is not a working route.** A stage executor can be finished, registered and
  green while the public route that would call it is still not composed, so the slice stays disabled.
  `implementation-status.json` tells you the first; `launch:code` tells you the second.
- **`LIVE_QUALIFIED` records complete contour qualification, not code quality or every limited live observation.**
  A zero count does not erase dated owner-loop receipts; neither those receipts nor green local gates
  prove the current build/profile is fully live-qualified.

Deterministic work — test strength, mutation coverage, parity vectors — is real engineering, but it
does not shorten the `launch:code` list. Do it when it blocks a product path, or when that list is
empty.
