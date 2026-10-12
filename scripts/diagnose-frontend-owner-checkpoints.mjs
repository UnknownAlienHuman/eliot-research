import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CLAIM_ROOT = "docs/agent-work/frontend-owner-claims/";
const REGISTRY = "docs/agent-work/frontend-owner-checkpoints.json";
const MAX_HISTORY = 2000;
const MAX_PATHS = 32;
const SHA = /^[a-f0-9]{40}$/u;

function fail(code, detail = "") {
  throw new Error(`${code}${detail ? `: ${detail}` : ""}`);
}
function git(args, optional = false) {
  try {
    return execFileSync("git", ["-c", "core.quotepath=false", "-C", ROOT, ...args], {
      encoding: "utf8", maxBuffer: 16 * 1024 * 1024, timeout: 30000,
      stdio: ["ignore", "pipe", "pipe"],
    }).trimEnd();
  } catch {
    if (optional) return null;
    fail("GIT_READ_FAILED", args[0] ?? "unknown");
  }
}
function covers(pattern, target) {
  const regex = pattern.split("**").map((part) => part.split("*").map((piece) =>
    piece.replace(/[.+?^${}()|[\]\\]/gu, "\\$&")).join("[^/]*")).join(".*");
  return new RegExp(`^${regex}$`, "u").test(target);
}
function readJson(rev, path) {
  const text = git(["show", `${rev}:${path}`], true);
  if (text === null) fail("MISSING_BLOB", `${rev}:${path}`);
  try { return JSON.parse(text); } catch { fail("BAD_JSON", `${rev}:${path}`); }
}
function filesAt(rev, prefix) {
  const output = git(["ls-tree", "-r", "--name-only", rev, "--", prefix]);
  return output.split("\n").filter(Boolean);
}
function activeClaimsAt(rev) {
  const claims = new Map();
  for (const file of filesAt(rev, CLAIM_ROOT)) {
    const claim = readJson(rev, file);
    if (claim?.state === "ACTIVE" && Array.isArray(claim.write_paths)) claims.set(file, claim);
  }
  return claims;
}
function registryAt(rev) {
  const registry = readJson(rev, REGISTRY);
  if (!Array.isArray(registry?.checkpoints)) fail("BAD_REGISTRY", rev);
  return registry.checkpoints;
}
function argumentsFrom(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = { "--history-base": "historyBase", "--head": "head" }[argv[index]];
    const value = argv[index + 1];
    if (!key || !value || result[key] !== undefined) fail("BAD_ARGUMENT");
    result[key] = value;
  }
  if (!SHA.test(result.historyBase ?? "") || !SHA.test(result.head ?? "")) fail("BAD_ARGUMENT");
  return result;
}

function diagnose(historyBase, head) {
  const commits = git(["rev-list", "--reverse", "--topo-order", `${historyBase}..${head}`])
    .split("\n").filter(Boolean);
  if (commits.length > MAX_HISTORY) fail("HISTORY_LIMIT", String(commits.length));
  for (const commit of commits) {
    const parents = git(["show", "-s", "--format=%P", commit]).split(" ").filter(Boolean);
    const paths = new Set();
    const parentClaims = new Map();
    for (const parent of parents) {
      const checkpoints = registryAt(parent);
      const leafRows = checkpoints.filter((row) => row?.kind === "leaf" && Array.isArray(row.write_scopes));
      const changed = git(["diff", "--name-only", "--no-renames", parent, commit]).split("\n").filter(Boolean);
      for (const path of changed) {
        if (leafRows.some((row) => row.write_scopes.some((scope) => covers(scope, path)))) paths.add(path);
      }
      for (const [file, claim] of activeClaimsAt(parent)) parentClaims.set(file, claim);
    }
    if (!paths.size) continue;
    const orderedPaths = [...paths].sort();
    const exact = [...parentClaims.entries()].filter(([, claim]) =>
      orderedPaths.every((path) => claim.write_paths.includes(path)));
    if (exact.length === 1) continue;
    const relevantClaims = [...parentClaims.entries()].filter(([, claim]) =>
      claim.write_paths.some((path) => paths.has(path))).map(([file, claim]) => ({
        file,
        claim_id: claim.claim_id,
        checkpoint_id: claim.checkpoint_id,
        matching_paths: claim.write_paths.filter((path) => paths.has(path)).sort(),
      })).sort((left, right) => left.file.localeCompare(right.file));
    return {
      protocol: "eliotr.frontend-owner-history-diagnostic.v1",
      status: "SOURCE_COVERAGE_MISMATCH",
      commit,
      parents,
      paths: orderedPaths.slice(0, MAX_PATHS),
      path_count: orderedPaths.length,
      paths_truncated: orderedPaths.length > MAX_PATHS,
      exact_cover_count: exact.length,
      relevant_active_claims: relevantClaims,
      authority: "DIAGNOSTIC_ONLY",
    };
  }
  return {
    protocol: "eliotr.frontend-owner-history-diagnostic.v1",
    status: "NO_SOURCE_COVERAGE_MISMATCH_FOUND",
    head,
    authority: "DIAGNOSTIC_ONLY",
  };
}

try {
  const { historyBase, head } = argumentsFrom(process.argv.slice(2));
  console.error(`Frontend checkpoints diagnostic: ${JSON.stringify(diagnose(historyBase, head))}`);
} catch (error) {
  console.error(`Frontend checkpoints diagnostic: FAIL ${error instanceof Error ? error.message : "UNKNOWN"}`);
  process.exitCode = 1;
}
