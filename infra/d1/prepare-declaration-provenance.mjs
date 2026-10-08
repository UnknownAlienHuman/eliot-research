import { resolve } from "node:path";
import ts from "typescript";

export const PREPARE_DECLARATION_KIND = Object.freeze({
  database: "workers-d1-database",
  session: "workers-d1-session",
  nonCanonical: "resolved-non-canonical",
  unresolved: "unresolved",
  noSharedProgram: "unknown-no-shared-program",
});

export function prepareDeclarationMetadataKey(fileName, start) {
  return `${resolve(fileName).replaceAll("\\", "/").toLowerCase()}\u0000${start}`;
}

export function prepareDeclarationKindAt(metadata, fileName, start) {
  return metadata?.get(prepareDeclarationMetadataKey(fileName, start))
    ?? PREPARE_DECLARATION_KIND.noSharedProgram;
}

export function createPrepareDeclarationMetadata({ program, checker, sourceFiles, canonicalAuthority }) {
  const metadata = new Map();
  if (!program?.getSourceFiles || !checker?.getResolvedSignature || !Array.isArray(sourceFiles)) return metadata;

  const programSources = new Set(program.getSourceFiles());
  const canonicalPrepareDeclarations = canonicalAuthority?.prepareDeclarationKinds;
  const receiverKind = canonicalAuthority?.receiverKind;
  for (const source of sourceFiles) {
    if (!source || !programSources.has(source)) continue;
    function visit(node) {
      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
          && node.expression.name.text === "prepare") {
        let kind = PREPARE_DECLARATION_KIND.unresolved;
        let declaration;
        try {
          declaration = checker.getResolvedSignature(node)?.declaration;
        } catch {
          declaration = undefined;
        }
        if (declaration) {
          const methodKind = canonicalPrepareDeclarations?.get(declaration);
          let receiver;
          try {
            receiver = receiverKind?.(checker.getTypeAtLocation(node.expression.expression));
          } catch {
            receiver = undefined;
          }
          const inheritedDatabasePrepare = methodKind === PREPARE_DECLARATION_KIND.database
            && receiver === PREPARE_DECLARATION_KIND.session;
          kind = methodKind && receiver && (methodKind === receiver || inheritedDatabasePrepare)
            ? receiver : PREPARE_DECLARATION_KIND.nonCanonical;
        }
        metadata.set(prepareDeclarationMetadataKey(source.fileName, node.getStart(source)), kind);
      }
      ts.forEachChild(node, visit);
    }
    visit(source);
  }
  return metadata;
}
