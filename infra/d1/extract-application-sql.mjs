import { readFileSync, readdirSync, statSync } from "node:fs";
import { relative, resolve, sep } from "node:path";
import { fileURLToPath, URL } from "node:url";
import process from "node:process";
import ts from "typescript";
import { createErasureReceiverTargetOverrides } from "./receiver-target-provenance.mjs";
import { compilerOptions } from "./receiver-target-provenance-values.mjs";
import { createCanonicalPrepareDeclarationAuthority } from "./receiver-target-general-roots.mjs";
import { createPrepareDeclarationMetadata, prepareDeclarationKindAt } from "./prepare-declaration-provenance.mjs";
import { createSourceLexicalBindings, resolveLocalTarget } from "./source-lexical-bindings.mjs";
import { createSqlBindingCardinality } from "./sql-binding-cardinality.mjs";
import { createBoundedCallsiteTargetEvidence } from "./receiver-target-callsite-evidence.mjs";

const root = resolve(fileURLToPath(new URL("../../", import.meta.url)));
const roots = [resolve(root, "apps/eliotr-core/src"), resolve(root, "packages")];
const sqlStart = /^(?:WITH\b|SELECT\b|INSERT\b|UPDATE\b|DELETE\b|REPLACE\b|PRAGMA\b|EXPLAIN\b|CREATE\b|DROP\b|ALTER\b)/i;
const maxReportedDynamicSites = 30;

function sourceFiles(directory, output = []) {
  for (const name of readdirSync(directory)) {
    const path = resolve(directory, name);
    const info = statSync(path);
    if (info.isDirectory()) {
      if (name !== "node_modules" && name !== "dist" && name !== "test" && name !== "tests") {
        sourceFiles(path, output);
      }
    } else if (/\.(?:ts|tsx|mts|cts)$/.test(name) && !/\.(?:test|spec)\./.test(name)
        && !/fixture/i.test(name) && !/(?:^|[-.])test-support(?:[-.]|$)/i.test(name)) {
      output.push(path);
    }
  }
  return output;
}

function collectPackageSources(directory) {
  return readdirSync(directory).flatMap((name) => {
    const source = resolve(directory, name, "src");
    try {
      return statSync(source).isDirectory() ? sourceFiles(source) : [];
    } catch {
      return [];
    }
  });
}

function isSql(value) {
  return typeof value === "string" && sqlStart.test(value.trim());
}

function unwrapExpression(node) {
  let current = node;
  while (current && (ts.isParenthesizedExpression(current) || ts.isAsExpression(current)
      || ts.isTypeAssertionExpression(current) || ts.isSatisfiesExpression(current))) {
    current = current.expression;
  }
  return current;
}

function canonicalBindingParts(receiver) {
  const expression = unwrapExpression(receiver);
  let bindingName;
  let base;
  if (expression && ts.isPropertyAccessExpression(expression)) {
    bindingName = expression.name.text;
    base = unwrapExpression(expression.expression);
  } else if (expression && ts.isElementAccessExpression(expression)
      && expression.argumentExpression && ts.isStringLiteral(expression.argumentExpression)) {
    bindingName = expression.argumentExpression.text;
    base = unwrapExpression(expression.expression);
  }
  const directEnvironment = base && (
    (ts.isIdentifier(base) && base.text === "env")
    || (ts.isPropertyAccessExpression(base) && base.name.text === "env" && base.expression.kind === ts.SyntaxKind.ThisKeyword)
  );
  return directEnvironment ? { base, bindingName } : undefined;
}

function targetBinding(receiver) {
  const parts = canonicalBindingParts(receiver);
  if (parts?.bindingName === "CORE_DB") return { targetStore: "core", targetStatus: "resolved-direct-binding" };
  if (parts?.bindingName === "SEARCH_DB") return { targetStore: "search", targetStatus: "resolved-direct-binding" };
  return { targetStore: "unknown", targetStatus: "unresolved-receiver" };
}

function sourceLocation(source, node) {
  const { line } = source.getLineAndCharacterOfPosition(node.getStart(source));
  return `${relative(root, source.fileName).split(sep).join("/")}:${line + 1}`;
}

function staticEvaluator(source) {
  const declarations = new Map();
  const functions = new Map();
  const globalBindings = new Map();
  const resolving = new Set();

  for (const statement of source.statements) {
    if (ts.isVariableStatement(statement) && (statement.declarationList.flags & ts.NodeFlags.Const) !== 0) {
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name) && declaration.initializer) {
          declarations.set(declaration.name.text, declaration.initializer);
          globalBindings.set(declaration.name.text, declaration);
          if (ts.isArrowFunction(declaration.initializer) || ts.isFunctionExpression(declaration.initializer)) {
            functions.set(declaration.name.text, declaration.initializer);
          }
        }
      }
    } else if (ts.isFunctionDeclaration(statement) && statement.name) {
      functions.set(statement.name.text, statement);
      globalBindings.set(statement.name.text, statement);
    }
  }

  function evaluateFunction(fn, args, depth) {
    if (depth > 12) return undefined;
    const environment = new Map();
    fn.parameters.forEach((parameter, index) => {
      if (ts.isIdentifier(parameter.name)) {
        const value = args[index] === undefined && parameter.initializer ? evaluate(parameter.initializer, environment, depth + 1) : args[index];
        environment.set(parameter.name.text, value);
      }
    });
    const body = fn.body;
    if (!body) return undefined;
    if (!ts.isBlock(body)) return evaluate(body, environment, depth + 1);
    const localDeclarations = [];
    function collectLocals(node) {
      if (node !== body && ts.isFunctionLike(node)) {
        if (ts.isFunctionDeclaration(node) && node.name) {
          localDeclarations.push({ name: node.name.text, declaration: node, kind: "function" });
        }
        return;
      }
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
        const statement = node.parent?.parent;
        localDeclarations.push({
          name: node.name.text,
          declaration: node,
          kind: statement?.parent === body ? "variable" : "other",
        });
      } else if ((ts.isClassDeclaration(node) || ts.isEnumDeclaration(node)) && node.name) {
        localDeclarations.push({ name: node.name.text, declaration: node, kind: "other" });
      }
      ts.forEachChild(node, collectLocals);
    }
    collectLocals(body);
    const duplicateNames = new Set();
    for (const declaration of localDeclarations) {
      const name = declaration.name;
      if (environment.has(name)) duplicateNames.add(name);
      environment.set(name, undefined);
    }
    for (const declaration of localDeclarations) {
      const name = declaration.name;
      if (declaration.kind !== "variable" || duplicateNames.has(name)
          || (ts.getCombinedNodeFlags(declaration.declaration) & ts.NodeFlags.Const) === 0
          || !declaration.declaration.initializer) continue;
      environment.set(name, evaluate(declaration.declaration.initializer, environment, depth + 1));
    }

    function statement(node) {
      if (!node) return undefined;
      if (ts.isReturnStatement(node)) return { returned: true, value: node.expression && evaluate(node.expression, environment, depth + 1) };
      if (ts.isVariableStatement(node)) {
        for (const declaration of node.declarationList.declarations) {
          if (ts.isIdentifier(declaration.name) && declaration.initializer) {
            environment.set(declaration.name.text, evaluate(declaration.initializer, environment, depth + 1));
          }
        }
      } else if (ts.isIfStatement(node)) {
        const condition = evaluate(node.expression, environment, depth + 1);
        if (condition === undefined) return { unknown: true };
        return statement(condition ? node.thenStatement : node.elseStatement);
      } else if (ts.isBlock(node)) {
        for (const child of node.statements) {
          const result = statement(child);
          if (result?.returned || result?.unknown) return result;
        }
      } else if (ts.isSwitchStatement(node)) {
        const value = evaluate(node.expression, environment, depth + 1);
        if (value === undefined) return { unknown: true };
        let active = false;
        for (const clause of node.caseBlock.clauses) {
          if (ts.isDefaultClause(clause)) active ||= !node.caseBlock.clauses.some((candidate) => ts.isCaseClause(candidate) && evaluate(candidate.expression, environment, depth + 1) === value);
          else {
            const caseValue = evaluate(clause.expression, environment, depth + 1);
            if (caseValue === undefined) return { unknown: true };
            if (caseValue === value) active = true;
          }
          if (active) for (const child of clause.statements) {
            const result = statement(child);
            if (result?.returned || result?.unknown) return result;
          }
        }
      }
      return undefined;
    }
    for (const child of body.statements) {
      const result = statement(child);
      if (result?.returned) return result.value;
      if (result?.unknown) return undefined;
    }
    return undefined;
  }

  function evaluateAddition(node, environment, depth) {
    const pending = [{ node, ready: false }];
    const values = new Map();
    while (pending.length) {
      const entry = pending.pop();
      const expression = entry.node;
      if (!ts.isBinaryExpression(expression) || expression.operatorToken.kind !== ts.SyntaxKind.PlusToken) {
        const value = evaluate(expression, environment, depth + 1);
        if (typeof value !== "string" && typeof value !== "number") return undefined;
        values.set(expression, value);
      } else if (!entry.ready) {
        pending.push({ node: expression, ready: true },
          { node: expression.right, ready: false }, { node: expression.left, ready: false });
      } else {
        const left = values.get(expression.left);
        const right = values.get(expression.right);
        // Preserve the AST grouping: numeric addition precedes string coercion.
        values.set(expression, typeof left === "number" && typeof right === "number"
          ? left + right : String(left) + String(right));
      }
    }
    return values.get(node);
  }

  function evaluate(node, environment = new Map(), depth = 0) {
    if (!node || depth > 20) return undefined;
    if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isTypeAssertionExpression(node) || ts.isSatisfiesExpression(node)) {
      return evaluate(node.expression, environment, depth + 1);
    }
    if (node.kind === ts.SyntaxKind.TrueKeyword) return true;
    if (node.kind === ts.SyntaxKind.FalseKeyword) return false;
    if (node.kind === ts.SyntaxKind.NullKeyword) return null;
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
    if (ts.isNumericLiteral(node)) return Number(node.text);
    if (ts.isIdentifier(node)) {
      if (environment.has(node.text)) return environment.get(node.text);
      if (resolving.has(node.text)) return undefined;
      const initializer = declarations.get(node.text);
      if (!initializer) return undefined;
      resolving.add(node.text);
      const result = evaluate(initializer, environment, depth + 1);
      resolving.delete(node.text);
      return result;
    }
    if (ts.isTemplateExpression(node)) {
      let result = node.head.text;
      for (const span of node.templateSpans) {
        const value = evaluate(span.expression, environment, depth + 1);
        if (typeof value !== "string" && typeof value !== "number") return undefined;
        result += String(value) + span.literal.text;
      }
      return result;
    }
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
      return evaluateAddition(node, environment, depth);
    }
    if (ts.isBinaryExpression(node) && [ts.SyntaxKind.EqualsEqualsEqualsToken, ts.SyntaxKind.EqualsEqualsToken].includes(node.operatorToken.kind)) {
      const left = evaluate(node.left, environment, depth + 1);
      const right = evaluate(node.right, environment, depth + 1);
      return left === undefined || right === undefined ? undefined : left === right;
    }
    if (ts.isConditionalExpression(node)) {
      const condition = evaluate(node.condition, environment, depth + 1);
      return typeof condition === "boolean" ? evaluate(condition ? node.whenTrue : node.whenFalse, environment, depth + 1) : undefined;
    }
    if (ts.isArrayLiteralExpression(node)) {
      const values = node.elements.map((element) => evaluate(element, environment, depth + 1));
      return values.some((value) => value === undefined) ? undefined : values;
    }
    if (ts.isCallExpression(node)) {
      const args = node.arguments.map((argument) => evaluate(argument, environment, depth + 1));
      if (args.includes(undefined)) return undefined;
      if (ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === "join") {
        const array = evaluate(node.expression.expression, environment, depth + 1);
        if (Array.isArray(array)) return array.join(args[0] ?? ",");
      }
      if (ts.isIdentifier(node.expression)) {
        if (environment.has(node.expression.text)) return undefined;
        const declaration = functions.get(node.expression.text);
        if (declaration) return evaluateFunction(declaration, args, depth + 1);
      }
    }
    return undefined;
  }

  const evaluateSource = (node, environment = new Map()) => evaluate(node, environment);
  evaluateSource.globalBindings = globalBindings;
  return evaluateSource;
}

export function extractSourceText(
  text,
  file = resolve(root, "<fixture>.ts"),
  targetOverrides,
  prepareDeclarationMetadata,
  targetBindingEvidence,
) {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  if (source.parseDiagnostics.length) throw new Error("SOURCE_PARSE_FAILED");
  const evaluateRaw = staticEvaluator(source);
  const queries = [];
  const unresolved = [];

  const lexical = createSourceLexicalBindings(source, ts);
  const environmentBindings = new WeakMap();
  function isPropertyName(identifier) {
    const parent = identifier.parent;
    return (ts.isPropertyAccessExpression(parent) && parent.name === identifier)
      || (ts.isPropertyAssignment(parent) && parent.name === identifier)
      || (ts.isMethodDeclaration(parent) && parent.name === identifier)
      || (ts.isPropertyDeclaration(parent) && parent.name === identifier)
      || (ts.isPropertySignature(parent) && parent.name === identifier)
      || (ts.isEnumMember(parent) && parent.name === identifier);
  }
  function isCallCallee(identifier) {
    let expression = identifier;
    while (ts.isParenthesizedExpression(expression.parent) || ts.isAsExpression(expression.parent)
        || ts.isTypeAssertionExpression(expression.parent) || ts.isSatisfiesExpression(expression.parent)) expression = expression.parent;
    return ts.isCallExpression(expression.parent) && expression.parent.expression === expression;
  }
  function evaluate(node, environment = new Map()) {
    if (!node) return undefined;
    const bindings = environmentBindings.get(environment);
    let safe = true;
    function checkBindings(current) {
      if (ts.isIdentifier(current) && !isPropertyName(current)) {
        const binding = lexical.bindingAt(current);
        if (!binding || binding.ambiguous) {
          safe = false;
          return;
        }
        const globalBinding = evaluateRaw.globalBindings.get(current.text);
        if (isCallCallee(current)) {
          if (binding.scope !== source || globalBinding !== binding.declaration
              || (environment.has(current.text) && bindings?.get(current.text) !== binding.declaration)) safe = false;
        } else if (binding.scope === source) {
          if (environment.has(current.text) && bindings?.get(current.text) !== binding.declaration) safe = false;
          if (globalBinding && globalBinding !== binding.declaration) safe = false;
        } else if (!environment.has(current.text) || bindings?.get(current.text) !== binding.declaration) safe = false;
      }
      ts.forEachChild(current, checkBindings);
    }
    checkBindings(node);
    return safe ? evaluateRaw(node, environment) : undefined;
  }
  const resolveLocalTargetForCall = (receiver, call) => resolveLocalTarget(receiver, call, {
    source, ts, lexical, targetBinding, canonicalBindingParts, unwrapExpression,
  });
  function shadowedNames(owner, initialValues = new Map(), inheritedEnvironment = new Map()) {
    const environment = new Map(inheritedEnvironment);
    const bindings = new Map(environmentBindings.get(inheritedEnvironment) ?? []);
    environmentBindings.set(environment, bindings);
    if (!owner) return environment;
    const declarations = lexical.declarationsFor(owner);
    const duplicateNames = new Set();
    const declaredNames = new Set();
    for (const declaration of declarations) {
      const name = declaration.name;
      if (declaredNames.has(name)) duplicateNames.add(name);
      declaredNames.add(name);
      environment.set(name, undefined);
      bindings.set(name, duplicateNames.has(name) ? undefined : declaration.declaration);
    }
    for (const [name, value] of initialValues) {
      const parameters = declarations.filter((declaration) => declaration.name === name && declaration.kind === "parameter");
      if (parameters.length === 1 && !duplicateNames.has(name)) environment.set(name, value);
      else {
        environment.set(name, undefined);
        bindings.set(name, undefined);
      }
    }
    for (const declaration of declarations) {
      const name = declaration.name;
      if (duplicateNames.has(name) || declaration.kind !== "const" || !ts.isVariableDeclaration(declaration.declaration)
          || !declaration.declaration.initializer) continue;
      environment.set(name, evaluate(declaration.declaration.initializer, environment));
    }
    return environment;
  }

  const cardinality = createSqlBindingCardinality({
    source,
    ts,
    lexical,
    evaluate,
    environmentFor: shadowedNames,
  });

  function visit(node) {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === "prepare") {
      const argument = node.arguments[0];
      const contexts = cardinality.contextsForPrepare(node);
      const location = sourceLocation(source, node);
      const receiverNode = node.expression.expression;
      const receiver = receiverNode.getText(source);
      const prepareDeclarationKind = prepareDeclarationKindAt(prepareDeclarationMetadata, source.fileName, node.getStart(source));
      const target = targetOverrides?.get(node.getStart(source)) ?? resolveLocalTargetForCall(receiverNode, node);
      const variants = new Map();
      const unresolvedVariants = [];
      for (const context of contexts) {
        const { environment } = context;
        const value = evaluate(argument, environment);
        const binding = cardinality.bindingMetadata(node, context);
        if (isSql(value)) {
          const query = {
            location,
            sql: value,
            receiver,
            targetStore: target.targetStore,
            targetStatus: target.targetStatus,
            ...(target.targetStore === "unknown" && targetBindingEvidence?.has(node.getStart(source))
              ? { targetBindingEvidence: targetBindingEvidence.get(node.getStart(source)) } : {}),
            prepareDeclarationKind,
            bindingArity: binding.bindingArity,
            bindingProvenance: binding.bindingProvenance,
          };
          variants.set(JSON.stringify(query), query);
        } else {
          unresolvedVariants.push({ value, ...binding, prepareDeclarationKind });
        }
      }
      queries.push(...variants.values());
      if (!argument || unresolvedVariants.length > 0) {
        const bindingVariants = new Map(unresolvedVariants.map((item) => [JSON.stringify(item), item]));
        const distinctArities = [...new Set([...bindingVariants.values()].map((item) => item.bindingArity))];
        const distinctProvenance = [...new Set([...bindingVariants.values()].map((item) => item.bindingProvenance))];
        const value = evaluate(argument);
        unresolved.push({
          location,
          receiver,
          targetStore: target.targetStore,
          targetStatus: target.targetStatus,
          prepareDeclarationKind,
          bindingArity: distinctArities.length === 1 ? distinctArities[0] : null,
          bindingProvenance: distinctProvenance.length === 1 ? distinctProvenance[0] : "varies-by-invocation",
          classification: !argument ? "missing-prepare-argument"
            : unresolvedVariants.some((item) => item.value === undefined) ? "dynamic-or-unresolved-sql"
              : "static-unrecognized-sql",
          reason: !argument ? "missing-prepare-argument" : value === undefined ? "dynamic-or-unresolved" : "non-sql-prepare-argument",
        });
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  return { queries, unresolved };
}

function extractSource(file, targetOverrides, prepareDeclarationMetadata, targetBindingEvidence) {
  return extractSourceText(readFileSync(file, "utf8"), file, targetOverrides,
    prepareDeclarationMetadata, targetBindingEvidence);
}

export function extractApplicationSql(options = {}) {
  const files = options.sourceFiles === undefined
    ? [...sourceFiles(roots[0]), ...collectPackageSources(roots[1])].sort()
    : options.sourceFiles.map((file) => resolve(root, file));
  const program = ts.createProgram([...new Set(files.map((file) => resolve(file)))], compilerOptions(root));
  const checker = program.getTypeChecker();
  const canonicalAuthority = createCanonicalPrepareDeclarationAuthority({ program, checker, root });
  const analyzedSources = files.map((file) => program.getSourceFile(resolve(file))).filter(Boolean);
  const prepareDeclarationMetadata = createPrepareDeclarationMetadata({
    program,
    checker,
    sourceFiles: analyzedSources,
    canonicalAuthority,
  });
  const targetOverrides = options.sourceFiles === undefined
    ? createErasureReceiverTargetOverrides(files, root, program)
    : new Map();
  const targetBindingEvidence = options.includeBoundedTargetEvidence === true
    ? createBoundedCallsiteTargetEvidence({ program, checker, files, root })
    : new Map();
  const queries = [];
  const unresolved = [];
  for (const file of files) {
    const fileKey = resolve(file).replaceAll("\\", "/").toLowerCase();
    const overrides = targetOverrides.get(fileKey);
    const boundedEvidence = targetBindingEvidence.get(fileKey);
    const extracted = extractSource(file, overrides, prepareDeclarationMetadata, boundedEvidence);
    queries.push(...extracted.queries);
    unresolved.push(...extracted.unresolved);
  }
  const unique = new Map();
  for (const query of queries) unique.set(JSON.stringify(query), query);
  return {
    queries: [...unique.values()],
    unresolved,
    scannedFiles: files.length,
    excludedFixtureFiles: fixtureFiles(),
    reportedUnresolved: unresolved.slice(0, maxReportedDynamicSites),
    strictTargetQualification: process.env.D1_DEPTH_STRICT_TARGETS === "1",
  };
}

function fixtureFiles() {
  const result = [];
  for (const base of roots) {
    const files = base === roots[0] ? sourceFilesIncludingFixtures(base) : collectPackageSourcesIncludingFixtures(base);
    for (const file of files) {
      if (/fixture/i.test(file) || /(?:^|[-.])test-support(?:[-.]|$)/i.test(file)) {
        result.push(relative(root, file).split(sep).join("/"));
      }
    }
  }
  return result.sort();
}

function sourceFilesIncludingFixtures(directory, output = []) {
  for (const name of readdirSync(directory)) {
    const path = resolve(directory, name);
    const info = statSync(path);
    if (info.isDirectory()) {
      if (name !== "node_modules" && name !== "dist" && name !== "test" && name !== "tests") sourceFilesIncludingFixtures(path, output);
    } else if (/\.(?:ts|tsx|mts|cts)$/.test(name) && !/\.(?:test|spec)\./.test(name)
        && (/fixture/i.test(name) || /(?:^|[-.])test-support(?:[-.]|$)/i.test(name))) output.push(path);
  }
  return output;
}

function collectPackageSourcesIncludingFixtures(directory) {
  return readdirSync(directory).flatMap((name) => {
    const source = resolve(directory, name, "src");
    try {
      return statSync(source).isDirectory() ? sourceFilesIncludingFixtures(source) : [];
    } catch {
      return [];
    }
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = extractApplicationSql();
    if (process.argv.includes("--json")) process.stdout.write(JSON.stringify(result));
    else {
      process.stdout.write(`D1_APP_SQL inventory: files=${result.scannedFiles} recovered=${result.queries.length} unresolved=${result.unresolved.length}\n`);
      process.stdout.write(`D1_APP_SQL fixture_files=${result.excludedFixtureFiles.length}\n`);
      for (const site of result.reportedUnresolved) {
        process.stdout.write(`D1_APP_SQL unresolved ${site.location} class=${site.classification} target=${site.targetStore} `
          + `arity=${site.bindingArity === null ? "unknown" : site.bindingArity} reason=${site.reason}\n`);
      }
      if (result.unresolved.length > result.reportedUnresolved.length) process.stdout.write(`D1_APP_SQL unresolved_sites_omitted=${result.unresolved.length - result.reportedUnresolved.length}\n`);
    }
  } catch (error) {
    process.stderr.write(`D1_APP_SQL extraction failed: ${error instanceof Error ? error.name : "UNKNOWN"}\n`);
    process.exitCode = 2;
  }
}
