import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { lstat, open, readdir } from "node:fs/promises";
import path from "node:path";

const MANIFEST_PROTOCOL = "eliotr.cloudflare-assets-manifest.v1";
const MANIFEST_STATE = "LOCAL_ONLY";
const MANIFEST_DIRECTORY = "apps/eliotr-pwa/dist";
const EXCLUDED_ROUTING_FILES = Object.freeze(["_headers", "_redirects"]);
const DEFAULT_LIMITS = Object.freeze({
  fileCount: 20_000,
  fileBytes: 16 * 1024 * 1024,
  totalBytes: 256 * 1024 * 1024,
  entries: 40_000,
  deadlineMs: 120_000,
});
const SHA256_PATTERN = /^[a-f0-9]{64}$/;

/**
 * Hash the exact bounded PWA output directory represented by generated Core config.
 * The returned manifest is local preparation evidence only; it is not a deployment
 * receipt or an atomic seal over a complete build.
 */
export async function readDeploymentAssetManifest(config, { root } = {}) {
  if (typeof root !== "string" || !path.isAbsolute(root) || !isRecord(config?.assets) ||
      typeof config.assets.directory !== "string") {
    throw new Error("Deployment asset manifest inputs are invalid");
  }

  const repositoryRoot = path.resolve(root);
  const expectedDirectory = path.resolve(repositoryRoot, "apps", "eliotr-pwa", "dist");
  const configuredDirectory = path.resolve(repositoryRoot, "apps", "eliotr-core", config.assets.directory);
  if (configuredDirectory !== expectedDirectory) {
    throw new Error("Generated asset directory does not match the pinned PWA output");
  }
  let directoryStats;
  try {
    directoryStats = await lstat(expectedDirectory);
  } catch {
    throw new Error("Deployment asset directory cannot be read");
  }
  if (directoryStats.isSymbolicLink() || !directoryStats.isDirectory()) {
    throw new Error("Deployment asset directory is not a regular directory");
  }

  const files = [];
  let totalBytes = 0;
  const deadline = Date.now() + DEFAULT_LIMITS.deadlineMs;
  const scan = { entries: 0 };
  await walkAssetDirectory(expectedDirectory, "", files, (size) => {
    totalBytes += size;
    if (totalBytes > DEFAULT_LIMITS.totalBytes) {
      throw new Error("Deployment asset directory exceeds the byte limit");
    }
  }, deadline, scan);
  if (files.length === 0 || files.length > DEFAULT_LIMITS.fileCount) {
    throw new Error("Deployment asset directory has an invalid file count");
  }
  files.sort((left, right) => compareCodePoints(left.path, right.path));
  const manifest = {
    protocol: MANIFEST_PROTOCOL,
    state: MANIFEST_STATE,
    directory: MANIFEST_DIRECTORY,
    files,
    excluded_routing_files: [...EXCLUDED_ROUTING_FILES],
  };
  return { ...manifest, manifest_sha256: digestManifest(manifest.files, manifest.excluded_routing_files) };
}

/**
 * Read every listed static asset through the authenticated Worker hostname and
 * compare the decoded response body bytes with the local manifest.
 */
export async function verifyDeploymentAssets(manifest, input, { fetchImpl = globalThis.fetch,
  timeoutMs = DEFAULT_LIMITS.deadlineMs } = {}) {
  const normalized = validateManifest(manifest);
  if (!input || typeof input !== "object" || typeof input.origin !== "string") {
    throw new Error("Deployment asset readback inputs are invalid");
  }
  const origin = parseExactOrigin(input.origin);
  const cloudflared = input.ownerHttpTransport === "cloudflared" && !input.cookie;
  if (!cloudflared && (input.cookie === undefined || input.cookie === null || input.cookie === "")) {
    return { state: "NOT_EXECUTED", reason: "access_cookie_missing" };
  }
  if ((!cloudflared && (typeof input.cookie !== "string" || input.cookie.length > 16_384 || !/^[A-Za-z0-9._~-]+$/u.test(input.cookie))) || typeof fetchImpl !== "function" ||
      !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300_000) {
    throw new Error("Deployment asset readback inputs are invalid");
  }

  const routes = normalized.files.map((file) => ({ file, pathname: canonicalAssetPath(file.path) }));
  if (new Set(routes.map((route) => route.pathname)).size !== routes.length) {
    throw new Error("Deployment asset paths have a canonical URL collision");
  }

  const controller = new globalThis.AbortController();
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error("Deployment asset readback exceeded its deadline"));
    }, timeoutMs);
  });
  const readback = readAssets(routes, origin, input.cookie, fetchImpl, controller.signal);
  let completed = false;
  try {
    const result = await Promise.race([readback, deadline]);
    completed = true;
    return result;
  } finally {
    if (!completed) controller.abort();
    clearTimeout(timer);
  }
}

async function walkAssetDirectory(directory, relativeDirectory, files, addSize, deadline, scan) {
  if (Date.now() > deadline) throw new Error("Deployment asset scan exceeded its deadline");
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    throw new Error("Deployment asset directory cannot be read");
  }
  scan.entries += entries.length;
  if (scan.entries > DEFAULT_LIMITS.entries) throw new Error("Deployment asset directory exceeds the entry-count limit");
  entries.sort((left, right) => compareCodePoints(left.name, right.name));
  for (const entry of entries) {
    if (Date.now() > deadline) throw new Error("Deployment asset scan exceeded its deadline");
    const relativePath = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name;
    validatePath(relativePath);
    const absolutePath = path.join(directory, entry.name);
    let stats;
    try {
      stats = await lstat(absolutePath);
    } catch {
      throw new Error("Deployment asset directory changed while being read");
    }
    if (stats.isSymbolicLink()) throw new Error("Deployment asset directory contains a symbolic link");
    if (stats.isDirectory()) {
      await walkAssetDirectory(absolutePath, relativePath, files, addSize, deadline, scan);
      continue;
    }
    if (!stats.isFile()) throw new Error("Deployment asset directory contains a non-regular entry");
    if (!relativeDirectory && EXCLUDED_ROUTING_FILES.includes(entry.name)) continue;
    if (stats.size > DEFAULT_LIMITS.fileBytes) throw new Error("Deployment asset exceeds the per-file byte limit");
    if (files.length >= DEFAULT_LIMITS.fileCount) throw new Error("Deployment asset directory exceeds the file-count limit");

    let handle;
    try {
      const noFollow = fsConstants.O_NOFOLLOW ?? 0;
      handle = await open(absolutePath, fsConstants.O_RDONLY | noFollow);
    } catch {
      throw new Error("Deployment asset file cannot be read");
    }
    try {
      const before = await handle.stat();
      if (!before.isFile() || before.size !== stats.size || before.dev !== stats.dev || before.ino !== stats.ino) {
        throw new Error("Deployment asset changed while being read");
      }
      const hash = createHash("sha256");
      const chunk = Buffer.alloc(64 * 1024);
      let size = 0;
      try {
        for (;;) {
          if (Date.now() > deadline) throw new Error("deadline");
          const { bytesRead } = await handle.read(chunk, 0, chunk.byteLength, null);
          if (bytesRead === 0) break;
          size += bytesRead;
          if (size > before.size || size > DEFAULT_LIMITS.fileBytes) throw new Error("changed size");
          hash.update(chunk.subarray(0, bytesRead));
        }
      } catch {
        throw new Error("Deployment asset file cannot be read within its bounds");
      }
      const after = await handle.stat();
      if (after.size !== before.size || after.mtimeMs !== before.mtimeMs || size !== before.size) {
        throw new Error("Deployment asset changed while being read");
      }
      addSize(size);
      files.push({ path: relativePath, bytes: size, sha256: hash.digest("hex") });
    } finally {
      await handle.close().catch(() => {});
    }
  }
}

async function readAssets(routes, origin, cookie, fetchImpl, signal) {
  const results = [];
  for (const { file, pathname } of routes) {
    let response;
    try {
      response = await fetchImpl(new URL(pathname, origin), {
        method: "GET",
        redirect: "manual",
        cache: "no-store",
        headers: { ...(cookie ? { Cookie: `CF_Authorization=${cookie}` } : {}), Accept: "*/*" },
        signal,
      });
    } catch {
      throw new Error("Deployment asset readback failed: request error");
    }
    if (!response || response.status !== 200 || response.redirected || !response.body) {
      await cancelBody(response);
      throw new Error("Deployment asset readback failed: unexpected HTTP response");
    }
    let actual;
    try {
      actual = await hashResponseBody(response.body, file.bytes, signal);
    } catch {
      throw new Error("Deployment asset readback failed: network or stream error");
    }
    if (actual.bytes !== file.bytes || actual.sha256 !== file.sha256) {
      throw new Error("Deployment asset readback failed: content mismatch");
    }
    results.push({ path: file.path, status: 200, bytes: actual.bytes, sha256: actual.sha256 });
  }
  return { state: "PASS", results };
}

async function hashResponseBody(body, expectedBytes, signal) {
  const reader = body.getReader();
  const hash = createHash("sha256");
  const abort = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener("abort", abort, { once: true });
  let bytes = 0;
  try {
    for (;;) {
      if (signal.aborted) throw new Error("Deployment asset readback failed: aborted");
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > DEFAULT_LIMITS.fileBytes || bytes > expectedBytes) {
        throw new Error("Deployment asset readback failed: response exceeds expected size");
      }
      hash.update(value);
    }
    return { bytes, sha256: hash.digest("hex") };
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  } finally {
    signal.removeEventListener("abort", abort);
    reader.releaseLock();
  }
}

async function cancelBody(response) {
  try {
    await response?.body?.cancel();
  } catch {
    // The error response body is never used as evidence or surfaced to callers.
  }
}

function validateManifest(manifest) {
  if (!isRecord(manifest) || manifest.protocol !== MANIFEST_PROTOCOL || manifest.state !== MANIFEST_STATE ||
      manifest.directory !== MANIFEST_DIRECTORY || !Array.isArray(manifest.files) || manifest.files.length === 0 ||
      manifest.files.length > DEFAULT_LIMITS.fileCount || !Array.isArray(manifest.excluded_routing_files) ||
      manifest.excluded_routing_files.length !== EXCLUDED_ROUTING_FILES.length ||
      manifest.excluded_routing_files.some((file, index) => file !== EXCLUDED_ROUTING_FILES[index]) ||
      typeof manifest.manifest_sha256 !== "string" || !SHA256_PATTERN.test(manifest.manifest_sha256)) {
    throw new Error("Deployment asset manifest is invalid");
  }
  let totalBytes = 0;
  const paths = new Set();
  for (const file of manifest.files) {
    if (!isRecord(file) || typeof file.path !== "string" || !Number.isSafeInteger(file.bytes) || file.bytes < 0 ||
        file.bytes > DEFAULT_LIMITS.fileBytes || typeof file.sha256 !== "string" || !SHA256_PATTERN.test(file.sha256)) {
      throw new Error("Deployment asset manifest is invalid");
    }
    validatePath(file.path);
    if (paths.has(file.path)) throw new Error("Deployment asset manifest contains duplicate paths");
    paths.add(file.path);
    totalBytes += file.bytes;
    if (totalBytes > DEFAULT_LIMITS.totalBytes) throw new Error("Deployment asset manifest exceeds the byte limit");
  }
  const sortedFiles = [...manifest.files].sort((left, right) => compareCodePoints(left.path, right.path));
  if (sortedFiles.some((file, index) => file.path !== manifest.files[index].path) ||
      digestManifest(manifest.files, manifest.excluded_routing_files) !== manifest.manifest_sha256) {
    throw new Error("Deployment asset manifest digest or order is invalid");
  }
  return { files: manifest.files };
}

function validatePath(value) {
  if (typeof value !== "string" || value.length === 0 || value.length > 1024 || value.startsWith("/") ||
      value.includes("\\") || value.includes("%") || value.includes(":") || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new Error("Deployment asset path is invalid");
  }
  const segments = value.split("/");
  if (segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")) {
    throw new Error("Deployment asset path is invalid");
  }
}

function canonicalAssetPath(filePath) {
  if (filePath === "index.html") return "/";
  if (filePath.endsWith("/index.html")) return `/${encodeSegments(filePath.slice(0, -"index.html".length).replace(/\/$/, ""))}/`;
  if (filePath.endsWith(".html")) return `/${encodeSegments(filePath.slice(0, -".html".length))}`;
  return `/${encodeSegments(filePath)}`;
}

function encodeSegments(value) {
  return value.split("/").map((segment) => encodeURIComponent(segment)).join("/");
}

function digestManifest(files, excludedFiles) {
  const canonical = JSON.stringify({
    protocol: MANIFEST_PROTOCOL,
    directory: MANIFEST_DIRECTORY,
    excluded_routing_files: excludedFiles,
    files: files.map(({ path: filePath, bytes, sha256 }) => ({ path: filePath, bytes, sha256 })),
  });
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

function parseExactOrigin(value) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("Deployment asset origin is invalid");
  }
  if (parsed.protocol !== "https:" || parsed.origin !== value || parsed.username || parsed.password ||
      parsed.pathname !== "/" || parsed.search || parsed.hash) {
    throw new Error("Deployment asset origin is invalid");
  }
  return parsed.origin;
}

function compareCodePoints(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
