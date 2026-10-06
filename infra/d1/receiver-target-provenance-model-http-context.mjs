import { resolve } from "node:path";
import ts from "typescript";
import { canonicalDeclaration, normalized, propertyName } from "./receiver-target-provenance-values.mjs";
import { proveScalarEnvironmentConsumer } from "./receiver-target-provenance-model-http-consumers.mjs";
import { proveModelQualificationRouteTable } from "./receiver-target-provenance-model-http-route-proof.mjs";

const MODEL_OPERATION = "system.research.model-qualification";

function parens(node) {
  let current = node;
  while (current && ts.isParenthesizedExpression(current)) current = current.expression;
  return current;
}

function isConstDeclaration(declaration) {
  return Boolean(declaration && ts.isVariableDeclaration(declaration)
    && ts.isVariableDeclarationList(declaration.parent)
    && (declaration.parent.flags & ts.NodeFlags.Const) !== 0);
}

function containsNode(root, node) {
  for (let current = node; current; current = current.parent) if (current === root) return true;
  return false;
}

function literalProperty(checker, object, name) {
  if (!object || !ts.isObjectLiteralExpression(object)) return undefined;
  const properties = object.properties.filter((item) => propertyName(item.name) === name);
  if (properties.length !== 1 || (!ts.isPropertyAssignment(properties[0])
      && !ts.isShorthandPropertyAssignment(properties[0]))
      || (properties[0].name && ts.isComputedPropertyName(properties[0].name))) return undefined;
  const value = parens(ts.isPropertyAssignment(properties[0])
    ? properties[0].initializer : properties[0].name);
  if (!value) return undefined;
  return { node: properties[0], value, symbol: checker.getSymbolAtLocation(properties[0].name) };
}

/** Prove only the exact Worker-to-model HTTP path that is relevant to the three SQL sites. */
export function createModelQualificationHttpContextProof({
  root,
  program,
  checker,
  calls,
  functionKey,
}) {
  const paths = {
    http: resolve(root, "apps/eliotr-core/src/http.ts"),
    routes: resolve(root, "apps/eliotr-core/src/http-special-routes.ts"),
    composition: resolve(root, "apps/eliotr-core/src/composition-root.ts"),
    handler: resolve(root, "apps/eliotr-core/src/research-model-qualification-http.ts"),
    access: resolve(root, "apps/eliotr-core/src/http-request-auth.ts"),
    response: resolve(root, "apps/eliotr-core/src/http-response.ts"),
    agentTask: resolve(root, "packages/cloudflare-http-protocol/src/agent-task-inbox-input.ts"),
    apiDispatch: resolve(root, "apps/eliotr-core/src/http-api-dispatch.ts"),
  };
  const source = (path) => program.getSourceFiles().find((item) => normalized(item.fileName) === normalized(path));
  const declaration = (path, name) => source(path)?.statements.flatMap((statement) => {
    if (ts.isFunctionDeclaration(statement) && statement.name?.text === name && statement.body) return [statement];
    return [];
  })[0];
  const key = (node) => node && functionKey(checker, canonicalDeclaration(checker, node));
  const callsByNode = new Map(calls.map((call) => [call.node, call]));
  const declarations = {
    http: declaration(paths.http, "handleHttp"),
    resolveRoute: declaration(paths.http, "resolveRoute"),
    route: declaration(paths.routes, "dispatchHttpSpecialRoute"),
    handler: declaration(paths.handler, "handleResearchModelQualification"),
    access: declaration(paths.access, "configuredAccessVerifier"),
    response: declaration(paths.response, "apiResult"),
    agentTask: declaration(paths.agentTask, "isAgentTaskHttpOperation"),
    apiDispatch: declaration(paths.apiDispatch, "dispatchHttpApiRoute"),
  };
  const keys = Object.fromEntries(Object.entries(declarations).map(([name, node]) => [name, key(node)]));
  if (Object.values(declarations).some((node) => !node) || Object.values(keys).some((value) => !value)) return undefined;

  function unalias(symbol) {
    let current = symbol;
    const seen = new Set();
    while (current && (current.flags & ts.SymbolFlags.Alias) !== 0 && !seen.has(current)) {
      seen.add(current);
      try { current = checker.getAliasedSymbol(current); }
      catch { return undefined; }
    }
    return current;
  }

  function identifierValue(node) {
    const value = parens(node);
    if (!value || !ts.isIdentifier(value)) return undefined;
    return ts.isShorthandPropertyAssignment(value.parent) && value.parent.name === value
      ? checker.getShorthandAssignmentValueSymbol(value.parent) : checker.getSymbolAtLocation(value);
  }

  function propertyPath(node, baseSymbol, names) {
    let current = parens(node);
    for (let index = names.length - 1; index >= 0; index -= 1) {
      if (!current || !ts.isPropertyAccessExpression(current) || current.name.text !== names[index]) return false;
      const receiverType = checker.getTypeAtLocation(current.expression);
      const expected = checker.getPropertyOfType(receiverType, names[index]);
      if (!expected || checker.getSymbolAtLocation(current.name) !== expected) return false;
      current = parens(current.expression);
    }
    return Boolean(current && ts.isIdentifier(current) && checker.getSymbolAtLocation(current) === baseSymbol);
  }

  function directIdentifier(node, symbol) {
    const value = parens(node);
    return Boolean(value && ts.isIdentifier(value) && identifierValue(value) === symbol);
  }

  function isStringLiteral(node, expected) {
    const value = parens(node);
    return Boolean(value && ts.isStringLiteral(value) && value.text === expected);
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

  function operationPath(node, parameterSymbol, parameterType) {
    if (!propertyPath(node, parameterSymbol, ["match", "route", "operation"])) return false;
    const operationType = checker.getTypeAtLocation(node);
    return Boolean(operationType && (operationType.flags & ts.TypeFlags.String) !== 0
      && checker.getPropertyOfType(parameterType, "match"));
  }

  function agentPredicateExcludesModelOperation(callNode) {
    const call = callsByNode.get(callNode);
    const predicate = declarations.agentTask;
    if (!call || call.calleeKey !== keys.agentTask || callNode.arguments.length !== 1
        || !ts.isIdentifier(predicate.parameters[0]?.name)) return false;
    const returns = returnsIn(predicate);
    if (returns.length !== 1) return false;
    const expression = parens(returns[0]);
    if (!expression || !ts.isCallExpression(expression) || !ts.isPropertyAccessExpression(expression.expression)
        || expression.expression.name.text !== "includes" || expression.arguments.length !== 1
        || !directIdentifier(expression.arguments[0], checker.getSymbolAtLocation(predicate.parameters[0].name))) return false;
    let receiver = expression.expression.expression;
    while (ts.isAsExpression(receiver) || ts.isTypeAssertionExpression(receiver) || ts.isParenthesizedExpression(receiver)) receiver = receiver.expression;
    if (!ts.isIdentifier(receiver)) return false;
    const operationSymbol = checker.getSymbolAtLocation(receiver);
    const operationDeclaration = operationSymbol?.valueDeclaration;
    if (!operationSymbol || !operationDeclaration || !ts.isVariableDeclaration(operationDeclaration)
        || !isConstDeclaration(operationDeclaration) || !operationDeclaration.initializer) return false;
    const variableStatement = operationDeclaration.parent.parent;
    if (!ts.isVariableStatement(variableStatement)
        || variableStatement.modifiers?.some((item) => item.kind === ts.SyntaxKind.ExportKeyword
          || item.kind === ts.SyntaxKind.DefaultKeyword)) return false;
    let initializer = operationDeclaration.initializer;
    while (ts.isAsExpression(initializer) || ts.isTypeAssertionExpression(initializer)) initializer = initializer.expression;
    const array = parens(initializer);
    if (!array || !ts.isArrayLiteralExpression(array) || array.elements.some((item) => !ts.isStringLiteral(item))) return false;
    let safeUses = true;
    for (const sourceFile of program.getSourceFiles()) {
      function inspectUse(node) {
        if (!safeUses) return;
        if (ts.isIdentifier(node) && node !== operationDeclaration.name
            && checker.getSymbolAtLocation(node) === operationSymbol) {
          const parent = node.parent;
          if (ts.isTypeQueryNode(parent) && parent.exprName === node) return;
          let receiverNode = node;
          let access = receiverNode.parent;
          while (ts.isAsExpression(access) || ts.isTypeAssertionExpression(access) || ts.isParenthesizedExpression(access)) {
            receiverNode = access;
            access = access.parent;
          }
          const use = access?.parent;
          if (!ts.isPropertyAccessExpression(access) || access.expression !== receiverNode
              || access.name.text !== "includes" || !ts.isCallExpression(use) || use.expression !== access
              || use.arguments.length !== 1 || !containsNode(predicate.body, use)
              || !directIdentifier(use.arguments[0], checker.getSymbolAtLocation(predicate.parameters[0].name))) {
            safeUses = false;
            return;
          }
        }
        ts.forEachChild(node, inspectUse);
      }
      inspectUse(sourceFile);
      if (!safeUses) return false;
    }
    return !array.elements.some((item) => item.text === MODEL_OPERATION);
  }

  function falsePrefixIf(node, operationSymbol) {
    const expression = parens(node.expression);
    if (!expression || !ts.isBinaryExpression(expression) || expression.operatorToken.kind !== ts.SyntaxKind.BarBarToken) return false;
    const terms = [parens(expression.left), parens(expression.right)];
    const prefixes = [];
    for (const term of terms) {
      if (!term || !ts.isCallExpression(term) || !ts.isPropertyAccessExpression(term.expression)
          || term.expression.name.text !== "startsWith" || term.arguments.length !== 1
          || !propertyPath(term.expression.expression, operationSymbol, ["match", "route", "operation"])
          || !ts.isStringLiteral(parens(term.arguments[0]))) return false;
      prefixes.push(parens(term.arguments[0]).text);
    }
    return prefixes.length === 2 && prefixes.every((prefix) => !MODEL_OPERATION.startsWith(prefix));
  }

  function inside(node, ancestor) { return Boolean(ancestor && containsNode(ancestor, node)); }

  function directBlockStatement(block, node) {
    let current = node;
    while (current && current.parent !== block) current = current.parent;
    return current?.parent === block && ts.isBlock(block) ? current : undefined;
  }

  function returnsAllPaths(statement) {
    if (ts.isReturnStatement(statement)) return true;
    if (ts.isBlock(statement)) return statement.statements.some(returnsAllPaths);
    return ts.isIfStatement(statement) && Boolean(statement.elseStatement)
      && returnsAllPaths(statement.thenStatement) && returnsAllPaths(statement.elseStatement);
  }

  function beforeInBlock(block, earlier, later) {
    const first = directBlockStatement(block, earlier);
    const second = directBlockStatement(block, later);
    return Boolean(first && second && block.statements.indexOf(first) < block.statements.indexOf(second));
  }

  const routeTable = proveModelQualificationRouteTable({
    root, program, checker, resolveRoute: declarations.resolveRoute,
  });
  if (!routeTable) return undefined;
  const http = declarations.http;
  const route = declarations.route;
  const handler = declarations.handler;
  const httpEnvSymbol = checker.getSymbolAtLocation(http.parameters[1]?.name);
  const routeInputSymbol = checker.getSymbolAtLocation(route.parameters[0]?.name);
  const routeInputType = route.parameters[0] && checker.getTypeAtLocation(route.parameters[0]);
  const routeEnvProperty = routeInputType && checker.getPropertyOfType(routeInputType, "env");
  if (!httpEnvSymbol || !routeInputSymbol || !routeEnvProperty) return undefined;

  const resolved = findVariable(http, "resolved");
  const resolvedSymbol = resolved && checker.getSymbolAtLocation(resolved.name);
  const resolveCall = resolved?.initializer && parens(resolved.initializer);
  if (!resolved || !isConstDeclaration(resolved) || !resolvedSymbol || !resolveCall
      || !ts.isCallExpression(resolveCall) || callsByNode.get(resolveCall)?.calleeKey !== keys.resolveRoute) return undefined;
  const resolvedMatchPath = (node) => propertyPath(node, resolvedSymbol, ["match"]);
  const matchRouteAuth = (node) => propertyPath(node, resolvedSymbol, ["match", "route", "auth"]);
  const httpCalls = calls.filter((call) => call.ownerKey === keys.http);
  const routeCalls = httpCalls.filter((call) => call.calleeKey === keys.route);
  if (routeCalls.length !== 1) return undefined;
  const routeCall = routeCalls[0].node;
  const routeArgument = parens(routeCall.arguments[0]);
  const routeMatch = literalProperty(checker, routeArgument, "match");
  const routeEnv = literalProperty(checker, routeArgument, "env");
  if (!routeArgument || !routeMatch || !routeEnv || !resolvedMatchPath(routeMatch.value)
      || !directIdentifier(routeEnv.value, httpEnvSymbol)) return undefined;
  const publicBranches = [];
  const noMatchBranches = [];
  function inspectHttp(node) {
    if (node !== http.body && (ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node)
        || ts.isArrowFunction(node) || ts.isFunctionExpression(node))) return;
    if (ts.isIfStatement(node)) {
      const condition = parens(node.expression);
      if (condition && ts.isBinaryExpression(condition)
          && condition.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken
          && matchRouteAuth(condition.left) && isStringLiteral(condition.right, "public")) publicBranches.push(node);
      if (condition && ts.isBinaryExpression(condition)
          && condition.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken
          && resolvedMatchPath(condition.left) && ts.isIdentifier(parens(condition.right))
          && parens(condition.right).text === "undefined") {
        noMatchBranches.push(node);
      }
    }
    ts.forEachChild(node, inspectHttp);
  }
  inspectHttp(http.body);
  if (publicBranches.length !== 1 || noMatchBranches.length !== 1) return undefined;
  const publicBranch = publicBranches[0];
  const noMatchBranch = noMatchBranches[0];
  const routeStatement = directBlockStatement(http.body, routeCall);
  const publicStatement = routeStatement && ts.isTryStatement(routeStatement)
    ? directBlockStatement(routeStatement.tryBlock, publicBranch) : undefined;
  if (!routeStatement || !ts.isTryStatement(routeStatement) || !inside(routeCall, routeStatement.tryBlock)
      || !inside(publicBranch, routeStatement.tryBlock) || noMatchBranch.parent !== http.body
      || noMatchBranch.elseStatement || !returnsAllPaths(noMatchBranch.thenStatement)
      || !publicStatement || publicBranch.elseStatement || !returnsAllPaths(publicBranch.thenStatement)
      || !beforeInBlock(http.body, noMatchBranch, routeCall)
      || !beforeInBlock(routeStatement.tryBlock, publicBranch, routeCall)) return undefined;
  const readinessCalls = httpCalls.filter((call) => call.callee.getSourceFile
    && normalized(call.callee.getSourceFile().fileName) === normalized(resolve(root, "apps/eliotr-core/src/readiness.ts"))
    && call.callee.name?.text === "readReadiness");
  const readReadinessCall = readinessCalls.find((call) => inside(call.node, publicBranch.thenStatement));
  const staticCall = httpCalls.find((call) => normalized(call.callee.getSourceFile().fileName)
    === normalized(resolve(root, "apps/eliotr-core/src/agent-inbox-static.ts"))
    && call.callee.name?.text === "fetchStaticAsset" && inside(call.node, noMatchBranch.thenStatement));
  if (!readReadinessCall || !staticCall) return undefined;

  const specialVariable = findVariable(http, "special");
  const specialSymbol = specialVariable && checker.getSymbolAtLocation(specialVariable.name);
  const specialInitializer = specialVariable?.initializer && parens(specialVariable.initializer);
  const guard = (() => {
    const matches = [];
    function visit(node) {
      if (node !== http.body && (ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node)
          || ts.isArrowFunction(node) || ts.isFunctionExpression(node))) return;
      if (ts.isIfStatement(node)) {
        const condition = parens(node.expression);
        if (condition && ts.isBinaryExpression(condition)
            && condition.operatorToken.kind === ts.SyntaxKind.ExclamationEqualsEqualsToken
            && directIdentifier(condition.left, specialSymbol) && isNull(condition.right)
            && ts.isReturnStatement(node.thenStatement) && directIdentifier(node.thenStatement.expression, specialSymbol)
            && !node.elseStatement) matches.push(node);
      }
      ts.forEachChild(node, visit);
    }
    visit(http.body);
    return matches.length === 1 ? matches[0] : undefined;
  })();

  function isNull(node) {
    const value = parens(node);
    return Boolean(value && value.kind === ts.SyntaxKind.NullKeyword);
  }

  if (!specialVariable || !isConstDeclaration(specialVariable) || !specialSymbol || !specialInitializer
      || !ts.isAwaitExpression(specialInitializer) || !ts.isCallExpression(parens(specialInitializer.expression))
      || callsByNode.get(parens(specialInitializer.expression))?.calleeKey !== keys.route || !guard) return undefined;

  const specialCall = parens(specialInitializer.expression);
  if (specialCall !== routeCall) return undefined;
  const operationProperty = checker.getPropertyOfType(routeInputType, "match");
  const operationSymbol = routeInputSymbol;
  const operationExpression = (() => {
    let result;
    function visit(node) {
      if (ts.isSwitchStatement(node) && operationPath(node.expression, operationSymbol, routeInputType)) {
        if (result) result = null;
        else result = node;
      }
      ts.forEachChild(node, visit);
    }
    visit(route.body);
    return result;
  })();
  if (!operationExpression || !operationProperty || routeInputType.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) return undefined;
  const targetCases = operationExpression.caseBlock.clauses.filter((clause) => ts.isCaseClause(clause)
    && isStringLiteral(clause.expression, MODEL_OPERATION));
  if (targetCases.length !== 1) return undefined;
  const targetCase = targetCases[0];
  const routeClauses = operationExpression.caseBlock.clauses;
  const targetIndex = routeClauses.indexOf(targetCase);
  function abruptForRoute(statement) {
    if (ts.isReturnStatement(statement) || ts.isThrowStatement(statement)) return true;
    if (ts.isBreakStatement(statement)) {
      if (statement.label) return false;
      let current = statement.parent;
      while (current) {
        if (current === operationExpression) return true;
        if (ts.isIterationStatement(current, true) || ts.isSwitchStatement(current)) return false;
        current = current.parent;
      }
      return false;
    }
    if (ts.isBlock(statement)) return statement.statements.length > 0
      && abruptForRoute(statement.statements.at(-1));
    return ts.isIfStatement(statement) && Boolean(statement.elseStatement)
      && abruptForRoute(statement.thenStatement) && abruptForRoute(statement.elseStatement);
  }
  for (let index = 0; index < targetIndex;) {
    while (index < targetIndex && routeClauses[index].statements.length === 0) index += 1;
    if (index === targetIndex || !abruptForRoute(routeClauses[index].statements.at(-1))) return undefined;
    index += 1;
  }
  for (const clause of routeClauses) {
    if (ts.isCaseClause(clause) && !ts.isStringLiteral(parens(clause.expression))) return undefined;
  }
  const targetReturns = targetCase.statements.filter(ts.isReturnStatement);
  if (targetReturns.length !== 1 || targetCase.statements.at(-1) !== targetReturns[0]
      || !targetReturns[0].expression || !ts.isCallExpression(parens(targetReturns[0].expression))) return undefined;
  const modelHandlerCall = parens(targetReturns[0].expression);
  if (callsByNode.get(modelHandlerCall)?.calleeKey !== keys.handler) return undefined;
  const handlerEnvArgument = modelHandlerCall.arguments[1];
  if (!propertyPath(handlerEnvArgument, routeInputSymbol, ["env"])) return undefined;
  const awaitedHandlerType = checker.getAwaitedType?.(checker.getTypeAtLocation(modelHandlerCall));
  if (!awaitedHandlerType || awaitedHandlerType.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown | ts.TypeFlags.Null
      | ts.TypeFlags.Undefined | ts.TypeFlags.Void)) return undefined;

  const prefixGuards = [];
  const agentGuards = [];
  function inspectRoute(node) {
    if (node !== route.body && (ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node)
        || ts.isArrowFunction(node) || ts.isFunctionExpression(node))) return;
    if (ts.isIfStatement(node)) {
      if (falsePrefixIf(node, operationSymbol)) prefixGuards.push(node);
      const condition = parens(node.expression);
      const agentAccepted = condition && ts.isCallExpression(condition) && callsByNode.get(condition)?.calleeKey === keys.agentTask
          && condition.arguments.length === 1 && operationPath(condition.arguments[0], operationSymbol, routeInputType)
          && agentPredicateExcludesModelOperation(condition);
      if (agentAccepted) agentGuards.push(node);
    }
    ts.forEachChild(node, inspectRoute);
  }
  inspectRoute(route.body);
  if (prefixGuards.length !== 1 || agentGuards.length !== 1) return undefined;

  const accessCall = httpCalls.find((call) => call.calleeKey === keys.access && call.node.arguments.length === 1
    && directIdentifier(call.node.arguments[0], httpEnvSymbol));
  const responseCalls = calls.filter((call) => call.ownerKey === keys.handler && call.calleeKey === keys.response);
  const responseCall = responseCalls.length === 1 && responseCalls[0].node.arguments.length > 1
    && directIdentifier(responseCalls[0].node.arguments[1], checker.getSymbolAtLocation(handler.parameters[1].name))
    ? responseCalls[0] : undefined;
  if (!accessCall || !proveScalarEnvironmentConsumer(accessCall.callee, 0, checker, callsByNode)
      || !responseCall || !proveScalarEnvironmentConsumer(responseCall.callee, 1, checker, callsByNode)) return undefined;

  const apiCalls = httpCalls.filter((call) => call.calleeKey === keys.apiDispatch);
  const factoryVariable = findVariable(http, "factory");
  const factorySymbol = factoryVariable && checker.getSymbolAtLocation(factoryVariable.name);
  const factoryCall = httpCalls.map((call) => call.node).find((node) => ts.isCallExpression(node)
    && ts.isIdentifier(node.expression) && checker.getSymbolAtLocation(node.expression) === factorySymbol);
  const blockOf = (node) => {
    let current = node;
    while (current && !ts.isBlock(current)) current = current.parent;
    return current;
  };
  if (!factoryVariable || !isConstDeclaration(factoryVariable) || !factorySymbol || !factoryCall
      || apiCalls.length !== 1 || !inside(factoryCall, guard.parent) || !inside(apiCalls[0].node, guard.parent)
      || blockOf(specialVariable) !== guard.parent || blockOf(factoryVariable) !== guard.parent
      || specialVariable.getStart() >= guard.getStart() || factoryCall.getStart() <= guard.getStart()
      || apiCalls[0].node.getStart() <= guard.getStart()) return undefined;
  const factoryInitializer = parens(factoryVariable.initializer);
  if (!factoryInitializer || !ts.isBinaryExpression(factoryInitializer)
      || factoryInitializer.operatorToken.kind !== ts.SyntaxKind.QuestionQuestionToken) return undefined;
  const fallback = parens(factoryInitializer.right);
  const expectedFactory = fallback && ts.isIdentifier(fallback)
    && unalias(checker.getSymbolAtLocation(fallback))?.declarations?.some((item) => item.getSourceFile() === source(paths.composition)
      && ts.isFunctionDeclaration(item) && item.name?.text === "createApplication");
  if (!expectedFactory) return undefined;

  const skipArguments = new Map();
  function skip(node, index) {
    const indices = skipArguments.get(node) ?? new Set();
    indices.add(index);
    skipArguments.set(node, indices);
  }
  function argumentIndexesContaining(callNode, symbol, envProperty) {
    const indexes = [];
    callNode.arguments.forEach((argument, index) => {
      let found = false;
      function visit(node) {
        if (envProperty && ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression)
            && checker.getSymbolAtLocation(node.expression) === symbol && node.name.text === "env"
            && checker.getSymbolAtLocation(node.name) === envProperty) found = true;
        else if (!envProperty && ts.isIdentifier(node) && identifierValue(node) === symbol) found = true;
        if (!found) ts.forEachChild(node, visit);
      }
      visit(argument);
      if (found) indexes.push(index);
    });
    return indexes;
  }

  skip(responseCall.node, 1);
  const safeCalls = new Set([accessCall.node, responseCall.node]);
  const inactiveHttpNodes = new Set([readReadinessCall.node, staticCall.node]);
  const prefixGuardSet = new Set(prefixGuards);
  const agentGuardSet = new Set(agentGuards);
  function classifyHttpUse(callNode) {
    if (callNode === routeCall) return "allowed";
    if (safeCalls.has(callNode)) return "safe";
    if (inactiveHttpNodes.has(callNode)) return "inactive";
    if (callNode === factoryCall || apiCalls.some((call) => call.node === callNode)) return "fallback";
    return undefined;
  }
  function capturesHttpEnvironment(node) {
    let captured = false;
    function inspect(candidate) {
      if (captured) return;
      if (ts.isIdentifier(candidate) && identifierValue(candidate) === httpEnvSymbol) captured = true;
      ts.forEachChild(candidate, inspect);
    }
    inspect(node);
    return captured;
  }
  function collectHttpEnvironmentUses() {
    let valid = true;
    function visit(node) {
      if (node !== http.body && (ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node)
          || ts.isArrowFunction(node) || ts.isFunctionExpression(node))) {
        if (capturesHttpEnvironment(node)) valid = false;
        return;
      }
      if (ts.isIdentifier(node) && identifierValue(node) === httpEnvSymbol) {
        let current = node;
        let callNode;
        let index = -1;
        while (current && current !== http.body) {
          const parent = current.parent;
          if (ts.isCallExpression(parent)) {
            index = parent.arguments.findIndex((argument) => containsNode(argument, node));
            if (index >= 0) { callNode = parent; break; }
          }
          current = parent;
        }
        if (!callNode) { valid = false; return; }
        const classification = classifyHttpUse(callNode);
        if (!classification) { valid = false; return; }
        if (classification === "safe") {
          if (!callNode.arguments[index] || !directIdentifier(callNode.arguments[index], httpEnvSymbol)) valid = false;
          else skip(callNode, index);
        } else if (classification === "inactive") {
          const nodeBranch = callNode === readReadinessCall.node ? publicBranch : noMatchBranch;
          const callInsideExpectedBranch = inside(callNode, nodeBranch.thenStatement);
          if (!callInsideExpectedBranch) valid = false;
          else skip(callNode, index);
        } else if (classification === "fallback") {
          if (!inside(callNode, guard.parent) || callNode.getStart() <= guard.getStart()) valid = false;
          else skip(callNode, index);
        }
      }
      ts.forEachChild(node, visit);
    }
    visit(http.body);
    return valid;
  }
  if (!collectHttpEnvironmentUses()) return undefined;

  function functionArgumentUsesEnv(callNode, index) {
    return argumentIndexesContaining(callNode, routeInputSymbol, routeEnvProperty).includes(index);
  }

  const routeEnvOccurrences = [];
  function collectRouteEnvOccurrences(node) {
    if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression)
        && checker.getSymbolAtLocation(node.expression) === routeInputSymbol && node.name.text === "env"
        && checker.getSymbolAtLocation(node.name) === routeEnvProperty) {
      routeEnvOccurrences.push(node);
    }
    ts.forEachChild(node, collectRouteEnvOccurrences);
  }
  collectRouteEnvOccurrences(route.body);

  function nearestCallArgument(node, owner) {
    let current = node;
    while (current && current !== owner) {
      const parent = current.parent;
      if (ts.isCallExpression(parent)) {
        const index = parent.arguments.findIndex((argument) => containsNode(argument, node));
        if (index >= 0) return { call: parent, index };
      }
      current = parent;
    }
    return undefined;
  }

  function routeUseClassification(callNode, index) {
    if (callNode === modelHandlerCall && functionArgumentUsesEnv(callNode, index)) return "allowed";
    for (const guardNode of prefixGuardSet) if (inside(callNode, guardNode.thenStatement)) return "inactive";
    for (const guardNode of agentGuardSet) if (inside(callNode, guardNode.thenStatement)) return "inactive";
    for (const clause of operationExpression.caseBlock.clauses) {
      if (clause === targetCase || !inside(callNode, clause)) continue;
      return "inactive";
    }
    return undefined;
  }

  for (const occurrence of routeEnvOccurrences) {
    const use = nearestCallArgument(occurrence, route.body);
    if (!use) return undefined;
    const classification = routeUseClassification(use.call, use.index);
    if (classification === "inactive") skip(use.call, use.index);
    else if (classification !== "allowed") return undefined;
  }

  // The route row is tied to the match passed into the dispatcher, and the selected
  // switch arm returns a non-null Promise<Response> before the HTTP fallback guard.
  const specialMatch = literalProperty(checker, routeArgument, "match");
  if (!specialMatch || !resolvedMatchPath(specialMatch.value)
      || !routeEnvProperty || routeEnvProperty.flags & ts.SymbolFlags.Optional) return undefined;
  return {
    isNonEscapingArgument: (node, index) => skipArguments.get(node)?.has(index) ?? false,
  };
}
