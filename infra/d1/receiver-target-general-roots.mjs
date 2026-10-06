import { dirname, resolve } from "node:path";
import ts from "typescript";

const slash = (path) => resolve(path).replaceAll("\\", "/").toLowerCase();
const unwrapParens = (node) => {
  let value = node;
  while (value && ts.isParenthesizedExpression(value)) value = value.expression;
  return value;
};
function realSymbol(checker, symbol) {
  return symbol && (symbol.flags & ts.SymbolFlags.Alias) !== 0
    ? checker.getAliasedSymbol(symbol) : symbol;
}
function typeSymbol(checker, node) {
  const type = checker.getTypeAtLocation(node);
  return type.aliasSymbol ?? type.getSymbol();
}
function moduleExport(checker, source, name) {
  const module = source?.symbol;
  if (!module) return undefined;
  const exported = checker.getExportsOfModule(module).find((item) => item.getName() === name);
  const target = realSymbol(checker, exported);
  return target?.declarations?.find((item) => ts.isClassDeclaration(item) && item.name);
}
function canonicalWorkersTypeSources(root, program) {
  const options = program.getCompilerOptions();
  const envPath = resolve(root, "apps/eliotr-core/src/env.ts");
  const resolution = ts.resolveTypeReferenceDirective("@cloudflare/workers-types", envPath, options, ts.sys)
    .resolvedTypeReferenceDirective;
  const resolved = resolution?.resolvedFileName;
  const resolvedPath = resolved && slash(resolved);
  if (!resolvedPath || !resolvedPath.endsWith("/node_modules/@cloudflare/workers-types/index.d.ts")) {
    return { complete: false, sources: new Set() };
  }
  const packageDirectory = dirname(resolve(resolved));
  const canonicalFiles = new Set([
    slash(resolve(packageDirectory, "index.d.ts")),
    slash(resolve(packageDirectory, "index.ts")),
  ]);
  const programFiles = new Set(program.getSourceFiles().map((source) => slash(source.fileName)));
  const sources = new Set([...canonicalFiles].filter((path) => programFiles.has(path)));
  return {
    complete: sources.has(resolvedPath),
    sources,
  };
}
function isCanonicalWorkersTypeDeclaration(declaration, expectedName, canonicalSources) {
  const source = declaration?.getSourceFile();
  return Boolean(source && canonicalSources.has(slash(source.fileName))
    && (ts.isInterfaceDeclaration(declaration) || ts.isClassDeclaration(declaration))
    && declaration.name?.text === expectedName);
}
function isWorkersTypeSymbol(checker, symbol, expectedName, canonicalSources) {
  const declarations = symbol?.declarations ?? [];
  return symbol?.getName() === expectedName && declarations.length > 0
    && declarations.every((declaration) => isCanonicalWorkersTypeDeclaration(declaration, expectedName, canonicalSources)
      && realSymbol(checker, checker.getSymbolAtLocation(declaration.name)) === symbol);
}
function canonicalTypeSymbols(program, checker, name, canonicalSources) {
  const candidates = new Set();
  let sawUnresolvedDeclaration = false;
  for (const source of program.getSourceFiles()) {
    if (!canonicalSources.has(slash(source.fileName))) continue;
    function visit(node) {
      if ((ts.isClassDeclaration(node) || ts.isInterfaceDeclaration(node)) && node.name?.text === name) {
        const symbol = realSymbol(checker, checker.getSymbolAtLocation(node.name));
        if (symbol) candidates.add(symbol);
        else sawUnresolvedDeclaration = true;
      }
      ts.forEachChild(node, visit);
    }
    visit(source);
  }
  return {
    complete: !sawUnresolvedDeclaration && candidates.size > 0
      && [...candidates].every((symbol) => isWorkersTypeSymbol(checker, symbol, name, canonicalSources)),
    candidates,
  };
}
function canonicalPrepareDeclarationsForType(checker, symbol, ownerSymbols, canonicalSources) {
  const type = checker.getDeclaredTypeOfSymbol(symbol);
  const property = checker.getPropertyOfType(type, "prepare");
  const declarations = property?.declarations ?? [];
  const kinds = new Map();
  let complete = declarations.length > 0;
  for (const declaration of declarations) {
    const parent = declaration.parent;
    const parentSymbol = parent?.name && realSymbol(checker, checker.getSymbolAtLocation(parent.name));
    const ownerKind = parentSymbol && ownerSymbols.get(parentSymbol);
    const valid = (ts.isMethodDeclaration(declaration) || ts.isMethodSignature(declaration))
      && ts.isIdentifier(declaration.name) && declaration.name.text === "prepare"
      && ownerKind !== undefined
      && isCanonicalWorkersTypeDeclaration(parent, parent.name.text, canonicalSources)
      && realSymbol(checker, checker.getSymbolAtLocation(parent.name)) === parentSymbol
      && realSymbol(checker, checker.getSymbolAtLocation(declaration.name)) === property;
    if (!valid) {
      complete = false;
      continue;
    }
    kinds.set(declaration, ownerKind);
  }
  return { complete, kinds };
}

/**
 * Derive canonical D1 declaration identity from the caller's TypeScript Program.
 * No second Program is created; an augmented or structurally similar declaration
 * is rejected unless every merged declaration resolves to the canonical SDK source.
 */
export function createCanonicalPrepareDeclarationAuthority({ program, checker, root }) {
  const resolved = canonicalWorkersTypeSources(root, program);
  const canonicalSources = resolved.sources;
  const databaseCandidates = canonicalTypeSymbols(program, checker, "D1Database", canonicalSources);
  const sessionCandidates = canonicalTypeSymbols(program, checker, "D1DatabaseSession", canonicalSources);
  const ownerSymbols = new Map();
  if (databaseCandidates.complete) {
    for (const symbol of databaseCandidates.candidates) ownerSymbols.set(symbol, "workers-d1-database");
  }
  if (sessionCandidates.complete) {
    for (const symbol of sessionCandidates.candidates) ownerSymbols.set(symbol, "workers-d1-session");
  }
  const databasePrepareDeclarations = new Set();
  const sessionPrepareDeclarations = new Set();
  const prepareDeclarationKinds = new Map();
  let databaseComplete = resolved.complete && databaseCandidates.complete;
  let sessionComplete = resolved.complete && sessionCandidates.complete;
  for (const symbol of databaseCandidates.candidates) {
    const result = canonicalPrepareDeclarationsForType(checker, symbol, ownerSymbols, canonicalSources);
    databaseComplete &&= result.complete;
    for (const [declaration, kind] of result.kinds) {
      databasePrepareDeclarations.add(declaration);
      prepareDeclarationKinds.set(declaration, kind);
    }
  }
  for (const symbol of sessionCandidates.candidates) {
    const result = canonicalPrepareDeclarationsForType(checker, symbol, ownerSymbols, canonicalSources);
    sessionComplete &&= result.complete;
    for (const [declaration, kind] of result.kinds) {
      sessionPrepareDeclarations.add(declaration);
      prepareDeclarationKinds.set(declaration, kind);
    }
  }
  if (!databaseComplete) databasePrepareDeclarations.clear();
  if (!sessionComplete) sessionPrepareDeclarations.clear();
  for (const [declaration, kind] of prepareDeclarationKinds) {
    if ((kind === "workers-d1-database" && !databaseComplete)
        || (kind === "workers-d1-session" && !sessionComplete)) prepareDeclarationKinds.delete(declaration);
  }
  const databaseReceiverSymbols = databaseComplete ? databaseCandidates.candidates : new Set();
  const sessionReceiverSymbols = sessionComplete ? sessionCandidates.candidates : new Set();
  function receiverKind(type) {
    if (!type || type.isUnionOrIntersection?.()) return null;
    const symbol = realSymbol(checker, type.aliasSymbol ?? type.getSymbol());
    if (databaseReceiverSymbols.has(symbol)) return "workers-d1-database";
    if (sessionReceiverSymbols.has(symbol)) return "workers-d1-session";
    return null;
  }
  return {
    complete: databaseComplete && sessionComplete,
    databaseComplete,
    sessionComplete,
    canonicalSources,
    databaseReceiverSymbols,
    sessionReceiverSymbols,
    databasePrepareDeclarations,
    sessionPrepareDeclarations,
    prepareDeclarationKinds,
    receiverKind,
  };
}
function exactGenericBase(checker, declaration, expectedName, envSymbol, canonicalSources) {
  const clauses = declaration.heritageClauses ?? [];
  const bases = clauses.flatMap((clause) => clause.token === ts.SyntaxKind.ExtendsKeyword
    ? [...clause.types] : []);
  if (bases.length !== 1) return false;
  const base = bases[0];
  const symbol = realSymbol(checker, checker.getSymbolAtLocation(base.expression));
  return isWorkersTypeSymbol(checker, symbol, expectedName, canonicalSources)
    && base.typeArguments?.length >= 1
    && typeSymbol(checker, base.typeArguments[0]) === envSymbol;
}
function envDeclaration(program, root) {
  const path = resolve(root, "apps/eliotr-core/src/env.ts");
  const source = program.getSourceFiles().find((item) => slash(item.fileName) === slash(path));
  const declaration = source?.statements.find((item) => ts.isInterfaceDeclaration(item) && item.name.text === "Env");
  return declaration ? { source, declaration } : undefined;
}
function objectProperty(object, name) {
  if (!object || !ts.isObjectLiteralExpression(object)) return undefined;
  const matches = object.properties.filter((item) => item.name
    && (ts.isIdentifier(item.name) || ts.isStringLiteral(item.name)) && item.name.text === name);
  return matches.length === 1 ? matches[0] : undefined;
}
function workerObjectFromExport(source) {
  const assignment = source?.statements.find((item) => ts.isExportAssignment(item) && !item.isExportEquals);
  const expression = assignment?.expression;
  if (!expression || !ts.isSatisfiesExpression(expression) || !ts.isObjectLiteralExpression(unwrapParens(expression.expression))) {
    return undefined;
  }
  const handlerType = expression.type;
  if (!ts.isTypeReferenceNode(handlerType) || !ts.isIdentifier(handlerType.typeName)
      || handlerType.typeName.text !== "ExportedHandler" || handlerType.typeArguments?.length !== 1) return undefined;
  return { object: unwrapParens(expression.expression), envTypeNode: handlerType.typeArguments[0] };
}
function classMethods(classDeclaration, predicate = () => true) {
  return classDeclaration.members.filter((member) => ts.isMethodDeclaration(member)
    && member.body && !member.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.StaticKeyword)
    && (!member.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.PrivateKeyword
      || modifier.kind === ts.SyntaxKind.ProtectedKeyword)) && predicate(member));
}

/**
 * Discover only manifest-bound invocation roots and D1 origins. Any parse, type,
 * identity, or environment mismatch makes this result incomplete; callers must
 * not infer a default binding from the source property name.
 */
export function discoverConfiguredReceiverRoots({ root, program, checker }) {
  const configPath = resolve(root, "apps/eliotr-core/wrangler.jsonc");
  const configText = ts.sys.readFile(configPath);
  if (configText === undefined) return { complete: false, reason: "wrangler-config-missing", roots: [], origins: new Map(), nativePrepareDeclarations: new Set() };
  const parsed = ts.parseConfigFileTextToJson(configPath, configText);
  const config = parsed.config;
  if (parsed.error || !config || typeof config.main !== "string") {
    return { complete: false, reason: "wrangler-config-invalid", roots: [], origins: new Map(), nativePrepareDeclarations: new Set() };
  }
  const envPair = envDeclaration(program, root);
  const envSymbol = envPair && checker.getSymbolAtLocation(envPair.declaration.name);
  const envType = envSymbol && checker.getDeclaredTypeOfSymbol(envSymbol);
  if (!envSymbol || !envType) return { complete: false, reason: "canonical-env-missing", roots: [], origins: new Map(), nativePrepareDeclarations: new Set() };
  const coreProperty = checker.getPropertyOfType(envType, "CORE_DB");
  const searchProperty = checker.getPropertyOfType(envType, "SEARCH_DB");
  if (!coreProperty || !searchProperty) return { complete: false, reason: "database-env-properties-missing", roots: [], origins: new Map(), nativePrepareDeclarations: new Set() };
  const coreType = checker.getTypeOfSymbolAtLocation(coreProperty, coreProperty.valueDeclaration ?? envPair.declaration);
  const searchType = checker.getTypeOfSymbolAtLocation(searchProperty, searchProperty.valueDeclaration ?? envPair.declaration);
  if ((coreType.aliasSymbol ?? coreType.getSymbol()) !== (searchType.aliasSymbol ?? searchType.getSymbol())) {
    return { complete: false, reason: "database-types-differ", roots: [], origins: new Map(), nativePrepareDeclarations: new Set() };
  }
  const prepareAuthority = createCanonicalPrepareDeclarationAuthority({ program, checker, root });
  const canonicalSources = prepareAuthority.canonicalSources;
  const d1Type = coreType;
  const d1Symbol = coreType.aliasSymbol ?? coreType.getSymbol();
  if (!prepareAuthority.databaseComplete || !prepareAuthority.databaseReceiverSymbols.has(d1Symbol)) {
    return { complete: false, reason: "canonical-workers-d1-type-unproven", roots: [], origins: new Map(), nativePrepareDeclarations: new Set() };
  }
  const nativePrepareDeclarations = new Set(prepareAuthority.databasePrepareDeclarations);
  if (prepareAuthority.sessionComplete) {
    for (const declaration of prepareAuthority.sessionPrepareDeclarations) nativePrepareDeclarations.add(declaration);
  }
  if (nativePrepareDeclarations.size === 0) {
    return { complete: false, reason: "canonical-d1-prepare-missing", roots: [], origins: new Map(), nativePrepareDeclarations };
  }

  const mainPath = resolve(dirname(configPath), config.main);
  const workerSource = program.getSourceFiles().find((item) => slash(item.fileName) === slash(mainPath));
  const worker = workerObjectFromExport(workerSource);
  if (!worker || typeSymbol(checker, worker.envTypeNode) !== envSymbol) {
    return { complete: false, reason: "configured-worker-type-unproven", roots: [], origins: new Map(), nativePrepareDeclarations };
  }

  const profiles = [{ name: "default", value: config }];
  if (config.env !== undefined) {
    if (!config.env || typeof config.env !== "object" || Array.isArray(config.env)) {
      return { complete: false, reason: "wrangler-env-invalid", roots: [], origins: new Map(), nativePrepareDeclarations };
    }
    for (const [name, value] of Object.entries(config.env)) {
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        return { complete: false, reason: "wrangler-env-profile-invalid", roots: [], origins: new Map(), nativePrepareDeclarations };
      }
      profiles.push({ name, value });
    }
  }

  const roots = [];
  const originTargets = new Map();
  let complete = true;
  const expectedMigrations = new Map([
    [slash(resolve(root, "infra/d1/core/migrations")), "core"],
    [slash(resolve(root, "infra/d1/search/migrations")), "search"],
  ]);
  for (const profile of profiles) {
    const databases = profile.value.d1_databases;
    if (!Array.isArray(databases)) {
      complete = false;
      continue;
    }
    const seenBindings = new Set();
    const profileBindings = new Map();
    for (const database of databases) {
      if (!database || typeof database.binding !== "string" || typeof database.migrations_dir !== "string"
          || typeof database.database_name !== "string" || seenBindings.has(database.binding)) {
        complete = false;
        continue;
      }
      seenBindings.add(database.binding);
      if (database.binding !== "CORE_DB" && database.binding !== "SEARCH_DB") continue;
      const property = checker.getPropertyOfType(envType, database.binding);
      const expectedProperty = database.binding === "CORE_DB" ? coreProperty : searchProperty;
      const migrationPath = slash(resolve(dirname(configPath), database.migrations_dir));
      const target = expectedMigrations.get(migrationPath);
      const databaseFieldType = property && checker.getTypeOfSymbolAtLocation(property, property.valueDeclaration ?? envPair.declaration);
      if (!property || property !== expectedProperty || !target
          || (databaseFieldType.aliasSymbol ?? databaseFieldType.getSymbol()) !== (d1Type.aliasSymbol ?? d1Type.getSymbol())) {
        complete = false;
        continue;
      }
      profileBindings.set(property, target);
      const configuredTargets = originTargets.get(property) ?? new Set();
      configuredTargets.add(target);
      originTargets.set(property, configuredTargets);
    }

    const handlerNames = ["fetch"];
    if (Array.isArray(profile.value.queues?.consumers) && profile.value.queues.consumers.length > 0) handlerNames.push("queue");
    if (Array.isArray(profile.value.triggers?.crons) && profile.value.triggers.crons.length > 0) handlerNames.push("scheduled");
    for (const name of handlerNames) {
      const method = objectProperty(worker.object, name);
      if (!method || !ts.isMethodDeclaration(method) || method.parameters.length < 2
          || typeSymbol(checker, method.parameters[1]) !== envSymbol) {
        complete = false;
        continue;
      }
      const bindings = new Map(profileBindings);
      roots.push({ kind: "worker", profile: profile.name, declaration: method, envParameter: method.parameters[1], envSymbol, bindings });
    }

    for (const binding of profile.value.durable_objects?.bindings ?? []) {
      if (!binding || typeof binding.class_name !== "string") { complete = false; continue; }
      const classDeclaration = moduleExport(checker, workerSource, binding.class_name);
      if (!classDeclaration || !exactGenericBase(checker, classDeclaration, "DurableObject", envSymbol, canonicalSources)) { complete = false; continue; }
      roots.push(...classMethods(classDeclaration).map((declaration) => ({
        kind: "durable-object", profile: profile.name, declaration, envSymbol, thisEnv: true, bindings: profileBindings,
      })));
    }

    for (const workflow of profile.value.workflows ?? []) {
      if (!workflow || typeof workflow.class_name !== "string") { complete = false; continue; }
      const classDeclaration = moduleExport(checker, workerSource, workflow.class_name);
      if (!classDeclaration || !exactGenericBase(checker, classDeclaration, "WorkflowEntrypoint", envSymbol, canonicalSources)) { complete = false; continue; }
      roots.push(...classMethods(classDeclaration, (member) => ts.isIdentifier(member.name) && member.name.text === "run")
        .map((declaration) => ({
          kind: "workflow", profile: profile.name, declaration, envSymbol, thisEnv: true, bindings: profileBindings,
        })));
    }
  }

  const origins = new Map();
  for (const [property, targets] of originTargets) {
    if (targets.size === 1) origins.set(property, [...targets][0]);
  }
  if (profiles.length === 0 || roots.length === 0) complete = false;
  return { complete, reason: complete ? undefined : "one-or-more-configured-roots-or-bindings-unproven", roots, origins, nativePrepareDeclarations };
}
