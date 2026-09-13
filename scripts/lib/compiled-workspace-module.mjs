import { registerHooks } from "node:module";
import { access } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, resolve, sep } from "node:path";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
let registered = false;
const exportsByPackage = new Map();

/** Operator CLIs execute the same compiled modules that the Worker uses. */
export async function loadCompiledWorkspaceModule(relativePath) {
  const path = resolve(root, relativePath);
  if (!path.startsWith(`${root}${sep}`) || !relativePath.includes("/dist/") || !path.endsWith(".js")) {
    throw new Error("Expected a compiled JavaScript module inside this workspace");
  }
  try { await access(path); }
  catch { throw new Error("Compiled operator module is missing; run pnpm exec tsc -b apps/eliotr-core first"); }
  if (!registered) {
    registerHooks({
      resolve(specifier, context, nextResolve) {
        const workspace = /^@eliotr\/([a-z0-9-]+)(?:\/([a-z0-9-]+\.js))?$/u.exec(specifier);
        if (!workspace) return nextResolve(specifier, context);
        const packageRoot = resolve(root, "packages", workspace[1]);
        if (!exportsByPackage.has(packageRoot)) {
          exportsByPackage.set(packageRoot, JSON.parse(readFileSync(resolve(packageRoot, "package.json"), "utf8")).exports);
        }
        const source = exportsByPackage.get(packageRoot)?.[workspace[2] ? `./${workspace[2]}` : "."];
        if (typeof source !== "string" || !/^\.\/src\/[a-z0-9-]+\.ts$/u.test(source)) {
          throw new Error(`Unsupported compiled workspace export: ${specifier}`);
        }
        const compiled = source.replace("./src/", "./dist/").replace(/\.ts$/u, ".js");
        return nextResolve(pathToFileURL(resolve(packageRoot, compiled)).href, context);
      },
    });
    registered = true;
  }
  return import(pathToFileURL(path).href);
}
