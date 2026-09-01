import { rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const fixture = resolve(root, "packages/domain/src/__eliotr_boundary_negative__.ts");
const relativeFixture = "packages/domain/src/__eliotr_boundary_negative__.ts";
let created = false;

try {
  await writeFile(fixture, 'import { readFile } from "node:fs/promises";\nvoid readFile;\n', {
    flag: "wx",
  });
  created = true;

  const result = spawnSync(process.execPath, ["scripts/check-boundaries.mjs"], {
    cwd: root,
    encoding: "utf8",
  });
  const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;

  if (result.status === 0) {
    throw new Error("forbidden-import negative fixture was accepted");
  }
  if (!output.includes(`${relativeFixture} imports forbidden module node:fs/promises`)) {
    throw new Error(`boundary gate failed for the wrong reason:\n${output}`);
  }

  console.log("Forbidden-import negative boundary: PASS (gate rejected injected node:fs import).");
} finally {
  if (created) await rm(fixture, { force: true });
}
