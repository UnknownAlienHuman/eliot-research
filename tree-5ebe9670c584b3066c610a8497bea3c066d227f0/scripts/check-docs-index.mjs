// Documentation indexes are load-bearing: an agent that cannot find a document behaves as if the
// document does not exist. This gate fails when a document is unindexed, when an index link is
// broken, or when an entry point stops pointing at docs/START-HERE.md.
//
// It deliberately checks reachability, not prose quality.

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve, posix } from "node:path";

const root = resolve(import.meta.dirname, "..");
const errors = [];

function read(relPath) {
  return readFileSync(join(root, relPath), "utf8");
}

function walk(relDir, predicate) {
  const out = [];
  const absolute = join(root, relDir);
  for (const entry of readdirSync(absolute, { withFileTypes: true })) {
    const child = posix.join(relDir, entry.name);
    if (entry.isDirectory()) out.push(...walk(child, predicate));
    else if (predicate(entry.name)) out.push(child);
  }
  return out;
}

function linkTargets(markdown) {
  const targets = [];
  for (const match of markdown.matchAll(/\]\(([^)\s]+)\)/gu)) targets.push(match[1]);
  return targets;
}

// 1. Every implementation document is reachable from its own index.
{
  const indexPath = "docs/implementation/README.md";
  const index = read(indexPath);
  const documents = walk("docs/implementation", (name) => name.endsWith(".md") || name.endsWith(".json"));
  for (const document of documents) {
    if (document === indexPath) continue;
    const linked = relative("docs/implementation", document).split("\\").join("/");
    if (!index.includes(`(${linked})`)) {
      errors.push(`${indexPath}: does not link ${document}`);
    }
  }
}

// 2. Every work packet is reachable from the packet index, manifest and additive fragments alike.
{
  const indexPath = "docs/agent-work/README.md";
  const index = read(indexPath);
  const ids = JSON.parse(read("docs/agent-work/manifest.json")).packets.map((packet) => packet.id);
  for (const name of readdirSync(join(root, "docs/agent-work/packets"))) {
    if (!name.endsWith(".json")) continue;
    const fragment = JSON.parse(read(posix.join("docs/agent-work/packets", name)));
    ids.push((fragment.packet ?? fragment).id);
  }
  for (const id of ids) {
    if (!index.includes(`[${id}]`)) errors.push(`${indexPath}: does not list packet ${id}`);
  }
}

// 3. Every docs/ subdirectory is reachable from the docs index.
{
  const indexPath = "docs/README.md";
  const index = read(indexPath);
  for (const entry of readdirSync(join(root, "docs"), { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    if (!index.includes(`${entry.name}/`)) errors.push(`${indexPath}: does not list docs/${entry.name}/`);
  }
}

// 4. The entry points keep pointing at the entry point.
{
  const expected = [
    ["README.md", "docs/START-HERE.md"],
    ["AGENTS.md", "docs/START-HERE.md"],
    ["docs/README.md", "START-HERE.md"],
    ["docs/agent-work/README.md", "../START-HERE.md"],
    ["docs/implementation/README.md", "../START-HERE.md"],
    ["docs/implementation/launch-prs/README.md", "../../START-HERE.md"],
    ["docs/implementation/launch-prs/agent-start.md", "../../START-HERE.md"],
  ];
  for (const [file, target] of expected) {
    if (!read(file).includes(`(${target})`)) errors.push(`${file}: must link ${target}`);
  }
}

// 5. Every link in an index resolves to something that exists.
{
  const indexes = [
    "README.md",
    "AGENTS.md",
    "docs/README.md",
    "docs/START-HERE.md",
    "docs/agent-work/README.md",
    "docs/implementation/README.md",
    "docs/implementation/launch-prs/README.md",
    "docs/implementation/launch-prs/agent-start.md",
  ];
  for (const index of indexes) {
    const directory = index.includes("/") ? index.slice(0, index.lastIndexOf("/")) : ".";
    for (const target of linkTargets(read(index))) {
      if (/^[a-z][a-z0-9+.-]*:/iu.test(target) || target.startsWith("#")) continue;
      const clean = target.split("#")[0];
      if (clean === "") continue;
      const candidate = join(root, directory, clean);
      try {
        statSync(candidate);
      } catch {
        errors.push(`${index}: broken link ${target}`);
      }
    }
  }
}

if (errors.length > 0) {
  for (const error of errors) console.error(`documentation index: ${error}`);
  console.error(`\n${errors.length} documentation index problem(s).`);
  console.error("An unindexed document is unreachable. Add it to its index rather than deleting this gate.");
  process.exit(1);
}

console.log("Documentation indexes valid: every document, packet and docs/ directory is reachable, every index link resolves.");
