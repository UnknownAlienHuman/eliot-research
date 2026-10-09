import { copyFile, lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
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
    for (const path of [
      "scripts",
      "scripts/lib",
      "packages/domain/src",
      "packages/cloudflare-research/src",
      "packages/cloudflare-model-control/src",
      "apps/eliotr-core/src",
      "apps/eliotr-core/test",
      "apps/eliotr-pwa/scripts",
    ]) {
      await mkdir(resolve(checkout, path), { recursive: true });
    }
    for (const name of ["check-boundaries.mjs", "check-budgets.mjs"]) {
      await copyFile(resolve(root, "scripts", name), resolve(checkout, "scripts", name));
    }
    for (const name of ["boundary-registration-discovery.mjs"]) {
      await copyFile(resolve(root, "scripts", "lib", name), resolve(checkout, "scripts", "lib", name));
    }
    // Registration discovery reads the reference graph. An empty graph is the
    // honest portable fixture; the live graph is proven by real repository runs.
    await writeFile(resolve(checkout, "tsconfig.json"),
      JSON.stringify({ files: [], references: [] }, null, 2) + "\n", "utf8");
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
    await writeFile(fixture, 'import { x } from "@eliotr/research";\nvoid x;\n');
    runGate(boundaries, 1, ["packages/domain/src/fixture.ts violates dependency direction with @eliotr/research"],
      "reverse dependency rejection", temporary);
    await writeFile(fixture, "export const safe = 1;\n");
    const adapter = resolve(checkout, "packages/cloudflare-research/src/fixture.ts");
    await writeFile(adapter, 'export { x } from "@eliotr/cloudflare-artifacts/unknown-subpath.js";\n');
    runGate(boundaries, 1, ["packages/cloudflare-research/src/fixture.ts violates dependency direction with @eliotr/cloudflare-artifacts/unknown-subpath.js"],
      "unknown artifact subpath rejection", temporary);
    await writeFile(adapter, [
      'export { a } from "@eliotr/cloudflare-artifacts/artifact-draft-reauthorization.js";',
      'export { b } from "@eliotr/cloudflare-artifacts/artifact-draft-citations-reauthorization.js";',
      'export { c } from "@eliotr/retrieval";',
    ].join("\n"));
    runGate(boundaries, 0, ["Package boundaries and forbidden imports: PASS"],
      "exact authorized artifact subpaths and retrieval", temporary);

    const qualificationTest = resolve(checkout,
      "packages/cloudflare-model-control/src/research-model-qualification-renewal.test.ts");
    const branchStagesTest = resolve(checkout,
      "packages/cloudflare-research/src/research-model-spend-admission-branch-stages.test.ts");
    const inboxTest = resolve(checkout,
      "apps/eliotr-core/test/agent-inbox-assets-routing.test.mjs");
    const inboxBuild = resolve(checkout, "apps/eliotr-pwa/scripts/build-agent-inbox.mjs");
    await writeFile(qualificationTest, 'import { readFileSync } from "node:fs";\nvoid readFileSync;\n');
    await writeFile(branchStagesTest, 'import { readFileSync } from "node:fs";\nvoid readFileSync;\n');
    await writeFile(inboxTest, [
      'import { readFile } from "node:fs/promises";',
      'import { chromium } from "playwright-core";',
      "void readFile; void chromium;",
    ].join("\n"));
    await writeFile(inboxBuild, 'import { readFile } from "node:fs/promises";\nvoid readFile;\n');
    runGate(boundaries, 0, ["Package boundaries and forbidden imports: PASS"],
      "exact host tool import exceptions", temporary);

    await writeFile(qualificationTest, 'import { readFile } from "node:fs/promises";\nvoid readFile;\n');
    runGate(boundaries, 1, [
      "packages/cloudflare-model-control/src/research-model-qualification-renewal.test.ts imports forbidden module node:fs/promises",
    ], "host filesystem exception rejects unlisted subpath", temporary);

    await writeFile(fixture, 'import { chromium } from "playwright-core";\nvoid chromium;\n');
    runGate(boundaries, 1, [
      "packages/domain/src/fixture.ts imports forbidden module playwright-core",
    ], "exact host Playwright exception rejects unrelated product file", temporary);

    await writeFile(inboxBuild, [
      'import { readFile } from "node:fs/promises";',
      'import { verify } from "@eliotr/cloudflare-access";',
      'import { spawn } from "node:child_process";',
      "void readFile; void verify; void spawn;",
    ].join("\n"));
    runGate(boundaries, 1, [
      "apps/eliotr-pwa/scripts/build-agent-inbox.mjs violates dependency direction with @eliotr/cloudflare-access",
      "apps/eliotr-pwa/scripts/build-agent-inbox.mjs imports forbidden module node:child_process",
    ], "host filesystem exception preserves PWA and forbidden-import boundaries", temporary);

    await writeFile(fixture, "// budget fixture\n".repeat(601));
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
  const firstOwnedPath =
    "packages/cloudflare-access/**";
  const secondOwnedPath =
    "packages/platform-cloudflare/src/observability.ts";
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
    (original) => original.replace(`- \`${secondOwnedPath}\`\n`, ""),
    [
      `ER-17: manifest owns path absent from packet document: ${secondOwnedPath}`,
    ],
  );

  await withWorkPacketMutation(
    "Work-packet ownership order drift negative boundary",
    (original) =>
      original.replace(
        `- \`${firstOwnedPath}\`\n- \`${secondOwnedPath}\`\n`,
        `- \`${secondOwnedPath}\`\n- \`${firstOwnedPath}\`\n`,
      ),
    ["ER-17: manifest and packet document owned paths use different order"],
  );

  await withWorkPacketMutation(
    "Work-packet malformed ownership entry negative boundary",
    (original) =>
      original.replace(`- \`${firstOwnedPath}\`\n`, `- ${firstOwnedPath}\n`),
    [
      "ER-17: ER-17-access-observability-and-runtime-limits.md:",
      "has malformed owned-path entry",
    ],
  );
}

if (!process.argv.includes("--owner-web")) {
  await proveCheckoutPathsArePortable();
  await proveForbiddenImportFailsClosed();
  await proveUnregisteredPendingStateFailsClosed();
  await proveWorkPacketParityFailsClosed();
}

// Owner-web and UI are registered browser roots. Each fixture below fails
// closed on a mis-declared direction, not on the mere presence of a file.
// A recursively removed path must be a fixture this harness owns and must sit
// inside the repository, so a bad path can never delete real source.
async function fixtureStat(path) {
  try { return await lstat(path); }
  catch (error) { if (error.code === "ENOENT") return null; throw error; }
}

async function removeCreatedFile(path, content) {
  const entry = await fixtureStat(path);
  if (!entry) return;
  if (!entry.isFile() || entry.isSymbolicLink() || await readFile(path, "utf8") !== content) {
    throw new Error("Refusing cleanup of changed or foreign fixture: " + path);
  }
  await rm(path);
}

async function removeOwnedFixture(directory, createdFiles) {
  const target = resolve(directory);
  if (target !== resolve(root, "packages/__eliotr_unknown_root__")) {
    throw new Error("Refusing cleanup outside the exact owned fixture: " + target);
  }
  async function inspect(path) {
    const entry = await lstat(path);
    if (!entry.isDirectory() || entry.isSymbolicLink()) {
      throw new Error("Refusing fixture cleanup through a reparse point: " + path);
    }
    for (const name of await readdir(path)) {
      const child = resolve(path, name);
      if (child === resolve(target, "src")) await inspect(child);
      else if (!createdFiles.has(child)) throw new Error("Foreign fixture entry: " + child);
      else {
        const file = await lstat(child);
        if (!file.isFile() || file.isSymbolicLink() || await readFile(child, "utf8") !== createdFiles.get(child)) {
          throw new Error("Changed fixture entry: " + child);
        }
      }
    }
  }
  await inspect(target);
  await rm(target, { recursive: true });
}

async function proveWebAndUiBoundariesFailClosed() {
  const webDir = resolve(root, "apps/eliotr-web");
  const uiDir = resolve(root, "packages/ui");
  const webFixture = resolve(webDir, "src/__eliotr_web_direction__.tsx");
  const uiFixture = resolve(uiDir, "src/__eliotr_ui_direction__.tsx");
  const unknownRoot = resolve(root, "packages/__eliotr_unknown_root__");
  if (await fixtureStat(unknownRoot)) throw new Error("Fixture root already exists; preserving it: " + unknownRoot);
  const createdFiles = new Map();
  let unknownCreated = false;
  for (const dir of [resolve(webDir, "src"), resolve(uiDir, "src")]) {
    await mkdir(dir, { recursive: true });
  }
  const cleanup = async () => {
    for (const fixture of [webFixture, uiFixture]) {
      if (createdFiles.has(fixture)) await removeCreatedFile(fixture, createdFiles.get(fixture));
    }
    if (unknownCreated) await removeOwnedFixture(unknownRoot, createdFiles);
  };
  async function createFile(path, content) {
    await writeFile(path, content, { flag: "wx" });
    createdFiles.set(path, content);
  }

  try {
    // Owner-web may import React and its UI package, never a backend root.
    await createFile(webFixture,
      'import { runtime } from "@eliotr/cloudflare-research-runtime";\n' +
      "export const useRuntime = () => runtime;\n");
    runGateExpectingFailure("scripts/check-boundaries.mjs",
      ["apps/eliotr-web/src/__eliotr_web_direction__.tsx violates dependency direction with @eliotr/cloudflare-research-runtime"],
      "owner-web backend import rejection");
    await removeCreatedFile(webFixture, createdFiles.get(webFixture));

    // UI may import React only. A backend or owner-api dependency is a breach.
    await createFile(uiFixture,
      'import { contracts } from "@eliotr/contracts";\n' +
      "export const useContracts = () => contracts;\n");
    runGateExpectingFailure("scripts/check-boundaries.mjs",
      ["packages/ui/src/__eliotr_ui_direction__.tsx violates dependency direction with @eliotr/contracts"],
      "ui backend import rejection");
    await removeCreatedFile(uiFixture, createdFiles.get(uiFixture));

    // An unknown package inside a registered source root must fail closed.
    await mkdir(unknownRoot);
    unknownCreated = true;
    await mkdir(resolve(unknownRoot, "src"));
    await createFile(resolve(unknownRoot, "package.json"),
      JSON.stringify({ name: "@eliotr/unknown-root-probe", private: true, version: "0.0.0" }) + "\n");
    await createFile(resolve(unknownRoot, "src/index.ts"),
      "export const probe = 1;\n");
    runGateExpectingFailure("scripts/check-boundaries.mjs",
      ["Workspace package @eliotr/unknown-root-probe has no boundary rule: packages/__eliotr_unknown_root__",
        "packages/__eliotr_unknown_root__/src/index.ts is source inside an unregistered workspace root; no boundary rule declares it"],
      "unknown workspace root rejection");
    await removeOwnedFixture(unknownRoot, createdFiles);
    unknownCreated = false;

    // A TS reference without a matching boundary rule must fail closed.
    const tsconfigPath = resolve(root, "tsconfig.json");
    const originalTsconfig = await readFile(tsconfigPath, "utf8");
    try {
      const mutated = originalTsconfig.replace(
        `      "path": "packages/ui"`,
        `      "path": "packages/__eliotr_ts_only__"`,
      );
      if (mutated === originalTsconfig) {
        throw new Error("ui TS reference fixture did not change tsconfig.json");
      }
      await writeFile(tsconfigPath, mutated, "utf8");
      runGateExpectingFailure("scripts/check-boundaries.mjs",
        ["TypeScript-referenced workspace root has no boundary rule: packages/__eliotr_ts_only__"],
        "unreferenced TS boundary rejection");
    } finally {
      await writeFile(tsconfigPath, originalTsconfig, "utf8");
    }

    console.log("Owner-web and UI boundary negatives: PASS (backend imports, unknown root, TS reference).");
  } finally {
    await cleanup();
  }
}

async function proveSourceBudgetEntrypoints() {
  const uiDir = resolve(root, "packages/ui/src");
  await mkdir(uiDir, { recursive: true });
  const oversized = Array.from({ length: 601 }, () => "// ui budget fixture").join("\n");
  const fixture = resolve(uiDir, "__eliotr_ui_budget__.ts");
  let created = false;
  try {
    await writeFile(fixture, oversized, { flag: "wx" });
    created = true;
    runGateExpectingFailure("scripts/check-budgets.mjs",
      ["packages/ui/src/__eliotr_ui_budget__.ts has 601 lines (max 600)"],
      "ui source line budget rejection");
    console.log("Owner-web and UI source budget negatives: PASS.");
  } finally {
    if (created) await removeCreatedFile(fixture, oversized);
  }
}

await proveWebAndUiBoundariesFailClosed();
await proveSourceBudgetEntrypoints();
