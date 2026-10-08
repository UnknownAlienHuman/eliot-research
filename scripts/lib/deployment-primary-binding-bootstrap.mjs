import { createHash } from "node:crypto";
import { lstat, realpath, readFile } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

export const PRIMARY_BINDING_BOOTSTRAP_PROTOCOL = "eliotr.maintenance-primary-binding-bootstrap.v1";
export const PRIMARY_BUCKET_RECEIPT_PROTOCOL = "eliotr.r2-bucket-creation-receipt.v1";
const INTENT_KEYS = Object.freeze(["protocol", "account_id", "worker_id", "binding", "version_metadata",
  "bucket_receipt", "baseline", "candidate"]);
const BINDING_KEYS = Object.freeze(["name", "type", "bucket_name", "jurisdiction", "storage_class"]);
const VERSION_METADATA_KEYS = Object.freeze(["name", "type"]);
const RECEIPT_PIN_KEYS = Object.freeze(["path", "sha256", "protocol", "account_id", "bucket_name",
  "jurisdiction", "storage_class", "preexisting", "create_count", "create_readback", "existence_readback"]);
const RECEIPT_KEYS = Object.freeze(["protocol", "account_id", "bucket_name", "jurisdiction", "storage_class",
  "preexisting", "create_count", "create_readback", "existence_readback"]);
const BASELINE_KEYS = Object.freeze(["deployment_id", "version_id", "generation", "configuration_sha256"]);
const CANDIDATE_KEYS = Object.freeze(["source_head", "generation", "configuration_sha256"]);
const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/iu;
const ACCOUNT = /^[A-Za-z0-9_-]{1,64}$/u;
const SOURCE_HEAD = /^[0-9a-f]{40}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const BUCKET_NAME = /^[a-z0-9](?:[a-z0-9-]{1,61}[a-z0-9])?$/u;
const PROFILE_VALUE = /^[A-Za-z0-9_-]{1,64}$/u;
const MAX_INTENT_BYTES = 16 * 1024;
const MAX_RECEIPT_BYTES = 16 * 1024;
const PRIMARY_BUCKET = "BACKUP_PARTS_BUCKET";
const VERSION_METADATA = "VERSION_METADATA";
const PRIMARY_R2_KEYS = new Set(["binding", "bucket_name", "jurisdiction"]);
const VALIDATED = new WeakSet();
const PRIVATE = new WeakMap();
const fail = (message) => { throw new Error(message); };
const isRecord = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

/** Remove only the two approved primary-binding additions before strict baseline readback. */
export function withoutPrimaryBindingAdditions(config) {
  if (!isRecord(config) || !Array.isArray(config.r2_buckets)) {
    fail("Primary binding bootstrap baseline configuration is invalid");
  }
  const baseline = { ...config, r2_buckets: config.r2_buckets.filter((item) => item?.binding !== PRIMARY_BUCKET) };
  delete baseline.version_metadata;
  return baseline;
}

/** Load a strict maintenance intent for the fresh backup-parts bucket and metadata binding. */
export async function loadMaintenancePrimaryBindingBootstrap({ path, root, accountId, sourceHead, candidateGeneration,
  candidateConfigurationSha256, candidateConfig, candidateCapabilities, activeWorkerIdentity,
  baselineConfigurationBaseline, baselineConfig, read = readFile } = {}) {
  if (typeof read !== "function" || !validPathInput(root) || !validPathInput(path) ||
      !ACCOUNT.test(accountId ?? "") || !SOURCE_HEAD.test(sourceHead ?? "") ||
      candidateGeneration !== `git-${sourceHead.slice(0, 12)}` || !SHA256.test(candidateConfigurationSha256 ?? "") ||
      !isRecord(candidateConfig) || !isRecord(candidateCapabilities) || !isRecord(activeWorkerIdentity) ||
      !isRecord(baselineConfigurationBaseline) || !isRecord(baselineConfig) ||
      !isRecord(candidateConfig.vars) || candidateConfig.vars.DEPLOYMENT_GENERATION !== candidateGeneration) {
    fail("Primary binding bootstrap requires pinned account, source, Worker and candidate inputs");
  }
  assertActiveBaseline(activeWorkerIdentity, baselineConfigurationBaseline);
  assertNoPrimaryBindings(baselineConfig, "baseline");
  assertDisabledProductSlices(candidateCapabilities);

  const intentFile = await readStateFile({ path, root, read, label: "Primary binding bootstrap intent",
    maximum: MAX_INTENT_BYTES });
  const intent = parseStrictJson(intentFile.bytes, "Primary binding bootstrap intent");
  exactKeys(intent, INTENT_KEYS, "Primary binding bootstrap intent has unsupported fields");
  if (intent.protocol !== PRIMARY_BINDING_BOOTSTRAP_PROTOCOL || intent.account_id !== accountId ||
      intent.worker_id !== "eliotr-core") {
    fail("Primary binding bootstrap intent identity is invalid");
  }
  exactKeys(intent.binding, BINDING_KEYS, "Primary binding bootstrap binding fields are invalid");
  exactKeys(intent.version_metadata, VERSION_METADATA_KEYS, "Primary binding bootstrap metadata fields are invalid");
  exactKeys(intent.bucket_receipt, RECEIPT_PIN_KEYS, "Primary binding bootstrap receipt pin is invalid");
  exactKeys(intent.baseline, BASELINE_KEYS, "Primary binding bootstrap baseline fields are invalid");
  exactKeys(intent.candidate, CANDIDATE_KEYS, "Primary binding bootstrap candidate fields are invalid");
  assertIntentBinding(intent.binding);
  if (intent.version_metadata.name !== VERSION_METADATA || intent.version_metadata.type !== "version_metadata") {
    fail("Primary binding bootstrap permits only the VERSION_METADATA binding");
  }
  assertReceiptPin(intent.bucket_receipt, accountId);
  assertBaselinePin(intent.baseline, activeWorkerIdentity, baselineConfigurationBaseline);
  if (intent.candidate.source_head !== sourceHead || intent.candidate.generation !== candidateGeneration ||
      intent.candidate.configuration_sha256 !== candidateConfigurationSha256) {
    fail("Primary binding bootstrap intent does not pin the exact candidate");
  }

  const receiptFile = await readStateFile({ path: intent.bucket_receipt.path, root: intentFile.root, read,
    label: "Primary bucket creation receipt", maximum: MAX_RECEIPT_BYTES });
  if (receiptFile.path === intentFile.path || sha256(receiptFile.bytes) !== intent.bucket_receipt.sha256) {
    fail("Primary binding bootstrap receipt bytes do not match the pinned receipt");
  }
  const receipt = parseStrictJson(receiptFile.bytes, "Primary bucket creation receipt");
  exactKeys(receipt, RECEIPT_KEYS, "Primary bucket creation receipt has unsupported fields");
  assertReceiptRecord(receipt, intent.bucket_receipt, accountId);
  if (intent.binding.bucket_name !== intent.bucket_receipt.bucket_name ||
      intent.binding.jurisdiction !== intent.bucket_receipt.jurisdiction ||
      intent.binding.storage_class !== intent.bucket_receipt.storage_class) {
    fail("Primary binding bootstrap binding and bucket receipt disagree");
  }
  assertCandidateBindings(candidateConfig, intent.bucket_receipt);
  if (!sameJson(withoutPrimaryBindingAdditions(baselineConfig), withoutPrimaryBindingAdditions(candidateConfig))) {
    fail("Primary binding bootstrap baseline may differ from its candidate only by the two primary bindings");
  }
  assertNoPrimarySnapshot(baselineConfigurationBaseline.configuration);

  const bootstrap = deepFreeze({
    protocol: intent.protocol,
    account_id: intent.account_id,
    worker_id: intent.worker_id,
    binding: { ...intent.binding },
    version_metadata: { ...intent.version_metadata },
    bucket_receipt: { ...intent.bucket_receipt },
    baseline: { ...intent.baseline },
    candidate: { ...intent.candidate },
    intent_sha256: intentFile.sha256,
  });
  VALIDATED.add(bootstrap);
  PRIVATE.set(bootstrap, {
    intentPath: intentFile.path,
    intentRoot: intentFile.root,
    intentIdentity: intentFile.identity,
    receiptPath: receiptFile.path,
    receiptIdentity: receiptFile.identity,
    receiptSha256: intent.bucket_receipt.sha256,
    read,
  });
  return bootstrap;
}

/** Assert the absent-before or present-after shape for a validated primary-binding intent. */
export function assertMaintenancePrimaryBindingBootstrapProfile({ bootstrap, phase, generatedConfig,
  activeWorkerIdentity, workerReadback } = {}) {
  const privateState = requireValidated(bootstrap);
  if (!isRecord(generatedConfig) || !isRecord(activeWorkerIdentity) || !["before", "after"].includes(phase) ||
      !isRecord(workerReadback)) {
    fail("Primary binding bootstrap phase inputs are invalid");
  }
  assertCandidateBindings(generatedConfig, bootstrap.bucket_receipt);
  if (activeWorkerIdentity.worker_id !== bootstrap.worker_id || activeWorkerIdentity.traffic_percentage !== 100) {
    fail("Primary binding bootstrap phase Worker is not a single 100% eliotr-core version");
  }
  if (phase === "before") {
    if (activeWorkerIdentity.deployment_id !== bootstrap.baseline.deployment_id ||
        activeWorkerIdentity.version_id !== bootstrap.baseline.version_id ||
        activeWorkerIdentity.generation !== bootstrap.baseline.generation) {
      fail("Primary binding bootstrap before-phase Worker does not match the pinned baseline");
    }
    assertNoPrimaryReadback(workerReadback);
  } else {
    if (activeWorkerIdentity.generation !== bootstrap.candidate.generation) {
      fail("Primary binding bootstrap after-phase Worker does not match the candidate generation");
    }
    assertPrimaryReadback(workerReadback, bootstrap.bucket_receipt);
  }
  return Object.freeze({ state: "PASS", phase, intent_sha256: privateState.intentSha256,
    bucket_receipt_sha256: privateState.receiptSha256, binding: PRIMARY_BUCKET,
    version_metadata: VERSION_METADATA, readback: "PASS" });
}

/** Re-read the pinned intent and private bucket receipt before upload and after readback. */
export async function requireUnchangedMaintenancePrimaryBindingBootstrap({ bootstrap } = {}) {
  const privateState = requireValidated(bootstrap);
  const intentFile = await readStateFile({ path: privateState.intentPath, root: privateState.intentRoot,
    read: privateState.read, expectedIdentity: privateState.intentIdentity,
    label: "Primary binding bootstrap intent", maximum: MAX_INTENT_BYTES });
  if (intentFile.sha256 !== bootstrap.intent_sha256) {
    fail("Primary binding bootstrap intent bytes changed during deployment");
  }
  const receiptFile = await readStateFile({ path: privateState.receiptPath, root: privateState.intentRoot,
    read: privateState.read, expectedIdentity: privateState.receiptIdentity,
    label: "Primary bucket creation receipt", maximum: MAX_RECEIPT_BYTES });
  if (receiptFile.sha256 !== privateState.receiptSha256 || receiptFile.sha256 !== bootstrap.bucket_receipt.sha256) {
    fail("Primary bucket creation receipt bytes changed during deployment");
  }
  return Object.freeze({ state: "PASS", intent_sha256: privateState.intentSha256,
    bucket_receipt_sha256: privateState.receiptSha256 });
}

function assertActiveBaseline(identity, baseline) {
  if (identity.worker_id !== "eliotr-core" || identity.traffic_percentage !== 100 ||
      !UUID.test(identity.deployment_id ?? "") || !UUID.test(identity.version_id ?? "") ||
      typeof identity.generation !== "string" || identity.generation.length < 1 ||
      baseline.deployment_id !== identity.deployment_id || baseline.version_id !== identity.version_id ||
      baseline.deployment_generation !== identity.generation || !SHA256.test(baseline.configuration_sha256 ?? "")) {
    fail("Primary binding bootstrap baseline does not match the active 100% Worker readback");
  }
}

function assertIntentBinding(binding) {
  if (binding.name !== PRIMARY_BUCKET || binding.type !== "r2_bucket" ||
      !BUCKET_NAME.test(binding.bucket_name ?? "") || !PROFILE_VALUE.test(binding.jurisdiction ?? "") ||
      !PROFILE_VALUE.test(binding.storage_class ?? "")) {
    fail("Primary binding bootstrap binding identity is invalid");
  }
}

function assertReceiptPin(pin, accountId) {
  if (!validPathInput(pin.path) || !SHA256.test(pin.sha256 ?? "") || pin.protocol !== PRIMARY_BUCKET_RECEIPT_PROTOCOL ||
      pin.account_id !== accountId || !BUCKET_NAME.test(pin.bucket_name ?? "") ||
      !PROFILE_VALUE.test(pin.jurisdiction ?? "") || !PROFILE_VALUE.test(pin.storage_class ?? "") ||
      pin.preexisting !== false || pin.create_count !== 1 || pin.create_readback !== "PASS" ||
      pin.existence_readback !== "PASS") {
    fail("Primary binding bootstrap receipt pin is invalid");
  }
}

function assertReceiptRecord(receipt, pin, accountId) {
  if (receipt.protocol !== PRIMARY_BUCKET_RECEIPT_PROTOCOL || receipt.account_id !== accountId ||
      receipt.bucket_name !== pin.bucket_name || receipt.jurisdiction !== pin.jurisdiction ||
      receipt.storage_class !== pin.storage_class || receipt.preexisting !== false || receipt.create_count !== 1 ||
      receipt.create_readback !== "PASS" || receipt.existence_readback !== "PASS" ||
      pin.protocol !== receipt.protocol || pin.account_id !== receipt.account_id) {
    fail("Primary bucket creation receipt does not prove one fresh create and existence readback");
  }
}

function assertBaselinePin(baseline, identity, readback) {
  if (baseline.deployment_id !== identity.deployment_id || baseline.version_id !== identity.version_id ||
      baseline.generation !== identity.generation || baseline.configuration_sha256 !== readback.configuration_sha256) {
    fail("Primary binding bootstrap intent does not pin the active baseline");
  }
}

function assertCandidateBindings(config, receipt) {
  if (!Array.isArray(config.r2_buckets)) fail("Primary binding bootstrap candidate R2 configuration is invalid");
  const matches = config.r2_buckets.filter((item) => item?.binding === PRIMARY_BUCKET);
  if (matches.length !== 1 || !isRecord(matches[0]) ||
      [...Object.keys(matches[0])].some((key) => !PRIMARY_R2_KEYS.has(key)) ||
      matches[0].bucket_name !== receipt.bucket_name ||
      (matches[0].jurisdiction !== undefined && matches[0].jurisdiction !== receipt.jurisdiction) ||
      (matches[0].jurisdiction === undefined && receipt.jurisdiction !== "default")) {
    fail("Primary binding bootstrap candidate must contain the exact fresh R2 bucket binding");
  }
  exactKeys(config.version_metadata, ["binding"], "Primary binding bootstrap candidate metadata configuration is invalid");
  if (config.version_metadata.binding !== VERSION_METADATA) {
    fail("Primary binding bootstrap candidate must contain the exact VERSION_METADATA binding");
  }
}

function assertNoPrimaryBindings(config, label) {
  if (!Array.isArray(config.r2_buckets) || config.r2_buckets.some((item) => item?.binding === PRIMARY_BUCKET) ||
      Object.hasOwn(config, "version_metadata")) {
    fail(`Primary binding bootstrap ${label} must have no primary binding additions`);
  }
}

function assertNoPrimarySnapshot(configuration) {
  const bindings = configuration?.version?.bindings;
  if (!Array.isArray(bindings)) fail("Primary binding bootstrap baseline configuration snapshot is invalid");
  if (bindings.some((binding) => binding?.bindingName === PRIMARY_BUCKET ||
      binding?.bindingName === VERSION_METADATA || binding?.type === "version_metadata")) {
    fail("Primary binding bootstrap baseline readback already contains a primary binding");
  }
}

function assertNoPrimaryReadback(worker) {
  const bindings = worker.binding_readback;
  if (!Array.isArray(bindings) || bindings.some((binding) => binding?.name === PRIMARY_BUCKET ||
      binding?.name === VERSION_METADATA || binding?.type === "version_metadata")) {
    fail("Primary binding bootstrap before-phase Worker contains an unexpected primary binding");
  }
}

function assertPrimaryReadback(worker, receipt) {
  const bindings = worker.binding_readback;
  if (!Array.isArray(bindings)) fail("Primary binding bootstrap after-phase Worker binding readback is invalid");
  const bucket = bindings.filter((binding) => binding?.name === PRIMARY_BUCKET);
  const metadata = bindings.filter((binding) => binding?.name === VERSION_METADATA);
  if (bucket.length !== 1 || bucket[0].type !== "r2_bucket" ||
      bucket[0].identity?.bucket_name !== receipt.bucket_name || metadata.length !== 1 ||
      metadata[0].type !== "version_metadata" || !isRecord(metadata[0].identity) ||
      Object.keys(metadata[0].identity).length !== 0) {
    fail("Primary binding bootstrap after-phase Worker is missing the exact two primary bindings");
  }
}

function assertDisabledProductSlices(capabilities) {
  const disabled = capabilities.disabled_slices;
  const enabled = capabilities.enabled_slices;
  const partial = capabilities.partial_slices;
  if (![disabled, enabled, partial].every(Array.isArray) ||
      ["RETRIEVAL", "ERASURE"].some((slice) => !disabled.includes(slice) || enabled.includes(slice) || partial.includes(slice))) {
    fail("Primary binding bootstrap must keep RETRIEVAL and ERASURE disabled");
  }
}

function requireValidated(bootstrap) {
  if (!isRecord(bootstrap) || !VALIDATED.has(bootstrap) || !PRIVATE.has(bootstrap)) {
    fail("Primary binding bootstrap intent was not loaded and validated by this module");
  }
  return PRIVATE.get(bootstrap);
}

async function readStateFile({ path, root, read, expectedIdentity, label, maximum }) {
  let rootPath;
  let statePath;
  let target;
  let relativePath;
  try {
    rootPath = await realpath(resolve(root));
    statePath = resolve(rootPath, ".eliotr-state");
    target = isAbsolute(path) ? resolve(path) : resolve(rootPath, path);
    relativePath = relative(statePath, target);
  } catch { fail(`${label} path is invalid`); }
  if (!relativePath || relativePath === ".." || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath) ||
      relativePath.split(sep).some((part) => !part || part === "." || part === ".." ||
        /[\u0000-\u001f<>:"|?*]/u.test(part) || /[. ]$/u.test(part))) {
    fail(`${label} path must stay under repository .eliotr-state`);
  }
  const before = await inspectStateFile({ rootPath, statePath, target, relativePath, label });
  if (before.size < 1 || before.size > maximum) fail(`${label} exceeds its size bound`);
  let content;
  try { content = await read(target); } catch { fail(`${label} is unreadable`); }
  const bytes = copyBytes(content, label);
  const after = await inspectStateFile({ rootPath, statePath, target, relativePath, label });
  if (bytes.length !== before.size || bytes.length !== after.size || !sameFileIdentity(before, after) ||
      (expectedIdentity !== undefined && !sameFileIdentity(expectedIdentity, before))) {
    fail(`${label} changed while being read`);
  }
  return { path: target, root: rootPath, identity: before, bytes, sha256: sha256(bytes) };
}

async function inspectStateFile({ rootPath, statePath, target, relativePath, label }) {
  try {
    const rootStat = await lstat(rootPath);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) fail(`${label} repository root is invalid`);
    const stateStat = await lstat(statePath);
    if (!stateStat.isDirectory() || stateStat.isSymbolicLink()) fail(`${label} state directory is invalid`);
    let directory = statePath;
    const parts = relativePath.split(sep);
    for (const part of parts.slice(0, -1)) {
      directory = resolve(directory, part);
      const directoryStat = await lstat(directory);
      if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) fail(`${label} path contains a symlink`);
    }
    const file = await lstat(target);
    if (!file.isFile() || file.isSymbolicLink()) fail(`${label} must be a regular file`);
    const canonicalState = await realpath(statePath);
    const canonicalTarget = await realpath(target);
    const canonicalRelative = relative(canonicalState, canonicalTarget);
    if (canonicalRelative !== relativePath || canonicalRelative === ".." || canonicalRelative.startsWith(`..${sep}`)) {
      fail(`${label} resolves outside .eliotr-state`);
    }
    return file;
  } catch (error) {
    if (error instanceof Error && error.message.startsWith(label)) throw error;
    fail(`${label} path is missing or contains a symlink`);
  }
}

function parseStrictJson(bytes, label) {
  let text;
  let value;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    value = JSON.parse(text);
    assertNoDuplicateJsonKeys(text, label);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith(label)) throw error;
    fail(`${label} is not strict UTF-8 JSON`);
  }
  return value;
}

function assertNoDuplicateJsonKeys(text, label) {
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
    fail(`${label} JSON string is invalid`);
  };
  const value = (depth = 0) => {
    if (depth > 16) fail(`${label} JSON nesting is excessive`);
    whitespace();
    if (text[cursor] === "{") {
      cursor += 1;
      whitespace();
      const keys = new Set();
      if (text[cursor] === "}") { cursor += 1; return; }
      while (cursor < text.length) {
        whitespace();
        if (text[cursor] !== '"') fail(`${label} JSON object key is invalid`);
        const key = string();
        if (keys.has(key)) fail(`${label} JSON contains duplicate fields`);
        keys.add(key);
        whitespace();
        if (text[cursor] !== ":") fail(`${label} JSON object separator is invalid`);
        cursor += 1;
        value(depth + 1);
        whitespace();
        if (text[cursor] === "}") { cursor += 1; return; }
        if (text[cursor] !== ",") fail(`${label} JSON object separator is invalid`);
        cursor += 1;
      }
      fail(`${label} JSON object is invalid`);
    }
    if (text[cursor] === "[") {
      cursor += 1;
      whitespace();
      if (text[cursor] === "]") { cursor += 1; return; }
      while (cursor < text.length) {
        value(depth + 1);
        whitespace();
        if (text[cursor] === "]") { cursor += 1; return; }
        if (text[cursor] !== ",") fail(`${label} JSON array separator is invalid`);
        cursor += 1;
      }
      fail(`${label} JSON array is invalid`);
    }
    if (text[cursor] === '"') { string(); return; }
    while (cursor < text.length && !/[\s,\]}]/u.test(text[cursor])) cursor += 1;
  };
  value();
  whitespace();
  if (cursor !== text.length) fail(`${label} JSON has trailing data`);
}

function exactKeys(value, expectedKeys, message) {
  if (!isRecord(value) || Object.keys(value).length !== expectedKeys.length ||
      expectedKeys.some((key) => !Object.hasOwn(value, key))) fail(message);
}

function validPathInput(value) {
  return typeof value === "string" && value.length > 0 && value.length <= 4096 &&
    !/[\u0000-\u001f\u007f]/u.test(value);
}

function copyBytes(value, label) {
  if (Buffer.isBuffer(value)) return Buffer.from(value);
  if (value instanceof Uint8Array) return Buffer.from(value);
  fail(`${label} byte reader returned invalid data`);
}

function sameFileIdentity(left, right) { return left.dev === right.dev && left.ino === right.ino; }

function sameJson(left, right) {
  const canonical = (value) => {
    if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
    if (isRecord(value)) return `{${Object.keys(value).sort().map((key) =>
      `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
    return JSON.stringify(value);
  };
  return canonical(left) === canonical(right);
}

function deepFreeze(value) {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}
