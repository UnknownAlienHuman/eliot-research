import ts from "typescript";
import { relative, resolve, sep } from "node:path";
import { normalized } from "./receiver-target-provenance-values.mjs";

const MAX_CALLSITE_DEPTH = 12;
const MAX_CALLS_PER_PARAMETER = 128;
const MAX_EVIDENCE_PATHS = 8;

function unwrap(node) {
  let current = node;
  while (current && (ts.isParenthesizedExpression(current) || ts.isAsExpression(current)
      || ts.isTypeAssertionExpression(current) || ts.isSatisfiesExpression(current)
      || ts.isNonNullExpression(current))) current = current.expression;
  return current;
}

function sourceLocation(root, node) {
  const source = node.getSourceFile();
  const { line } = source.getLineAndCharacterOfPosition(node.getStart(source));
  return `${relative(root, source.fileName).split(sep).join("/")}:${line + 1}`;
}

function directNamedDatabaseBinding(expression, checker) {
  const node = unwrap(expression);
  let bindingName;
  if (node && ts.isPropertyAccessExpression(node)) bindingName = node.name.text;
  else if (node && ts.isElementAccessExpression(node) && node.argumentExpression
      && ts.isStringLiteral(node.argumentExpression)) bindingName = node.argumentExpression.text;
  if (bindingName !== "CORE_DB" && bindingName !== "SEARCH_DB") return undefined;

  const type = checker.getTypeAtLocation(node);
  const symbol = type.aliasSymbol ?? type.getSymbol?.();
  const canonicalD1 = symbol?.getName() === "D1Database"
    && (symbol.declarations ?? []).some((declaration) =>
      normalized(declaration.getSourceFile().fileName).includes("/@cloudflare/workers-types/"));
  if (!canonicalD1) return undefined;
  return bindingName === "CORE_DB" ? "core" : "search";
}

/**
 * Report observed, positive parameter-forwarding paths to named Worker D1 bindings.
 * This is deliberately not an exhaustive target proof: callers outside the scanned
 * source set, opaque calls, and unsupported argument shapes remain unqualified.
 */
export function createBoundedCallsiteTargetEvidence({ program, checker, files, root }) {
  const callsByParameter = new Map();
  const sourceFiles = files.map((file) => program.getSourceFile(resolve(file))).filter(Boolean);

  for (const source of sourceFiles) {
    function visit(node) {
      if (ts.isCallExpression(node)) {
        const declaration = checker.getResolvedSignature(node)?.declaration;
        if (declaration?.body) {
          for (let index = 0; index < declaration.parameters.length; index += 1) {
            const parameter = declaration.parameters[index];
            if (!ts.isIdentifier(parameter.name) || !node.arguments[index]
                || ts.isSpreadElement(node.arguments[index])) continue;
            const symbol = checker.getSymbolAtLocation(parameter.name);
            if (!symbol) continue;
            const sites = callsByParameter.get(symbol) ?? [];
            sites.push({ call: node, argument: node.arguments[index] });
            callsByParameter.set(symbol, sites);
          }
        }
      }
      ts.forEachChild(node, visit);
    }
    visit(source);
  }

  function traceExpression(expression, callsites, visited, depth) {
    if (!expression || depth > MAX_CALLSITE_DEPTH) return [];
    const binding = directNamedDatabaseBinding(expression, checker);
    if (binding) return [{ targetStore: binding, callsites }];

    const node = unwrap(expression);
    if (!node || !ts.isIdentifier(node)) return [];
    const symbol = checker.getSymbolAtLocation(node);
    if (!symbol) return [];
    const parameter = (symbol.declarations ?? []).find(ts.isParameter);
    if (parameter) return traceParameter(symbol, callsites, visited, depth + 1);

    const declaration = (symbol.declarations ?? []).find(ts.isVariableDeclaration);
    if (declaration?.initializer && (ts.getCombinedNodeFlags(declaration) & ts.NodeFlags.Const) !== 0) {
      return traceExpression(declaration.initializer, callsites, visited, depth + 1);
    }
    return [];
  }

  function traceParameter(symbol, callsites, visited, depth) {
    if (depth > MAX_CALLSITE_DEPTH || visited.has(symbol)) return [];
    const nextVisited = new Set(visited);
    nextVisited.add(symbol);
    const sites = callsByParameter.get(symbol) ?? [];
    const evidence = [];
    for (const site of sites.slice(0, MAX_CALLS_PER_PARAMETER)) {
      const location = sourceLocation(root, site.call);
      evidence.push(...traceExpression(site.argument, [...callsites, location], nextVisited, depth + 1));
      if (evidence.length >= MAX_EVIDENCE_PATHS) break;
    }
    return evidence.slice(0, MAX_EVIDENCE_PATHS);
  }

  const byFile = new Map();
  for (const source of sourceFiles) {
    function visit(node) {
      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
          && node.expression.name.text === "prepare") {
        const receiver = unwrap(node.expression.expression);
        if (receiver && ts.isIdentifier(receiver)) {
          const symbol = checker.getSymbolAtLocation(receiver);
          if ((symbol?.declarations ?? []).some(ts.isParameter)) {
            const paths = traceParameter(symbol, [], new Set(), 0);
            const distinct = new Map(paths.map((path) => [JSON.stringify(path), path]));
            if (distinct.size > 0) {
              const evidence = {
                coverage: "positive-paths-only",
                exhaustive: false,
                paths: [...distinct.values()].slice(0, MAX_EVIDENCE_PATHS),
              };
              const key = normalized(source.fileName);
              const entries = byFile.get(key) ?? new Map();
              entries.set(node.getStart(source), evidence);
              byFile.set(key, entries);
            }
          }
        }
      }
      ts.forEachChild(node, visit);
    }
    visit(source);
  }
  return byFile;
}
