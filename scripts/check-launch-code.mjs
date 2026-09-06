import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
// ELIOT_RESEARCH §§0, 12.12, 18–19: optional integrations cannot replace these products.
const requiredSlices = new Set(["RETRIEVAL", "RESEARCH", "FEDERATION", "WIKI", "DRIVE_EXCHANGE", "ERASURE"]);
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
  // Load the already pinned compiler only when checking a release, not at module import.
  // Parsing excludes comments/string examples and refuses dynamic declarations instead of guessing.
  const ts = require("typescript");
  const source = ts.createSourceFile("composition-root.ts", composition, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  if (source.parseDiagnostics.length) throw new Error("Launch composition cannot be parsed");
  let declarations = 0;
  const visit = (node) => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "unavailable") {
      if (node.arguments.length !== 1 || !ts.isStringLiteral(node.arguments[0])) {
        throw new Error("Dynamic unavailable operation requires launch-gate review");
      }
      blockers.push(node.arguments[0].text);
    }
    if (ts.isPropertyAssignment(node) &&
        (ts.isIdentifier(node.name) || ts.isStringLiteral(node.name)) && node.name.text === "disabled_slices") {
      declarations += 1;
      if (!ts.isArrayLiteralExpression(node.initializer)) throw new Error("Dynamic disabled slices require launch-gate review");
      const seen = new Set();
      for (const item of node.initializer.elements) {
        if (!ts.isStringLiteral(item) || !/^[A-Z][A-Z0-9_]{0,63}$/u.test(item.text) || seen.has(item.text)) {
          throw new Error("Invalid or duplicate disabled slice");
        }
        seen.add(item.text);
        if (requiredSlices.has(item.text)) blockers.push(`disabled required slice: ${item.text}`);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  if (declarations !== 1) throw new Error("Expected exactly one explicit disabled_slices declaration");
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
