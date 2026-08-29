# ER-00: Workspace and verification gates

**Slice:** 0
**Depends on:** none
**Live gate:** none

## Objective

Implement this capability without redesigning neighboring contracts. The packet owns no authority
outside the paths below.

## Owned paths

- `package.json`
- `pnpm-workspace.yaml`
- `pnpm-lock.yaml`
- `tsconfig.json`
- `tsconfig.base.json`
- `eslint.config.mjs`
- `vitest.config.ts`
- `.editorconfig`
- `.npmrc`
- `.gitignore`
- `.github/**`
- `docs/implementation/toolchain.md`
- `scripts/check-boundaries.mjs`
- `scripts/check-budgets.mjs`
- `scripts/check-contract-fixtures.mjs`
- `scripts/check-work-packets.mjs`

## Read only

- `AGENTS.md`
- `docs/implementation/**`
- `docs/architecture/ELIOT_RESEARCH.md`

## Architecture extracts

- §17.2–17.4
- §19.1

## Required implementation

- Install a reproducible pnpm workspace and commit the lockfile.
- Preserve the pinned toolchain compatibility matrix; do not admit a compiler outside the linter peer range.
- Make lint, project-reference typecheck, unit tests, contract hashes, dependency boundaries, work-packet DAG, bundle budgets, generated bindings, and dry-run independently runnable.
- Keep Node-only tests separate from Workers integration tests using the Cloudflare Vitest plugin.
- Reject forbidden Worker dependencies and imports mechanically, including transitive production dependencies.

## Acceptance

- `pnpm check` runs from a clean clone.
- CI uses the committed lockfile and performs dry-run deployment without secrets.
- A package import-cycle or owned-path overlap fails before tests.

## Mandatory negative boundary

Add a forbidden import and prove the boundary check fails.

## Handoff contract

Produce:
- pnpm-lock.yaml
- green CI gate
- verification command registry

The PR must state contract/generation impact, migration/backfill impact, exact commands, negative-case
result, live receipts (or `NOT EXECUTED`), and any follow-up packet. Do not mark this packet complete
with placeholders, TODO authority paths, mocked live gates, or a stronger disposition than observed.
