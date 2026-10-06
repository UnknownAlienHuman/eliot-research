import { basename, resolve } from "node:path";
import ts from "typescript";
import { createModelQualificationHttpContextProof } from "./receiver-target-provenance-model-http-context.mjs";
import { normalized, propertyName, typeIdentity, unwrap } from "./receiver-target-provenance-values.mjs";

/** Resolve the one model-qualification route that persists failure-summary SQL. */
export function createModelQualificationTargetPolicy({
  root,
  program,
  checker,
  calls,
  functionKey,
  canonicalDeclaration,
}) {
  const paths = {
    env: resolve(root, "apps/eliotr-core/src/env.ts"),
    http: resolve(root, "apps/eliotr-core/src/http.ts"),
    routes: resolve(root, "apps/eliotr-core/src/http-special-routes.ts"),
    handler: resolve(root, "apps/eliotr-core/src/research-model-qualification-http.ts"),
    dispatch: resolve(root, "packages/cloudflare-model-control/src/research-model-qualification-dispatch.ts"),
    summary: resolve(root, "packages/cloudflare-model-control/src/research-model-qualification-failure-summary.ts"),
    prompt: resolve(root, "packages/cloudflare-model-control/src/research-qualification-prompt.ts"),
    native: resolve(root, "packages/cloudflare-model-control/src/research-model-qualification.ts"),
  };
  const source = (path) => program.getSourceFiles().find((item) => normalized(item.fileName) === normalized(path));
  const declaration = (path, name) => source(path)?.statements.find((item) => ts.isFunctionDeclaration(item)
    && item.name?.text === name && item.body);
  const envSource = source(paths.env);
  const envNode = envSource?.statements.find((item) => ts.isInterfaceDeclaration(item) && item.name.text === "Env");
  const envSymbol = envNode && checker.getSymbolAtLocation(envNode.name);
  const envType = envSymbol && checker.getDeclaredTypeOfSymbol(envSymbol);
  const coreProperty = envType && checker.getPropertyOfType(envType, "CORE_DB");
  const searchProperty = envType && checker.getPropertyOfType(envType, "SEARCH_DB");
  const http = declaration(paths.http, "handleHttp");
  const route = declaration(paths.routes, "dispatchHttpSpecialRoute");
  const handler = declaration(paths.handler, "handleResearchModelQualification");
  const factory = declaration(paths.dispatch, "createResearchModelQualificationDispatch");
  const readSummary = declaration(paths.summary, "readResearchModelQualificationFailureSummary");
  const recordSummary = declaration(paths.summary, "recordResearchModelQualificationFailureSummary");
  const promptFactory = declaration(paths.prompt, "createResearchQualificationPromptCompiler");
  const nativeFactory = declaration(paths.native, "createResearchModelQualificationNativeExecution");
  const key = (node) => node && functionKey(checker, canonicalDeclaration(checker, node));
  const keys = {
    http: key(http), route: key(route), handler: key(handler), factory: key(factory),
    read: key(readSummary), record: key(recordSummary), prompt: key(promptFactory), native: key(nativeFactory),
  };
  if (!envSymbol || !coreProperty || !searchProperty || !Object.values(keys).every(Boolean)
      || !http.parameters[1] || !handler.parameters[1] || !route.parameters[0] || !factory.parameters[0]
      || typeIdentity(checker, http.parameters[1]) !== envSymbol
      || typeIdentity(checker, handler.parameters[1]) !== envSymbol) return undefined;

  function directPropertyRead(expression, receiverSymbol, receiverType, name, expectedProperty) {
    const value = unwrap(expression);
    return Boolean(value && ts.isPropertyAccessExpression(value) && ts.isIdentifier(value.expression)
      && checker.getSymbolAtLocation(value.expression) === receiverSymbol && value.name.text === name
      && checker.getSymbolAtLocation(value.name) === expectedProperty
      && checker.getPropertyOfType(receiverType, name) === expectedProperty);
  }

  function directDatabaseRead(expression, receiverSymbol, receiverType) {
    const value = unwrap(expression);
    if (!value || !ts.isPropertyAccessExpression(value) || !ts.isIdentifier(value.expression)
        || checker.getSymbolAtLocation(value.expression) !== receiverSymbol) return false;
    const name = value.name.text;
    return (name === "CORE_DB" || name === "SEARCH_DB")
      && checker.getSymbolAtLocation(value.name) === checker.getPropertyOfType(receiverType, name);
  }

  function argumentObject(call, index) {
    const value = call?.arguments[index] && unwrap(call.arguments[index]);
    return value && ts.isObjectLiteralExpression(value) ? value : undefined;
  }

  function propertyValue(object, name, protectedNames) {
    const matches = object.properties.filter((item) => propertyName(item.name) === name);
    if (matches.length !== 1 || (!ts.isPropertyAssignment(matches[0])
        && !ts.isShorthandPropertyAssignment(matches[0]))) return undefined;
    for (const item of object.properties) {
      if (item.name && ts.isComputedPropertyName(item.name)) return undefined;
      if (!ts.isSpreadAssignment(item)) continue;
      const spreadType = checker.getTypeAtLocation(item.expression);
      if (spreadType.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) return undefined;
      const constituents = spreadType.isUnion() ? spreadType.types : [spreadType];
      if (constituents.some((part) => part.getStringIndexType()
          || protectedNames.some((field) => checker.getPropertyOfType(part, field)))) return undefined;
    }
    return ts.isPropertyAssignment(matches[0]) ? matches[0].initializer : matches[0].name;
  }

  function functionSource(node) {
    return normalized(node?.getSourceFile().fileName ?? "");
  }

  function hasExpectedCase(callNode) {
    let current = callNode.parent;
    while (current && current !== route) {
      if (ts.isCaseClause(current)) {
        return ts.isStringLiteral(current.expression)
          && current.expression.text === "system.research.model-qualification";
      }
      current = current.parent;
    }
    return false;
  }

  function globalObjectFreeze(expression) {
    const value = unwrap(expression);
    if (!value || !ts.isCallExpression(value) || !ts.isPropertyAccessExpression(value.expression)
        || !ts.isIdentifier(value.expression.expression) || value.expression.expression.text !== "Object"
        || value.arguments.length !== 1 || !ts.isObjectLiteralExpression(unwrap(value.arguments[0]))) return undefined;
    const objectSymbol = checker.getSymbolAtLocation(value.expression.expression);
    const freezeSymbol = checker.getSymbolAtLocation(value.expression.name);
    const standardLibrary = (symbol) => symbol?.declarations?.some((item) => item.getSourceFile().isDeclarationFile
      && /^lib\.[^/\\]+\.d\.ts$/u.test(basename(item.getSourceFile().fileName)));
    if (!standardLibrary(objectSymbol) || !standardLibrary(freezeSymbol)) return undefined;
    return unwrap(value.arguments[0]);
  }

  function returnedExecuteMethod() {
    const returned = [];
    function visit(node) {
      if (node !== factory.body && (ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node)
          || ts.isArrowFunction(node) || ts.isFunctionExpression(node))) return;
      if (ts.isReturnStatement(node) && node.expression) returned.push(node.expression);
      ts.forEachChild(node, visit);
    }
    visit(factory.body);
    if (returned.length !== 1) return undefined;
    const object = globalObjectFreeze(returned[0]);
    if (!object || object.properties.length !== 1 || !ts.isMethodDeclaration(object.properties[0])
        || propertyName(object.properties[0].name) !== "execute" || !object.properties[0].body) return undefined;
    return object.properties[0];
  }

  const execute = returnedExecuteMethod();
  const executeKey = key(execute);
  if (!execute || !executeKey) return undefined;
  const httpKey = keys.http;
  const routeKey = keys.route;
  const handlerKey = keys.handler;
  const factoryKey = keys.factory;

  const routeCallers = calls.filter((call) => call.calleeKey === routeKey);
  if (routeCallers.length !== 1 || routeCallers[0].ownerKey !== httpKey) return undefined;
  const routeInput = argumentObject(routeCallers[0].node, 0);
  const httpEnvSymbol = checker.getSymbolAtLocation(http.parameters[1].name);
  const inputEnv = routeInput && propertyValue(routeInput, "env", ["env"]);
  const inputEnvNode = inputEnv && unwrap(inputEnv);
  const inputEnvSymbol = inputEnvNode && ts.isIdentifier(inputEnvNode)
    ? ts.isShorthandPropertyAssignment(inputEnvNode.parent) && inputEnvNode.parent.name === inputEnvNode
      ? checker.getShorthandAssignmentValueSymbol(inputEnvNode.parent)
      : checker.getSymbolAtLocation(inputEnvNode)
    : undefined;
  const exactEnvForward = inputEnv && ts.isIdentifier(unwrap(inputEnv))
    && inputEnvSymbol === httpEnvSymbol;
  if (!exactEnvForward) return undefined;

  const handlerCalls = calls.filter((call) => call.ownerKey === routeKey && call.calleeKey === handlerKey);
  const routeInputSymbol = checker.getSymbolAtLocation(route.parameters[0].name);
  const routeInputType = checker.getTypeAtLocation(route.parameters[0]);
  const routeEnvProperty = checker.getPropertyOfType(routeInputType, "env");
  const handlerEnvArgument = handlerCalls[0]?.node.arguments[1] && unwrap(handlerCalls[0].node.arguments[1]);
  if (handlerCalls.length !== 1 || !hasExpectedCase(handlerCalls[0].node) || !handlerEnvArgument
      || !ts.isPropertyAccessExpression(handlerEnvArgument) || handlerEnvArgument.name.text !== "env"
      || !ts.isIdentifier(handlerEnvArgument.expression)
      || checker.getSymbolAtLocation(handlerEnvArgument.expression) !== routeInputSymbol
      || checker.getSymbolAtLocation(handlerEnvArgument.name) !== routeEnvProperty) return undefined;

  const factoryCalls = calls.filter((call) => call.calleeKey === factoryKey);
  if (factoryCalls.length !== 1 || factoryCalls[0].ownerKey !== handlerKey) return undefined;
  const dependenciesObject = argumentObject(factoryCalls[0].node, 0);
  const handlerEnvSymbol = checker.getSymbolAtLocation(handler.parameters[1].name);
  const handlerEnvType = checker.getTypeAtLocation(handler.parameters[1]);
  const coreArgument = dependenciesObject && propertyValue(dependenciesObject, "core_database",
    ["core_database", "search_database"]);
  const searchArgument = dependenciesObject && propertyValue(dependenciesObject, "search_database",
    ["core_database", "search_database"]);
  if (!dependenciesObject || !directDatabaseRead(coreArgument, handlerEnvSymbol, handlerEnvType)
      || !directDatabaseRead(searchArgument, handlerEnvSymbol, handlerEnvType)) return undefined;

  const dependenciesSymbol = checker.getSymbolAtLocation(factory.parameters[0].name);
  const dependenciesType = checker.getTypeAtLocation(factory.parameters[0]);
  if (!dependenciesSymbol) return undefined;
  function dependencyRead(expression, name) {
    const property = checker.getPropertyOfType(dependenciesType, name);
    return property && directPropertyRead(expression, dependenciesSymbol, dependenciesType, name, property);
  }

  const factoryVariable = factoryCalls[0].node.parent;
  const serviceDeclaration = ts.isVariableDeclaration(factoryVariable) ? factoryVariable : undefined;
  const serviceSymbol = serviceDeclaration && ts.isIdentifier(serviceDeclaration.name)
    ? checker.getSymbolAtLocation(serviceDeclaration.name) : undefined;
  if (!serviceDeclaration || !serviceSymbol || !serviceDeclaration.initializer
      || (ts.getCombinedNodeFlags(serviceDeclaration.parent) & ts.NodeFlags.Const) === 0) return undefined;
  let executeCallCount = 0;
  let serviceReferencesValid = true;
  function inspectService(node) {
    if (ts.isIdentifier(node) && checker.getSymbolAtLocation(node) === serviceSymbol && node !== serviceDeclaration.name) {
      const access = node.parent;
      const invocation = access?.parent;
      if (!ts.isPropertyAccessExpression(access) || access.expression !== node || access.name.text !== "execute"
          || !ts.isCallExpression(invocation) || invocation.expression !== access) serviceReferencesValid = false;
      else executeCallCount += 1;
    }
    ts.forEachChild(node, inspectService);
  }
  inspectService(handler.body);
  if (!serviceReferencesValid || executeCallCount !== 1) return undefined;

  const promptCalls = calls.filter((call) => call.ownerKey === executeKey && call.calleeKey === keys.prompt);
  const nativeCalls = calls.filter((call) => call.ownerKey === executeKey && call.calleeKey === keys.native);
  const promptObject = promptCalls.length === 1 && argumentObject(promptCalls[0].node, 0);
  const nativeObject = nativeCalls.length === 1 && argumentObject(nativeCalls[0].node, 0);
  const opaqueCalls = new Set();
  if (promptObject) {
    const promptCore = propertyValue(promptObject, "core_database", ["core_database", "search_database"]);
    const promptSearch = propertyValue(promptObject, "search_database", ["core_database", "search_database"]);
    if (dependencyRead(promptCore, "core_database") && dependencyRead(promptSearch, "search_database")) {
      opaqueCalls.add(promptCalls[0].node);
    }
  }
  if (nativeObject) {
    const nativeDatabase = propertyValue(nativeObject, "database", ["database"]);
    if (dependencyRead(nativeDatabase, "core_database")) opaqueCalls.add(nativeCalls[0].node);
  }
  if (opaqueCalls.size !== 2) return undefined;

  const httpContextProof = createModelQualificationHttpContextProof({
    root, program, checker, calls, functionKey,
  });
  if (!httpContextProof) return undefined;

  const dispatchPath = normalized(paths.dispatch);
  const summaryPath = normalized(paths.summary);
  const exactEdges = new Set([
    `${httpKey}->${routeKey}`,
    `${routeKey}->${handlerKey}`,
    `${handlerKey}->${factoryKey}`,
    `${factoryKey}->${executeKey}`,
  ]);
  function allowsCall(parent, child) {
    const parentKey = key(parent);
    const childKey = key(child);
    if (exactEdges.has(`${parentKey}->${childKey}`)) return true;
    const parentPath = functionSource(parent);
    const childPath = functionSource(child);
    if (parentPath === dispatchPath && childPath === dispatchPath) return true;
    if (parentPath === dispatchPath && childPath === summaryPath) {
      return childKey === keys.read || childKey === keys.record;
    }
    if (parentPath === summaryPath && childPath === summaryPath) {
      return parentKey === keys.record && childKey === keys.read;
    }
    return false;
  }

  return {
    allowsCall,
    isOpaqueD1Handoff: (call) => opaqueCalls.has(call.node),
    isNonEscapingArgument: httpContextProof.isNonEscapingArgument,
    restrictNested: (parent) => key(parent) === factoryKey,
    isApprovedNested: (parent, nested) => key(parent) === factoryKey && nested === execute,
    isTargetSqlSource: (path) => normalized(path) === summaryPath,
  };
}
