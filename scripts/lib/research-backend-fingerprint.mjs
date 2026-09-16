import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const FINGERPRINT_PROTOCOL = "eliotr.research-backend-fingerprint.v1";
const BACKEND_PATHS = Object.freeze([
  "package.json",
  "pnpm-lock.yaml",
  "tsconfig.json",
  "Cargo.toml",
  "Cargo.lock",
  "apps/eliotr-core/package.json",
  "apps/eliotr-core/tsconfig.json",
  "apps/eliotr-core/src",
  "packages",
  "crates",
  "infra/d1/core/migrations",
  "infra/d1/search/migrations",
]);
const SHA256 = /^[0-9a-f]{64}$/u;

export class ResearchBackendFingerprintError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "ResearchBackendFingerprintError";
    this.code = code;
  }
}

function fail(code, message) {
  throw new ResearchBackendFingerprintError(code, message);
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function sanitizeConfig(config) {
  if (config === null || typeof config !== "object" || Array.isArray(config)) {
    fail("RESEARCH_BACKEND_FINGERPRINT_INPUT_INVALID", "generated deployment configuration is invalid");
  }
  const copy = JSON.parse(JSON.stringify(config));
  delete copy.assets;
  if (copy.vars && typeof copy.vars === "object" && !Array.isArray(copy.vars)) {
    delete copy.vars.DEPLOYMENT_GENERATION;
  }
  return copy;
}

function defaultCapture(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, encoding: "utf8", shell: process.platform === "win32" });
  if (result.error || result.status !== 0) return null;
  return result.stdout;
}

function trackedManifest(root, capture) {
  const dirty = capture("git", ["status", "--porcelain=v1", "--untracked-files=no", "--", ...BACKEND_PATHS], root);
  if (dirty === null) fail("RESEARCH_BACKEND_FINGERPRINT_GIT_UNAVAILABLE", "backend source status is unavailable");
  if (dirty.trim() !== "") fail("RESEARCH_BACKEND_FINGERPRINT_DIRTY", "backend execution inputs contain uncommitted changes");
  const manifest = capture("git", ["ls-tree", "-r", "--full-tree", "HEAD", "--", ...BACKEND_PATHS], root);
  if (manifest === null || manifest.trim() === "") {
    fail("RESEARCH_BACKEND_FINGERPRINT_GIT_UNAVAILABLE", "backend source manifest is unavailable");
  }
  const rows = manifest.trim().split(/\r?\n/u).map((line) => {
    const match = /^(100644|100755|120000) blob ([0-9a-f]{40})\t(.+)$/u.exec(line);
    if (!match) fail("RESEARCH_BACKEND_FINGERPRINT_MANIFEST_INVALID", "backend source manifest contains an invalid row");
    return `${match[1]} ${match[2]}\t${match[3]}`;
  });
  rows.sort();
  return rows;
}

export function validateResearchBackendFingerprint(value) {
  if (typeof value !== "string" || !SHA256.test(value)) {
    fail("RESEARCH_BACKEND_FINGERPRINT_INPUT_INVALID", "backend fingerprint is invalid");
  }
  return value;
}

export function computeResearchBackendFingerprint({ root, generated_config, capture = defaultCapture } = {}) {
  if (typeof root !== "string" || root.length < 1 || typeof capture !== "function") {
    fail("RESEARCH_BACKEND_FINGERPRINT_INPUT_INVALID", "backend fingerprint input is invalid");
  }
  const resolvedRoot = resolve(root);
  const payload = {
    protocol: FINGERPRINT_PROTOCOL,
    source_manifest: trackedManifest(resolvedRoot, capture),
    deployment_config: sanitizeConfig(generated_config),
  };
  return createHash("sha256").update(canonical(payload)).digest("hex");
}
