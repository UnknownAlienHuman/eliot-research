# Scoped verification

Implement first. Use the existing checks for the code being changed, not a prerequisite testing programme.
[Release and schema transitions](production-readiness-plan.md) owns assembled-product acceptance.

## Edit loop

For a changed TypeScript package and its source files:

```sh
pnpm exec tsc -b packages/<package>/tsconfig.json --pretty false
pnpm exec eslint <changed-source-file-1> <changed-source-file-2>
```

The build follows declared project references; lint receives the named files. For SQL, use the installed migration
compiler (`pnpm d1:depth`). Compilation does not prove retained-row conversion or a remote migration was applied.
For a changed Rust crate:

```sh
cargo check -p <crate> --all-features --locked
cargo clippy -p <crate> --all-targets --all-features --locked -- -D warnings
```

For documentation, inspect the exact diff, local links and agreement between the manifesto and current technical
notes. Update the existing owner document rather than append another audit/status ledger.

## Behavioral verification after assembly

Run the existing relevant regression by exact path, using its owning Vitest configuration. Worker/native tests need
their Worker configuration; do not run them in a Node configuration and call that platform verification. A focused
bug reproduction during audit is allowed; state its stubs/emulator and scope, not a claimed live result.

Browser, restart, concurrency, cancellation and paid-provider acceptance follow the assembled path. Existing automatic
CI runs separately; record its actual result on the exact head. Not run, skipped and still running are not PASS.
No mandatory all-workspace Rust port, coverage/mutation campaign or independent approval queue precedes useful code.

The retained standalone Inbox verifier uses built assets and starts workerd before checking headers/browser framing:

```sh
pnpm --filter @eliotr/core exec node --test test/agent-inbox-assets-routing.test.mjs
```

Before React cutover it consumes the PWA build. Move that caller with the actual assets; do not retain Astro for a
fixture. `ELIOTR_TEST_CHROMIUM_EXECUTABLE_PATH` may select an absolute installed Chromium/Chrome executable.
This local check does not establish production Access or live edge behavior.

## Measurements and legacy commands

`pnpm budgets:check` and `node scripts/check-budgets.mjs` report source diagnostics, not runtime savings. Unknown
options and unreadable source still fail. Emitted artifacts are measured separately by `budgets:emitted` or
`budgets:emitted:check`; use the existing owner-web mode for that artifact. Retain the current 4 MiB gzip Worker and
600 KiB initial owner-web JavaScript release limits until explicitly changed. Record the actual build and unsupported
measurements; do not satisfy a size limit by moving code into another package or excluding it from measurement.

`check:affected` currently warns and delegates to `check:full`; it does not select affected files. The existing full
chain still includes status-registry and broad Rust obligations pending the tooling replacement. It is an available
command, not the selected definition of product readiness or a required loop for every edit. Remove obsolete callers
with their retired checks; do not replace them by success stubs or silence real failures.

Measure first visible text, final save, dependency calls, cost and reconnect behavior for the selected journey.
A configured binding, global schema marker, green CI, local dry-run or completed Workflow is not proof of that journey.
