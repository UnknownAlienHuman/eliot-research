import { readFile, readdir, stat } from "node:fs/promises";
import { extname, join, relative, resolve, sep } from "node:path";
import process from "node:process";

const root = process.cwd();
const registryPath = join(root, "docs/implementation/implementation-status.json");
const manifestPath = join(root, "docs/agent-work/manifest.json");
const registry = JSON.parse(await readFile(registryPath, "utf8"));
const manifest = JSON.parse(await readFile(manifestPath, "utf8"));

const errors = [];
if (registry.protocol !== "eliotr.implementation-status.v1") {
  errors.push("unknown implementation-status protocol");
}
if (!/^[a-f0-9]{40}$/.test(registry.baseline_commit ?? "")) {
  errors.push("baseline_commit must be a full lowercase Git commit SHA");
}
if (!Array.isArray(registry.entries)) errors.push("entries must be an array");

const allowedStates = new Set([
  "SCAFFOLD_FAIL_CLOSED",
  "IN_PROGRESS",
  "IMPLEMENTED_NOT_LIVE",
  "LIVE_QUALIFIED",
]);
const packetIds = new Set((manifest.packets ?? []).map((packet) => packet.id));
const seenIds = new Set();
const seenKeys = new Set();

function registryKey(entry) {
  return `${entry.path}\u0000${String(entry.sentinel).toLowerCase()}`;
}

for (const entry of registry.entries ?? []) {
  if (typeof entry.id !== "string" || entry.id.length === 0) {
    errors.push("every registry entry requires an id");
  } else if (seenIds.has(entry.id)) {
    errors.push(`duplicate registry id: ${entry.id}`);
  } else {
    seenIds.add(entry.id);
  }

  if (typeof entry.path !== "string" || entry.path.length === 0) {
    errors.push(`${entry.id ?? "<unknown>"}: path is required`);
  } else {
    const absolute = resolve(root, entry.path);
    if (absolute !== root && !absolute.startsWith(`${root}${sep}`)) {
      errors.push(`${entry.id}: path escapes repository root`);
    }
  }
  if (typeof entry.sentinel !== "string" || entry.sentinel.length === 0) {
    errors.push(`${entry.id}: sentinel is required`);
  }
  if (!allowedStates.has(entry.state)) {
    errors.push(`${entry.id}: unknown state ${String(entry.state)}`);
  }

  const key = registryKey(entry);
  if (seenKeys.has(key)) errors.push(`${entry.id}: duplicate path/sentinel registration`);
  seenKeys.add(key);

  if (!Array.isArray(entry.owner_packets) || entry.owner_packets.length === 0) {
    errors.push(`${entry.id}: owner_packets must name at least one work packet`);
  } else {
    for (const packetId of entry.owner_packets) {
      if (!packetIds.has(packetId)) errors.push(`${entry.id}: unknown owner packet ${packetId}`);
    }
  }
  if (!Array.isArray(entry.completion_evidence) || entry.completion_evidence.length === 0) {
    errors.push(`${entry.id}: completion_evidence must not be empty`);
  }
  if (
    entry.state === "LIVE_QUALIFIED" &&
    (!Array.isArray(entry.receipt_refs) || entry.receipt_refs.length === 0)
  ) {
    errors.push(`${entry.id}: LIVE_QUALIFIED requires receipt_refs`);
  }
}

const sentinels = [...new Set((registry.entries ?? []).map((entry) => entry.sentinel))];
const extensions = new Set([".ts", ".tsx", ".mjs", ".js"]);
const ignored = new Set(["node_modules", "dist", "dist-types", "coverage", ".wrangler"]);
const found = [];

async function walk(directory) {
  try {
    if (!(await stat(directory)).isDirectory()) return;
  } catch {
    return;
  }
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (ignored.has(entry.name)) continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      await walk(path);
      continue;
    }
    if (!extensions.has(extname(entry.name))) continue;
    const content = await readFile(path, "utf8");
    const folded = content.toLowerCase();
    for (const sentinel of sentinels) {
      if (folded.includes(String(sentinel).toLowerCase())) {
        found.push({ path: relative(root, path).replaceAll("\\", "/"), sentinel });
      }
    }
  }
}

for (const top of ["apps", "packages", "infra"]) await walk(join(root, top));

const actual = new Map(found.map((entry) => [registryKey(entry), entry]));
const registered = new Map((registry.entries ?? []).map((entry) => [registryKey(entry), entry]));
const unregistered = [...actual.keys()].filter((item) => !registered.has(item));
const stale = [...registered.keys()].filter((item) => !actual.has(item));
if (unregistered.length > 0) errors.push(`unregistered sentinels: ${JSON.stringify(unregistered)}`);
if (stale.length > 0) errors.push(`stale registrations: ${JSON.stringify(stale)}`);

if (errors.length > 0) {
  console.error(JSON.stringify({ errors, unregistered, stale }, null, 2));
  process.exitCode = 1;
} else {
  console.log(
    `implementation status: ${actual.size} fail-closed contours registered; ` +
    `${seenIds.size} unique entries; owner packets valid`,
  );
}
