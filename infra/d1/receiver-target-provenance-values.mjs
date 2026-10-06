import { resolve } from "node:path";
import ts from "typescript";

export const trackedFields = new Set(["CORE_DB", "SEARCH_DB", "core_database", "search_database", "database", "env"]);
export const targetBits = Object.freeze({ core: 1, search: 2, unknown: 4 });

export function normalized(path) {
  return resolve(path).replaceAll("\\", "/").toLowerCase();
}

export function declarationName(declaration) {
  return declaration?.name && ts.isIdentifier(declaration.name) ? declaration.name.text : undefined;
}

export function isFunctionDeclaration(node) {
  return node && (ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node)
    || ts.isFunctionExpression(node) || ts.isArrowFunction(node) || ts.isConstructorDeclaration(node));
}

export function hasBody(declaration) {
  return isFunctionDeclaration(declaration) && declaration.body !== undefined;
}

export function mergeValues(left, right) {
  const fields = new Map(left.fields);
  for (const [name, bits] of right.fields) {
    const prior = fields.get(name);
    fields.set(name, prior === undefined ? bits : prior | bits);
  }
  for (const [name, bits] of fields) {
    if (!left.fields.has(name) || !right.fields.has(name)) fields.set(name, bits | targetBits.unknown);
  }
  const objects = new Map();
  for (const name of new Set([...left.objects.keys(), ...right.objects.keys()])) {
    const leftObject = left.objects.get(name);
    const rightObject = right.objects.get(name);
    if (leftObject && rightObject) objects.set(name, mergeValues(leftObject, rightObject));
    else {
      const present = leftObject ?? rightObject;
      const poisoned = emptyValue(true);
      poisoned.self = targetBits.unknown;
      for (const tracked of trackedFields) poisoned.fields.set(tracked, targetBits.unknown);
      for (const nestedName of present.objects.keys()) {
        const nestedPoisoned = emptyValue(true);
        nestedPoisoned.self = targetBits.unknown;
        for (const tracked of trackedFields) nestedPoisoned.fields.set(tracked, targetBits.unknown);
        poisoned.objects.set(nestedName, nestedPoisoned);
      }
      objects.set(name, poisoned);
    }
  }
  return {
    self: left.self | right.self,
    fields,
    objects,
    symbols: new Map([...left.symbols, ...right.symbols]),
    knownShape: left.knownShape && right.knownShape,
  };
}

export function emptyValue(knownShape = false) {
  return { self: 0, fields: new Map(), objects: new Map(), symbols: new Map(), knownShape };
}

export function factForValue(value) {
  if (value.self === targetBits.core) return "core";
  if (value.self === targetBits.search) return "search";
  return "unknown";
}

export function updateValue(current, incoming) {
  const fields = current ? new Map(current.fields) : new Map();
  for (const [name, bits] of incoming.fields) fields.set(name, (fields.get(name) ?? 0) | bits);
  const symbols = new Map(current?.symbols ?? []);
  for (const [name, symbol] of incoming.symbols) symbols.set(name, symbol);
  const objects = new Map(current?.objects ?? []);
  for (const [name, value] of incoming.objects) {
    objects.set(name, objects.has(name) ? accumulateValues(objects.get(name), value) : value);
  }
  const next = {
    self: (current?.self ?? 0) | incoming.self,
    fields,
    objects,
    symbols,
    knownShape: current ? current.knownShape && incoming.knownShape : incoming.knownShape,
  };
  const before = current ? valueKey(current) : "";
  const after = valueKey(next);
  return { next, changed: before !== after };
}

function valueKey(value) {
  return JSON.stringify([
    value.self,
    value.knownShape,
    [...value.fields].sort(([a], [b]) => a.localeCompare(b)),
    [...value.objects].sort(([a], [b]) => a.localeCompare(b)).map(([name, child]) => [name, valueKey(child)]),
    [...value.symbols].map(([name, symbol]) => [name,
      symbol?.declarations?.[0]?.getSourceFile().fileName ?? "", symbol?.declarations?.[0]?.pos ?? -1]),
  ]);
}

function accumulateValues(left, right) {
  const fields = new Map(left.fields);
  for (const [name, bits] of right.fields) fields.set(name, (fields.get(name) ?? 0) | bits);
  const objects = new Map(left.objects);
  for (const [name, value] of right.objects) {
    objects.set(name, objects.has(name) ? accumulateValues(objects.get(name), value) : value);
  }
  return {
    self: left.self | right.self,
    fields,
    objects,
    symbols: new Map([...left.symbols, ...right.symbols]),
    knownShape: left.knownShape && right.knownShape,
  };
}

export function canonicalDeclaration(checker, declaration) {
  if (!declaration) return undefined;
  const name = declarationName(declaration);
  if (!name) return declaration;
  const symbol = checker.getSymbolAtLocation(declaration.name);
  const implementation = symbol?.declarations?.find(hasBody);
  return implementation ?? declaration;
}

export function resolvedSymbol(checker, symbol) {
  if (symbol && (symbol.flags & ts.SymbolFlags.Alias) !== 0) return checker.getAliasedSymbol(symbol);
  return symbol;
}

export function declarationForIdentifier(checker, identifier) {
  const symbol = resolvedSymbol(checker, checker.getSymbolAtLocation(identifier));
  return symbol?.declarations?.find(hasBody);
}

export function functionKey(checker, declaration) {
  const canonical = canonicalDeclaration(checker, declaration);
  if (!canonical) return undefined;
  const name = declarationName(canonical);
  return name ? checker.getSymbolAtLocation(canonical.name) ?? canonical : canonical;
}

export function propertyName(name) {
  if (!name) return undefined;
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) return name.text;
  return undefined;
}

export function unwrap(node) {
  let current = node;
  while (current && (ts.isParenthesizedExpression(current) || ts.isAsExpression(current)
      || ts.isTypeAssertionExpression(current) || ts.isSatisfiesExpression(current))) current = current.expression;
  return current;
}

export function typeIdentity(checker, node) {
  const type = checker.getTypeAtLocation(node);
  return type.aliasSymbol ?? type.getSymbol();
}

export function compilerOptions(root) {
  const configPath = resolve(root, "tsconfig.base.json");
  const config = ts.readConfigFile(configPath, ts.sys.readFile);
  const parsed = ts.parseJsonConfigFileContent(config.config ?? {}, ts.sys, root, {}, configPath);
  return {
    ...parsed.options,
    noEmit: true,
    composite: false,
    declaration: false,
    declarationMap: false,
    sourceMap: false,
    incremental: false,
    skipLibCheck: true,
    types: ["@cloudflare/workers-types"],
  };
}

export function sourceUnder(path, directory) {
  const candidate = normalized(path);
  const base = normalized(directory).replace(/\/$/u, "");
  return candidate.startsWith(`${base}/`);
}
