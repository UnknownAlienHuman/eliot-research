// ER-40 production bootstrap planner/executor for the rust-vectors gate.
//
// This module owns the exact production decision/execution that
// scripts/check-rust-vectors.mjs calls. There is no duplicate bootstrap logic
// in the gate: the gate imports ensureWorkspace() / ensureWorkspaceWithDeps()
// from here and invokes runBootstrapSelfTest() once at the top so
// `node scripts/check-rust-vectors.mjs` necessarily executes the regression.
//
// Production route (clean checkout):
//   probe   corepack pnpm --version            (shell:false on POSIX)
//   prepare corepack prepare pnpm@<pin> --activate (only on probe mismatch)
//   install corepack pnpm install --frozen-lockfile
// Never spawns a bare `pnpm` binary: on a clean Linux runner the current
// process PATH gains no observable new pnpm shim (shell:false), so a bare
// `pnpm` fails with ENOENT even after preparation succeeded.
//
// Corepack policy (toolchain.md#bootstrap, CI pins Node 22):
//   - Node >=22.13.0 ships corepack; CI runs Node 22 with
//     `corepack enable` + `corepack prepare pnpm@11.23.0 --activate`.
//   - For any other engine-supported Node, a missing `corepack` executable
//     fails immediately with a prerequisite/version diagnostic that names the
//     toolchain bootstrap. No silent unpinned download, no fallback to a bare
//     `pnpm`/`npm` route, no weakened `--frozen-lockfile` semantics.
//   - Preparation/install always set COREPACK_ENABLE_DOWNLOAD_PROMPT=0 with
//     inherited env; labels/argv are logged, env values and secrets never are.
//   - Timeouts: preserved production behavior (no explicit timeout option;
//     synchronous spawnSync inherits the caller/CI step timeout).
import { spawnSync as nodeSpawnSync } from "node:child_process";
import { existsSync as nodeExistsSync, readFileSync as nodeReadFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const PINNED_VERSION = /^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][0-9A-Za-z.-]+)?$/u;
export const MANAGER_PATTERN = /^pnpm@([0-9]+\.[0-9]+\.[0-9]+(?:[-+][0-9A-Za-z.-]+)?)$/u;
export const COREPACK_ENABLE_DOWNLOAD_PROMPT = "0";
export const EXPECTED_PIN_EXAMPLE = "pnpm@11.23.0";
export const COREPACK_PREREQUISITE_HINT =
  "corepack executable is unavailable; install the repo toolchain per docs/implementation/toolchain.md#bootstrap " +
  "(Node >=22.13.0 ships corepack; CI pins Node 22 with `corepack enable` and " +
  "`corepack prepare pnpm@11.23.0 --activate`)";

export const REPO_ROOT = fileURLToPath(new URL("../", import.meta.url));

export function fail(message) {
  throw new Error(message);
}

export function shellForPlatform(platform = process.platform) {
  return platform === "win32";
}

export function readPackageJsonFile(packagePath, readFileSyncFn = nodeReadFileSync) {
  try {
    return JSON.parse(readFileSyncFn(packagePath, "utf8"));
  } catch (error) {
    fail(
      `rust-vectors gate: cannot read ${packagePath}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export function parsePinnedPnpm(manager) {
  const match = typeof manager === "string" ? MANAGER_PATTERN.exec(manager) : null;
  if (match === null) {
    fail(
      `rust-vectors gate: root packageManager must pin pnpm (for example ${EXPECTED_PIN_EXAMPLE})`,
    );
  }
  return match[1];
}

export function defaultWorkspaceIsInstalled(repoRoot = REPO_ROOT, existsSyncFn = nodeExistsSync) {
  return (
    existsSyncFn(join(repoRoot, "node_modules", ".modules.yaml")) &&
    existsSyncFn(join(repoRoot, "node_modules", "typescript", "bin", "tsc")) &&
    existsSyncFn(
      join(
        repoRoot,
        "packages",
        "domain",
        "node_modules",
        "@eliotr",
        "contracts",
        "package.json",
      ),
    )
  );
}

function corepackMissingError(label, detail) {
  return `rust-vectors gate: ${label} failed to start: ${detail} (${COREPACK_PREREQUISITE_HINT})`;
}

// Exact production command runner. Logs only binary+argv+label; never env values.
export function runGateCommandWithDeps(binary, args, label, deps = {}) {
  const {
    spawnSyncFn = nodeSpawnSync,
    platform = process.platform,
    env = process.env,
    repoRoot = REPO_ROOT,
    extraEnv,
    useShell = shellForPlatform(platform),
    logger = console.log,
  } = deps;
  logger(`rust-vectors gate: ${label}: ${[binary, ...args].join(" ")}`);
  const result = spawnSyncFn(binary, args, {
    cwd: repoRoot,
    stdio: "inherit",
    shell: useShell,
    ...(extraEnv === undefined ? {} : { env: { ...env, ...extraEnv } }),
  });
  if (result.error) {
    if (binary === "corepack") fail(corepackMissingError(label, result.error.message));
    fail(`rust-vectors gate: ${label} failed to start: ${result.error.message}`);
  }
  if (result.status !== 0) {
    fail(`rust-vectors gate: ${label} exited with code ${result.status}`);
  }
  return result;
}

export function captureStdoutWithDeps(binary, args, deps = {}) {
  const {
    spawnSyncFn = nodeSpawnSync,
    platform = process.platform,
    repoRoot = REPO_ROOT,
  } = deps;
  const result = spawnSyncFn(binary, args, {
    cwd: repoRoot,
    stdio: ["ignore", "pipe", "ignore"],
    shell: shellForPlatform(platform),
    encoding: "utf8",
  });
  if (result.error || result.status !== 0) return undefined;
  return typeof result.stdout === "string" ? result.stdout.trim() : undefined;
}

// Production bootstrap with injected seams. Default deps are the real process
// behavior; tests inject spawnSyncFn/platform/env/probes and observe `calls`.
export function ensureWorkspaceWithDeps(deps = {}) {
  const {
    spawnSyncFn = nodeSpawnSync,
    platform = process.platform,
    env = process.env,
    repoRoot = REPO_ROOT,
    workspaceIsInstalledFn = () => defaultWorkspaceIsInstalled(repoRoot, nodeExistsSync),
    readPackageJsonFn = (path) => readPackageJsonFile(path, nodeReadFileSync),
    logger = console.log,
  } = deps;
  const calls = [];
  const observingSpawnSync = (binary, args, options) => {
    calls.push({ binary, args: [...args], shell: options?.shell, hasEnv: options?.env !== undefined });
    return spawnSyncFn(binary, args, options);
  };
  const runDeps = (extra) => ({
    spawnSyncFn: observingSpawnSync,
    platform,
    env,
    repoRoot,
    logger,
    ...extra,
  });

  if (workspaceIsInstalledFn()) {
    logger("rust-vectors gate: frozen workspace dependencies present; reusing the repo toolchain.");
    return { reused: true, pinnedPnpm: undefined, calls };
  }

  const rootPkg = readPackageJsonFn(join(repoRoot, "package.json"));
  const pinnedPnpm = parsePinnedPnpm(typeof rootPkg.packageManager === "string" ? rootPkg.packageManager : "");
  const probe = captureStdoutWithDeps("corepack", ["pnpm", "--version"], {
    spawnSyncFn: observingSpawnSync,
    platform,
    repoRoot,
  });
  if (probe !== pinnedPnpm) {
    runGateCommandWithDeps(
      "corepack",
      ["prepare", `pnpm@${pinnedPnpm}`, "--activate"],
      `activating repo-pinned pnpm@${pinnedPnpm} via corepack`,
      runDeps({ extraEnv: { COREPACK_ENABLE_DOWNLOAD_PROMPT } }),
    );
  }
  runGateCommandWithDeps(
    "corepack",
    ["pnpm", "install", "--frozen-lockfile"],
    "installing frozen workspace dependencies",
    runDeps({ extraEnv: { COREPACK_ENABLE_DOWNLOAD_PROMPT } }),
  );
  if (!workspaceIsInstalledFn()) {
    fail("rust-vectors gate: workspace install completed but dependencies are still unresolvable");
  }
  return { reused: false, pinnedPnpm, calls };
}

export function ensureWorkspace() {
  return ensureWorkspaceWithDeps();
}

function assertEqual(actual, expected, message) {
  if (actual !== expected) {
    fail(`${message}: expected ${JSON.stringify(expected)}; received ${JSON.stringify(actual)}`);
  }
}

function assertThrowsWith(fragment, fn, message) {
  try {
    fn();
  } catch (error) {
    const text = error instanceof Error ? error.message : String(error);
    if (!text.includes(fragment)) fail(`${message}: wrong rejection: ${text}`);
    return text;
  }
  fail(`${message}: expected failure was accepted`);
}

function fakeSpawnSyncFactory({ probeOutput = "11.23.0", failBinaries = {}, record = [] } = {}) {
  return (binary, args, options) => {
    record.push({ binary, args: [...args], shell: options?.shell, env: options?.env });
    const key = `${binary} ${args.join(" ")}`;
    if (failBinaries[key] !== undefined) return failBinaries[key];
    if (binary === "corepack" && args.join(" ") === "pnpm --version") {
      if (probeOutput === undefined) return { error: undefined, status: 1, stdout: "" };
      return { error: undefined, status: 0, stdout: `${probeOutput}\n` };
    }
    return { error: undefined, status: 0, stdout: "" };
  };
}

// Executable seam: invokes the exact production helper with injected fakes and
// asserts observed executable/argv/env/shell/order for POSIX and Windows plus
// every fail-closed case. The gate calls this once at the top; the standalone
// regression file calls it directly for proof.
export function runBootstrapSelfTest() {
  const silent = () => {};
  let assertions = 0;
  const ok = (actual, expected, message) => {
    assertions += 1;
    assertEqual(actual, expected, message);
  };

  for (const platform of ["linux", "win32"]) {
    const expectedShell = platform === "win32";
    const record = [];
    const spawnSyncFn = fakeSpawnSyncFactory({ probeOutput: "0.0.0", record });
    let checks = 0;
    const result = ensureWorkspaceWithDeps({
      spawnSyncFn,
      platform,
      env: { PATH: "test-path", SECRET: "must-not-log" },
      repoRoot: "/repo",
      workspaceIsInstalledFn: () => {
        checks += 1;
        return checks > 1;
      },
      readPackageJsonFn: () => ({ packageManager: "pnpm@11.23.0" }),
      logger: silent,
    });
    // Probe mismatch plans prepare then install, in order, through corepack.
    ok(result.reused, false, `${platform}: cold checkout must bootstrap`);
    ok(record.length, 3, `${platform}: probe+prepare+install order`);
    ok(record[0].binary, "corepack", `${platform}: probe executable`);
    ok(record[0].args.join(" "), "pnpm --version", `${platform}: probe argv`);
    ok(record[0].shell, expectedShell, `${platform}: probe shell`);
    ok(record[1].binary, "corepack", `${platform}: prepare executable`);
    ok(record[1].args.join(" "), "prepare pnpm@11.23.0 --activate", `${platform}: prepare argv`);
    ok(record[1].shell, expectedShell, `${platform}: prepare shell`);
    ok(record[1].env?.COREPACK_ENABLE_DOWNLOAD_PROMPT, "0", `${platform}: prepare env flag`);
    ok(record[1].env?.PATH, "test-path", `${platform}: prepare inherits env`);
    ok(record[2].args.join(" "), "pnpm install --frozen-lockfile", `${platform}: install argv`);
    ok(record[2].shell, expectedShell, `${platform}: install shell`);
    ok(record[2].env?.COREPACK_ENABLE_DOWNLOAD_PROMPT, "0", `${platform}: install env flag`);
  }

  // Probe match skips prepare: exactly probe+install.
  {
    const record = [];
    let checks = 0;
    ensureWorkspaceWithDeps({
      spawnSyncFn: fakeSpawnSyncFactory({ probeOutput: "11.23.0", record }),
      platform: "linux",
      env: {},
      repoRoot: "/repo",
      workspaceIsInstalledFn: () => {
        checks += 1;
        return checks > 1;
      },
      readPackageJsonFn: () => ({ packageManager: "pnpm@11.23.0" }),
      logger: silent,
    });
    assertions += 1;
    assertEqual(record.length, 2, "probe match must skip prepare");
    assertions += 1;
    assertEqual(record[1].args.join(" "), "pnpm install --frozen-lockfile", "probe match installs frozen");
  }

  // Bounded reuse: already-installed workspace performs zero spawns.
  {
    const record = [];
    const result = ensureWorkspaceWithDeps({
      spawnSyncFn: fakeSpawnSyncFactory({ record }),
      platform: "linux",
      env: {},
      repoRoot: "/repo",
      workspaceIsInstalledFn: () => true,
      readPackageJsonFn: () => fail("must not read package.json on reuse path"),
      logger: silent,
    });
    assertions += 1;
    assertEqual(result.reused, true, "installed workspace must reuse");
    assertions += 1;
    assertEqual(record.length, 0, "reuse path must spawn nothing");
  }

  // Fail-closed: missing corepack exe surfaces the toolchain prerequisite.
  assertions += 1;
  assertThrowsWith(
    "corepack executable is unavailable",
    () =>
      ensureWorkspaceWithDeps({
        spawnSyncFn: () => ({ error: Object.assign(new Error("spawn corepack ENOENT"), { code: "ENOENT" }), status: null }),
        platform: "linux",
        env: {},
        repoRoot: "/repo",
        workspaceIsInstalledFn: () => false,
        readPackageJsonFn: () => ({ packageManager: "pnpm@11.23.0" }),
        logger: silent,
      }),
    "missing corepack must fail with prerequisite diagnostic",
  );

  // Fail-closed: non-zero prepare/install exit codes.
  for (const failingArgv of ["prepare pnpm@11.23.0 --activate", "pnpm install --frozen-lockfile"]) {
    assertions += 1;
    assertThrowsWith(
      "exited with code",
      () =>
        ensureWorkspaceWithDeps({
          spawnSyncFn: fakeSpawnSyncFactory({
            probeOutput: "0.0.0",
            failBinaries: { [`corepack ${failingArgv}`]: { error: undefined, status: 1, stdout: "" } },
          }),
          platform: "linux",
          env: {},
          repoRoot: "/repo",
          workspaceIsInstalledFn: () => false,
          readPackageJsonFn: () => ({ packageManager: "pnpm@11.23.0" }),
          logger: silent,
        }),
      `non-zero ${failingArgv} must fail closed`,
    );
  }

  // Fail-closed: pin mismatch is handled by prepare; malformed/injection pins reject.
  for (const bad of ["", "npm@11.23.0", "pnpm@latest", "pnpm@11.23.0; rm -rf /", "pnpm@11.23", "pnpm@", 42, undefined]) {
    assertions += 1;
    assertThrowsWith(
      "root packageManager must pin pnpm",
      () =>
        ensureWorkspaceWithDeps({
          spawnSyncFn: fakeSpawnSyncFactory({}),
          platform: "linux",
          env: {},
          repoRoot: "/repo",
          workspaceIsInstalledFn: () => false,
          readPackageJsonFn: () => ({ packageManager: bad }),
          logger: silent,
        }),
      `malformed packageManager ${JSON.stringify(bad)} must fail closed`,
    );
  }

  // Fail-closed: install completed but workspace still unresolvable.
  assertions += 1;
  assertThrowsWith(
    "still unresolvable",
    () =>
      ensureWorkspaceWithDeps({
        spawnSyncFn: fakeSpawnSyncFactory({ probeOutput: "0.0.0" }),
        platform: "linux",
        env: {},
        repoRoot: "/repo",
        workspaceIsInstalledFn: () => false,
        readPackageJsonFn: () => ({ packageManager: "pnpm@11.23.0" }),
        logger: silent,
      }),
    "unresolvable post-install must fail closed",
  );

  return { assertions };
}
