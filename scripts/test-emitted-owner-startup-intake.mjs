import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readOwnerWebStartupEvidence } from "./lib/emitted-owner-startup-intake.mjs";
import { parseArguments } from "./check-emitted-budgets.mjs";

const digest = bytes => createHash("sha256").update(bytes).digest("hex");
const here = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = execFileSync("git", ["rev-parse", "--show-toplevel"],
  { cwd: here, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const source = execFileSync("git", ["rev-parse", "origin/main"],
  { cwd: repositoryRoot, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const lock = execFileSync("git", ["show", source + ":pnpm-lock.yaml"],
  { cwd: repositoryRoot, stdio: ["ignore", "pipe", "pipe"] });
const lockBlob = createHash("sha1").update(`blob ${lock.length}\0`).update(lock).digest("hex");
const fixtureBase = resolve(repositoryRoot, ".eliotr-state", "startup-intake-fixtures");
await mkdir(fixtureBase, { recursive: true });
const fixture = await mkdtemp(resolve(fixtureBase, "case-"));
const snapshot = resolve(fixture, "source-snapshot");
const emitted = resolve(snapshot, "apps/eliotr-web/dist/client");
await mkdir(emitted, { recursive: true });
await mkdir(resolve(fixture, "readback"));
await mkdir(resolve(fixture, "observer"));
await writeFile(resolve(snapshot, "pnpm-lock.yaml"), lock);
const html = Buffer.from('<script type="module" src="/entry.js"></script>');
const js = Buffer.from('export const n = 1;');
await writeFile(resolve(emitted, "index.html"), html);
await writeFile(resolve(emitted, "entry.js"), js);
const buildPath = resolve(fixture, "build.json");
const readbackPath = resolve(fixture, "readback", "artifact-readback.json");
const observationPath = resolve(fixture, "observer", "observation.json");
const build = { source_commit: source, status: "BUILT_WITH_BOUNDED_INPUT_OBSERVATION", error: null,
  remote_bindings: false, candidate_directory_membership_stable: true, snapshot,
  started: "2026-10-11T00:00:00Z", finished: "2026-10-11T00:01:00Z",
  git_bound_observed_inputs: [{ path: "pnpm-lock.yaml", git_blob: lockBlob, bytes: lock.length, sha256: digest(lock) }] };
const buildBytes = Buffer.from(JSON.stringify(build));
await writeFile(buildPath, buildBytes);
const rb = { source_commit: source, status: "VERIFIED_BOUNDED_ARTIFACT_CONFIG_SOURCE_READBACK",
  build: { path: buildPath, bytes: buildBytes.length, sha256: digest(buildBytes) },
  artifacts: [["index.html", html], ["entry.js", js]].map(([path, bytes]) => ({
    path: "apps/eliotr-web/dist/client/" + path, bytes: bytes.length, sha256: digest(bytes) })) };
const readbackBytes = Buffer.from(JSON.stringify(rb));
await writeFile(readbackPath, readbackBytes);
const o = { source_commit: source, build_sha256: digest(buildBytes), artifact_readback_sha256: digest(readbackBytes),
  route: "/research", profile: "SYNTHETIC_INTAKE_UNIT_FIXTURE_NOT_RUNTIME_ACCEPTANCE", boundary: "FIXTURE_BOUNDARY",
  requests: [{ resource_type: "document", artifact: "index.html" }] };
const observationBytes = Buffer.from(JSON.stringify(o));
await writeFile(observationPath, observationBytes);
const options = { sourceCommit: source, artifactReadbackPath: readbackPath, observationPaths: [observationPath] };
const evidence = await readOwnerWebStartupEvidence(repositoryRoot, options);
assert.equal(evidence.sourceDirectory, snapshot);
assert.equal(evidence.startupObservations.size, 1);
assert.equal(evidence.observerAuthentication, "NOT_ESTABLISHED_BY_BYTE_DIGESTS");
assert.equal(JSON.stringify(evidence.startupObservations.get("index.html")), "{}");
assert.ok(relative(dirname(readbackPath), buildPath).startsWith(".."));

await assert.rejects(readOwnerWebStartupEvidence(repositoryRoot,
  { ...options, sourceCommit: "0".repeat(40) }), /another source/u);
await assert.rejects(readOwnerWebStartupEvidence(repositoryRoot,
  { ...options, observationPaths: [observationPath, observationPath] }), /duplicate or ambiguous/u);
await assert.rejects(readOwnerWebStartupEvidence(repositoryRoot,
  { ...options, expectedSourceDirectory: repositoryRoot }), /different build directory/u);
await writeFile(buildPath, Buffer.concat([buildBytes, Buffer.from(" ")]));
await assert.rejects(readOwnerWebStartupEvidence(repositoryRoot, options), /pointer digest or length/u);
await writeFile(buildPath, buildBytes);
await writeFile(resolve(emitted, "entry.js"), "changed");
await assert.rejects(readOwnerWebStartupEvidence(repositoryRoot, options), /artifact bytes changed/u);
await writeFile(resolve(emitted, "entry.js"), js);
await writeFile(resolve(emitted, "unobserved.js"), "export const extra = true;");
await assert.rejects(readOwnerWebStartupEvidence(repositoryRoot, options), /manifest is incomplete/u);
// Do not delete any source/fixture. The last negative case retains its exact
// bytes to make unobserved membership falsification independently inspectable.
// The explicit record itself is checked before pointer/artifact processing.
await symlink(resolve(fixture, "readback"), resolve(fixture, "readback-link"), process.platform === "win32" ? "junction" : "dir");
await assert.rejects(readOwnerWebStartupEvidence(repositoryRoot,
  { ...options, artifactReadbackPath: resolve(fixture, "readback-link", "artifact-readback.json") }), /symbolic links/u);

const parsed = parseArguments(["--inspect-owner-web-startup", "--source-tree", source,
  "--artifact-readback", readbackPath, "--startup-observation", observationPath]);
assert.equal(parsed.inspectOwnerWebStartup, true);
assert.equal(parsed.receiptPath, ".eliotr-state/owner-web-startup-budget-receipt.json");
assert.throws(() => parseArguments(["--owner-web", "--startup-observation", observationPath]), /requires both/u);
assert.throws(() => parseArguments(["--inspect-owner-web-startup", "--source-tree", source]), /requires exact/u);
assert.equal((await readFile(observationPath)).equals(observationBytes), true);
console.log(JSON.stringify({ status: "PASS", groups: 5,
  scope: "Cross-directory pointer/digest, source/directory identity, complete including unobserved assets, symbolic-link refusal and CLI routing; synthetic fixture only",
  fixture: relative(repositoryRoot, fixture).replaceAll("\\", "/") }));
