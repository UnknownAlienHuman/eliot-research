import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

// Registration must be discovered from the live workspace inventory and the
// TypeScript reference graph, never assumed. These checks fail closed so a new
// package, a renamed owner, a duplicate/shadowed rule, or an unregistered root
// is a hard boundary error instead of silent non-coverage.
export function normalizeRootPath(value) {
  return String(value).split("\\").join("/").replace(/^\.\//u, "").replace(/\/+$/u, "");
}

export function parsePackageRuleKeys(source) {
  const marker = "const PACKAGE_RULES = new Map([";
  const start = source.indexOf(marker);
  if (start < 0) return [];
  const open = start + marker.length - 1;
  let depth = 0;
  let index = open;
  let quote = null;
  for (; index < source.length; index += 1) {
    const character = source[index];
    if (quote) {
      if (character === "\\") index += 1;
      else if (character === quote) quote = null;
      continue;
    }
    if (character === "\"" || character === "'") quote = character;
    else if (character === "[" || character === "{" || character === "(") depth += 1;
    else if (character === "]" || character === "}" || character === ")") {
      depth -= 1;
      if (depth === 0) break;
    }
  }
  const body = source.slice(open + 1, index);
  const keys = [];
  let entryDepth = 0;
  let entryIndex = -1;
  let cursor = 0;
  while (cursor < body.length) {
    const character = body[cursor];
    if (entryDepth === 1 && entryIndex < 0 && (character === "\"" || character === "'")) {
      entryIndex = cursor + 1;
      cursor += 1;
      continue;
    }
    if (entryDepth === 1 && entryIndex >= 0 && character === body[entryIndex - 1]) {
      keys.push(body.slice(entryIndex, cursor));
      entryIndex = -1;
      cursor += 1;
      continue;
    }
    if (character === "[") entryDepth += 1;
    if (character === "]") entryDepth -= 1;
    cursor += 1;
  }
  return keys;
}

export async function discoverRegistrationDefects(root, sourceRoots, ruleKeys, hasRule) {
  const defects = [];
  if (ruleKeys.size === 0) {
    defects.push("No boundary rules could be parsed from this gate");
    return defects;
  }
  let referenced;
  try {
    const tsconfig = JSON.parse(await readFile(join(root, "tsconfig.json"), "utf8"));
    referenced = Array.isArray(tsconfig.references) ? tsconfig.references : [];
  } catch {
    defects.push("tsconfig.json could not be read for registration discovery");
    return defects;
  }
  const resolvedReferences = new Set();
  for (const reference of referenced) {
    const raw = reference?.path;
    if (typeof raw !== "string" || raw.trim().length === 0) {
      defects.push("tsconfig.json declares a reference without a usable path");
      continue;
    }
    const normalized = normalizeRootPath(raw);
    if (normalized.startsWith("..") || normalized.startsWith("/") || /^[A-Za-z]:/u.test(normalized)) {
      defects.push("tsconfig.json reference escapes the repository: " + normalized);
      continue;
    }
    resolvedReferences.add(normalized);
    if (!ruleKeys.has(normalized)) {
      defects.push("TypeScript-referenced workspace root has no boundary rule: " + normalized);
    }
  }
  const owners = [...ruleKeys].sort((left, right) => left.length - right.length);
  for (const sourceRoot of sourceRoots) {
    let entries;
    try {
      entries = await readdir(join(root, sourceRoot), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const name = sourceRoot + "/" + entry.name;
      let manifest;
      try {
        manifest = JSON.parse(await readFile(join(root, name, "package.json"), "utf8"));
      } catch {
        continue;
      }
      const packageName = manifest?.name;
      if (typeof packageName !== "string" || packageName.length === 0) continue;
      if (!ruleKeys.has(name)) {
        defects.push("Workspace package " + packageName + " has no boundary rule: " + name);
        continue;
      }
      if (resolvedReferences.has(name) && hasRule(name).size === 0) {
        defects.push("Boundary rule is empty and enforces no dependency direction: " + name);
      }
      for (const owner of owners) {
        if (owner !== name && owner.length < name.length && name.startsWith(owner + "/")) {
          defects.push("Boundary rule " + owner + " shadows " + name);
        }
      }
    }
  }
  return defects;
}
