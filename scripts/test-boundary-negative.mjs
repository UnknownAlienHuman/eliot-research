import { readFile, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const workPacketPath = resolve(
  root,
  "docs/agent-work/ER-17-access-observability-and-runtime-limits.md",
);

function runGateExpectingFailure(script, expectedFragments, label) {
  const result = spawnSync(process.execPath, [script], {
    cwd: root,
    encoding: "utf8",
  });
  if (result.error !== undefined) throw result.error;
  const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;

  if (result.status === 0) {
    throw new Error(`${label} was accepted`);
  }
  for (const expected of expectedFragments) {
    if (!output.includes(expected)) {
      throw new Error(`${label} failed for the wrong reason:\n${output}`);
    }
  }
}

async function withWorkPacketMutation(label, mutate, expectedFragments) {
  const original = await readFile(workPacketPath, "utf8");
  const mutated = mutate(original);
  if (mutated === original) {
    throw new Error(`${label} fixture did not change ER-17`);
  }

  try {
    await writeFile(workPacketPath, mutated, "utf8");
    runGateExpectingFailure(
      "scripts/check-work-packets.mjs",
      expectedFragments,
      label,
    );
    console.log(`${label}: PASS`);
  } finally {
    await writeFile(workPacketPath, original, "utf8");
  }
}

async function proveForbiddenImportFailsClosed() {
  const fixture = resolve(
    root,
    "packages/domain/src/__eliotr_boundary_negative__.ts",
  );
  const relativeFixture =
    "packages/domain/src/__eliotr_boundary_negative__.ts";
  let created = false;

  try {
    await writeFile(
      fixture,
      'import { readFile } from "node:fs/promises";\nvoid readFile;\n',
      { flag: "wx" },
    );
    created = true;
    runGateExpectingFailure(
      "scripts/check-boundaries.mjs",
      [`${relativeFixture} imports forbidden module node:fs/promises`],
      "forbidden-import negative fixture",
    );
    console.log(
      "Forbidden-import negative boundary: PASS (gate rejected injected node:fs import).",
    );
  } finally {
    if (created) await rm(fixture, { force: true });
  }
}

async function proveWorkPacketParityFailsClosed() {
  const accessPath =
    "packages/platform-cloudflare/src/access.ts";
  const accessTestPath =
    "packages/platform-cloudflare/src/access.test.ts";
  const finalPath =
    "packages/platform-cloudflare/src/runtime-limits.test.ts";
  const injectedPath =
    "packages/platform-cloudflare/src/__eliotr_manifest_drift__.test.ts";

  await withWorkPacketMutation(
    "Work-packet document-only ownership drift negative boundary",
    (original) =>
      original.replace(
        `- \`${finalPath}\`\n`,
        `- \`${finalPath}\`\n- \`${injectedPath}\`\n`,
      ),
    [
      `ER-17: packet document owns path absent from manifest: ${injectedPath}`,
    ],
  );

  await withWorkPacketMutation(
    "Work-packet manifest-only ownership drift negative boundary",
    (original) => original.replace(`- \`${accessTestPath}\`\n`, ""),
    [
      `ER-17: manifest owns path absent from packet document: ${accessTestPath}`,
    ],
  );

  await withWorkPacketMutation(
    "Work-packet ownership order drift negative boundary",
    (original) =>
      original.replace(
        `- \`${accessPath}\`\n- \`${accessTestPath}\`\n`,
        `- \`${accessTestPath}\`\n- \`${accessPath}\`\n`,
      ),
    ["ER-17: manifest and packet document owned paths use different order"],
  );

  await withWorkPacketMutation(
    "Work-packet malformed ownership entry negative boundary",
    (original) =>
      original.replace(`- \`${accessPath}\`\n`, `- ${accessPath}\n`),
    [
      "ER-17: ER-17-access-observability-and-runtime-limits.md:",
      "has malformed owned-path entry",
    ],
  );
}

await proveForbiddenImportFailsClosed();
await proveWorkPacketParityFailsClosed();
