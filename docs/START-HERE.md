# Start here

This is the only repository entry point. Choose the route that matches the work; do not read the
entire documentation tree or infer the active queue from old PRs.

## 1. Choose your route

| You are doing | First document | Next authority |
|---|---|---|
| Backend implementation | [backend-entrypoints.md](implementation/backend-entrypoints.md) | Active PR/passport, owning ER packet, named architecture sections |
| Backend shared integration | [backend-entrypoints.md](implementation/backend-entrypoints.md) §4 | [final PR matrix](../.github/audits/2026-10-08/FINAL-PR-DISPOSITION-MATRIX.md) |
| Backend review | [backend-entrypoints.md](implementation/backend-entrypoints.md) §5 | PR acceptance list and exact changed callers/removals |
| Owner web/UI replacement | [PR #329](https://github.com/UnknownAlienHuman/eliot-research/pull/329) | ER-47/ER-48 and UI-owned documents |
| Platform operation or release | [production-readiness-plan.md](implementation/production-readiness-plan.md) | Runbook/checklist for the exact accepted build |
| Understanding current implementation state | [implementation-status.json](implementation/implementation-status.json) and [gap-register.md](implementation/gap-register.md) | Current code and retained receipts |
| Understanding product authority | [ELIOT_RESEARCH.md](architecture/ELIOT_RESEARCH.md), only the named section | Accepted ADRs and language/runtime contract |
| Looking up work-packet file ownership | [agent-work/README.md](agent-work/README.md) and [manifest.json](agent-work/manifest.json) | Exact packet and additive fragment |
| Reviewing historical/audit work | [audit completion marker](../.github/audits/2026-10-08/BACKEND-AUDIT-PREPARATION-COMPLETE.md) | Matrix, preservation reconciliation and dated evidence |

The backend audit and implementation preparation are complete. That marker means the queue and
ownership graph are bounded; it does **not** mean product implementation, tests, native Cloudflare
qualification, deployment or release are complete.

The former [`backend-delivery-plan.md`](implementation/backend-delivery-plan.md) records the paused
October 6 source checkpoint. It is historical evidence, not the current implementation queue.

## 2. Authority order

When documents disagree, use this order:

1. current `origin/main` code and installed schemas;
2. the active PR/passport and accepted predecessor SHAs;
3. [backend-entrypoints.md](implementation/backend-entrypoints.md) and the final PR matrix;
4. owning work packet and manifest paths;
5. normative architecture, language/runtime contract and accepted ADRs;
6. dated audits, old launch plans and closed PRs as historical evidence only.

Do not resolve a shared-contract conflict by inventing a leaf-local schema, registry, retry engine or
compatibility exception.

## 3. Orient before editing

From the repository root:

```bash
git fetch origin --prune
git log --oneline -5 origin/main
git status --short
pnpm launch:code
pnpm work-packets:check
pnpm check:implementation-status
```

Then read only:

1. the assigned PR/passport;
2. [backend-entrypoints.md](implementation/backend-entrypoints.md);
3. `AGENTS.md`;
4. the owning work packet;
5. the exact neighboring contracts and architecture sections named by that packet.

Do not infer current work from branch age, open-PR count, an old PR body, a historical audit percentage
or a local uncommitted patch.

## 4. Manager/worktree discipline

The current implementation model is **one worktree per manager**. A manager owns one bounded checkpoint
at a time. Subagents do not create extra worktrees; they operate inside the manager worktree under
disjoint path ownership or remain read-only.

Example:

```bash
git fetch origin --prune
git worktree add ../eliot-research-mgr-<manager> \
  -b manager/<manager>/<pr>-<slug> origin/main
```

Before editing, record in the active PR:

```text
Baseline: <exact origin/main SHA>
Manager/worktree: <manager ID and branch>
Checkpoint: <one bounded result>
Owned files: <exact paths>
Shared files: <none, or named integrator handoff>
Dependencies: <accepted predecessor SHAs or PENDING>
Build gate: <compile/scoped lint; minimal Clippy for Rust>
Deferred: <focused/full/native/live checks not executed>
```

One named integrator serializes shared contracts, composition roots, public routes, migrations,
manifests, barrels, lockfiles, generated bindings and CI. Never force-push over another manager.

## 5. Code-first implementation phase

During assembly:

- TypeScript: compile and run scoped ESLint;
- Rust: compile and run minimal Clippy for the changed crate;
- SQL: run the installed D1 depth/target compiler when SQL changes;
- execute a narrow reproduction only when the active PR requires it;
- run broad unit/browser/native/mutation/live suites after assembled product code is ready.

Use [scoped-verification.md](implementation/scoped-verification.md) for command templates. Mark every
unexecuted gate `PENDING`, never `PASS`.

Reuse existing contracts, stores, Workflow stages and authority readers. A missing composition path is
not permission to add another engine. Every mutation retains:

```text
Intent → Attempt → Receipt → Readback → Reconciliation
```

Never make model, HTTP or R2 calls inside a D1 transaction. A lost acknowledgement is `UNKNOWN`, not
permission to mint another identity or repeat a possibly paid effect.

## 6. Publish and integrate safely

Before publication:

```bash
git fetch origin --prune
git diff --check
```

The manager refreshes the expected base and records the exact commit. The integrator compares the full
file list, checks that no historical branch contents leaked into the change, runs the required scoped
build gate, and publishes without rewriting history.

After publication:

1. read the resulting ref back;
2. verify the exact changed-file list;
3. record SHA, commands, results and pending gates in the PR;
4. update the execution router only when dependency order or ownership changed.

A local patch, unattached blob, source-only proposal or successful provider response is not published
or accepted product work.

## 7. Essential maps

| Need | Read |
|---|---|
| Current backend wave and role entry points | [backend-entrypoints.md](implementation/backend-entrypoints.md) |
| Full PR disposition/dependency graph | [FINAL-PR-DISPOSITION-MATRIX.md](../.github/audits/2026-10-08/FINAL-PR-DISPOSITION-MATRIX.md) |
| Cloudflare versus Eliot ownership | [CLOUDFLARE-NATIVE-OWNERSHIP.md](../.github/audits/2026-10-08/CLOUDFLARE-NATIVE-OWNERSHIP.md) |
| Product/state authority | [ELIOT_RESEARCH.md](architecture/ELIOT_RESEARCH.md), only named sections |
| TypeScript/Rust/SQL ownership | [LANGUAGE_RUNTIME_CONTRACT.md](architecture/LANGUAGE_RUNTIME_CONTRACT.md) and accepted ADRs |
| File ownership | [agent-work/README.md](agent-work/README.md) and [manifest.json](agent-work/manifest.json) |
| Implemented vs scaffold vs live | [implementation-status.json](implementation/implementation-status.json) |
| Known product gaps | [gap-register.md](implementation/gap-register.md) |
| Failure/retry semantics | [failure-model.md](implementation/failure-model.md) |
| Security/disclosure/erasure | [security-checklist.md](implementation/security-checklist.md) |
| Manager branches/worktrees | [branch-discipline.md](implementation/branch-discipline.md) |
| Pinned tools | [toolchain.md](implementation/toolchain.md) |

## 8. Release acceptance remains separate

GitHub Actions are manual-only. Do not dispatch broad workflows or mutate remote Cloudflare/Google
resources without explicit owner authorization.

After code assembly, acceptance remains ordered:

1. local integration and exact D1 authority;
2. attested staging build/bindings/schema/assets;
3. native/security/restore/client conformance and Golden quality;
4. workload/latency/cost;
5. final release acceptance.

Compilation, a green docs check, a local emulator, Workflow completion or provider acceptance alone
does not establish production readiness or `LIVE_QUALIFIED`.

## 9. Never treat these as permission

- age, count or closure of branches;
- a stale planning head or old audit;
- a configured client ID without verified possession;
- an index hit without exact authorized evidence bytes;
- retryability as permission to repeat an unknown paid effect;
- optional Google/federation/Rust/UI work as a deterministic-core blocker unless the active PR names it;
- missing local Git credentials as proof that GitHub write access is unavailable.
