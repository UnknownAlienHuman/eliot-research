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

## Full repository and release checks

After assembly, run the explicit full repository chain:

```sh
pnpm check:full
```

This runs the unchanged `pnpm check` chain, including repository checks, tests, and `pnpm rust:check`. It is
not affected-file selection and does not replace the manual S92–S97 release acceptance in
[`START-HERE.md`](../START-HERE.md).
