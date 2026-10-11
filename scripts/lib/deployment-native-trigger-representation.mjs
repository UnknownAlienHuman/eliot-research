import { createHash } from "node:crypto";
import { lstat, mkdir, open, readFile, realpath, readdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { tokenizeDeploymentSql } from "./deployment-sql-tokens.mjs";

export const NATIVE_TRIGGER_PROTOCOL = "eliotr.d1-native-trigger-case.v1";
const HASH = /^[0-9a-f]{64}$/u;
const NAME = /^\d{4}_[A-Za-z0-9_-]+\.sql$/u;
const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/iu;
const sha = bytes => createHash("sha256").update(bytes).digest("hex");
const invalid = message => { throw new Error(message); };

export function validNativeTriggerTransport(value, names) {
  return Array.isArray(names) && names.length > 0 && names.length <= 2048 && names.every((name, index) =>
    NAME.test(name ?? "") && (index === 0 || names[index - 1] < name)) &&
    value !== null && typeof value === "object" && !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype &&
    Object.keys(value).length === 3 && [NATIVE_TRIGGER_PROTOCOL, "eliotr.d1-native-trigger-case-commentless.v1"].includes(value.protocol) &&
    HASH.test(value.local_migration_bundle_sha256 ?? "") && Array.isArray(value.migration_hashes) &&
    value.migration_hashes.length === names.length && value.migration_hashes.every((entry, index) =>
      entry !== null && typeof entry === "object" && !Array.isArray(entry) && Object.getPrototypeOf(entry) === Object.prototype &&
      Object.keys(entry).length === 2 && entry.name === names[index] && HASH.test(entry.sha256 ?? ""));
}

// CASE is already an atomic SQLite expression. This representation inserts
// exactly two parentheses around each depth-zero trigger-body CASE, preserving
// every original byte. It does not rewrite predicates, keywords or comments.
export function projectDeploymentNativeTriggerSql(sql) {
  if (typeof sql !== "string" || Buffer.byteLength(sql, "utf8") > 4 * 1024 * 1024) invalid("Invalid native migration SQL input");
  if (new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(Buffer.from(sql, "utf8")) !== sql) {
    invalid("Native migration SQL is not lossless UTF-8");
  }
  const edits = [];
  const firstWords = [];
  const blocks = [];
  let trigger = false, body = false, parens = 0;
  for (const token of tokenizeDeploymentSql(sql)) {
    if (token.type === "symbol" && token.value === ";" && (!trigger || (body && blocks.length === 0))) {
      if (trigger && parens !== 0) invalid("Unbalanced parentheses in native trigger representation");
      firstWords.length = 0;
      trigger = false;
      body = false;
      parens = 0;
      continue;
    }
    if (token.type === "word" && firstWords.length < 2) firstWords.push(token.value);
    if (firstWords[0] === "CREATE" && firstWords[1] === "TRIGGER") trigger = true;
    if (!trigger) continue;
    if (body && token.type === "symbol") {
      if (token.value === "(") parens += 1;
      else if (token.value === ")" && --parens < 0) invalid("Unbalanced parentheses in native trigger representation");
    }
    if (token.type !== "word") continue;
    if (!body && token.value === "BEGIN") {
      body = true;
      blocks.push({ kind: "BEGIN" });
    } else if (body && token.value === "CASE") {
      const wrap = parens === 0;
      blocks.push({ kind: "CASE", wrap });
      if (wrap) edits.push({ offset: token.start, text: "(" });
    } else if (body && token.value === "END") {
      const block = blocks.pop();
      if (!block) invalid("Unbalanced CASE/END in native trigger representation");
      if (block.kind === "CASE" && block.wrap) edits.push({ offset: token.end, text: ")" });
    }
  }
  if (trigger && (!body || blocks.length !== 0 || parens !== 0)) invalid("Unbalanced native trigger representation");
  edits.sort((left, right) => left.offset - right.offset);
  let result = "", offset = 0;
  for (const edit of edits) {
    result += sql.slice(offset, edit.offset) + edit.text;
    offset = edit.offset;
  }
  result += sql.slice(offset);
  return Object.freeze({ sql: result, source_sha256: sha(sql), sha256: sha(result),
    source_bytes: Buffer.byteLength(sql, "utf8"), bytes: Buffer.byteLength(result, "utf8"),
    inserted_parentheses: edits.length });
}

async function writeExclusive(file, bytes) {
  await mkdir(dirname(file), { recursive: true });
  const handle = await open(file, "wx", 0o600);
  try { await handle.writeFile(bytes); await handle.sync(); }
  finally { await handle.close(); }
}

// The mirror retains the original config bytes and selected canonical relative
// migration path. Ordinary Wrangler owns migration ordering and bookkeeping.
export async function materializeNativeMigrationMirror({ root, intent, configBytes, bundle,
  mirrorParentRoot = root, companionBundles = [], read = readFile, projectSql = projectDeploymentNativeTriggerSql }) {
  if (!UUID.test(intent?.intent_id ?? "") || !["CORE_DB", "SEARCH_DB"].includes(intent?.database?.binding) ||
      !validNativeTriggerTransport(intent?.migration_transport, intent?.migration_names ?? []) || typeof projectSql !== "function" ||
      ((intent.protocol === "eliotr.cloudflare-d1-migration-intent.v5") !==
       (intent.migration_transport.protocol === "eliotr.d1-native-trigger-case-commentless.v1"))) invalid("Invalid native migration mirror input");
  const sourceRoot = await realpath(root);
  const destinationRoot = await realpath(mirrorParentRoot);
  validateMirrorBundles(intent, bundle, companionBundles);
  const parent = resolve(destinationRoot, ".eliotr-state/d1-native-migrations");
  await mkdir(parent, { recursive: true });
  if ((await lstat(parent)).isSymbolicLink() || await realpath(parent) !== parent) invalid("Unsafe native migration mirror parent");
  const mirror = resolve(parent, intent.intent_id);
  await mkdir(mirror);
  const pending = new Set(intent.migration_names);
  const effective = new Map(intent.migration_transport.migration_hashes.map(entry => [entry.name, entry.sha256]));
  for (const streamBundle of [bundle, ...companionBundles]) {
    const stream = streamBundle.binding === "CORE_DB" ? "core" : "search";
    const directory = resolve(mirror, "infra/d1", stream, "migrations");
    for (const entry of streamBundle.migration_entries) {
      const file = resolve(sourceRoot, "infra/d1", stream, "migrations", entry.name);
      const before = await lstat(file);
      if (!before.isFile() || before.isSymbolicLink() || before.size > 16 * 1024 * 1024 ||
          await realpath(file) !== file) invalid("Unsafe native migration source path");
      const original = await read(file);
      const after = await lstat(file);
      if (!after.isFile() || after.isSymbolicLink() || before.dev !== after.dev || before.ino !== after.ino ||
          before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs ||
          after.size !== original.byteLength) invalid("Native migration source changed while being read");
      if (sha(original) !== entry.sha256) invalid("Original migration changed while materializing native representation");
      const selected = streamBundle.binding === intent.database.binding && pending.has(entry.name);
      const output = selected
        ? Buffer.from(projectSql(new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(original)).sql, "utf8")
        : original;
      if (sha(output) !== (selected ? effective.get(entry.name) : entry.sha256)) invalid("Native migration representation differs from approved effect pin");
      await writeExclusive(resolve(directory, entry.name), output);
    }
  }
  if (sha(configBytes) !== intent.generated_config_sha256) invalid("Native mirror config differs from original approved config");
  await writeExclusive(resolve(mirror, "apps/eliotr-core/wrangler.deploy.jsonc"), configBytes);
  const result = Object.freeze({ root: mirror, cwd: resolve(mirror, "apps/eliotr-core"),
    config_sha256: intent.generated_config_sha256, local_migration_bundle_sha256: intent.migration_transport.local_migration_bundle_sha256 });
  await verifyNativeMigrationMirror({ mirror: result, intent, bundle, companionBundles });
  return result;
}

function validateMirrorBundles(intent, bundle, companionBundles) {
  if (!Array.isArray(companionBundles) || companionBundles.length > 1 ||
      bundle?.binding !== intent.database.binding || bundle.database_id !== intent.database.database_id ||
      bundle.database_name !== intent.database.database_name || bundle.local_migration_bundle_sha256 !== intent.local_migration_bundle_sha256) {
    invalid("Native mirror source bundle differs from approved target");
  }
  const bindings = new Set();
  for (const stream of [bundle, ...companionBundles]) {
    if (!["CORE_DB", "SEARCH_DB"].includes(stream?.binding) || bindings.has(stream.binding) ||
        !Array.isArray(stream.migration_entries) || stream.migration_entries.length < 1 || stream.migration_entries.length > 2048 ||
        !Array.isArray(stream.migration_names) || JSON.stringify(stream.migration_names) !== JSON.stringify(stream.migration_entries.map(entry => entry.name)) ||
        stream.migration_entries.some((entry, index) => !NAME.test(entry.name ?? "") || !HASH.test(entry.sha256 ?? "") ||
          (index > 0 && stream.migration_entries[index - 1].name >= entry.name)) ||
        sha(JSON.stringify(stream.migration_entries)) !== stream.local_migration_bundle_sha256) invalid("Invalid native mirror source stream");
    bindings.add(stream.binding);
  }
  const offset = bundle.migration_names.indexOf(intent.migration_names[0]);
  if (offset < 0 || JSON.stringify(bundle.migration_entries.slice(offset)) !== JSON.stringify(intent.migration_hashes)) {
    invalid("Native mirror source pins are not the approved complete suffix");
  }
}

export async function verifyNativeMigrationMirror({ mirror, intent, bundle, companionBundles = [] }) {
  validateMirrorBundles(intent, bundle, companionBundles);
  const configPath = resolve(mirror.cwd, "wrangler.deploy.jsonc");
  if (await realpath(mirror.root) !== mirror.root || await realpath(configPath) !== configPath ||
      (await lstat(configPath)).isSymbolicLink()) invalid("Unsafe native migration mirror path");
  const config = await readFile(configPath);
  if (sha(config) !== intent.generated_config_sha256) invalid("Native mirror config changed before apply");
  for (const streamBundle of [bundle, ...companionBundles]) {
    const stream = streamBundle.binding === "CORE_DB" ? "core" : "search";
    const directory = resolve(mirror.root, "infra/d1", stream, "migrations");
    if (await realpath(directory) !== directory) invalid("Unsafe native migration mirror directory");
    const entries = await readdir(directory, { withFileTypes: true });
    const names = entries.map(entry => entry.name).sort();
    if (entries.some(entry => !entry.isFile()) || JSON.stringify(names) !== JSON.stringify(streamBundle.migration_names)) invalid("Native mirror migration membership changed");
    const selected = streamBundle.binding === intent.database.binding;
    const approved = new Map(streamBundle.migration_entries.map(entry => [entry.name, entry.sha256]));
    if (selected) for (const entry of intent.migration_transport.migration_hashes) approved.set(entry.name, entry.sha256);
    const pins = [];
    for (const name of names) {
      const file = resolve(directory, name);
      if ((await lstat(file)).isSymbolicLink()) invalid("Native mirror migration became a symlink");
      const hash = sha(await readFile(file));
      if (hash !== approved.get(name)) invalid("Native mirror migration changed before apply");
      pins.push({ name, sha256: hash });
    }
    const expectedHash = selected ? intent.migration_transport.local_migration_bundle_sha256 : streamBundle.local_migration_bundle_sha256;
    if (sha(JSON.stringify(pins)) !== expectedHash) invalid("Native mirror bundle differs from approved effect pin");
    }
}
