# Isolated local application

Current operator contract for local development. Historical production run IDs, provider-proof expiries and browser
acceptance diaries are not local-launch instructions; Git history retains them.

## Commands

After the task-sized bootstrap from [toolchain](toolchain.md):

```sh
pnpm local:prepare
pnpm local:dev
```

`local:prepare` builds current served assets, creates an ignored local profile and applies committed Core/Search D1
migrations to isolated local state. `local:dev` prepares idempotently and starts the one Worker on loopback. It must
not import production D1/R2 state, remote credentials, parent dotenv files or environment selectors.

Run the disposable smoke only when the assembled local path is relevant:

```sh
pnpm local:smoke
```

It checks current boot, migration ledgers, local persistence, served assets and authentication denial. It is not an
authenticated owner journey, model qualification, search qualification or production deployment receipt.

## Owner browser session

Use:

```sh
pnpm local:owner
```

The launcher uses the existing Cloudflare Access application and official `cloudflared` login. It starts a local
Worker plus a loopback-only bridge, keeps the Access assertion out of browser JavaScript, and issues one short local
pairing URL/session. It does not create or deploy an Access application, Tunnel or Worker.

Login establishes identity only. Source access still requires the actual selected local namespace/read policy. The
operator may explicitly initialize a namespace or apply a policy through the existing command-file options:

```sh
pnpm local:owner --initialize-namespace path/to/namespace.json
pnpm local:owner --policy path/to/policy.json
```

Those files are trusted local operator input, bounded by the current CLI, never browser-supplied grant APIs. Do not
embed a principal, credential or production resource in documentation examples.

## Isolation and safety

The generated profile and local D1 state stay under ignored `.eliotr-state/local/`. Local preparation preserves an
existing valid local cursor key and rejects malformed/conflicting configuration; it does not silently replace
credentials or read parent secrets. Remote bindings remain disabled for the isolated profile unless a specific
selected test explicitly names and authorizes them.

The Worker still authenticates protected requests. The bridge binds only to loopback, rejects cross-origin/cross-port
traffic, never follows upstream redirects and discards a response racing sign-out/expiry. Do not expose it through a
Tunnel or public interface. Stop the launcher to end the local session.

## What local development does not prove

A successful local run does not prove:

- production Access/bindings, provider credentials or managed search availability;
- deployed Workflow/Agent hibernation and reconnect behavior;
- remote D1 migration state or retained-data conversion;
- representative latency, cost, quota or browser acceptance;
- permission to deploy, erase data or rotate credentials.

Use [release and schema transitions](production-readiness-plan.md) for remote cutover and
[scoped verification](scoped-verification.md) for development checks. Record environment-dependent work as unrun or
failed; do not turn an old successful production observation into continuing readiness.

## Maintenance

Keep local scripts aligned with the current React/Vite assets and one Worker. When Astro/legacy PWA callers are
removed, delete their local build/proxy branches too. Preserve useful isolation/authentication checks; remove any
local fixture whose only purpose is a canceled protocol, status registry or historical release programme.
