# Saved local work — 2026-09-10

The owner requested a quota-end push, then a second audit of local leftovers and cleanup.
This directory preserves unfinished work as **inactive recovery artifacts**, not accepted runtime
implementation. No snapshot here is compiled, deployed, or evidence of feature completion.
The product remains incomplete; continue from the [gap register](../../gap-register.md).

## Verified delivery baseline

Before this documentation checkpoint, local `main`, `origin/main`, and the live GitHub
`refs/heads/main` all resolved to `4d2f7d074b6d87e65e9a77ec35261a84abb7e16a`.
The canonical working tree was clean and the shared stash was empty. Four agent worktrees remained;
three initially contained uncommitted source changes. The owner subsequently required every change
to be committed and pushed; the resulting commits are recorded below.

## All local changes committed

The eight previously uncommitted files were committed exactly as found, without further source edits.
All four agent branch heads and the documentation update on `main` are published together. The exact
WIP histories also have annotated checkpoint tags, so branch-hygiene expiry cannot discard them.

| Work | GitHub branch | Commit | Checkpoint tag |
|---|---|---|---|
| Coverage codec | `agent/er36-workspace-candidate-ledger-20260909` | `1abf2fa09ee78c3daa8bb0073b42630e1cb00e8c` | `checkpoint/20260910-coverage-wip` |
| Synthesis validation helpers | `quarantine/synthesis-helpers-20260910` | `874a96de7bd7491b066d830f49b759f1ff3a66c9` | `checkpoint/20260910-synthesis-wip` |
| Legacy Drive provisioning | `agent/er18-google-provisioning-20260909` | `f9443ee8c87b891583d0c93149aa26e7ecb1fad5` | `checkpoint/20260910-legacy-drive-wip` |
| Citation stage15 | `agent/er24-library-active-readiness-20260909` | `df9f814131c3cb7e033f0b56c362bea030242c8c` | `checkpoint/20260910-stage15-wip` |

These are WIP commits, not runtime acceptance. The inactive recovery snapshots remain in `main`.
No tests were rerun for merely committing existing source; product limitations below still apply.
Branch hygiene removed the old synthesis branch name because its previous PR was closed
(`CLOSED_PULL_REQUEST`, run34536533542). The same commit is republished under the quarantine name
above; no history was rewritten and its checkpoint tag remained available throughout.

## Recoverable unfinished source

| Artifact | Source / base | Status |
|---|---|---|
| [stage15-citations-wip.patch](stage15-citations-wip.patch) | Commit `df9f814131c3cb7e033f0b56c362bea030242c8c`, based on `9e6cc4154e2f501bb0a0129a063faa4c94e93730`; branch `agent/er24-library-active-readiness-20260909` | Two new citation result/handler files; lint checked previously, runtime unverified. |
| [research-committed-lineage.ts.txt](research-committed-lineage.ts.txt) | Same stage15 branch | Historical dependency needed to understand the WIP; stale W2 imports must be reconciled with the current shared workflow package before integration. |
| [synthesis-candidate-wip.patch](synthesis-candidate-wip.patch) | Change against `c20797a82714b43abbf34b93699c9a2676f03b6d`, now committed at `874a96d` | Shared v2 span/Unicode and citation-union helpers; no post-edit validation. |
| [research-coverage-result.ts.txt](research-coverage-result.ts.txt) | File added on `933f6bafa86097b925ac2c4f9f585e5df245493e`, now committed at `1abf2fa` | Byte-for-byte stage16 codec snapshot; handler and runtime proof absent. |
| [legacy-drive-provisioning-wip.patch](legacy-drive-provisioning-wip.patch) | Six-file change against `b36dad025f2dcc9d18783aa1fff9d19bbe86c5e4`, now committed at `f9443ee` | Preserved older server-owned Drive Exchange work. This is not the selected Spark/Antigravity MCP profile and does not authorize Google Cloud work. |

Patches were written directly by Git with full blob indexes; the coverage file was copied as bytes.
The local `.gitattributes` prevents newline conversion of recovery artifacts. `git apply --numstat`
parsed all three patches, and the stage15 patch passed `git apply --check` against the delivery
baseline. These checks establish recoverability, not correctness of the unfinished implementation.
Original source bytes remain unchanged. Recover into a separate worktree based on the named source
commit, then merge current `main` and review; do not apply every historical patch blindly to main.

The four base histories are also preserved on GitHub by annotated recovery tags:

- `checkpoint/20260910-stage15-wip` → `df9f814131c3cb7e033f0b56c362bea030242c8c`
- `checkpoint/20260910-coverage-base` → `933f6bafa86097b925ac2c4f9f585e5df245493e`
- `checkpoint/20260910-synthesis-base` → `c20797a82714b43abbf34b93699c9a2676f03b6d`
- `checkpoint/20260910-legacy-drive-base` → `b36dad025f2dcc9d18783aa1fff9d19bbe86c5e4`

These preserve older committed changes as well as the exact bases of the dirty-file snapshots.
They are not release tags. The legacy Drive provisioning commits are intentionally not integrated
into the selected MCP runtime. Existing draft PRs remain open; their unfinished plans and source are
not garbage. Many other local commit IDs differ because the same code was integrated and amended.

## Cleanup scope

Only agent-created scratch files, generated protocol schemas and downloaded Workers type references
in the parent workspace are cleanup candidates. Their local archive includes exact relative paths,
lengths and SHA-256 checksums, with every ZIP member verified before loose originals are removed.
The local archive is deliberately not committed: historical diagnostic logs may contain account or
session metadata. Tool runtimes, dependencies, local database/authentication state, user configuration,
Git history, open draft PRs, and incomplete worktrees are retained.

Completed cleanup: 886 files totaling 99,577,592 bytes were archived to
`../.codex-archive/research-scratch-2026-09-10.zip` relative to the repository, then removed from their
scratch locations. The archive is 9,205,913 bytes; SHA-256:
`167FAE82D7FC4FC1CF0A3F64BCC250D24F868EE8AE5574F3A02CC4FE7A2CEFDF`.
Its adjacent manifest records all 886 paths and individual checksums. This includes the two stray
verification source files under the parent `packages/` directory: a separate Luna audit confirmed
they are superseded by tracked code. Stale patch backups and the old synthesis fixture were also
confirmed integrated or superseded before archival. A newly downloaded CI log was moved into the
same archive directory separately. No source worktree, dependency installation or local database was
deleted.

## CI limitation at the delivery baseline

[CI run 34534923253](https://github.com/UnknownAlienHuman/eliot-research/actions/runs/34534923253)
for `4d2f7d0` failed both `verify` and `windows-tooling` at **Verify source budgets**:
`packages/cloudflare-research` has 10,073 source lines against a 10,000 limit. Rust and Ubuntu local
launch passed; Windows local launch was still running at inspection. This recovery-only checkpoint
does not change application source or repair that known failure. Documentation index, ownership
manifest and snapshot integrity checks are separate from product acceptance.

This checkpoint does not claim that every draft PR or unique historical patch is merged. Patch-ID
differences alone cannot distinguish missing implementation from integrated-and-amended work.
