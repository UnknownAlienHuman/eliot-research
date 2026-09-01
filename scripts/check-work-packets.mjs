import { readFile, readdir } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const agentWorkDirectory = resolve(root, "docs/agent-work");
const manifestPath = resolve(agentWorkDirectory, "manifest.json");
const fragmentsDirectory = resolve(agentWorkDirectory, "packets");
const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
const errors = [];

if (manifest.protocol !== "eliotr.agent-work.v1") errors.push("unexpected manifest protocol");
if (!/^[a-f0-9]{40}$/u.test(manifest.baseline_commit ?? "")) {
  errors.push("baseline_commit must be a full SHA");
}
if (
  typeof manifest.generated_at !== "string" ||
  Number.isNaN(Date.parse(manifest.generated_at)) ||
  !manifest.generated_at.endsWith("Z")
) {
  errors.push("generated_at must be an ISO-8601 UTC timestamp");
}

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

function documentPath(packet) {
  if (typeof packet.document !== "string" || packet.document.length === 0) {
    errors.push(`${packet.id}: missing packet document`);
    return undefined;
  }
  const path = resolve(agentWorkDirectory, packet.document);
  if (!path.startsWith(`${agentWorkDirectory}${sep}`)) {
    errors.push(`${packet.id}: packet document escapes docs/agent-work`);
    return undefined;
  }
  return path;
}

function ownedPathsFromDocument(markdown, packetId) {
  const lines = markdown.split(/\r?\n/u);
  const headingIndex = lines.findIndex((line) => line.trim() === "## Owned paths");
  if (headingIndex < 0) {
    errors.push(`${packetId}: packet document has no ## Owned paths section`);
    return [];
  }

  const paths = [];
  for (const line of lines.slice(headingIndex + 1)) {
    if (/^##\s+/u.test(line)) break;
    if (line.trim().length === 0) continue;

    const match = /^- `([^`]+)`\s*$/u.exec(line);
    if (match?.[1] !== undefined) {
      paths.push(match[1]);
      continue;
    }
    if (line.startsWith("-")) {
      errors.push(`${packetId}: malformed owned-path bullet in packet document: ${line}`);
    }
  }

  if (paths.length === 0) errors.push(`${packetId}: packet document has no owned paths`);
  const duplicates = paths.filter((path, index) => paths.indexOf(path) !== index);
  for (const duplicate of new Set(duplicates)) {
    errors.push(`${packetId}: duplicate owned path in packet document: ${duplicate}`);
  }
  return paths;
}

function compareOwnedPaths(packet, documentedPaths) {
  const manifestPaths = packet.owned_paths;
  if (!Array.isArray(manifestPaths)) return;

  const length = Math.max(manifestPaths.length, documentedPaths.length);
  for (let index = 0; index < length; index += 1) {
    if (manifestPaths[index] !== documentedPaths[index]) {
      errors.push(
        `${packet.id}: owned_paths drift at index ${index}: manifest=${JSON.stringify(
          manifestPaths[index],
        )} document=${JSON.stringify(documentedPaths[index])}`,
      );
    }
  }
}

const packetList = [...(manifest.packets ?? []), ...(await loadFragments())];
const ids = new Set();
const packets = new Map();

for (const packet of packetList) {
  if (typeof packet.id !== "string" || packet.id.length === 0) {
    errors.push("packet without a valid id");
    continue;
  }
  if (ids.has(packet.id)) errors.push(`duplicate packet id: ${packet.id}`);
  ids.add(packet.id);
  packets.set(packet.id, packet);

  if (!Array.isArray(packet.owned_paths) || packet.owned_paths.length === 0) {
    errors.push(`${packet.id}: no owned_paths`);
  } else {
    const duplicates = packet.owned_paths.filter(
      (path, index) => packet.owned_paths.indexOf(path) !== index,
    );
    for (const duplicate of new Set(duplicates)) {
      errors.push(`${packet.id}: duplicate owned path in manifest: ${duplicate}`);
    }
  }
  if (!packet.mandatory_negative_case) errors.push(`${packet.id}: no mandatory negative case`);
  if ((packet.max_package_source_lines ?? Infinity) > 10_000) {
    errors.push(`${packet.id}: package line limit > 10000`);
  }

  const path = documentPath(packet);
  if (path !== undefined) {
    try {
      const markdown = await readFile(path, "utf8");
      compareOwnedPaths(packet, ownedPathsFromDocument(markdown, packet.id));
    } catch (error) {
      if (error?.code === "ENOENT") errors.push(`${packet.id}: missing packet document ${packet.document}`);
      else throw error;
    }
  }
}

for (const packet of packetList) {
  for (const dependency of packet.depends_on ?? []) {
    if (!packets.has(dependency)) errors.push(`${packet.id}: unknown dependency ${dependency}`);
    if (dependency === packet.id) errors.push(`${packet.id}: self dependency`);
  }
}

function patternKind(pattern) {
  if (pattern.endsWith("/**")) {
    return { broad: true, prefix: pattern.slice(0, -3).replace(/\/$/u, "") };
  }
  if (pattern.includes("*")) {
    return {
      broad: true,
      prefix: pattern.slice(0, pattern.indexOf("*")).replace(/\/$/u, ""),
    };
  }
  return { broad: false, prefix: pattern };
}

function patternsOverlap(left, right) {
  const a = patternKind(left);
  const b = patternKind(right);
  if (!a.broad && !b.broad) return a.prefix === b.prefix;
  if (a.broad && b.broad) {
    return (
      a.prefix === b.prefix ||
      a.prefix.startsWith(`${b.prefix}/`) ||
      b.prefix.startsWith(`${a.prefix}/`)
    );
  }
  const broad = a.broad ? a : b;
  const exact = a.broad ? b : a;
  return exact.prefix === broad.prefix || exact.prefix.startsWith(`${broad.prefix}/`);
}

const claims = [];
for (const packet of packetList) {
  for (const path of packet.owned_paths ?? []) claims.push({ id: packet.id, path });
}
for (let left = 0; left < claims.length; left += 1) {
  for (let right = left + 1; right < claims.length; right += 1) {
    if (
      claims[left].id !== claims[right].id &&
      patternsOverlap(claims[left].path, claims[right].path)
    ) {
      errors.push(
        `owned path overlap: ${claims[left].id}:${claims[left].path} <-> ${claims[right].id}:${claims[right].path}`,
      );
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
console.log(
  `Work packet manifest valid: ${packets.size} packets, ${claims.length} exclusive path claims, exact document parity, acyclic DAG.`,
);
