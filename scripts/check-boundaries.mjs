import { readFile, readdir } from "node:fs/promises";
import { extname, join, relative, sep } from "node:path";

const ROOT = new URL("../", import.meta.url).pathname;
const SOURCE_ROOTS = ["packages", "apps"];
const FORBIDDEN_IMPORTS = [
  "langchain",
  "@langchain/",
  "llamaindex",
  "@llamaindex/",
  "prisma",
  "@prisma/",
  "googleapis",
  "@google-cloud/",
  "playwright",
  "puppeteer",
  "child_process",
  "node:child_process",
  "node:fs",
  "node:fs/promises",
  "better-sqlite3",
  "sqlite3",
];

const PACKAGE_RULES = new Map([
  ["packages/contracts", new Set(["zod"])],
  ["packages/domain", new Set(["@eliotr/contracts"])],
  ["packages/policy", new Set(["@eliotr/contracts", "@eliotr/domain"])],
  ["packages/retrieval", new Set(["@eliotr/contracts", "@eliotr/domain", "@eliotr/policy"])],
  ["packages/research", new Set(["@eliotr/contracts", "@eliotr/domain", "@eliotr/policy", "@eliotr/retrieval"])],
  ["packages/platform-cloudflare", new Set(["@eliotr/contracts", "@eliotr/domain", "@eliotr/retrieval", "@eliotr/research"])],
  ["packages/google-drive-exchange", new Set(["@eliotr/contracts", "@eliotr/domain", "@eliotr/policy"])],
  ["packages/interfaces", new Set(["@eliotr/contracts", "@eliotr/domain", "@eliotr/policy", "@eliotr/retrieval", "@eliotr/research", "@eliotr/google-drive-exchange"])],
  ["packages/testkit", new Set(["@eliotr/contracts", "@eliotr/domain", "@eliotr/policy", "@eliotr/retrieval", "@eliotr/research", "@eliotr/google-drive-exchange", "@eliotr/interfaces"])],
  ["apps/eliotr-pwa", new Set(["@eliotr/contracts"])],
  ["apps/eliotr-core", new Set([
    "@eliotr/contracts",
    "@eliotr/domain",
    "@eliotr/policy",
    "@eliotr/retrieval",
    "@eliotr/research",
    "@eliotr/platform-cloudflare",
    "@eliotr/google-drive-exchange",
    "@eliotr/interfaces",
  ])],
]);

async function walk(dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (["node_modules", "dist", ".wrangler", ".git"].includes(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...await walk(full));
    else if ([".ts", ".tsx", ".mts", ".cts", ".js", ".mjs"].includes(extname(entry.name))) out.push(full);
  }
  return out;
}

function ownerFor(file) {
  const normalized = relative(ROOT, file).split(sep).join("/");
  return [...PACKAGE_RULES.keys()].find((prefix) => normalized === prefix || normalized.startsWith(`${prefix}/`));
}

function importsOf(source) {
  const matches = source.matchAll(/(?:from\s+|import\s*\()\s*["']([^"']+)["']/g);
  return [...matches].map((match) => match[1]);
}

const errors = [];
for (const sourceRoot of SOURCE_ROOTS) {
  const fullRoot = join(ROOT, sourceRoot);
  for (const file of await walk(fullRoot)) {
    const owner = ownerFor(file);
    if (!owner) continue;
    const source = await readFile(file, "utf8");
    for (const specifier of importsOf(source)) {
      if (FORBIDDEN_IMPORTS.some((prefix) => specifier === prefix || specifier.startsWith(prefix))) {
        errors.push(`${relative(ROOT, file)} imports forbidden module ${specifier}`);
      }
      if (!specifier.startsWith("@eliotr/")) continue;
      const allowed = PACKAGE_RULES.get(owner);
      if (!allowed?.has(specifier)) {
        errors.push(`${relative(ROOT, file)} violates dependency direction with ${specifier}`);
      }
    }
  }
}

if (errors.length > 0) {
  console.error(errors.join("\n"));
  process.exitCode = 1;
} else {
  console.log("Package boundaries and forbidden imports: PASS");
}
