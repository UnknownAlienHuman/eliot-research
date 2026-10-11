// Bounded source-only regression for the ER26 native trigger CASE representation
// adapter and its isolated per-intent migration mirror.
//
// This file reads the implemented helpers directly and pins byte-exact contract
// behaviour on a real temporary filesystem tree. The fixtures are local
// qualification fixtures: they are not backend authority and not proof of a
// native migration apply.

import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import test from "node:test";
import {
  NATIVE_TRIGGER_PROTOCOL,
  materializeNativeMigrationMirror,
  projectDeploymentNativeTriggerSql,
  validNativeTriggerTransport,
  verifyNativeMigrationMirror,
} from "./lib/deployment-native-trigger-representation.mjs";
import { readDeploymentMigrationEntries } from "./lib/deployment-migrations.mjs";

const sha = (value) => createHash("sha256").update(value).digest("hex");
const ACCOUNT_ID = "a".repeat(32);
const CORE_ID = "11111111-1111-4111-8111-111111111111";
const SEARCH_ID = "22222222-2222-4222-8222-222222222222";
const CORE_NAME = "eliotr-core";
const SEARCH_NAME = "eliotr-search";
const CONFIG_NAME = "wrangler.deploy.jsonc";
const CORE_STREAM = "infra/d1/core/migrations";
const SEARCH_STREAM = "infra/d1/search/migrations";
const BASE_NAME = "0001_fixture_base.sql";
const PENDING_NAME = "0002_fixture_pending.sql";
const AFTER_NAME = "0003_fixture_after_pending.sql";
const UNICODE_NAME = "0004_fixture_unicode.sql";
const SEARCH_BASE_NAME = "0001_search_base.sql";
const SEARCH_TRIGGER_NAME = "0002_search_trigger.sql";
const ESCAPE_NAME = "../escape.sql";
const SOURCE_PREFIX = "eliotr-native-source-";
const MIRROR_PREFIX = "eliotr-native-mirror-";

const BASE_SQL = "CREATE TABLE fixture_base (id INTEGER PRIMARY KEY) STRICT;\n";
const AFTER_SQL = "CREATE TABLE fixture_after_pending (id INTEGER PRIMARY KEY);\n";
const SEARCH_BASE_SQL = "CREATE TABLE search_base (id INTEGER PRIMARY KEY) STRICT;\n";
const SEARCH_TRIGGER_SQL =
  "CREATE TABLE search_receipt (id TEXT PRIMARY KEY, outcome TEXT NOT NULL) STRICT;\n" +
  "CREATE TRIGGER search_receipt_insert AFTER INSERT ON search_receipt\n" +
  "BEGIN\n" +
  "  SELECT CASE WHEN NEW.outcome = '' THEN RAISE(ABORT, 'SEARCH_OUTCOME_REQUIRED') END;\n" +
  "END;\n";

// Exactly one depth-zero CASE in a trigger body: two inserted parentheses and
// nothing else moves.
const PENDING_SQL =
  "CREATE TABLE IF NOT EXISTS fixture_receipt (\n" +
  "  id TEXT PRIMARY KEY,\n" +
  "  outcome TEXT NOT NULL\n" +
  ") STRICT;\n" +
  "CREATE TRIGGER fixture_receipt_insert AFTER INSERT ON fixture_receipt\n" +
  "BEGIN\n" +
  "  SELECT CASE WHEN NEW.outcome = '' THEN RAISE(ABORT, 'FIXTURE_OUTCOME_REQUIRED') END;\n" +
  "END;\n";
const PENDING_EXPECTED =
  "CREATE TABLE IF NOT EXISTS fixture_receipt (\n" +
  "  id TEXT PRIMARY KEY,\n" +
  "  outcome TEXT NOT NULL\n" +
  ") STRICT;\n" +
  "CREATE TRIGGER fixture_receipt_insert AFTER INSERT ON fixture_receipt\n" +
  "BEGIN\n" +
  "  SELECT (CASE WHEN NEW.outcome = '' THEN RAISE(ABORT, 'FIXTURE_OUTCOME_REQUIRED') END);\n" +
  "END;\n";

// Comments, quoted keywords, doubled quotes, bracket identifiers, a non-ASCII
// run, an interior BOM and CRLF endings must survive byte for byte. Only the
// depth-zero CASE gains parentheses.
const UNICODE_SQL =
  "-- 'CASE' \"END\" stay inside a line comment\r\n" +
  "/* a block comment that also holds 'CASE' and END */\r\n" +
  "CREATE TABLE IF NOT EXISTS fixture_note (\r\n" +
  "  id TEXT PRIMARY KEY,\r\n" +
  "  note TEXT NOT NULL DEFAULT 'it''s fine'\r\n" +
  ") STRICT;\r\n" +
  "CREATE TRIGGER fixture_note_insert AFTER INSERT ON fixture_note\r\n" +
  "BEGIN\r\n" +
  "  \uFEFF-- interior BOM inside the trigger body\r\n" +
  "  SELECT CASE WHEN 'CASE' = 'CASE' AND NEW.note <> [CASE] THEN '\u0430\u0442\u0430\u043a' ELSE '' END;\r\n" +
  "END;\r\n";
const UNICODE_EXPECTED =
  "-- 'CASE' \"END\" stay inside a line comment\r\n" +
  "/* a block comment that also holds 'CASE' and END */\r\n" +
  "CREATE TABLE IF NOT EXISTS fixture_note (\r\n" +
  "  id TEXT PRIMARY KEY,\r\n" +
  "  note TEXT NOT NULL DEFAULT 'it''s fine'\r\n" +
  ") STRICT;\r\n" +
  "CREATE TRIGGER fixture_note_insert AFTER INSERT ON fixture_note\r\n" +
  "BEGIN\r\n" +
  "  \uFEFF-- interior BOM inside the trigger body\r\n" +
  "  SELECT (CASE WHEN 'CASE' = 'CASE' AND NEW.note <> [CASE] THEN '\u0430\u0442\u0430\u043a' ELSE '' END);\r\n" +
  "END;\r\n";

test("SOURCE_ONLY a depth-zero trigger-body CASE receives exactly two parentheses", () => {
  const result = projectDeploymentNativeTriggerSql(PENDING_SQL);
  assert.equal(result.sql, PENDING_EXPECTED);
  assert.equal(result.inserted_parentheses, 2);
  assert.equal(result.source_sha256, sha(Buffer.from(PENDING_SQL, "utf8")));
  assert.equal(result.sha256, sha(Buffer.from(PENDING_EXPECTED, "utf8")));
  assert.equal(result.source_bytes, Buffer.byteLength(PENDING_SQL, "utf8"));
  assert.equal(result.bytes, Buffer.byteLength(PENDING_EXPECTED, "utf8"));
  assert.equal(result.bytes, result.source_bytes + 2);
});

test("SOURCE_ONLY comments quoted escaped keywords Unicode interior BOM and CRLF stay byte-exact", () => {
  const result = projectDeploymentNativeTriggerSql(UNICODE_SQL);
  assert.equal(result.sql, UNICODE_EXPECTED);
  assert.equal(result.inserted_parentheses, 2);
  assert.equal(result.bytes, result.source_bytes + 2);
  for (const marker of ["-- 'CASE' \"END\" stay inside a line comment", "'it''s fine'", "[CASE]",
    "\u0430\u0442\u0430\u043a", "\uFEFF", "\r\n"]) {
    assert.ok(result.sql.includes(marker), marker);
  }
  assert.equal(projectDeploymentNativeTriggerSql("\uFEFF" + PENDING_SQL).sql,
    "\uFEFF" + PENDING_EXPECTED);
});

test("SOURCE_ONLY multiple and nested CASEs wrap only the depth-zero ones", () => {
  const multiple = "CREATE TRIGGER a ON x BEGIN SELECT CASE WHEN 1 THEN 2 END; SELECT CASE WHEN 3 THEN 4 END; END;\n";
  const multipleExpected = "CREATE TRIGGER a ON x BEGIN SELECT (CASE WHEN 1 THEN 2 END); SELECT (CASE WHEN 3 THEN 4 END); END;\n";
  assert.equal(projectDeploymentNativeTriggerSql(multiple).sql, multipleExpected);
  assert.equal(projectDeploymentNativeTriggerSql(multiple).inserted_parentheses, 4);
  const nested = "CREATE TRIGGER a ON x BEGIN SELECT CASE WHEN 1 THEN (CASE WHEN 2 THEN 3 END) ELSE 4 END; END;\n";
  const nestedExpected = "CREATE TRIGGER a ON x BEGIN SELECT (CASE WHEN 1 THEN (CASE WHEN 2 THEN 3 END) ELSE 4 END); END;\n";
  assert.equal(projectDeploymentNativeTriggerSql(nested).sql, nestedExpected);
  assert.equal(projectDeploymentNativeTriggerSql(nested).inserted_parentheses, 2);
  const twoTriggers = "CREATE TRIGGER a ON x BEGIN SELECT CASE WHEN 1 THEN 2 END; END;\n" +
    "CREATE TRIGGER b ON y BEGIN SELECT CASE WHEN 3 THEN 4 END; END;\n";
  assert.equal(projectDeploymentNativeTriggerSql(twoTriggers).inserted_parentheses, 4);
  const bare = "CREATE TRIGGER a ON x BEGIN SELECT RAISE(ABORT, 'X'), 1; END;\n";
  assert.equal(projectDeploymentNativeTriggerSql(bare).sql, bare);
});

test("SOURCE_ONLY already parenthesized CASE and non-trigger statements stay unchanged", () => {
  const parenthesized = "CREATE TRIGGER a ON x BEGIN SELECT (CASE WHEN 1 THEN 2 END); END;\n";
  const parenthesizedResult = projectDeploymentNativeTriggerSql(parenthesized);
  assert.equal(parenthesizedResult.sql, parenthesized);
  assert.equal(parenthesizedResult.inserted_parentheses, 0);
  const view = "CREATE VIEW v AS SELECT CASE WHEN a THEN 1 ELSE 2 END FROM t;\n";
  assert.equal(projectDeploymentNativeTriggerSql(view).sql, view);
  const quoted = "CREATE TRIGGER a ON x BEGIN SELECT 'CASE', 'END'; END;\n";
  assert.equal(projectDeploymentNativeTriggerSql(quoted).sql, quoted);
  assert.equal(projectDeploymentNativeTriggerSql(BASE_SQL).sql, BASE_SQL);
});

test("SOURCE_ONLY malformed quotes comments CASE parentheses lone surrogates and non-strings reject", () => {
  const malformed = [
    "CREATE TRIGGER a ON x BEGIN SELECT '; END;\n",
    "CREATE TRIGGER a ON x BEGIN SELECT /* unterminated; END;\n",
    "CREATE TRIGGER a ON x BEGIN SELECT CASE WHEN 1 THEN 2 END",
    "CREATE TRIGGER a ON x BEGIN END END; END;\n",
    "CREATE TRIGGER a ON x BEGIN SELECT (1; END;\n",
    "CREATE TRIGGER a ON x BEGIN SELECT 1); END;\n",
    "CREATE TRIGGER a ON x BEGIN SELECT \uD800; END;\n",
    "CREATE TRIGGER a ON x BEGIN SELECT CASE WHEN 1 THEN CASE WHEN 2 THEN 3 END; END;\n",
    "CREATE TRIGGER a ON x BEGIN SELECT CASE WHEN 1 THEN 2 END END END;\n",
  ];
  for (const sql of malformed) assert.throws(() => projectDeploymentNativeTriggerSql(sql), Error, sql);
  assert.throws(() => projectDeploymentNativeTriggerSql("a".repeat(4 * 1024 * 1024 + 1)),
    /Invalid native migration SQL input/u);
  for (const value of [null, undefined, 42, {}, Buffer.from("x", "utf8")]) {
    assert.throws(() => projectDeploymentNativeTriggerSql(value), /Invalid native migration SQL input/u);
  }
});

test("SOURCE_ONLY the native transport shape admits one exact layout and rejects misuse", () => {
  const names = ["0001_a.sql", "0002_b.sql"];
  const entries = [{ name: names[0], sha256: "a".repeat(64) }, { name: names[1], sha256: "b".repeat(64) }];
  const good = { protocol: NATIVE_TRIGGER_PROTOCOL, local_migration_bundle_sha256: "c".repeat(64),
    migration_hashes: entries };
  const frozen = { protocol: NATIVE_TRIGGER_PROTOCOL, local_migration_bundle_sha256: "c".repeat(64),
    migration_hashes: entries.map((entry) => ({ ...entry })) };
  assert.equal(validNativeTriggerTransport(frozen, names), true);
  assert.equal(validNativeTriggerTransport(Object.freeze(frozen), names), true);
  const rejected = [
    [null, names],
    [[], names],
    [{ ...good, protocol: "eliotr.d1-native-trigger-case.v2" }, names],
    [{ ...good, local_migration_bundle_sha256: "C".repeat(64) }, names],
    [{ ...good, local_migration_bundle_sha256: "a".repeat(63) }, names],
    [{ ...good, local_migration_bundle_sha256: "a".repeat(65) }, names],
    [{ ...good, local_migration_bundle_sha256: undefined }, names],
    [{ ...good, extra: 1 }, names],
    [{ ...good, migration_hashes: entries.slice(0, 1) }, names],
    [{ ...good, migration_hashes: [...entries, { name: "0003_c.sql", sha256: "d".repeat(64) }] }, names],
    [{ ...good, migration_hashes: [{ ...entries[0], name: "0001_z.sql" }, entries[1]] }, names],
    [{ ...good, migration_hashes: [{ ...entries[0], sha256: "a".repeat(63) }, entries[1]] }, names],
    [{ ...good, migration_hashes: [{ ...entries[0], extra: 1 }, entries[1]] }, names],
    [{ ...good, migration_hashes: [null, entries[1]] }, names],
    [{ ...good, migration_hashes: [[names[0], "a".repeat(64)], entries[1]] }, names],
    [{ ...good, migration_hashes: {} }, names],
    [Object.assign(Object.create(null), good), names],
    [frozen, ["0001_a.sql"]],
  ];
  for (const [value, list] of rejected) assert.equal(validNativeTriggerTransport(value, list), false);
});

function deployConfig() {
  return {
    name: CORE_NAME, preview_urls: false, vars: { ENVIRONMENT: "production" },
    d1_databases: [
      { binding: "CORE_DB", database_name: CORE_NAME, database_id: CORE_ID,
        migrations_dir: "../../infra/d1/core/migrations" },
      { binding: "SEARCH_DB", database_name: SEARCH_NAME, database_id: SEARCH_ID,
        migrations_dir: "../../infra/d1/search/migrations" },
    ],
  };
}

async function createSourceFixture() {
  const root = await mkdtemp(join(resolve(tmpdir()), SOURCE_PREFIX));
  const coreDirectory = join(root, CORE_STREAM);
  const searchDirectory = join(root, SEARCH_STREAM);
  const appDirectory = join(root, "apps/eliotr-core");
  await Promise.all([mkdir(coreDirectory, { recursive: true }),
    mkdir(searchDirectory, { recursive: true }), mkdir(appDirectory, { recursive: true })]);
  await Promise.all([
    writeFile(join(coreDirectory, BASE_NAME), Buffer.from(BASE_SQL, "utf8")),
    writeFile(join(coreDirectory, PENDING_NAME), Buffer.from(PENDING_SQL, "utf8")),
    writeFile(join(coreDirectory, AFTER_NAME), Buffer.from(AFTER_SQL, "utf8")),
    writeFile(join(coreDirectory, UNICODE_NAME), Buffer.from(UNICODE_SQL, "utf8")),
    writeFile(join(searchDirectory, SEARCH_BASE_NAME), Buffer.from(SEARCH_BASE_SQL, "utf8")),
    writeFile(join(searchDirectory, SEARCH_TRIGGER_NAME), Buffer.from(SEARCH_TRIGGER_SQL, "utf8")),
  ]);
  const config = deployConfig();
  const configBytes = Buffer.from(JSON.stringify(config));
  await writeFile(join(appDirectory, CONFIG_NAME), configBytes);
  const coreBundle = await readDeploymentMigrationEntries(config, "CORE_DB", { root });
  const searchBundle = await readDeploymentMigrationEntries(config, "SEARCH_DB", { root });
  return { root, coreDirectory, searchDirectory, appDirectory, config, configBytes,
    coreBundle, searchBundle };
}

// The pending list is the complete ordered suffix of the real bundle, so the
// original pins handed to the mirror come from readDeploymentMigrationEntries
// itself rather than from a fabricated caller bundle.
async function buildIntent(fixture) {
  const offset = fixture.coreBundle.migration_names.indexOf(PENDING_NAME);
  const suffix = fixture.coreBundle.migration_entries.slice(offset);
  const projected = new Map();
  for (const entry of suffix) {
    const original = await readFile(join(fixture.coreDirectory, entry.name));
    const sql = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(original);
    const result = projectDeploymentNativeTriggerSql(sql);
    projected.set(entry.name, { bytes: Buffer.from(result.sql, "utf8"), sha256: result.sha256 });
  }
  const effectBundle = fixture.coreBundle.migration_entries.map((entry) => ({ name: entry.name,
    sha256: projected.get(entry.name)?.sha256 ?? entry.sha256 }));
  const intent = {
    protocol: "eliotr.cloudflare-d1-migration-intent.v4",
    intent_id: randomUUID(),
    account_id: ACCOUNT_ID,
    generated_config_sha256: sha(fixture.configBytes),
    database: { binding: "CORE_DB", database_name: CORE_NAME, database_id: CORE_ID },
    migration_names: suffix.map((entry) => entry.name),
    migration_hashes: suffix,
    local_migration_bundle_sha256: fixture.coreBundle.local_migration_bundle_sha256,
    migration_transport: {
      protocol: NATIVE_TRIGGER_PROTOCOL,
      local_migration_bundle_sha256: sha(JSON.stringify(effectBundle)),
      migration_hashes: suffix.map((entry) => ({ name: entry.name, sha256: projected.get(entry.name).sha256 })),
    },
  };
  return { intent, projected };
}

async function materialized() {
  const fixture = await createSourceFixture();
  const { intent, projected } = await buildIntent(fixture);
  const destination = await mkdtemp(join(resolve(tmpdir()), MIRROR_PREFIX));
  const mirror = await materializeNativeMigrationMirror({
    root: fixture.root, intent, configBytes: fixture.configBytes, bundle: fixture.coreBundle,
    companionBundles: [fixture.searchBundle], mirrorParentRoot: destination,
  });
  return { fixture, intent, projected, destination, mirror };
}

function cleanup(t, ...paths) {
  for (const value of paths) {
    const absolute = resolve(value);
    assert.equal(dirname(absolute), resolve(tmpdir()), "Cleanup must stay in a generated temporary root");
    assert.ok([SOURCE_PREFIX, MIRROR_PREFIX].some(prefix => basename(absolute).startsWith(prefix)),
      "Cleanup requires an owned fixture prefix");
  }
  t.after(async () => {
    await Promise.all(paths.map((path) => rm(path, { recursive: true, force: true })));
  });
}

test("SOURCE_ONLY both streams mirror with byte-identical config and originals and only pending CASE SQL transformed", async (t) => {
  const fixture = await createSourceFixture();
  const { intent, projected } = await buildIntent(fixture);
  const destination = await mkdtemp(join(resolve(tmpdir()), MIRROR_PREFIX));
  cleanup(t, fixture.root, destination);
  assert.equal(validNativeTriggerTransport(intent.migration_transport, intent.migration_names), true);
  const mirror = await materializeNativeMigrationMirror({
    root: fixture.root, intent, configBytes: fixture.configBytes, bundle: fixture.coreBundle,
    companionBundles: [fixture.searchBundle], mirrorParentRoot: destination,
  });
  assert.equal(mirror.root, resolve(destination, ".eliotr-state/d1-native-migrations", intent.intent_id));
  assert.equal(mirror.cwd, resolve(mirror.root, "apps/eliotr-core"));
  assert.equal(mirror.config_sha256, intent.generated_config_sha256);
  assert.equal(mirror.local_migration_bundle_sha256, intent.migration_transport.local_migration_bundle_sha256);
  assert.deepEqual(await readFile(join(mirror.cwd, CONFIG_NAME)), fixture.configBytes);
  for (const [stream, bundle] of [["core", fixture.coreBundle], ["search", fixture.searchBundle]]) {
    const listed = (await readdir(join(mirror.root, "infra/d1", stream, "migrations"))).sort();
    assert.deepEqual(listed, [...bundle.migration_names].sort());
  }
  const pendingNames = new Set(intent.migration_names);
  for (const entry of fixture.coreBundle.migration_entries) {
    const actual = await readFile(join(mirror.root, CORE_STREAM, entry.name));
    const source = await readFile(join(fixture.coreDirectory, entry.name));
    assert.deepEqual(actual, pendingNames.has(entry.name) ? projected.get(entry.name).bytes : source, entry.name);
  }
  assert.equal((await readFile(join(mirror.root, CORE_STREAM, PENDING_NAME))).toString("utf8"), PENDING_EXPECTED);
  assert.equal((await readFile(join(mirror.root, CORE_STREAM, UNICODE_NAME))).toString("utf8"), UNICODE_EXPECTED);
  for (const entry of fixture.searchBundle.migration_entries) {
    assert.equal(sha(await readFile(join(mirror.root, SEARCH_STREAM, entry.name))), entry.sha256, entry.name);
  }
  for (const [directory, bundle] of [[fixture.coreDirectory, fixture.coreBundle],
    [fixture.searchDirectory, fixture.searchBundle]]) {
    for (const entry of bundle.migration_entries) {
      assert.equal(sha(await readFile(join(directory, entry.name))), entry.sha256, entry.name);
    }
  }
  const effectPins = await Promise.all(fixture.coreBundle.migration_entries.map(async (entry) => ({ name: entry.name,
    sha256: pendingNames.has(entry.name)
      ? sha(await readFile(join(mirror.root, CORE_STREAM, entry.name))) : entry.sha256 })));
  assert.equal(sha(JSON.stringify(effectPins)), intent.migration_transport.local_migration_bundle_sha256);
  await verifyNativeMigrationMirror({ mirror, intent, bundle: fixture.coreBundle,
    companionBundles: [fixture.searchBundle] });
});

test("SOURCE_ONLY an existing mirror cannot be reused", async (t) => {
  const { fixture, intent, destination, mirror } = await materialized();
  cleanup(t, fixture.root, destination);
  await assert.rejects(() => materializeNativeMigrationMirror({
    root: fixture.root, intent, configBytes: fixture.configBytes, bundle: fixture.coreBundle,
    companionBundles: [fixture.searchBundle], mirrorParentRoot: destination,
  }));
  await verifyNativeMigrationMirror({ mirror, intent, bundle: fixture.coreBundle,
    companionBundles: [fixture.searchBundle] });
});

test("SOURCE_ONLY mirror tamper membership substitution and config change reject", async (t) => {
  const first = await materialized();
  cleanup(t, first.fixture.root, first.destination);
  const verify = (entry) => verifyNativeMigrationMirror({ mirror: entry.mirror, intent: entry.intent,
    bundle: entry.fixture.coreBundle, companionBundles: [entry.fixture.searchBundle] });
  await writeFile(join(first.mirror.root, CORE_STREAM, PENDING_NAME), Buffer.from("-- tampered\n", "utf8"));
  await assert.rejects(() => verify(first), /Native mirror migration changed before apply/u);
  const second = await materialized();
  cleanup(t, second.fixture.root, second.destination);
  await writeFile(join(second.mirror.root, CORE_STREAM, "0009_fixture_extra.sql"),
    Buffer.from("-- extra\n", "utf8"));
  await assert.rejects(() => verify(second), /Native mirror migration membership changed/u);
  const third = await materialized();
  cleanup(t, third.fixture.root, third.destination);
  await rm(join(third.mirror.root, CORE_STREAM, UNICODE_NAME));
  await mkdir(join(third.mirror.root, CORE_STREAM, UNICODE_NAME));
  await assert.rejects(() => verify(third), /Native mirror migration membership changed/u);
  const fourth = await materialized();
  cleanup(t, fourth.fixture.root, fourth.destination);
  await writeFile(join(fourth.mirror.cwd, CONFIG_NAME), Buffer.from("{}\n", "utf8"));
  await assert.rejects(() => verify(fourth), /Native mirror config changed before apply/u);
  const fifth = await materialized();
  cleanup(t, fifth.fixture.root, fifth.destination);
  await writeFile(join(fifth.mirror.root, SEARCH_STREAM, SEARCH_TRIGGER_NAME),
    Buffer.from("-- tampered\n", "utf8"));
  await assert.rejects(() => verify(fifth), /Native mirror migration changed before apply/u);
});

test("SOURCE_ONLY intent pin and drifted original source reject", async (t) => {
  const fixture = await createSourceFixture();
  const { intent } = await buildIntent(fixture);
  const pinRoot = await mkdtemp(join(resolve(tmpdir()), MIRROR_PREFIX));
  const effectRoot = await mkdtemp(join(resolve(tmpdir()), MIRROR_PREFIX));
  const driftRoot = await mkdtemp(join(resolve(tmpdir()), MIRROR_PREFIX));
  cleanup(t, fixture.root, pinRoot, effectRoot, driftRoot);
  const materialize = (target, plan) => materializeNativeMigrationMirror({
    root: fixture.root, intent: plan, configBytes: fixture.configBytes, bundle: fixture.coreBundle,
    companionBundles: [fixture.searchBundle], mirrorParentRoot: target,
  });
  await assert.rejects(() => materialize(pinRoot, { ...intent, generated_config_sha256: "0".repeat(64) }),
    /Native mirror config differs from original approved config/u);
  const wrongEffect = { ...intent, migration_transport: {
    protocol: NATIVE_TRIGGER_PROTOCOL,
    local_migration_bundle_sha256: intent.migration_transport.local_migration_bundle_sha256,
    migration_hashes: intent.migration_transport.migration_hashes.map((entry, index) =>
      index === 0 ? { name: entry.name, sha256: "1".repeat(64) } : entry),
  } };
  await assert.rejects(() => materialize(effectRoot, wrongEffect),
    /Native migration representation differs from approved effect pin/u);
  await writeFile(join(fixture.coreDirectory, PENDING_NAME),
    Buffer.from(PENDING_SQL.replace("FIXTURE_OUTCOME_REQUIRED", "CHANGED_OUTCOME_REQUIRED"), "utf8"));
  await assert.rejects(() => materialize(driftRoot, intent),
    /Original migration changed while materializing native representation/u);
});

test("SOURCE_ONLY bundle binding intent identifier and companion stream misuse reject", async (t) => {
  const fixture = await createSourceFixture();
  const { intent } = await buildIntent(fixture);
  const roots = [];
  for (let index = 0; index < 7; index += 1) roots.push(await mkdtemp(join(resolve(tmpdir()), MIRROR_PREFIX)));
  cleanup(t, fixture.root, ...roots);
  const materialize = (target, plan, bundle, companions) => materializeNativeMigrationMirror({
    root: fixture.root, intent: plan, configBytes: fixture.configBytes, bundle,
    companionBundles: companions, mirrorParentRoot: target,
  });
  const shifted = { ...intent, intent_id: "../../../etc/passwd" };
  const escapedEntries = fixture.searchBundle.migration_entries.map((entry) =>
    entry.name === SEARCH_BASE_NAME ? { name: ESCAPE_NAME, sha256: entry.sha256 } : entry);
  const escapedBundle = { ...fixture.searchBundle, migration_entries: escapedEntries,
    migration_names: escapedEntries.map((entry) => entry.name) };
  const driftedEntries = fixture.searchBundle.migration_entries.map((entry, index) =>
    index === 0 ? { name: entry.name, sha256: "3".repeat(64) } : entry);
  const driftedBundle = { ...fixture.searchBundle, migration_entries: driftedEntries,
    local_migration_bundle_sha256: sha(JSON.stringify(driftedEntries)) };
  const cases = [
    [shifted, fixture.coreBundle, [fixture.searchBundle], /Invalid native migration mirror input/u],
    [intent, fixture.searchBundle, [fixture.coreBundle],
      /Native mirror source bundle differs from approved target/u],
    [intent, fixture.coreBundle, [escapedBundle], /Invalid native mirror source stream/u],
    [intent, fixture.coreBundle, [driftedBundle],
      /Original migration changed while materializing native representation/u],
    [intent, fixture.coreBundle, [fixture.coreBundle], /Invalid native mirror source stream/u],
    [intent, fixture.coreBundle, "search", /Native mirror source bundle differs from approved target/u],
    [intent, fixture.coreBundle, [fixture.coreBundle, fixture.searchBundle],
      /Native mirror source bundle differs from approved target/u],
  ];
  for (const [plan, bundle, companions, pattern] of cases) {
    await assert.rejects(() => materialize(roots.shift(), plan, bundle, companions), pattern);
  }
});

test("SOURCE_ONLY junctions at the mirror parent and original source directory reject", async (t) => {
  const fixture = await createSourceFixture();
  const { intent } = await buildIntent(fixture);
  const parentRoot = await mkdtemp(join(resolve(tmpdir()), MIRROR_PREFIX));
  const sourceRoot = await mkdtemp(join(resolve(tmpdir()), MIRROR_PREFIX));
  cleanup(t, fixture.root, parentRoot, sourceRoot);
  const alternate = join(parentRoot, "replacement");
  await mkdir(alternate);
  await mkdir(join(parentRoot, ".eliotr-state"));
  await symlink(alternate, join(parentRoot, ".eliotr-state/d1-native-migrations"), "junction");
  await assert.rejects(() => materializeNativeMigrationMirror({ root: fixture.root, intent,
    configBytes: fixture.configBytes, bundle: fixture.coreBundle, mirrorParentRoot: parentRoot }),
  /Unsafe native migration mirror parent/u);
  const originalDirectory = fixture.coreDirectory;
  const movedDirectory = originalDirectory + "-original";
  assert.ok(originalDirectory.startsWith(fixture.root + "/") ||
    originalDirectory.startsWith(fixture.root + "\\"));
  await rename(originalDirectory, movedDirectory);
  await symlink(movedDirectory, originalDirectory, "junction");
  await assert.rejects(() => materializeNativeMigrationMirror({ root: fixture.root, intent,
    configBytes: fixture.configBytes, bundle: fixture.coreBundle, mirrorParentRoot: sourceRoot }),
  /Unsafe native migration source path/u);
});
