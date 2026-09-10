import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

const FIXTURES = [
  ["tests/fixtures/contracts/eliotr.normalized.v1.yaml", "3a5f9fd2b254eebe574b2c4a28f9804df0da9df359e59ceee125fa7da90fef22"],
  ["tests/fixtures/contracts/source.owner-cutover.v1.yaml", "b659806e37a4bc60ea67b4416e35212f559213bbadb28618b7edcee686b9277e"],
];

const root = new URL("../", import.meta.url);
const failures = [];
for (const [path, expected] of FIXTURES) {
  const bytes = await readFile(new URL(path, root));
  const actual = createHash("sha256").update(bytes).digest("hex");
  if (actual !== expected) failures.push(`${path}: expected ${expected}, received ${actual}`);
}

if (failures.length > 0) {
  console.error(failures.join("\n"));
  process.exitCode = 1;
} else {
  console.log("Normative contract fixture hashes: PASS");
}
