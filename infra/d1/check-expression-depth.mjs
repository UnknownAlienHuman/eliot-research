import { spawnSync } from "node:child_process";
import { fileURLToPath, URL } from "node:url";
import process from "node:process";
import console from "node:console";

const root = fileURLToPath(new URL("../../", import.meta.url));
const script = fileURLToPath(new URL("./check-expression-depth.py", import.meta.url));
// Build-time stdlib tooling only. No shell, npm install, product runtime or remote database.
const candidates = process.platform === "win32"
  ? [["python", []], ["py", ["-3"]], ["python3", []]]
  : [["python3", []], ["python", []]];
let status = 2;
let launched = false;
for (const [command, prefix] of candidates) {
  const result = spawnSync(command, [...prefix, script], {
    cwd: root, stdio: "inherit", shell: false, timeout: 120_000,
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
