import { readFile, readdir, stat } from "node:fs/promises";
import { extname, join, relative } from "node:path";

const ROOT = new URL("../", import.meta.url).pathname;
const PACKAGE_ROOTS = ["packages", "apps"];
const MAX_FILE_LINES = 600;
const MAX_PACKAGE_SOURCE_LINES = 10_000;
const MAX_WORKER_SOURCE_BYTES = 600 * 1024;
const MAX_PWA_SOURCE_BYTES = 2 * 1024 * 1024;

async function walk(dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (["node_modules", "dist", ".wrangler", ".git"].includes(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...await walk(full));
    else out.push(full);
  }
  return out;
}

const errors = [];
for (const rootName of PACKAGE_ROOTS) {
  const parent = join(ROOT, rootName);
  for (const entry of await readdir(parent, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const packageDir = join(parent, entry.name);
    const sourceDir = join(packageDir, "src");
    try { await stat(sourceDir); } catch { continue; }
    const files = (await walk(sourceDir)).filter((file) => [".ts", ".tsx", ".js", ".mjs"].includes(extname(file)));
    let lines = 0;
    let bytes = 0;
    for (const file of files) {
      const text = await readFile(file, "utf8");
      const fileLines = text.split("\n").length;
      lines += fileLines;
      bytes += Buffer.byteLength(text);
      if (fileLines > MAX_FILE_LINES) errors.push(`${relative(ROOT, file)} has ${fileLines} lines (max ${MAX_FILE_LINES})`);
    }
    if (lines > MAX_PACKAGE_SOURCE_LINES) errors.push(`${rootName}/${entry.name} has ${lines} source lines (max ${MAX_PACKAGE_SOURCE_LINES})`);
    if (`${rootName}/${entry.name}` === "apps/eliotr-core" && bytes > MAX_WORKER_SOURCE_BYTES) errors.push(`Worker source is ${bytes} bytes (max ${MAX_WORKER_SOURCE_BYTES})`);
    if (`${rootName}/${entry.name}` === "apps/eliotr-pwa" && bytes > MAX_PWA_SOURCE_BYTES) errors.push(`PWA source is ${bytes} bytes (max ${MAX_PWA_SOURCE_BYTES})`);
  }
}

if (errors.length > 0) {
  console.error(errors.join("\n"));
  process.exitCode = 1;
} else {
  console.log("Source budgets: PASS");
}
