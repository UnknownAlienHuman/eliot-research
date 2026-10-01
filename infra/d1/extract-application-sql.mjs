import { readFileSync, readdirSync, statSync } from "node:fs";
import { relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

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
    } else if (/\.(?:ts|tsx|mts|cts)$/.test(name) && !/\.(?:test|spec)\./.test(name) && !/fixture/i.test(name)) {
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

function sourceLocation(source, node) {
  const { line } = source.getLineAndCharacterOfPosition(node.getStart(source));
  return `${relative(root, source.fileName).split(sep).join("/")}:${line + 1}`;
}

function staticEvaluator(source) {
  const declarations = new Map();
  const functions = new Map();
  const resolving = new Set();

  for (const statement of source.statements) {
    if (ts.isVariableStatement(statement) && (statement.declarationList.flags & ts.NodeFlags.Const) !== 0) {
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name) && declaration.initializer) {
          declarations.set(declaration.name.text, declaration.initializer);
          if (ts.isArrowFunction(declaration.initializer) || ts.isFunctionExpression(declaration.initializer)) {
            functions.set(declaration.name.text, declaration.initializer);
          }
        }
      }
    } else if (ts.isFunctionDeclaration(statement) && statement.name) {
      functions.set(statement.name.text, statement);
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
        if (typeof condition === "boolean") return statement(condition ? node.thenStatement : node.elseStatement);
      } else if (ts.isBlock(node)) {
        for (const child of node.statements) {
          const result = statement(child);
          if (result?.returned) return result;
        }
      } else if (ts.isSwitchStatement(node)) {
        const value = evaluate(node.expression, environment, depth + 1);
        let active = false;
        for (const clause of node.caseBlock.clauses) {
          if (ts.isDefaultClause(clause)) active ||= !node.caseBlock.clauses.some((candidate) => ts.isCaseClause(candidate) && evaluate(candidate.expression, environment, depth + 1) === value);
          else if (evaluate(clause.expression, environment, depth + 1) === value) active = true;
          if (active) for (const child of clause.statements) {
            const result = statement(child);
            if (result?.returned) return result;
          }
        }
      }
      return undefined;
    }
    for (const child of body.statements) {
      const result = statement(child);
      if (result?.returned) return result.value;
    }
    return undefined;
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
      const left = evaluate(node.left, environment, depth + 1);
      const right = evaluate(node.right, environment, depth + 1);
      if ((typeof left === "string" || typeof left === "number") && (typeof right === "string" || typeof right === "number")) return String(left) + String(right);
      return undefined;
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
        const declaration = functions.get(node.expression.text);
        if (declaration) return evaluateFunction(declaration, args, depth + 1);
      }
    }
    return undefined;
  }

  return (node, environment = new Map()) => evaluate(node, environment);
}

export function extractSourceText(text, file = resolve(root, "<fixture>.ts")) {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  if (source.parseDiagnostics.length) throw new Error("SOURCE_PARSE_FAILED");
  const evaluate = staticEvaluator(source);
  const queries = [];
  const unresolved = [];

  function invocationEnvironments(call) {
    let owner = call.parent;
    while (owner && !ts.isFunctionLike(owner)) owner = owner.parent;
    if (!owner) return [new Map()];
    const functionName = owner.name && ts.isIdentifier(owner.name) ? owner.name.text
      : ts.isVariableDeclaration(owner.parent) && ts.isIdentifier(owner.parent.name) ? owner.parent.name.text : undefined;
    if (!functionName) return [new Map()];
    const environments = [new Map()];
    function findInvocations(node) {
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === functionName && node !== owner) {
        const environment = new Map();
        owner.parameters.forEach((parameter, index) => {
          if (!ts.isIdentifier(parameter.name)) return;
          const value = node.arguments[index] ? evaluate(node.arguments[index]) : parameter.initializer ? evaluate(parameter.initializer) : undefined;
          if (value !== undefined) environment.set(parameter.name.text, value);
        });
        if (environment.size) environments.push(environment);
      }
      ts.forEachChild(node, findInvocations);
    }
    findInvocations(source);
    return environments;
  }

  function visit(node) {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === "prepare") {
      const argument = node.arguments[0];
      const environments = invocationEnvironments(node);
      const values = [...new Set(environments.map((environment) => evaluate(argument, environment)).filter(isSql))];
      const location = sourceLocation(source, node);
      if (values.length) for (const sql of values) queries.push({ location, sql });
      else {
        const value = evaluate(argument);
        unresolved.push({ location, reason: !argument ? "missing-prepare-argument" : value === undefined ? "dynamic-or-unresolved" : "non-sql-prepare-argument" });
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  return { queries, unresolved };
}

function extractSource(file) {
  return extractSourceText(readFileSync(file, "utf8"), file);
}

export function extractApplicationSql() {
  const files = [...sourceFiles(roots[0]), ...collectPackageSources(roots[1])].sort();
  const queries = [];
  const unresolved = [];
  for (const file of files) {
    const extracted = extractSource(file);
    queries.push(...extracted.queries);
    unresolved.push(...extracted.unresolved);
  }
  const unique = new Map();
  for (const query of queries) unique.set(`${query.location}\0${query.sql}`, query);
  return {
    queries: [...unique.values()],
    unresolved,
    scannedFiles: files.length,
    excludedFixtureFiles: fixtureFiles(),
    reportedUnresolved: unresolved.slice(0, maxReportedDynamicSites),
  };
}

function fixtureFiles() {
  const result = [];
  for (const base of roots) {
    const files = base === roots[0] ? sourceFilesIncludingFixtures(base) : collectPackageSourcesIncludingFixtures(base);
    for (const file of files) if (/fixture/i.test(file)) result.push(relative(root, file).split(sep).join("/"));
  }
  return result.sort();
}

function sourceFilesIncludingFixtures(directory, output = []) {
  for (const name of readdirSync(directory)) {
    const path = resolve(directory, name);
    const info = statSync(path);
    if (info.isDirectory()) {
      if (name !== "node_modules" && name !== "dist" && name !== "test" && name !== "tests") sourceFilesIncludingFixtures(path, output);
    } else if (/\.(?:ts|tsx|mts|cts)$/.test(name) && !/\.(?:test|spec)\./.test(name) && /fixture/i.test(name)) output.push(path);
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
      for (const site of result.reportedUnresolved) process.stdout.write(`D1_APP_SQL unresolved ${site.location} ${site.reason}\n`);
      if (result.unresolved.length > result.reportedUnresolved.length) process.stdout.write(`D1_APP_SQL unresolved_sites_omitted=${result.unresolved.length - result.reportedUnresolved.length}\n`);
    }
  } catch (error) {
    process.stderr.write(`D1_APP_SQL extraction failed: ${error instanceof Error ? error.name : "UNKNOWN"}\n`);
    process.exitCode = 2;
  }
}
