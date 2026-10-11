/**
 * Bounded inventory of module load occurrences in one emitted JavaScript asset.
 *
 * This is a pure syntactic occurrence inventory, not an evaluator and not an
 * eagerness classifier. It proves that a load occurrence exists at an exact
 * source range and records what its literal specifier is. It never decides
 * whether the owning module evaluates, whether a Worker constructor runs,
 * whether an unused dynamic import stays lazy, whether any preload runs, or
 * what the complete runtime module graph is. Those questions belong to the
 * startup-observation evidence path, which consumes this inventory as one of
 * its inputs.
 *
 * Parsing uses the installed TypeScript public API only. createSourceFile
 * supplies the text, an in-memory finite createProgram over that same file
 * supplies the syntactic diagnostics, and noLib plus noResolve keep the program
 * away from the filesystem, a library, node_modules and the network. Only
 * getSyntacticDiagnostics is consulted. Semantic diagnostics, the type
 * checker and parseDiagnostics are deliberately unused, so type information
 * can neither strengthen nor weaken a recorded occurrence.
 */

import { createHash } from "node:crypto";
import ts from "typescript";

/** Occurrence kinds this inventory distinguishes. No other kind is invented. */
export const LOAD_OCCURRENCE_KINDS = Object.freeze({
  staticImport: "static-import",
  reExport: "re-export",
  dynamicImport: "dynamic-import",
  workerConstructor: "worker-constructor",
  sharedWorkerConstructor: "shared-worker-constructor",
});

/**
 * Compatibility reason strings for an unresolved edge. The existing budget
 * consumers already report these exact literals, so an unsupported form keeps
 * the string they expect instead of inventing a new one.
 */
export const UNRESOLVED_LOAD_REASONS = Object.freeze({
  staticImport: "static import",
  reExport: "re-export",
  dynamicImport: "dynamic import",
  workerUrl: "worker URL",
});

/** The emitted inventory protocol name. */
export const LOAD_OCCURRENCE_PROTOCOL = "eliotr.module-load-occurrence.v1";

/**
 * Unit name for every recorded source position. A bare number invites the reader
 * to assume byte offsets, which is wrong for any multi-byte literal, so the
 * inventory names the unit it reports.
 */
export const LOAD_OCCURRENCE_OFFSET_UNIT = "UTF16 code units";

/**
 * Builds the one-file, no-library, no-resolution program that supplies the
 * syntactic diagnostics. Every path and every byte comes from the caller, so
 * the program is finite and touches nothing on disk.
 */
function createFiniteSyntacticProgram(fileName, source, parsedSourceFile) {
  const host = {
    getSourceFile: (candidate) => (candidate === fileName ? parsedSourceFile : undefined),
    getDefaultLibFileName: () => "",
    writeFile: () => {},
    getCurrentDirectory: () => "",
    getCanonicalFileName: (candidate) => candidate,
    useCaseSensitiveFileNames: () => true,
    getNewLine: () => "\n",
    fileExists: (candidate) => candidate === fileName,
    readFile: (candidate) => (candidate === fileName ? source : undefined),
  };
  const options = {
    allowJs: true,
    checkJs: false,
    noLib: true,
    noResolve: true,
    target: ts.ScriptTarget.Latest,
    module: ts.ModuleKind.ESNext,
    moduleDetection: ts.ModuleDetectionKind.Force,
    strict: false,
    types: [],
  };
  return ts.createProgram([fileName], options, host);
}

/** Literal text of a string literal or a substitution-free template, else null. */
function literalSpecifierOf(node) {
  return node !== undefined && node !== null && ts.isStringLiteralLike(node) ? node.text : null;
}

/**
 * True only for the exact syntax `import.meta.url`.
 *
 * TypeScript 6.0.3 has no `UrlKeyword` member, and a PropertyAccessExpression
 * name is an Identifier whose `.text` carries the property name, so the check uses
 * `isIdentifier` plus that text. A bare `import.meta` is a MetaProperty and is
 * rejected here, which keeps a URL whose base is not `import.meta.url`
 * unresolved rather than attributing it to the constructor. The MetaProperty
 * name is also verified to be exactly `meta`, so no other meta property
 * satisfies this predicate.
 */
function isImportMetaUrl(node) {
  if (node === undefined || node === null) return false;
  if (ts.isMetaProperty(node)) return false;
  if (!ts.isPropertyAccessExpression(node)) return false;
  if (!ts.isIdentifier(node.name)) return false;
  if (node.name.text !== "url") return false;
  const base = node.expression;
  if (!ts.isMetaProperty(base)) return false;
  if (base.keywordToken !== ts.SyntaxKind.ImportKeyword) return false;
  if (!ts.isIdentifier(base.name)) return false;
  return base.name.text === "meta";
}

/**
 * Returns the literal specifier of the only supported worker shape
 * new Worker(new URL(<literal>, import.meta.url), ...) and the SharedWorker
 * equivalent, or null for every other form.
 *
 * The new URL expression must be the first argument, it must be the direct
 * callee of the constructor expression, its first argument must be a literal
 * and its second argument must be exactly import.meta.url. A nested new URL
 * anywhere else in the list, an argument holder such as new Worker(makeUrl()),
 * a non-literal first argument and a new URL with no second argument all
 * return null, so a nested literal is never attributed to the constructor.
 */
function directWorkerLiteral(argumentNodes) {
  const first = argumentNodes[0];
  if (first === undefined || first === null) return null;
  if (!ts.isNewExpression(first) || !ts.isIdentifier(first.expression)) return null;
  if (first.expression.text !== "URL") return null;
  const urlArguments = first.arguments ?? [];
  if (urlArguments.length < 2) return null;
  if (!isImportMetaUrl(urlArguments[1])) return null;
  return literalSpecifierOf(urlArguments[0]);
}

/**
 * Collects every module load occurrence in one emitted JavaScript source
 * string.
 *
 * Recorded `start` and `end` values are positions in ECMAScript UTF-16 code
 * units, the same unit the ECMAScript specification and the string `length` use.
 *
 * @param source The exact module text as read from the emitted artifact.
 * @param fileName The artifact-relative name used for the parsed identity.
 * @returns An inventory holding sourceSha256, utf8Bytes, every occurrences
 *   entry in source order with its literal specifier when one exists, and the
 *   compatibility arrays staticImports, dynamicImports, workerImports and
 *   unresolved. A specifier that appears more than once is retained once per
 *   actual occurrence rather than deduplicated.
 *
 * The recorded range is the exact node the specifier came from. A static import
 * or re-export range is its module specifier literal, a dynamic import range is
 * its first argument, and a worker constructor range is the whole constructor
 * expression, so a recorded worker range can never be confused with the nested
 * URL that a rejected shape would have supplied. A literal range therefore
 * includes the quotation marks, which is why specifier text alone does not
 * equal the sliced source.
 */
export function collectModuleLoadOccurrences(source, fileName) {
  if (typeof source !== "string") throw new Error("An emitted module source must be a string");
  if (typeof fileName !== "string" || fileName.length === 0) {
    throw new Error("An emitted module file name must be a non-empty string");
  }

  const parsed = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const program = createFiniteSyntacticProgram(fileName, source, parsed);
  // The program reuses the supplied source file by identity, so traversal runs
  // over the program-owned node and every range stays bound to the caller text.
  const analyzed = program.getSourceFile(fileName);
  if (analyzed === undefined) {
    throw new Error("The finite syntactic program did not retain the emitted module");
  }

  const syntacticDiagnostics = program.getSyntacticDiagnostics(analyzed);
  if (syntacticDiagnostics.length > 0) {
    const detail = syntacticDiagnostics
      .map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, " "))
      .join("; ");
    throw new Error("An emitted JavaScript module could not be parsed: " + detail);
  }

  const occurrences = [];
  const staticImports = [];
  const dynamicImports = [];
  const workerImports = [];
  const unresolved = [];

  const record = (kind, node, specifier, unresolvedReason) => {
    occurrences.push({
      kind,
      start: node.getStart(analyzed),
      end: node.end,
      specifier,
    });
    if (unresolvedReason === null) {
      if (kind === LOAD_OCCURRENCE_KINDS.staticImport || kind === LOAD_OCCURRENCE_KINDS.reExport) {
        staticImports.push(specifier);
      } else if (kind === LOAD_OCCURRENCE_KINDS.dynamicImport) {
        dynamicImports.push(specifier);
      } else {
        workerImports.push(specifier);
      }
    } else {
      unresolved.push(unresolvedReason);
    }
  };

  const visit = (node) => {
    if (ts.isImportDeclaration(node) && node.moduleSpecifier !== undefined) {
      const specifier = literalSpecifierOf(node.moduleSpecifier);
      record(LOAD_OCCURRENCE_KINDS.staticImport, node.moduleSpecifier, specifier,
        specifier === null ? UNRESOLVED_LOAD_REASONS.staticImport : null);
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier !== undefined) {
      const specifier = literalSpecifierOf(node.moduleSpecifier);
      record(LOAD_OCCURRENCE_KINDS.reExport, node.moduleSpecifier, specifier,
        specifier === null ? UNRESOLVED_LOAD_REASONS.reExport : null);
    } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const specifier = literalSpecifierOf(node.arguments?.[0]);
      record(LOAD_OCCURRENCE_KINDS.dynamicImport, node.arguments?.[0] ?? node, specifier,
        specifier === null ? UNRESOLVED_LOAD_REASONS.dynamicImport : null);
    } else if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) &&
        ["Worker", "SharedWorker"].includes(node.expression.text)) {
      const shared = node.expression.text === "SharedWorker";
      const kind = shared ? LOAD_OCCURRENCE_KINDS.sharedWorkerConstructor
        : LOAD_OCCURRENCE_KINDS.workerConstructor;
      const specifier = directWorkerLiteral(node.arguments ?? []);
      record(kind, node, specifier,
        specifier === null ? UNRESOLVED_LOAD_REASONS.workerUrl : null);
    }
    ts.forEachChild(node, visit);
  };

  visit(analyzed);

  return Object.freeze({
    protocol: LOAD_OCCURRENCE_PROTOCOL,
    fileName,
    offsetUnit: LOAD_OCCURRENCE_OFFSET_UNIT,
    sourceSha256: createHash("sha256").update(Buffer.from(source, "utf8")).digest("hex"),
    utf8Bytes: Buffer.byteLength(source, "utf8"),
    occurrences: Object.freeze(occurrences),
    staticImports: Object.freeze(staticImports),
    dynamicImports: Object.freeze(dynamicImports),
    workerImports: Object.freeze(workerImports),
    unresolved: Object.freeze(unresolved),
  });
}

export default { collectModuleLoadOccurrences };
