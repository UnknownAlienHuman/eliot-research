import { readFile, stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runDeploymentMigrationOperation } from "./lib/deployment-migration-operation.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const MAX_INTENT_BYTES = 2 * 1024 * 1024;

function parseArgs(args) {
  if (args.length === 1 && (args[0] === "--help" || args[0] === "-h")) return { help: true };
  if (args.length !== 2 && args.length !== 3) return null;
  if (args[0] !== "--plan" || args[1] === "" || (args.length === 3 && args[2] !== "--confirm-live")) return null;
  return { planPath: resolve(process.cwd(), args[1]), confirmLive: args.length === 3 };
}

const parsed = parseArgs(process.argv.slice(2));
if (parsed?.help) {
  console.log("Usage: node scripts/migrate-cloudflare-d1.mjs --plan <intent.json> [--confirm-live]");
} else if (parsed === null) {
  console.error("Expected one --plan <intent.json> and optional --confirm-live");
  process.exitCode = 2;
} else {
  try {
    const fileStat = await stat(parsed.planPath);
    if (!fileStat.isFile() || fileStat.size > MAX_INTENT_BYTES) throw new Error("Migration intent file exceeds its local size bound");
    const bytes = await readFile(parsed.planPath);
    if (bytes.byteLength > MAX_INTENT_BYTES) throw new Error("Migration intent file exceeds its local size bound");
    let intent;
    try { intent = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
    catch { throw new Error("Migration intent file is invalid JSON"); }
    const result = await runDeploymentMigrationOperation({ intent, root: ROOT, confirmLive: parsed.confirmLive });
    if (result.state === "PLAN_ONLY") console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : "D1 migration operation failed");
    process.exitCode = 1;
  }
}
