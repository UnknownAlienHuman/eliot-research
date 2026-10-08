import { createHash } from "node:crypto";
import { lstat, realpath, readFile } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

const PROTOCOL = "eliotr.maintenance-route-update.v1";
const ROUTE_KEYS = Object.freeze(["method", "path", "operation", "auth", "maximum_request_bytes", "response_mode"]);
const INTENT_KEYS = Object.freeze(["protocol", "account_id", "hostname", "baseline", "candidate",
  "baseline_routes", "candidate_routes", "added_routes", "changed_routes", "service_principals"]);
const BASELINE_KEYS = Object.freeze(["deployment_id", "version_id", "generation", "routes_sha256"]);
const CANDIDATE_KEYS = Object.freeze(["source_head", "generation", "routes_sha256"]);
const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/iu;
const ACCOUNT_ID = /^[A-Za-z0-9_-]{1,64}$/u;
const SOURCE_HEAD = /^[0-9a-f]{40}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const HOST_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u;
const HOSTNAME = /^(?=.{1,253}$)[a-z0-9.-]+$/u;
const AUTH = new Set(["public", "owner", "service", "owner_or_service"]);
const ADD_AUTH = new Set(["owner", "service", "owner_or_service"]);
const RESPONSE_MODE = new Set(["json", "stream", "handle", "redirect"]);
const METHODS = new Set(["GET", "POST", "PUT", "DELETE"]);
const MAX_INTENT_BYTES = 2 * 1024 * 1024;
const MAX_ROUTES = 512;
const VALIDATED = new WeakSet();
const PRIVATE = new WeakMap();
const fail = (message = "Maintenance route update intent is invalid") => { throw new Error(message); };
const isRecord = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const bounded = (value, maximum = 1024) => typeof value === "string" && value.length > 0 && value.length <= maximum &&
  !/[\u0000-\u0020\u007f]/u.test(value);

/** Load and validate one exact, ignored MAINTENANCE route-update intent. */
export async function loadMaintenanceRouteUpdate({ path, root, sourceHead, candidateGeneration, accountId,
  hostname, activeWorkerIdentity, candidateRoutes, observedRoutes, read = readFile } = {}) {
  if (typeof read !== "function" || !validPathInput(root) || !validPathInput(path) ||
      !SOURCE_HEAD.test(sourceHead ?? "") || candidateGeneration !== `git-${sourceHead.slice(0, 12)}` ||
      !ACCOUNT_ID.test(accountId ?? "") || !validHostname(hostname) || !isRecord(activeWorkerIdentity) ||
      activeWorkerIdentity.worker_id !== "eliotr-core" || !UUID.test(activeWorkerIdentity.deployment_id ?? "") ||
      !UUID.test(activeWorkerIdentity.version_id ?? "") || !bounded(activeWorkerIdentity.generation, 256) ||
      activeWorkerIdentity.access_service_principals !== "") {
    fail("Maintenance route update requires pinned source, Worker identity and empty service principals");
  }

  const file = await readIntentFile({ path, root, read });
  const parsed = parseIntent(file.bytes);
  exactKeys(parsed, INTENT_KEYS, "Maintenance route update intent fields are invalid");
  if (parsed.protocol !== PROTOCOL || parsed.account_id !== accountId || parsed.hostname !== hostname ||
      parsed.service_principals !== "") {
    fail("Maintenance route update intent identity or service-principal pin is invalid");
  }
  exactKeys(parsed.baseline, BASELINE_KEYS, "Maintenance route update baseline fields are invalid");
  exactKeys(parsed.candidate, CANDIDATE_KEYS, "Maintenance route update candidate fields are invalid");
  if (!SHA256.test(parsed.baseline.routes_sha256 ?? "") || !SHA256.test(parsed.candidate.routes_sha256 ?? "")) {
    fail("Maintenance route update route digests must be lowercase SHA-256 values");
  }

  const baselineRoutes = normalizeRoutes(parsed.baseline_routes);
  const declaredCandidateRoutes = normalizeRoutes(parsed.candidate_routes);
  const actualCandidateRoutes = normalizeRoutes(candidateRoutes);
  const actualObservedRoutes = normalizeRoutes(observedRoutes);
  const addedRoutes = normalizeRoutes(parsed.added_routes, { allowEmpty: true });
  const changedRoutes = normalizeChangedRoutes(parsed.changed_routes);

  if (parsed.baseline.deployment_id !== activeWorkerIdentity.deployment_id ||
      parsed.baseline.version_id !== activeWorkerIdentity.version_id ||
      parsed.baseline.generation !== activeWorkerIdentity.generation ||
      parsed.candidate.source_head !== sourceHead || parsed.candidate.generation !== candidateGeneration ||
      baselineRoutes.length !== actualObservedRoutes.length || !sameJson(baselineRoutes, actualObservedRoutes) ||
      declaredCandidateRoutes.length !== actualCandidateRoutes.length || !sameJson(declaredCandidateRoutes, actualCandidateRoutes) ||
      parsed.baseline.routes_sha256 !== routeDigest(actualObservedRoutes) ||
      parsed.candidate.routes_sha256 !== routeDigest(actualCandidateRoutes)) {
    fail("Maintenance route update intent does not pin the exact live baseline and candidate");
  }

  const delta = routeDelta(baselineRoutes, actualCandidateRoutes);
  if (delta.removed.length !== 0 || delta.added.length + delta.changed.length === 0 ||
      !sameJson(addedRoutes, delta.added) || !sameJson(changedRoutes, delta.changed)) {
    fail("Maintenance route update intent does not declare the exact permitted route delta");
  }

  const routeUpdate = deepFreeze({
    protocol: parsed.protocol,
    account_id: parsed.account_id,
    hostname: parsed.hostname,
    baseline: { ...parsed.baseline },
    candidate: { ...parsed.candidate },
    baseline_routes: baselineRoutes,
    candidate_routes: actualCandidateRoutes,
    added_routes: delta.added,
    changed_routes: delta.changed,
    service_principals: "",
    intent_sha256: file.sha256,
  });
  VALIDATED.add(routeUpdate);
  PRIVATE.set(routeUpdate, { path: file.path, root: file.root, read, intentSha256: file.sha256 });
  return routeUpdate;
}

/** Re-read the original regular file and verify its bytes have not changed since load. */
export async function requireUnchangedMaintenanceRouteUpdate({ routeUpdate } = {}) {
  const privateState = requireValidated(routeUpdate);
  const file = await readIntentFile({ path: privateState.path, root: privateState.root, read: privateState.read });
  if (file.sha256 !== privateState.intentSha256 || file.sha256 !== routeUpdate.intent_sha256) {
    fail("Maintenance route update intent bytes changed during deployment");
  }
  return Object.freeze({ state: "PASS", intent_sha256: file.sha256 });
}

/** Require the exact planned route surface immediately before or after deployment. */
export function assertRouteUpdateProfile({ routeUpdate, candidateRoutes, observedRoutes, phase } = {}) {
  requireValidated(routeUpdate);
  if (phase !== "before" && phase !== "after") fail("Maintenance route update phase is invalid");
  const candidate = normalizeRoutes(candidateRoutes);
  const observed = normalizeRoutes(observedRoutes);
  if (!sameJson(candidate, routeUpdate.candidate_routes)) {
    fail("Maintenance route update candidate differs from the pinned source profile");
  }
  const expectedObserved = phase === "before" ? routeUpdate.baseline_routes : routeUpdate.candidate_routes;
  if (!sameJson(observed, expectedObserved)) {
    fail(`Maintenance route update ${phase} readback differs from its pinned route surface`);
  }
  return Object.freeze({ state: "PASS", phase, intent_sha256: routeUpdate.intent_sha256,
    baseline_routes_sha256: routeUpdate.baseline.routes_sha256,
    candidate_routes_sha256: routeUpdate.candidate.routes_sha256,
    added_routes: routeUpdate.added_routes.length, changed_routes: routeUpdate.changed_routes.length });
}

/** Compare the preserved route baseline with the exact post-deployment candidate readback. */
export function assertRouteUpdateReadback({ routeUpdate, baselineRoutes, currentRoutes } = {}) {
  requireValidated(routeUpdate);
  const baseline = normalizeRoutes(baselineRoutes);
  const current = normalizeRoutes(currentRoutes);
  if (!sameJson(baseline, routeUpdate.baseline_routes) || !sameJson(current, routeUpdate.candidate_routes)) {
    fail("Maintenance route update readback differs from the pinned baseline or candidate");
  }
  return Object.freeze({ state: "PASS", intent_sha256: routeUpdate.intent_sha256,
    baseline_routes_sha256: routeUpdate.baseline.routes_sha256,
    current_routes_sha256: routeUpdate.candidate.routes_sha256 });
}

function requireValidated(routeUpdate) {
  if (!isRecord(routeUpdate) || !VALIDATED.has(routeUpdate) || !PRIVATE.has(routeUpdate)) {
    fail("Maintenance route update was not loaded and validated by this module");
  }
  return PRIVATE.get(routeUpdate);
}

async function readIntentFile({ path, root, read }) {
  let rootPath;
  let statePath;
  let target;
  let relativePath;
  try {
    rootPath = await realpath(resolve(root));
    statePath = resolve(rootPath, ".eliotr-state");
    target = isAbsolute(path) ? resolve(path) : resolve(rootPath, path);
    relativePath = relative(statePath, target);
  } catch {
    fail("Maintenance route update file path is invalid");
  }
  if (!relativePath || relativePath === ".." || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath) ||
      relativePath.split(sep).some((part) => !part || part === "." || part === ".." ||
        /[\u0000-\u001f<>:"|?*]/u.test(part) || /[. ]$/u.test(part))) {
    fail("Maintenance route update file must be strictly under the repository .eliotr-state directory");
  }

  const statBefore = await inspectRegularFilePath(rootPath, statePath, target, relativePath);
  if (statBefore.size < 1 || statBefore.size > MAX_INTENT_BYTES) {
    fail("Maintenance route update file exceeds its size bound");
  }
  let content;
  try { content = await read(target); } catch { fail("Maintenance route update file is unreadable"); }
  const bytes = copyBytes(content);
  const statAfter = await inspectRegularFilePath(rootPath, statePath, target, relativePath);
  if (bytes.length !== statBefore.size || bytes.length !== statAfter.size ||
      !sameFileIdentity(statBefore, statAfter) || bytes.length > MAX_INTENT_BYTES) {
    fail("Maintenance route update file changed while being read");
  }
  return { path: target, root: rootPath, bytes, sha256: sha256(bytes) };
}

async function inspectRegularFilePath(rootPath, statePath, target, relativePath) {
  try {
    const rootStat = await lstat(rootPath);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) fail("Repository root is not a regular directory");
    let directory = statePath;
    const stateStat = await lstat(directory);
    if (!stateStat.isDirectory() || stateStat.isSymbolicLink()) fail("Repository state directory is not a regular directory");
    const parts = relativePath.split(sep);
    for (const part of parts.slice(0, -1)) {
      directory = resolve(directory, part);
      const directoryStat = await lstat(directory);
      if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) {
        fail("Maintenance route update path contains a symlink or non-directory");
      }
    }
    const before = await lstat(target);
    if (!before.isFile() || before.isSymbolicLink()) fail("Maintenance route update must be a regular file");
    const canonicalState = await realpath(statePath);
    const canonicalTarget = await realpath(target);
    const canonicalRelative = relative(canonicalState, canonicalTarget);
    if (canonicalRelative !== relativePath || canonicalRelative === ".." || canonicalRelative.startsWith(`..${sep}`)) {
      fail("Maintenance route update path resolves outside .eliotr-state");
    }
    return before;
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Maintenance route update")) throw error;
    fail("Maintenance route update path is missing or contains a symlink");
  }
}

function parseIntent(bytes) {
  let text;
  let parsed;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    parsed = JSON.parse(text);
    assertNoDuplicateJsonKeys(text);
  } catch {
    fail("Maintenance route update intent is not strict UTF-8 JSON");
  }
  return parsed;
}

function assertNoDuplicateJsonKeys(text) {
  let cursor = 0;
  const whitespace = () => { while (/\s/u.test(text[cursor] ?? "")) cursor += 1; };
  const string = () => {
    const start = cursor;
    cursor += 1;
    while (cursor < text.length) {
      if (text[cursor] === "\\") { cursor += 2; continue; }
      if (text[cursor] === '"') { cursor += 1; return JSON.parse(text.slice(start, cursor)); }
      cursor += 1;
    }
    fail("Maintenance route update JSON string is invalid");
  };
  const value = (depth = 0) => {
    if (depth > 16) fail("Maintenance route update JSON nesting is excessive");
    whitespace();
    if (text[cursor] === "{") {
      cursor += 1;
      whitespace();
      const keys = new Set();
      if (text[cursor] === "}") { cursor += 1; return; }
      while (cursor < text.length) {
        whitespace();
        if (text[cursor] !== '"') fail("Maintenance route update JSON object key is invalid");
        const key = string();
        if (keys.has(key)) fail("Maintenance route update JSON contains duplicate fields");
        keys.add(key);
        whitespace();
        cursor += 1;
        value(depth + 1);
        whitespace();
        if (text[cursor] === "}") { cursor += 1; return; }
        cursor += 1;
      }
      fail("Maintenance route update JSON object is invalid");
    }
    if (text[cursor] === "[") {
      cursor += 1;
      whitespace();
      if (text[cursor] === "]") { cursor += 1; return; }
      while (cursor < text.length) {
        value(depth + 1);
        whitespace();
        if (text[cursor] === "]") { cursor += 1; return; }
        cursor += 1;
      }
      fail("Maintenance route update JSON array is invalid");
    }
    if (text[cursor] === '"') { string(); return; }
    while (cursor < text.length && !/[\s,\]}]/u.test(text[cursor])) cursor += 1;
  };
  value();
  whitespace();
  if (cursor !== text.length) fail("Maintenance route update JSON has trailing data");
}

function normalizeRoutes(routes, { allowEmpty = false } = {}) {
  if (!Array.isArray(routes) || routes.length > MAX_ROUTES || (!allowEmpty && routes.length === 0)) {
    fail("Maintenance route update route list is invalid");
  }
  const normalized = routes.map(normalizeRoute);
  const identities = normalized.map(routeIdentity);
  if (new Set(identities).size !== identities.length) fail("Maintenance route update route list contains duplicates");
  return normalized.sort(compareRoutes);
}

function normalizeRoute(route) {
  exactKeys(route, ROUTE_KEYS, "Maintenance route update route entry fields are invalid");
  if (!METHODS.has(route.method) || !bounded(route.path) || !bounded(route.operation, 256) ||
      !AUTH.has(route.auth) || !Number.isSafeInteger(route.maximum_request_bytes) || route.maximum_request_bytes < 0 ||
      !RESPONSE_MODE.has(route.response_mode)) {
    fail("Maintenance route update route entry is invalid");
  }
  return Object.fromEntries(ROUTE_KEYS.map((key) => [key, route[key]]));
}

function normalizeChangedRoutes(routes) {
  if (!Array.isArray(routes) || routes.length > MAX_ROUTES) fail("Maintenance route update changes are invalid");
  const normalized = routes.map((entry) => {
    exactKeys(entry, ["before", "after"], "Maintenance route update change fields are invalid");
    const before = normalizeRoute(entry.before);
    const after = normalizeRoute(entry.after);
    if (routeIdentity(before) !== routeIdentity(after) || before.auth !== "owner" || after.auth !== "owner_or_service" ||
        !sameJson(withoutAuth(before), withoutAuth(after))) {
      fail("Maintenance route update changes may only widen owner auth to owner_or_service");
    }
    return { before, after };
  });
  return normalized.sort((left, right) => compareRoutes(left.before, right.before));
}

function routeDelta(baseline, candidate) {
  const beforeById = new Map(baseline.map((route) => [routeIdentity(route), route]));
  const afterById = new Map(candidate.map((route) => [routeIdentity(route), route]));
  const removed = [...beforeById.keys()].filter((key) => !afterById.has(key)).sort();
  const added = candidate.filter((route) => !beforeById.has(routeIdentity(route)));
  const changed = [];
  for (const [key, before] of beforeById) {
    const after = afterById.get(key);
    if (after && !sameJson(before, after)) {
      if (before.auth !== "owner" || after.auth !== "owner_or_service" ||
          !sameJson(withoutAuth(before), withoutAuth(after))) {
        fail("Maintenance route update contains an unapproved route change");
      }
      changed.push({ before, after });
    }
  }
  for (const route of added) {
    if (!ADD_AUTH.has(route.auth)) fail("Maintenance route update cannot add a public route");
  }
  return { removed, added: added.sort(compareRoutes),
    changed: changed.sort((left, right) => compareRoutes(left.before, right.before)) };
}

function exactKeys(value, expectedKeys, message) {
  if (!isRecord(value)) fail(message);
  const keys = Reflect.ownKeys(value);
  if (keys.length !== expectedKeys.length || keys.some((key) => typeof key !== "string" || !expectedKeys.includes(key))) {
    fail(message);
  }
}

function validHostname(value) {
  if (typeof value !== "string" || !HOSTNAME.test(value) || value !== value.toLowerCase()) return false;
  const labels = value.split(".");
  return labels.length >= 2 && labels.every((label) => label.length <= 63 && HOST_LABEL.test(label));
}

function validPathInput(value) {
  return typeof value === "string" && value.length > 0 && value.length <= 4096 &&
    !/[\u0000-\u001f\u007f]/u.test(value);
}

function routeIdentity(route) { return `${route.method}\n${route.path}`; }
function compareRoutes(left, right) {
  const leftKey = routeIdentity(left);
  const rightKey = routeIdentity(right);
  return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
}
function withoutAuth(route) {
  return Object.fromEntries(ROUTE_KEYS.filter((key) => key !== "auth").map((key) => [key, route[key]]));
}
function routeDigest(routes) { return sha256(Buffer.from(JSON.stringify(routes), "utf8")); }
function sha256(bytes) { return createHash("sha256").update(bytes).digest("hex"); }
function sameJson(left, right) { return JSON.stringify(left) === JSON.stringify(right); }
function copyBytes(value) {
  if (Buffer.isBuffer(value)) return Buffer.from(value);
  if (value instanceof Uint8Array) return Buffer.from(value);
  fail("Maintenance route update file reader returned invalid bytes");
}
function sameFileIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}
function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const key of Reflect.ownKeys(value)) deepFreeze(value[key]);
    Object.freeze(value);
  }
  return value;
}
