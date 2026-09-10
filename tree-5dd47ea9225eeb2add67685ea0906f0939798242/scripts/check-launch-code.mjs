import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
/** Negative release gate, not a completeness proof or replacement for retained live conformance. */
export function launchCodeBlockers(registry, composition) {
  if (registry?.protocol !== "eliotr.implementation-status.v1" || !Array.isArray(registry.entries) || !registry.entries.length ||
      typeof composition !== "string" || !composition.includes("createApplication")) {
    throw new Error("Launch implementation registry or composition is invalid");
  }
  const known = new Set(["SCAFFOLD_FAIL_CLOSED", "IN_PROGRESS", "IMPLEMENTED_NOT_LIVE", "LIVE_QUALIFIED"]);
  const blockers = [];
  for (const entry of registry.entries) {
    if (!known.has(entry.state) || typeof entry.path !== "string" || typeof entry.id !== "string") {
      throw new Error("Launch implementation entry is invalid");
    }
    if (["SCAFFOLD_FAIL_CLOSED", "IN_PROGRESS"].includes(entry.state)) blockers.push(`${entry.id}: ${entry.path}`);
  }
  for (const match of composition.matchAll(/unavailable\(\s*["']([^"']+)["']\s*\)/gu)) blockers.push(match[1]);
  return [...new Set(blockers)].sort();
}
export async function assertLaunchCodeComplete() {
  const registry = JSON.parse(await readFile(resolve(root, "docs/implementation/implementation-status.json"), "utf8"));
  const composition = await readFile(resolve(root, "apps/eliotr-core/src/composition-root.ts"), "utf8");
  const blockers = launchCodeBlockers(registry, composition);
  if (blockers.length) throw new Error(`LIVE_DEPLOY_BLOCKED: known unfinished product paths: ${blockers.join("; ")}`);
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  await assertLaunchCodeComplete().then(() => console.log("No registered pending product paths; live conformance remains a separate release requirement."))
    .catch((error) => { console.error(error.message); process.exitCode = 1; });
}
