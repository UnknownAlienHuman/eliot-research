# Start here

This is the only entry point for implementation work. It is intentionally short.

- Current state and execution order: [backend-delivery-plan.md](implementation/backend-delivery-plan.md).
- Original S01–S99 requirements: [PR #292](https://github.com/UnknownAlienHuman/eliot-research/pull/292).
- Repository boundaries: [AGENTS.md](../AGENTS.md).
- Ownership: [agent-work/README.md](agent-work/README.md) and [manifest.json](agent-work/manifest.json).

Open planning PRs, old Launch documents and historical audits are evidence, not competing queues.

## 1. Orient before editing

Run from the repository root:

```bash
git fetch origin --prune
git log --oneline -5 origin/main
git status --short
pnpm launch:code
pnpm work-packets:check
pnpm check:implementation-status
gh pr view 292
gh pr view 229 --comments
```

Then read, in this order:

1. the **Current active checkpoint** in `backend-delivery-plan.md`;
2. the latest comment on its GitHub task;
3. `AGENTS.md`;
4. only the owning work packet and the architecture sections named by that packet.

Do not infer current work from an old PR body, branch name, open-PR count, historical audit percentage or a local uncommitted patch. `origin/main` plus the current task discussion is the source of truth.

## 2. Claim one checkpoint

Before editing, post a short claim in the active task:

```text
Baseline: <exact origin/main SHA>
Checkpoint: <one bounded result>
Owned files: <exact paths>
Exit: <compile/lint/static conditions>
Deferred: <behavioral/native/live acceptance not run>
```

Rules:

- work directly on `main`; no task branch or additional worktree;
- one agent owns one checkpoint at a time;
- edit only owned paths; shared manifests, migrations, barrels, CI and composition files require the named integrator ownership;
- if `origin/main` moved after the claim, reconcile before publication; never force-push;
- finish or explicitly hand off before claiming another checkpoint.

## 3. Implement the product, not a parallel stack

The current owner-directed phase is **code first**:

- TypeScript: compile and run scoped ESLint;
- SQL: also run the installed depth-100 compiler;
- Rust: run compilation and minimal Clippy for the changed crate;
- broad unit/browser/native/mutation/live suites run after product-code assembly unless the active task explicitly requires a narrow reproduction.

Keep every final acceptance criterion, but mark unexecuted checks `PENDING`, never `PASS`.

Reuse existing contracts, stores, Workflow stages and authority readers. A missing composition path is not permission to add another engine. Every mutation retains:

```text
Intent → Attempt → Receipt → Readback → Reconciliation
```

Never make model, HTTP or R2 calls inside a D1 transaction. A lost acknowledgement is `UNKNOWN`, not permission to mint another identity or repeat a possibly paid effect.

## 4. Publish a checkpoint safely

A checkpoint must be coherent and reviewable. Prefer a small source set, but do not split an invariant across commits merely to reduce file count.

Before publication:

```bash
git fetch origin --prune
git diff --check
```

Use normal authenticated Git or the authorized GitHub Git Data API. Update `main` only as a non-forced fast-forward from the refreshed expected head.

After publication:

1. read `refs/heads/main` again;
2. fetch the published commit and verify its file list;
3. comment on the active task with the exact SHA, commands/results and remaining work;
4. update `backend-delivery-plan.md` when the active checkpoint or queue changed.

A local manifest, prepared patch or unattached blob is not published work.

## 5. Authority map

| Need | Read |
|---|---|
| Current checkpoint and queue | [backend-delivery-plan.md](implementation/backend-delivery-plan.md) |
| Complete original task criteria | [PR #292](https://github.com/UnknownAlienHuman/eliot-research/pull/292) and the selected S task |
| Product/state authority | [ELIOT_RESEARCH.md](architecture/ELIOT_RESEARCH.md), only named sections |
| TypeScript/Rust/SQL ownership | [LANGUAGE_RUNTIME_CONTRACT.md](architecture/LANGUAGE_RUNTIME_CONTRACT.md), amended by [ADR-0007](adr/0007-external-agents-and-cloudflare-evolution.md) |
| Muse, Cloudflare evolution and external QA | [ADR-0007](adr/0007-external-agents-and-cloudflare-evolution.md) and [operator runbook](implementation/muse-operator-runbook.md); not a replacement queue |
| File ownership | [agent-work/README.md](agent-work/README.md) and [manifest.json](agent-work/manifest.json) |
| Implemented vs scaffold vs live | [implementation-status.json](implementation/implementation-status.json) |
| Known product gaps | [gap-register.md](implementation/gap-register.md) |
| Failure/retry semantics | [failure-model.md](implementation/failure-model.md) |
| Security, disclosure and erasure | [security-checklist.md](implementation/security-checklist.md) |
| Branch/publication rules | [branch-discipline.md](implementation/branch-discipline.md) |
| Pinned tools | [toolchain.md](implementation/toolchain.md) |

If a packet conflicts with architecture, stop and name the exact conflict. Do not resolve it with a leaf-specific schema or hidden exception.

## 6. CI and final acceptance

GitHub Actions are currently manual-only. Do not restore automatic triggers or dispatch broad workflows without owner authorization.

After code assembly, execute acceptance in this order:

1. S92 local integration;
2. S94 staging;
3. S93 quality, S95 native/security/restore/client conformance and S96 workload/cost on the attested build;
4. S97 release acceptance.

Compilation, a green docs check, a local emulator, a Workflow completion or provider acceptance alone does not establish production readiness or `LIVE_QUALIFIED`.

## 7. Never treat these as permission

- age, count or closure of branches;
- a stale planning head;
- an audit estimate;
- a configured client ID without verified possession;
- an index hit without exact authorized evidence bytes;
- optional managed OAuth or unselected Slice 7 as a baseline blocker;
- missing local Git credentials as proof that GitHub write access is unavailable.
