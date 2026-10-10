import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";

const require = createRequire(import.meta.url);
export function validateApplicationOperationComposition(repositoryRoot, composition, sourceOverrides, enabledSlices, partialSlices, disabledSlices) {
  const ts = require("typescript");
  const configPath = resolve(repositoryRoot, "apps/eliotr-core/tsconfig.json");
  const config = ts.readConfigFile(configPath, ts.sys.readFile);
  if (config.error) throw new Error("Launch operation TypeScript config cannot be read");
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, dirname(configPath), {
    noEmit: true, composite: false, incremental: false, tsBuildInfoFile: undefined,
  });
  const rootFile = resolve(repositoryRoot, "apps/eliotr-core/src/composition-root.ts");
  const overrides = new Map([...sourceOverrides].map(([path, text]) => [resolve(path), text]));
  overrides.set(rootFile, composition);
  const host = ts.createCompilerHost(parsed.options);
  const defaultGetSourceFile = host.getSourceFile.bind(host);
  host.getSourceFile = (fileName, languageVersion, onError, fresh) => {
    const override = overrides.get(resolve(fileName));
    return override === undefined ? defaultGetSourceFile(fileName, languageVersion, onError, fresh) :
      ts.createSourceFile(fileName, override, languageVersion, true, ts.ScriptKind.TS);
  };
  const program = ts.createProgram({ rootNames: [rootFile], options: parsed.options, host });
  const checker = program.getTypeChecker();
  const source = program.getSourceFile(rootFile);
  if (!source) throw new Error("Launch operation source graph is unavailable");
  const apps = source.statements.filter((node) =>
    ts.isFunctionDeclaration(node) && node.name?.text === "createApplication" && node.body);
  if (apps.length !== 1) throw new Error("Application operation contract is missing or duplicated");
  const signature = checker.getSignatureFromDeclaration(apps[0]);
  const servicesProperty = signature && checker.getPropertyOfType(checker.getReturnTypeOfSignature(signature), "services");
  if (!servicesProperty) throw new Error("ApplicationServices type is unavailable");
  const serviceTypes = checker.getPropertiesOfType(checker.getTypeOfSymbolAtLocation(servicesProperty, apps[0]));
  const serviceVariables = [];
  const findServices = (node) => {
    if (node !== apps[0].body && ts.isFunctionLike(node)) return;
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === "services") serviceVariables.push(node); ts.forEachChild(node, findServices);
  };
  findServices(apps[0].body);
  if (serviceVariables.length !== 1 || !ts.isObjectLiteralExpression(serviceVariables[0].initializer)) {
    throw new Error("Application service composition is not a static object");
  }
  const serviceValues = new Map();
  for (const property of serviceVariables[0].initializer.properties) {
    if (!ts.isPropertyAssignment(property) || !(ts.isIdentifier(property.name) || ts.isStringLiteral(property.name)) || serviceValues.has(property.name.text)) throw new Error("Application service composition has a dynamic or duplicate field");
    serviceValues.set(property.name.text, property.initializer);
  }
  if (serviceTypes.length !== serviceValues.size || serviceTypes.some((service) => !serviceValues.has(service.name))) {
    throw new Error("Application service composition does not match ApplicationServices");
  }
  function calledFunction(call) {
    if (!ts.isCallExpression(call)) throw new Error("Application service is not composed through a handler factory");
    let symbol = checker.getSymbolAtLocation(call.expression);
    if (symbol && symbol.flags & ts.SymbolFlags.Alias) symbol = checker.getAliasedSymbol(symbol);
    const declaration = symbol?.valueDeclaration ?? symbol?.declarations?.find(ts.isFunctionDeclaration);
    if (!declaration || !ts.isFunctionDeclaration(declaration) || !declaration.body) throw new Error("Application handler factory is not a source function");
    return declaration;
  }
  function valueSymbol(node) {
    if (ts.isShorthandPropertyAssignment(node)) return checker.getShorthandAssignmentValueSymbol(node);
    const location = ts.isPropertyAccessExpression(node) ? node.name : node;
    let symbol = ts.isIdentifier(location) ? checker.getSymbolAtLocation(location) : undefined;
    if (symbol && symbol.flags & ts.SymbolFlags.Alias) symbol = checker.getAliasedSymbol(symbol);
    return symbol;
  }
  function intrinsicFreezeArgument(call) {
    if (ts.isCallChain(call) || ts.isPropertyAccessChain(call.expression) ||
        !ts.isPropertyAccessExpression(call.expression) ||
        !ts.isIdentifier(call.expression.expression) || call.expression.expression.text !== "Object" ||
        call.expression.name.text !== "freeze" || call.arguments.length !== 1 ||
        ts.isSpreadElement(call.arguments[0])) return undefined;
    const receiver = call.expression.expression, receiverSymbol = checker.getSymbolAtLocation(receiver);
    const fromDefaultLibrary = (symbol) => symbol?.declarations?.length > 0 &&
      symbol.declarations.every((declaration) => program.isSourceFileDefaultLibrary(declaration.getSourceFile()));
    if (!receiverSymbol?.valueDeclaration || !fromDefaultLibrary(receiverSymbol)) return undefined;
    const calleeSymbol = checker.getSymbolAtLocation(call.expression.name);
    const freezeMember = checker.getPropertyOfType(checker.getTypeAtLocation(receiver), "freeze");
    if (!calleeSymbol || calleeSymbol !== freezeMember || !fromDefaultLibrary(calleeSymbol)) return undefined;
    return call.arguments[0];
  }
  function capabilityDenial(node, seen = new Set()) {
    let denied = false;
    const visit = (current) => {
      if (denied) return;
      if (ts.isNewExpression(current) && ts.isIdentifier(current.expression) && current.expression.text === "CapabilityUnavailableError") { denied = true; return; }
      if (ts.isCallExpression(current) || ts.isIdentifier(current) ||
          ts.isPropertyAccessExpression(current) || ts.isShorthandPropertyAssignment(current) || current === node) {
        const reference = ts.isCallExpression(current) ? current.expression : current;
        const symbol = valueSymbol(reference);
        const declaration = symbol?.valueDeclaration, body = declaration && (ts.isVariableDeclaration(declaration) ? declaration.initializer :
          ts.isFunctionDeclaration(declaration) || ts.isMethodDeclaration(declaration) ? declaration.body :
            ts.isPropertyAssignment(declaration) || ts.isPropertyDeclaration(declaration) ? declaration.initializer : undefined);
        if (body && resolve(declaration.getSourceFile().fileName) === rootFile && !seen.has(declaration)) { seen.add(declaration); visit(body); }
      }
      ts.forEachChild(current, visit);
    };
    visit(node); return denied;
  }
  function returns(factory) {
    const fallsThrough = (node) => {
      if (ts.isReturnStatement(node) || ts.isThrowStatement(node)) return false;
      if (ts.isBlock(node)) { let active = true; for (const statement of node.statements) if (active) active = fallsThrough(statement); return active; }
      if (ts.isIfStatement(node)) return !node.elseStatement || fallsThrough(node.thenStatement) || fallsThrough(node.elseStatement);
      return true;
    };
    if (fallsThrough(factory.body)) throw new Error("Application operation factory has an uncovered or opaque return path");
    const sites = [];
    const visit = (node, conditional = false) => {
      if (node !== factory.body && ts.isFunctionLike(node)) return;
      if (ts.isReturnStatement(node)) { if (!node.expression) throw new Error("Application operation factory returns no service value"); sites.push({ expression: node.expression, conditional }); return; }
      if (ts.isIfStatement(node)) {
        visit(node.thenStatement, true);
        if (node.elseStatement) visit(node.elseStatement, true);
        return;
      }
      ts.forEachChild(node, (child) => visit(child, conditional));
    };
    visit(factory.body); return sites;
  }
  function staticallyCallable(node, stack = new Set()) {
    if (ts.isParenthesizedExpression(node)) return staticallyCallable(node.expression, stack);
    if (ts.isArrowFunction(node) || ts.isFunctionExpression(node) || (ts.isMethodDeclaration(node) && node.body)) return true;
    if (ts.isCallExpression(node)) { const factory = calledFunction(node), sites = returns(factory); return sites.length > 0 && sites.every((site) => staticallyCallable(site.expression, new Set(stack).add(factory))); }
    if (!ts.isIdentifier(node) && !ts.isPropertyAccessExpression(node) && !ts.isShorthandPropertyAssignment(node)) return false;
    const declaration = valueSymbol(node)?.valueDeclaration;
    if (declaration && !stack.has(declaration)) {
      const next = new Set(stack).add(declaration);
      if ((ts.isFunctionDeclaration(declaration) || ts.isMethodDeclaration(declaration)) && declaration.body) return true;
      if (ts.isVariableDeclaration(declaration) && declaration.initializer && ts.isVariableDeclarationList(declaration.parent) && (declaration.parent.flags & ts.NodeFlags.Const)) return staticallyCallable(declaration.initializer, next);
      if (ts.isPropertyAssignment(declaration)) return staticallyCallable(declaration.initializer, next); if (ts.isPropertyDeclaration(declaration) && declaration.initializer) return staticallyCallable(declaration.initializer, next);
    }
    if (!ts.isPropertyAccessExpression(node)) return false;
    const shapes = objectShapes(node.expression, new Set(stack)); return shapes.length > 0 && shapes.every((shape) => shape.handlers.get(node.name.text)?.callable);
  }
  function objectShapes(node, stack = new Set()) {
    if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isSatisfiesExpression(node)) return objectShapes(node.expression, stack);
    if (ts.isIdentifier(node)) {
      const declaration = checker.getSymbolAtLocation(node)?.valueDeclaration;
      if (!declaration || !ts.isVariableDeclaration(declaration) || !declaration.initializer ||
          !ts.isVariableDeclarationList(declaration.parent) || !(declaration.parent.flags & ts.NodeFlags.Const)) {
        throw new Error("Application operation spread is not a source value");
      }
      return objectShapes(declaration.initializer, stack);
    }
    if (ts.isCallExpression(node)) {
      const frozen = intrinsicFreezeArgument(node);
      return frozen === undefined ? factoryShapes(calledFunction(node), stack) : objectShapes(frozen, stack);
    }
    if (!ts.isObjectLiteralExpression(node)) throw new Error("Application operation handlers are not a static object");
    let shapes = [{ handlers: new Map(), conditional: false }];
    for (const property of node.properties) {
      if (ts.isSpreadAssignment(property)) {
        const spread = objectShapes(property.expression, stack);
        shapes = shapes.flatMap((shape) => spread.map((other) => ({
          handlers: new Map([...shape.handlers, ...other.handlers]),
          conditional: shape.conditional || other.conditional,
        })));
        continue;
      }
      const name = ts.isShorthandPropertyAssignment(property) ? property.name.text :
        ts.isIdentifier(property.name) || ts.isStringLiteral(property.name) ? property.name.text : null;
      if (!name) throw new Error("Application operation handler has a dynamic name");
      const initializer = ts.isPropertyAssignment(property) ? property.initializer : property;
      const callable = (ts.isMethodDeclaration(property) ||
        checker.getSignaturesOfType(checker.getTypeAtLocation(initializer), ts.SignatureKind.Call).length > 0) &&
        staticallyCallable(initializer, new Set(stack));
      const handler = { callable, denied: callable && capabilityDenial(initializer) };
      shapes = shapes.map((shape) => {
        const handlers = new Map(shape.handlers);
        handlers.set(name, handler);
        return { handlers, conditional: shape.conditional };
      });
    }
    return shapes;
  }
  function factoryShapes(factory, stack = new Set()) {
    if (stack.has(factory)) throw new Error("Application operation factory recursion is dynamic");
    const next = new Set(stack).add(factory);
    return returns(factory).flatMap((site) => objectShapes(site.expression, next).map((shape) => ({ handlers: shape.handlers, conditional: shape.conditional || site.conditional })));
  }
  const operationHandlers = {};
  const serviceShapes = new Map();
  for (const service of serviceTypes) {
    const expected = checker.getPropertiesOfType(checker.getTypeOfSymbolAtLocation(service, apps[0]));
    const shapes = factoryShapes(calledFunction(serviceValues.get(service.name)));
    if (!shapes.length) throw new Error("Application " + service.name + " factory has no return path");
    for (const shape of shapes) {
      const missing = expected.filter((handler) => !shape.handlers.get(handler.name)?.callable)
        .map((handler) => handler.name).sort();
      if (missing.length) throw new Error("Missing mandatory " + service.name + " handlers: " + missing.join(", "));
    }
    operationHandlers[service.name] = Object.freeze(expected.map((handler) => handler.name).sort());
    serviceShapes.set(service.name, { expected, shapes });
  }
  const federation = serviceShapes.get("federation");
  if (!federation) throw new Error("Application federation service contract is missing");
  const anyDenial = federation.shapes.some((shape) => [...shape.handlers.values()].some((handler) => handler.denied));
  const everyPathDenied = federation.shapes.every((shape) => federation.expected.every((handler) =>
    shape.handlers.get(handler.name)?.denied));
  const conditionalDenial = federation.shapes.some((shape) => shape.conditional &&
    [...shape.handlers.values()].some((handler) => handler.denied));
  const availability = everyPathDenied ? "disabled" : conditionalDenial ? "conditional-denial" :
    anyDenial ? "partial-denial" : "composed";
  if (availability === "disabled" && !disabledSlices.includes("FEDERATION")) {
    throw new Error("Disabled federation handlers must be classified in disabled_slices");
  }
  if (["conditional-denial", "partial-denial"].includes(availability) && !partialSlices.includes("FEDERATION")) {
    throw new Error("Conditional federation denial must be classified in partial_slices");
  }
  if (enabledSlices.includes("FEDERATION") && anyDenial) {
    throw new Error("Federation with denied operation handlers cannot be classified as enabled");
  }
  return Object.freeze({
    mandatory_handlers: Object.freeze(operationHandlers),
    federation_availability: availability,
  });
}
