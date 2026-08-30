import { readFile, readdir } from "node:fs/promises";
import { extname, join, relative } from "node:path";
import process from "node:process";

const root = process.cwd();
const registryPath = join(root, "docs/implementation/implementation-status.json");
const registry = JSON.parse(await readFile(registryPath, "utf8"));
if (registry.protocol !== "eliotr.implementation-status.v1") {
  throw new Error("unknown implementation-status protocol");
}
if (!Array.isArray(registry.states) || !Array.isArray(registry.entries)) {
  throw new Error("implementation-status registry must declare states and entries");
}

const knownStates = new Set(registry.states);
const pendingSentinels = [
  "implementation required",
  "must compose implemented ports",
  "not implemented",
];
const implementedPrefix = "IMPLEMENTED_NOT_LIVE:";
const extensions = new Set([".ts", ".tsx", ".mjs", ".js"]);
const ignored = new Set(["node_modules", "dist", "dist-types", "coverage", ".wrangler"]);
const sourceFiles = new Map();

async function walk(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (ignored.has(entry.name)) continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) await walk(path);
    else if (extensions.has(extname(entry.name))) {
      sourceFiles.set(
        relative(root, path).replaceAll("\\", "/"),
        await readFile(path, "utf8"),
      );
    }
  }
}
for (const top of ["apps", "packages", "infra"]) await walk(join(root, top));

const errors = [];
const ids = new Set();
for (const entry of registry.entries) {
  if (typeof entry.id !== "string" || entry.id.length === 0 || ids.has(entry.id)) {
    errors.push(`duplicate or invalid registry id: ${String(entry.id)}`);
    continue;
  }
  ids.add(entry.id);
  if (!knownStates.has(entry.state)) {
    errors.push(`${entry.id}: unknown state ${String(entry.state)}`);
  }
  if (typeof entry.path !== "string" || typeof entry.sentinel !== "string") {
    errors.push(`${entry.id}: path and sentinel must be strings`);
    continue;
  }
  const content = sourceFiles.get(entry.path);
  if (content === undefined) {
    errors.push(`${entry.id}: registered source path is missing: ${entry.path}`);
    continue;
  }
  if (!content.toLowerCase().includes(entry.sentinel.toLowerCase())) {
    errors.push(`${entry.id}: stale sentinel in ${entry.path}: ${entry.sentinel}`);
  }
  if (entry.state === "IMPLEMENTED_NOT_LIVE" && !entry.sentinel.startsWith(implementedPrefix)) {
    errors.push(`${entry.id}: IMPLEMENTED_NOT_LIVE entries require an explicit ${implementedPrefix} marker`);
  }
  if (entry.state === "SCAFFOLD_FAIL_CLOSED" && entry.sentinel.startsWith(implementedPrefix)) {
    errors.push(`${entry.id}: fail-closed scaffold cannot use an implemented marker`);
  }
  if (entry.state === "LIVE_QUALIFIED") {
    const evidence = Array.isArray(entry.completion_evidence) ? entry.completion_evidence : [];
    if (evidence.length === 0 || evidence.some((item) => /not executed|mock/i.test(String(item)))) {
      errors.push(`${entry.id}: LIVE_QUALIFIED requires real non-mock completion evidence`);
    }
  }
}

for (const [path, content] of sourceFiles) {
  const lower = content.toLowerCase();
  for (const sentinel of pendingSentinels) {
    if (!lower.includes(sentinel.toLowerCase())) continue;
    const registered = registry.entries.some((entry) =>
      entry.path === path &&
      entry.state === "SCAFFOLD_FAIL_CLOSED" &&
      lower.includes(entry.sentinel.toLowerCase())
    );
    if (!registered) errors.push(`${path}: unregistered fail-closed contour: ${sentinel}`);
  }
  if (content.includes(implementedPrefix)) {
    const registered = registry.entries.some((entry) =>
      entry.path === path &&
      entry.state === "IMPLEMENTED_NOT_LIVE" &&
      content.includes(entry.sentinel)
    );
    if (!registered) errors.push(`${path}: unregistered ${implementedPrefix} contour`);
  }
}

if (errors.length > 0) {
  console.error(JSON.stringify({ errors }, null, 2));
  process.exitCode = 1;
} else {
  const counts = Object.fromEntries(registry.states.map((state) => [
    state,
    registry.entries.filter((entry) => entry.state === state).length,
  ]));
  console.log(`implementation status: ${registry.entries.length} contours registered ${JSON.stringify(counts)}`);
}
