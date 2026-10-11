import assert from "node:assert/strict";
import { boundaryModuleImports } from "./lib/boundary-module-imports.mjs";

assert.deepEqual(boundaryModuleImports([
  "// import('node:fs'); export { x } from 'forbidden';",
  String.raw`export const label = "from \"fake-package\" and import(\"node:fs\")";`,
  'export const prose = "Facts from \'" + described.en;',
  'export const view = <span title="from fake-package">import text</span>;',
].join("\n"), "prose.tsx"), []);
assert.deepEqual(boundaryModuleImports([
  'import "node:fs";',
  'import { value } from "@eliotr/research";',
  'export { other } from "@eliotr/domain";',
  'const lazy = import("node:fs/promises");',
  'type Lazy = typeof import("@eliotr/contracts");',
  'import sqlite = require("node:sqlite");',
].join("\n"), "imports.ts"), ["node:fs", "@eliotr/research", "@eliotr/domain", "node:fs/promises", "@eliotr/contracts", "node:sqlite"]);
assert.throws(() => boundaryModuleImports('import { from "node:fs";', "invalid.ts"), /invalid module syntax/u);
for (const argument of ['"node:fs" + ""', '"node:fs" + suffix', 'specifier']) {
  assert.throws(() => boundaryModuleImports(`void import(${argument});`, "computed.ts"), /non-literal dynamic module import/u);
}
console.log("Boundary module syntax: PASS (actual static/dynamic/type/re-export imports; prose/comments excluded; malformed syntax rejected).");
