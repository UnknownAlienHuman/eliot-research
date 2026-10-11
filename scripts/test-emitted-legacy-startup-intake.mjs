import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArguments } from "./check-emitted-budgets.mjs";
import { readLegacyPwaStartupEvidence, readOwnerWebStartupEvidence } from "./lib/emitted-owner-startup-intake.mjs";
import { reconcileRouteLoadMembership } from "./lib/emitted-route-membership.mjs";

const digest = bytes => createHash("sha256").update(bytes).digest("hex");
const here = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = execFileSync("git", ["rev-parse", "--show-toplevel"],
  { cwd: here, encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "pipe"] }).trim();
const git = args => execFileSync("git", args,
  { cwd: repositoryRoot, windowsHide: true, maxBuffer: 8 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });
const source = git(["rev-parse", "HEAD"]).toString().trim();
const gitDirectory = git(["rev-parse", "--absolute-git-dir"]).toString().trim();
const sourceInputs = ["pnpm-lock.yaml", "apps/eliotr-core/package.json"].map(path => {
  const bytes = git(["show", source + ":" + path]);
  return { path, bytes, row: { path, bytes: bytes.length, sha256: digest(bytes),
    git_blob: createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex") } };
});
const tempParent = resolve(tmpdir());
const fixtureRoot = await mkdtemp(resolve(tempParent, "eliotr-legacy-intake-"));
const priorGitDirectory = process.env.GIT_DIR;
const refusals = [];
let cliOptionCases = 0;

async function writeBytes(filename, bytes) {
  await mkdir(dirname(filename), { recursive: true });
  await writeFile(filename, bytes);
}

async function makeFixture(name, clientPrefix, workerPath, configPath = null) {
  const root = resolve(fixtureRoot, name), snapshot = resolve(root, "snapshot");
  const clientBytes = new Map([
    ["index.html", Buffer.from('<script type="module" src="/entry.js"></script>')],
    ["entry.js", Buffer.from('import "./shared.js"; export const load = () => import("./unobserved.js");')],
    ["shared.js", Buffer.from("export const shared = 1;")],
    ["unobserved.js", Buffer.from("export const later = 2;")],
    ["style.css", Buffer.from("body { color: black; }")],
  ]);
  const artifactBytes = new Map([...clientBytes].map(([path, bytes]) => [clientPrefix + path, bytes]));
  artifactBytes.set(workerPath, Buffer.from("export default { fetch() {} };"));
  if (configPath) artifactBytes.set(configPath, Buffer.from('{"configPath":"fixture"}'));
  for (const input of sourceInputs) await writeBytes(resolve(snapshot, input.path), input.bytes);
  for (const [path, bytes] of artifactBytes) await writeBytes(resolve(snapshot, path), bytes);
  const buildPath = resolve(root, "build", "build.json");
  const readbackPath = resolve(root, "readback", "artifacts.json");
  const observationPath = resolve(root, "observer", "observation.json");
  const build = { status: "BUILT_WITH_BOUNDED_INPUT_OBSERVATION", source_commit: source, error: null,
    remote_bindings: false, candidate_directory_membership_stable: true, snapshot: "snapshot",
    started: "2026-10-11T00:00:00Z", finished: "2026-10-11T00:00:01Z",
    git_bound_observed_inputs: sourceInputs.map(input => input.row) };
  const buildBytes = Buffer.from(JSON.stringify(build));
  const readback = { status: "VERIFIED_BOUNDED_ARTIFACT_CONFIG_SOURCE_READBACK", source_commit: source,
    build: { path: relative(root, buildPath), bytes: buildBytes.length, sha256: digest(buildBytes) },
    artifacts: [...artifactBytes].map(([path, bytes]) => ({ path, bytes: bytes.length, sha256: digest(bytes) })) };
  const readbackBytes = Buffer.from(JSON.stringify(readback));
  const started = Date.parse(build.started);
  const requests = ["index.html", "entry.js", "shared.js", "shared.js"].map((path, index) => {
    const bytes = clientBytes.get(path);
    return { id: index + 1, origin: "http://127.0.0.1:12345", pathname: index === 0 ? "/" : "/" + path,
      resource_type: index === 0 ? "document" : "script", artifact: path, method: "GET", status: 200,
      state: "FINISHED", started_epoch_ms: started + 10 + index, finished_epoch_ms: started + 100 + index,
      completed_by_boundary: true, service_worker_request: false, from_service_worker: false,
      query_bytes: 0, query_sha256: digest(Buffer.alloc(0)), response_role: "PINNED_STATIC_ASSET",
      artifact_matches: true, body_sha256: digest(bytes), decoded_body_bytes: bytes.length };
  });
  // Existing observer record shape, populated by a synthetic unit fixture only.
  const observation = { protocol: "eliotr.actual-owner-startup-observation.v1",
    status: "BOUNDED_ACTUAL_RESEARCH_STARTUP_OBSERVED", source_commit: source,
    build_sha256: digest(buildBytes), artifact_readback_sha256: digest(readbackBytes),
    origin: "http://127.0.0.1:12345", route: "/", profile: "SYNTHETIC_INTAKE_NOT_RUNTIME_ACCEPTANCE",
    boundary: "FIXTURE_BOUNDARY", boundary_epoch_ms: started + 500,
    started_at: build.started, finished_at: build.finished, requests,
    requests_at_boundary: requests.map(row => ({ ...row })), observer_errors: [],
    browser_errors: { page_error_count: 0, console_error_count: 0 },
    context: { fresh: true, storage_state_loaded: false, http_cache: "DISABLED_BY_ROUTE_INTERCEPTION" },
    page_state: { service_worker_controller: null }, service_workers_at_boundary: [] };
  await writeBytes(buildPath, buildBytes);
  await writeBytes(readbackPath, readbackBytes);
  await writeBytes(observationPath, JSON.stringify(observation));
  return { root, snapshot, clientPrefix, clientBytes, artifactBytes, build, buildBytes, buildPath,
    readback, readbackPath, observation, observationPath,
    options: { sourceCommit: source, artifactReadbackPath: readbackPath,
      observationPaths: [observationPath], expectedSourceDirectory: snapshot } };
}

async function rewriteReadback(fixture, readback, observation = fixture.observation) {
  const bytes = Buffer.from(JSON.stringify(readback));
  await writeFile(fixture.readbackPath, bytes);
  await writeFile(fixture.observationPath, JSON.stringify({ ...observation, artifact_readback_sha256: digest(bytes) }));
}

async function rewriteBuild(fixture, build) {
  const bytes = Buffer.from(JSON.stringify(build));
  await writeFile(fixture.buildPath, bytes);
  await rewriteReadback(fixture, { ...fixture.readback,
    build: { ...fixture.readback.build, bytes: bytes.length, sha256: digest(bytes) } },
  { ...fixture.observation, build_sha256: digest(bytes) });
}

function consume(fixture, token) {
  const graph = new Map(["entry.js", "shared.js", "unobserved.js"].map(path => [path,
    { staticImports: path === "entry.js" ? ["shared.js"] : [],
      dynamicImports: path === "entry.js" ? ["unobserved.js"] : [], workerImports: [] }]));
  return reconcileRouteLoadMembership({ htmlPath: "index.html", entryPaths: ["entry.js"],
    graph, bytesByPath: fixture.clientBytes, startupObservation: token });
}

async function reject(label, operation, pattern) {
  await assert.rejects(operation, pattern);
  refusals.push(label);
}

async function cleanupFixture() {
  const cleanupPath = resolve(fixtureRoot), cleanupRelative = relative(tempParent, cleanupPath);
  if (!cleanupRelative || isAbsolute(cleanupRelative) || cleanupRelative.split(sep)[0] === ".." ||
      dirname(cleanupPath) !== tempParent || !basename(cleanupPath).startsWith("eliotr-legacy-intake-")) {
    throw new Error("Temporary intake fixture cleanup escaped its designated parent");
  }
  await rm(cleanupPath, { recursive: true, force: true });
}

try {
  // The scanner reads existing immutable Git objects from these temporary roots;
  // no temporary or product Git refs/index are created or changed.
  process.env.GIT_DIR = gitDirectory;
  const legacy = await makeFixture("legacy", "apps/eliotr-pwa/dist/", "apps/eliotr-core/dist/index.js");
  const owner = await makeFixture("owner", "apps/eliotr-web/dist/client/", "apps/eliotr-web/dist/eliotr_core/index.js",
    "apps/eliotr-web/.wrangler/deploy/config.json");
  for (const [fixture, reader] of [[legacy, readLegacyPwaStartupEvidence], [owner, readOwnerWebStartupEvidence]]) {
    const evidence = await reader(fixture.root, fixture.options);
    assert.equal(evidence.sourceDirectory, fixture.snapshot);
    assert.equal(evidence.sourceCommit, source);
    assert.equal(evidence.observerAuthentication, "NOT_ESTABLISHED_BY_BYTE_DIGESTS");
    assert.equal(evidence.startupObservations.size, 1);
    const token = evidence.startupObservations.get("index.html"), measured = consume(fixture, token);
    assert.equal(measured.status, "MEASURED", JSON.stringify(measured.issues));
    assert.equal(measured.initialJavaScript.resources.length, 2);
    assert.equal(measured.initialJavaScript.rawBytes,
      fixture.clientBytes.get("entry.js").length + fixture.clientBytes.get("shared.js").length);
    assert.equal(measured.unobservedDynamicJavaScript[0].path, "unobserved.js");
    assert.equal(consume(fixture, JSON.parse(JSON.stringify(token))).status, "NOT_MEASURED");
    refusals.push(basename(fixture.root) + " serialized admission token");
  }
  await reject("owner artifacts substituted for legacy", () => readLegacyPwaStartupEvidence(owner.root, owner.options), /outside the legacy PWA build/u);
  await reject("legacy artifacts substituted for owner", () => readOwnerWebStartupEvidence(legacy.root, legacy.options), /outside the generated owner-web build/u);
  await rewriteReadback(legacy, { ...legacy.readback,
    artifacts: legacy.readback.artifacts.filter(row => !row.path.endsWith("/unobserved.js")) });
  await reject("omitted unobserved client asset", () => readLegacyPwaStartupEvidence(legacy.root, legacy.options), /manifest is incomplete/u);
  await rewriteReadback(legacy, legacy.readback);
  await reject("duplicate HTML ownership", () => readLegacyPwaStartupEvidence(legacy.root,
    { ...legacy.options, observationPaths: [legacy.observationPath, legacy.observationPath] }), /duplicate or ambiguous/u);
  await rewriteReadback(legacy, legacy.readback, { ...legacy.observation,
    requests: legacy.observation.requests.map(row => row.resource_type === "document" ? { ...row, artifact: "absent.html" } : row) });
  await reject("HTML absent from client manifest", () => readLegacyPwaStartupEvidence(legacy.root, legacy.options), /HTML is absent/u);
  await rewriteReadback(legacy, legacy.readback);
  const entryPath = resolve(legacy.snapshot, legacy.clientPrefix, "entry.js");
  await writeFile(entryPath, "changed artifact");
  await reject("changed client artifact", () => readLegacyPwaStartupEvidence(legacy.root, legacy.options), /artifact bytes changed/u);
  await writeFile(entryPath, legacy.clientBytes.get("entry.js"));
  const workerPath = resolve(legacy.snapshot, "apps/eliotr-core/dist/index.js");
  await writeFile(workerPath, "changed worker");
  await reject("changed Core artifact", () => readLegacyPwaStartupEvidence(legacy.root, legacy.options), /artifact bytes changed/u);
  await writeFile(workerPath, legacy.artifactBytes.get("apps/eliotr-core/dist/index.js"));
  const sourcePath = resolve(legacy.snapshot, sourceInputs[1].path);
  await writeFile(sourcePath, "changed source");
  await reject("changed observed source", () => readLegacyPwaStartupEvidence(legacy.root, legacy.options), /source input bytes changed/u);
  await writeFile(sourcePath, sourceInputs[1].bytes);
  await rewriteBuild(legacy, { ...legacy.build, git_bound_observed_inputs: [sourceInputs[1].row] });
  await reject("omitted observed lockfile", () => readLegacyPwaStartupEvidence(legacy.root, legacy.options), /omits its observed lockfile/u);
  await rewriteBuild(legacy, legacy.build);
  await writeFile(legacy.buildPath, Buffer.concat([legacy.buildBytes, Buffer.from(" ")]));
  await reject("changed build pointer bytes", () => readLegacyPwaStartupEvidence(legacy.root, legacy.options), /pointer digest or length/u);
  await writeFile(legacy.buildPath, legacy.buildBytes);
  await reject("different selected source", () => readLegacyPwaStartupEvidence(legacy.root,
    { ...legacy.options, sourceCommit: "0".repeat(40) }), /another source/u);
  await reject("different expected build directory", () => readLegacyPwaStartupEvidence(legacy.root,
    { ...legacy.options, expectedSourceDirectory: legacy.root }), /different build directory/u);
  await rewriteReadback(legacy, { ...legacy.readback,
    artifacts: [{ path: "../outside.js", bytes: 1, sha256: "0".repeat(64) }, ...legacy.readback.artifacts] });
  await reject("escaping artifact path", () => readLegacyPwaStartupEvidence(legacy.root, legacy.options), /outside the legacy PWA build/u);
  await rewriteReadback(legacy, legacy.readback);
  await reject("escaping evidence path", () => readLegacyPwaStartupEvidence(legacy.root,
    { ...legacy.options, artifactReadbackPath: owner.readbackPath }), /escapes the repository/u);
  const linkedReadback = resolve(legacy.root, "readback-link");
  await symlink(dirname(legacy.readbackPath), linkedReadback, process.platform === "win32" ? "junction" : "dir");
  await reject("symbolic evidence ancestor", () => readLegacyPwaStartupEvidence(legacy.root,
    { ...legacy.options, artifactReadbackPath: resolve(linkedReadback, "artifacts.json") }), /symbolic links/u);

  const paired = ["--artifact-readback", legacy.readbackPath,
    "--startup-observation", legacy.observationPath, "--startup-observation", owner.observationPath];
  for (const prefix of [[], ["--check-only"], ["--owner-web"], ["--owner-web", "--check-only"]]) {
    const options = parseArguments([...prefix, ...paired]);
    assert.equal(options.ownerWeb, prefix.includes("--owner-web"));
    assert.equal(options.checkOnly, prefix.includes("--check-only"));
    assert.equal(options.artifactReadbackPath, legacy.readbackPath);
    assert.deepEqual(options.observationPaths, [legacy.observationPath, owner.observationPath]);
    if (options.ownerWeb) assert.equal(options.receiptPath, "apps/eliotr-web/.wrangler/s90-emitted-budget-receipt.json");
    cliOptionCases += 1;
    for (const half of [["--artifact-readback", legacy.readbackPath], ["--startup-observation", legacy.observationPath]]) {
      assert.throws(() => parseArguments([...prefix, ...half]), /requires both/u);
      cliOptionCases += 1;
    }
  }
  assert.throws(() => parseArguments(["--reuse-retained-owner-web", "--source-tree", source, ...paired]), /requires only/u);
  cliOptionCases += 1;
  const inspection = parseArguments(["--inspect-owner-web-startup", "--source-tree", source,
    "--artifact-readback", owner.readbackPath, "--startup-observation", owner.observationPath]);
  assert.equal(inspection.inspectOwnerWebStartup, true);
  assert.equal(inspection.receiptPath, ".eliotr-state/owner-web-startup-budget-receipt.json");
  cliOptionCases += 1;
  assert.equal((await readFile(sourcePath)).equals(sourceInputs[1].bytes), true);
} finally {
  if (priorGitDirectory === undefined) delete process.env.GIT_DIR;
  else process.env.GIT_DIR = priorGitDirectory;
  await cleanupFixture();
}
console.log(JSON.stringify({ status: "PASS", source, admission_profiles: ["legacy-pwa", "owner-web"],
  capability_and_input_refusals: refusals, cli_option_cases: cliOptionCases,
  temporary_fixture_cleanup: "COMPLETED", scope: "Synthetic focused intake/admission only; no runtime/release acceptance" }));
