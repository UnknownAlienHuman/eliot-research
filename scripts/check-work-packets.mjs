import { access, readFile, readdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const manifestPath = resolve(root, "docs/agent-work/manifest.json");
const fragmentsDirectory = resolve(root, "docs/agent-work/packets");
const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
const errors = [];

if (manifest.protocol !== "eliotr.agent-work.v1") errors.push("unexpected manifest protocol");
if (!/^[a-f0-9]{40}$/.test(manifest.baseline_commit ?? "")) errors.push("baseline_commit must be a full SHA");

async function loadFragments() {
  let names;
  try {
    names = (await readdir(fragmentsDirectory)).filter((name) => name.endsWith(".json")).sort();
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
  const packets = [];
  for (const name of names) {
    const path = resolve(fragmentsDirectory, name);
    let fragment;
    try {
      fragment = JSON.parse(await readFile(path, "utf8"));
    } catch (error) {
      errors.push(`${name}: invalid JSON: ${error.message}`);
      continue;
    }
    if (fragment.protocol !== "eliotr.agent-work.packet.v1") {
      errors.push(`${name}: unexpected fragment protocol`);
      continue;
    }
    if (typeof fragment.packet !== "object" || fragment.packet === null || Array.isArray(fragment.packet)) {
      errors.push(`${name}: packet must be an object`);
      continue;
    }
    packets.push(fragment.packet);
  }
  return packets;
}

const packetList = [...(manifest.packets ?? []), ...await loadFragments()];
const ids = new Set();
const packets = new Map();
for (const packet of packetList) {
  if (ids.has(packet.id)) errors.push(`duplicate packet id: ${packet.id}`);
  ids.add(packet.id);
  packets.set(packet.id, packet);
  if (!Array.isArray(packet.owned_paths) || packet.owned_paths.length === 0) errors.push(`${packet.id}: no owned_paths`);
  if (!packet.mandatory_negative_case) errors.push(`${packet.id}: no mandatory negative case`);
  if ((packet.max_package_source_lines ?? Infinity) > 10_000) errors.push(`${packet.id}: package line limit > 10000`);
  try {
    await access(resolve(root, "docs/agent-work", packet.document));
  } catch {
    errors.push(`${packet.id}: missing packet document ${packet.document}`);
  }
}

for (const packet of packetList) {
  for (const dependency of packet.depends_on ?? []) {
    if (!packets.has(dependency)) errors.push(`${packet.id}: unknown dependency ${dependency}`);
    if (dependency === packet.id) errors.push(`${packet.id}: self dependency`);
  }
}

function patternKind(pattern) {
  if (pattern.endsWith("/**")) return { broad: true, prefix: pattern.slice(0, -3).replace(/\/$/, "") };
  if (pattern.includes("*")) return { broad: true, prefix: pattern.slice(0, pattern.indexOf("*")).replace(/\/$/, "") };
  return { broad: false, prefix: pattern };
}
function patternsOverlap(left, right) {
  const a = patternKind(left);
  const b = patternKind(right);
  if (!a.broad && !b.broad) return a.prefix === b.prefix;
  if (a.broad && b.broad) {
    return a.prefix === b.prefix || a.prefix.startsWith(`${b.prefix}/`) || b.prefix.startsWith(`${a.prefix}/`);
  }
  const broad = a.broad ? a : b;
  const exact = a.broad ? b : a;
  return exact.prefix === broad.prefix || exact.prefix.startsWith(`${broad.prefix}/`);
}

const claims = [];
for (const packet of packetList) {
  for (const path of packet.owned_paths) claims.push({ id: packet.id, path });
}
for (let i = 0; i < claims.length; i += 1) {
  for (let j = i + 1; j < claims.length; j += 1) {
    if (claims[i].id !== claims[j].id && patternsOverlap(claims[i].path, claims[j].path)) {
      errors.push(`owned path overlap: ${claims[i].id}:${claims[i].path} <-> ${claims[j].id}:${claims[j].path}`);
    }
  }
}

const visiting = new Set();
const visited = new Set();
function visit(id, stack) {
  if (visited.has(id)) return;
  if (visiting.has(id)) {
    errors.push(`dependency cycle: ${[...stack, id].join(" -> ")}`);
    return;
  }
  visiting.add(id);
  const packet = packets.get(id);
  for (const dependency of packet?.depends_on ?? []) visit(dependency, [...stack, id]);
  visiting.delete(id);
  visited.add(id);
}
for (const id of packets.keys()) visit(id, []);

if (errors.length > 0) {
  console.error(errors.map((error) => `- ${error}`).join("\n"));
  process.exit(1);
}
console.log(`Work packet manifest valid: ${packets.size} packets, ${claims.length} exclusive path claims, acyclic DAG.`);
