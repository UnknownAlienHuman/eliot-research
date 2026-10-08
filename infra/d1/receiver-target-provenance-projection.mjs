import ts from "typescript";
import { normalized, propertyName } from "./receiver-target-provenance-values.mjs";

function withoutParentheses(node) {
  let current = node;
  while (current && ts.isParenthesizedExpression(current)) current = current.expression;
  return current;
}

function isProjectionFactory({
  declaration,
  checker,
  rootFileSet,
  envType,
  envPropertySymbols,
}) {
  if (!declaration || !ts.isFunctionDeclaration(declaration) || !declaration.body
      || declaration.asteriskToken || declaration.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword)
      || !rootFileSet.has(normalized(declaration.getSourceFile().fileName))
      || declaration.parameters.length !== 1) return false;

  const factorySymbol = declaration.name && checker.getSymbolAtLocation(declaration.name);
  if (!factorySymbol || factorySymbol.declarations?.filter((item) => ts.isFunctionDeclaration(item)).length !== 1) return false;

  const [parameter] = declaration.parameters;
  if (!ts.isIdentifier(parameter.name) || parameter.dotDotDotToken || parameter.questionToken || parameter.initializer) return false;
  const parameterSymbol = checker.getSymbolAtLocation(parameter.name);
  const bodyStatements = declaration.body.statements;
  if (!parameterSymbol || bodyStatements.length !== 1 || !ts.isReturnStatement(bodyStatements[0])
      || !bodyStatements[0].expression) return false;

  const returned = withoutParentheses(bodyStatements[0].expression);
  if (!returned || !ts.isObjectLiteralExpression(returned)) return false;
  const fields = new Map();
  for (const member of returned.properties) {
    if (!ts.isPropertyAssignment(member) || ts.isComputedPropertyName(member.name)) return false;
    const outputName = propertyName(member.name);
    const initializer = withoutParentheses(member.initializer);
    if (!outputName || fields.has(outputName) || outputName === "env"
        || !initializer || !ts.isPropertyAccessExpression(initializer)
        || initializer.questionDotToken || !ts.isIdentifier(initializer.expression)
        || checker.getSymbolAtLocation(initializer.expression) !== parameterSymbol) return false;

    const sourceName = initializer.name.text;
    const sourceProperty = checker.getPropertyOfType(checker.getTypeAtLocation(parameter), sourceName);
    const envProperty = checker.getPropertyOfType(envType, sourceName);
    if (!sourceProperty || !envProperty || sourceName !== outputName) return false;

    if (outputName === "CORE_DB" || outputName === "SEARCH_DB") {
      const accessProperty = checker.getSymbolAtLocation(initializer.name);
      const sourceFieldType = checker.getTypeOfSymbolAtLocation(sourceProperty, parameter);
      const envFieldType = checker.getTypeOfSymbolAtLocation(envProperty, envProperty.valueDeclaration ?? declaration);
      const sourceTypeSymbol = sourceFieldType.aliasSymbol ?? sourceFieldType.getSymbol?.();
      const envTypeSymbol = envFieldType.aliasSymbol ?? envFieldType.getSymbol?.();
      if (sourceName !== outputName || accessProperty !== sourceProperty
          || envPropertySymbols.get(outputName) !== envProperty
          || !sourceTypeSymbol || sourceTypeSymbol !== envTypeSymbol) return false;
    }
    fields.set(outputName, initializer);
  }

  if (!fields.has("CORE_DB") || !fields.has("SEARCH_DB")) return false;
  const signature = checker.getSignatureFromDeclaration(declaration);
  const returnType = signature && checker.getReturnTypeOfSignature(signature);
  if (!returnType) return false;
  for (const name of ["CORE_DB", "SEARCH_DB"]) {
    const outputProperty = checker.getPropertyOfType(returnType, name);
    if (!outputProperty || outputProperty === envPropertySymbols.get(name)) return false;
  }
  return true;
}

/** Find only direct Worker-Env calls to a pure, field-preserving copy factory. */
export function findDetachedProjectionCalls({
  checker,
  rootFileSet,
  workerFetch,
  workerEnvParameter,
  envType,
  envPropertySymbols,
}) {
  const parameterSymbol = workerEnvParameter && ts.isIdentifier(workerEnvParameter.name)
    ? checker.getSymbolAtLocation(workerEnvParameter.name) : undefined;
  if (!parameterSymbol || !workerFetch?.body) return new Set();

  const verified = new Set();
  function visit(node) {
    if (ts.isCallExpression(node) && !node.questionDotToken && node.arguments.length === 1) {
      const actual = withoutParentheses(node.arguments[0]);
      const signatureDeclaration = checker.getResolvedSignature(node)?.declaration;
      const declaration = signatureDeclaration && ts.isFunctionDeclaration(signatureDeclaration)
        ? signatureDeclaration : undefined;
      if (actual && ts.isIdentifier(actual)
          && checker.getSymbolAtLocation(actual) === parameterSymbol
          && isProjectionFactory({ declaration, checker, rootFileSet, envType, envPropertySymbols })) {
        verified.add(node);
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(workerFetch.body);
  return verified;
}
