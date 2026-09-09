import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
// ELIOT_RESEARCH §§0, 12.12, 18–19: optional integrations cannot replace these products.
const COMMON_REQUIRED_SLICES = new Set(["RETRIEVAL", "RESEARCH", "FEDERATION", "WIKI", "ERASURE"]);
const GOOGLE_TRANSPORTS = new Set(["disabled", "gemini-mcp", "drive-exchange"]);
const PROFILE_SCOPED_ENTRY_IDS = new Set(["pending-drive-exchange", "implemented-006", "workspace-candidate-admission"]);
const RELEASE_PROFILE_PROTOCOL = "eliotr.release-profile.v1";
const PROFILE_REQUIREMENTS = {
  "gemini-mcp": {
    entry_id: "workspace-candidate-admission",
    label: "Workspace candidate admission/readback qualification",
  },
  "drive-exchange": {
    entry_id: "pending-drive-exchange",
    label: "server-owned Drive Exchange qualification",
  },
};
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
/** Negative release gate, not a completeness proof or replacement for retained live conformance. */
export function launchCodeBlockers(registry, composition) {
  if (registry?.protocol !== "eliotr.implementation-status.v1" || !Array.isArray(registry.entries) || !registry.entries.length ||
      typeof composition !== "string" || !composition.includes("createApplication")) {
    throw new Error("Launch implementation registry or composition is invalid");
  }
  const profile = registry.release_profile;
  if (profile?.protocol !== RELEASE_PROFILE_PROTOCOL || !GOOGLE_TRANSPORTS.has(profile.google_external_transport)) {
    throw new Error("Launch release profile is invalid or missing");
  }
  const selectedTransport = profile.google_external_transport;
  const known = new Set(["SCAFFOLD_FAIL_CLOSED", "IN_PROGRESS", "IMPLEMENTED_NOT_LIVE", "LIVE_QUALIFIED"]);
  const blockers = [];
  for (const entry of registry.entries) {
    if (!known.has(entry.state) || typeof entry.path !== "string" || typeof entry.id !== "string") {
      throw new Error("Launch implementation entry is invalid");
    }
    if (entry.required_for_transports !== undefined &&
        (!PROFILE_SCOPED_ENTRY_IDS.has(entry.id) || !Array.isArray(entry.required_for_transports) || entry.required_for_transports.length === 0 ||
         entry.required_for_transports.some((transport) => !GOOGLE_TRANSPORTS.has(transport)))) {
      throw new Error(`${entry.id}: required_for_transports is invalid`);
    }
    const appliesToProfile = entry.required_for_transports === undefined ||
      entry.required_for_transports.includes(selectedTransport);
    if (appliesToProfile && ["SCAFFOLD_FAIL_CLOSED", "IN_PROGRESS"].includes(entry.state)) {
      blockers.push(`${entry.id}: ${entry.path}`);
    }
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
        if (COMMON_REQUIRED_SLICES.has(item.text) ||
            (item.text === "DRIVE_EXCHANGE" && selectedTransport === "drive-exchange")) {
          blockers.push(`disabled required slice: ${item.text}`);
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  if (declarations !== 1) throw new Error("Expected exactly one explicit disabled_slices declaration");
  if (selectedTransport === "disabled") {
    blockers.push("google external transport is disabled for the selected release profile");
  } else {
    const requirement = PROFILE_REQUIREMENTS[selectedTransport];
    const entry = registry.entries.find((candidate) => candidate.id === requirement.entry_id);
    if (entry === undefined || ["SCAFFOLD_FAIL_CLOSED", "IN_PROGRESS"].includes(entry.state)) {
      blockers.push(`google ${selectedTransport}: ${requirement.label} is incomplete`);
    }
  }
  return [...new Set(blockers)].sort();
}

export function readConfiguredTransport(config) {
  if (config === null || typeof config !== "object" || Array.isArray(config) ||
      config.vars === null || typeof config.vars !== "object" || Array.isArray(config.vars)) {
    throw new Error("Launch deployment config is invalid");
  }
  const value = config.vars.GOOGLE_EXTERNAL_TRANSPORT;
  if (!GOOGLE_TRANSPORTS.has(value)) {
    throw new Error("Launch deployment config has an invalid GOOGLE_EXTERNAL_TRANSPORT");
  }
  return value;
}

export async function assertLaunchCodeComplete() {
  const registry = JSON.parse(await readFile(resolve(root, "docs/implementation/implementation-status.json"), "utf8"));
  const composition = await readFile(resolve(root, "apps/eliotr-core/src/composition-root.ts"), "utf8");
  const resources = JSON.parse(await readFile(resolve(root, "infra/cloudflare/resources.json"), "utf8"));
  const canonicalPath = resolve(root, resources?.worker?.canonical_config ?? "");
  const config = JSON.parse(await readFile(canonicalPath, "utf8"));
  const configuredTransport = readConfiguredTransport(config);
  if (registry.release_profile.google_external_transport !== configuredTransport) {
    throw new Error("Launch release profile does not match the canonical deployment config");
  }
  const blockers = launchCodeBlockers(registry, composition);
  if (blockers.length) throw new Error(`LIVE_DEPLOY_BLOCKED: known unfinished product paths: ${blockers.join("; ")}`);
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  await assertLaunchCodeComplete().then(() => console.log("No registered pending product paths; live conformance remains a separate release requirement."))
    .catch((error) => { console.error(error.message); process.exitCode = 1; });
}
