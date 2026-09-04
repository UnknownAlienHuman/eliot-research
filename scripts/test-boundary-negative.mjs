import { readFile, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

async function proveForbiddenImportFailsClosed() {
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
}

async function proveWorkPacketDocumentDriftFailsClosed() {
  const packetPath = resolve(
    root,
    "docs/agent-work/ER-17-access-observability-and-runtime-limits.md",
  );
  const anchor = "- `packages/platform-cloudflare/src/runtime-limits.test.ts`\n";
  const injectedPath =
    "packages/platform-cloudflare/src/__eliotr_manifest_drift__.test.ts";
  const original = await readFile(packetPath, "utf8");
  let mutated = false;

  try {
    if (original.split(anchor).length !== 2) {
      throw new Error("ER-17 owned-path anchor is missing or ambiguous");
    }
    await writeFile(
      packetPath,
      original.replace(anchor, `${anchor}- \`${injectedPath}\`\n`),
      "utf8",
    );
    mutated = true;

    const result = spawnSync(
      process.execPath,
      ["scripts/check-work-packets.mjs"],
      { cwd: root, encoding: "utf8" },
    );
    const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
    const expected =
      `ER-17: packet document owns path absent from manifest: ${injectedPath}`;

    if (result.status === 0) {
      throw new Error("work-packet document drift was accepted");
    }
    if (!output.includes(expected)) {
      throw new Error(`work-packet gate failed for the wrong reason:\n${output}`);
    }

    console.log(
      "Work-packet document drift negative boundary: PASS (gate rejected injected ownership drift).",
    );
  } finally {
    if (mutated) await writeFile(packetPath, original, "utf8");
  }
}

await proveForbiddenImportFailsClosed();
await proveWorkPacketDocumentDriftFailsClosed();
