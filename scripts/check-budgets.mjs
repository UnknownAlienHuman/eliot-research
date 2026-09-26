import { readFile, readdir, stat } from "node:fs/promises";
import { extname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const PACKAGE_ROOTS = ["packages", "apps"];
// Source-maintainability heuristics, not emitted-artifact or platform/runtime limits.
// Colocated tests under src are included; moving a file cannot establish a smaller deployed bundle.
const MAX_FILE_LINES = 600;
const MAX_PACKAGE_SOURCE_LINES = 10_000;
const MAX_WORKER_SOURCE_BYTES = 600 * 1024;
const MAX_PWA_SOURCE_BYTES = 2 * 1024 * 1024;

export function countPhysicalLines(text) {
  if (text.length === 0) return 0;
  const lines = text.split(/\r\n|\n|\r/u);
  if (lines[lines.length - 1] === "") lines.pop();
  return lines.length;
}

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

console.log("Source scope: packages/*/src and apps/*/src (.ts/.tsx/.js/.mjs), including colocated tests.");
console.log(`Source limits: ${MAX_FILE_LINES} physical lines/file; ${MAX_PACKAGE_SOURCE_LINES} lines/package; ` +
  `Worker ${MAX_WORKER_SOURCE_BYTES} bytes; PWA ${MAX_PWA_SOURCE_BYTES} bytes.`);
console.log("Emitted artifacts, startup, heap and CPU: NOT_MEASURED by this source scan (S90).");
const errors = [];
if (countPhysicalLines("a\nb\n") !== 2 || countPhysicalLines("a\r\nb\r\n") !== 2 ||
    countPhysicalLines("a\rb") !== 2 || countPhysicalLines("") !== 0) {
  errors.push("physical line counter is not cross-platform exact");
}
for (const rootName of PACKAGE_ROOTS) {
  const parent = join(ROOT, rootName);
  for (const entry of await readdir(parent, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const packageDir = join(parent, entry.name);
    const sourceDir = join(packageDir, "src");
    try { await stat(sourceDir); } catch (error) {
      if (error?.code === "ENOENT") continue; // Some workspace packages have no source directory.
      throw error; // Unreadable sources are not evidence of a passing budget.
    }
    const files = (await walk(sourceDir)).filter((file) => [".ts", ".tsx", ".js", ".mjs"].includes(extname(file)));
    let lines = 0;
    let bytes = 0;
    for (const file of files) {
      const text = await readFile(file, "utf8");
      const fileLines = countPhysicalLines(text);
      lines += fileLines;
      bytes += Buffer.byteLength(text);
      if (fileLines > MAX_FILE_LINES) errors.push(`${relative(ROOT, file).split(sep).join("/")} has ${fileLines} lines (max ${MAX_FILE_LINES})`);
    }
    if (lines > MAX_PACKAGE_SOURCE_LINES) errors.push(`${rootName}/${entry.name} has ${lines} source lines (max ${MAX_PACKAGE_SOURCE_LINES})`);
    if (`${rootName}/${entry.name}` === "apps/eliotr-core" && bytes > MAX_WORKER_SOURCE_BYTES) errors.push(`Worker source is ${bytes} bytes (max ${MAX_WORKER_SOURCE_BYTES})`);
    if (`${rootName}/${entry.name}` === "apps/eliotr-pwa" && bytes > MAX_PWA_SOURCE_BYTES) errors.push(`PWA source is ${bytes} bytes (max ${MAX_PWA_SOURCE_BYTES})`);
  }
}

if (errors.length > 0) {
  console.log(`Source budgets: FAIL (${errors.length} violations)`);
  console.error(errors.join("\n"));
  process.exitCode = 1;
} else {
  console.log("Source budgets: PASS");
}
