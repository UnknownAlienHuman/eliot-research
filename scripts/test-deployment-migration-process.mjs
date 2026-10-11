import assert from "node:assert/strict";
import { lstat, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import test from "node:test";
import { runDeploymentMigrationChild } from "./lib/deployment-migration-operation.mjs";

const prefix = "eliotr process fixture ";
async function fixture(t, source) {
  const directory = await mkdtemp(join(resolve(tmpdir()), prefix));
  assert.equal(dirname(directory), resolve(tmpdir()));
  t.after(async () => {
    assert.equal(dirname(directory), resolve(tmpdir()));
    assert.ok(basename(directory).startsWith(prefix));
    const info = await lstat(directory);
    assert.ok(info.isDirectory() && !info.isSymbolicLink());
    assert.equal(await realpath(directory), directory);
    await rm(directory, { recursive: true, force: false });
  });
  const file = join(directory, "native cli fixture.mjs");
  await writeFile(file, source, { flag: "wx" });
  return { directory, file };
}
const options = extra => ({ shell: false, captureOutput: true, timeoutMs: 5000, ...extra });

test("actual Node process preserves executable/script/cwd spaces and raw argv", async t => {
  const input = await fixture(t, "console.log(JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd(), marker: process.env.ELIOTR_PROCESS_FIXTURE }));\n");
  const argv = ["d1", "migrations", "apply", "database with spaces", "--remote", "--config", "config with spaces.jsonc", "&|^%!"];
  let started = 0;
  const result = await runDeploymentMigrationChild(process.execPath, [input.file, ...argv], input.directory,
    { ...process.env, ELIOTR_PROCESS_FIXTURE: "literal marker" }, options({ onStarted: () => { started += 1; } }));
  assert.equal(result.status, 0); assert.equal(result.stderr, ""); assert.equal(started, 1);
  assert.deepEqual(JSON.parse(result.stdout), { argv, cwd: input.directory, marker: "literal marker" });
});

test("actual child commit then nonzero exit retains started/uncertain state", async t => {
  const input = await fixture(t, "import { writeFileSync } from 'node:fs'; writeFileSync(process.argv[2], 'committed'); process.exit(7);\n");
  const committed = join(input.directory, "durable fixture marker");
  let started = 0;
  await assert.rejects(() => runDeploymentMigrationChild(process.execPath, [input.file, committed], input.directory,
    process.env, options({ onStarted: () => { started += 1; } })), error =>
    error.name === "OperationCommandError" && error.started === true && error.uncertain === true && error.status === 7);
  assert.equal(started, 1); assert.equal(await readFile(committed, "utf8"), "committed");
});

test("pre-cancelled process is not started and cannot write the fixture marker", async t => {
  const input = await fixture(t, "import { writeFileSync } from 'node:fs'; writeFileSync(process.argv[2], 'unexpected');\n");
  const marker = join(input.directory, "must remain absent");
  const cancellation = new globalThis.AbortController(); cancellation.abort();
  let started = 0;
  await assert.rejects(() => runDeploymentMigrationChild(process.execPath, [input.file, marker], input.directory,
    process.env, options({ signal: cancellation.signal, onStarted: () => { started += 1; } })), error =>
    error.name === "OperationCommandError" && error.started === false && error.uncertain === false);
  assert.equal(started, 0); await assert.rejects(() => readFile(marker), { code: "ENOENT" });
});
