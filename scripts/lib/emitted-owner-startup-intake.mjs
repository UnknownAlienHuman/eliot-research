import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { admitStartupObservation } from "./emitted-route-membership.mjs";

const digest = bytes => createHash("sha256").update(bytes).digest("hex");
const gitBlob = bytes => createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
const clientPrefix = "apps/eliotr-web/dist/client/";
const validPath = value => typeof value === "string" && value.length > 0 &&
  !isAbsolute(value) && !value.includes("\\") && !value.includes(":") &&
  !value.split("/").some(part => ["", ".", ".."].includes(part));

async function safePath(root, filename, directory = false) {
  const absolute = resolve(root, filename), segments = relative(root, absolute).split(sep);
  if (!segments.length || segments[0] === ".." || isAbsolute(relative(root, absolute))) {
    throw new Error("Startup evidence path escapes the repository");
  }
  let cursor = root;
  for (const part of segments) {
    if (!part) continue;
    cursor = resolve(cursor, part);
    const entry = await lstat(cursor);
    if (entry.isSymbolicLink()) throw new Error("Startup evidence cannot traverse symbolic links");
    if (cursor !== absolute && !entry.isDirectory()) throw new Error("Startup evidence ancestor is not a directory");
  }
  const entry = await lstat(absolute);
  if (directory ? !entry.isDirectory() : !entry.isFile()) throw new Error("Startup evidence is not a regular entry");
  if (resolve(await realpath(absolute)).toLowerCase() !== absolute.toLowerCase()) {
    throw new Error("Startup evidence resolves to another path");
  }
  return absolute;
}

async function readRecord(root, filename, maxBytes) {
  const absolute = await safePath(root, filename);
  if ((await lstat(absolute)).size > maxBytes) throw new Error("Startup evidence record is oversized");
  const bytes = await readFile(absolute);
  if (bytes.length > maxBytes || !Buffer.from(bytes.toString("utf8"), "utf8").equals(bytes)) {
    throw new Error("Startup evidence record is oversized or not UTF-8");
  }
  return { absolute, bytes, sha256: digest(bytes), value: JSON.parse(bytes.toString("utf8")) };
}

async function clientMembership(repositoryRoot, sourceDirectory) {
  const entries = [], start = clientPrefix.slice(0, -1);
  const walk = async prefix => {
    const directory = await safePath(repositoryRoot, resolve(sourceDirectory, prefix), true);
    for (const name of (await readdir(directory)).sort()) {
      const filename = prefix + "/" + name;
      const absolute = await safePath(repositoryRoot, resolve(sourceDirectory, filename),
        (await lstat(resolve(sourceDirectory, filename))).isDirectory());
      const entry = await lstat(absolute);
      if (entry.isDirectory()) await walk(filename);
      else entries.push(filename);
      if (entries.length > 10000) throw new Error("Unexpected startup artifact inventory");
    }
  };
  await walk(start);
  return entries.sort();
}

// These are the existing retained observer/build records, joined by their own
// pointers and byte digests. Their JSON labels are not an observer attestation.
export async function readOwnerWebStartupEvidence(repositoryRoot, options) {
  const root = resolve(repositoryRoot);
  if ((await lstat(root)).isSymbolicLink()) throw new Error("Startup repository root is a symbolic link");
  if (!/^[a-f0-9]{40}$/u.test(options.sourceCommit ?? "") ||
      !Array.isArray(options.observationPaths) || options.observationPaths.length === 0) {
    throw new Error("Startup intake requires an exact source commit and explicit observations");
  }
  const readback = await readRecord(root, options.artifactReadbackPath, 2 * 1024 * 1024);
  const rb = readback.value;
  if (rb.status !== "VERIFIED_BOUNDED_ARTIFACT_CONFIG_SOURCE_READBACK" ||
      rb.source_commit !== options.sourceCommit || !Array.isArray(rb.artifacts) || rb.artifacts.length === 0) {
    throw new Error("Startup artifact readback is incomplete or belongs to another source");
  }
  const build = await readRecord(root, rb.build?.path, 32 * 1024 * 1024);
  if (build.sha256 !== rb.build?.sha256 || build.bytes.length !== rb.build?.bytes) {
    throw new Error("Startup build pointer digest or length differs");
  }
  const b = build.value;
  if (b.status !== "BUILT_WITH_BOUNDED_INPUT_OBSERVATION" || b.source_commit !== options.sourceCommit ||
      b.error !== null || b.remote_bindings !== false || b.candidate_directory_membership_stable !== true ||
      !Number.isFinite(Date.parse(b.started)) || !Number.isFinite(Date.parse(b.finished)) ||
      Date.parse(b.started) > Date.parse(b.finished)) throw new Error("Startup build envelope is incomplete");
  const sourceDirectory = await safePath(root, b.snapshot, true);
  if (options.expectedSourceDirectory && resolve(options.expectedSourceDirectory) !== sourceDirectory) {
    throw new Error("Startup observation belongs to a different build directory");
  }
  const tree = execFileSync("git", ["ls-tree", "-r", "-z", options.sourceCommit],
    { cwd: root, windowsHide: true, maxBuffer: 8 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });
  const gitInputs = new Map(tree.toString("utf8").split("\0").filter(Boolean).map(row => {
    const tab = row.indexOf("\t"), [mode, kind, oid] = row.slice(0, tab).split(" ");
    return [row.slice(tab + 1), { mode, kind, oid }];
  }));
  if (!Array.isArray(b.git_bound_observed_inputs) || b.git_bound_observed_inputs.length === 0) {
    throw new Error("Startup build has no exact observed source inputs");
  }
  const seenInputs = new Set();
  for (const row of b.git_bound_observed_inputs) {
    const member = gitInputs.get(row.path);
    if (!validPath(row.path) || seenInputs.has(row.path) || member?.kind !== "blob" ||
        !["100644", "100755"].includes(member.mode) || member.oid !== row.git_blob) {
      throw new Error("Startup source input differs from the selected Git tree");
    }
    const bytes = await readFile(await safePath(root, resolve(sourceDirectory, row.path)));
    if (bytes.length !== row.bytes || digest(bytes) !== row.sha256 || gitBlob(bytes) !== member.oid) {
      throw new Error("Startup source input bytes changed");
    }
    seenInputs.add(row.path);
  }
  if (!seenInputs.has("pnpm-lock.yaml")) throw new Error("Startup build omits its observed lockfile");
  const artifacts = [], seenArtifacts = new Set();
  for (const row of rb.artifacts) {
    if (!validPath(row.path) || seenArtifacts.has(row.path) ||
        !(row.path.startsWith("apps/eliotr-web/dist/") || row.path === "apps/eliotr-web/.wrangler/deploy/config.json")) {
      throw new Error("Startup artifact path is duplicate or outside the generated owner-web build");
    }
    const bytes = await readFile(await safePath(root, resolve(sourceDirectory, row.path)));
    if (bytes.length !== row.bytes || digest(bytes) !== row.sha256) throw new Error("Startup artifact bytes changed");
    seenArtifacts.add(row.path);
    if (row.path.startsWith(clientPrefix)) {
      artifacts.push({ path: row.path.slice(clientPrefix.length), sha256: row.sha256, rawBytes: row.bytes });
    }
  }
  const actual = await clientMembership(root, sourceDirectory);
  const declared = [...seenArtifacts].filter(p => p.startsWith(clientPrefix)).sort();
  if (JSON.stringify(actual) !== JSON.stringify(declared)) throw new Error("Startup client artifact manifest is incomplete");
  const startupObservations = new Map(), observationDigests = [];
  for (const filename of options.observationPaths) {
    const record = await readRecord(root, filename, 4 * 1024 * 1024), o = record.value;
    const documents = o.requests?.filter(row => row.resource_type === "document") ?? [];
    if (documents.length !== 1 || !validPath(documents[0].artifact) ||
        startupObservations.has(documents[0].artifact)) throw new Error("Startup observation has duplicate or ambiguous HTML ownership");
    const htmlPath = documents[0].artifact;
    const token = admitStartupObservation(record.bytes, {
      observationSha256: record.sha256, sourceCommit: options.sourceCommit,
      buildSha256: build.sha256, artifactReadbackSha256: readback.sha256,
      route: o.route, htmlPath, profile: o.profile, boundary: o.boundary, artifacts,
    });
    startupObservations.set(htmlPath, token);
    observationDigests.push(record.sha256);
  }
  return { sourceDirectory, sourceCommit: options.sourceCommit, buildStartedAt: b.started,
    buildSha256: build.sha256, artifactReadbackSha256: readback.sha256, observationDigests,
    startupObservations, observerAuthentication: "NOT_ESTABLISHED_BY_BYTE_DIGESTS" };
}
