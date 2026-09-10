import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const workPacketPath = resolve(
  root,
  "docs/agent-work/ER-17-access-observability-and-runtime-limits.md",
);

function runGate(script, expectedStatus, expectedFragments, label, cwd = root) {
  const result = spawnSync(process.execPath, [script], {
    cwd,
    encoding: "utf8",
    timeout: 15_000,
  });
  if (result.error !== undefined) throw result.error;
  const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;

  if (result.status !== expectedStatus) {
    throw new Error(`${label}: expected exit ${expectedStatus}, got ${result.status}:\n${output}`);
  }
  for (const expected of expectedFragments) {
    if (!output.includes(expected)) {
      throw new Error(`${label} failed for the wrong reason:\n${output}`);
    }
  }
}

function runGateExpectingFailure(script, expectedFragments, label) {
  runGate(script, 1, expectedFragments, label);
}

// Exercise the real scripts, not a duplicate path-conversion implementation. These
// fixtures also fail on POSIX when URL.pathname leaves spaces/Unicode percent-encoded.
async function proveCheckoutPathsArePortable() {
  const temporary = await mkdtemp(resolve(tmpdir(), "eliotr paths "));
  const checkout = resolve(temporary, "проверка # % 日本語");
  try {
    for (const path of ["scripts", "packages/domain/src", "apps/eliotr-core/src"]) {
      await mkdir(resolve(checkout, path), { recursive: true });
    }
    for (const name of ["check-boundaries.mjs", "check-budgets.mjs"]) {
      await copyFile(resolve(root, "scripts", name), resolve(checkout, "scripts", name));
    }
    const fixture = resolve(checkout, "packages/domain/src/fixture.ts");
    await writeFile(fixture, "export const safe = 1;\n");
    const boundaries = resolve(checkout, "scripts/check-boundaries.mjs");
    const budgets = resolve(checkout, "scripts/check-budgets.mjs");
    // An unrelated CWD cannot change which checkout is checked.
    runGate(boundaries, 0, ["Package boundaries and forbidden imports: PASS"], "portable boundary gate", temporary);
    runGate(budgets, 0, ["Source budgets: PASS"], "portable budget gate", temporary);
    await writeFile(fixture, 'import { readFile } from "node:fs/promises";\nvoid readFile;\n');
    runGate(boundaries, 1, ["packages/domain/src/fixture.ts imports forbidden module node:fs/promises"],
      "portable forbidden-import rejection", temporary);
    await writeFile(fixture, "// budget fixture\n".repeat(600));
    runGate(budgets, 1, ["packages/domain/src/fixture.ts has 601 lines (max 600)"],
      "portable source-budget rejection", temporary);
    console.log("Checkout portability: PASS (space/Unicode/#/% paths; unrelated CWD; exact negative exits).");
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

async function withWorkPacketMutation(label, mutate, expectedFragments) {
  const original = await readFile(workPacketPath, "utf8");
  const normalized = original.replaceAll("\r\n", "\n");
  const mutated = mutate(normalized);
  if (mutated === normalized) {
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

async function proveUnregisteredPendingStateFailsClosed() {
  const relativeFixture =
    "apps/eliotr-core/src/__eliotr_pending_status_negative__.ts";
  const fixture = resolve(root, relativeFixture);
  let created = false;

  try {
    await writeFile(
      fixture,
      'export const state = "IMPLEMENTATION_PENDING" as const;\n',
      { flag: "wx" },
    );
    created = true;
    runGateExpectingFailure(
      "scripts/check-implementation-status.mjs",
      [
        `${relativeFixture}: runtime IMPLEMENTATION_PENDING state lacks a registered SCAFFOLD_FAIL_CLOSED marker`,
      ],
      "unregistered implementation-pending negative fixture",
    );
    console.log(
      "Implementation-pending negative boundary: PASS (gate rejected unregistered runtime scaffold).",
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

await proveCheckoutPathsArePortable();
await proveForbiddenImportFailsClosed();
await proveUnregisteredPendingStateFailsClosed();
await proveWorkPacketParityFailsClosed();
