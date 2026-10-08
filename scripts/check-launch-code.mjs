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
  // ADR-0007: Google is optional; only a selected integration adds its own gate.
  if (selectedTransport !== "disabled") {
    const requirement = PROFILE_REQUIREMENTS[selectedTransport];
    const entry = registry.entries.find((candidate) => candidate.id === requirement.entry_id);
    if (entry === undefined || ["SCAFFOLD_FAIL_CLOSED", "IN_PROGRESS"].includes(entry.state)) {
      blockers.push(`google ${selectedTransport}: ${requirement.label} is incomplete`);
    }
  }
  return [...new Set(blockers)].sort();
}

const CAPABILITY_PROFILE_PROPERTIES = Object.freeze([
  "protocol", "deployment_generation", "google_external_transport", "enabled_slices", "partial_slices",
  "disabled_slices", "federation_configured", "orientation_profile", "orientation_max_sources",
  "orientation_max_results", "routes", "exact_evidence_resolution_required",
  "transport_completion_is_research_completion", "ingest_live_qualified",
]);

/** Read the fixed, source-owned capability profile without evaluating Worker code. */
export async function readCompositionCapabilityProfile({ root: repositoryRoot = root, read = readFile } = {}) {
  const ts = require("typescript");
  const readText = async (path) => {
    const value = await read(path, "utf8");
    if (typeof value !== "string") throw new Error("Capability profile source is unreadable");
    return value;
  };
  const composition = tsSource(await readText(resolve(repositoryRoot, "apps/eliotr-core/src/composition-root.ts")), "composition-root.ts");
  const routeSource = tsSource(await readText(resolve(repositoryRoot, "packages/interfaces/src/routes.ts")), "routes.ts");
  const contractSource = tsSource(await readText(resolve(repositoryRoot, "packages/contracts/src/research.ts")), "research.ts");
  const orientationSource = tsSource(await readText(resolve(repositoryRoot,
    "packages/cloudflare-navigation/src/orientation-input.ts")), "orientation-input.ts");
  if (assertNamedImport(composition, "@eliotr/interfaces", "ROUTES") !== "ROUTES" ||
      assertNamedImport(composition, "@eliotr/cloudflare-navigation", "ORIENTATION_PROFILE") !== "ORIENTATION_PROFILE") {
    throw new Error("Capability profile imports may not be aliased");
  }
  if (assertNamedImport(routeSource, "@eliotr/contracts", "RESEARCH_REQUEST_MAX_BYTES") !== "RESEARCH_REQUEST_MAX_BYTES") {
    throw new Error("Capability profile route-limit import may not be aliased");
  }
  if (routeSource.statements.some((statement) => !ts.isImportDeclaration(statement) &&
      !ts.isInterfaceDeclaration(statement) && !ts.isTypeAliasDeclaration(statement) &&
      !(ts.isVariableStatement(statement) && statement.declarationList.declarations.length === 1 &&
        ts.isIdentifier(statement.declarationList.declarations[0].name) &&
        statement.declarationList.declarations[0].name.text === "ROUTES"))) {
    throw new Error("Capability profile route source contains executable or dynamic expansion");
  }

  const functions = composition.statements.filter((statement) =>
    ts.isFunctionDeclaration(statement) && statement.name?.text === "capabilities");
  if (functions.length !== 1 || functions[0].body === undefined) throw new Error("Capability profile function is missing or duplicated");
  const body = functions[0].body;
  const returns = body.statements.filter(ts.isReturnStatement);
  if (returns.length !== 1 || !ts.isObjectLiteralExpression(returns[0].expression)) {
    throw new Error("Capability profile must return one explicit object literal");
  }
  if (body.statements.length !== 2 || !ts.isVariableStatement(body.statements[0]) ||
      !(body.statements[0].declarationList.flags & ts.NodeFlags.Const) ||
      body.statements[0].declarationList.declarations.length !== 1 || body.statements[1] !== returns[0]) {
    throw new Error("Capability profile contains an executable or dynamic expansion");
  }
  const properties = new Map();
  for (const property of returns[0].expression.properties) {
    if (!ts.isPropertyAssignment(property) || !ts.isIdentifier(property.name) && !ts.isStringLiteral(property.name)) {
      throw new Error("Capability profile has a dynamic or spread property");
    }
    const name = property.name.text;
    if (properties.has(name)) throw new Error(`Capability profile duplicates ${name}`);
    properties.set(name, property.initializer);
  }
  if (properties.size !== CAPABILITY_PROFILE_PROPERTIES.length ||
      CAPABILITY_PROFILE_PROPERTIES.some((name) => !properties.has(name))) {
    throw new Error("Capability profile has missing or unknown fields");
  }

  const literal = (node, label) => {
    if (ts.isStringLiteral(node)) return node.text;
    if (node.kind === ts.SyntaxKind.TrueKeyword) return true;
    if (node.kind === ts.SyntaxKind.FalseKeyword) return false;
    if (ts.isNumericLiteral(node) && Number.isSafeInteger(Number(node.text))) return Number(node.text);
    throw new Error(`Capability profile ${label} is dynamic`);
  };
  const array = (node, label) => {
    if (!ts.isArrayLiteralExpression(node) || node.elements.length > 64) {
      throw new Error(`Capability profile ${label} is dynamic or oversized`);
    }
    const values = node.elements.map((item) => literal(item, label));
    if (values.some((value) => typeof value !== "string" || !/^[A-Z][A-Z0-9_]{0,63}$/u.test(value)) ||
        new Set(values).size !== values.length) throw new Error(`Capability profile ${label} is invalid or duplicated`);
    return values;
  };
  const property = (name) => properties.get(name);
  const protocol = literal(property("protocol"), "protocol");
  if (protocol !== "eliotr.capabilities.v1") throw new Error("Capability profile protocol is invalid");
  if (!isEnvProperty(property("deployment_generation"), "DEPLOYMENT_GENERATION")) {
    throw new Error("Capability profile deployment generation is dynamic");
  }
  const googleTransport = property("google_external_transport");
  if (!ts.isCallExpression(googleTransport) || !ts.isIdentifier(googleTransport.expression) ||
      googleTransport.expression.text !== "readGoogleExternalTransport" || googleTransport.arguments.length !== 1 ||
      !isEnvProperty(googleTransport.arguments[0], "GOOGLE_EXTERNAL_TRANSPORT")) {
    throw new Error("Capability profile Google transport is dynamic");
  }
  const federationDeclaration = body.statements[0].declarationList.declarations[0];
  if (!ts.isIdentifier(federationDeclaration.name) || federationDeclaration.name.text !== "federationConfigured" ||
      federationDeclaration.initializer === undefined) throw new Error("Capability profile federation declaration is invalid");
  const federation = federationDeclaration.initializer;
  if (!isFederationConfigurationExpression(federation)) throw new Error("Capability profile federation configuration is dynamic");
  if (!isImportedIdentifier(property("federation_configured"), "federationConfigured")) {
    throw new Error("Capability profile federation flag is dynamic");
  }
  if (!isImportedIdentifier(property("routes"), "ROUTES")) throw new Error("Capability profile routes are dynamic");
  if (!isImportedIdentifier(property("orientation_profile"), "ORIENTATION_PROFILE")) {
    throw new Error("Capability profile orientation profile is dynamic");
  }

  const routeTable = staticRoutes(routeSource, contractSource);
  const orientationProfile = literal(uniqueVariableInitializer(orientationSource, "ORIENTATION_PROFILE"), "orientation profile");
  if (orientationProfile.length < 1 || orientationProfile.length > 128) throw new Error("Capability profile orientation profile is invalid");
  const safetyInvariants = {
    exact_evidence_resolution_required: literal(property("exact_evidence_resolution_required"), "exact evidence invariant"),
    transport_completion_is_research_completion: literal(property("transport_completion_is_research_completion"), "completion invariant"),
    ingest_live_qualified: literal(property("ingest_live_qualified"), "ingest qualification invariant"),
  };
  if (safetyInvariants.exact_evidence_resolution_required !== true ||
      safetyInvariants.transport_completion_is_research_completion !== false ||
      safetyInvariants.ingest_live_qualified !== false) {
    throw new Error("Capability profile safety invariants are invalid");
  }

  return Object.freeze({
    protocol,
    enabled_slices: Object.freeze(array(property("enabled_slices"), "enabled slices")),
    partial_slices: Object.freeze(array(property("partial_slices"), "partial slices")),
    disabled_slices: Object.freeze(array(property("disabled_slices"), "disabled slices")),
    federation_configuration: Object.freeze({
      principal_ref: "FEDERATION_SERVER_PRINCIPAL_REF", cursor_key: "FEDERATION_CURSOR_HMAC_KEY",
    }),
    orientation_profile: orientationProfile,
    orientation_max_sources: literal(property("orientation_max_sources"), "orientation source limit"),
    orientation_max_results: literal(property("orientation_max_results"), "orientation result limit"),
    routes: Object.freeze(routeTable.map((route) => Object.freeze(route))),
    safety_invariants: Object.freeze(safetyInvariants),
  });
}

function tsSource(text, fileName) {
  const source = require("typescript").createSourceFile(fileName, text, require("typescript").ScriptTarget.Latest, true, require("typescript").ScriptKind.TS);
  if (source.parseDiagnostics.length) throw new Error(`Capability profile source cannot be parsed (${fileName})`);
  return source;
}

function assertNamedImport(source, moduleName, importedName) {
  const ts = require("typescript");
  const matches = [];
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier) ||
        statement.moduleSpecifier.text !== moduleName) continue;
    const bindings = statement.importClause?.namedBindings;
    if (!bindings || !ts.isNamedImports(bindings)) continue;
    for (const element of bindings.elements) {
      if ((element.propertyName?.text ?? element.name.text) === importedName) matches.push(element.name.text);
    }
  }
  if (matches.length !== 1) throw new Error(`Capability profile import is missing or duplicated (${importedName})`);
  return matches[0];
}

function uniqueVariableInitializer(source, name) {
  const ts = require("typescript");
  const matches = [];
  for (const statement of source.statements) {
    if (!ts.isVariableStatement(statement) || !(statement.declarationList.flags & ts.NodeFlags.Const)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (ts.isIdentifier(declaration.name) && declaration.name.text === name) matches.push(declaration.initializer);
    }
  }
  if (matches.length !== 1 || matches[0] === undefined) throw new Error(`Capability profile constant is missing or duplicated (${name})`);
  return matches[0];
}

function isImportedIdentifier(node, name) {
  return require("typescript").isIdentifier(node) && node.text === name;
}

function isEnvProperty(node, name) {
  const ts = require("typescript");
  return ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "env" &&
    node.name.text === name;
}

function isFederationConfigurationExpression(node) {
  const ts = require("typescript");
  const expected = ["FEDERATION_SERVER_PRINCIPAL_REF", "FEDERATION_CURSOR_HMAC_KEY"];
  const condition = (item, name) => ts.isBinaryExpression(item) &&
    item.operatorToken.kind === ts.SyntaxKind.ExclamationEqualsEqualsToken && isEnvProperty(item.left, name) &&
    ts.isIdentifier(item.right) && item.right.text === "undefined";
  return ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken &&
    condition(node.left, expected[0]) && condition(node.right, expected[1]);
}

function staticRoutes(routeSource, contractSource) {
  const ts = require("typescript");
  const routeInitializer = uniqueVariableInitializer(routeSource, "ROUTES");
  const initializer = routeInitializer && ts.isAsExpression(routeInitializer) && ts.isTypeReferenceNode(routeInitializer.type) &&
    ts.isIdentifier(routeInitializer.type.typeName) && routeInitializer.type.typeName.text === "const"
    ? routeInitializer.expression : null;
  if (!ts.isArrayLiteralExpression(initializer) || initializer.elements.length < 1 || initializer.elements.length > 512) {
    throw new Error("Capability profile routes are dynamic or oversized");
  }
  const maxRequestBytes = uniqueVariableInitializer(contractSource, "RESEARCH_REQUEST_MAX_BYTES");
  if (!ts.isNumericLiteral(maxRequestBytes)) throw new Error("Capability profile route byte limit is dynamic");
  const route = (node) => {
    if (!ts.isObjectLiteralExpression(node)) throw new Error("Capability profile route entry is dynamic");
    const result = {};
    for (const property of node.properties) {
      if (!ts.isPropertyAssignment(property) || !ts.isIdentifier(property.name) && !ts.isStringLiteral(property.name)) {
        throw new Error("Capability profile route entry has a dynamic field");
      }
      const name = property.name.text;
      if (Object.hasOwn(result, name)) throw new Error("Capability profile route entry has a duplicate field");
      result[name] = routeLiteral(property.initializer, maxRequestBytes, ts);
    }
    const keys = ["method", "path", "operation", "auth", "maximum_request_bytes", "response_mode"];
    if (Object.keys(result).length !== keys.length || keys.some((key) => !Object.hasOwn(result, key)) ||
        typeof result.method !== "string" || typeof result.path !== "string" || typeof result.operation !== "string" ||
        typeof result.auth !== "string" || typeof result.response_mode !== "string" ||
        !Number.isSafeInteger(result.maximum_request_bytes) || result.maximum_request_bytes < 0) {
      throw new Error("Capability profile route entry is invalid");
    }
    return result;
  };
  const routes = initializer.elements.map(route);
  const identities = routes.map((item) => `${item.method}\n${item.path}`);
  if (new Set(identities).size !== identities.length) throw new Error("Capability profile routes contain duplicates");
  return routes.sort((left, right) => {
    const leftKey = `${left.method}\n${left.path}`;
    const rightKey = `${right.method}\n${right.path}`;
    return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
  });
}

function routeLiteral(node, maxRequestBytes, ts) {
  if (ts.isStringLiteral(node)) return node.text;
  if (ts.isNumericLiteral(node)) return Number(node.text);
  if (node.kind === ts.SyntaxKind.TrueKeyword) return true;
  if (node.kind === ts.SyntaxKind.FalseKeyword) return false;
  if (ts.isIdentifier(node) && node.text === "RESEARCH_REQUEST_MAX_BYTES") return Number(maxRequestBytes.text);
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const left = routeLiteral(node.left, maxRequestBytes, ts);
    const right = routeLiteral(node.right, maxRequestBytes, ts);
    if (typeof left === "number" && typeof right === "number" && Number.isSafeInteger(left + right)) return left + right;
  }
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.AsteriskToken) {
    const left = routeLiteral(node.left, maxRequestBytes, ts);
    const right = routeLiteral(node.right, maxRequestBytes, ts);
    if (typeof left === "number" && typeof right === "number" && Number.isSafeInteger(left * right)) return left * right;
  }
  throw new Error("Capability profile route value is dynamic");
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
