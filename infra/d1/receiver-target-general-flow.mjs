import ts from "typescript";
import { normalized } from "./receiver-target-provenance-values.mjs";

const NONE = Object.freeze({ kind: "none" });
const UNKNOWN = Object.freeze({ kind: "unknown" });
const UNRESOLVED_ORIGIN = Object.freeze({ kind: "unresolved-origin" });
const depthLimit = 48;
const contextLimit = 4096;

function isFunction(node) {
  return node && (ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node)
    || ts.isFunctionExpression(node) || ts.isArrowFunction(node) || ts.isConstructorDeclaration(node));
}
function unwrapParens(node) {
  let value = node;
  while (value && ts.isParenthesizedExpression(value)) value = value.expression;
  return value;
}
function resolveAlias(checker, symbol) {
  return symbol && (symbol.flags & ts.SymbolFlags.Alias) !== 0 ? checker.getAliasedSymbol(symbol) : symbol;
}
function ownerFunction(node) {
  let current = node?.parent;
  while (current && !isFunction(current)) current = current.parent;
  return current;
}
function staticName(name) {
  return name && (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) ? name.text : undefined;
}
function functionImplementation(checker, symbol) {
  const resolved = resolveAlias(checker, symbol);
  return resolved?.declarations?.find((item) => isFunction(item) && item.body);
}
function sameTarget(left, right) {
  return left?.kind === "database" && right?.kind === "database" && left.target === right.target;
}
function objectValue(properties = new Map()) { return { kind: "object", properties }; }
function databaseValue(target) { return target === "core" || target === "search" ? { kind: "database", target } : UNRESOLVED_ORIGIN; }
function callableValue(declaration, closure) { return { kind: "function", declaration, closure }; }

function join(left, right) {
  if (left === right) return left;
  if (left?.kind === "unresolved-origin" || right?.kind === "unresolved-origin") return UNRESOLVED_ORIGIN;
  if (sameTarget(left, right)) return left;
  if (left?.kind === "database" || right?.kind === "database") return UNRESOLVED_ORIGIN;
  if (left?.kind === "object" && right?.kind === "object") {
    const properties = new Map();
    for (const name of new Set([...left.properties.keys(), ...right.properties.keys()])) {
      properties.set(name, left.properties.has(name) && right.properties.has(name)
        ? join(left.properties.get(name), right.properties.get(name)) : UNRESOLVED_ORIGIN);
    }
    return objectValue(properties);
  }
  if (left?.kind === "object" || right?.kind === "object") return UNRESOLVED_ORIGIN;
  if (left?.kind === "function" && right?.kind === "function"
      && left.declaration === right.declaration && left.closure === right.closure) return left;
  if (left?.kind === "function" || right?.kind === "function") return UNRESOLVED_ORIGIN;
  if (!left || !right || left.kind === "unknown" || right.kind === "unknown") return UNKNOWN;
  if (left.kind === "none" && right.kind === "none") return NONE;
  return UNKNOWN;
}

/**
 * Trace target values from configured entrypoint contexts to exact D1 prepare
 * declarations. The initial eligible source is d1-search.ts; unsupported flow
 * invalidates the current context instead of falling back to names or types.
 */
export function traceConfiguredReceiverTargets({
  program,
  checker,
  roots,
  nativePrepareDeclarations,
  rootFiles,
  eligibleSource,
}) {
  const rootFileSet = new Set(rootFiles.map(normalized));
  const mutatedSymbols = new Set();
  const mutatedProperties = new Set();
  const mutatedPropertyNames = new Set();
  const dynamicMutation = { value: false, reason: undefined };
  const databaseTypeSymbols = new Set();
  for (const root of roots) {
    const envType = checker.getDeclaredTypeOfSymbol(root.envSymbol);
    for (const name of ["CORE_DB", "SEARCH_DB"]) {
      const property = checker.getPropertyOfType(envType, name);
      if (property) {
        const type = checker.getTypeOfSymbolAtLocation(property, property.valueDeclaration ?? root.declaration);
        const symbol = type.aliasSymbol ?? type.getSymbol();
        if (symbol) databaseTypeSymbols.add(symbol);
      }
    }
  }
  for (const source of program.getSourceFiles()) {
    if (!rootFileSet.has(normalized(source.fileName))) continue;
    function visit(node) {
      const assignment = ts.isBinaryExpression(node)
        && node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment
        && node.operatorToken.kind <= ts.SyntaxKind.LastAssignment;
      const mutation = ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)
        ? node.operator === ts.SyntaxKind.PlusPlusToken || node.operator === ts.SyntaxKind.MinusMinusToken ? node.operand : undefined
        : ts.isDeleteExpression(node) ? node.expression : undefined;
      const lhs = assignment ? node.left : mutation;
      const assignmentTarget = lhs && unwrapParens(lhs);
      if (assignment && (ts.isObjectLiteralExpression(assignmentTarget)
          || ts.isArrayLiteralExpression(assignmentTarget))) {
        dynamicMutation.value = true;
        dynamicMutation.reason ??= "destructuring-assignment-target";
      }
      if ((ts.isForInStatement(node) || ts.isForOfStatement(node))
          && !ts.isVariableDeclarationList(node.initializer)) {
        dynamicMutation.value = true;
        dynamicMutation.reason ??= "loop-assignment-target";
      }
      if (assignmentTarget && ts.isIdentifier(assignmentTarget)) {
        const symbol = resolveAlias(checker, checker.getSymbolAtLocation(assignmentTarget));
        if (symbol) mutatedSymbols.add(symbol);
      } else if (assignmentTarget
          && (ts.isPropertyAccessExpression(assignmentTarget) || ts.isElementAccessExpression(assignmentTarget))) {
        const receiverType = checker.getTypeAtLocation(assignmentTarget.expression);
        const name = ts.isPropertyAccessExpression(assignmentTarget) ? assignmentTarget.name.text
          : assignmentTarget.argumentExpression && (ts.isStringLiteral(assignmentTarget.argumentExpression)
            || ts.isNumericLiteral(assignmentTarget.argumentExpression))
            ? assignmentTarget.argumentExpression.text : undefined;
        const property = ts.isPropertyAccessExpression(assignmentTarget) ? checker.getSymbolAtLocation(assignmentTarget.name)
          : name ? checker.getPropertyOfType(receiverType, name) : undefined;
        if (!name) {
          dynamicMutation.value = true;
          dynamicMutation.reason ??= "dynamic-property-write";
        } else {
          mutatedPropertyNames.add(name);
          if (property) mutatedProperties.add(property);
          if (name === "prepare") {
            dynamicMutation.value = true;
            dynamicMutation.reason ??= "native-prepare-replacement";
          }
        }
      }
      ts.forEachChild(node, visit);
    }
    visit(source);
  }
  if (dynamicMutation.value) return {
    complete: false,
    overrides: new Map(),
    reason: dynamicMutation.reason ?? "dynamic-database-property-write",
  };
  function isDatabaseTyped(node) {
    const type = checker.getTypeAtLocation(node);
    return databaseTypeSymbols.has(type.aliasSymbol ?? type.getSymbol());
  }

  const sinkRecords = new Map();
  let analyzedContexts = 0;
  let sawIncompleteContext = false;
  const globalFrame = { declaration: undefined, parent: undefined, bindings: new Map(), cache: new Map(), thisValue: NONE, incomplete: false };

  function hasOrigin(value, seen = new Set()) {
    if (!value || seen.has(value)) return false;
    seen.add(value);
    if (value.kind === "database" || value.kind === "unresolved-origin") return true;
    if (value.kind === "object") return [...value.properties.values()].some((item) => hasOrigin(item, seen));
    if (value.kind === "function") return capturedValues(value, new Set()).some((item) => hasOrigin(item, seen));
    return false;
  }
  function unresolvedShapeForType(type, location, seen = new Set()) {
    if (!type || seen.has(type)) return UNKNOWN;
    seen.add(type);
    const symbol = type.aliasSymbol ?? type.getSymbol();
    if (databaseTypeSymbols.has(symbol)) return UNRESOLVED_ORIGIN;
    if (type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) return UNKNOWN;
    if (type.isUnion()) {
      const parts = type.types.map((part) => unresolvedShapeForType(part, location, new Set(seen)));
      return parts.slice(1).reduce(join, parts[0] ?? UNKNOWN);
    }
    const properties = new Map();
    for (const property of checker.getPropertiesOfType(type)) {
      const propertyType = checker.getTypeOfSymbolAtLocation(property, property.valueDeclaration ?? location);
      const shape = unresolvedShapeForType(propertyType, property.valueDeclaration ?? location, new Set(seen));
      if (hasOrigin(shape)) properties.set(property.getName(), shape);
    }
    return properties.size > 0 ? objectValue(properties) : UNKNOWN;
  }
  function unresolvedShapeForNode(node) {
    return unresolvedShapeForType(checker.getTypeAtLocation(node), node);
  }  function capturedValues(fn, seen = new Set()) {
    if (seen.has(fn)) return [];
    seen.add(fn);
    const result = [];
    const body = fn.declaration.body;
    function visit(node) {
      if (node !== body && isFunction(node)) return;
      if (ts.isCallExpression(node)) {
        const callee = node.expression;
        const receiver = ts.isPropertyAccessExpression(callee)
          ? evalNode(callee.expression, fn.closure ?? globalFrame, new Set())
          : evalNode(callee, fn.closure ?? globalFrame, new Set());
        if (hasOrigin(receiver)) result.push(receiver);
        for (const argument of node.arguments) {
          const value = ts.isSpreadElement(argument) ? UNKNOWN : evalNode(argument, fn.closure ?? globalFrame, new Set());
          if (hasOrigin(value)) result.push(value);
        }
        return;
      }
      if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
        const value = evalNode(node, fn.closure ?? globalFrame, new Set());
        if (hasOrigin(value)) result.push(value);
        return;
      }
      if (ts.isIdentifier(node)) {
        const symbol = resolveAlias(checker, checker.getSymbolAtLocation(node));
        if (symbol && symbol.valueDeclaration && ownerFunction(symbol.valueDeclaration) !== fn.declaration) {
          const value = lookup(symbol, fn.closure ?? globalFrame, new Set());
          if (hasOrigin(value)) result.push(value);
        }
      }
      ts.forEachChild(node, visit);
    }
    if (body) visit(body);
    return result;
  }
  function frameFor(frame, declaration) {
    const owner = ownerFunction(declaration);
    let current = frame;
    while (current) {
      if (current.declaration === owner) return current;
      current = current.parent;
    }
    return globalFrame;
  }
  function lookup(symbol, frame, resolving) {
    if (!symbol) return UNKNOWN;
    const resolved = resolveAlias(checker, symbol);
    if (mutatedSymbols.has(resolved)) {
      const declaration = resolved.valueDeclaration ?? resolved.declarations?.[0] ?? frame?.declaration;
      return unresolvedShapeForType(checker.getTypeOfSymbolAtLocation(resolved, declaration), declaration);
    }
    let current = frame;
    while (current) {
      if (current.bindings.has(resolved)) return current.bindings.get(resolved);
      current = current.parent;
    }
    if (globalFrame.bindings.has(resolved)) return globalFrame.bindings.get(resolved);
    if (resolving.has(resolved)) return UNKNOWN;
    const declaration = resolved.valueDeclaration ?? resolved.declarations?.[0];
    if (isFunction(declaration) && declaration.body) return callableValue(declaration, frameFor(frame, declaration));
    if (declaration && ts.isVariableDeclaration(declaration)) {
      const declarationFrame = frameFor(frame, declaration);
      if (mutatedSymbols.has(resolved) || !declaration.initializer
          || (ts.getCombinedNodeFlags(declaration.parent) & ts.NodeFlags.Const) === 0) return isDatabaseTyped(declaration) ? UNRESOLVED_ORIGIN : UNKNOWN;
      resolving.add(resolved);
      const value = evalNode(declaration.initializer, declarationFrame, resolving);
      resolving.delete(resolved);
      return value;
    }
    return NONE;
  }
  function recordSink(node, value, frame) {
    const path = normalized(node.getSourceFile().fileName);
    if (!eligibleSource(path)) return;
    const records = sinkRecords.get(path) ?? new Map();
    const offset = node.getStart(node.getSourceFile());
    const prior = records.get(offset);
    const next = { value: prior ? join(prior.value, value) : value, frames: new Set(prior?.frames ?? []) };
    next.frames.add(frame);
    records.set(offset, next);
    sinkRecords.set(path, records);
  }
  function callTarget(node, frame, resolving) {
    const callee = evalNode(node.expression, frame, resolving);
    if (callee.kind === "function") return callee;
    const signatureDeclaration = checker.getResolvedSignature(node)?.declaration;
    const implementation = functionImplementation(checker, checker.getSymbolAtLocation(
      signatureDeclaration?.name ?? node.expression,
    ));
    return implementation ? callableValue(implementation, frame) : undefined;
  }
  function invoke(fn, args, thisValue, parentFrame, stack) {
    analyzedContexts += 1;
    if (analyzedContexts > contextLimit || stack.length >= depthLimit
        || stack.some((item) => item.declaration === fn.declaration)) {
      if (parentFrame) parentFrame.incomplete = true;
      sawIncompleteContext = true;
      return UNKNOWN;
    }
    const frame = {
      declaration: fn.declaration,
      parent: fn.closure ?? parentFrame ?? globalFrame,
      bindings: new Map(),
      cache: new Map(),
      thisValue: thisValue ?? NONE,
      incomplete: false,
    };
    fn.declaration.parameters?.forEach((parameter, index) => {
      if (!ts.isIdentifier(parameter.name)) {
        if (hasOrigin(args[index])) frame.incomplete = true;
        return;
      }
      const symbol = resolveAlias(checker, checker.getSymbolAtLocation(parameter.name));
      if (symbol) {
        const incoming = args[index] ?? NONE;
        const fallback = incoming.kind === "none" || incoming.kind === "unknown"
          ? unresolvedShapeForNode(parameter) : UNKNOWN;
        const bound = hasOrigin(fallback) ? fallback : incoming;
        if (hasOrigin(fallback)) frame.incomplete = true;
        frame.bindings.set(symbol, bound);
      }
    });
    const nextStack = [...stack, fn];
    frame.stack = nextStack;
    const returns = [];
    const body = fn.declaration.body;
    if (!body) return UNKNOWN;
    function scan(node) {
      if (node !== body && isFunction(node)) return;
      if (ts.isCallExpression(node)) { evalNode(node, frame, new Set()); return; }
      if (ts.isReturnStatement(node)) { returns.push(node.expression ? evalNode(node.expression, frame, new Set()) : NONE); return; }
      ts.forEachChild(node, scan);
    }
    scan(body);
    const result = returns.length === 0 ? NONE : returns.slice(1).reduce(join, returns[0]);
    if (frame.incomplete) sawIncompleteContext = true;
    return result;
  }
  function evalCall(node, frame, resolving) {
    const signatureDeclaration = checker.getResolvedSignature(node)?.declaration;
    const nativeProperty = ts.isPropertyAccessExpression(node.expression)
      ? checker.getSymbolAtLocation(node.expression.name) : undefined;
    const nativeAlias = ts.isIdentifier(node.expression) ? resolveAlias(checker, checker.getSymbolAtLocation(node.expression)) : undefined;
    if (signatureDeclaration && nativePrepareDeclarations.has(signatureDeclaration)
        && ts.isPropertyAccessExpression(node.expression)
        && !mutatedProperties.has(nativeProperty) && !mutatedPropertyNames.has(node.expression.name.text)
        && !mutatedSymbols.has(nativeAlias)) {
      const receiver = evalNode(node.expression.expression, frame, resolving);
      recordSink(node, receiver.kind === "database" ? receiver : UNKNOWN, frame);
      return NONE;
    }
    const target = callTarget(node, frame, resolving);
    const args = node.arguments.map((argument) => ts.isSpreadElement(argument)
      ? UNKNOWN : evalNode(argument, frame, resolving));
    const receiver = ts.isPropertyAccessExpression(node.expression)
      ? evalNode(node.expression.expression, frame, resolving) : NONE;
    if (target) return invoke(target, args, receiver, frame, frame?.stack ?? []);
    if (hasOrigin(receiver) || args.some((argument) => hasOrigin(argument))) frame.incomplete = true;
    return UNKNOWN;
  }
  function evalNode(node, frame, resolving) {
    const expression = unwrapParens(node);
    if (!expression) return NONE;
    if (ts.isParenthesizedExpression(expression)) return evalNode(expression.expression, frame, resolving);
    if (ts.isAsExpression(expression) || ts.isTypeAssertionExpression(expression)
        || ts.isSatisfiesExpression(expression) || ts.isNonNullExpression(expression)) {
      const inner = evalNode(expression.expression, frame, resolving);
      if (hasOrigin(inner)) frame.incomplete = true;
      return hasOrigin(inner) ? UNKNOWN : inner;
    }
    if (ts.isAwaitExpression(expression)) return evalNode(expression.expression, frame, resolving);
    if (ts.isIdentifier(expression)) return lookup(checker.getSymbolAtLocation(expression), frame, resolving);
    if (expression.kind === ts.SyntaxKind.ThisKeyword) return frame.thisValue;
    if (ts.isPropertyAccessExpression(expression)) {
      const receiver = evalNode(expression.expression, frame, resolving);
      if (receiver.kind === "object") {
        const property = checker.getSymbolAtLocation(expression.name);
        if (mutatedProperties.has(property) || mutatedPropertyNames.has(expression.name.text)) {
          return isDatabaseTyped(expression) ? UNRESOLVED_ORIGIN : UNKNOWN;
        }
        return receiver.properties.get(expression.name.text) ?? unresolvedShapeForNode(expression);
      }
      return receiver.kind === "unresolved-origin" || isDatabaseTyped(expression)
        ? UNRESOLVED_ORIGIN : receiver.kind === "unknown" ? UNKNOWN : NONE;
    }
    if (ts.isElementAccessExpression(expression)) {
      const receiver = evalNode(expression.expression, frame, resolving);
      if (receiver.kind !== "object" || !ts.isStringLiteral(expression.argumentExpression)) {
        if (hasOrigin(receiver)) frame.incomplete = true;
        return hasOrigin(receiver) || isDatabaseTyped(expression) ? UNRESOLVED_ORIGIN : NONE;
      }
      const property = checker.getPropertyOfType(checker.getTypeAtLocation(expression.expression), expression.argumentExpression.text);
      if (mutatedProperties.has(property) || mutatedPropertyNames.has(expression.argumentExpression.text)) {
        return isDatabaseTyped(expression) ? UNRESOLVED_ORIGIN : UNKNOWN;
      }
      return receiver.properties.get(expression.argumentExpression.text) ?? unresolvedShapeForNode(expression);
    }
    if (ts.isObjectLiteralExpression(expression)) {
      const properties = new Map();
      for (const property of expression.properties) {
        if (ts.isSpreadAssignment(property) || !property.name || ts.isComputedPropertyName(property.name)) {
          frame.incomplete = true;
          return UNKNOWN;
        }
        const name = staticName(property.name);
        if (!name) { frame.incomplete = true; return UNKNOWN; }
        const symbol = checker.getSymbolAtLocation(property.name);
        if (mutatedPropertyNames.has(name) || (symbol && mutatedProperties.has(symbol))) {
          frame.incomplete = true;
          return UNKNOWN;
        }
        if (ts.isPropertyAssignment(property)) properties.set(name, evalNode(property.initializer, frame, resolving));
        else if (ts.isShorthandPropertyAssignment(property)) properties.set(name,
          lookup(checker.getShorthandAssignmentValueSymbol(property), frame, resolving));
        else if (ts.isMethodDeclaration(property) && property.body) properties.set(name, callableValue(property, frame));
        else { frame.incomplete = true; return UNKNOWN; }
      }
      return objectValue(properties);
    }
    if (isFunction(expression)) return callableValue(expression, frame);
    if (ts.isCallExpression(expression)) return evalCall(expression, frame, resolving);
    if (ts.isConditionalExpression(expression)) return join(
      evalNode(expression.whenTrue, frame, resolving), evalNode(expression.whenFalse, frame, resolving),
    );
    if (ts.isBinaryExpression(expression) && expression.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken) {
      return join(evalNode(expression.left, frame, resolving), evalNode(expression.right, frame, resolving));
    }
    if (ts.isArrayLiteralExpression(expression)) {
      const values = expression.elements.map((item) => ts.isSpreadElement(item) ? UNKNOWN : evalNode(item, frame, resolving));
      return objectValue(new Map(values.map((value, index) => [String(index), value])));
    }
    if (expression.kind === ts.SyntaxKind.NullKeyword || ts.isStringLiteral(expression)
        || ts.isNumericLiteral(expression) || ts.isBooleanLiteral(expression)) return NONE;
    return UNKNOWN;
  }

  for (const root of roots) {
    const envProperties = new Map();
    for (const name of ["CORE_DB", "SEARCH_DB"]) {
      const property = checker.getPropertyOfType(checker.getDeclaredTypeOfSymbol(root.envSymbol), name);
      envProperties.set(name, databaseValue(root.bindings.get(property)));
    }
    const envValue = objectValue(envProperties);
    const rootFunction = callableValue(root.declaration, globalFrame);
    const args = root.declaration.parameters.map((parameter, index) => index === 1 ? envValue
      : index === 0 ? NONE : NONE);
    const thisValue = root.thisEnv ? objectValue(new Map([["env", envValue]])) : NONE;
    invoke(rootFunction, args, thisValue, globalFrame, []);
  }

  const overrides = new Map();
  for (const [path, records] of sinkRecords) {
    const file = program.getSourceFiles().find((source) => normalized(source.fileName) === path);
    if (!file) continue;
    const targets = new Map();
    for (const [offset, record] of records) {
      const invalidFrame = [...record.frames].some((frame) => {
        let current = frame;
        while (current) {
          if (current.incomplete) return true;
          current = current.parent;
        }
        return false;
      });
      const targetStore = invalidFrame || record.value.kind !== "database" ? "unknown" : record.value.target;
      if (targetStore !== "unknown") targets.set(offset, {
        targetStore,
        targetStatus: "resolved-local-const-alias",
      });
    }
    if (targets.size > 0) overrides.set(path, targets);
  }
  return {
    complete: !sawIncompleteContext,
    overrides,
    reason: sawIncompleteContext ? "one-or-more-rooted-contexts-remain-unknown" : undefined,
  };
}
