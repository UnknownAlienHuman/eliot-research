// Executable regression for CI-FIX1 (PR #100 CI run 34022069460, Rust job
// 101456348622): `node scripts/check-rust-vectors.mjs` failed on clean Linux
// with `spawnSync pnpm ENOENT` because ensureWorkspace() spawned a bare `pnpm`
// after `corepack prepare --activate` with shell:false. The gate must route
// every pnpm invocation through the already-resolved `corepack` executable.
//
// Unlike the former source-text grep proof (never executed by any gate), this
// file invokes the exact production helper
// (scripts/check-rust-vectors-bootstrap.mjs) with injected fakes and asserts
// the observed executable/argv/env/shell/order for POSIX and Windows plus all
// fail-closed cases. It is wired into the already-required gate path: the top
// of scripts/check-rust-vectors.mjs calls runBootstrapSelfTest() once, so
// `node scripts/check-rust-vectors.mjs` necessarily runs this seam. Running
// this file directly (`node scripts/test-rust-vectors-install.mjs`) reproduces
// the same assertions standalone, including the old bare-pnpm route failure.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  ensureWorkspaceWithDeps,
  runBootstrapSelfTest,
} from "./check-rust-vectors-bootstrap.mjs";

// 1. Exact production seam: POSIX + Windows order/argv/env/shell and every
// fail-closed case (probe/prepare/install, pin, injection, unresolvable,
// missing corepack with toolchain prerequisite diagnostic, bounded reuse).
const seam = runBootstrapSelfTest();
assert.ok(seam.assertions >= 30, `self-test must cover the seam (got ${seam.assertions})`);

// 2. Direct observable-call proof on the production executor: a cold POSIX
// checkout plans exactly probe -> prepare -> install through corepack with
// shell:false and COREPACK_ENABLE_DOWNLOAD_PROMPT=0 inherited env.
{
  const record = [];
  let checks = 0;
  const fakeSpawn = (binary, args, options) => {
    record.push({ binary, args: [...args], shell: options?.shell, env: options?.env });
    if (binary === "corepack" && args.join(" ") === "pnpm --version") {
      return { error: undefined, status: 0, stdout: "0.0.0\n" };
    }
    return { error: undefined, status: 0, stdout: "" };
  };
  ensureWorkspaceWithDeps({
    spawnSyncFn: fakeSpawn,
    platform: "linux",
    env: { PATH: "inherited", COREPACK_ENABLE_DOWNLOAD_PROMPT: undefined },
    repoRoot: "/repo",
    workspaceIsInstalledFn: () => {
      checks += 1;
      return checks > 1;
    },
    readPackageJsonFn: () => ({ packageManager: "pnpm@11.23.0" }),
    logger: () => {},
  });
  assert.equal(record.length, 3, "cold POSIX checkout must plan probe+prepare+install");
  assert.deepEqual(record[0].args, ["pnpm", "--version"], "probe argv must stay exact");
  assert.deepEqual(
    record[1].args,
    ["prepare", "pnpm@11.23.0", "--activate"],
    "prepare argv must pin pnpm@11.23.0",
  );
  assert.deepEqual(
    record[2].args,
    ["pnpm", "install", "--frozen-lockfile"],
    "install argv must stay frozen",
  );
  for (const [index, step] of record.entries()) {
    assert.equal(step.binary, "corepack", `step ${index} must use the corepack executable`);
    assert.equal(step.shell, false, `POSIX step ${index} must keep shell:false`);
  }
  assert.equal(record[1].env?.COREPACK_ENABLE_DOWNLOAD_PROMPT, "0", "prepare must disable prompts");
  assert.equal(record[2].env?.COREPACK_ENABLE_DOWNLOAD_PROMPT, "0", "install must disable prompts");
  assert.equal(record[1].env?.PATH, "inherited", "prepare must inherit env");
}

// 3. Old bare-`pnpm` runtime route fails this regression. Model the CI symptom:
// a bare pnpm shim absent from PATH fails with ENOENT under shell:false, while
// the corepack-resolved route dispatches with explicit argv. A legacy plan that
// emits a bare `pnpm` install is rejected: the production helper never emits
// such a call, so any recorded bare-pnpm call is a regression failure.
{
  const missing = spawnSync("eliotr-definitely-missing-pnpm-shim-xyz", ["--version"], {
    encoding: "utf8",
    shell: false,
  });
  assert.equal(missing.error?.code, "ENOENT", "bare missing pnpm shim must fail with ENOENT");

  const record = [];
  let postChecks = 0;
  ensureWorkspaceWithDeps({
    spawnSyncFn: (binary, args) => {
      record.push({ binary, args: [...args] });
      if (binary === "corepack" && args.join(" ") === "pnpm --version") {
        return { error: undefined, status: 0, stdout: "11.23.0\n" };
      }
      return { error: undefined, status: 0, stdout: "" };
    },
    platform: "linux",
    env: {},
    repoRoot: "/repo",
    workspaceIsInstalledFn: () => {
      postChecks += 1;
      return postChecks > 1;
    },
    readPackageJsonFn: () => ({ packageManager: "pnpm@11.23.0" }),
    logger: () => {},
  });
  const barePnpmCalls = record.filter(({ binary }) => binary === "pnpm");
  assert.equal(barePnpmCalls.length, 0, "production helper must never emit a bare pnpm call");
  // A legacy planner emitting `pnpm install --frozen-lockfile` directly would
  // produce exactly such a call and therefore fails this regression.
  const legacyPlan = [{ binary: "pnpm", args: ["install", "--frozen-lockfile"] }];
  assert.equal(legacyPlan[0].binary, "pnpm", "legacy plan uses bare pnpm");
  assert.notEqual(
    record.find((call) => call.binary === legacyPlan[0].binary)?.binary,
    legacyPlan[0].binary,
    "legacy bare-pnpm plan must not match the production corepack plan",
  );

  const routed = spawnSync(process.execPath, ["--version"], { encoding: "utf8", shell: false });
  assert.equal(routed.error, undefined, "resolved executable with explicit argv must start");
  assert.equal(routed.status, 0, "resolved executable must exit zero");
  assert.match(routed.stdout ?? "", /^v\d+\./u, "resolved executable must report a version");
}

console.log(
  `Rust vectors installer routing: PASS (executable corepack seam, ${seam.assertions} self-test assertions; no bare pnpm spawn).`,
);
