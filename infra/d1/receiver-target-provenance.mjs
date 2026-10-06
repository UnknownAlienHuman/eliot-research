import { resolve } from "node:path";
import ts from "typescript";
import { propagateEscapedTargetBindings } from "./receiver-target-escape-analysis.mjs";
import { createModelQualificationTargetPolicy } from "./receiver-target-provenance-model-qualification.mjs";
import { mergeModelQualificationPass } from "./receiver-target-provenance-pass.mjs";
import { findDetachedProjectionCalls } from "./receiver-target-provenance-projection.mjs";
import { createGeneralReceiverTargetOverrides } from "./receiver-target-general.mjs";
import {
  canonicalDeclaration,
  compilerOptions,
  declarationForIdentifier,
  emptyValue,
  factForValue,
  functionKey,
  hasBody,
  isFunctionDeclaration,
  mergeValues,
  normalized,
  propertyName,
  sourceUnder,
  targetBits,
  trackedFields,
  typeIdentity,
  updateValue,
  unwrap,
} from "./receiver-target-provenance-values.mjs";

/**
 * Build overrides for bounded Worker Env paths: erasure composition and the
 * one model-qualification failure-summary route. Call edges are TypeChecker-
 * resolved; direct callers join parameter facts and unsupported edges stay unknown.
 */
export function createErasureReceiverTargetOverrides(files, root, suppliedProgram, pass = "combined") {
  const envPath = resolve(root, "apps/eliotr-core/src/env.ts");
  const workerPath = resolve(root, "apps/eliotr-core/src/index.ts");
  const httpPath = resolve(root, "apps/eliotr-core/src/http.ts");
  const compositionPath = resolve(root, "apps/eliotr-core/src/composition-root.ts");
  const ownerServicePath = resolve(root, "apps/eliotr-core/src/erasure-owner-service.ts");
  const appRuntimePath = resolve(root, "apps/eliotr-core/src/erasure-runtime.ts");
  const operationsPath = resolve(root, "packages/cloudflare-erasure-operations/src/erasure-runtime.ts");
  const backendPath = resolve(root, "packages/cloudflare-erasure/src/factory.ts");
  const erasureSourceRoot = resolve(root, "packages/cloudflare-erasure/src");
  const rootNames = [...new Set(files.map((file) => resolve(file)))];
  const program = suppliedProgram ?? ts.createProgram(rootNames, compilerOptions(root));
  if (pass === "combined") return mergeModelQualificationPass((selected) =>
    createErasureReceiverTargetOverrides(files, root, program, selected));
  if (pass === "general") return createGeneralReceiverTargetOverrides({ files, root, program, checker: program.getTypeChecker() });
  const checker = program.getTypeChecker();
  const envSource = program.getSourceFile(envPath);
  const envDeclaration = envSource?.statements.find((statement) => ts.isInterfaceDeclaration(statement)
    && statement.name.text === "Env");
  const envSymbol = envDeclaration && checker.getSymbolAtLocation(envDeclaration.name);
  const envType = envSymbol && checker.getDeclaredTypeOfSymbol(envSymbol);
  const workerSource = program.getSourceFile(workerPath);
  const defaultExport = workerSource?.statements.find((statement) => ts.isExportAssignment(statement) && !statement.isExportEquals);
  const workerSatisfies = defaultExport && ts.isSatisfiesExpression(defaultExport.expression) ? defaultExport.expression : undefined;
  const workerHandlerType = workerSatisfies?.type;
  const workerHandlerEnv = workerHandlerType && ts.isTypeReferenceNode(workerHandlerType)
    && ts.isIdentifier(workerHandlerType.typeName) && workerHandlerType.typeName.text === "ExportedHandler"
    ? workerHandlerType.typeArguments?.[0] : undefined;
  const workerObject = workerSatisfies && unwrap(workerSatisfies.expression);
  const workerFetch = workerObject && ts.isObjectLiteralExpression(workerObject)
    ? workerObject.properties.find((property) => ts.isMethodDeclaration(property)
      && propertyName(property.name) === "fetch") : undefined;
  const httpSource = program.getSourceFile(httpPath);
  const handleHttp = httpSource?.statements.find((statement) => ts.isFunctionDeclaration(statement)
    && statement.name?.text === "handleHttp");
  const compositionSource = program.getSourceFile(compositionPath);
  const createApplication = compositionSource?.statements.find((statement) => ts.isFunctionDeclaration(statement)
    && statement.name?.text === "createApplication");
  const ownerApi = compositionSource?.statements.find((statement) => ts.isFunctionDeclaration(statement)
    && statement.name?.text === "ownerApi");
  const ownerServiceSource = program.getSourceFile(ownerServicePath);
  const createOwnerService = ownerServiceSource?.statements.find((statement) => ts.isFunctionDeclaration(statement)
    && statement.name?.text === "createErasureOwnerService");
  const appRuntime = program.getSourceFile(appRuntimePath);
  const appCoordinator = appRuntime?.statements.find((statement) => ts.isFunctionDeclaration(statement)
    && statement.name?.text === "createConfiguredErasureCoordinator");
  const operationsSource = program.getSourceFile(operationsPath);
  const operationsEntry = operationsSource?.statements.find((statement) => ts.isFunctionDeclaration(statement)
    && statement.name?.text === "createConfiguredErasureCoordinator");
  const backendSource = program.getSourceFile(backendPath);
  const backendEntry = backendSource?.statements.find((statement) => ts.isFunctionDeclaration(statement)
    && statement.name?.text === "createConfiguredErasureBackend");
  if (!envSymbol || !envType || !workerFetch || !handleHttp || !createApplication || !ownerApi
      || !createOwnerService || !appCoordinator || !operationsEntry || !backendEntry
      || !workerHandlerEnv || typeIdentity(checker, workerHandlerEnv) !== envSymbol) return new Map();

  const envPropertySymbols = new Map();
  for (const name of ["CORE_DB", "SEARCH_DB"]) {
    const property = checker.getPropertyOfType(envType, name);
    if (property) envPropertySymbols.set(name, property);
  }
  if (envPropertySymbols.size !== 2) return new Map();

  const rootFileSet = new Set(rootNames.map(normalized));
  const calls = [];
  const declarations = new Map();
  function visitSource(source) {
    if (!rootFileSet.has(normalized(source.fileName))) return;
    function visit(node) {
      if (isFunctionDeclaration(node) && hasBody(node)) {
        const key = functionKey(checker, node);
        if (key) declarations.set(key, canonicalDeclaration(checker, node));
      }
      if (ts.isCallExpression(node)) {
        const signatureDeclaration = checker.getResolvedSignature(node)?.declaration;
        const callee = canonicalDeclaration(checker, signatureDeclaration);
        const key = functionKey(checker, callee);
        if (callee && key) {
          let owner = node.parent;
          while (owner && !isFunctionDeclaration(owner)) owner = owner.parent;
          const ownerKey = owner ? functionKey(checker, owner) : undefined;
          calls.push({ node, callee, calleeKey: key, owner, ownerKey, source });
        }
      }
      ts.forEachChild(node, visit);
    }
    visit(source);
  }
  for (const source of program.getSourceFiles()) visitSource(source);

  const workerKey = functionKey(checker, workerFetch);
  const httpKey = functionKey(checker, handleHttp);
  const applicationKey = functionKey(checker, createApplication);
  const ownerApiKey = functionKey(checker, ownerApi);
  const ownerServiceKey = functionKey(checker, createOwnerService);
  const appCoordinatorKey = functionKey(checker, appCoordinator);
  const operationsKey = functionKey(checker, operationsEntry);
  const backendKey = functionKey(checker, backendEntry);
  const callRecordsByCallee = new Map();
  for (const call of calls) {
    const records = callRecordsByCallee.get(call.calleeKey) ?? [];
    records.push(call);
    callRecordsByCallee.set(call.calleeKey, records);
  }
  const modelQualificationPolicy = createModelQualificationTargetPolicy({
    root, program, checker, calls, functionKey, canonicalDeclaration,
  });
  if (pass === "model" && !modelQualificationPolicy) return new Map();

  const workerEnvParameter = workerFetch.parameters[1];
  const httpCallers = callRecordsByCallee.get(httpKey) ?? [];
  const httpDependenciesParameter = handleHttp.parameters[3];
  const emptyDefaultDependencies = httpDependenciesParameter?.initializer
    && ts.isObjectLiteralExpression(unwrap(httpDependenciesParameter.initializer))
    && unwrap(httpDependenciesParameter.initializer).properties.length === 0;
  const factoryDeclaration = handleHttp.body && (() => {
    let found;
    function find(node) {
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === "factory") found = node;
      if (!found) ts.forEachChild(node, find);
    }
    find(handleHttp.body);
    return found;
  })();
  const factoryInitializer = factoryDeclaration?.initializer && unwrap(factoryDeclaration.initializer);
  const factoryExpression = factoryInitializer && ts.isBinaryExpression(factoryInitializer)
      && factoryInitializer.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken
    ? factoryInitializer : undefined;
  const fallbackExpression = factoryExpression && unwrap(factoryExpression.right);
  const factorySymbol = factoryDeclaration && checker.getSymbolAtLocation(factoryDeclaration.name);
  const dependenciesSymbol = httpDependenciesParameter && checker.getSymbolAtLocation(httpDependenciesParameter.name);
  const fallbackIsCreateApplication = fallbackExpression && ts.isIdentifier(fallbackExpression)
    && functionKey(checker, declarationForIdentifier(checker, fallbackExpression)) === applicationKey;
  const factoryLeft = factoryExpression && unwrap(factoryExpression.left);
  const fallbackReadsDefaultDependencies = factoryLeft && ts.isPropertyAccessExpression(factoryLeft)
    && factoryLeft.name.text === "applicationFactory" && ts.isIdentifier(factoryLeft.expression)
    && checker.getSymbolAtLocation(factoryLeft.expression) === dependenciesSymbol;
  const workerIsOnlyHttpCaller = httpCallers.length > 0 && httpCallers.every((call) => call.ownerKey === workerKey
    && call.node.arguments.length <= 3);
  const defaultApplicationFactoryIsProven = Boolean(emptyDefaultDependencies && fallbackIsCreateApplication
    && fallbackReadsDefaultDependencies && workerIsOnlyHttpCaller);
  if (defaultApplicationFactoryIsProven && factorySymbol) {
    for (const call of calls) {
      if (call.ownerKey === httpKey && ts.isIdentifier(call.node.expression)
          && checker.getSymbolAtLocation(call.node.expression) === factorySymbol) {
        call.callee = createApplication;
        call.calleeKey = applicationKey;
        call.calleeResolvedByDefault = true;
      }
    }
    callRecordsByCallee.clear();
    for (const call of calls) {
      const records = callRecordsByCallee.get(call.calleeKey) ?? [];
      records.push(call);
      callRecordsByCallee.set(call.calleeKey, records);
    }
  }

  function functionFile(declaration) {
    return declaration?.getSourceFile().fileName ?? "";
  }
  function isErasureSource(declaration) {
    return sourceUnder(functionFile(declaration), erasureSourceRoot);
  }
  function allowedEdge(parent, child) {
    const parentKey = functionKey(checker, parent);
    const childKey = functionKey(checker, child);
    if (pass === "model") {
      if (parentKey === workerKey) return childKey === httpKey;
      return modelQualificationPolicy?.allowsCall(parent, child) ?? false;
    }
    if (modelQualificationPolicy?.allowsCall(parent, child)) return true;
    if (parentKey === workerKey) return childKey === httpKey;
    if (parentKey === httpKey) return defaultApplicationFactoryIsProven && childKey === applicationKey;
    if (parentKey === applicationKey) return childKey === ownerApiKey;
    function nestedWithinOwnerApi(node) {
      let current = node.parent;
      while (current) {
        if (isFunctionDeclaration(current) && functionKey(checker, current) === ownerApiKey) return true;
        current = current.parent;
      }
      return false;
    }
    if (parentKey === ownerApiKey || nestedWithinOwnerApi(parent)) return childKey === ownerServiceKey;
    if (parentKey === ownerServiceKey) return childKey === appCoordinatorKey;
    if (parentKey === appCoordinatorKey) return childKey === operationsKey;
    if (parentKey === operationsKey) return childKey === backendKey;
    return isErasureSource(parent) && isErasureSource(child);
  }

  if (!workerEnvParameter || typeIdentity(checker, workerEnvParameter) !== envSymbol) return new Map();
  const detachedProjectionCalls = findDetachedProjectionCalls({
    checker,
    rootFileSet,
    workerFetch,
    workerEnvParameter,
    envType,
    envPropertySymbols,
  });

  const reachable = new Map();
  const queue = [workerFetch];
  while (queue.length > 0) {
    const current = queue.shift();
    const currentKey = functionKey(checker, current);
    if (!currentKey || reachable.has(currentKey)) continue;
    reachable.set(currentKey, current);
    function addNested(node) {
      if (node !== current && isFunctionDeclaration(node)) {
        const nestedKey = functionKey(checker, node);
        const permitted = !modelQualificationPolicy?.restrictNested(current)
          || modelQualificationPolicy.isApprovedNested(current, node);
        if (permitted && nestedKey && !reachable.has(nestedKey)) queue.push(node);
        return;
      }
      ts.forEachChild(node, addNested);
    }
    if (current.body) addNested(current.body);
    for (const call of calls) {
      if (call.ownerKey !== currentKey || !allowedEdge(current, call.callee)) continue;
      if (!reachable.has(call.calleeKey)) queue.push(call.callee);
    }
  }

  const parameterFacts = new Map();
  const seedEnv = {
    self: 0,
    fields: new Map([["CORE_DB", targetBits.core], ["SEARCH_DB", targetBits.search]]),
    objects: new Map(),
    symbols: envPropertySymbols,
    knownShape: true,
  };
  const workerEnvParameterSymbol = checker.getSymbolAtLocation(workerEnvParameter.name);
  if (!workerEnvParameterSymbol) return new Map();
  parameterFacts.set(workerEnvParameterSymbol, seedEnv);

  const mutatedSymbols = new Set();
  const mutatedProperties = new Set();
  const escapedSymbols = new Set();
  const escapedProperties = new Set();
  function collectMutations(source) {
    if (!rootFileSet.has(normalized(source.fileName))) return;
    function visit(node) {
      const lhs = ts.isBinaryExpression(node) && node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment
        && node.operatorToken.kind <= ts.SyntaxKind.LastAssignment ? unwrap(node.left)
        : ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)
          ? ((node.operator === ts.SyntaxKind.PlusPlusToken || node.operator === ts.SyntaxKind.MinusMinusToken) ? unwrap(node.operand) : undefined)
          : ts.isDeleteExpression(node) ? unwrap(node.expression) : undefined;
      if (lhs && ts.isIdentifier(lhs)) {
        const symbol = checker.getSymbolAtLocation(lhs);
        if (symbol) mutatedSymbols.add(symbol);
      } else if (lhs && (ts.isPropertyAccessExpression(lhs) || ts.isElementAccessExpression(lhs))) {
        const name = ts.isPropertyAccessExpression(lhs) ? lhs.name.text
          : lhs.argumentExpression && ts.isStringLiteral(lhs.argumentExpression) ? lhs.argumentExpression.text : undefined;
        const symbol = ts.isPropertyAccessExpression(lhs) ? checker.getSymbolAtLocation(lhs.name) : undefined;
        if (name && trackedFields.has(name) && symbol) mutatedProperties.add(symbol);
      }
      ts.forEachChild(node, visit);
    }
    visit(source);
  }
  for (const source of program.getSourceFiles()) collectMutations(source);

  function environmentParameter(symbol) {
    const facts = parameterFacts.get(symbol);
    return facts ?? emptyValue();
  }

  function writeIsKnown(node, symbol) {
    return !mutatedSymbols.has(symbol) && !mutatedProperties.has(checker.getSymbolAtLocation(node.name));
  }

  function objectField(value, name, propertySymbol, requireSymbolMatch = true) {
    if (propertySymbol && (mutatedProperties.has(propertySymbol) || escapedProperties.has(propertySymbol))) return targetBits.unknown;
    const exact = value.symbols.get(name);
    const bits = value.fields.get(name);
    return requireSymbolMatch && exact && propertySymbol && exact !== propertySymbol ? targetBits.unknown
      : bits ?? (value.knownShape ? 0 : targetBits.unknown);
  }

  function bindArgument(argument, parameter, finalPass) {
    const actual = argument ?? parameter.initializer;
    if (!actual || ts.isSpreadElement(actual) || !ts.isIdentifier(parameter.name)) {
      return { self: targetBits.unknown, fields: new Map(), objects: new Map(), symbols: new Map(), knownShape: false };
    }
    const value = evaluate(actual, new Set());
    const parameterType = checker.getTypeAtLocation(parameter);
    const fields = new Map();
    const objects = new Map();
    const symbols = new Map();
    for (const property of checker.getPropertiesOfType(parameterType)) {
      const name = property.getName();
      if (!trackedFields.has(name)) continue;
      if (value.objects.has(name)) {
        objects.set(name, value.objects.get(name));
        symbols.set(name, property);
        continue;
      }
      const bits = objectField(value, name, property, false);
      fields.set(name, bits === 0 && finalPass ? targetBits.unknown : bits);
      symbols.set(name, property);
    }
    const self = value.self === 0 && finalPass ? targetBits.unknown : value.self;
    return { self, fields, objects, symbols, knownShape: value.knownShape };
  }

  function parameterSymbol(parameter) {
    return ts.isIdentifier(parameter.name) ? checker.getSymbolAtLocation(parameter.name) : undefined;
  }

  function applyCall(call, finalPass) {
    const callee = call.callee;
    let changed = false;
    for (let index = 0; index < callee.parameters.length; index += 1) {
      const parameter = callee.parameters[index];
      const symbol = parameterSymbol(parameter);
      if (!symbol) continue;
      const incoming = bindArgument(call.node.arguments[index], parameter, finalPass);
      const updated = updateValue(parameterFacts.get(symbol), incoming);
      if (updated.changed) {
        parameterFacts.set(symbol, updated.next);
        changed = true;
      }
    }
    return changed;
  }

  function allowedCaller(call) {
    return call.owner && call.ownerKey && reachable.has(call.ownerKey)
      && (allowedEdge(call.owner, call.callee)
        || (!reachable.has(call.calleeKey) && modelQualificationPolicy?.isOpaqueD1Handoff(call)));
  }

  let changed = true;
  let rounds = 0;
  while (changed && rounds < 64) {
    changed = false;
    rounds += 1;
    for (const [key] of reachable) {
      if (key === workerKey) continue;
      for (const call of callRecordsByCallee.get(key) ?? []) {
        if (allowedCaller(call)) changed = applyCall(call, false) || changed;
      }
    }
  }

  for (const [key] of reachable) {
    if (key === workerKey) continue;
    for (const call of callRecordsByCallee.get(key) ?? []) {
      if (allowedCaller(call)) applyCall(call, true);
      else {
        for (const parameter of call.callee.parameters) {
          const symbol = parameterSymbol(parameter);
          if (!symbol) continue;
          const incoming = { self: targetBits.unknown, fields: new Map(), objects: new Map(), symbols: new Map(), knownShape: false };
          for (const property of checker.getPropertiesOfType(checker.getTypeAtLocation(parameter))) {
            const name = property.getName();
            if (trackedFields.has(name)) {
              if (name === "env") {
                const nestedUnknown = emptyValue(true);
                nestedUnknown.self = targetBits.unknown;
                nestedUnknown.fields.set("CORE_DB", targetBits.unknown);
                nestedUnknown.fields.set("SEARCH_DB", targetBits.unknown);
                incoming.objects.set(name, nestedUnknown);
              } else incoming.fields.set(name, targetBits.unknown);
              incoming.symbols.set(name, property);
            }
          }
          const updated = updateValue(parameterFacts.get(symbol), incoming);
          parameterFacts.set(symbol, updated.next);
        }
      }
    }
  }

  changed = true;
  rounds = 0;
  while (changed && rounds < 64) {
    changed = false;
    rounds += 1;
  for (const [key] of reachable) {
      if (key === workerKey) continue;
      for (const call of callRecordsByCallee.get(key) ?? []) {
        if (allowedCaller(call)) changed = applyCall(call, true) || changed;
      }
    }
  }

  function evaluateIdentifierSymbol(symbol, resolving) {
    if (!symbol) return { ...emptyValue(), self: targetBits.unknown };
    const declaration = symbol.valueDeclaration;
    if (escapedSymbols.has(symbol)) {
      if (parameterFacts.has(symbol)) return poisonValue(parameterFacts.get(symbol));
      if (declaration && ts.isVariableDeclaration(declaration) && declaration.initializer && !resolving.has(symbol)) {
        resolving.add(symbol);
        const value = evaluate(declaration.initializer, resolving);
        resolving.delete(symbol);
        return poisonValue(value);
      }
      return poisonValue(environmentParameter(symbol));
    }
    if (parameterFacts.has(symbol)) return parameterFacts.get(symbol);
    if (declaration && ts.isVariableDeclaration(declaration)) {
      if ((ts.getCombinedNodeFlags(declaration.parent) & ts.NodeFlags.Const) === 0
          || !declaration.initializer || !writeIsKnown(declaration, symbol) || resolving.has(symbol)) {
        return { ...emptyValue(), self: targetBits.unknown };
      }
      resolving.add(symbol);
      const result = evaluate(declaration.initializer, resolving);
      resolving.delete(symbol);
      return result;
    }
    if (declaration && ts.isParameter(declaration)) {
      const value = environmentParameter(symbol);
      return value.self === 0 && value.fields.size === 0 && value.objects.size === 0
        ? { ...value, self: targetBits.unknown } : value;
    }
    return { ...emptyValue(), self: targetBits.unknown };
  }

  function evaluate(node, resolving) {
    const expression = unwrap(node);
    if (!expression) return emptyValue();
    if (ts.isIdentifier(expression)) return evaluateIdentifierSymbol(checker.getSymbolAtLocation(expression), resolving);
    if (ts.isPropertyAccessExpression(expression) || ts.isElementAccessExpression(expression)) {
      const name = ts.isPropertyAccessExpression(expression) ? expression.name.text
        : expression.argumentExpression && ts.isStringLiteral(expression.argumentExpression) ? expression.argumentExpression.text : undefined;
      if (!name || !trackedFields.has(name)) return { ...emptyValue(), self: targetBits.unknown };
      const symbol = ts.isPropertyAccessExpression(expression) ? checker.getSymbolAtLocation(expression.name) : undefined;
      if (symbol && (mutatedProperties.has(symbol) || escapedProperties.has(symbol))) {
        return { ...emptyValue(), self: targetBits.unknown };
      }
      const base = evaluate(expression.expression, resolving);
      const nested = base.objects.get(name);
      if (nested) {
        const exact = base.symbols.get(name);
        if (exact && symbol && exact !== symbol) return { ...emptyValue(), self: targetBits.unknown };
        return nested;
      }
      const bits = objectField(base, name, symbol);
      return { ...emptyValue(), self: bits || (base.self === 0 && base.fields.size === 0 && base.objects.size === 0 ? 0 : targetBits.unknown) };
    }
    if (ts.isObjectLiteralExpression(expression)) {
      const fields = new Map();
      const objects = new Map();
      const symbols = new Map();
      let knownShape = true;
      for (const property of expression.properties) {
        if (ts.isSpreadAssignment(property)) {
          const spread = evaluate(property.expression, resolving);
          if (!spread.knownShape) {
            for (const name of trackedFields) {
              if (name === "env") {
                const nestedUnknown = emptyValue(true);
                nestedUnknown.self = targetBits.unknown;
                nestedUnknown.fields.set("CORE_DB", targetBits.unknown);
                nestedUnknown.fields.set("SEARCH_DB", targetBits.unknown);
                objects.set(name, nestedUnknown);
              } else fields.set(name, targetBits.unknown);
            }
          } else {
            for (const name of trackedFields) {
              if (spread.fields.has(name)) fields.set(name, spread.fields.get(name));
              if (spread.objects.has(name)) objects.set(name, spread.objects.get(name));
            }
          }
          for (const [name, symbol] of spread.symbols) symbols.set(name, symbol);
        } else if (ts.isPropertyAssignment(property)) {
          const name = propertyName(property.name);
          if (!name || !trackedFields.has(name)) continue;
          const value = evaluate(property.initializer, resolving);
          if (name === "env" && (value.knownShape || value.fields.size > 0 || value.objects.size > 0)) {
            objects.set(name, value);
            fields.delete(name);
          } else fields.set(name, value.self === 0 ? targetBits.unknown : value.self);
          const objectType = checker.getTypeAtLocation(expression);
          const symbol = checker.getPropertyOfType(objectType, name) ?? checker.getSymbolAtLocation(property.name);
          if (symbol) symbols.set(name, symbol);
        } else if (ts.isShorthandPropertyAssignment(property)) {
          const name = property.name.text;
          if (!trackedFields.has(name)) continue;
          const value = evaluateIdentifierSymbol(checker.getShorthandAssignmentValueSymbol(property), resolving);
          if (name === "env" && (value.knownShape || value.fields.size > 0 || value.objects.size > 0)) {
            objects.set(name, value);
            fields.delete(name);
          } else fields.set(name, value.self === 0 ? targetBits.unknown : value.self);
          const objectType = checker.getTypeAtLocation(expression);
          const symbol = checker.getPropertyOfType(objectType, name) ?? checker.getSymbolAtLocation(property.name);
          if (symbol) symbols.set(name, symbol);
        } else {
          knownShape = false;
        }
      }
      return { self: 0, fields, objects, symbols, knownShape };
    }
    if (ts.isConditionalExpression(expression)) {
      const left = evaluate(expression.whenTrue, resolving);
      const right = evaluate(expression.whenFalse, resolving);
      return mergeValues(left, right);
    }
    return { ...emptyValue(), self: targetBits.unknown };
  }

  function poisonValue(value) {
    const fields = new Map([...value.fields.keys()].map((name) => [name, targetBits.unknown]));
    const objects = new Map([...value.objects].map(([name, child]) => [name, poisonValue(child)]));
    return {
      self: targetBits.unknown,
      fields,
      objects,
      symbols: value.symbols,
      knownShape: value.knownShape,
    };
  }

  propagateEscapedTargetBindings({
    program, rootFileSet, reachable, calls, checker, functionKey, workerKey, allowedCaller, parameterSymbol,
    evaluate, evaluateSymbol: evaluateIdentifierSymbol,
    escapedSymbols, escapedProperties,
    detachedProjectionCalls,
    isNonEscapingArgument: (node, index) => modelQualificationPolicy?.isNonEscapingArgument(node, index) ?? false,
  });

  changed = true;
  rounds = 0;
  while (changed && rounds < 64) {
    changed = false;
    rounds += 1;
    for (const [key] of reachable) {
      if (key === workerKey) continue;
      for (const call of callRecordsByCallee.get(key) ?? []) {
        if (allowedCaller(call)) changed = applyCall(call, true) || changed;
      }
    }
  }

  function isReachableSqlOwner(node) {
    let owner = node.parent;
    while (owner && !isFunctionDeclaration(owner)) owner = owner.parent;
    const key = owner && functionKey(checker, owner);
    return key ? reachable.has(key) : false;
  }

  const overrides = new Map();
  for (const source of program.getSourceFiles()) {
    if (!rootFileSet.has(normalized(source.fileName))) continue;
    if (pass === "model" ? !modelQualificationPolicy.isTargetSqlSource(source.fileName)
      : !sourceUnder(source.fileName, erasureSourceRoot)) continue;
    function visit(node) {
      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
          && node.expression.name.text === "prepare" && isReachableSqlOwner(node)) {
        const receiver = node.expression.expression;
        const value = evaluate(receiver, new Set());
        const targetStore = factForValue(value);
        const sourceOverrides = overrides.get(normalized(source.fileName)) ?? new Map();
        sourceOverrides.set(node.getStart(source), {
          targetStore,
          targetStatus: targetStore === "unknown" ? "unresolved-receiver" : "resolved-local-const-alias",
        });
        overrides.set(normalized(source.fileName), sourceOverrides);
      }
      ts.forEachChild(node, visit);
    }
    visit(source);
  }
  return overrides;
}
