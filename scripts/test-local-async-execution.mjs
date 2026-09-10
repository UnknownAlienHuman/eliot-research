import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { executeLocalAsync } from "./lib/local-launch.mjs";

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.equal(typeof address, "object");
  return `http://127.0.0.1:${address.port}/health`;
}

test("async local commands leave the owner HTTP loop responsive", async () => {
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/plain" });
    response.end("ok");
  });
  const url = await listen(server);
  try {
    const startedAt = performance.now();
    const command = executeLocalAsync(["-e", "setTimeout(() => process.stdout.write('done'), 700)"], { capture: true });
    let timeoutId;
    const response = await Promise.race([
      fetch(url),
      new Promise((_, reject) => { timeoutId = setTimeout(() => reject(new Error("HTTP responsiveness check timed out")), 2_000); }),
    ]);
    clearTimeout(timeoutId);
    const elapsedMs = performance.now() - startedAt;
    assert.equal(response.status, 200);
    assert.equal(await response.text(), "ok");
    assert.ok(elapsedMs < 600, `HTTP response waited ${Math.round(elapsedMs)}ms for the child`);
    assert.equal(await command, "done");
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("async local command preserves split UTF-8 and classifies D1 lock failures", async () => {
  const command = executeLocalAsync(["-e", [
    "const value = Buffer.from('prefix 🌌 suffix\\n');",
    "const split = value.indexOf(Buffer.from('🌌')) + 1;",
    "process.stdout.write(value.subarray(0, split));",
    "setTimeout(() => process.stdout.write(value.subarray(split)), 10);",
  ].join("")], { capture: true });
  assert.equal(await command, "prefix 🌌 suffix\n");

  await assert.rejects(
    executeLocalAsync(["-e", "console.error('database is locked'); process.exit(1)"], { capture: true }),
    (error) => error?.cause?.diagnostic === "TRANSIENT_D1_LOCK" && /database is locked/u.test(String(error.cause.stderr)),
  );
});

test("async local command timeout waits for child termination", async () => {
  await assert.rejects(
    executeLocalAsync(["-e", "setTimeout(() => process.stdout.write('late'), 500)"], { capture: true, timeoutMs: 50 }),
    (error) => error?.cause?.code === "ETIMEDOUT",
  );
});

test("async local timeout cleans a child process tree before returning", async () => {
  const directory = await mkdtemp(join(tmpdir(), "eliotr-async-cleanup-"));
  const marker = join(directory, "late-grandchild-write");
  const grandchildCode = `setTimeout(() => require("node:fs").writeFileSync(${JSON.stringify(marker)}, "late"), 500)`;
  const parentCode = [
    "const { spawn } = require(\"node:child_process\");",
    `spawn(process.execPath, ["-e", ${JSON.stringify(grandchildCode)}], { stdio: "inherit" });`,
    "setTimeout(() => {}, 2000);",
  ].join("");
  try {
    await assert.rejects(
      executeLocalAsync(["-e", parentCode], { capture: true, timeoutMs: 75 }),
      (error) => error?.cause?.code === "ETIMEDOUT",
    );
    await new Promise((resolve) => setTimeout(resolve, 700));
    await assert.rejects(readFile(marker), { code: "ENOENT" });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
