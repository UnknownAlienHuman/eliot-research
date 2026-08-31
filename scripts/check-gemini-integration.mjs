import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const root = process.cwd();
const setupPath = resolve(root, "integrations/gemini-spark/setup.mjs");
const manifestPath = resolve(root, "integrations/gemini-spark/extension/gemini-extension.json");
const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
const expectedTools = [
  "eliotr_system_status",
  "eliotr_catalog",
  "eliotr_create_google_sync_plan",
  "eliotr_validate_google_sync_receipt",
];

assert.equal(manifest.name, "eliot-research");
assert.equal(manifest.contextFileName, "GEMINI.md");
assert.deepEqual(manifest.mcpServers?.["eliot-research"]?.includeTools, expectedTools);
assert.equal(manifest.mcpServers?.["eliot-research"]?.httpUrl, "$ELIOTR_MCP_HTTP_URL");
assert.equal(manifest.mcpServers?.["eliot-research"]?.trust, undefined);
assert.equal(
  manifest.mcpServers?.["eliot-research"]?.headers?.["CF-Access-Client-Id"],
  "$ELIOTR_CF_ACCESS_CLIENT_ID",
);
assert.equal(
  manifest.mcpServers?.["eliot-research"]?.headers?.["CF-Access-Client-Secret"],
  "$ELIOTR_CF_ACCESS_CLIENT_SECRET",
);
const settings = new Map(manifest.settings.map((entry) => [entry.envVar, entry]));
assert.equal(settings.get("ELIOTR_CF_ACCESS_CLIENT_ID")?.sensitive, true);
assert.equal(settings.get("ELIOTR_CF_ACCESS_CLIENT_SECRET")?.sensitive, true);

const temporary = await mkdtemp(resolve(tmpdir(), "eliotr-gemini-"));
try {
  const settingsPath = resolve(temporary, "settings.json");
  await mkdir(dirname(settingsPath), { recursive: true });
  await writeFile(settingsPath, `${JSON.stringify({
    theme: "existing",
    mcp: { allowed: ["existing-server"] },
    mcpServers: { "existing-server": { command: "existing" } },
  }, null, 2)}\n`);
  const original = await readFile(settingsPath, "utf8");
  const secret = "MUST_NOT_APPEAR_IN_OUTPUT_OR_FILE";
  const environment = {
    ...process.env,
    ELIOTR_CF_ACCESS_CLIENT_ID: secret,
    ELIOTR_CF_ACCESS_CLIENT_SECRET: secret,
  };

  const dryRun = spawnSync(process.execPath, [
    setupPath,
    "--endpoint", "https://research.example.test/mcp",
    "--settings", settingsPath,
    "--dry-run",
  ], { cwd: root, encoding: "utf8", env: environment });
  assert.equal(dryRun.status, 0, dryRun.stderr);
  assert.equal(await readFile(settingsPath, "utf8"), original, "dry-run mutated settings");
  assert.doesNotMatch(dryRun.stdout, new RegExp(secret, "u"));
  const plan = JSON.parse(dryRun.stdout);
  assert.equal(plan.mode, "DRY_RUN_NO_MUTATION");
  assert.deepEqual(plan.settings.mcp.allowed, ["existing-server", "eliot-research"]);
  assert.equal(plan.settings.theme, "existing");
  assert.equal(plan.settings.mcpServers["existing-server"].command, "existing");
  assert.deepEqual(plan.settings.mcpServers["eliot-research"].includeTools, expectedTools);
  assert.equal(
    plan.settings.mcpServers["eliot-research"].headers["CF-Access-Client-Secret"],
    "$ELIOTR_CF_ACCESS_CLIENT_SECRET",
  );
  assert.deepEqual(
    plan.extensions.filter((entry) => entry.name !== "eliot-research").map((entry) => entry.ref),
    [
      "089927ead01433f38c65c12cdcd2ed9a18165277",
      "ec545cd8252d33c83f02b97939690b8ae16888ef",
    ],
  );

  const apply = spawnSync(process.execPath, [
    setupPath,
    "--endpoint", "https://research.example.test/mcp",
    "--settings", settingsPath,
  ], { cwd: root, encoding: "utf8", env: environment });
  assert.equal(apply.status, 0, apply.stderr);
  const firstApplied = await readFile(settingsPath, "utf8");
  assert.doesNotMatch(firstApplied, new RegExp(secret, "u"));

  const repeat = spawnSync(process.execPath, [
    setupPath,
    "--endpoint", "https://research.example.test/mcp",
    "--settings", settingsPath,
  ], { cwd: root, encoding: "utf8", env: environment });
  assert.equal(repeat.status, 0, repeat.stderr);
  assert.equal(await readFile(settingsPath, "utf8"), firstApplied, "setup is not byte-idempotent");

  const invalid = spawnSync(process.execPath, [
    setupPath,
    "--endpoint", "http://research.example.test/mcp?unsafe=1",
    "--settings", settingsPath,
    "--dry-run",
  ], { cwd: root, encoding: "utf8", env: environment });
  assert.notEqual(invalid.status, 0);
  assert.match(invalid.stderr, /exact https:\/\/<host>\/mcp/u);

  const noConsent = spawnSync(process.execPath, [
    setupPath,
    "--endpoint", "https://research.example.test/mcp",
    "--settings", settingsPath,
    "--install-extensions",
    "--dry-run",
  ], { cwd: root, encoding: "utf8", env: environment });
  assert.notEqual(noConsent.status, 0);
  assert.match(noConsent.stderr, /requires --consent/u);
} finally {
  await rm(temporary, { recursive: true, force: true });
}

console.log("Gemini Spark MCP integration fixtures: PASS");
