// ER-40 line-budget gate: every source/reference/test file <600 physical lines.
//
// Counts physical lines reliably cross-platform via Node (never
// Get-Content|Measure-Object as acceptance): splits on CRLF/LF/CR and does not
// count a trailing newline as an extra line. Reports the max file/count and
// crate totals. Fails closed on any violation.
import { readFile, readdir } from "node:fs/promises";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const MAX_FILE_LINES = 600;
const MAX_CRATE_SOURCE_LINES = 10_000;

// Single family scope: scope-snapshot-identity.v1 (ER-40). No K3+ families.
const SCOPED_DIRS = [
  "crates/eliotr-canonical/src/scope_snapshot_identity",
  "crates/eliotr-test-vectors/src/scope_snapshot_identity",
  "crates/eliotr-test-vectors/reference/scope-snapshot-identity",
  "crates/eliotr-test-vectors/tests/scope_snapshot_identity",
];
const SCOPED_FILES = [
  "crates/eliotr-canonical/src/scope_snapshot_identity.rs",
  "crates/eliotr-test-vectors/src/scope_snapshot_identity.rs",
  "crates/eliotr-test-vectors/tests/scope_snapshot_identity.rs",
  "crates/eliotr-test-vectors/reference/scope-snapshot-identity.mjs",
  "crates/eliotr-test-vectors/reference/scope-snapshot-identity-differential.mjs",
];
const CRATE_SRC_DIRS = [
  "crates/eliotr-canonical/src",
  "crates/eliotr-test-vectors/src",
];

export function countPhysicalLines(text) {
  if (text.length === 0) return 0;
  const parts = text.split(/\r\n|\n|\r/);
  // A trailing newline terminates the last line; it is not an extra line.
  if (parts.length > 0 && parts[parts.length - 1] === "") parts.pop();
  return parts.length;
}

async function collectFiles(dir, extensions) {
  const out = [];
  for (const entry of await readdir(join(ROOT, dir), { withFileTypes: true })) {
    const rel = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await collectFiles(rel, extensions)));
    else if (extensions.includes(extname(entry.name))) out.push(rel);
  }
  return out;
}

const errors = [];
let maxFile = "";
let maxCount = 0;
let scopedTotal = 0;

const scoped = [...SCOPED_FILES];
for (const dir of SCOPED_DIRS) {
  scoped.push(...(await collectFiles(dir, [".rs", ".mjs", ".js", ".ts"])));
}
scoped.sort();
for (const rel of scoped) {
  const text = await readFile(join(ROOT, rel), "utf8");
  const count = countPhysicalLines(text);
  scopedTotal += count;
  if (count > maxCount) {
    maxCount = count;
    maxFile = rel.split("\\").join("/");
  }
  if (count >= MAX_FILE_LINES) {
    errors.push(`${rel.split("\\").join("/")} has ${count} physical lines (max ${MAX_FILE_LINES - 1})`);
  }
}

// Negative control: the counter must not mistake a trailing newline or CRLF
// for an extra line.
if (countPhysicalLines("a\nb\n") !== 2) errors.push("line counter mishandles trailing LF");
if (countPhysicalLines("a\r\nb\r\n") !== 2) errors.push("line counter mishandles trailing CRLF");
if (countPhysicalLines("a\nb") !== 2) errors.push("line counter mishandles missing trailing newline");
if (countPhysicalLines("") !== 0) errors.push("line counter mishandles empty file");

const crateTotals = {};
for (const dir of CRATE_SRC_DIRS) {
  const files = await collectFiles(dir, [".rs"]);
  let total = 0;
  for (const rel of files) {
    total += countPhysicalLines(await readFile(join(ROOT, rel), "utf8"));
  }
  crateTotals[dir] = { files: files.length, lines: total };
  if (total > MAX_CRATE_SOURCE_LINES) {
    errors.push(`${dir} has ${total} source lines (max ${MAX_CRATE_SOURCE_LINES})`);
  }
}

if (errors.length > 0) {
  console.error(errors.join("\n"));
  process.exitCode = 1;
} else {
  const totals = Object.entries(crateTotals)
    .map(([dir, info]) => `${dir}=${info.lines} lines/${info.files} files`)
    .join(", ");
  console.log(
    `ER-40 line budget: PASS (${scoped.length} scoped files, ${scopedTotal} scoped lines, max ${maxFile}=${maxCount}; ${totals}).`,
  );
}
