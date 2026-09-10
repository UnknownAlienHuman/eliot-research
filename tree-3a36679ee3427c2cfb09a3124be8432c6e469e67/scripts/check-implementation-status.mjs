import { readFile, readdir } from "node:fs/promises";
import { extname, join, relative } from "node:path";
import process from "node:process";

const root = process.cwd();
const registryPath = join(root, "docs/implementation/implementation-status.json");
const registry = JSON.parse(await readFile(registryPath, "utf8"));
const expectedProtocol = "eliotr.implementation-status.v1";
const allowedStates = new Set([
  "SCAFFOLD_FAIL_CLOSED",
  "IN_PROGRESS",
  "IMPLEMENTED_NOT_LIVE",
  "LIVE_QUALIFIED",
]);
const extensions = new Set([".ts", ".tsx", ".mjs", ".js"]);
const ignored = new Set(["node_modules", "dist", "dist-types", "coverage", ".wrangler"]);
const markerPattern = /^\s*\/\/\s*(SCAFFOLD_FAIL_CLOSED|IN_PROGRESS|IMPLEMENTED_NOT_LIVE|LIVE_QUALIFIED):\s+([^\r\n]+?)\s*$/gmu;
const pendingStatePattern = /\bIMPLEMENTATION_PENDING\b/u;
const sourceFiles = new Map();
const errors = [];

if (registry.protocol !== expectedProtocol) errors.push(`unknown implementation-status protocol: ${String(registry.protocol)}`);
if (!Array.isArray(registry.states) || !Array.isArray(registry.entries)) {
  throw new Error("implementation-status registry must declare states and entries");
}
if (registry.states.length !== allowedStates.size || registry.states.some((state) => !allowedStates.has(state))) {
  errors.push("registry states do not match the implementation-status protocol");
}
if (!/^[a-f0-9]{40}$/u.test(registry.baseline_commit ?? "")) {
  errors.push("baseline_commit must be a full lowercase commit SHA");
}

async function walk(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (ignored.has(entry.name)) continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) await walk(path);
    else if (extensions.has(extname(entry.name))) {
      sourceFiles.set(relative(root, path).replaceAll("\\", "/"), await readFile(path, "utf8"));
    }
  }
}
for (const top of ["apps", "packages", "infra"]) await walk(join(root, top));

function markersIn(content) {
  const markers = [];
  markerPattern.lastIndex = 0;
  for (const match of content.matchAll(markerPattern)) {
    const state = match[1];
    const detail = match[2]?.trim();
    if (state !== undefined && detail !== undefined) markers.push({ state, sentinel: `${state}: ${detail}` });
  }
  return markers;
}

const ids = new Set();
const registrations = new Set();
for (const entry of registry.entries) {
  if (typeof entry.id !== "string" || entry.id.length === 0 || ids.has(entry.id)) {
    errors.push(`duplicate or invalid registry id: ${String(entry.id)}`);
    continue;
  }
  ids.add(entry.id);
  if (!allowedStates.has(entry.state)) errors.push(`${entry.id}: unknown state ${String(entry.state)}`);
  if (typeof entry.path !== "string" || entry.path.length === 0 || typeof entry.sentinel !== "string") {
    errors.push(`${entry.id}: path and sentinel must be non-empty strings`);
    continue;
  }
  const key = `${entry.path}\u0000${entry.sentinel}`;
  if (registrations.has(key)) errors.push(`${entry.id}: duplicate path/sentinel registration`);
  registrations.add(key);
  const expectedPrefix = `${entry.state}:`;
  if (!entry.sentinel.startsWith(expectedPrefix)) {
    errors.push(`${entry.id}: sentinel must begin with ${expectedPrefix}`);
  }
  if (!Array.isArray(entry.owner_packets) || entry.owner_packets.length === 0 ||
      entry.owner_packets.some((packet) => typeof packet !== "string" || packet.length === 0)) {
    errors.push(`${entry.id}: owner_packets must contain at least one packet ID`);
  }
  if (typeof entry.behavior !== "string" || entry.behavior.trim().length === 0) {
    errors.push(`${entry.id}: behavior must be a non-empty string`);
  }
  const evidence = Array.isArray(entry.completion_evidence) ? entry.completion_evidence : [];
  if (evidence.length === 0 || evidence.some((item) => typeof item !== "string" || item.trim().length === 0)) {
    errors.push(`${entry.id}: completion_evidence must contain non-empty strings`);
  }
  if (entry.state === "LIVE_QUALIFIED" && evidence.some((item) => /not executed|mock/i.test(item))) {
    errors.push(`${entry.id}: LIVE_QUALIFIED requires real non-mock completion evidence`);
  }
  const content = sourceFiles.get(entry.path);
  if (content === undefined) {
    errors.push(`${entry.id}: registered source path is missing: ${entry.path}`);
    continue;
  }
  const markers = markersIn(content);
  if (!markers.some((marker) => marker.state === entry.state && marker.sentinel === entry.sentinel)) {
    errors.push(`${entry.id}: stale or missing exact marker in ${entry.path}: ${entry.sentinel}`);
  }
}

for (const [path, content] of sourceFiles) {
  const markers = markersIn(content);
  for (const marker of markers) {
    const key = `${path}\u0000${marker.sentinel}`;
    if (!registrations.has(key)) errors.push(`${path}: unregistered implementation marker: ${marker.sentinel}`);
  }
  if (
    pendingStatePattern.test(content) &&
    !markers.some((marker) => marker.state === "SCAFFOLD_FAIL_CLOSED")
  ) {
    errors.push(
      `${path}: runtime IMPLEMENTATION_PENDING state lacks a registered SCAFFOLD_FAIL_CLOSED marker`,
    );
  }
}

if (errors.length > 0) {
  console.error(JSON.stringify({ errors }, null, 2));
  process.exitCode = 1;
} else {
  const counts = Object.fromEntries([...allowedStates].map((state) => [
    state,
    registry.entries.filter((entry) => entry.state === state).length,
  ]));
  console.log(`implementation status: ${registry.entries.length} exact contours registered ${JSON.stringify(counts)}`);
}
