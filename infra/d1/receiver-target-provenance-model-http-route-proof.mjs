import { resolve } from "node:path";
import ts from "typescript";
import { normalized, propertyName } from "./receiver-target-provenance-values.mjs";

const MODEL_OPERATION = "system.research.model-qualification";
const MODEL_PATH = "/api/v1/system/research-model-qualification";

function parens(node) {
  let current = node;
  while (current && ts.isParenthesizedExpression(current)) current = current.expression;
  return current;
}

function routeTableArray(initializer) {
  const value = parens(initializer);
  if (value && ts.isArrayLiteralExpression(value)) return value;
  if (!value || !ts.isAsExpression(value) || !ts.isTypeReferenceNode(value.type)
      || !ts.isIdentifier(value.type.typeName) || value.type.typeName.text !== "const"
      || value.type.typeArguments?.length) return undefined;
  const asserted = parens(value.expression);
  return asserted && ts.isArrayLiteralExpression(asserted) ? asserted : undefined;
}

function isConstDeclaration(declaration) {
  return Boolean(declaration && ts.isVariableDeclaration(declaration)
    && ts.isVariableDeclarationList(declaration.parent)
    && (declaration.parent.flags & ts.NodeFlags.Const) !== 0);
}

function literalProperty(checker, object, name) {
  if (!object || !ts.isObjectLiteralExpression(object)) return undefined;
  const properties = object.properties.filter((item) => propertyName(item.name) === name);
  if (properties.length !== 1 || (!ts.isPropertyAssignment(properties[0])
      && !ts.isShorthandPropertyAssignment(properties[0]))
      || (properties[0].name && ts.isComputedPropertyName(properties[0].name))) return undefined;
  const value = parens(ts.isPropertyAssignment(properties[0])
    ? properties[0].initializer : properties[0].name);
  return value ? { value } : undefined;
}

function directIdentifier(node, symbol, checker) {
  const value = parens(node);
  if (!value || !ts.isIdentifier(value)) return false;
  const actual = ts.isShorthandPropertyAssignment(value.parent) && value.parent.name === value
    ? checker.getShorthandAssignmentValueSymbol(value.parent) : checker.getSymbolAtLocation(value);
  return actual === symbol;
}

function findVariable(functionNode, name) {
  const matches = [];
  function visit(node) {
    if (node !== functionNode && (ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node)
        || ts.isArrowFunction(node) || ts.isFunctionExpression(node))) return;
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === name) matches.push(node);
    ts.forEachChild(node, visit);
  }
  visit(functionNode.body);
  return matches.length === 1 ? matches[0] : undefined;
}

function returnsIn(functionNode) {
  const results = [];
  function visit(node) {
    if (node !== functionNode.body && (ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node)
        || ts.isArrowFunction(node) || ts.isFunctionExpression(node))) return;
    if (ts.isReturnStatement(node) && node.expression) results.push(node.expression);
    ts.forEachChild(node, visit);
  }
  visit(functionNode.body);
  return results;
}

function isEmptyArray(node) {
  const value = parens(node);
  return Boolean(value && ts.isArrayLiteralExpression(value) && value.elements.length === 0);
}

export function proveModelQualificationRouteTable({ root, program, checker, resolveRoute }) {
  const routeTablePath = resolve(root, "packages/interfaces/src/routes.ts");
  const tableSource = program.getSourceFiles().find((item) => normalized(item.fileName) === normalized(routeTablePath));
  const declaration = tableSource?.statements.flatMap((statement) => {
    if (!ts.isVariableStatement(statement)) return [];
    return statement.declarationList.declarations.filter((item) => ts.isIdentifier(item.name)
      && item.name.text === "ROUTES");
  })[0];
  const routes = declaration && routeTableArray(declaration.initializer);
  if (!declaration || !isConstDeclaration(declaration)
      || !routes) return undefined;
  const routeSymbol = checker.getSymbolAtLocation(declaration.name);
  if (!routeSymbol || !resolveRoute?.body) return undefined;
  const entries = routes.elements.map((element) => {
    const object = parens(element);
    if (!object || !ts.isObjectLiteralExpression(object)
        || object.properties.some((item) => ts.isSpreadAssignment(item) || ts.isComputedPropertyName(item.name))) return undefined;
    const operation = literalProperty(checker, object, "operation");
    const method = literalProperty(checker, object, "method");
    const path = literalProperty(checker, object, "path");
    const auth = literalProperty(checker, object, "auth");
    if (![operation, method, path, auth].every(Boolean)
        || !ts.isStringLiteral(operation.value) || !ts.isStringLiteral(method.value)
        || !ts.isStringLiteral(path.value) || !ts.isStringLiteral(auth.value)) return undefined;
    return { operation: operation.value.text, method: method.value.text,
      path: path.value.text, auth: auth.value.text };
  });
  if (entries.some((entry) => !entry)) return undefined;
  const targets = entries.filter((entry) => entry.operation === MODEL_OPERATION);
  if (targets.length !== 1) return undefined;
  const target = targets[0];
  if (target.method !== "POST" || target.path !== MODEL_PATH || target.auth !== "owner"
      || entries.filter((entry) => entry.method === target.method && entry.path === target.path).length !== 1) return undefined;

  let routeImportUse;
  function findRouteUse(node) {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
        && node.expression.name.text === "flatMap" && ts.isIdentifier(node.expression.expression)) {
      let symbol = checker.getSymbolAtLocation(node.expression.expression);
      const seen = new Set();
      while (symbol && (symbol.flags & ts.SymbolFlags.Alias) !== 0 && !seen.has(symbol)) {
        seen.add(symbol);
        try { symbol = checker.getAliasedSymbol(symbol); }
        catch { return; }
      }
      if (symbol === routeSymbol) {
        routeImportUse = routeImportUse ? null : node;
      }
    }
    ts.forEachChild(node, findRouteUse);
  }
  findRouteUse(resolveRoute.body);
  if (!routeImportUse || routeImportUse.arguments.length !== 1) return undefined;
  const pathMatches = findVariable(resolveRoute, "pathMatches");
  const pathMatchesSymbol = pathMatches && checker.getSymbolAtLocation(pathMatches.name);
  if (!pathMatches || !isConstDeclaration(pathMatches) || !pathMatchesSymbol
      || parens(pathMatches.initializer) !== routeImportUse) return undefined;
  const callback = parens(routeImportUse.arguments[0]);
  if (!callback || !ts.isArrowFunction(callback) || callback.parameters.length !== 1
      || !ts.isIdentifier(callback.parameters[0].name)) return undefined;
  const callbackRouteSymbol = checker.getSymbolAtLocation(callback.parameters[0].name);
  const callbackReturns = returnsIn(callback);
  if (!callbackRouteSymbol || callbackReturns.length !== 1) return undefined;
  const callbackResult = parens(callbackReturns[0]);
  if (!callbackResult || !ts.isConditionalExpression(callbackResult)) return undefined;
  const arrays = [parens(callbackResult.whenTrue), parens(callbackResult.whenFalse)];
  if (!arrays.some(isEmptyArray)) return undefined;
  const rowArray = arrays.find((item) => item && ts.isArrayLiteralExpression(item) && item.elements.length === 1);
  const row = rowArray && parens(rowArray.elements[0]);
  const rowRoute = row && literalProperty(checker, row, "route");
  if (!row || !ts.isObjectLiteralExpression(row) || !rowRoute
      || !directIdentifier(rowRoute.value, callbackRouteSymbol, checker)) return undefined;

  const match = findVariable(resolveRoute, "match");
  const matchSymbol = match && checker.getSymbolAtLocation(match.name);
  const findCall = match?.initializer && parens(match.initializer);
  if (!match || !isConstDeclaration(match) || !matchSymbol || !findCall
      || !ts.isCallExpression(findCall) || !ts.isPropertyAccessExpression(findCall.expression)
      || findCall.expression.name.text !== "find" || !ts.isIdentifier(findCall.expression.expression)
      || checker.getSymbolAtLocation(findCall.expression.expression) !== pathMatchesSymbol) return undefined;
  const matchedReturns = returnsIn(resolveRoute).filter((item) => {
    const value = parens(item);
    const property = value && ts.isObjectLiteralExpression(value) && literalProperty(checker, value, "match");
    return property && directIdentifier(property.value, matchSymbol, checker);
  });
  if (matchedReturns.length !== 1) return undefined;
  return { target, routeSymbol, matchSymbol };
}
