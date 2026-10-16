import { createHash, randomBytes, randomUUID } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { lstat, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const WORKER = "apps/eliotr-web/dist/eliotr_core";
const GENERATED = "apps/eliotr-core/wrangler.deploy.jsonc";
const CLIENT = "apps/eliotr-web/dist/client";
const VERSION = "4.143.1";
const SCOPE = "LOCAL_PREPARED_WORKER_ROUTE_DENIAL_AND_STATIC_BYTES_ONLY";
const MAX_BODY = 2 * 1024 * 1024, MAX_LOG = 256 * 1024;
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const samePath = (left, right) => process.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right;
const fail = code => { throw new Error("Owner-web native routes: " + code); };

function within(promise, timeout, code) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Owner-web native routes: " + code)), Math.max(1, timeout));
    Promise.resolve(promise).then(resolve, reject).finally(() => clearTimeout(timer));
  });
}

async function file(root, relative, limit = MAX_BODY) {
  const absolute = path.resolve(root, relative), before = await lstat(absolute);
  if (!before.isFile() || before.isSymbolicLink() || before.size > limit ||
      !samePath(await realpath(absolute), absolute)) fail("UNSAFE_OR_OVERSIZED_INPUT");
  const bytes = await readFile(absolute), after = await lstat(absolute);
  if (before.size !== bytes.length || before.size !== after.size || before.mtimeMs !== after.mtimeMs) fail("INPUT_CHANGED_DURING_READ");
  return { bytes, pin: { path: relative, byte_length: bytes.length, sha256: hash(bytes) } };
}

async function sourceDirectory(directory, code) {
  const info = await lstat(directory).catch(() => null);
  if (!info?.isDirectory() || info.isSymbolicLink() ||
      !samePath(await realpath(directory), directory)) fail(code);
}

// Only a .git entry at the explicit root can authorize discovery. A linked
// worktree must have reciprocal registration in its canonical common directory.
async function sourceLayout(root) {
  await sourceDirectory(root, "SOURCE_ROOT_REDIRECTED");
  const entry = path.join(root, ".git"), info = await lstat(entry).catch(() => null);
  if (!info || info.isSymbolicLink()) fail("SOURCE_GIT_ENTRY_REQUIRED");
  let gitDirectory = entry, commonDirectory = entry;
  const metadata = {};
  if (info.isFile()) {
    const pointer = await file(root, ".git", 4096);
    const match = /^gitdir: ([^\r\n\0]+)\r?\n?$/u.exec(pointer.bytes.toString("utf8"));
    if (!match) fail("INVALID_SOURCE_WORKTREE_LAYOUT");
    gitDirectory = path.resolve(root, match[1]);
    await sourceDirectory(gitDirectory, "INVALID_SOURCE_WORKTREE_LAYOUT");
    const common = await file(gitDirectory, "commondir", 4096);
    const commonPath = /^([^\r\n\0]+)\r?\n?$/u.exec(common.bytes.toString("utf8"));
    if (!commonPath) fail("INVALID_SOURCE_WORKTREE_LAYOUT");
    commonDirectory = path.resolve(gitDirectory, commonPath[1]);
    await sourceDirectory(commonDirectory, "INVALID_SOURCE_WORKTREE_LAYOUT");
    const registrations = path.join(commonDirectory, "worktrees");
    if (!samePath(path.dirname(gitDirectory), registrations)) fail("INVALID_SOURCE_WORKTREE_LAYOUT");
    await sourceDirectory(registrations, "INVALID_SOURCE_WORKTREE_LAYOUT");
    const backlink = await file(gitDirectory, "gitdir", 4096);
    const backPath = /^([^\r\n\0]+)\r?\n?$/u.exec(backlink.bytes.toString("utf8"));
    if (!backPath || !samePath(path.resolve(gitDirectory, backPath[1]), entry)) fail("SOURCE_WORKTREE_BACKLINK_MISMATCH");
    Object.assign(metadata, { pointer: pointer.pin.sha256, commondir: common.pin.sha256, backlink: backlink.pin.sha256 });
  } else if (info.isDirectory()) await sourceDirectory(entry, "INVALID_SOURCE_WORKTREE_LAYOUT");
  else fail("SOURCE_GIT_ENTRY_REQUIRED");
  metadata.head = (await file(gitDirectory, "HEAD", 1024)).pin.sha256;
  return { root, git_directory: gitDirectory, common_directory: commonDirectory, metadata };
}

function sourceGit(root, args) {
  // Ambient Git routing/configuration must never redirect capture to a dirty
  // primary checkout. Disable optional index writes and executable fsmonitors.
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith("GIT_")));
  Object.assign(env, { GIT_OPTIONAL_LOCKS: "0", GIT_CONFIG_NOSYSTEM: "1", GIT_NO_LAZY_FETCH: "1", GIT_TERMINAL_PROMPT: "0",
    GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null" });
  return new Promise((resolve, reject) => execFile("git", ["--no-optional-locks", "--no-replace-objects",
    "-c", "core.fsmonitor=false", "-c", "core.untrackedCache=false", "-C", root, ...args],
  { env, shell: false, windowsHide: true, encoding: "utf8", timeout: 5000, maxBuffer: MAX_BODY }, (error, stdout) => {
    if (error) reject(new Error("Owner-web native routes: SOURCE_GIT_READ_FAILED"));
    else resolve(stdout);
  }));
}

/** Read-only identity of the requested clean checkout, including registered Git worktrees. */
export async function readOwnerWebNativeSourceIdentity(root) {
  root = path.resolve(root);
  const before = await sourceLayout(root);
  const facts = (await sourceGit(root, ["rev-parse", "--path-format=absolute", "--git-dir", "--git-common-dir",
    "--show-toplevel", "--is-inside-work-tree", "--is-bare-repository"])).trim().split(/\r?\n/u);
  if (facts.length !== 5 || !samePath(path.resolve(facts[0]), before.git_directory) ||
      !samePath(path.resolve(facts[1]), before.common_directory) || !samePath(path.resolve(facts[2]), root) ||
      facts[3] !== "true" || facts[4] !== "false") fail("SOURCE_WORKTREE_IDENTITY_MISMATCH");
  const head = (await sourceGit(root, ["rev-parse", "--verify", "HEAD^{commit}"])).trim();
  if (!/^[a-f0-9]{40}$/u.test(head)) fail("INVALID_SOURCE_HEAD");
  const index = await sourceGit(root, ["ls-files", "-v", "-z"]);
  if (index.split("\0").some(record => /^[a-zS] /u.test(record))) fail("SOURCE_INDEX_FLAGS_UNSUPPORTED");
  if (await sourceGit(root, ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--ignore-submodules=none"])) {
    fail("DIRTY_SOURCE_WORKTREE");
  }
  const after = await sourceLayout(root);
  if (JSON.stringify(before) !== JSON.stringify(after) ||
      (await sourceGit(root, ["rev-parse", "--verify", "HEAD^{commit}"])).trim() !== head) fail("SOURCE_REPOSITORY_CHANGED");
  return { ...before, source_head: head };
}

async function inputs(root) {
  const sourceIdentity = await readOwnerWebNativeSourceIdentity(root);
  const records = {};
  for (const [key, relative, limit] of [
    ["generated_config", GENERATED, MAX_BODY], ["emitted_config", WORKER + "/wrangler.json", MAX_BODY],
    ["entrypoint", WORKER + "/index.js", 32 * 1024 * 1024],
    ["tombstone", CLIENT + "/sw.js", MAX_BODY], ["inbox", CLIENT + "/agent-inbox/index.html", MAX_BODY],
    ["headers", CLIENT + "/_headers", MAX_BODY],
    ["wrangler_package", "node_modules/wrangler/package.json", MAX_BODY],
    ["wrangler_entry", "node_modules/wrangler/bin/wrangler.js", MAX_BODY],
  ]) {
    // Installed package symlinks are expected; pin their resolved bytes without permitting source-output links.
    if (key.startsWith("wrangler_")) {
      const actual = await realpath(path.resolve(root, relative));
      const info = await lstat(actual);
      if (!info.isFile() || info.size > limit) fail("INVALID_INSTALLED_WRANGLER");
      const bytes = await readFile(actual);
      records[key] = { bytes, pin: { path: relative, byte_length: bytes.length, sha256: hash(bytes) } };
    } else records[key] = await file(root, relative, limit);
  }
  const pkg = JSON.parse(records.wrangler_package.bytes.toString("utf8"));
  const config = JSON.parse(records.emitted_config.bytes.toString("utf8"));
  const generated = JSON.parse(records.generated_config.bytes.toString("utf8"));
  const expected = path.resolve(root, GENERATED);
  if (pkg.name !== "wrangler" || pkg.version !== VERSION || config.name !== "eliotr-core" ||
      config.main !== "index.js" || config.no_bundle !== true || config.targetEnvironment !== undefined ||
      !samePath(path.resolve(config.configPath ?? ""), expected) || !samePath(path.resolve(config.userConfigPath ?? ""), expected) ||
      config.assets?.directory !== "../client" || config.assets?.binding !== "ASSETS" ||
      generated.assets?.directory !== "../eliotr-web/dist/client" || generated.name !== "eliotr-core" ||
      (config.build && Object.keys(config.build).length) || config.hooks !== undefined) fail("PREPARED_PRODUCTION_CONFIG_REQUIRED");
  const first = config.assets.run_worker_first;
  if (!Array.isArray(first) || !["/agents", "/agents/*", "/agent-inbox", "/agent-inbox/*"].every(route => first.includes(route))) {
    fail("WORKER_FIRST_ROUTE_GUARDS_MISSING");
  }
  const html = records.inbox.bytes.toString("utf8");
  if (!html.includes("No task loaded.") || !html.includes("No dispatch loaded.") ||
      !html.includes("/agent-inbox/retirement.js") || !html.includes("/agent-inbox/app.js")) fail("IDLE_INBOX_ENTRY_MISSING");
  return { records, source_head: sourceIdentity.source_head, source_identity: sourceIdentity };
}

function localEnvironment(environment, logs) {
  const allowed = new Set(["PATH", "PATHEXT", "SYSTEMROOT", "WINDIR", "COMSPEC", "TEMP", "TMP",
    "USERPROFILE", "HOME", "HOMEDRIVE", "HOMEPATH", "LOCALAPPDATA", "APPDATA", "PROGRAMFILES",
    "PROGRAMFILES(X86)", "PROGRAMW6432", "LANG", "LC_ALL"]);
  return { ...Object.fromEntries(Object.entries(environment).filter(([key]) => allowed.has(key.toUpperCase()))),
    CI: "true", FORCE_COLOR: "0", NO_COLOR: "1", WRANGLER_SEND_METRICS: "false", WRANGLER_LOG_PATH: logs };
}

function get(origin, pathname, upgrade, timeout) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const headers = upgrade ? { Accept: "application/json", Connection: "Upgrade", Upgrade: "websocket",
      "Sec-WebSocket-Version": "13", "Sec-WebSocket-Key": randomBytes(16).toString("base64"), Origin: origin }
      : { Accept: pathname === "/sw.js" ? "application/javascript" : pathname === "/agent-inbox/" ? "text/html" : "application/json" };
    const finish = (error, result) => { if (settled) return; settled = true; clearTimeout(timer); if (error) reject(error); else resolve(result); };
    const request = httpRequest(origin + pathname, { method: "GET", headers, agent: false, maxHeaderSize: 16 * 1024 }, response => {
      let length = 0; const chunks = [];
      response.on("data", chunk => {
        length += chunk.length;
        if (length > MAX_BODY) { request.destroy(); finish(new Error("Owner-web native routes: RESPONSE_BODY_LIMIT")); }
        else chunks.push(chunk);
      });
      response.on("error", () => finish(new Error("Owner-web native routes: RESPONSE_STREAM_FAILED")));
      response.on("aborted", () => finish(new Error("Owner-web native routes: RESPONSE_ABORTED")));
      response.on("end", () => finish(null, { status: response.statusCode, headers: response.headers, bytes: Buffer.concat(chunks) }));
    });
    const timer = setTimeout(() => { request.destroy(); finish(new Error("Owner-web native routes: REQUEST_DEADLINE")); }, timeout);
    request.on("upgrade", (_response, socket) => { socket.destroy(); finish(new Error("Owner-web native routes: UNAUTHORIZED_WEBSOCKET_UPGRADE")); });
    request.on("error", () => finish(new Error("Owner-web native routes: REQUEST_FAILED")));
    request.end();
  });
}

async function stopOwned(child, closed, remaining) {
  if (!child) return;
  if (child.exitCode === null && child.signalCode === null && Number.isSafeInteger(child.pid)) {
    if (process.platform === "win32") {
      const binary = path.join(process.env.SystemRoot ?? "C:/Windows", "System32/taskkill.exe");
      await new Promise((resolve, reject) => execFile(binary, ["/PID", String(child.pid), "/T", "/F"],
        { shell: false, windowsHide: true, timeout: Math.min(4000, remaining()), maxBuffer: 4096 }, error => {
          if (error && child.exitCode === null && child.signalCode === null) reject(new Error("Owner-web native routes: PROCESS_TREE_SHUTDOWN_FAILED"));
          else resolve();
        }));
    } else {
      try { process.kill(-child.pid, "SIGTERM"); } catch (error) { if (error.code !== "ESRCH") throw error; }
    }
  }
  try { await within(closed, Math.min(3000, remaining()), "PROCESS_CLOSE_DEADLINE"); }
  catch (error) {
    if (process.platform !== "win32" && child.pid) {
      try { process.kill(-child.pid, "SIGKILL"); } catch (killError) { if (killError.code !== "ESRCH") throw killError; }
      await within(closed, Math.min(2000, remaining()), "PROCESS_FORCE_CLOSE_DEADLINE");
    } else throw error;
  }
}

/** Root-only execution: the unchanged production graph runs locally, without build or remote bindings. */
export async function assertOwnerWebNativeRoutes({ root, environment }) {
  root = path.resolve(root);
  const started = Date.now(), deadline = started + 55_000, workDeadline = deadline - 10_000;
  const remaining = () => Math.max(1, deadline - Date.now());
  const workRemaining = () => { if (Date.now() >= workDeadline) fail("NATIVE_OBSERVATION_DEADLINE"); return workDeadline - Date.now(); };
  const uuid = randomUUID(), state = path.resolve(root, ".eliotr-state/owner-web-native-state-" + uuid);
  const receiptPath = ".eliotr-state/owner-web-native-routes-" + uuid + ".json";
  let before, child, closed, origin, childFailure, failure = null, args;
  const results = [], log = { stdout: { bytes: 0, digest: createHash("sha256"), tail: "" },
    stderr: { bytes: 0, digest: createHash("sha256"), tail: "" } };
  const recordLog = (channel, chunk) => {
    const item = log[channel]; item.bytes += chunk.length; item.digest.update(chunk);
    if (item.bytes > MAX_LOG) childFailure = "PROCESS_LOG_LIMIT";
    item.tail = (item.tail + chunk.toString("utf8").replace(/\u001b\[[0-9;]*m/gu, "")).slice(-8192);
    for (const match of item.tail.matchAll(/\bReady on (http:\/\/127\.0\.0\.1:([0-9]{1,5}))(?:\/)?(?=\s|$)/gu)) {
      const port = Number(match[2]);
      if (port < 1 || port > 65535 || (origin && origin !== match[1])) childFailure = "AMBIGUOUS_PROCESS_READY";
      else origin = match[1];
    }
  };
  try {
    before = await within(inputs(root), workRemaining(), "INPUT_READ_DEADLINE");
    await within(mkdir(state, { recursive: true }), workRemaining(), "LOCAL_STATE_DEADLINE");
    args = [path.resolve(root, "node_modules/wrangler/bin/wrangler.js"), "dev", "--config", path.resolve(root, WORKER, "wrangler.json"),
      "--local", "--no-bundle", "--ip", "127.0.0.1", "--port", "0", "--inspector-ip", "127.0.0.1", "--inspector-port", "0",
      "--local-protocol", "http", "--persist-to", state, "--no-live-reload", "--no-show-interactive-dev-session", "--no-types", "--no-enable-containers", "--no-tunnel"];
    child = spawn(process.execPath, args, { cwd: root, env: localEnvironment(environment, path.join(state, "logs")),
      shell: false, windowsHide: true, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"] });
    child.on("error", () => { childFailure = "PROCESS_SPAWN_FAILED"; });
    closed = new Promise(resolve => child.once("close", (code, signal) => resolve({ code, signal })));
    child.stdout.on("data", chunk => recordLog("stdout", chunk));
    child.stderr.on("data", chunk => recordLog("stderr", chunk));
    while (!origin) {
      workRemaining();
      if (childFailure || child.exitCode !== null || child.signalCode !== null) fail(childFailure ?? "PROCESS_EXIT_BEFORE_READY");
      await delay(50);
    }
    for (const [pathname, upgrade, expectedStatus, expectedType] of [
      ["/agents", false, 404, "json"], ["/agents/research-session/probe", false, 401, "json"],
      ["/agents/research-session/probe", true, 401, "json"], ["/sw.js", false, 200, "javascript"], ["/agent-inbox/", false, 200, "html"],
    ]) {
      if (childFailure || child.exitCode !== null || child.signalCode !== null) fail(childFailure ?? "PROCESS_EXIT_DURING_PROBES");
      const response = await get(origin, pathname, upgrade, Math.min(4000, workRemaining()));
      const contentType = String(response.headers["content-type"] ?? ""), csp = String(response.headers["content-security-policy"] ?? "");
      const result = { path: pathname, upgrade, status: response.status, content_type: contentType,
        body_sha256: hash(response.bytes), byte_length: response.bytes.length, checks: [] };
      results.push(result);
      if (response.status !== expectedStatus) fail("UNEXPECTED_NATIVE_STATUS");
      if (expectedType === "json") {
        if (!/^application\/(?:problem\+)?json(?:;|$)/iu.test(contentType)) fail("DENIAL_IS_NOT_JSON");
        const data = JSON.parse(response.bytes.toString("utf8"));
        if (!data || typeof data !== "object" || Array.isArray(data) ||
            (data.status !== undefined && data.status !== expectedStatus)) fail("INVALID_DENIAL_JSON");
        result.checks.push("EXPECTED_JSON_DENIAL", ...(upgrade ? ["NO_WEBSOCKET_UPGRADE"] : []));
      } else if (expectedType === "javascript") {
        if (!/^(?:application|text)\/(?:javascript|ecmascript)(?:;|$)/iu.test(contentType) ||
            !response.bytes.equals(before.records.tombstone.bytes) ||
            (response.headers["service-worker-allowed"] !== undefined && response.headers["service-worker-allowed"] !== "/") ||
            !["no-cache", "max-age=0"].every(expected => String(response.headers["cache-control"] ?? "")
              .split(",").some(value => value.trim().toLowerCase() === expected))) fail("TOMBSTONE_BYTES_OR_HEADERS_DIFFER");
        result.service_worker_allowed = response.headers["service-worker-allowed"] ?? "DEFAULT_ROOT_SCOPE_FOR_SW_JS";
        result.cache_control = String(response.headers["cache-control"]);
        result.checks.push("EXACT_EMITTED_TOMBSTONE", "ROOT_SCOPE", "NO_CACHE_MAX_AGE_ZERO");
      } else {
        if (!/^text\/html(?:;|$)/iu.test(contentType) || !response.bytes.equals(before.records.inbox.bytes) ||
            !csp || /unsafe-inline/iu.test(csp) || !/\bscript-src\s+'self'(?:\s|;|$)/iu.test(csp)) fail("INBOX_BYTES_OR_CSP_DIFFER");
        result.csp_sha256 = hash(Buffer.from(csp));
        result.checks.push("EXACT_EMITTED_IDLE_INBOX_HTML", "CSP_WITHOUT_UNSAFE_INLINE");
      }
      result.state = "PASS";
    }
    const after = await within(inputs(root), workRemaining(), "INPUT_REREAD_DEADLINE");
    if (JSON.stringify(after.source_identity) !== JSON.stringify(before.source_identity) || Object.keys(before.records).some(key =>
      JSON.stringify(before.records[key].pin) !== JSON.stringify(after.records[key].pin))) fail("SOURCE_OR_PREPARED_BYTES_CHANGED");
  } catch (error) {
    failure = /^Owner-web native routes: [A-Z_]+$/u.test(error.message ?? "") ? error.message : "Owner-web native routes: OBSERVATION_FAILED";
  } finally {
    try { await stopOwned(child, closed, remaining); }
    catch { failure = "Owner-web native routes: PROCESS_SHUTDOWN_NOT_CONFIRMED"; }
  }
  if (Date.now() >= deadline) failure = "Owner-web native routes: TOTAL_55_SECOND_DEADLINE";
  if (failure) {
    await mkdir(state, { recursive: true });
    await Promise.all([
      writeFile(path.join(state, "stdout-tail.txt"), log.stdout.tail),
      writeFile(path.join(state, "stderr-tail.txt"), log.stderr.tail),
    ]);
  }
  const receipt = { protocol: "eliotr.owner-web-native-routes.v1", state: failure ? "FAIL" : "PASS", scope: SCOPE,
    source_head: before?.source_head ?? null, started_at: new Date(started).toISOString(), finished_at: new Date().toISOString(),
    pins: before ? Object.fromEntries(Object.entries(before.records).map(([key, value]) => [key, value.pin])) : {},
    wrangler_version: VERSION, process: { pid: child?.pid ?? null, origin: origin ?? null, ready_from_owned_process: Boolean(origin),
      argv: args ?? [], local: true, no_bundle: true, shutdown_confirmed: child ? child.exitCode !== null || child.signalCode !== null : true,
      stdout_bytes: log.stdout.bytes, stdout_sha256: log.stdout.digest.digest("hex"),
      stderr_bytes: log.stderr.bytes, stderr_sha256: log.stderr.digest.digest("hex") },
    routes: results, failure, limits: "No authenticated service readiness, browser execution, deployment or live cutover qualification" };
  await within(mkdir(path.resolve(root, ".eliotr-state"), { recursive: true }), remaining(), "RECEIPT_DIRECTORY_DEADLINE");
  const bytes = Buffer.from(JSON.stringify(receipt, null, 2) + "\n");
  await within(writeFile(path.resolve(root, receiptPath), bytes, { flag: "wx" }), remaining(), "RECEIPT_WRITE_DEADLINE");
  const evidence = { path: receiptPath, byte_length: bytes.length, sha256: hash(bytes) };
  if (failure) { const error = new Error(failure); error.evidence = evidence; throw error; }
  return { state: "PASS", scope: SCOPE, evidence };
}
