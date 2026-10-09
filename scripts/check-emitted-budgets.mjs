import { spawnSync } from "node:child_process";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  captureSourceIdentity,
  DEFAULT_RECEIPT_PATH,
  inspectPwaBuild,
  inspectWorkerBuild,
  inspectWebBuild,
  inspectWebWorkerBuild,
  OWNER_WEB_INITIAL_GZIP_BUDGET_BYTES,
  RECEIPT_PROTOCOL,
  validateReceipt,
  WORKER_GZIP_BUDGET_BYTES,
} from "./lib/emitted-build-budget-evidence.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PNPM = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
const INPUT_PATHS = [
  ".npmrc",
  "package.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "tsconfig.json",
  "tsconfig.base.json",
  "apps/eliotr-core/package.json",
  "apps/eliotr-core/tsconfig.json",
  "apps/eliotr-core/wrangler.jsonc",
  "scripts/generate-cloudflare-types.mjs",
  "apps/eliotr-pwa/package.json",
  "apps/eliotr-pwa/astro.config.mjs",
  "apps/eliotr-pwa/tsconfig.json",
  "apps/eliotr-pwa/vite.config.ts",
  "apps/eliotr-pwa/scripts/build-agent-inbox.mjs",
  ".eliotr-state/generated-types/eliotr-core.d.ts",
  "apps/eliotr-web/package.json",
  "apps/eliotr-web/tsconfig.json",
  "apps/eliotr-web/vite.config.ts",
  "apps/eliotr-web/vite.integrated.config.ts",
  "apps/eliotr-web/index.html",
  "packages/ui/package.json",
  "packages/ui/tsconfig.json",
];

function spawnPnpm(args, options = {}) {
  return spawnSync(PNPM, args, {
    cwd: ROOT,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
    windowsHide: true,
    shell: process.platform === "win32",
    ...options,
  });
}

function parseArguments(args) {
  const options = { checkOnly: false, receiptPath: DEFAULT_RECEIPT_PATH, help: false, ownerWeb: false };
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === "--check-only") {
      options.checkOnly = true;
    } else if (args[index] === "--owner-web") {
      options.ownerWeb = true;
    } else if (args[index] === "--receipt") {
      const value = args[index + 1];
      if (!value) throw new Error("--receipt requires a path");
      options.receiptPath = value;
      index += 1;
    } else if (args[index] === "--help" || args[index] === "-h") {
      options.help = true;
    } else {
      throw new Error("Unknown emitted budget option: " + args[index]);
    }
  }
  if (options.ownerWeb && options.receiptPath === DEFAULT_RECEIPT_PATH) {
    options.receiptPath = "apps/eliotr-web/.wrangler/s90-emitted-budget-receipt.json";
  }
  return options;
}

function packageJson(path) {
  return readFile(resolve(ROOT, path), "utf8").then((value) => JSON.parse(value));
}

async function sha256File(path) {
  const { createHash } = await import("node:crypto");
  return createHash("sha256").update(await readFile(resolve(ROOT, path))).digest("hex");
}

async function readBuildInputs() {
  const result = {};
  for (const path of INPUT_PATHS) result[path] = await sha256File(path);
  return result;
}

function versionOutput(args) {
  const result = spawnPnpm(args);
  const output = (result.stdout ?? "") + (result.stderr ?? "");
  return result.status === 0 ? output.trim() : null;
}

async function toolVersions() {
  const pnpm = versionOutput(["--version"]);
  const wrangler = versionOutput(["--filter", "@eliotr/core", "exec", "wrangler", "--version"]);
  const astro = versionOutput(["--filter", "@eliotr/pwa", "exec", "astro", "--version"]);
  const vite = versionOutput(["--filter", "@eliotr/pwa", "exec", "vite", "--version"]);
  return {
    node: process.version,
    pnpm: pnpm?.split(/\r?\n/u).at(-1) ?? null,
    wrangler: wrangler?.split(/\r?\n/u).at(-1) ?? null,
    astro: astro?.split(/\r?\n/u).at(-1) ?? null,
    vite: vite?.split(/\r?\n/u).at(-1) ?? null,
  };
}

async function verifyBuildCommands() {
  const [rootPackage, workerPackage, pwaPackage] = await Promise.all([
    packageJson("package.json"),
    packageJson("apps/eliotr-core/package.json"),
    packageJson("apps/eliotr-pwa/package.json"),
  ]);
  const commands = {
    combined: rootPackage.scripts?.["cf:dry-run"],
    emitted: rootPackage.scripts?.["budgets:emitted"],
    emittedCheck: rootPackage.scripts?.["budgets:emitted:check"],
    pwa: pwaPackage.scripts?.build,
    worker: workerPackage.scripts?.["deploy:dry-run"],
    types: workerPackage.scripts?.["cf:types"],
  };
  const expected = {
    combined: "pnpm build:pwa && pnpm --filter @eliotr/core deploy:dry-run",
    emitted: "node scripts/check-emitted-budgets.mjs",
    emittedCheck: "node scripts/check-emitted-budgets.mjs --check-only",
    pwa: "node scripts/build-agent-inbox.mjs && astro build",
    worker: "wrangler deploy --dry-run --minify --outdir dist",
    types: "node ../../scripts/generate-cloudflare-types.mjs",
  };
  const issues = Object.keys(expected)
    .filter((key) => commands[key] !== expected[key])
    .map((key) => "Build command changed or is unsupported: " + key);
  return { commands, issues };
}

function statusCode(status) {
  return status === "PASS" ? 0 : 1;
}

function overallStatus(worker, pwa, sourceStable) {
  if (!sourceStable) return "STALE";
  if (worker.status === "STALE" || pwa.status === "STALE") return "STALE";
  if (worker.status === "NOT_MEASURED" || pwa.status === "NOT_MEASURED") return "NOT_MEASURED";
  if (worker.status === "FAIL" || pwa.status === "FAIL") return "FAIL";
  return "PASS";
}

function printSummary(receipt, receiptPath) {
  console.log(JSON.stringify({
    protocol: receipt.protocol,
    status: receipt.status,
    receipt: receiptPath.replaceAll("\\", "/"),
    source: {
      commit: receipt.source?.commit ?? null,
      dirty: receipt.source?.dirty ?? null,
      stableDuringBuild: receipt.source?.stableDuringBuild ?? null,
    },
    worker: {
      status: receipt.worker?.status ?? "NOT_MEASURED",
      rawReported: receipt.worker?.metric?.rawReported ?? null,
      gzipBytes: receipt.worker?.metric?.gzipBytes ?? null,
      gzipReported: receipt.worker?.metric?.gzipReported ?? null,
      thresholdBytes: receipt.worker?.threshold?.gzipBytes ?? null,
    },
    ownerWeb: {
      status: receipt.pwa?.status ?? "NOT_MEASURED",
      initialRoute: receipt.pwa?.initialOwnerWebJavaScript?.route ?? null,
      initialGzipBytes: receipt.pwa?.initialOwnerWebJavaScript?.gzipBytes ?? null,
      thresholdBytes: receipt.pwa?.threshold?.gzipBytes ?? null,
      sharedInitialChunks: receipt.pwa?.sharedInitialChunks?.length ?? null,
      lazyChunks: receipt.pwa?.lazyJavaScript?.resources?.length ?? null,
      agentInboxGzipBytes: receipt.pwa?.agentInbox?.initialJavaScript?.gzipBytes ?? null,
    },
    issues: receipt.issues ?? [],
  }, null, 2));
}

async function checkExistingReceipt(options) {
  const receiptPath = resolve(ROOT, options.receiptPath);
  let receipt = null;
  try {
    receipt = JSON.parse(await readFile(receiptPath, "utf8"));
  } catch (error) {
    if (error?.code !== "ENOENT") {
      const result = {
        protocol: RECEIPT_PROTOCOL,
        status: "NOT_MEASURED",
        issues: ["Receipt could not be read as JSON"],
      };
      printSummary(result, options.receiptPath);
      return 1;
    }
  }

  const currentInputDigests = await readBuildInputs();
  const currentIdentity = await captureSourceIdentity(ROOT, currentInputDigests);
  const validation = await validateReceipt(ROOT, receipt, currentIdentity);
  const result = receipt
    ? { ...receipt, status: validation.status, issues: validation.issues }
    : { protocol: RECEIPT_PROTOCOL, status: validation.status, issues: validation.issues };
  printSummary(result, options.receiptPath);
  return statusCode(validation.status);
}

async function writeReceipt(receiptPath, receipt) {
  const absolute = resolve(ROOT, receiptPath);
  await mkdir(dirname(absolute), { recursive: true });
  const temporary = absolute + ".tmp-" + process.pid;
  await writeFile(temporary, JSON.stringify(receipt, null, 2) + "\n", "utf8");
  await rename(temporary, absolute);
}

export async function runEmittedBudgetCheck(args = []) {
  let options;
  try {
    options = parseArguments(args);
  } catch (error) {
    console.error(error.message);
    console.error("Usage: node scripts/check-emitted-budgets.mjs [--check-only] [--receipt <path>]");
    return 2;
  }
  if (options.help) {
    console.log("Usage: node scripts/check-emitted-budgets.mjs [--check-only] [--receipt <path>]");
    return 0;
  }
  if (options.ownerWeb) return runOwnerWebBudgetCheck(options);
  if (options.checkOnly) return checkExistingReceipt(options);

  const commandEvidence = await verifyBuildCommands();
  const versions = await toolVersions();
  const commandIssues = [...commandEvidence.issues];
  const inputDigests = await readBuildInputs();
  const before = await captureSourceIdentity(ROOT, inputDigests);
  const buildStartedAt = new Date().toISOString();
  for (const tool of ["pnpm", "wrangler", "astro", "vite"]) {
    if (!versions[tool]) commandIssues.push("Installed tool version is unavailable: " + tool);
  }

  const buildAttempted = commandIssues.length === 0;
  let worker;
  let pwa;
  try {
    if (!buildAttempted) throw new Error("Build skipped because the command or installed tool set is unsupported");
    const build = spawnPnpm(["cf:dry-run"]);
    const buildFinishedAt = new Date().toISOString();
    const output = (build.stdout ?? "") + "\n" + (build.stderr ?? "");
    const inputDigestsAfter = await readBuildInputs();
    const after = await captureSourceIdentity(ROOT, inputDigestsAfter);
    const sourceStable = before.fingerprint === after.fingerprint;
    [worker, pwa] = await Promise.all([
      inspectWorkerBuild(ROOT, buildStartedAt, output),
      inspectPwaBuild(ROOT, buildStartedAt),
    ]);
    if (build.error) commandIssues.push("Build process could not start: " + (build.error.code ?? "unknown"));
    if (build.status !== 0) commandIssues.push("The pinned local dry-run exited unsuccessfully");
    if (!sourceStable) commandIssues.push("Source or lockfile changed during the emitted build");
    if (JSON.stringify(inputDigests) !== JSON.stringify(inputDigestsAfter)) {
      commandIssues.push("A captured build input changed during the emitted build");
    }
    if (build.status !== 0 || build.error) {
      worker.status = "NOT_MEASURED";
      pwa.status = "NOT_MEASURED";
    }
    if (!sourceStable) {
      worker.status = "STALE";
      pwa.status = "STALE";
    }
    const artifacts = [
      ...(worker.artifactFiles ?? []),
      ...(pwa.artifactFiles ?? []),
    ];
    const issues = [...commandIssues, ...(worker.issues ?? []), ...(pwa.issues ?? [])];
    const receipt = {
      protocol: RECEIPT_PROTOCOL,
      createdAt: buildFinishedAt,
      status: overallStatus(worker, pwa, sourceStable),
      source: {
        commit: before.commit,
        commitAfterBuild: after.commit,
        dirty: before.dirty,
        dirtyAfterBuild: after.dirty,
        dirtyEntryCount: before.dirtyEntryCount,
        dirtyDigest: before.dirtyDigest,
        fingerprintBeforeBuild: before.fingerprint,
        fingerprintAfterBuild: after.fingerprint,
        stableDuringBuild: sourceStable,
        lockfileSha256: before.lockfileSha256,
        buildInputDigestSha256: before.buildInputDigestSha256,
        buildInputDigestSha256After: after.buildInputDigestSha256,
      },
      build: {
        command: "pnpm cf:dry-run",
        attempted: buildAttempted,
        commandStatus: build.status,
        startedAt: buildStartedAt,
        finishedAt: buildFinishedAt,
        environmentProfile: "local dry-run; top-level Wrangler config; no --remote; no explicit target environment",
        commands: commandEvidence.commands,
        toolVersions: versions,
        inputDigests,
        inputDigestsAfter,
      },
      thresholds: {
        workerGzipBytes: WORKER_GZIP_BUDGET_BYTES,
        ownerWebInitialJavaScriptGzipBytes: OWNER_WEB_INITIAL_GZIP_BUDGET_BYTES,
        sourceLineAndByteBudgets: "separate maintainability diagnostics; not runtime metrics",
      },
      worker,
      pwa,
      artifacts,
      issues,
    };

    const finalStatus = await validateReceipt(ROOT, receipt, after);
    if (finalStatus.status === "STALE" && sourceStable) {
      receipt.status = "STALE";
      receipt.issues.push(...finalStatus.issues);
      worker.status = "STALE";
      pwa.status = "STALE";
    }
    await writeReceipt(options.receiptPath, receipt);
    printSummary(receipt, options.receiptPath);
    return statusCode(receipt.status);
  } catch (error) {
    const finishedAt = new Date().toISOString();
    const inputDigestsAfter = await readBuildInputs();
    const after = await captureSourceIdentity(ROOT, inputDigestsAfter);
    const sourceStable = before.fingerprint === after.fingerprint;
    worker = { status: sourceStable ? "NOT_MEASURED" : "STALE", issues: [] };
    pwa = { status: sourceStable ? "NOT_MEASURED" : "STALE", issues: [] };
    const issues = [...commandIssues, error?.message ?? "Emitted budget build failed closed"];
    const receipt = {
      protocol: RECEIPT_PROTOCOL,
      createdAt: finishedAt,
      status: sourceStable ? "NOT_MEASURED" : "STALE",
      source: {
        commit: before.commit,
        commitAfterBuild: after.commit,
        dirty: before.dirty,
        dirtyAfterBuild: after.dirty,
        dirtyEntryCount: before.dirtyEntryCount,
        dirtyDigest: before.dirtyDigest,
        fingerprintBeforeBuild: before.fingerprint,
        fingerprintAfterBuild: after.fingerprint,
        stableDuringBuild: sourceStable,
        lockfileSha256: before.lockfileSha256,
        buildInputDigestSha256: before.buildInputDigestSha256,
        buildInputDigestSha256After: after.buildInputDigestSha256,
      },
      build: {
        command: "pnpm cf:dry-run",
        attempted: buildAttempted,
        commandStatus: null,
        startedAt: buildStartedAt,
        finishedAt,
        environmentProfile: "local dry-run; top-level Wrangler config; no --remote; no explicit target environment",
        commands: commandEvidence.commands,
        toolVersions: versions,
        inputDigests,
        inputDigestsAfter,
      },
      thresholds: {
        workerGzipBytes: WORKER_GZIP_BUDGET_BYTES,
        ownerWebInitialJavaScriptGzipBytes: OWNER_WEB_INITIAL_GZIP_BUDGET_BYTES,
        sourceLineAndByteBudgets: "separate maintainability diagnostics; not runtime metrics",
      },
      worker,
      pwa,
      artifacts: [],
      issues,
    };
    await writeReceipt(options.receiptPath, receipt);
    printSummary(receipt, options.receiptPath);
    return statusCode(receipt.status);
  }
}

async function runOwnerWebBudgetCheck(options) {
  const inputDigests = await readBuildInputs();
  const before = await captureSourceIdentity(ROOT, inputDigests);
  if (options.checkOnly) {
    const receipt = JSON.parse(await readFile(resolve(ROOT, options.receiptPath), "utf8"));
    const result = await validateReceipt(ROOT, receipt, before, { ownerWeb: true });
    console.log(JSON.stringify({ graph: "owner-web", ...result }));
    return statusCode(result.status);
  }
  const startedAt = new Date().toISOString();
  const webRoot = resolve(ROOT, "apps/eliotr-web");
  const build = spawnSync(process.execPath, [resolve(ROOT, "node_modules/vite/bin/vite.js"), "build", "--config", "vite.integrated.config.ts"], {
    cwd: webRoot, env: { ...process.env, CLOUDFLARE_ENV: "test" }, encoding: "utf8", maxBuffer: 32 * 1024 * 1024, windowsHide: true,
  });
  if (build.status !== 0) throw new Error("Owner-web integrated build failed");
  const dryEnv = { ...process.env };
  for (const key of ["CLOUDFLARE_ENV", "CLOUDFLARE_API_TOKEN", "CF_API_TOKEN", "CLOUDFLARE_API_KEY", "CF_API_KEY"]) delete dryEnv[key];
  const dryRun = spawnSync(process.execPath, [resolve(ROOT, "node_modules/wrangler/bin/wrangler.js"), "deploy", "--dry-run", "--no-bundle",
    "--config", resolve(webRoot, "dist/eliotr_core/wrangler.json"), "--outdir", resolve(ROOT, ".eliotr-state/frontend-owner-dry-run")], {
    cwd: ROOT, env: dryEnv, encoding: "utf8", maxBuffer: 32 * 1024 * 1024, windowsHide: true,
  });
  if (dryRun.status !== 0) throw new Error("Owner-web native dry-run failed: " + (dryRun.stderr ?? "").slice(-600));
  const nativeSizeOutput = ((dryRun.stdout ?? "") + "\n" + (dryRun.stderr ?? "")).split(/\r?\n/u)
    .filter(line => /wrangler\s+\d+\.\d+\.\d+|Total Upload:|--dry-run:\s*exiting now|Read \d+ files?/iu.test(line)).join("\n");
  const [worker, ownerWeb] = await Promise.all([inspectWebWorkerBuild(ROOT, startedAt, nativeSizeOutput), inspectWebBuild(ROOT, startedAt)]);
  const inputDigestsAfter = await readBuildInputs();
  const after = await captureSourceIdentity(ROOT, inputDigestsAfter);
  const stable = before.fingerprint === after.fingerprint;
  const issues = [...worker.issues, ...ownerWeb.issues];
  const status = !stable ? "STALE" : issues.length ? "NOT_MEASURED" : worker.status === "FAIL" || ownerWeb.status === "FAIL" ? "FAIL" : "PASS";
  const finishedAt = new Date().toISOString();
  const receipt = { protocol: RECEIPT_PROTOCOL, graph: "owner-web", purpose: "candidate", createdAt: finishedAt, status,
    source: { commit: before.commit, commitAfterBuild: after.commit, fingerprintBeforeBuild: before.fingerprint,
      fingerprintAfterBuild: after.fingerprint, stableDuringBuild: stable, lockfileSha256: before.lockfileSha256 },
    build: { command: "vite build --config vite.integrated.config.ts + wrangler deploy --dry-run --no-bundle", commandStatus: dryRun.status,
      startedAt, finishedAt, environmentProfile: "CLOUDFLARE_ENV=test; remoteBindings=false; local candidate only",
      inputDigests, inputDigestsAfter, nativeSizeOutput,
      toolVersions: { node: process.version, vite: JSON.parse(await readFile(resolve(webRoot, "node_modules/vite/package.json"), "utf8")).version } },
    worker, ownerWeb, artifacts: [...worker.artifactFiles, ...ownerWeb.artifactFiles], issues,
  };
  const checked = await validateReceipt(ROOT, receipt, after, { ownerWeb: true });
  if (checked.status !== status) { receipt.status = checked.status; receipt.issues.push(...checked.issues); }
  await writeReceipt(options.receiptPath, receipt);
  console.log(JSON.stringify({ graph: "owner-web", status: receipt.status, workerGzipBytes: worker.nativeReport.gzip?.bytes,
    initialJavaScriptGzipBytes: ownerWeb.metric.gzipBytes, receipt: options.receiptPath, issues: receipt.issues }));
  return statusCode(receipt.status);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runEmittedBudgetCheck(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  }).catch((error) => {
    console.error("Emitted budget check failed closed: " + (error?.message ?? "unknown error"));
    process.exitCode = 1;
  });
}
