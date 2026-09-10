import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { installLocalCancellationSeam } from "./local-cancellation-seam.mjs";

test("cancellation seam is isolated and selects only the exact fixture query", async () => {
  const directory = await mkdtemp(resolve(tmpdir(), "eliotr-cancellation-seam-test-"));
  const wrongDirectory = await mkdtemp(resolve(tmpdir(), "eliotr-cancellation-seam-wrong-"));
  try {
    const productionMain = resolve(import.meta.dirname, "../../../apps/eliotr-core/src/index.ts");
    const configPath = resolve(directory, "wrangler.json");
    await writeFile(configPath, `${JSON.stringify({ name: "eliotr-core-local", main: productionMain })}\n`);
    const query = "owner-e2e-cancel-static-query";
    const installed = await installLocalCancellationSeam({ config: configPath, directory }, { query });
    const config = JSON.parse(await readFile(configPath, "utf8"));
    const source = await readFile(installed.entrypoint, "utf8");
    assert.equal(config.main, installed.entrypoint);
    assert.equal(config.main.endsWith("owner-e2e-cancellation-entrypoint.mjs"), true);
    assert.equal(config.main.includes("apps/eliotr-core/src/index.ts"), false);
    assert.match(source, /payload\?\.workflow_kind === "EXHAUSTIVE_QUERY"/u);
    assert.match(source, /payload\.exhaustive_request\?\.query === CANCELLATION_QUERY/u);
    assert.match(source, /waitForEvent\(CANCELLATION_EVENT, \{ type: CANCELLATION_EVENT \}\)/u);
    assert.match(source, /export default production/u);
    assert.ok(!source.includes("idempotency-key"), "the seam must not add a public request selector");

    const wrongConfig = resolve(wrongDirectory, "wrangler.json");
    await writeFile(wrongConfig, `${JSON.stringify({ name: "eliotr-core-local", main: resolve(import.meta.dirname, "../../../apps/eliotr-core/src/not-index.ts") })}\n`);
    await assert.rejects(
      installLocalCancellationSeam({ config: wrongConfig, directory: wrongDirectory }, { query }),
      /exact production Worker entrypoint/u,
      "a noncanonical config must be rejected before generating a wrapper",
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
    await rm(wrongDirectory, { recursive: true, force: true });
  }
});
