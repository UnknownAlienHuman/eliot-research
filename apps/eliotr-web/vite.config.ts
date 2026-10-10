import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";
import type { Plugin } from "vite";
import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import ts from "typescript";

// React 19 production forwardRef creates a descriptor; it does not run render.
// Group each fresh descriptor and its displayName store in a PURE initializer.
// This allows unused framework prefetch code to shake in library mode while
// preserving used components. Bind this optimization to the exact source.
export function libraryRouterOnlyOptimization(): Plugin {
  const appRequire = createRequire(import.meta.url);
  const routerRoot = dirname(appRequire.resolve("react-router/package.json"));
  const sourcePath = realpathSync(resolve(routerRoot, "dist/development/chunk-OB3PAWPO.mjs")).replaceAll("\\", "/");
  const expectedSha = "f6e41335042afcbcb7bcda3c8b1545fa1fb4fe3f40fd1cc08d8a18167afab8ef";
  return {
    name: "eliotr-library-router-factories",
    apply: "build",
    enforce: "pre",
    configResolved(config) {
      if (!config.isProduction) throw new Error("Router factory optimization requires a production build.");
    },
    transform(code, id) {
      if (id.split("?", 1)[0]?.replaceAll("\\", "/") !== sourcePath) return null;
      if (createHash("sha256").update(code).digest("hex") !== expectedSha) throw new Error("Pinned React Router factory source changed.");
      const ast = ts.createSourceFile(id, code, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
      const importedReact = ast.statements.some(statement => ts.isImportDeclaration(statement) &&
        ts.isStringLiteral(statement.moduleSpecifier) && statement.moduleSpecifier.text === "react" &&
        statement.importClause?.namedBindings && ts.isNamespaceImport(statement.importClause.namedBindings) &&
        statement.importClause.namedBindings.name.text === "React10");
      if (!importedReact) throw new Error("Pinned React Router namespace changed.");
      if (code.includes("__eliotrRouterFactory")) throw new Error("Router factory binding conflicts.");
      const targets = new Set(["Link", "NavLink", "Form"]);
      const edits: { start: number; end: number; text: string }[] = [];
      for (const statement of ast.statements) {
        if (!ts.isVariableStatement(statement)) continue;
        for (const declaration of statement.declarationList.declarations) {
          if (!ts.isIdentifier(declaration.name) || !targets.has(declaration.name.text)) continue;
          const call = declaration.initializer;
          const render = call && ts.isCallExpression(call) ? call.arguments[0] : undefined;
          if (!call || !ts.isCallExpression(call) || !ts.isPropertyAccessExpression(call.expression) ||
            !ts.isIdentifier(call.expression.expression) || call.expression.expression.text !== "React10" ||
            call.expression.name.text !== "forwardRef" || call.arguments.length !== 1 ||
            !render || !(ts.isFunctionExpression(render) || ts.isArrowFunction(render))) {
            throw new Error("Pinned React Router factory shape changed.");
          }
          const name = declaration.name.text;
          const names = ast.statements.filter(statement => ts.isExpressionStatement(statement) &&
            ts.isBinaryExpression(statement.expression) && statement.expression.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
            ts.isPropertyAccessExpression(statement.expression.left) && ts.isIdentifier(statement.expression.left.expression) &&
            statement.expression.left.expression.text === name && statement.expression.left.name.text === "displayName" &&
            ts.isStringLiteral(statement.expression.right) && statement.expression.right.text === name);
          const displayName = names[0];
          if (names.length !== 1 || !displayName) throw new Error("Pinned Router displayName metadata changed.");
          targets.delete(declaration.name.text);
          edits.push({ start: call.getStart(ast), end: call.getEnd(), text: `/* @__PURE__ */(() => { const __eliotrRouterFactory = ${call.getText(ast)}; __eliotrRouterFactory.displayName = ${JSON.stringify(name)}; return __eliotrRouterFactory; })()` });
          edits.push({ start: displayName.getStart(ast), end: displayName.getEnd(), text: "" });
        }
      }
      if (targets.size || edits.length !== 6) throw new Error("Pinned React Router factories are incomplete.");
      for (const edit of edits.sort((a, b) => b.start - a.start)) code = code.slice(0, edit.start) + edit.text + code.slice(edit.end);
      return { code, map: null };
    },
  };
}

// Fixture-only review: no Worker plugin, bindings or remote effects.
export default defineConfig({
  plugins: [libraryRouterOnlyOptimization(), react(), tailwindcss()],
  server: { host: "127.0.0.1", port: 5173, strictPort: true },
  build: { outDir: "dist", sourcemap: false },
});
