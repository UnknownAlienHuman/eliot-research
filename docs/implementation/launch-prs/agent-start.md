# Start a manager on a launch checkpoint

New to the repository? Read [`docs/START-HERE.md`](../../START-HERE.md) first. For backend work, the
current queue and role routes are in [`backend-entrypoints.md`](../backend-entrypoints.md).

This file covers only the manager launch procedure. It does not create a new queue and does not replace
the active PR/passport, ER ownership or product architecture.

## 1. Select a dependency-ready checkpoint

Use the current role router and final PR matrix, not an old numbered wave:

```bash
git fetch origin --prune
git log --oneline -5 origin/main
pnpm work-packets:check
pnpm check:implementation-status
```

Then read:

1. [`backend-entrypoints.md`](../backend-entrypoints.md);
2. the assigned PR/passport;
3. the owning ER packet and exact `owned_paths`;
4. only the named contracts and architecture sections.

A documentation-only passport is not implemented code. A source patch without repository-pinned gates
is not integrated. A blocked shared task never authorizes a stub or parallel engine.

## 2. Create one manager worktree

Each manager gets exactly one worktree and one checkpoint at a time. Subagents do not create their own
worktrees.

```bash
git fetch origin --prune
git worktree add ../eliot-research-mgr-<manager> \
  -b manager/<manager>/<pr>-<slug> origin/main
cd ../eliot-research-mgr-<manager>
git status --short
git log --oneline -5
```

If the manager already has a worktree, reuse or finish it. Do not create a second one.

## 3. Post the claim before editing

```text
Baseline: <exact origin/main SHA>
Manager/worktree: <manager ID and branch>
Checkpoint: <PR/checkpoint ID and one bounded result>
Owner: <ER packet>
Owned files: <exact paths>
Shared files: <none, or named integrator handoff>
Inputs: <accepted predecessor SHAs/artifacts>
Build gate: <compile/scoped lint; minimal Clippy for Rust>
Narrow reproduction: <named case or NONE>
Deferred: <focused/full/native/live acceptance still PENDING>
No account changes: true
```

Read other active claims before writing. Shared contracts, migrations, composition, barrels, manifests,
lockfiles, generated bindings and CI belong to one named integrator.

## 4. Implement and hand off

The current phase is code first:

- TypeScript: compile and scoped ESLint;
- Rust: compile and minimal Clippy;
- SQL: installed D1 depth/target compiler;
- run the narrow reproduction required by the active PR;
- defer broad suites/native/live acceptance until assembled product code unless explicitly required.

At handoff record:

```text
Exact commit SHA
Changed paths
Migrated callers
Deleted/retired duplicate functions or branches
Legacy codec/persisted-identity impact
Net production LOC/bundle delta
D1/R2/provider-call delta
Commands and exit codes
Negative/replay/lost-ACK/bound evidence
PENDING gates and downstream owner
```

A wrapper over two unchanged implementations is not completion.

## 5. Reconcile and publish safely

Before handoff:

```bash
git fetch origin --prune
git diff --check
```

Never force-push over concurrent work. Reconcile the refreshed expected head. The named integrator
compares the exact file list, rejects stale historical-tree contamination, runs the required build gate,
publishes without rewriting history and reads the resulting ref back.

## 6. Do not use these as launch authority

- an old first-wave list in a dated launch document;
- branch age/count or a closed PR;
- a historical audit percentage;
- a local unattached patch/blob;
- a provider 200 response;
- optional Google/federation/Rust/UI work as a core blocker unless the active PR names it;
- missing local Git credentials as proof that GitHub write access is unavailable.
