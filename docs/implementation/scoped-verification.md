# Scoped verification

`pnpm check:affected` is deprecated. It prints a warning and delegates to `pnpm check:full`; it never
selects checks from changed files or packages. `pnpm check:full` is the explicit name for the existing
complete repository check, and `pnpm check` remains its original entry point. No affected-dependency
selector is implemented.

## Code-first edit loop

Run compile and lint checks against the changed package and source files. For a TypeScript project, use:

```sh
pnpm exec tsc -b packages/<package>/tsconfig.json --pretty false
pnpm exec eslint <changed-source-file-1> <changed-source-file-2>
```

The TypeScript build follows that project's declared references. ESLint receives only the named files.
For example, the existing Cloudflare Backup package can be checked with:

```sh
pnpm --filter @eliotr/cloudflare-backup typecheck
pnpm exec eslint packages/cloudflare-backup/src/restore-executor.ts
```

For SQL changes, run the installed cross-migration compiler:

```sh
pnpm d1:depth
```

For a changed Rust crate, compile and lint that crate with:

```sh
cargo check -p <crate> --all-features --locked
cargo clippy -p <crate> --all-targets --all-features --locked -- -D warnings
```

Run a focused regression only when the active task requires it, using the exact test path:

```sh
pnpm exec vitest run <exact-test-path>
```

Broad behavioral, browser, native, mutation, and live acceptance stays pending until product-code assembly
unless the task explicitly calls for a narrow reproduction.

The existing inbox outer-Assets verifier uses the built PWA output and starts
Wrangler/workerd before checking real response headers and browser framing:

```sh
pnpm --filter @eliotr/core exec node --test test/agent-inbox-assets-routing.test.mjs
```

Use an existing PWA build, or run `pnpm build:pwa` when its source has changed.
Playwright uses its default browser discovery unless
`ELIOTR_TEST_CHROMIUM_EXECUTABLE_PATH` names an absolute existing Chromium/Chrome
executable. The override selects the installed executable without installing a
browser. This local verifier does not establish authenticated production flows
or live edge readback.

## Source diagnostics and emitted budgets

`pnpm budgets:check` and the bare `node scripts/check-budgets.mjs` entry point report source-line and
source-byte observations as advisory diagnostics. The existing `--source` option has the same semantics.
Unknown options, unreadable source and scanner failures still fail. Inventory and diagnostic thresholds
are unchanged, including colocated tests; formatting or source relocation cannot establish runtime savings.
The existing isolated source-budget regression is
`node scripts/test-boundary-negative.mjs --source-budgets`; it runs the actual checker through both CLI
entries and verifies LF/CRLF, Unicode byte counts and preserved scanner/argument failures.

`pnpm budgets:emitted` and `pnpm budgets:emitted:check` inspect emitted evidence separately. The existing
owner-web mode is `node scripts/check-emitted-budgets.mjs --owner-web` (add `--check-only` for retained
receipt validation). Worker ≤4 MiB gzip and initial owner-web JavaScript ≤600 KiB gzip remain release
limits. Missing/stale artifacts, incomplete startup observations and unsupported native measurements do
not establish readiness. Startup/CPU/heap/workload acceptance remains S96 on the attested build; request,
reader, SQL and model security limits are unaffected.

## Full repository and release checks

After assembly, run the explicit full repository chain:

```sh
pnpm check:full
```

This runs the unchanged `pnpm check` chain, including repository checks, tests, and `pnpm rust:check`. It is
not affected-file selection and does not replace the manual S92–S97 release acceptance in
[`START-HERE.md`](../START-HERE.md).
