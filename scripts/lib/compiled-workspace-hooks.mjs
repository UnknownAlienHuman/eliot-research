import { readFile } from "node:fs/promises";
import { resolve as resolvePath } from "node:path";
import { pathToFileURL } from "node:url";

let root;
const exportsByPackage = new Map();

export function initialize(data) {
  root = data.root;
}

export async function resolve(specifier, context, nextResolve) {
  const workspace = /^@eliotr\/([a-z0-9-]+)(?:\/([a-z0-9-]+(?:\.js)?))?$/u.exec(specifier);
  if (!workspace) return nextResolve(specifier, context);
  const packageRoot = resolvePath(root, "packages", workspace[1]);
  if (!exportsByPackage.has(packageRoot)) {
    exportsByPackage.set(packageRoot, JSON.parse(await readFile(resolvePath(packageRoot, "package.json"), "utf8")).exports);
  }
  const source = exportsByPackage.get(packageRoot)?.[workspace[2] ? `./${workspace[2]}` : "."];
  if (typeof source !== "string" || !/^\.\/src\/[a-z0-9-]+\.ts$/u.test(source)) {
    throw new Error(`Unsupported compiled workspace export: ${specifier}`);
  }
  const compiled = source.replace("./src/", "./dist/").replace(/\.ts$/u, ".js");
  return nextResolve(pathToFileURL(resolvePath(packageRoot, compiled)).href, context);
}
