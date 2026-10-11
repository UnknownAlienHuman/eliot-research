import { createHash } from "node:crypto";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { deploymentMigrationIntentSha256, validateDeploymentMigrationIntent } from "./deployment-migration-operation.mjs";
import { projectDeploymentNativeTriggerSql } from "./deployment-native-trigger-representation.mjs";

import { projectDeploymentNativeCommentlessSql } from "./deployment-native-sql-representation.mjs";

const sha = bytes => createHash("sha256").update(bytes).digest("hex");
const hash = /^[0-9a-f]{64}$/u;
const fail = reason => { throw new Error("Deployment native schema provenance rejected: " + reason); };
const exact = (value, keys) => value !== null && typeof value === "object" && !Array.isArray(value) &&
  Object.getPrototypeOf(value) === Object.prototype && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const equal = (left, right) => JSON.stringify(left) === JSON.stringify(right);

function readPinnedSource(root, path, pin) {
  const file = resolve(root, path), suffix = relative(root, file);
  if (suffix === "" || suffix === ".." || suffix.startsWith(".." + sep) || isAbsolute(suffix) ||
      suffix.split(sep).join("/") !== path || !hash.test(pin.sha256 ?? "") ||
      !Number.isSafeInteger(pin.byte_length) || pin.byte_length < 1 || pin.byte_length > 16 * 1024 * 1024) fail("invalid source path/pin");
  const before = lstatSync(file);
  if (!before.isFile() || before.isSymbolicLink() || before.size !== pin.byte_length || realpathSync(file) !== file) fail("unsafe or changed source file");
  const bytes = readFileSync(file);
  const after = lstatSync(file);
  if (!after.isFile() || after.isSymbolicLink() || before.dev !== after.dev || before.ino !== after.ino ||
      before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs ||
      sha(bytes) !== pin.sha256 || bytes.byteLength !== pin.byte_length) fail("source bytes changed while being read");
  return bytes;
}

// Reproduce effective migration pins from the captured ORIGINAL repository
// bytes. This never reads sqlite_master or accepts live state as an expectation.
export function validateDeploymentNativeSchemaProvenance({ root, representation, sourceStreams,
  capturedMigrations, generatedConfigPin } = {}) {
  if (!exact(representation, ["intent", "intent_sha256", "intent_file", "streams"]) ||
      !Array.isArray(representation.streams) || representation.streams.length !== 2) fail("invalid representation shape");
  const intent = validateDeploymentMigrationIntent(representation.intent);
  if (!["eliotr.cloudflare-d1-migration-intent.v4", "eliotr.cloudflare-d1-migration-intent.v5"].includes(intent.protocol) ||
      representation.intent_sha256 !== deploymentMigrationIntentSha256(intent) ||
      intent.generated_config_sha256 !== generatedConfigPin.sha256) fail("intent/config pins differ");
  const filePin = representation.intent_file;
  if (!exact(filePin, ["path", "sha256", "byte_length"])) fail("invalid intent file pin");
  const intentBytes = readPinnedSource(root, filePin.path, filePin);
  let fileIntent;
  try { fileIntent = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(intentBytes)); }
  catch { fail("intent file is not lossless JSON"); }
  if (deploymentMigrationIntentSha256(fileIntent) !== representation.intent_sha256) fail("intent file differs from recorded intent");
  const selected = sourceStreams.find(stream => stream.binding === intent.database.binding);
  if (!selected || selected.account_id !== intent.account_id || selected.database_id !== intent.database.database_id ||
      selected.database_name !== intent.database.database_name || selected.migration_bundle_sha256 !== intent.local_migration_bundle_sha256) {
    fail("intent target differs from captured source stream");
  }
  const offset = selected.migration_entries.findIndex(entry => entry.name === intent.migration_names[0]);
  if (offset < 0 || !equal(selected.migration_entries.slice(offset), intent.migration_hashes)) fail("intent source pins are not the complete suffix");
  const pending = new Map(intent.migration_transport.migration_hashes.map(entry => [entry.name, entry.sha256]));
  for (let index = 0; index < sourceStreams.length; index += 1) {
    const source = sourceStreams[index], effective = representation.streams[index];
    if (!exact(effective, ["binding", "migration_entries", "migration_bundle_sha256", "total_sql_bytes"]) ||
        effective.binding !== source.binding) fail("invalid effective stream identity");
    const captured = capturedMigrations.get(source.binding);
    const streamName = source.binding === "CORE_DB" ? "core" : "search";
    const entries = [];
    let totalBytes = 0;
    for (const input of captured) {
      const original = readPinnedSource(root, `infra/d1/${streamName}/migrations/${input.name}`, input);
      const applyRepresentation = source.binding === intent.database.binding && pending.has(input.name);
      const projected = applyRepresentation
        ? (intent.protocol === "eliotr.cloudflare-d1-migration-intent.v5" ? projectDeploymentNativeCommentlessSql : projectDeploymentNativeTriggerSql)(new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(original))
        : { sha256: input.sha256, bytes: input.byte_length };
      if (applyRepresentation && projected.sha256 !== pending.get(input.name)) fail("effective file differs from approved representation");
      entries.push({ name: input.name, sha256: projected.sha256 });
      totalBytes += projected.bytes;
    }
    if (!equal(effective.migration_entries, entries) || effective.migration_bundle_sha256 !== sha(JSON.stringify(entries)) ||
        effective.total_sql_bytes !== totalBytes || (source.binding === intent.database.binding &&
        effective.migration_bundle_sha256 !== intent.migration_transport.local_migration_bundle_sha256)) fail("effective stream pins differ from deterministic source projection");
  }
  return true;
}
