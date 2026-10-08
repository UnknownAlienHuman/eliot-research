import { createHash } from "node:crypto";
import { lstat, realpath, readFile } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

const PROTOCOL = "eliotr.maintenance-ai-search-binding-bootstrap.v1";
const INTENT_KEYS = Object.freeze(["protocol", "account_id", "worker_id", "binding", "baseline", "candidate",
  "manifest_sha256"]);
const BINDING_KEYS = Object.freeze(["name", "type", "namespace", "remote"]);
const BASELINE_KEYS = Object.freeze(["deployment_id", "version_id", "generation", "configuration_sha256"]);
const CANDIDATE_KEYS = Object.freeze(["source_head", "generation", "configuration_sha256"]);
const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/iu;
const ACCOUNT = /^[A-Za-z0-9_-]{1,64}$/u;
const SOURCE_HEAD = /^[0-9a-f]{40}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const MAX_INTENT_BYTES = 16 * 1024;
const MAX_MANIFEST_BYTES = 64 * 1024;
const VALIDATED = new WeakSet();
const PRIVATE = new WeakMap();
const fail = (message) => { throw new Error(message); };
const isRecord = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

/** Load an exact maintenance-only intent for the single AI_SEARCH namespace binding. */
export async function loadMaintenanceAiSearchBootstrap({ path, root, accountId, sourceHead, candidateGeneration,
  candidateConfigurationSha256, candidateConfig, candidateCapabilities, activeWorkerIdentity,
  baselineConfigurationBaseline, baselineConfig, read = readFile } = {}) {
  if (typeof read !== "function" || !validPathInput(root) || !validPathInput(path) ||
      !ACCOUNT.test(accountId ?? "") || !SOURCE_HEAD.test(sourceHead ?? "") ||
      candidateGeneration !== `git-${sourceHead.slice(0, 12)}` || !SHA256.test(candidateConfigurationSha256 ?? "") ||
      !isRecord(candidateConfig) || !isRecord(candidateCapabilities) || !isRecord(activeWorkerIdentity) ||
      !isRecord(baselineConfigurationBaseline) || !isRecord(baselineConfig)) {
    fail("AI Search binding bootstrap requires pinned account, source, Worker and candidate inputs");
  }
  if (activeWorkerIdentity.worker_id !== "eliotr-core" || activeWorkerIdentity.ai_search_bound !== false ||
      !UUID.test(activeWorkerIdentity.deployment_id ?? "") || !UUID.test(activeWorkerIdentity.version_id ?? "") ||
      typeof activeWorkerIdentity.generation !== "string" || activeWorkerIdentity.generation.length < 1 ||
      baselineConfigurationBaseline.deployment_id !== activeWorkerIdentity.deployment_id ||
      baselineConfigurationBaseline.version_id !== activeWorkerIdentity.version_id ||
      baselineConfigurationBaseline.deployment_generation !== activeWorkerIdentity.generation ||
      !SHA256.test(baselineConfigurationBaseline.configuration_sha256 ?? "")) {
    fail("AI Search binding bootstrap baseline does not match the active Worker readback");
  }
  assertNoSearchBinding(baselineConfig, "baseline");
  assertCandidateSearchBinding(candidateConfig);
  if (!sameJson(withoutAiSearchBindings(baselineConfig), withoutAiSearchBindings(candidateConfig))) {
    fail("AI Search binding bootstrap baseline may differ from its candidate only by the namespace binding");
  }
  assertDisabledProductSlices(candidateCapabilities);

  const file = await readIntentFile({ path, root, read });
  const intent = parseIntent(file.bytes);
  exactKeys(intent, INTENT_KEYS, "AI Search binding bootstrap intent has unsupported fields");
  if (intent.protocol !== PROTOCOL || intent.account_id !== accountId || intent.worker_id !== "eliotr-core" ||
      !SHA256.test(intent.manifest_sha256 ?? "")) {
    fail("AI Search binding bootstrap intent identity or manifest pin is invalid");
  }
  exactKeys(intent.binding, BINDING_KEYS, "AI Search binding bootstrap binding fields are invalid");
  if (intent.binding.name !== "AI_SEARCH" || intent.binding.type !== "ai_search_namespace" ||
      intent.binding.namespace !== "eliotr" || intent.binding.remote !== true) {
    fail("AI Search binding bootstrap permits only the exact remote eliotr namespace binding");
  }
  exactKeys(intent.baseline, BASELINE_KEYS, "AI Search binding bootstrap baseline fields are invalid");
  exactKeys(intent.candidate, CANDIDATE_KEYS, "AI Search binding bootstrap candidate fields are invalid");
  if (intent.baseline.deployment_id !== activeWorkerIdentity.deployment_id ||
      intent.baseline.version_id !== activeWorkerIdentity.version_id ||
      intent.baseline.generation !== activeWorkerIdentity.generation ||
      intent.baseline.configuration_sha256 !== baselineConfigurationBaseline.configuration_sha256 ||
      intent.candidate.source_head !== sourceHead || intent.candidate.generation !== candidateGeneration ||
      intent.candidate.configuration_sha256 !== candidateConfigurationSha256) {
    fail("AI Search binding bootstrap intent does not pin the exact active baseline and candidate");
  }

  const rootPath = await realpath(resolve(root));
  const manifest = await readPinnedManifest({ root: rootPath, read });
  const manifestBytes = manifest.bytes;
  if (manifestBytes.length < 1 || manifestBytes.length > MAX_MANIFEST_BYTES ||
      sha256(manifestBytes) !== intent.manifest_sha256) {
    fail("AI Search binding bootstrap intent does not pin the exact AI Search manifest");
  }

  const bootstrap = deepFreeze({ protocol: intent.protocol, account_id: intent.account_id, worker_id: intent.worker_id,
    binding: { ...intent.binding }, baseline: { ...intent.baseline }, candidate: { ...intent.candidate },
    manifest_sha256: intent.manifest_sha256, intent_sha256: file.sha256 });
  VALIDATED.add(bootstrap);
  PRIVATE.set(bootstrap, { path: file.path, root: file.root, manifestPath: manifest.path,
    manifestIdentity: manifest.identity, read, intentSha256: file.sha256,
    manifestSha256: intent.manifest_sha256 });
  return bootstrap;
}

/** Assert the exact absent-before or present-after shape for the validated bootstrap intent. */
export function assertMaintenanceAiSearchBootstrapProfile({ bootstrap, phase, generatedConfig,
  activeWorkerIdentity } = {}) {
  const privateState = requireValidated(bootstrap);
  if (!isRecord(generatedConfig) || !isRecord(activeWorkerIdentity) || !["before", "after"].includes(phase)) {
    fail("AI Search binding bootstrap phase inputs are invalid");
  }
  assertCandidateSearchBinding(generatedConfig);
  if (phase === "before") {
    if (activeWorkerIdentity.worker_id !== bootstrap.worker_id || activeWorkerIdentity.ai_search_bound !== false ||
        activeWorkerIdentity.deployment_id !== bootstrap.baseline.deployment_id ||
        activeWorkerIdentity.version_id !== bootstrap.baseline.version_id ||
        activeWorkerIdentity.generation !== bootstrap.baseline.generation) {
      fail("AI Search binding bootstrap before-phase Worker does not match the pinned absent baseline");
    }
  } else if (activeWorkerIdentity.worker_id !== bootstrap.worker_id || activeWorkerIdentity.ai_search_bound !== true ||
      activeWorkerIdentity.generation !== bootstrap.candidate.generation) {
    fail("AI Search binding bootstrap after-phase Worker does not match the bound candidate");
  }
  return Object.freeze({ state: "PASS", phase, intent_sha256: privateState.intentSha256,
    manifest_sha256: privateState.manifestSha256, binding: "AI_SEARCH:eliotr" });
}

/** Re-read the pinned intent and resource manifest before upload and after readback. */
export async function requireUnchangedMaintenanceAiSearchBootstrap({ bootstrap } = {}) {
  const privateState = requireValidated(bootstrap);
  const file = await readIntentFile({ path: privateState.path, root: privateState.root, read: privateState.read });
  if (file.sha256 !== privateState.intentSha256 || file.sha256 !== bootstrap.intent_sha256) {
    fail("AI Search binding bootstrap intent bytes changed during deployment");
  }
  const manifest = await readPinnedManifest({ root: privateState.root, read: privateState.read,
    expectedIdentity: privateState.manifestIdentity });
  const manifestBytes = manifest.bytes;
  if (manifestBytes.length < 1 || manifestBytes.length > MAX_MANIFEST_BYTES ||
      sha256(manifestBytes) !== privateState.manifestSha256 ||
      privateState.manifestSha256 !== bootstrap.manifest_sha256) {
    fail("AI Search binding bootstrap manifest changed during deployment");
  }
  return Object.freeze({ state: "PASS", intent_sha256: privateState.intentSha256,
    manifest_sha256: privateState.manifestSha256 });
}

function assertCandidateSearchBinding(config) {
  const namespaces = config.ai_search_namespaces;
  if (!Array.isArray(namespaces) || namespaces.length !== 1 || !isRecord(namespaces[0]) ||
      Object.keys(namespaces[0]).sort().join(",") !== "binding,namespace,remote" ||
      namespaces[0].binding !== "AI_SEARCH" || namespaces[0].namespace !== "eliotr" || namespaces[0].remote !== true) {
    fail("AI Search binding bootstrap candidate must contain only the exact remote eliotr namespace binding");
  }
  if (config.ai_search !== undefined && (!Array.isArray(config.ai_search) || config.ai_search.length !== 0)) {
    fail("AI Search binding bootstrap candidate cannot add instance bindings");
  }
}

function assertNoSearchBinding(config, label) {
  if ((config.ai_search_namespaces !== undefined &&
      (!Array.isArray(config.ai_search_namespaces) || config.ai_search_namespaces.length !== 0)) ||
      (config.ai_search !== undefined && (!Array.isArray(config.ai_search) || config.ai_search.length !== 0))) {
    fail(`AI Search binding bootstrap ${label} must have no AI Search binding`);
  }
}

function withoutAiSearchBindings(config) {
  return { ...config, ai_search_namespaces: [], ai_search: [] };
}

function sameJson(left, right) {
  const canonical = (value) => {
    if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
    if (isRecord(value)) return `{${Object.keys(value).sort().map((key) =>
      `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
    return JSON.stringify(value);
  };
  return canonical(left) === canonical(right);
}

function assertDisabledProductSlices(capabilities) {
  const disabled = capabilities.disabled_slices;
  const enabled = capabilities.enabled_slices;
  const partial = capabilities.partial_slices;
  if (![disabled, enabled, partial].every(Array.isArray) ||
      ["RETRIEVAL", "ERASURE"].some((slice) => !disabled.includes(slice) || enabled.includes(slice) || partial.includes(slice))) {
    fail("AI Search binding bootstrap must keep RETRIEVAL and ERASURE disabled");
  }
}

function requireValidated(bootstrap) {
  if (!isRecord(bootstrap) || !VALIDATED.has(bootstrap) || !PRIVATE.has(bootstrap)) {
    fail("AI Search binding bootstrap intent was not loaded and validated by this module");
  }
  return PRIVATE.get(bootstrap);
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
  } catch { fail("AI Search binding bootstrap intent path is invalid"); }
  if (!relativePath || relativePath === ".." || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath) ||
      relativePath.split(sep).some((part) => !part || part === "." || part === ".." ||
        /[\u0000-\u001f<>:"|?*]/u.test(part) || /[. ]$/u.test(part))) {
    fail("AI Search binding bootstrap intent must stay under repository .eliotr-state");
  }
  const statBefore = await inspectRegularFilePath(rootPath, statePath, target, relativePath);
  if (statBefore.size < 1 || statBefore.size > MAX_INTENT_BYTES) fail("AI Search binding bootstrap intent exceeds its size bound");
  let content;
  try { content = await read(target); } catch { fail("AI Search binding bootstrap intent is unreadable"); }
  const bytes = copyBytes(content);
  const statAfter = await inspectRegularFilePath(rootPath, statePath, target, relativePath);
  if (bytes.length !== statBefore.size || bytes.length !== statAfter.size || !sameFileIdentity(statBefore, statAfter) ||
      bytes.length > MAX_INTENT_BYTES) fail("AI Search binding bootstrap intent changed while being read");
  return { path: target, root: rootPath, bytes, sha256: sha256(bytes) };
}

async function inspectRegularFilePath(rootPath, statePath, target, relativePath) {
  try {
    const rootStat = await lstat(rootPath);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) fail("AI Search binding bootstrap repository root is invalid");
    const stateStat = await lstat(statePath);
    if (!stateStat.isDirectory() || stateStat.isSymbolicLink()) fail("AI Search binding bootstrap state directory is invalid");
    let directory = statePath;
    const parts = relativePath.split(sep);
    for (const part of parts.slice(0, -1)) {
      directory = resolve(directory, part);
      const directoryStat = await lstat(directory);
      if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) {
        fail("AI Search binding bootstrap path contains a symlink or non-directory");
      }
    }
    const before = await lstat(target);
    if (!before.isFile() || before.isSymbolicLink()) fail("AI Search binding bootstrap must be a regular file");
    const canonicalState = await realpath(statePath);
    const canonicalTarget = await realpath(target);
    const canonicalRelative = relative(canonicalState, canonicalTarget);
    if (canonicalRelative !== relativePath || canonicalRelative === ".." || canonicalRelative.startsWith(`..${sep}`)) {
      fail("AI Search binding bootstrap intent resolves outside .eliotr-state");
    }
    return before;
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("AI Search binding bootstrap")) throw error;
    fail("AI Search binding bootstrap path is missing or contains a symlink");
  }
}

function parseIntent(bytes) {
  let text;
  let parsed;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    parsed = JSON.parse(text);
    assertNoDuplicateJsonKeys(text);
  } catch { fail("AI Search binding bootstrap intent is not strict UTF-8 JSON"); }
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
    fail("AI Search binding bootstrap JSON string is invalid");
  };
  const value = (depth = 0) => {
    if (depth > 16) fail("AI Search binding bootstrap JSON nesting is excessive");
    whitespace();
    if (text[cursor] === "{") {
      cursor += 1;
      whitespace();
      const keys = new Set();
      if (text[cursor] === "}") { cursor += 1; return; }
      while (cursor < text.length) {
        whitespace();
        if (text[cursor] !== '"') fail("AI Search binding bootstrap JSON object key is invalid");
        const key = string();
        if (keys.has(key)) fail("AI Search binding bootstrap JSON contains duplicate fields");
        keys.add(key);
        whitespace();
        cursor += 1;
        value(depth + 1);
        whitespace();
        if (text[cursor] === "}") { cursor += 1; return; }
        cursor += 1;
      }
      fail("AI Search binding bootstrap JSON object is invalid");
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
      fail("AI Search binding bootstrap JSON array is invalid");
    }
    if (text[cursor] === '"') { string(); return; }
    while (cursor < text.length && !/[\s,\]}]/u.test(text[cursor])) cursor += 1;
  };
  value();
  whitespace();
  if (cursor !== text.length) fail("AI Search binding bootstrap JSON has trailing data");
}

function exactKeys(value, expectedKeys, message) {
  if (!isRecord(value) || Object.keys(value).length !== expectedKeys.length ||
      expectedKeys.some((key) => !Object.hasOwn(value, key))) fail(message);
}

function validPathInput(value) {
  return typeof value === "string" && value.length > 0 && value.length <= 4096 &&
    !/[\u0000-\u001f\u007f]/u.test(value);
}

async function readPinnedManifest({ root, read, expectedIdentity } = {}) {
  const path = resolve(root, "infra/ai-search/instances.json");
  let before;
  let after;
  try {
    const rootStat = await lstat(root);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) fail("AI Search manifest repository root is invalid");
    let directory = root;
    for (const part of ["infra", "ai-search"]) {
      directory = resolve(directory, part);
      const directoryStat = await lstat(directory);
      if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) {
        fail("AI Search manifest path contains a symlink or non-directory");
      }
    }
    before = await lstat(path);
    if (!before.isFile() || before.isSymbolicLink() || before.size < 1 || before.size > MAX_MANIFEST_BYTES ||
        await realpath(path) !== path) fail("AI Search manifest must be a bounded regular repository file");
    if (expectedIdentity !== undefined && !sameFileIdentity(before, expectedIdentity)) {
      fail("AI Search manifest file identity changed during deployment");
    }
    const bytes = copyBytes(await read(path));
    after = await lstat(path);
    if (bytes.length !== before.size || bytes.length !== after.size || !sameFileIdentity(before, after)) {
      fail("AI Search manifest changed while being read");
    }
    return { path, bytes, identity: { dev: after.dev, ino: after.ino } };
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("AI Search manifest")) throw error;
    fail("AI Search manifest is missing or unreadable");
  }
}

function copyBytes(value) {
  if (Buffer.isBuffer(value)) return Buffer.from(value);
  if (value instanceof Uint8Array) return Buffer.from(value);
  fail("AI Search binding bootstrap byte reader returned invalid data");
}

function sameFileIdentity(left, right) { return left.dev === right.dev && left.ino === right.ino; }

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const key of Reflect.ownKeys(value)) deepFreeze(value[key]);
    Object.freeze(value);
  }
  return value;
}
