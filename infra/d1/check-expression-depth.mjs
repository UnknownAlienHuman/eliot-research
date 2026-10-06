import { spawnSync } from "node:child_process";
import { fileURLToPath, URL } from "node:url";
import process from "node:process";
import console from "node:console";

const root = fileURLToPath(new URL("../../", import.meta.url));
const script = fileURLToPath(new URL("./check-expression-depth.py", import.meta.url));
const extractor = fileURLToPath(new URL("./extract-application-sql.mjs", import.meta.url));
// Build-time tooling only: pinned TypeScript AST plus Python stdlib SQLite; no product runtime or remote database.
const args = process.argv.slice(2);
if (args.length > 1 || (args.length === 1 && args[0] !== "--strict-targets")) {
  console.error("D1_DEPTH_SETUP_FAILED: unsupported wrapper option.");
  process.exitCode = 2;
} else {
  const strictTargetFlag = args[0] === "--strict-targets";
  const inventory = spawnSync(process.execPath, [extractor, "--json"], {
    cwd: root, encoding: "utf8", shell: false, timeout: 120_000,
    env: { ...process.env, ...(strictTargetFlag ? { D1_DEPTH_STRICT_TARGETS: "1" } : {}), PYTHONDONTWRITEBYTECODE: "1" },
  });
  if (inventory.error !== undefined || inventory.signal !== null || inventory.status !== 0) {
    console.error("D1_DEPTH_SETUP_FAILED: application SQL extraction failed.");
    process.exitCode = 2;
  } else {
    let manifest;
    try {
      manifest = JSON.parse(inventory.stdout);
    } catch {
      console.error("D1_DEPTH_SETUP_FAILED: application SQL inventory is invalid.");
      process.exitCode = 2;
    }
    if (manifest !== undefined) runCompiler(JSON.stringify(manifest));
  }
}

function runCompiler(applicationSql) {
  const candidates = process.platform === "win32"
    ? [["python", []], ["py", ["-3"]], ["python3", []]]
    : [["python3", []], ["python", []]];
  let status = 2;
  let launched = false;
  for (const [command, prefix] of candidates) {
    const result = spawnSync(command, [...prefix, script, "--application-sql-stdin"], {
      cwd: root, input: applicationSql, stdio: ["pipe", "inherit", "inherit"], shell: false, timeout: 120_000,
      env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" },
    });
    if (result.error?.code === "ENOENT") continue;
    launched = true;
    if (result.error !== undefined || result.signal !== null) {
      console.error("D1_DEPTH_SETUP_FAILED: compiler process failed or exceeded its time bound.");
    } else {
      status = result.status ?? 2;
    }
    break;
  }
  if (!launched) console.error("D1_DEPTH_SETUP_FAILED: install Python >=3.11 with SQLite >=3.45.");
  process.exitCode = status;
}
