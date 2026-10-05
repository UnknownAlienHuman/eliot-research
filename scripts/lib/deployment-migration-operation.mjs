import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdir, open, readFile, rename, stat, unlink } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { injectOAuthBearer, loadWranglerOAuthCredential, resolveAuthMode, scrubTokenEnv,
  stripNodeOptionsLoaderTokens, verifyWranglerOAuthAccount, WRANGLER_OAUTH_MODE } from "./cloudflare-wrangler-oauth.mjs";
import { readDeploymentMigrationEntries, inspectDeploymentMigrationLedger,
  validateDeploymentMigrationDirectories } from "./deployment-migrations.mjs";
import { readDeploymentJson } from "./deployment-verification.mjs";
import { validateStagingTarget } from "./staging-isolation.mjs";

const INTENT_PROTOCOL = "eliotr.cloudflare-d1-migration-intent.v1";
const RECEIPT_PROTOCOL = "eliotr.cloudflare-d1-migration-receipt.v1";
const EMPTY_SEMANTIC_REVISION_REPAIR = Object.freeze({
  migrationName: "0108_research_semantic_config_revision_glob_limits.sql",
  baselineName: "0097_research_semantic_config_revision.sql",
  targetName: "research_semantic_config_revision",
  replacementName: "research_semantic_config_revision_0108",
  guardName: "__eliotr_migration_0108_research_semantic_config_revision_empty_guard",
  updateTriggerName: "research_semantic_config_revision_no_update",
  deleteTriggerName: "research_semantic_config_revision_no_delete",
  baselineSha256: "6d5cf0043a64e9ae281daa1af9e8d59cb4037060361b0798f0a494312b75b722",
});
const BOUNDED_STAGE_OPERATION_COPY_REBUILD = Object.freeze({
  migrationName: "0113_research_provider_key_model_use_failure_alignment.sql",
  migrationSha256: "308df2409b85ff48fce06e25b98564f02852a1a3cd2db1c6746a6b8492a9492b",
  baselineName: "0110_research_provider_key_model_use.sql",
  predecessorPins: Object.freeze([
    Object.freeze({ name: "0110_research_provider_key_model_use.sql",
      sha256: "cf906b6059822fb87fb2ed7d1551be55d0cbfa11adaf78e95617365fe0d3a12c" }),
    Object.freeze({ name: "0111_provider_native_model_authority.sql",
      sha256: "47829bbd0403b04ae74933e67f26e266d3c57b34086a5cf67ce843e393f8d207" }),
    Object.freeze({ name: "0112_workflow_failure_shape_alignment.sql",
      sha256: "fc3288924de8bb82078da27f23cd155c3b01aed24e4011ac8f53bfa5365dcf74" }),
  ]),
  targetName: "research_provider_key_model_use_stage_operation",
  replacementName: "research_provider_key_model_use_stage_operation_0113_copy",
  parentTableName: "research_provider_key_model_use_operation",
  childTableNames: Object.freeze([
    "research_provider_key_model_price_observation",
    "provider_native_model_preparation",
  ]),
  triggerNames: Object.freeze([
    "research_provider_key_model_price_observation_owner_insert",
    "provider_native_model_preparation_guard",
    "provider_native_model_qualification_attempt_guard",
    "provider_native_model_observation_guard",
    "provider_native_model_candidate_guard",
    "provider_native_model_qualification_proof_guard",
    "provider_native_model_qualification_complete_guard",
    "research_provider_key_model_use_stage_transition",
    "research_provider_key_model_use_stage_no_delete",
  ]),
  maximumRows: 64,
  maximumScannedRows: 65,
  maximumFieldPayloadBytes: 1_048_576,
});
const HASH = /^[0-9a-f]{64}$/u;
const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/iu;
const ACCOUNT = /^[A-Za-z0-9_-]{1,64}$/u;
const DATABASE_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/u;
const MIGRATION = /^\d{4}_[A-Za-z0-9_-]+\.sql$/u;
const SCHEMA_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/u;
const MAX_LOCAL_BUNDLE_BYTES = 16 * 1024 * 1024;
const MAX_APPROVED_SQL_BYTES = 4 * 1024 * 1024;
const MAX_MIGRATIONS = 2048;
const MAX_RUNTIME_MS = 5 * 60_000;
const MAX_RECEIPT_HISTORY = 32;
const MAX_INTENT_BYTES = 2 * 1024 * 1024;
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const CONFIG_NAME = "wrangler.deploy.jsonc";
const RECEIPT_DIRECTORY = ".eliotr-state/d1-migration-receipts";
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const fail = (message = "Scoped D1 migration intent or readback mismatch") => { throw new Error(message); };

function isObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exactKeys(value, keys) {
  return isObject(value) && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (!isObject(value)) return JSON.stringify(value);
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
}

function isoDate(value) {
  if (typeof value !== "string" || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/u.test(value)) return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

function validMigrationNames(names, { allowEmpty = false } = {}) {
  return Array.isArray(names) && (allowEmpty || names.length > 0) && names.length <= MAX_MIGRATIONS &&
    names.every((name, index) => typeof name === "string" && MIGRATION.test(name) &&
      (index === 0 || names[index - 1] < name));
}

function validateSchemaProbes(probes, migrationNames) {
  if (!Array.isArray(probes) || probes.length < 1 || probes.length > 64) return false;
  const covered = new Set();
  const unique = new Set();
  for (const probe of probes) {
    if (!exactKeys(probe, ["object_type", "name", "before_sql_sha256", "create_sql_sha256", "migration_names"]) ||
        !["table", "index", "trigger", "view"].includes(probe.object_type) ||
        typeof probe.name !== "string" || !SCHEMA_NAME.test(probe.name) || probe.name.toLowerCase().startsWith("sqlite_") ||
        !(probe.before_sql_sha256 === null || HASH.test(probe.before_sql_sha256)) ||
        !HASH.test(probe.create_sql_sha256) || !validMigrationNames(probe.migration_names)) return false;
    const identity = `${probe.object_type}\u0000${probe.name.toLowerCase()}`;
    if (unique.has(identity) || probe.migration_names.some((name) => !migrationNames.includes(name))) return false;
    unique.add(identity);
    for (const name of probe.migration_names) covered.add(name);
  }
  return migrationNames.every((name) => covered.has(name));
}

export function validateDeploymentMigrationIntent(intent) {
  const keys = ["protocol", "intent_id", "account_id", "generated_config_sha256", "database",
    "migration_names", "migration_hashes", "local_migration_bundle_sha256", "risk_review",
    "schema_probes", "max_migrations", "max_sql_bytes", "deadline_at", "max_runtime_ms"];
  if (!exactKeys(intent, keys) || intent.protocol !== INTENT_PROTOCOL || !UUID.test(intent.intent_id ?? "") ||
      !ACCOUNT.test(intent.account_id ?? "") || !HASH.test(intent.generated_config_sha256 ?? "") ||
      !HASH.test(intent.local_migration_bundle_sha256 ?? "") ||
      !exactKeys(intent.database, ["binding", "database_name", "database_id"]) ||
      !["CORE_DB", "SEARCH_DB"].includes(intent.database.binding) ||
      intent.database.database_name !== (intent.database.binding === "CORE_DB" ? "eliotr-core" : "eliotr-search") ||
      !DATABASE_NAME.test(intent.database.database_name) || !UUID.test(intent.database.database_id ?? "") ||
      !validMigrationNames(intent.migration_names) || !Array.isArray(intent.migration_hashes) ||
      intent.migration_hashes.length !== intent.migration_names.length ||
      !intent.migration_hashes.every((entry, index) => exactKeys(entry, ["name", "sha256"]) &&
        entry.name === intent.migration_names[index] && HASH.test(entry.sha256 ?? "")) ||
      !exactKeys(intent.risk_review, ["classification", "summary", "reviewed_bundle_sha256", "index_build_cost_reviewed"]) ||
      !["additive_schema_only", "schema_metadata_only", "data_preserving_bounded_copy_rebuild"]
        .includes(intent.risk_review.classification) ||
      typeof intent.risk_review.summary !== "string" || intent.risk_review.summary.trim().length < 16 ||
      intent.risk_review.summary.length > 512 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/u.test(intent.risk_review.summary) ||
      intent.risk_review.reviewed_bundle_sha256 !== sha256(JSON.stringify(intent.migration_hashes)) ||
      typeof intent.risk_review.index_build_cost_reviewed !== "boolean" ||
      !validateSchemaProbes(intent.schema_probes, intent.migration_names) ||
      !Number.isSafeInteger(intent.max_migrations) || intent.max_migrations !== intent.migration_names.length ||
      !Number.isSafeInteger(intent.max_sql_bytes) || intent.max_sql_bytes < 1 || intent.max_sql_bytes > MAX_APPROVED_SQL_BYTES ||
      !isoDate(intent.deadline_at) || !Number.isSafeInteger(intent.max_runtime_ms) ||
      intent.max_runtime_ms < 1000 || intent.max_runtime_ms > MAX_RUNTIME_MS ||
      Buffer.byteLength(canonicalJson(intent), "utf8") > MAX_INTENT_BYTES) {
    fail("Invalid or unsupported versioned D1 migration intent");
  }
  return intent;
}

function tokens(sql) {
  const result = [];
  const wordPattern = /[A-Za-z_][A-Za-z0-9_$]*/uy;
  for (let index = 0; index < sql.length;) {
    const char = sql[index];
    if (/\s/u.test(char)) { index += 1; continue; }
    if (char === "-" && sql[index + 1] === "-") {
      index += 2;
      while (index < sql.length && sql[index] !== "\n" && sql[index] !== "\r") index += 1;
      continue;
    }
    if (char === "/" && sql[index + 1] === "*") {
      const end = sql.indexOf("*/", index + 2);
      if (end < 0) fail("Unterminated SQL comment in approved migration");
      index = end + 2;
      continue;
    }
    if (char === "'" || char === "\"" || char === "`" || char === "[") {
      const close = char === "[" ? "]" : char;
      let value = "";
      let closed = false;
      index += 1;
      while (index < sql.length) {
        if (sql[index] === close) {
          if (sql[index + 1] === close && char !== "[") { value += close; index += 2; continue; }
          index += 1;
          closed = true;
          break;
        }
        value += sql[index];
        index += 1;
      }
      if (!closed) fail("Unterminated quoted SQL token in approved migration");
      if (result.length >= 100_000) fail("Migration SQL exceeds the bounded token admission limit");
      result.push({ type: char === "'" ? "literal" : "identifier", value });
      continue;
    }
    wordPattern.lastIndex = index;
    const word = wordPattern.exec(sql);
    if (word) {
      if (result.length >= 100_000) fail("Migration SQL exceeds the bounded token admission limit");
      result.push({ type: "word", value: word[0].toUpperCase(), raw: word[0] });
      index += word[0].length;
      continue;
    }
    if (result.length >= 100_000) fail("Migration SQL exceeds the bounded token admission limit");
    result.push({ type: "symbol", value: char });
    index += 1;
  }
  return result;
}

function splitSqlStatements(sqlTokens) {
  const statements = [];
  let statement = [];
  const firstWords = [];
  let trigger = false;
  let triggerBody = false;
  const triggerBlocks = [];
  const finish = () => {
    if (statement.length > 0) statements.push(statement);
    statement = [];
    firstWords.length = 0;
    trigger = false;
    triggerBody = false;
    triggerBlocks.length = 0;
  };
  for (const token of sqlTokens) {
    if (token.type === "symbol" && token.value === ";" && (!trigger || (triggerBody && triggerBlocks.length === 0))) {
      finish();
      continue;
    }
    statement.push(token);
    if (token.type === "word" && firstWords.length < 2) firstWords.push(token.value);
    if (firstWords[0] === "CREATE" && firstWords[1] === "TRIGGER") trigger = true;
    if (trigger && token.type === "word") {
      if (!triggerBody && token.value === "BEGIN") {
        triggerBody = true;
        triggerBlocks.push("BEGIN");
      } else if (triggerBody && token.value === "CASE") triggerBlocks.push("CASE");
      else if (triggerBody && token.value === "END" && triggerBlocks.length > 0) triggerBlocks.pop();
    }
  }
  if (trigger && (!triggerBody || triggerBlocks.length !== 0)) fail("Unbalanced SQL trigger body in approved migration");
  finish();
  return statements;
}

function identifierAt(statement, index) {
  const token = statement[index];
  if (token === undefined || (token.type !== "word" && token.type !== "identifier") || !SCHEMA_NAME.test(token.value)) return null;
  return token.type === "word" ? token.raw : token.value;
}

function wordAt(statement, index, expected) {
  return statement[index]?.type === "word" && statement[index].value === expected;
}

function nameAfterCreate(statement, objectType) {
  if (!wordAt(statement, 0, "CREATE") || !wordAt(statement, 1, objectType.toUpperCase())) return null;
  let index = 2;
  if (wordAt(statement, index, "IF") && wordAt(statement, index + 1, "NOT") && wordAt(statement, index + 2, "EXISTS")) index += 3;
  const name = identifierAt(statement, index);
  return name !== null && !consumeAt(statement, index + 1, ".") ? name : null;
}

function parseDrop(statement) {
  if (!wordAt(statement, 0, "DROP") || !(wordAt(statement, 1, "TRIGGER") || wordAt(statement, 1, "VIEW"))) return null;
  let index = 2;
  if (wordAt(statement, index, "IF") && wordAt(statement, index + 1, "EXISTS")) index += 2;
  const name = identifierAt(statement, index++);
  return name === null || index !== statement.length ? null : { object_type: statement[1].value.toLowerCase(), name };
}

function consumeWord(statement, state, expected) {
  if (!wordAt(statement, state.index, expected)) return false;
  state.index += 1;
  return true;
}

function consumeSymbol(statement, state, expected) {
  if (statement[state.index]?.type !== "symbol" || statement[state.index].value !== expected) return false;
  state.index += 1;
  return true;
}

function consumeIdentifier(statement, state, expected) {
  const value = identifierAt(statement, state.index);
  if (value === null || (expected !== undefined && value.toLowerCase() !== expected)) return false;
  state.index += 1;
  return expected ?? value;
}

function consumeLiteral(statement, state, { pattern = null, maxLength = 512 } = {}) {
  const token = statement[state.index];
  if (token?.type !== "literal" || token.value.length > maxLength || (pattern !== null && !pattern.test(token.value))) return null;
  state.index += 1;
  return token.value;
}

function parseTimestampFunction(statement, state) {
  return consumeWord(statement, state, "STRFTIME") && consumeSymbol(statement, state, "(") &&
    consumeLiteral(statement, state) === "%Y-%m-%dT%H:%M:%fZ" && consumeSymbol(statement, state, ",") &&
    consumeLiteral(statement, state) === "now" && consumeSymbol(statement, state, ")");
}

function parseTimestampValue(statement, state) {
  const start = state.index;
  if (parseTimestampFunction(statement, state)) return true;
  state.index = start;
  return consumeLiteral(statement, state, { pattern: /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/u, maxLength: 32 }) !== null;
}

function parseSchemaStateInsert(statement) {
  const state = { index: 0 };
  if (!consumeWord(statement, state, "INSERT") || !consumeWord(statement, state, "INTO") ||
      !consumeIdentifier(statement, state, "schema_state") || !consumeSymbol(statement, state, "(") ||
      !consumeIdentifier(statement, state, "key") || !consumeSymbol(statement, state, ",") ||
      !consumeIdentifier(statement, state, "value") || !consumeSymbol(statement, state, ",") ||
      !consumeIdentifier(statement, state, "updated_at") || !consumeSymbol(statement, state, ")") ||
      !consumeWord(statement, state, "VALUES") || !consumeSymbol(statement, state, "(")) return null;
  const key = consumeLiteral(statement, state, { pattern: /^[A-Za-z0-9_:-]{1,128}$/u, maxLength: 128 });
  if (key === null || !consumeSymbol(statement, state, ",")) return null;
  const value = consumeLiteral(statement, state, { maxLength: 512 });
  if (value === null || !consumeSymbol(statement, state, ",") || !parseTimestampValue(statement, state) ||
      !consumeSymbol(statement, state, ")")) return null;
  if (state.index < statement.length) {
    if (!consumeWord(statement, state, "ON") || !consumeWord(statement, state, "CONFLICT") ||
        !consumeSymbol(statement, state, "(") || !consumeIdentifier(statement, state, "key") ||
        !consumeSymbol(statement, state, ")") || !consumeWord(statement, state, "DO") ||
        !consumeWord(statement, state, "UPDATE") || !consumeWord(statement, state, "SET") ||
        !consumeIdentifier(statement, state, "value") || !consumeSymbol(statement, state, "=") ||
        !consumeIdentifier(statement, state, "excluded") || !consumeSymbol(statement, state, ".") ||
        !consumeIdentifier(statement, state, "value") || !consumeSymbol(statement, state, ",") ||
        !consumeIdentifier(statement, state, "updated_at") || !consumeSymbol(statement, state, "=") ||
        !consumeIdentifier(statement, state, "excluded") || !consumeSymbol(statement, state, ".") ||
        !consumeIdentifier(statement, state, "updated_at")) return null;
  }
  return state.index === statement.length ? { key, value } : null;
}

function parseSchemaStateUpdate(statement) {
  const state = { index: 0 };
  if (!consumeWord(statement, state, "UPDATE") || !consumeIdentifier(statement, state, "schema_state") ||
      !consumeWord(statement, state, "SET") || !consumeIdentifier(statement, state, "value") ||
      !consumeSymbol(statement, state, "=")) return null;
  const value = consumeLiteral(statement, state, { maxLength: 512 });
  if (value === null || !consumeSymbol(statement, state, ",") ||
      !consumeIdentifier(statement, state, "updated_at") || !consumeSymbol(statement, state, "=") ||
      !parseTimestampValue(statement, state) || !consumeWord(statement, state, "WHERE") ||
      !consumeIdentifier(statement, state, "key") || !consumeSymbol(statement, state, "=")) return null;
  const key = consumeLiteral(statement, state, { pattern: /^[A-Za-z0-9_:-]{1,128}$/u, maxLength: 128 });
  return key !== null && state.index === statement.length ? { key, value } : null;
}

function pragmaForeignKeysOn(statement) {
  return statement.length === 4 && wordAt(statement, 0, "PRAGMA") && wordAt(statement, 1, "FOREIGN_KEYS") &&
    statement[2]?.type === "symbol" && statement[2].value === "=" && wordAt(statement, 3, "ON");
}

function viewDefinition(statement) {
  if (!wordAt(statement, 0, "CREATE") || !wordAt(statement, 1, "VIEW")) return null;
  let index = 2;
  if (wordAt(statement, index, "IF") && wordAt(statement, index + 1, "NOT") && wordAt(statement, index + 2, "EXISTS")) index += 3;
  const name = identifierAt(statement, index++);
  if (name === null || consumeAt(statement, index, ".")) return null;
  if (consumeAt(statement, index, "(")) {
    const close = matchingParenEnd(statement, index);
    if (close < 0) return null;
    index = close + 1;
  }
  return wordAt(statement, index, "AS") && index + 1 < statement.length ? name : null;
}

function triggerDefinition(statement) {
  const name = nameAfterCreate(statement, "trigger");
  return name !== null && statement.some((token, index) => index > 1 && token.type === "word" && token.value === "BEGIN")
    ? name : null;
}

function consumeAt(statement, index, symbol) {
  return statement[index]?.type === "symbol" && statement[index].value === symbol;
}

function createTableDefinition(statement) {
  if (!wordAt(statement, 0, "CREATE") || !wordAt(statement, 1, "TABLE")) return null;
  let index = 2;
  if (wordAt(statement, index, "IF") && wordAt(statement, index + 1, "NOT") && wordAt(statement, index + 2, "EXISTS")) index += 3;
  const name = identifierAt(statement, index++);
  if (name === null || !consumeAt(statement, index, "(")) return null;
  const open = index;
  let depth = 0;
  let close = -1;
  for (; index < statement.length; index += 1) {
    const token = statement[index];
    if (token.type !== "symbol") continue;
    if (token.value === "(") depth += 1;
    else if (token.value === ")") {
      depth -= 1;
      if (depth === 0) { close = index; break; }
      if (depth < 0) return null;
    }
  }
  if (close <= open + 1) return null;
  const suffix = statement.slice(close + 1);
  const suffixWords = suffix.map((token) => token.type === "word" ? token.value : token.value);
  const allowedSuffix = [[], ["STRICT"], ["WITHOUT", "ROWID"], ["WITHOUT", "ROWID", ",", "STRICT"],
    ["STRICT", ",", "WITHOUT", "ROWID"]];
  return allowedSuffix.some((candidate) => JSON.stringify(candidate) === JSON.stringify(suffixWords)) ? name : null;
}

function matchingParenEnd(statement, open) {
  if (!consumeAt(statement, open, "(")) return -1;
  let depth = 0;
  for (let index = open; index < statement.length; index += 1) {
    const token = statement[index];
    if (token.type !== "symbol") continue;
    if (token.value === "(") depth += 1;
    else if (token.value === ")" && --depth === 0) return index;
  }
  return -1;
}

function createIndexDefinition(statement) {
  if (!wordAt(statement, 0, "CREATE")) return null;
  let index = 1;
  if (wordAt(statement, index, "UNIQUE")) index += 1;
  if (!wordAt(statement, index++, "INDEX")) return null;
  if (wordAt(statement, index, "IF") && wordAt(statement, index + 1, "NOT") && wordAt(statement, index + 2, "EXISTS")) index += 3;
  const name = identifierAt(statement, index++);
  if (name === null || !wordAt(statement, index++, "ON")) return null;
  const table = identifierAt(statement, index++);
  if (table === null) return null;
  const close = matchingParenEnd(statement, index);
  const noPredicate = close === statement.length - 1;
  const partialPredicate = wordAt(statement, close + 1, "WHERE") && close + 2 < statement.length;
  return close > index + 1 && (noPredicate || partialPredicate) ? { name, table } : null;
}

function alterAddColumnDefinition(statement) {
  const state = { index: 0 };
  if (!consumeWord(statement, state, "ALTER") || !consumeWord(statement, state, "TABLE") ||
      !consumeIdentifier(statement, state) || !consumeWord(statement, state, "ADD")) return null;
  consumeWord(statement, state, "COLUMN");
  if (!consumeIdentifier(statement, state)) return null;
  const types = new Set(["TEXT", "INTEGER", "INT", "REAL", "BLOB", "NUMERIC", "BOOLEAN", "JSON", "DATE", "DATETIME", "DECIMAL"]);
  if (statement[state.index]?.type === "word" && types.has(statement[state.index].value)) state.index += 1;
  let notNull = false;
  let defaultValue = false;
  while (state.index < statement.length) {
    if (!notNull && consumeWord(statement, state, "NOT")) {
      if (!consumeWord(statement, state, "NULL")) return null;
      notNull = true;
    } else if (!defaultValue && consumeWord(statement, state, "DEFAULT")) {
      const token = statement[state.index];
      if (token?.type === "literal" || (token?.type === "word" && token.value === "NULL")) {
        state.index += 1;
      } else {
        const number = [];
        while (state.index < statement.length && statement[state.index].type === "symbol" && /^[\d.+-]$/u.test(statement[state.index].value)) {
          number.push(statement[state.index++].value);
        }
        if (number.length === 0 || !/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/u.test(number.join(""))) return null;
      }
      defaultValue = true;
    } else return null;
  }
  return state.index === statement.length ? true : null;
}

function sameSqlTokens(left, right) {
  return left.length === right.length && left.every((token, index) =>
    token.type === right[index].type && token.value === right[index].value);
}

function singleSqlStatement(text) {
  const statements = splitSqlStatements(tokens(text));
  return statements.length === 1 ? statements[0] : null;
}

function tableColumnCheckRange(statement, columnName) {
  const open = statement.findIndex((token) => token.type === "symbol" && token.value === "(");
  const close = open < 0 ? -1 : matchingParenEnd(statement, open);
  if (close < 0) return null;
  let segmentStart = open + 1;
  let depth = 0;
  for (let index = open + 1; index <= close; index += 1) {
    if (index === close || (depth === 0 && consumeAt(statement, index, ","))) {
      const segment = statement.slice(segmentStart, index);
      if (identifierAt(segment, 0)?.toLowerCase() === columnName.toLowerCase()) {
        const checkIndex = segment.findIndex((token) => token.type === "word" && token.value === "CHECK");
        if (checkIndex < 0 || !consumeAt(segment, checkIndex + 1, "(")) return null;
        const checkEnd = matchingParenEnd(segment, checkIndex + 1);
        if (checkEnd !== segment.length - 1) return null;
        return { start: segmentStart + checkIndex, end: segmentStart + checkEnd + 1 };
      }
      segmentStart = index + 1;
      continue;
    }
    if (consumeAt(statement, index, "(")) depth += 1;
    else if (consumeAt(statement, index, ")")) depth -= 1;
  }
  return null;
}

function expectedRepairedSemanticRevisionTable(baselineStatement) {
  if (createTableDefinition(baselineStatement) !== EMPTY_SEMANTIC_REVISION_REPAIR.targetName) return null;
  const repair = EMPTY_SEMANTIC_REVISION_REPAIR;
  const expected = [...baselineStatement];
  expected[2] = { type: "word", value: repair.replacementName.toUpperCase(), raw: repair.replacementName };
  const replacementChecks = [
    { column: "revision_ref",
      sql: "CHECK (length(revision_ref) = 16 AND substr(revision_ref, 1, 4) = 'scr-' AND substr(revision_ref, 5) NOT GLOB '*[^0-9a-f]*')" },
    { column: "config_sha256",
      sql: "CHECK (length(config_sha256) = 64 AND config_sha256 NOT GLOB '*[^0-9a-f]*')" },
  ].map((entry) => ({ ...entry, range: tableColumnCheckRange(baselineStatement, entry.column),
    tokens: tokens(entry.sql) }));
  if (replacementChecks.some((entry) => entry.range === null)) return null;
  for (const entry of replacementChecks.sort((left, right) => right.range.start - left.range.start)) {
    expected.splice(entry.range.start, entry.range.end - entry.range.start, ...entry.tokens);
  }
  return expected;
}

function classifyEmptySemanticRevisionRepair(statements, { earlierCreatedTables, baselineMigrationSql }) {
  const repair = EMPTY_SEMANTIC_REVISION_REPAIR;
  if (typeof baselineMigrationSql !== "string" ||
      sha256(Buffer.from(baselineMigrationSql, "utf8")) !== repair.baselineSha256) {
    fail("Empty semantic revision repair requires the exact immutable 0097 source schema");
  }
  const baselineStatements = splitSqlStatements(tokens(baselineMigrationSql));
  const baselineTables = baselineStatements.filter((statement) =>
    createTableDefinition(statement) === repair.targetName);
  const baselineTriggers = new Map(baselineStatements.map((statement) => [triggerDefinition(statement), statement])
    .filter(([name]) => name !== null));
  if (baselineTables.length !== 1 || baselineTriggers.size !== 2 ||
      !baselineTriggers.has(repair.updateTriggerName) || !baselineTriggers.has(repair.deleteTriggerName)) {
    fail("Immutable semantic revision source schema differs from the reviewed repair baseline");
  }
  const reservedNames = new Set([repair.targetName, repair.replacementName, repair.guardName]
    .map((name) => name.toLowerCase()));
  if (earlierCreatedTables.some((name) => reservedNames.has(name.toLowerCase()))) {
    fail("Empty semantic revision repair conflicts with an earlier migration-created table");
  }
  const expectedStatements = [
    "CREATE TABLE " + repair.guardName + " (empty_confirmed INTEGER NOT NULL CHECK (empty_confirmed = 1)) STRICT",
    "INSERT INTO " + repair.guardName + " (empty_confirmed) SELECT CASE WHEN NOT EXISTS (SELECT 1 FROM " +
      repair.targetName + " LIMIT 1) THEN 1 ELSE 0 END",
    "DROP TABLE " + repair.guardName,
    "DROP TABLE " + repair.targetName,
    "ALTER TABLE " + repair.replacementName + " RENAME TO " + repair.targetName,
  ].map(singleSqlStatement);
  const expectedReplacementTable = expectedRepairedSemanticRevisionTable(baselineTables[0]);
  if (statements.length !== 8 || expectedStatements.some((expected) => expected === null) ||
      expectedReplacementTable === null ||
      !sameSqlTokens(statements[0], expectedStatements[0]) ||
      !sameSqlTokens(statements[1], expectedStatements[1]) ||
      !sameSqlTokens(statements[2], expectedStatements[2]) ||
      !sameSqlTokens(statements[4], expectedStatements[3]) ||
      !sameSqlTokens(statements[5], expectedStatements[4]) ||
      !sameSqlTokens(statements[3], expectedReplacementTable)) {
    fail("Migration is outside the exact guarded empty semantic revision repair");
  }
  const expectedTriggerNames = [repair.updateTriggerName, repair.deleteTriggerName];
  for (const [index, name] of expectedTriggerNames.entries()) {
    const actual = statements[index + 6];
    if (triggerDefinition(actual) !== name || !sameSqlTokens(actual, baselineTriggers.get(name))) {
      fail("Semantic revision repair must preserve both immutable source triggers exactly");
    }
  }
  const required = [
    { object_type: "table", name: repair.targetName },
    { object_type: "trigger", name: repair.updateTriggerName },
    { object_type: "trigger", name: repair.deleteTriggerName },
  ];
  return Object.freeze({
    classification: "schema_metadata_only",
    statement_count: statements.length,
    index_build_cost_reviewed: false,
    newly_created_tables: Object.freeze([]),
    required_schema_objects: Object.freeze(required.map((entry) => Object.freeze(entry))),
    created_schema_objects: Object.freeze(required.map((entry) =>
      Object.freeze({ ...entry, replacement: true }))),
    must_probe_schema_objects: Object.freeze(required.map((entry) => Object.freeze(entry))),
    metadata_markers: Object.freeze([]),
    bounded_metadata_writes: 0,
  });
}

function classifyBoundedStageOperationCopyRebuild(text, statements, { baselineMigrationSql, predecessorMigrationHashes }) {
  const repair = BOUNDED_STAGE_OPERATION_COPY_REBUILD;
  if (sha256(Buffer.from(text, "utf8")) !== repair.migrationSha256) {
    fail("Stage-operation rebuild requires its exact bounded-copy SQL bytes");
  }
  if (typeof baselineMigrationSql !== "string" ||
      sha256(Buffer.from(baselineMigrationSql, "utf8")) !== repair.predecessorPins[0].sha256) {
    fail("Stage-operation rebuild requires the exact immutable 0110 source schema");
  }
  if (!Array.isArray(predecessorMigrationHashes) ||
      predecessorMigrationHashes.length !== repair.predecessorPins.length ||
      !predecessorMigrationHashes.every((entry, index) => exactKeys(entry, ["name", "sha256"]) &&
        entry.name === repair.predecessorPins[index].name && entry.sha256 === repair.predecessorPins[index].sha256)) {
    fail("Stage-operation rebuild requires exact 0110-0112 predecessor migration pins");
  }

  const baselineTables = splitSqlStatements(tokens(baselineMigrationSql)).filter((statement) =>
    createTableDefinition(statement) === repair.targetName);
  const createdTriggers = statements.map(triggerDefinition).filter((name) => name !== null);
  const droppedTriggers = statements.map(parseDrop).filter((entry) => entry?.object_type === "trigger").map((entry) => entry.name);
  const expectedTriggerSet = new Set(repair.triggerNames.map((name) => name.toLowerCase()));
  const observedCreatedTriggerSet = new Set(createdTriggers.map((name) => name.toLowerCase()));
  const observedDroppedTriggerSet = new Set(droppedTriggers.map((name) => name.toLowerCase()));
  const createdTables = statements.map(createTableDefinition).filter((name) => name !== null);
  const droppedTargetTableCount = statements.filter((statement) => statement.length === 3 &&
    wordAt(statement, 0, "DROP") && wordAt(statement, 1, "TABLE") &&
    identifierAt(statement, 2)?.toLowerCase() === repair.targetName.toLowerCase()).length;
  if (baselineTables.length !== 1 || createdTables.filter((name) =>
      name.toLowerCase() === repair.replacementName.toLowerCase()).length !== 1 || droppedTargetTableCount !== 1 ||
      createdTriggers.length !== expectedTriggerSet.size || droppedTriggers.length !== expectedTriggerSet.size ||
      observedCreatedTriggerSet.size !== expectedTriggerSet.size || observedDroppedTriggerSet.size !== expectedTriggerSet.size ||
      [...expectedTriggerSet].some((name) => !observedCreatedTriggerSet.has(name) || !observedDroppedTriggerSet.has(name))) {
    fail("Stage-operation rebuild differs from the exact bounded table and nine-trigger replacement");
  }

  const replacements = [
    { object_type: "table", name: repair.targetName },
    ...repair.triggerNames.map((name) => ({ object_type: "trigger", name })),
  ];
  const required = [
    ...replacements,
    { object_type: "table", name: repair.parentTableName },
    ...repair.childTableNames.map((name) => ({ object_type: "table", name })),
  ];
  return Object.freeze({
    classification: "data_preserving_bounded_copy_rebuild",
    statement_count: statements.length,
    index_build_cost_reviewed: false,
    newly_created_tables: Object.freeze([]),
    required_schema_objects: Object.freeze(required.map((entry) => Object.freeze(entry))),
    created_schema_objects: Object.freeze(replacements.map((entry) =>
      Object.freeze({ ...entry, replacement: true }))),
    must_probe_schema_objects: Object.freeze(replacements.map((entry) => Object.freeze(entry))),
    metadata_markers: Object.freeze([]),
    bounded_metadata_writes: 0,
    bounded_copy: Object.freeze({
      table: repair.targetName,
      maximum_rows: repair.maximumRows,
      maximum_scanned_rows: repair.maximumScannedRows,
      maximum_field_payload_bytes: repair.maximumFieldPayloadBytes,
    }),
  });
}

export function classifyDeploymentMigrationSql(text, { earlierCreatedTables = [], migrationName = null,
  baselineMigrationSql = null, predecessorMigrationHashes = null } = {}) {
  if (typeof text !== "string" || !Array.isArray(earlierCreatedTables) || earlierCreatedTables.length > 64 ||
      earlierCreatedTables.some((name) => typeof name !== "string" || !SCHEMA_NAME.test(name))) {
    fail("Invalid input to the scoped D1 migration SQL classifier");
  }
  const statements = splitSqlStatements(tokens(text));
  if (statements.length === 0) fail("Empty SQL migration is outside the supported maintenance profile");
  if (migrationName === EMPTY_SEMANTIC_REVISION_REPAIR.migrationName) {
    return classifyEmptySemanticRevisionRepair(statements, { earlierCreatedTables, baselineMigrationSql });
  }
  if (migrationName === BOUNDED_STAGE_OPERATION_COPY_REBUILD.migrationName) {
    return classifyBoundedStageOperationCopyRebuild(text, statements, { baselineMigrationSql, predecessorMigrationHashes });
  }
  const createdTables = new Set(earlierCreatedTables.map((name) => name.toLowerCase()));
  const newlyCreatedTables = [];
  const createdObjects = new Map();
  const droppedObjects = [];
  const requiredSchemaObjects = [];
  const mustProbeSchemaObjects = [];
  const metadataMarkers = new Map();
  let hasMetadataOperation = false;
  let hasIndexBuild = false;
  const registerCreated = (objectType, name, statementIndex) => {
    if (name.toLowerCase().startsWith("sqlite_")) fail("SQLite internal schema objects are outside the migration profile");
    const key = `${objectType}:${name.toLowerCase()}`;
    if (createdObjects.has(key)) fail("A migration may create each reviewed schema object only once");
    createdObjects.set(key, { object_type: objectType, name, statement_index: statementIndex });
  };
  const addRequired = (objectType, name) => {
    if (!requiredSchemaObjects.some((entry) => entry.object_type === objectType && entry.name.toLowerCase() === name.toLowerCase())) {
      requiredSchemaObjects.push({ object_type: objectType, name });
    }
  };

  for (const [statementIndex, statement] of statements.entries()) {
    if (pragmaForeignKeysOn(statement)) { hasMetadataOperation = true; continue; }
    const metadataInsert = parseSchemaStateInsert(statement);
    if (metadataInsert !== null) {
      hasMetadataOperation = true;
      if (!metadataMarkers.has(metadataInsert.key) && metadataMarkers.size >= 64) fail("Migration writes too many bounded schema markers");
      metadataMarkers.set(metadataInsert.key, metadataInsert.value);
      addRequired("table", "schema_state");
      continue;
    }
    const metadataUpdate = parseSchemaStateUpdate(statement);
    if (metadataUpdate !== null) {
      hasMetadataOperation = true;
      if (!metadataMarkers.has(metadataUpdate.key) && metadataMarkers.size >= 64) fail("Migration writes too many bounded schema markers");
      metadataMarkers.set(metadataUpdate.key, metadataUpdate.value);
      addRequired("table", "schema_state");
      continue;
    }

    const table = createTableDefinition(statement);
    if (table !== null) {
      if (createdTables.has(table.toLowerCase())) fail("A migration cannot redefine a table already in this approved set");
      if (createdTables.size >= 64) fail("Approved migration set exceeds the bounded table preflight");
      createdTables.add(table.toLowerCase());
      newlyCreatedTables.push(table);
      registerCreated("table", table, statementIndex);
      addRequired("table", table);
      continue;
    }

    const view = viewDefinition(statement);
    if (view !== null) {
      hasMetadataOperation = true;
      registerCreated("view", view, statementIndex);
      addRequired("view", view);
      continue;
    }

    const trigger = triggerDefinition(statement);
    if (trigger !== null) {
      hasMetadataOperation = true;
      registerCreated("trigger", trigger, statementIndex);
      addRequired("trigger", trigger);
      continue;
    }

    const drop = parseDrop(statement);
    if (drop !== null) {
      hasMetadataOperation = true;
      if (drop.name.toLowerCase().startsWith("sqlite_") ||
          droppedObjects.some((entry) => entry.object_type === drop.object_type && entry.name.toLowerCase() === drop.name.toLowerCase())) {
        fail("A migration may drop each reviewed schema object only once");
      }
      droppedObjects.push({ ...drop, statement_index: statementIndex });
      continue;
    }

    const firstWords = statement.filter((token) => token.type === "word").slice(0, 3).map((token) => token.value);
    if (firstWords[0] === "CREATE" && (firstWords[1] === "INDEX" ||
        (firstWords[1] === "UNIQUE" && firstWords[2] === "INDEX"))) {
      const definition = createIndexDefinition(statement);
      if (definition === null || !createdTables.has(definition.table.toLowerCase())) {
        fail("CREATE INDEX over an existing table is outside the bounded maintenance profile");
      }
      hasIndexBuild = true;
      registerCreated("index", definition.name, statementIndex);
      addRequired("index", definition.name);
      continue;
    }

    if (firstWords[0] === "ALTER" && firstWords[1] === "TABLE") {
      const tableName = identifierAt(statement, 2);
      if (tableName === null || alterAddColumnDefinition(statement) !== true) {
        fail("Only bounded ALTER TABLE ADD COLUMN without table scans is supported");
      }
      addRequired("table", tableName);
      continue;
    }

    fail("Migration contains SQL outside the reviewed schema-only allowlist");
  }

  for (const dropped of droppedObjects) {
    const key = `${dropped.object_type}:${dropped.name.toLowerCase()}`;
    const created = createdObjects.get(key);
    if (created === undefined || dropped.statement_index >= created.statement_index ||
        !["trigger", "view"].includes(dropped.object_type)) {
      fail("DROP is supported only before a same-migration named trigger/view replacement");
    }
    addRequired(dropped.object_type, dropped.name);
    mustProbeSchemaObjects.push({ object_type: dropped.object_type, name: created.name });
  }
  if (requiredSchemaObjects.length > 64) fail("Migration requires more schema probes than the bounded readback supports");
  const classification = hasMetadataOperation ? "schema_metadata_only" : "additive_schema_only";
  return Object.freeze({ classification, statement_count: statements.length,
    index_build_cost_reviewed: hasIndexBuild, newly_created_tables: Object.freeze(newlyCreatedTables),
    required_schema_objects: Object.freeze(requiredSchemaObjects.map((entry) => Object.freeze(entry))),
    created_schema_objects: Object.freeze([...createdObjects.values()].map((entry) => Object.freeze({
      object_type: entry.object_type, name: entry.name,
      replacement: droppedObjects.some((drop) => drop.object_type === entry.object_type &&
        drop.name.toLowerCase() === entry.name.toLowerCase()),
    }))),
    must_probe_schema_objects: Object.freeze(mustProbeSchemaObjects.map((entry) => Object.freeze(entry))),
    metadata_markers: Object.freeze([...metadataMarkers].map(([key, value]) => Object.freeze({ key, value }))),
    bounded_metadata_writes: statements.filter((statement) => parseSchemaStateInsert(statement) !== null ||
      parseSchemaStateUpdate(statement) !== null).length });
}

async function readPendingSql(intent, root, localBundle, read) {
  const entries = new Map(localBundle.migration_entries.map((entry) => [entry.name, entry]));
  const pending = [];
  let totalBytes = 0;
  let indexBuildCostReviewed = false;
  let classification = "additive_schema_only";
  const createdTables = [];
  const requiredObjectsByMigration = [];
  const metadataMarkers = new Map();
  const firstCreatedObjects = new Map();
  for (let index = 0; index < intent.migration_names.length; index += 1) {
    const name = intent.migration_names[index];
    const local = entries.get(name);
    const approved = intent.migration_hashes[index];
    if (local === undefined || approved.name !== name || local.sha256 !== approved.sha256) {
      fail("Approved migration bytes differ from the frozen local bundle");
    }
    const bytes = await read(resolve(root, "infra/d1", intent.database.binding === "CORE_DB" ? "core" : "search", "migrations", name));
    if (sha256(bytes) !== approved.sha256) fail("Approved migration changed while preparing the operation");
    totalBytes += bytes.byteLength;
    if (totalBytes > intent.max_sql_bytes) fail("Pending migration SQL exceeds the approved byte budget");
    let sql;
    try { sql = new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
    catch { fail("Migration SQL is not valid UTF-8"); }
    let baselineMigrationSql = null;
    let predecessorMigrationHashes = null;
    if (name === EMPTY_SEMANTIC_REVISION_REPAIR.migrationName) {
      const baseline = entries.get(EMPTY_SEMANTIC_REVISION_REPAIR.baselineName);
      if (baseline === undefined) fail("Empty semantic revision repair is missing its pinned 0097 baseline migration");
      const baselineBytes = await read(resolve(root, "infra/d1/core/migrations",
        EMPTY_SEMANTIC_REVISION_REPAIR.baselineName));
      if (sha256(baselineBytes) !== baseline.sha256) {
        fail("Immutable semantic revision source schema differs from its migration bundle pin");
      }
      try { baselineMigrationSql = new TextDecoder("utf-8", { fatal: true }).decode(baselineBytes); }
      catch { fail("Immutable semantic revision source schema is not valid UTF-8"); }
    } else if (name === BOUNDED_STAGE_OPERATION_COPY_REBUILD.migrationName) {
      predecessorMigrationHashes = [];
      for (const pin of BOUNDED_STAGE_OPERATION_COPY_REBUILD.predecessorPins) {
        const predecessor = entries.get(pin.name);
        if (predecessor === undefined || predecessor.sha256 !== pin.sha256) {
          fail("Stage-operation rebuild is missing an exact 0110-0112 predecessor migration pin");
        }
        const predecessorBytes = await read(resolve(root, "infra/d1/core/migrations", pin.name));
        if (sha256(predecessorBytes) !== pin.sha256) {
          fail("Stage-operation rebuild predecessor source differs from its reviewed immutable pin");
        }
        predecessorMigrationHashes.push({ name: pin.name, sha256: pin.sha256 });
        if (pin.name === BOUNDED_STAGE_OPERATION_COPY_REBUILD.baselineName) {
          try { baselineMigrationSql = new TextDecoder("utf-8", { fatal: true }).decode(predecessorBytes); }
          catch { fail("Stage-operation rebuild baseline source schema is not valid UTF-8"); }
        }
      }
    }
    let admitted;
    try { admitted = classifyDeploymentMigrationSql(sql, { earlierCreatedTables: createdTables,
      migrationName: name, baselineMigrationSql, predecessorMigrationHashes }); }
    catch (error) { fail(`Unsupported scoped migration SQL in ${name}: ${error.message}`); }
    if (admitted.classification === "data_preserving_bounded_copy_rebuild") {
      classification = admitted.classification;
    } else if (classification !== "data_preserving_bounded_copy_rebuild" &&
        admitted.classification === "schema_metadata_only") {
      classification = admitted.classification;
    }
    indexBuildCostReviewed ||= admitted.index_build_cost_reviewed;
    createdTables.push(...admitted.newly_created_tables);
    for (const object of admitted.created_schema_objects) {
      const key = `${object.object_type}:${object.name.toLowerCase()}`;
      if (!firstCreatedObjects.has(key)) firstCreatedObjects.set(key, object);
    }
    for (const marker of admitted.metadata_markers) metadataMarkers.set(marker.key, marker.value);
    requiredObjectsByMigration.push({ name, required_schema_objects: admitted.required_schema_objects,
      must_probe_schema_objects: admitted.must_probe_schema_objects });
    pending.push({ name, sha256: approved.sha256, byte_length: bytes.byteLength,
      statement_count: admitted.statement_count });
  }
  if (intent.risk_review.index_build_cost_reviewed !== indexBuildCostReviewed ||
      intent.risk_review.classification !== classification) {
    fail("Migration risk review classification or index cost acknowledgment differs from approved SQL");
  }
  for (const migration of requiredObjectsByMigration) {
    for (const object of migration.required_schema_objects) {
      const probe = intent.schema_probes.find((entry) => entry.object_type === object.object_type &&
        entry.name.toLowerCase() === object.name.toLowerCase() && entry.migration_names.includes(migration.name));
      if (probe === undefined) fail(`Missing exact schema contract probe for ${migration.name} ${object.object_type}:${object.name}`);
    }
    for (const object of migration.must_probe_schema_objects) {
      const probe = intent.schema_probes.find((entry) => entry.object_type === object.object_type &&
        entry.name === object.name && entry.migration_names.includes(migration.name));
      if (probe === undefined) fail(`Missing replacement schema probe for ${migration.name} ${object.object_type}:${object.name}`);
    }
  }
  if (createdTables.length > 64) fail("Approved migration set creates more tables than the bounded preflight supports");
  for (const probe of intent.schema_probes) {
    const created = firstCreatedObjects.get(`${probe.object_type}:${probe.name.toLowerCase()}`);
    if (created !== undefined && !created.replacement && probe.before_sql_sha256 !== null) {
      fail("A newly created schema object requires an absence precondition");
    }
    if (created === undefined && probe.before_sql_sha256 === null) {
      fail("An existing schema object requires its exact reviewed initial SQL hash");
    }
  }
  if (metadataMarkers.size > 64) fail("Approved migration set writes more metadata markers than the bounded readback supports");
  return { pending, totalBytes, classification, indexBuildCostReviewed, createdTables, requiredObjectsByMigration,
    metadataMarkers: [...metadataMarkers].sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
      .map(([key, value]) => ({ key, value })) };
}

async function readPinnedLocalPlan(intent, root, read) {
  const configPath = resolve(root, "apps/eliotr-core", CONFIG_NAME);
  const configBytes = await read(configPath);
  if (sha256(configBytes) !== intent.generated_config_sha256) fail("Generated Wrangler config differs from approved intent");
  let config;
  try { config = JSON.parse(configBytes.toString("utf8")); }
  catch { fail("Generated Wrangler config is not valid JSON"); }
  if (!isObject(config) || config.name !== "eliotr-core" || config.preview_urls !== false) {
    fail("Generated Wrangler config is outside the existing Worker deployment profile");
  }
  validateDeploymentMigrationDirectories(config, { root });
  const bundle = await readDeploymentMigrationEntries(config, intent.database.binding, {
    root, maxTotalBytes: MAX_LOCAL_BUNDLE_BYTES,
  });
  if (bundle.database_name !== intent.database.database_name || bundle.database_id !== intent.database.database_id ||
      bundle.local_migration_bundle_sha256 !== intent.local_migration_bundle_sha256) {
    fail("Generated D1 binding or complete local migration bundle differs from approved intent");
  }
  const offset = bundle.migration_names.indexOf(intent.migration_names[0]);
  if (offset < 0 || JSON.stringify(bundle.migration_names.slice(offset)) !== JSON.stringify(intent.migration_names)) {
    fail("Approved migration names are not the complete ordered pending suffix");
  }
  const sql = await readPendingSql(intent, root, bundle, read);
  return { config, configPath, configBytes, bundle, sql };
}

class OperationCommandError extends Error {
  constructor(message, { started = false, status = null, uncertain = false } = {}) {
    super(message);
    this.name = "OperationCommandError";
    this.started = started;
    this.status = status;
    this.uncertain = uncertain;
  }
}

function runChild(command, args, cwd, env, { signal, timeoutMs, captureOutput = false, maxOutputBytes = 256 * 1024,
  onStarted = () => {} } = {}) {
  return new Promise((resolvePromise, rejectPromise) => {
    if (signal?.aborted) {
      rejectPromise(new OperationCommandError("Operation cancelled before command start"));
      return;
    }
    let child;
    let started = false;
    let finished = false;
    let timer;
    let stdout = "";
    let stderr = "";
    const finishError = (error) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      rejectPromise(error);
    };
    const abort = () => {
      try { child?.kill(); } catch { /* The remote effect remains unknown. */ }
      finishError(new OperationCommandError("Operation command cancelled after start", { started, uncertain: started }));
    };
    try {
      child = spawn(command, args, { cwd, env, shell: process.platform === "win32", windowsHide: true,
        stdio: captureOutput ? ["ignore", "pipe", "pipe"] : "inherit" });
      child.once("spawn", () => { started = true; onStarted(); });
      child.once("error", () => finishError(new OperationCommandError("Operation command could not start", { started })));
      if (captureOutput) {
        child.stdout.setEncoding("utf8");
        child.stderr.setEncoding("utf8");
        child.stdout.on("data", (chunk) => {
          stdout += chunk;
          if (Buffer.byteLength(stdout) + Buffer.byteLength(stderr) > maxOutputBytes) abort();
        });
        child.stderr.on("data", (chunk) => {
          stderr += chunk;
          if (Buffer.byteLength(stdout) + Buffer.byteLength(stderr) > maxOutputBytes) abort();
        });
      }
      child.once("close", (status) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
        if (status !== 0) {
          rejectPromise(new OperationCommandError("Operation command returned a nonzero exit", { started, status, uncertain: started }));
        } else resolvePromise({ status, stdout, stderr });
      });
      if (signal) signal.addEventListener("abort", abort, { once: true });
      timer = setTimeout(() => {
        try { child.kill(); } catch { /* The remote effect remains unknown. */ }
        finishError(new OperationCommandError("Operation command exceeded its local deadline", { started, uncertain: started }));
      }, timeoutMs);
    } catch {
      finishError(new OperationCommandError("Operation command could not start", { started }));
    }
  });
}

function cleanChildEnvironment(environment) {
  const env = { ...environment };
  if (env.NODE_OPTIONS !== undefined && env.NODE_OPTIONS !== null) {
    const stripped = stripNodeOptionsLoaderTokens(env.NODE_OPTIONS);
    if (String(stripped).trim() === "") delete env.NODE_OPTIONS;
    else env.NODE_OPTIONS = stripped;
  }
  return env;
}

function receiptPath(root, intentId) {
  return resolve(root, RECEIPT_DIRECTORY, `${intentId}.json`);
}

function validSchemaProbeObservation(value, { before = false } = {}) {
  return exactKeys(value, ["object_type", "name", "expected_sql_sha256", "observed_sql_sha256", "migration_names", "state"]) &&
    ["table", "index", "trigger", "view"].includes(value.object_type) && SCHEMA_NAME.test(value.name) &&
    (HASH.test(value.expected_sql_sha256) || (before && value.expected_sql_sha256 === null)) &&
    (value.observed_sql_sha256 === null || HASH.test(value.observed_sql_sha256)) &&
    validMigrationNames(value.migration_names) && ["PASS", "MISMATCH", "UNAVAILABLE"].includes(value.state);
}

function validMetadataMarkerObservation(value) {
  return exactKeys(value, ["key", "expected_value", "observed_value", "state"]) &&
    typeof value.key === "string" && /^[A-Za-z0-9_:-]{1,128}$/u.test(value.key) &&
    typeof value.expected_value === "string" && value.expected_value.length <= 512 &&
    (value.observed_value === null || (typeof value.observed_value === "string" && value.observed_value.length <= 512)) &&
    ["PASS", "MISMATCH", "UNAVAILABLE"].includes(value.state);
}

function validObservation(value) {
  return exactKeys(value, ["kind", "observed_at", "ledger_state", "applied_names", "pending_names", "schema_state", "schema_probes", "metadata_markers"]) &&
    ["BEFORE_APPLY", "AFTER_APPLY", "RETRY_RECONCILIATION"].includes(value.kind) && isoDate(value.observed_at) &&
    ["EXISTING", "UNAVAILABLE"].includes(value.ledger_state) && validMigrationNames(value.applied_names, { allowEmpty: true }) &&
    validMigrationNames(value.pending_names, { allowEmpty: true }) && ["NOT_RUN", "PASS", "MISMATCH", "UNAVAILABLE"].includes(value.schema_state) &&
    Array.isArray(value.schema_probes) && value.schema_probes.length <= 64 &&
    value.schema_probes.every((probe) => validSchemaProbeObservation(probe, { before: value.kind === "BEFORE_APPLY" })) &&
    Array.isArray(value.metadata_markers) && value.metadata_markers.length <= 64 && value.metadata_markers.every(validMetadataMarkerObservation);
}

function validateSavedReceipt(receipt, intent, intentSha256) {
  const keys = ["protocol", "intent_id", "intent_sha256", "target", "generated_config_sha256",
    "local_migration_bundle_sha256", "risk_review", "time_travel", "attempt_history", "observations", "overall_state"];
  if (!exactKeys(receipt, keys) || receipt.protocol !== RECEIPT_PROTOCOL || receipt.intent_id !== intent.intent_id ||
      receipt.intent_sha256 !== intentSha256 || !exactKeys(receipt.target, ["account_id", "binding", "database_name", "database_id"]) ||
      receipt.target.account_id !== intent.account_id || receipt.target.binding !== intent.database.binding ||
      receipt.target.database_name !== intent.database.database_name || receipt.target.database_id !== intent.database.database_id ||
      receipt.generated_config_sha256 !== intent.generated_config_sha256 ||
      receipt.local_migration_bundle_sha256 !== intent.local_migration_bundle_sha256 ||
      !exactKeys(receipt.risk_review, ["classification", "reviewed_bundle_sha256"]) ||
      receipt.risk_review.classification !== intent.risk_review.classification ||
      receipt.risk_review.reviewed_bundle_sha256 !== intent.risk_review.reviewed_bundle_sha256 ||
      !(receipt.time_travel === null || (exactKeys(receipt.time_travel, ["bookmark", "captured_at", "restore_performed"]) &&
        typeof receipt.time_travel.bookmark === "string" && receipt.time_travel.bookmark.length <= 256 &&
        isoDate(receipt.time_travel.captured_at) && receipt.time_travel.restore_performed === false)) ||
      !Array.isArray(receipt.attempt_history) || receipt.attempt_history.length > MAX_RECEIPT_HISTORY ||
      !Array.isArray(receipt.observations) || receipt.observations.length > MAX_RECEIPT_HISTORY * 2 ||
      !receipt.observations.every(validObservation) ||
      !["ATTEMPT_STARTED", "PASS", "FAILED", "PARTIAL", "UNKNOWN", "ALREADY_APPLIED", "RECONCILIATION_REQUIRED"].includes(receipt.overall_state)) {
    fail("Existing migration receipt does not match the exact canonical intent");
  }
  for (let index = 0; index < receipt.attempt_history.length; index += 1) {
    const attempt = receipt.attempt_history[index];
    if (!exactKeys(attempt, ["attempt_number", "started_at", "finished_at", "command_outcome", "before_applied_names", "before_pending_names"]) ||
        attempt.attempt_number !== index + 1 || !isoDate(attempt.started_at) ||
        !(attempt.finished_at === null || isoDate(attempt.finished_at)) ||
        !["RUNNING", "SUCCEEDED", "FAILED", "UNKNOWN", "NOT_STARTED"].includes(attempt.command_outcome) ||
        !validMigrationNames(attempt.before_applied_names, { allowEmpty: true }) ||
        !validMigrationNames(attempt.before_pending_names, { allowEmpty: true })) {
      fail("Existing migration receipt attempt history is invalid");
    }
  }
  return receipt;
}

async function saveMigrationReceipt(receipt, path, { createOnly = false } = {}) {
  await mkdir(dirname(path), { recursive: true });
  const bytes = `${JSON.stringify(receipt, null, 2)}\n`;
  if (createOnly) {
    const handle = await open(path, "wx", 0o600);
    try { await handle.writeFile(bytes, "utf8"); await handle.sync(); }
    finally { await handle.close(); }
    return;
  }
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    const handle = await open(temporary, "wx", 0o600);
    try { await handle.writeFile(bytes, "utf8"); await handle.sync(); }
    finally { await handle.close(); }
    await rename(temporary, path);
  } catch (error) {
    try { await unlink(temporary); } catch { /* No temporary file remains. */ }
    throw error;
  }
}

function boundedApiBase(raw) {
  let url;
  try { url = new URL(raw ?? "https://api.cloudflare.com/client/v4"); }
  catch { fail("Cloudflare API base URL is invalid"); }
  const fixture = url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
  if ((!fixture && (url.protocol !== "https:" || url.hostname !== "api.cloudflare.com" || url.port !== "")) ||
      url.username || url.password || url.search || url.hash || !["/client/v4", "/client/v4/"].includes(url.pathname)) {
    fail("Cloudflare API base URL is outside the supported official origin");
  }
  return url.href.replace(/\/$/u, "");
}

function remainingMs(intent, startedAt, now) {
  const deadline = Math.min(Date.parse(intent.deadline_at), startedAt + intent.max_runtime_ms);
  const remaining = Math.floor(deadline - now());
  if (remaining < 1) fail("Approved migration operation deadline expired before the next command");
  return remaining;
}

function requireNotCancelled(signal) {
  if (signal?.aborted) fail("Approved migration operation was cancelled before the next command");
}

async function readAccountAndDatabase(env, input, intent, { fetchImpl, timeoutMs, signal }) {
  const url = `${input.apiBase}/accounts/${encodeURIComponent(intent.account_id)}/d1/database/${encodeURIComponent(intent.database.database_id)}`;
  const request = (address, init) => fetchImpl(address, { ...init,
    ...(signal === undefined ? {} : { signal: AbortSignal.any([init.signal, signal]) }) });
  const { data } = await readDeploymentJson(url, {
    Authorization: `Bearer ${env.CLOUDFLARE_API_TOKEN}`, "Content-Type": "application/json",
  }, { fetchImpl: request, timeoutMs, maxBytes: 256 * 1024 });
  const database = data?.result;
  if (data?.success !== true || (Array.isArray(data.errors) && data.errors.length > 0) || !isObject(database) ||
      database.uuid !== intent.database.database_id || database.name !== intent.database.database_name ||
      database.version !== "production" ||
      (database.account_id !== undefined && database.account_id !== intent.account_id)) {
    fail("Cloudflare D1 identity or production-version readback differs from approved intent");
  }
  return { database_id: database.uuid, database_name: database.name, account_id: intent.account_id };
}

async function readSchemaProbes(env, input, intent, { fetchImpl, signal, timeoutMs, now = Date.now, metadataMarkers = [] }) {
  const observations = [];
  const markers = [];
  const cutoff = now() + timeoutMs;
  const outcome = (state) => ({ state, observations, metadata_markers: markers });
  for (const probe of intent.schema_probes) {
    if (signal?.aborted) return outcome("UNAVAILABLE");
    const remaining = Math.floor(cutoff - now());
    if (remaining < 1) return outcome("UNAVAILABLE");
    const url = `${input.apiBase}/accounts/${encodeURIComponent(intent.account_id)}/d1/database/${encodeURIComponent(intent.database.database_id)}/query`;
    const body = JSON.stringify({ sql: "SELECT type, name, sql FROM sqlite_master WHERE type = ? AND name = ? LIMIT 2",
      params: [probe.object_type, probe.name] });
    const request = (address, init) => fetchImpl(address, { ...init,
      ...(signal === undefined ? {} : { signal: AbortSignal.any([init.signal, signal]) }),
      method: "POST", body });
    try {
      const { data } = await readDeploymentJson(url, {
        Authorization: `Bearer ${env.CLOUDFLARE_API_TOKEN}`, "Content-Type": "application/json",
      }, { fetchImpl: request, timeoutMs: Math.min(5_000, remaining), maxBytes: 256 * 1024 });
      const result = data?.result?.[0];
      if (data?.success !== true || (Array.isArray(data.errors) && data.errors.length > 0) ||
          !Array.isArray(data.result) || data.result.length !== 1 || result?.success !== true ||
          !Array.isArray(result.results) || result.results.length > 2 || result.meta?.changed_db !== false ||
          result.meta?.rows_written !== 0) {
        observations.push({ object_type: probe.object_type, name: probe.name, expected_sql_sha256: probe.create_sql_sha256,
          observed_sql_sha256: null, migration_names: [...probe.migration_names], state: "UNAVAILABLE" });
        return outcome("UNAVAILABLE");
      }
      if (result.results.length !== 1) {
        observations.push({ object_type: probe.object_type, name: probe.name, expected_sql_sha256: probe.create_sql_sha256,
          observed_sql_sha256: null, migration_names: [...probe.migration_names], state: "MISMATCH" });
        return outcome("MISMATCH");
      }
      const row = result.results[0];
      if (!isObject(row) || Object.keys(row).length !== 3 || row.type !== probe.object_type || row.name !== probe.name ||
          typeof row.sql !== "string") {
        observations.push({ object_type: probe.object_type, name: probe.name, expected_sql_sha256: probe.create_sql_sha256,
          observed_sql_sha256: null, migration_names: [...probe.migration_names], state: "MISMATCH" });
        return outcome("MISMATCH");
      }
      const observed = sha256(Buffer.from(row.sql, "utf8"));
      observations.push({ object_type: probe.object_type, name: probe.name, expected_sql_sha256: probe.create_sql_sha256,
        observed_sql_sha256: observed, migration_names: [...probe.migration_names], state: observed === probe.create_sql_sha256 ? "PASS" : "MISMATCH" });
      if (observed !== probe.create_sql_sha256) return outcome("MISMATCH");
    } catch {
      observations.push({ object_type: probe.object_type, name: probe.name, expected_sql_sha256: probe.create_sql_sha256,
        observed_sql_sha256: null, migration_names: [...probe.migration_names], state: "UNAVAILABLE" });
      return outcome("UNAVAILABLE");
    }
  }
  for (const marker of metadataMarkers) {
    if (signal?.aborted) return outcome("UNAVAILABLE");
    const remaining = Math.floor(cutoff - now());
    if (remaining < 1) return outcome("UNAVAILABLE");
    const url = `${input.apiBase}/accounts/${encodeURIComponent(intent.account_id)}/d1/database/${encodeURIComponent(intent.database.database_id)}/query`;
    const body = JSON.stringify({ sql: "SELECT key, value FROM schema_state WHERE key = ? LIMIT 2", params: [marker.key] });
    const request = (address, init) => fetchImpl(address, { ...init,
      ...(signal === undefined ? {} : { signal: AbortSignal.any([init.signal, signal]) }), method: "POST", body });
    try {
      const { data } = await readDeploymentJson(url, {
        Authorization: `Bearer ${env.CLOUDFLARE_API_TOKEN}`, "Content-Type": "application/json",
      }, { fetchImpl: request, timeoutMs: Math.min(5_000, remaining), maxBytes: 256 * 1024 });
      const result = data?.result?.[0];
      if (data?.success !== true || (Array.isArray(data.errors) && data.errors.length > 0) ||
          !Array.isArray(data.result) || data.result.length !== 1 || result?.success !== true ||
          !Array.isArray(result.results) || result.results.length > 2 || result.meta?.changed_db !== false || result.meta?.rows_written !== 0) {
        markers.push({ key: marker.key, expected_value: marker.value, observed_value: null, state: "UNAVAILABLE" });
        return outcome("UNAVAILABLE");
      }
      if (result.results.length !== 1) {
        markers.push({ key: marker.key, expected_value: marker.value, observed_value: null, state: "MISMATCH" });
        return outcome("MISMATCH");
      }
      const row = result.results[0];
      const validRow = isObject(row) && Object.keys(row).length === 2 && row.key === marker.key &&
        typeof row.value === "string" && row.value.length <= 512;
      const state = validRow && row.value === marker.value ? "PASS" : "MISMATCH";
      markers.push({ key: marker.key, expected_value: marker.value,
        observed_value: validRow ? row.value : null, state });
      if (state !== "PASS") return outcome(state);
    } catch {
      markers.push({ key: marker.key, expected_value: marker.value, observed_value: null, state: "UNAVAILABLE" });
      return outcome("UNAVAILABLE");
    }
  }
  return outcome("PASS");
}

async function readSchemaPreconditions(env, input, intent, { fetchImpl, signal, timeoutMs, now = Date.now }) {
  const cutoff = now() + timeoutMs;
  const observations = [];
  const outcome = (state) => ({ state, observations, metadata_markers: [] });
  for (const probe of intent.schema_probes) {
    if (signal?.aborted) return outcome("UNAVAILABLE");
    const remaining = Math.floor(cutoff - now());
    if (remaining < 1) return outcome("UNAVAILABLE");
    const url = `${input.apiBase}/accounts/${encodeURIComponent(intent.account_id)}/d1/database/${encodeURIComponent(intent.database.database_id)}/query`;
    // SQLite schema identifiers are case-insensitive. Query all object types so
    // a differently cased or cross-type name cannot hide a conflicting object.
    const body = JSON.stringify({ sql: "SELECT type, name, sql FROM sqlite_master WHERE name = ? COLLATE NOCASE LIMIT 2",
      params: [probe.name] });
    const request = (address, init) => fetchImpl(address, { ...init,
      ...(signal === undefined ? {} : { signal: AbortSignal.any([init.signal, signal]) }), method: "POST", body });
    const observation = { object_type: probe.object_type, name: probe.name,
      expected_sql_sha256: probe.before_sql_sha256, observed_sql_sha256: null,
      migration_names: [...probe.migration_names], state: "UNAVAILABLE" };
    try {
      const { data } = await readDeploymentJson(url, {
        Authorization: `Bearer ${env.CLOUDFLARE_API_TOKEN}`, "Content-Type": "application/json",
      }, { fetchImpl: request, timeoutMs: Math.min(5_000, remaining), maxBytes: 256 * 1024 });
      const result = data?.result?.[0];
      if (data?.success !== true || (Array.isArray(data.errors) && data.errors.length > 0) ||
          !Array.isArray(data.result) || data.result.length !== 1 || result?.success !== true ||
          !Array.isArray(result.results) || result.results.length > 2 || result.meta?.changed_db !== false ||
          result.meta?.rows_written !== 0) {
        observations.push(observation);
        return outcome("UNAVAILABLE");
      }
      const row = result.results.length === 1 ? result.results[0] : null;
      if (isObject(row) && typeof row.sql === "string") observation.observed_sql_sha256 = sha256(Buffer.from(row.sql, "utf8"));
      const matches = probe.before_sql_sha256 === null ? result.results.length === 0 :
        isObject(row) && Object.keys(row).length === 3 && row.type === probe.object_type &&
        typeof row.name === "string" && row.name.toLowerCase() === probe.name.toLowerCase() &&
        observation.observed_sql_sha256 === probe.before_sql_sha256;
      observation.state = matches ? "PASS" : "MISMATCH";
      observations.push(observation);
      if (!matches) return outcome("MISMATCH");
    } catch {
      observations.push(observation);
      return outcome("UNAVAILABLE");
    }
  }
  return outcome("PASS");
}

function makeObservation(kind, observedAt, ledger, schema = { state: "NOT_RUN", observations: [], metadata_markers: [] }) {
  return { kind, observed_at: observedAt, ledger_state: ledger?.ledger_state ?? "UNAVAILABLE",
    applied_names: ledger?.applied_names ? [...ledger.applied_names] : [],
    pending_names: ledger?.pending_names ? [...ledger.pending_names] : [],
    schema_state: schema.state, schema_probes: schema.observations,
    metadata_markers: schema.metadata_markers ?? [] };
}

function createReceipt(intent, intentSha256, timeTravel, before, now) {
  const startedAt = new Date(now()).toISOString();
  return { protocol: RECEIPT_PROTOCOL, intent_id: intent.intent_id, intent_sha256: intentSha256,
    target: { account_id: intent.account_id, binding: intent.database.binding,
      database_name: intent.database.database_name, database_id: intent.database.database_id },
    generated_config_sha256: intent.generated_config_sha256,
    local_migration_bundle_sha256: intent.local_migration_bundle_sha256,
    risk_review: { classification: intent.risk_review.classification,
      reviewed_bundle_sha256: intent.risk_review.reviewed_bundle_sha256 },
    time_travel: timeTravel,
    attempt_history: [{ attempt_number: 1, started_at: startedAt, finished_at: null,
      command_outcome: "RUNNING", before_applied_names: [...before.applied_names], before_pending_names: [...before.pending_names] }],
    observations: [makeObservation("BEFORE_APPLY", startedAt, before)], overall_state: "ATTEMPT_STARTED" };
}

async function persistObservedReceipt(receipt, path, save, { createOnly = false } = {}) {
  await save(receipt, path, { createOnly });
}

async function markAttemptNotStarted(receipt, path, save, now) {
  const attempt = receipt.attempt_history.at(-1);
  if (attempt?.command_outcome !== "RUNNING") return;
  attempt.command_outcome = "NOT_STARTED";
  attempt.finished_at = new Date(now()).toISOString();
  receipt.overall_state = "FAILED";
  await persistObservedReceipt(receipt, path, save);
}

async function parseExistingReceipt(read, statFile, path, intent, intentSha256) {
  let text;
  try {
    const fileStat = await statFile(path);
    if (!fileStat.isFile() || fileStat.size > 2 * 1024 * 1024) fail("Existing D1 migration receipt exceeds its local size bound");
    text = await read(path, "utf8");
  } catch (error) { if (error?.code === "ENOENT") return null; throw error; }
  if (Buffer.byteLength(String(text), "utf8") > 2 * 1024 * 1024) fail("Existing D1 migration receipt exceeds its local size bound");
  let receipt;
  try { receipt = JSON.parse(String(text)); }
  catch { fail("Existing D1 migration receipt is invalid JSON"); }
  return validateSavedReceipt(receipt, intent, intentSha256);
}

function appendObservation(receipt, observation, overallState) {
  if (receipt.observations.length >= MAX_RECEIPT_HISTORY * 2) fail("Migration receipt reconciliation history is full");
  receipt.observations.push(observation);
  receipt.overall_state = overallState;
}

function allApprovedAlreadyApplied(intent, ledger) {
  return intent.migration_names.every((name) => ledger.applied_names.includes(name));
}

function migrationSetMatches(intent, ledger) {
  return JSON.stringify(ledger.pending_names) === JSON.stringify(intent.migration_names);
}

export async function runDeploymentMigrationOperation({ intent, root = ROOT, environment = process.env,
  confirmLive = false, execute, capture, fetchImpl = fetch, read = readFile, statFile = stat, readWranglerFile = read,
  now = Date.now, saveReceipt = saveMigrationReceipt, signal, log = console.log } = {}) {
  validateDeploymentMigrationIntent(intent);
  const startedAt = now();
  if (!Number.isSafeInteger(startedAt) || startedAt < 0) fail("Operation clock is invalid");
  const local = await readPinnedLocalPlan(intent, root, read);
  if (!confirmLive) {
    return Object.freeze({ state: "PLAN_ONLY", intent_id: intent.intent_id,
      intent_sha256: sha256(canonicalJson(intent)), binding: intent.database.binding,
      database_name: intent.database.database_name, migration_names: [...intent.migration_names],
      migration_count: intent.max_migrations, sql_bytes: local.sql.totalBytes });
  }

  const path = receiptPath(root, intent.intent_id);
  const intentSha256 = sha256(canonicalJson(intent));
  const existingReceipt = await parseExistingReceipt(read, statFile, path, intent, intentSha256);
  requireNotCancelled(signal);
  const env = { ...environment };
  if (env.CLOUDFLARE_ACCOUNT_ID !== intent.account_id) fail("Cloudflare account environment does not match approved intent");
  const configuredEnvironment = local.config.vars?.ENVIRONMENT;
  if (!["production", "staging"].includes(configuredEnvironment) ||
      (env.ELIOTR_ENVIRONMENT !== undefined && env.ELIOTR_ENVIRONMENT !== configuredEnvironment)) {
    fail("Cloudflare deployment environment does not match the pinned generated config");
  }
  env.ELIOTR_ENVIRONMENT = configuredEnvironment;
  validateStagingTarget(env);
  const usesWranglerOAuth = resolveAuthMode(env) === WRANGLER_OAUTH_MODE;
  const input = { accountId: intent.account_id, apiBase: boundedApiBase(env.CLOUDFLARE_API_BASE_URL) };
  const run = execute ?? ((command, args, cwd, childEnvironment, options) => runChild(command, args, cwd, childEnvironment, options));
  const captureCommand = capture ?? (async (command, args, cwd, childEnvironment, options) => {
    const result = await runChild(command, args, cwd, childEnvironment, { ...options, captureOutput: true });
    return result.stdout;
  });
  const deadline = () => remainingMs(intent, startedAt, now);
  const check = () => { requireNotCancelled(signal); return deadline(); };

  if (usesWranglerOAuth) {
    check();
    const whoami = await captureCommand("pnpm", ["exec", "wrangler", "whoami"], root,
      scrubTokenEnv(cleanChildEnvironment(env)),
      { signal, timeoutMs: deadline(), maxOutputBytes: 128 * 1024 });
    await verifyWranglerOAuthAccount({ expectedAccountId: intent.account_id, getWhoamiOutput: async () => whoami });
    const oauth = await loadWranglerOAuthCredential({ env: { ...process.env, ...env }, readFile: readWranglerFile, now: now() });
    env.CLOUDFLARE_API_TOKEN = injectOAuthBearer(env, oauth.bearer).CLOUDFLARE_API_TOKEN;
  }
  if (typeof env.CLOUDFLARE_API_TOKEN !== "string" || env.CLOUDFLARE_API_TOKEN.length < 1 ||
      env.CLOUDFLARE_API_TOKEN.length > 4096 || /[\r\n]/u.test(env.CLOUDFLARE_API_TOKEN)) {
    fail("Cloudflare credentials are unavailable for the approved migration operation");
  }
  const childEnv = cleanChildEnvironment(env);

  check();
  const identity = await readAccountAndDatabase(env, input, intent, { fetchImpl,
    signal, timeoutMs: Math.min(30_000, deadline()) });
  if (identity.account_id !== intent.account_id) fail("Cloudflare account identity readback mismatch");
  check();
  const before = await inspectDeploymentMigrationLedger(env, input, intent.database, local.bundle.migration_names,
    { fetchImpl, signal, timeoutMs: Math.min(30_000, deadline()) });

  if (existingReceipt !== null) {
    const state = allApprovedAlreadyApplied(intent, before) ? "ALREADY_APPLIED" : "RECONCILIATION_REQUIRED";
    const schema = state === "ALREADY_APPLIED"
      ? await readSchemaProbes(env, input, intent, { fetchImpl, signal, timeoutMs: Math.min(30_000, deadline()), now,
        metadataMarkers: local.sql.metadataMarkers })
      : { state: "NOT_RUN", observations: [], metadata_markers: [] };
    const finalState = state === "ALREADY_APPLIED" && schema.state !== "PASS" ? "UNKNOWN" : state;
    appendObservation(existingReceipt, makeObservation("RETRY_RECONCILIATION", new Date(now()).toISOString(), before, schema), finalState);
    await persistObservedReceipt(existingReceipt, path, saveReceipt);
    if (finalState !== "ALREADY_APPLIED") fail("Existing intent was not re-applied; reconciliation requires a new explicitly approved intent");
    log(JSON.stringify(existingReceipt, null, 2));
    return existingReceipt;
  }

  if (!migrationSetMatches(intent, before)) {
    if (allApprovedAlreadyApplied(intent, before)) {
      const schema = await readSchemaProbes(env, input, intent, { fetchImpl, signal,
        timeoutMs: Math.min(30_000, deadline()), now, metadataMarkers: local.sql.metadataMarkers });
      if (schema.state !== "PASS") fail("D1 ledger contains approved migration names but schema contract probes did not pass");
      const receipt = { protocol: RECEIPT_PROTOCOL, intent_id: intent.intent_id, intent_sha256: intentSha256,
        target: { account_id: intent.account_id, binding: intent.database.binding,
          database_name: intent.database.database_name, database_id: intent.database.database_id },
        generated_config_sha256: intent.generated_config_sha256,
        local_migration_bundle_sha256: intent.local_migration_bundle_sha256,
        risk_review: { classification: intent.risk_review.classification,
          reviewed_bundle_sha256: intent.risk_review.reviewed_bundle_sha256 }, time_travel: null,
        attempt_history: [], observations: [makeObservation("RETRY_RECONCILIATION", new Date(now()).toISOString(), before, schema)],
        overall_state: "ALREADY_APPLIED" };
      await persistObservedReceipt(receipt, path, saveReceipt, { createOnly: true });
      log(JSON.stringify(receipt, null, 2));
      return receipt;
    }
    fail("Current complete pending ledger set differs from approved intent; no automatic partial resume is allowed");
  }

  check();
  const timeTravelRaw = await captureCommand("pnpm", ["exec", "wrangler", "d1", "time-travel", "info",
    intent.database.database_name, "--json", "--config", CONFIG_NAME], resolve(root, "apps/eliotr-core"), childEnv,
  { signal, timeoutMs: deadline(), maxOutputBytes: 128 * 1024 });
  let timeTravelResult;
  try { timeTravelResult = JSON.parse(timeTravelRaw); }
  catch { fail("Cloudflare D1 Time Travel info did not return JSON"); }
  if (!exactKeys(timeTravelResult, ["bookmark"]) || typeof timeTravelResult.bookmark !== "string" ||
      timeTravelResult.bookmark.length < 1 || timeTravelResult.bookmark.length > 256 ||
      /[\u0000-\u001f\u007f]/u.test(timeTravelResult.bookmark)) {
    fail("Cloudflare D1 Time Travel bookmark readback is invalid");
  }
  const timeTravel = { bookmark: timeTravelResult.bookmark, captured_at: new Date(now()).toISOString(), restore_performed: false };
  const receipt = createReceipt(intent, intentSha256, timeTravel, before, now);
  await persistObservedReceipt(receipt, path, saveReceipt, { createOnly: true });

  // Re-read every approval pin and target readback immediately before apply.
  try {
    const current = await readPinnedLocalPlan(intent, root, read);
    if (sha256(current.configBytes) !== sha256(local.configBytes) ||
        current.bundle.local_migration_bundle_sha256 !== local.bundle.local_migration_bundle_sha256 ||
        current.sql.totalBytes !== local.sql.totalBytes) {
      fail("Frozen migration input changed before the schema effect");
    }
    check();
    const currentIdentity = await readAccountAndDatabase(env, input, intent, { fetchImpl,
      signal, timeoutMs: Math.min(30_000, deadline()) });
    if (JSON.stringify(currentIdentity) !== JSON.stringify(identity)) fail("D1 target identity changed before migration apply");
    check();
    const currentLedger = await inspectDeploymentMigrationLedger(env, input, intent.database, local.bundle.migration_names,
      { fetchImpl, signal, timeoutMs: Math.min(30_000, deadline()) });
    if (!migrationSetMatches(intent, currentLedger) ||
        JSON.stringify(currentLedger.applied_names) !== JSON.stringify(before.applied_names)) {
      fail("Complete D1 pending ledger changed before migration apply");
    }
    check();
    const preconditions = await readSchemaPreconditions(env, input, intent, {
      fetchImpl, signal, timeoutMs: Math.min(30_000, deadline()), now,
    });
    receipt.observations[receipt.observations.length - 1] = makeObservation("BEFORE_APPLY", new Date(now()).toISOString(), before, preconditions);
    await persistObservedReceipt(receipt, path, saveReceipt);
    if (preconditions.state !== "PASS") fail("Exact schema object preconditions failed before migration apply");
    check();
  } catch (error) {
    await markAttemptNotStarted(receipt, path, saveReceipt, now);
    throw error;
  }

  let commandOutcome;
  let commandError = null;
  try {
    await run("pnpm", ["exec", "wrangler", "d1", "migrations", "apply", intent.database.database_name,
      "--remote", "--config", CONFIG_NAME], resolve(root, "apps/eliotr-core"), childEnv,
    { signal, timeoutMs: deadline(), maxOutputBytes: 256 * 1024, onStarted: () => {} });
    commandOutcome = "SUCCEEDED";
  } catch (error) {
    commandError = error;
    commandOutcome = error?.uncertain || error?.started ? "UNKNOWN" : "FAILED";
  }

  const finishedAt = new Date(now()).toISOString();
  const attempt = receipt.attempt_history[receipt.attempt_history.length - 1];
  attempt.command_outcome = commandOutcome;
  attempt.finished_at = finishedAt;
  let after;
  let schema = { state: "NOT_RUN", observations: [], metadata_markers: [] };
  const reconciliationDeadline = now() + 15_000;
  try {
    after = await inspectDeploymentMigrationLedger(env, input, intent.database, local.bundle.migration_names,
      { fetchImpl, timeoutMs: Math.max(1, Math.floor(reconciliationDeadline - now())) });
    if (allApprovedAlreadyApplied(intent, after)) {
      const remaining = Math.floor(reconciliationDeadline - now());
      schema = remaining > 0
        ? await readSchemaProbes(env, input, intent, { fetchImpl, timeoutMs: remaining, now,
          metadataMarkers: local.sql.metadataMarkers })
        : { state: "UNAVAILABLE", observations: [], metadata_markers: [] };
    }
  } catch {
    after = null;
  }
  receipt.observations.push(makeObservation("AFTER_APPLY", new Date(now()).toISOString(), after, schema));
  if (receipt.observations.length > MAX_RECEIPT_HISTORY * 2) fail("Migration receipt reconciliation history is full");

  if (commandOutcome === "SUCCEEDED" && after !== null && after.pending_names.length === 0 &&
      JSON.stringify(after.applied_names) === JSON.stringify(local.bundle.migration_names) && schema.state === "PASS") {
    receipt.overall_state = "PASS";
  } else if (after !== null && after.pending_names.length === 0 &&
      JSON.stringify(after.applied_names) === JSON.stringify(local.bundle.migration_names)) {
    // A complete ledger alone cannot claim PASS without command success and
    // matching schema probes.
    receipt.overall_state = "UNKNOWN";
  } else if (after !== null && after.applied_names.length > before.applied_names.length) {
    receipt.overall_state = "PARTIAL";
  } else if (commandOutcome === "FAILED" && after !== null && after.pending_names.length === before.pending_names.length) {
    receipt.overall_state = "FAILED";
  } else {
    receipt.overall_state = "UNKNOWN";
  }
  await persistObservedReceipt(receipt, path, saveReceipt);
  if (receipt.overall_state !== "PASS") {
    const reason = commandError === null ? "D1 migration effect did not reach complete ledger and schema readback" :
      "D1 migration command failed or timed out; ledger reconciliation was persisted and the same intent will not be reapplied";
    fail(reason);
  }
  log(JSON.stringify(receipt, null, 2));
  return receipt;
}
