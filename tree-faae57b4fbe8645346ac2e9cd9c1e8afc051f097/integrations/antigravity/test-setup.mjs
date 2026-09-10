import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { prepareConfig, validateEndpoint } from "./setup.mjs";

const setupPath = fileURLToPath(new URL("./setup.mjs", import.meta.url));

test("creates a disabled, no-secret project-local template", async () => {
  const plan = spawnSync(process.execPath, [setupPath, "--endpoint", "https://research.example.test/mcp", "--dry-run"], {
    encoding: "utf8",
    env: { ...process.env, ELIOTR_CF_ACCESS_CLIENT_SECRET: "MUST_NOT_APPEAR" },
  });
  assert.equal(plan.status, 0, plan.stderr);
  const output = JSON.parse(plan.stdout);
  assert.equal(output.mode, "DRY_RUN_NO_MUTATION");
  assert.equal(output.server.serverUrl, "https://research.example.test/mcp");
  assert.equal(output.server.disabled, true);
  assert.equal(output.secrets_written, false);
  assert.doesNotMatch(plan.stdout, /MUST_NOT_APPEAR|headers|oauth|ELIOTR_CF_ACCESS/iu);
});

test("preserves unrelated servers and refuses an owned-name conflict", async () => {
  const directory = await mkdtemp(join(tmpdir(), "eliotr-antigravity-"));
  try {
    const configPath = join(directory, ".agents", "mcp_config.json");
    const original = {
      theme: "preserved",
      mcpServers: { existing: { serverUrl: "https://other.example.test/mcp" } },
    };
    await mkdir(join(directory, ".agents"), { recursive: true });
    await writeFile(configPath, `${JSON.stringify(original)}\n`);
    const initial = spawnSync(process.execPath, [setupPath, "--endpoint", "https://research.example.test/mcp", "--config", configPath, "--write"], { encoding: "utf8" });
    assert.equal(initial.status, 0, initial.stderr);
    assert.equal(JSON.parse(initial.stdout).mode, "WRITE_DISABLED_TEMPLATE");
    const written = JSON.parse(await readFile(configPath, "utf8"));
    assert.equal(written.theme, "preserved");
    assert.deepEqual(written.mcpServers.existing, original.mcpServers.existing);
    assert.deepEqual(written.mcpServers["eliot-research"], {
      serverUrl: "https://research.example.test/mcp",
      disabled: true,
    });

    const repeated = spawnSync(process.execPath, [setupPath, "--endpoint", "https://research.example.test/mcp", "--config", configPath, "--write"], { encoding: "utf8" });
    assert.equal(repeated.status, 0, repeated.stderr);
    const conflict = spawnSync(process.execPath, [setupPath, "--endpoint", "https://changed.example.test/mcp", "--config", configPath, "--write"], { encoding: "utf8" });
    assert.notEqual(conflict.status, 0);
    assert.match(conflict.stderr, /refusing to overwrite/iu);
    assert.deepEqual(JSON.parse(await readFile(configPath, "utf8")), written);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("fails closed for malformed config and unsafe endpoint", () => {
  assert.throws(() => validateEndpoint("http://research.example.test/mcp"), /exact https/iu);
  assert.throws(() => prepareConfig({ mcpServers: [] }, "https://research.example.test/mcp"), /mcpServers.*JSON object/iu);
  assert.throws(
    () => prepareConfig({ mcpServers: { "eliot-research": { serverUrl: "https://other.example.test/mcp" } } }, "https://research.example.test/mcp"),
    /refusing to overwrite/iu,
  );
});

test("does not echo malformed config contents", async () => {
  const directory = await mkdtemp(join(tmpdir(), "eliotr-antigravity-invalid-"));
  try {
    const configPath = join(directory, "mcp_config.json");
    const secret = "SECRET_MUST_NOT_APPEAR";
    await writeFile(configPath, `{"mcpServers":{"eliot-research":"${secret}"`);
    const result = spawnSync(process.execPath, [setupPath, "--endpoint", "https://research.example.test/mcp", "--config", configPath, "--write"], { encoding: "utf8" });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /is not valid JSON/iu);
    assert.doesNotMatch(result.stderr, new RegExp(secret, "u"));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

console.log("Antigravity project-local setup fixtures: PASS");
