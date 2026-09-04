import { readFile, readdir } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const agentWorkDirectory = resolve(root, "docs/agent-work");
const manifestPath = resolve(agentWorkDirectory, "manifest.json");
const fragmentsDirectory = resolve(agentWorkDirectory, "packets");
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

function duplicateValues(values) {
  const seen = new Set();
  const duplicates = new Set();
  for (const value of values) {
    if (seen.has(value)) duplicates.add(value);
    seen.add(value);
  }
  return [...duplicates].sort();
}

function parseDocumentOwnedPaths(packetId, documentName, markdown) {
  const lines = markdown.split(/\r?\n/u);
  const headingIndexes = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (lines[index] === "## Owned paths") headingIndexes.push(index);
  }
  if (headingIndexes.length !== 1) {
    errors.push(
      `${packetId}: ${documentName} must contain exactly one \"## Owned paths\" heading`,
    );
    return null;
  }

  const paths = [];
  const headingIndex = headingIndexes[0];
  for (let index = headingIndex + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (/^##(?:\s|$)/u.test(line)) break;
    if (line.trim() === "") continue;

    const match = /^- `([^`]+)`$/u.exec(line);
    if (match !== null) {
      paths.push(match[1]);
      continue;
    }

    if (line.startsWith("- ") || paths.length === 0) {
      errors.push(
        `${packetId}: ${documentName}:${index + 1} has malformed owned-path entry`,
      );
      continue;
    }

    // Packet documents may explain cross-packet handoffs directly after the
    // bullet block. Once at least one exact path was parsed, ordinary prose
    // terminates the machine-readable owned-path section.
    break;
  }

  if (paths.length === 0) {
    errors.push(`${packetId}: ${documentName} has no documented owned paths`);
    return null;
  }
  for (const duplicate of duplicateValues(paths)) {
    errors.push(`${packetId}: duplicate documented owned path: ${duplicate}`);
  }
  return paths;
}

function compareDocumentOwnedPaths(packet, documentPaths) {
  const manifestPaths = packet.owned_paths;
  const manifestSet = new Set(manifestPaths);
  const documentSet = new Set(documentPaths);
  for (const path of manifestPaths) {
    if (!documentSet.has(path)) {
      errors.push(`${packet.id}: manifest owns path absent from packet document: ${path}`);
    }
  }
  for (const path of documentPaths) {
    if (!manifestSet.has(path)) {
      errors.push(`${packet.id}: packet document owns path absent from manifest: ${path}`);
    }
  }
  const sameOrder = manifestPaths.every(
    (path, index) => path === documentPaths[index],
  );
  if (
    manifestPaths.length === documentPaths.length &&
    !sameOrder &&
    manifestPaths.every((path) => documentSet.has(path))
  ) {
    errors.push(`${packet.id}: manifest and packet document owned paths use different order`);
  }
}

async function validatePacketDocument(packet) {
  if (typeof packet.document !== "string" || packet.document.length === 0) {
    errors.push(`${packet.id}: missing packet document name`);
    return;
  }
  const documentPath = resolve(agentWorkDirectory, packet.document);
  const relativeDocumentPath = relative(agentWorkDirectory, documentPath);
  if (
    relativeDocumentPath === "" ||
    relativeDocumentPath.startsWith("..") ||
    isAbsolute(relativeDocumentPath)
  ) {
    errors.push(`${packet.id}: packet document escapes docs/agent-work`);
    return;
  }

  let markdown;
  try {
    markdown = await readFile(documentPath, "utf8");
  } catch {
    errors.push(`${packet.id}: missing packet document ${packet.document}`);
    return;
  }
  const documentPaths = parseDocumentOwnedPaths(
    packet.id,
    packet.document,
    markdown,
  );
  if (documentPaths !== null && Array.isArray(packet.owned_paths)) {
    compareDocumentOwnedPaths(packet, documentPaths);
  }
}

const packetList = [...(manifest.packets ?? []), ...await loadFragments()];
const ids = new Set();
const packets = new Map();
for (const packet of packetList) {
  if (ids.has(packet.id)) errors.push(`duplicate packet id: ${packet.id}`);
  ids.add(packet.id);
  packets.set(packet.id, packet);
  if (!Array.isArray(packet.owned_paths) || packet.owned_paths.length === 0) {
    errors.push(`${packet.id}: no owned_paths`);
  } else {
    for (const duplicate of duplicateValues(packet.owned_paths)) {
      errors.push(`${packet.id}: duplicate manifest owned path: ${duplicate}`);
    }
  }
  if (!packet.mandatory_negative_case) errors.push(`${packet.id}: no mandatory negative case`);
  if ((packet.max_package_source_lines ?? Infinity) > 10_000) errors.push(`${packet.id}: package line limit > 10000`);
  await validatePacketDocument(packet);
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
  for (const path of packet.owned_paths ?? []) claims.push({ id: packet.id, path });
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
console.log(`Work packet manifest valid: ${packets.size} packets, ${claims.length} exclusive path claims, acyclic DAG, packet documents synchronized.`);
