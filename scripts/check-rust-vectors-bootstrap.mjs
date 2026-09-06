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
// Corepack policy (CI pins Node 22; engine floor >=22.13.0 is the ESLint 10
// runtime floor, not a Corepack bundle guarantee):
//   - Corepack is a separate required prerequisite, not bundled with every
//     supported Node (Node 25 no longer bundles Corepack). CI pins Node 22
//     with `corepack enable` + `corepack prepare pnpm@11.23.0 --activate`
//     per docs/implementation/toolchain.md#bootstrap (ER-00-owned, read-only).
//   - A missing `corepack` executable fails immediately with a prerequisite
//     diagnostic naming that pinned toolchain procedure. No silent unpinned
//     download, no fallback to a bare `pnpm`/`npm` route, no weakened
//     `--frozen-lockfile` semantics.
//   - Preparation/install always set COREPACK_ENABLE_DOWNLOAD_PROMPT=0 with
//     inherited env; labels/argv are logged, env values and secrets never are.
//   - Timeouts: every bootstrap spawn carries an explicit bounded spawnSync
//     `timeout` (probe 15s per test-boundary-negative precedent, prepare 120s
//     for the pinned download, install 180s per the 180s CI vitest-step
//     precedent). Direct invocation cannot hang; the enclosing CI step timeout
//     remains the outer bound. Timeouts fail closed with a `timed out`
//     diagnostic naming the label and budget.
import { spawnSync as nodeSpawnSync } from "node:child_process";
import { existsSync as nodeExistsSync, readFileSync as nodeReadFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const PINNED_VERSION = /^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][0-9A-Za-z.-]+)?$/u;
export const MANAGER_PATTERN = /^pnpm@([0-9]+\.[0-9]+\.[0-9]+(?:[-+][0-9A-Za-z.-]+)?)$/u;
export const COREPACK_ENABLE_DOWNLOAD_PROMPT = "0";
export const EXPECTED_PIN_EXAMPLE = "pnpm@11.23.0";
// Bounded per-command spawnSync budgets (milliseconds). Probe matches the
// scripts/test-boundary-negative.mjs 15s spawn precedent; install matches the
// 180s bounded CI step precedent; prepare sits between for one pinned
// corepack download. Every probe/prepare/install spawn asserts these exact
// values through the production seam.
export const PROBE_TIMEOUT_MS = 15_000;
export const PREPARE_TIMEOUT_MS = 120_000;
export const INSTALL_TIMEOUT_MS = 180_000;
export const COREPACK_PREREQUISITE_HINT =
  "corepack executable is unavailable (corepack is a separate required prerequisite, " +
  "not bundled with every supported Node; Node 25 no longer bundles corepack); install the " +
  "repo toolchain per docs/implementation/toolchain.md#bootstrap " +
  "(CI pins Node 22 with `corepack enable` and " +
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
    timeoutMs,
  } = deps;
  logger(`rust-vectors gate: ${label}: ${[binary, ...args].join(" ")}`);
  const result = spawnSyncFn(binary, args, {
    cwd: repoRoot,
    stdio: "inherit",
    shell: useShell,
    ...(timeoutMs === undefined ? {} : { timeout: timeoutMs }),
    ...(extraEnv === undefined ? {} : { env: { ...env, ...extraEnv } }),
  });
  if (result.error) {
    if (result.error.code === "ETIMEDOUT") {
      fail(`rust-vectors gate: ${label} timed out after ${timeoutMs}ms`);
    }
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
    timeoutMs,
  } = deps;
  const result = spawnSyncFn(binary, args, {
    cwd: repoRoot,
    stdio: ["ignore", "pipe", "ignore"],
    shell: shellForPlatform(platform),
    encoding: "utf8",
    ...(timeoutMs === undefined ? {} : { timeout: timeoutMs }),
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
    calls.push({
      binary,
      args: [...args],
      shell: options?.shell,
      hasEnv: options?.env !== undefined,
      timeout: options?.timeout,
    });
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
    timeoutMs: PROBE_TIMEOUT_MS,
  });
  if (probe !== pinnedPnpm) {
    runGateCommandWithDeps(
      "corepack",
      ["prepare", `pnpm@${pinnedPnpm}`, "--activate"],
      `activating repo-pinned pnpm@${pinnedPnpm} via corepack`,
      runDeps({ extraEnv: { COREPACK_ENABLE_DOWNLOAD_PROMPT }, timeoutMs: PREPARE_TIMEOUT_MS }),
    );
  }
  runGateCommandWithDeps(
    "corepack",
    ["pnpm", "install", "--frozen-lockfile"],
    "installing frozen workspace dependencies",
    runDeps({ extraEnv: { COREPACK_ENABLE_DOWNLOAD_PROMPT }, timeoutMs: INSTALL_TIMEOUT_MS }),
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
    record.push({
      binary,
      args: [...args],
      shell: options?.shell,
      env: options?.env,
      timeout: options?.timeout,
    });
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
// asserts observed executable/argv/env/shell/timeout/order for POSIX and
// Windows plus every fail-closed case. The gate calls this once at the top;
// the standalone regression file calls it directly for proof.
export function normalizeBootstrapCalls(record) {
  return record.map((call) => ({
    binary: call.binary,
    argv: [...call.args].join(" "),
    shell: call.shell,
    timeout: call.timeout,
    prompt: call.env?.COREPACK_ENABLE_DOWNLOAD_PROMPT ?? null,
    path: call.env?.PATH ?? null,
  }));
}

function assertAllCorepack(record, context) {
  for (const [index, call] of record.entries()) {
    if (call.binary !== "corepack") {
      fail(`${context}: step ${index} uses bare \`${call.binary}\` executable; cold path must route every call through corepack`);
    }
  }
}

function assertNormalizedPlanEqual(actual, expected, message) {
  assertEqual(JSON.stringify(actual), JSON.stringify(expected), message);
}

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
    ok(record[0].timeout, PROBE_TIMEOUT_MS, `${platform}: probe timeout`);
    ok(record[1].binary, "corepack", `${platform}: prepare executable`);
    ok(record[1].args.join(" "), "prepare pnpm@11.23.0 --activate", `${platform}: prepare argv`);
    ok(record[1].shell, expectedShell, `${platform}: prepare shell`);
    ok(record[1].timeout, PREPARE_TIMEOUT_MS, `${platform}: prepare timeout`);
    ok(record[1].env?.COREPACK_ENABLE_DOWNLOAD_PROMPT, "0", `${platform}: prepare env flag`);
    ok(record[1].env?.PATH, "test-path", `${platform}: prepare inherits env`);
    ok(record[2].binary, "corepack", `${platform}: install executable`);
    ok(record[2].args.join(" "), "pnpm install --frozen-lockfile", `${platform}: install argv`);
    ok(record[2].shell, expectedShell, `${platform}: install shell`);
    ok(record[2].timeout, INSTALL_TIMEOUT_MS, `${platform}: install timeout`);
    ok(record[2].env?.COREPACK_ENABLE_DOWNLOAD_PROMPT, "0", `${platform}: install env flag`);
    ok(record[2].env?.PATH, "test-path", `${platform}: install inherits env`);
    // All-binary guard: no future cold-path addition may use another executable.
    assertions += 1;
    assertAllCorepack(record, `${platform}: cold path`);
    // Normalized-array validation: exact executable+argv+shell+timeout+env plan
    // in order, so reordering or a bare-`pnpm` swap fails even if per-index
    // asserts above were edited down.
    assertions += 1;
    assertNormalizedPlanEqual(
      normalizeBootstrapCalls(record),
      [
        { binary: "corepack", argv: "pnpm --version", shell: expectedShell, timeout: PROBE_TIMEOUT_MS, prompt: null, path: null },
        { binary: "corepack", argv: "prepare pnpm@11.23.0 --activate", shell: expectedShell, timeout: PREPARE_TIMEOUT_MS, prompt: "0", path: "test-path" },
        { binary: "corepack", argv: "pnpm install --frozen-lockfile", shell: expectedShell, timeout: INSTALL_TIMEOUT_MS, prompt: "0", path: "test-path" },
      ],
      `${platform}: normalized cold-path plan must match exactly`,
    );
    // Mutation proof inside the mandatory path: a legacy bare-`pnpm install`
    // plan is rejected by the same validators.
    assertions += 1;
    assertThrowsWith(
      "bare `pnpm`",
      () =>
        assertAllCorepack(
          [{ binary: "pnpm", args: ["install", "--frozen-lockfile"], shell: expectedShell, timeout: INSTALL_TIMEOUT_MS }],
          `${platform}: legacy plan`,
        ),
      `${platform}: legacy bare-pnpm install plan must be rejected`,
    );
    assertions += 1;
    assertThrowsWith(
      "normalized cold-path plan",
      () =>
        assertNormalizedPlanEqual(
          normalizeBootstrapCalls([
            { binary: "corepack", args: ["pnpm", "--version"], shell: expectedShell, timeout: PROBE_TIMEOUT_MS, env: undefined },
            { binary: "corepack", args: ["prepare", "pnpm@11.23.0", "--activate"], shell: expectedShell, timeout: PREPARE_TIMEOUT_MS, env: { COREPACK_ENABLE_DOWNLOAD_PROMPT: "0", PATH: "test-path" } },
            { binary: "pnpm", args: ["install", "--frozen-lockfile"], shell: expectedShell, timeout: undefined, env: undefined },
          ]),
          normalizeBootstrapCalls(record),
          `${platform}: normalized cold-path plan`,
        ),
      `${platform}: bare-pnpm install swap must fail normalized validation`,
    );
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
    assertions += 1;
    assertAllCorepack(record, "probe match");
    assertions += 1;
    assertEqual(record[0].binary, "corepack", "probe match probe executable");
    assertions += 1;
    assertEqual(record[1].binary, "corepack", "probe match install executable");
    assertions += 1;
    assertEqual(record[0].timeout, PROBE_TIMEOUT_MS, "probe match probe timeout");
    assertions += 1;
    assertEqual(record[1].timeout, INSTALL_TIMEOUT_MS, "probe match install timeout");
    assertions += 1;
    assertNormalizedPlanEqual(
      normalizeBootstrapCalls(record).map(({ binary, argv, timeout }) => ({ binary, argv, timeout })),
      [
        { binary: "corepack", argv: "pnpm --version", timeout: PROBE_TIMEOUT_MS },
        { binary: "corepack", argv: "pnpm install --frozen-lockfile", timeout: INSTALL_TIMEOUT_MS },
      ],
      "probe match normalized plan must stay corepack probe+install",
    );
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

  // Fail-closed: spawn timeout surfaces a bounded `timed out` diagnostic.
  assertions += 1;
  assertThrowsWith(
    "timed out",
    () =>
      ensureWorkspaceWithDeps({
        spawnSyncFn: (binary, args) => {
          if (binary === "corepack" && args.join(" ") === "pnpm --version") {
            return { error: undefined, status: 0, stdout: "0.0.0\n" };
          }
          return {
            error: Object.assign(new Error(`spawnSync ${binary} ETIMEDOUT`), { code: "ETIMEDOUT" }),
            status: null,
            signal: null,
          };
        },
        platform: "linux",
        env: {},
        repoRoot: "/repo",
        workspaceIsInstalledFn: () => false,
        readPackageJsonFn: () => ({ packageManager: "pnpm@11.23.0" }),
        logger: silent,
      }),
    "timed-out prepare must fail closed with a timeout diagnostic",
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
