# Toolchain contract

This file is the implementation authority for repository bootstrap. Leaf agents must not upgrade or
replace these tools inside their packets. Toolchain changes belong to **ER-00** and require a regenerated
lockfile plus all repository gates.

## Pinned baseline

| Tool | Version / minimum | Reason |
|---|---:|---|
| Node.js | `>=22.13.0` | Satisfies the runtime floor of the pinned ESLint 10 release. |
| pnpm | `11.23.0` | Workspace and lockfile owner. |
| TypeScript | `6.0.3` | Latest compiler line accepted by the pinned `typescript-eslint` peer range. |
| typescript-eslint | `8.68.0` | Flat-config TypeScript lint integration. |
| ESLint | `10.9.1` | Repository lint engine. |
| @eslint/js | `10.0.1` | Published flat JavaScript config package. It has an independent published-version line from the ESLint CLI package. |
| Wrangler | `4.127.1` | Worker build, generated binding types, dry-run, migrations and deploy. |
| @cloudflare/vitest-plugin | `1.1.0` | Workers runtime integration tests. Do not restore the retired pool package. |
| @cloudflare/workers-types | `5.20260827.1` | Compile-time Worker API declarations. Generated binding types remain authoritative for `Env`. |
| Vite | `8.2.2` | PWA build. |
| Vitest | `4.1.10` | Node and browser-independent unit harness. |
| Zod | `4.4.3` | Strict wire validation; load-bearing objects use `.strict()`. |

TypeScript 7 is intentionally **not** admitted yet. The pinned `typescript-eslint` release declares a
TypeScript peer range below 6.1; choosing TypeScript 7 would make the initial workspace dependency graph
unsupported before any product code runs. ER-00 may raise the compiler only after the linter supports it
and the generated lockfile, lint, typecheck and Worker tests pass together.

## First bootstrap

```bash
corepack enable
corepack prepare pnpm@11.23.0 --activate
pnpm install --no-frozen-lockfile
pnpm cf:types
pnpm check
pnpm cf:dry-run
git add pnpm-lock.yaml apps/eliotr-core/src/worker-configuration.d.ts
```

The repository scaffold does not claim a reproducible install until **ER-00** creates and commits
`pnpm-lock.yaml`. After that first bootstrap, CI and every other agent must use:

```bash
pnpm install --frozen-lockfile
```

## Upgrade rule

A toolchain update is one atomic ER-00 change:

1. change root/leaf pins together;
2. regenerate `pnpm-lock.yaml`;
3. regenerate Wrangler binding types;
4. run contract, boundary, budget and work-packet checks;
5. run lint, project-reference typecheck, unit and Workers integration tests;
6. run the minified Wrangler dry-run and bundle-budget gate;
7. record exact versions and any generation impact in the PR.

No leaf packet may add a second compiler, linter, test runner, package manager or Cloudflare deployment
entrypoint.
