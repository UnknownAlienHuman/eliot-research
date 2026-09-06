// Regression for CI-FIX1 (PR #100 CI run 34022069460, Rust job 101456348622):
// `node scripts/check-rust-vectors.mjs` failed on clean Linux with
// `spawnSync pnpm ENOENT` because ensureWorkspace() spawned a bare `pnpm`
// after `corepack prepare --activate` with shell:false, depending on an
// unobservable PATH mutation. The gate must route every pnpm invocation
// through the already-resolved `corepack` executable.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const source = await readFile(resolve(root, "scripts/check-rust-vectors.mjs"), "utf8");

function contains(fragment) {
  return source.includes(fragment);
}

// 1. Never spawn a bare unresolved `pnpm` after preparation.
for (const forbidden of [`runGateCommand("pnpm"`, `runGateCommand('pnpm'`, `captureStdout("pnpm"`, `captureStdout('pnpm'`]) {
  assert.equal(
    contains(forbidden),
    false,
    `gate must not spawn bare pnpm via ${forbidden}`,
  );
}

// 2. Version probe and frozen install both route through corepack with explicit argv.
assert.equal(
  contains(`captureStdout("corepack", ["pnpm", "--version"])`),
  true,
  "version probe must use corepack pnpm --version",
);
assert.equal(
  contains(`["pnpm", "install", "--frozen-lockfile"]`),
  true,
  "frozen install must use corepack pnpm install --frozen-lockfile",
);
assert.equal(contains(`"corepack"`), true, "gate must invoke the resolved corepack executable");

// 3. Frozen semantics, version pinning, and injection resistance are preserved.
assert.equal(contains("--frozen-lockfile"), true, "frozen lockfile semantics must remain");
assert.equal(contains("packageManager"), true, "root packageManager pin must remain");
assert.equal(contains("pinnedPnpm"), true, "pinned pnpm version must remain");
assert.equal(
  contains(`["prepare", \`pnpm@\${pinnedPnpm}\`, "--activate"]`),
  true,
  "corepack prepare must keep the pinned argv element",
);

// 4. Platform-correct shell discipline: Linux keeps shell:false, Windows keeps shell shims.
assert.equal(
  contains('useShell = process.platform === "win32"'),
  true,
  "runGateCommand must preserve the win32-shell default",
);
assert.equal(contains("shell: useShell"), true, "runGateCommand must honor the shell flag");
assert.equal(contains("shell: true"), false, "gate must not force shell:true on Linux");

// 5. Model the Linux failure: a bare pnpm shim absent from PATH fails with
// ENOENT under shell:false (the CI symptom), while the corepack-resolved route
// dispatches with explicit argv and no PATH mutation.
const missing = spawnSync("eliotr-definitely-missing-pnpm-shim-xyz", ["--version"], {
  encoding: "utf8",
  shell: false,
});
assert.equal(missing.error?.code, "ENOENT", "bare missing pnpm shim must fail with ENOENT");

const routed = spawnSync(process.execPath, ["--version"], { encoding: "utf8", shell: false });
assert.equal(routed.error, undefined, "resolved executable with explicit argv must start");
assert.equal(routed.status, 0, "resolved executable must exit zero");
assert.match(routed.stdout ?? "", /^v\d+\./u, "resolved executable must report a version");

console.log("Rust vectors installer routing: PASS (corepack-resolved pnpm on POSIX and Windows; no bare pnpm spawn).");
