// Provisioner exit regression (FIX2R): success paths must complete naturally.
//
// Root cause: after fetch/Undici work, process.exit(0) tears down closing
// libuv handles and fastfails on Node 24/25 Windows (status 3221226505 +
// "Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)"). All check-only
// success paths now set process.exitCode = 0 (or fall through) and let the
// event loop drain; explicit nonzero failure semantics (process.exit(2) and
// uncaught throws) are preserved.
//
// Coverage (deterministic, no network, no Cloudflare mutations, no secrets):
//   1. Static: none of the owned provisioners contains process.exit(0);
//      the three fixed scripts contain process.exitCode = 0; failure exits
//      (process.exit(2)) remain.
//   2. Runtime: each fixed provisioner spawned as a child with --help (a pure
//      success path with zero fetches) exits 0 naturally, with no
//      UV_HANDLE_CLOSING artifact and no 3221226505 status, even with empty
//      Cloudflare credentials (help bypasses auth validation).
//   3. Audit: provision-ai-gateways.mjs never had a success-path forced exit
//      (check-only falls through to the final plan log); asserted clean here.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const WIN_EXIT_ARTIFACT_STATUS = 3221226505;
const WIN_EXIT_ARTIFACT_STDERR = /UV_HANDLE_CLOSING/u;

const FIXED = [
  "scripts/provision-cloudflare-core.mjs",
  "scripts/provision-cloudflare-access.mjs",
  "scripts/provision-ai-search.mjs",
];
const AUDIT_CLEAN = "scripts/provision-ai-gateways.mjs";

function run(script, args = []) {
  return new Promise((resolveRun) => {
    const child = spawn(process.execPath, [resolve(repositoryRoot, script), ...args], {
      cwd: repositoryRoot,
      env: { ...process.env, CLOUDFLARE_ACCOUNT_ID: "", CLOUDFLARE_API_TOKEN: "" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    const timeout = setTimeout(() => child.kill("SIGKILL"), 15_000);
    child.on("error", (error) => {
      clearTimeout(timeout);
      resolveRun({ status: null, stdout, stderr: `${stderr}${String(error)}` });
    });
    child.on("close", (status) => {
      clearTimeout(timeout);
      resolveRun({ status, stdout, stderr });
    });
  });
}

let cases = 0;
const check = async (name, action) => { await action(); cases += 1; console.log(`Provisioner exit regression: ${name}: PASS`); };

for (const script of [...FIXED, AUDIT_CLEAN]) {
  await check(`${script} contains no process.exit(0)`, async () => {
    const source = await readFile(resolve(repositoryRoot, script), "utf8");
    assert.ok(!source.includes("process.exit(0)"), `${script} still forces a success exit`);
  });
}

for (const script of FIXED) {
  await check(`${script} marks success via exitCode, keeps failure exits`, async () => {
    const source = await readFile(resolve(repositoryRoot, script), "utf8");
    assert.ok(source.includes("process.exitCode = 0"), `${script} lacks natural-completion marker`);
    assert.ok(source.includes("process.exit(2)"), `${script} lost nonzero failure semantics`);
  });
}

await check(`${AUDIT_CLEAN} audit: no success exit, natural check-only completion`, async () => {
  const source = await readFile(resolve(repositoryRoot, AUDIT_CLEAN), "utf8");
  assert.ok(!source.includes("process.exit(0)"), "gateways gained a forced success exit");
  assert.ok(source.includes("CHECK_ONLY_NO_MUTATION"), "gateways check-only plan marker missing");
});

for (const script of FIXED) {
  for (let round = 1; round <= 3; round += 1) {
    await check(`${script} --help natural exit 0, no libuv artifact (run ${round}/3)`, async () => {
      const result = await run(script, ["--help"]);
      assert.equal(result.status, 0,
        `${script} --help status=${result.status}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
      assert.ok(result.status !== WIN_EXIT_ARTIFACT_STATUS, `${script} hit Windows fastfail status`);
      assert.ok(!WIN_EXIT_ARTIFACT_STDERR.test(result.stderr),
        `${script} stderr shows libuv closing-handle artifact:\n${result.stderr}`);
      assert.match(result.stdout, /Usage:/u, `${script} --help printed no usage`);
    });
  }
}

console.log(`Provisioner exit regression: ${cases} groups passed; live Cloudflare NOT_EXECUTED`);
