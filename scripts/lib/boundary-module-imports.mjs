import ts from "typescript";

/** Inspect module syntax; prose, comments and string contents are not imports. */
export function boundaryModuleImports(text, filename) {
  const source = ts.createSourceFile(filename, text, ts.ScriptTarget.Latest, false);
  if (source.parseDiagnostics.length) throw new Error(filename + " contains invalid module syntax");
  const imports = new Set();
  const add = literal => {
    if (literal && ts.isStringLiteralLike(literal)) imports.add(literal.text);
  };
  function visit(node) {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) add(node.moduleSpecifier);
    else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
      add(node.moduleReference.expression);
    } else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) add(node.argument.literal);
    else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      if (!node.arguments[0] || !ts.isStringLiteralLike(node.arguments[0])) {
        throw new Error(filename + " contains non-literal dynamic module import");
      }
      add(node.arguments[0]);
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  return [...imports];
}
