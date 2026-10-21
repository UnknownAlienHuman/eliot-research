# Toolchain

Use the versions and commands already declared by executable repository configuration. This note is a small operator
map, not a second package manifest, Rust promotion programme or requirement to install every verification tool before
editing product code.

## Sources of truth

| Concern | Current owner |
|---|---|
| Node/pnpm and JavaScript dependencies | root `package.json` and `pnpm-lock.yaml` |
| TypeScript project graph | root/leaf `tsconfig*.json` |
| Lint rules | `eslint.config.mjs` |
| Cloudflare build and bindings | `apps/eliotr-core/package.json`, Wrangler configs and generated `worker-configuration.d.ts` |
| Rust compiler, workspace and dependency locks | `rust-toolchain.toml`, `Cargo.toml`, `Cargo.lock` |
| Deep Rust verification | `.github/workflows/rust-deep-verification.yml` and its pinned tools |

Do not copy version tables from an old audit into a new authority. When a pin changes, change its executable owner and
lockfile together; update this note only when the normal operator command changes.

## Current baseline

The root currently declares Node `>=22.13.0`, pnpm `11.23.0`, TypeScript `6.0.3`, ESLint `10.9.1`, Vite `8.2.2`,
Vitest `4.1.11` and Wrangler `4.143.1`. Rust is pinned by `rust-toolchain.toml` and Cargo files. Treat those files as
canonical if this dated summary diverges.

Astro is not the target UI. A transitive package retained solely by the old PWA disappears with that caller; do not
turn its temporary version constraint into a permanent platform requirement.

## Bootstrap

For TypeScript/Worker work:

```sh
corepack enable
corepack prepare pnpm@11.23.0 --activate
pnpm install --frozen-lockfile
```

Use an already provisioned Rust toolchain for Rust changes. Do not install nightly, fuzzing, mutation or coverage tools
for an unrelated TypeScript task. Missing optional deep-verification tools make that check unrun; they do not justify
changing product source or lockfiles.

## Task-sized checks

Follow [scoped verification](scoped-verification.md): compile and lint the changed package/files first. For Rust,
run `cargo check` and minimal Clippy for the changed crate. For D1/SQL, use the existing migration/depth tooling that
covers the changed stream. Product and browser acceptance follow assembly.

Useful existing entry points include:

```sh
pnpm typecheck
pnpm lint
pnpm d1:depth
pnpm cf:types
pnpm cf:dry-run
pnpm check:full
```

`pnpm check:full` is broad repository verification, not a prerequisite for every edit and not proof of live product
readiness. Source budgets are diagnostics; emitted/runtime limits are verified separately. Historical work-packet,
status-registry and Rust-first programmes do not expand the selected task.

## Local and deployment commands

Use [local launch](local-launch.md) for `local:prepare`, `local:dev`, `local:smoke` and `local:owner`.
Use [release and schema transitions](production-readiness-plan.md) for provisioning/deployment and data cutovers.
A build, dry-run or bootstrap never authorizes remote deployment, credential change or data mutation.

## Upgrade rule

A tool update is one caller-complete change:

1. update the actual root/leaf pins and relevant lockfiles;
2. regenerate Cloudflare binding types when their source changes;
3. run the affected compiler/linter/build checks;
4. run the product checks that exercise the upgraded tool;
5. record compatibility impact and unrun environment checks in the PR.

Do not add a second package manager, compiler, linter, test runner or deployment entrypoint merely to avoid updating
the current one. Do not preserve a tool because an archived launch packet names it.
