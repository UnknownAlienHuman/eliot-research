import { register } from "node:module";
import { access } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, resolve, sep } from "node:path";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
let registered = false;

/** Operator CLIs execute the same compiled modules that the Worker uses. */
export async function loadCompiledWorkspaceModule(relativePath) {
  const path = resolve(root, relativePath);
  if (!path.startsWith(`${root}${sep}`) || !relativePath.includes("/dist/") || !path.endsWith(".js")) {
    throw new Error("Expected a compiled JavaScript module inside this workspace");
  }
  try { await access(path); }
  catch { throw new Error("Compiled operator module is missing; run pnpm exec tsc -b apps/eliotr-core first"); }
  if (!registered) {
    // Async module hooks are supported by the declared Node 22.13 minimum.
    // registerHooks would require Node 22.15 even to import this module.
    register(new URL("./compiled-workspace-hooks.mjs", import.meta.url), { data: { root } });
    registered = true;
  }
  return import(pathToFileURL(path).href);
}
