import assert from "node:assert/strict";
import {
  attestDeploymentApplicationSchemas,
  canonicalizeDeploymentSchemaCatalogue,
  DEPLOYMENT_SCHEMA_ATTESTATION_PROTOCOL,
  DEPLOYMENT_SCHEMA_CATALOGUE_PROTOCOL,
  DEPLOYMENT_SCHEMA_EXCLUSIONS,
  DEPLOYMENT_SCHEMA_MANIFEST_PROTOCOL,
  deploymentSchemaCatalogueSha256,
  readDeploymentApplicationSchemaCatalogue,
} from "./lib/deployment-schema-attestation.mjs";

const ACCOUNT_ID = "0123456789abcdef0123456789abcdef";
const CORE_ID = "11111111-1111-4111-8111-111111111111";
const SEARCH_ID = "22222222-2222-4222-8222-222222222222";
const TOKEN = "test-token-not-used-remotely";
const ENV = { CLOUDFLARE_ACCOUNT_ID: ACCOUNT_ID, CLOUDFLARE_API_TOKEN: TOKEN };
const INPUT = { apiBase: "https://api.cloudflare.com/client/v4" };
const CONFIG = {
  d1_databases: [
    { binding: "CORE_DB", database_name: "eliotr-core", database_id: CORE_ID },
    { binding: "SEARCH_DB", database_name: "eliotr-search", database_id: SEARCH_ID },
  ],
};
const CORE_OBJECTS = [
  { type: "table", name: "core_record", tbl_name: "core_record", sql: "CREATE TABLE core_record (id TEXT PRIMARY KEY)" },
  { type: "index", name: "core_record_created", tbl_name: "core_record", sql: "CREATE INDEX core_record_created ON core_record(id)" },
];
const SEARCH_OBJECTS = [
  { type: "table", name: "search_document", tbl_name: "search_document", sql: "CREATE TABLE search_document (id TEXT PRIMARY KEY)" },
];

function expectedManifest(coreObjects = CORE_OBJECTS, searchObjects = SEARCH_OBJECTS) {
  return {
    protocol: DEPLOYMENT_SCHEMA_MANIFEST_PROTOCOL,
    streams: [
      { binding: "CORE_DB", account_id: ACCOUNT_ID, database_id: CORE_ID, database_name: "eliotr-core",
        migration_bundle_sha256: "a".repeat(64), objects: coreObjects },
      { binding: "SEARCH_DB", account_id: ACCOUNT_ID, database_id: SEARCH_ID, database_name: "eliotr-search",
        migration_bundle_sha256: "b".repeat(64), objects: searchObjects },
    ],
  };
}

function queryRows(objects, { sentinel = objects.length, includeSentinel = true } = {}) {
  const rows = objects.map(({ type, name, tbl_name, sql }) => ({
    row_kind: 0, type, name, tbl_name, sql, object_count: null,
  }));
  if (includeSentinel) rows.push({ row_kind: 1, type: null, name: null, tbl_name: null, sql: null, object_count: sentinel });
  return rows;
}

function response(objects, options = {}) {
  return {
    success: true,
    errors: [],
    messages: [],
    result: [{
      success: true,
      results: queryRows(objects, options),
      meta: { changed_db: false, rows_written: 0, rows_read: objects.length },
    }],
  };
}

function mockFetch(responses, seen = []) {
  return async (url, init) => {
    seen.push({ url: String(url), init });
    const next = typeof responses === "function" ? responses(String(url), init) : responses.shift();
    return new Response(JSON.stringify(next), { status: 200, headers: { "content-type": "application/json" } });
  };
}

function resourceContext(binding, databaseId, databaseName) {
  return {
    protocol: "eliotr.cloudflare-d1.schema-database-context.v1",
    binding,
    account_id: ACCOUNT_ID,
    database_id: databaseId,
    database_name: databaseName,
  };
}

const canonical = canonicalizeDeploymentSchemaCatalogue(CORE_OBJECTS);
assert.equal(canonicalizeDeploymentSchemaCatalogue([...CORE_OBJECTS].reverse()), canonical,
  "catalogue order is canonical and stable");
assert.match(canonical, new RegExp(DEPLOYMENT_SCHEMA_CATALOGUE_PROTOCOL));
assert.equal(deploymentSchemaCatalogueSha256(CORE_OBJECTS), deploymentSchemaCatalogueSha256([...CORE_OBJECTS].reverse()));
assert.throws(() => canonicalizeDeploymentSchemaCatalogue([
  CORE_OBJECTS[0], { ...CORE_OBJECTS[0], name: "CORE_RECORD" },
]), /duplicate schema object identity/u);
assert.throws(() => canonicalizeDeploymentSchemaCatalogue([
  { ...CORE_OBJECTS[0], extra: true },
]), /malformed schema object/u);
assert.throws(() => canonicalizeDeploymentSchemaCatalogue([
  { type: "table", name: "d1_migrations", tbl_name: "d1_migrations", sql: "CREATE TABLE d1_migrations (name TEXT)" },
]), /malformed schema object/u);

const seen = [];
const read = await readDeploymentApplicationSchemaCatalogue(ENV, INPUT,
  resourceContext("CORE_DB", CORE_ID, "eliotr-core"), {
    fetchImpl: mockFetch([response(CORE_OBJECTS)], seen),
  });
assert.equal(read.protocol, DEPLOYMENT_SCHEMA_CATALOGUE_PROTOCOL);
assert.equal(read.scope, "application_schema");
assert.deepEqual(read.exclusions, DEPLOYMENT_SCHEMA_EXCLUSIONS);
assert.equal(read.object_count, CORE_OBJECTS.length);
assert.equal(read.catalogue_sha256, deploymentSchemaCatalogueSha256(CORE_OBJECTS));
assert.equal(seen.length, 1);
assert.equal(seen[0].init.method, "POST");
assert.equal(seen[0].url, `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/d1/database/${CORE_ID}/query`);
assert.equal(seen[0].init.headers.Authorization, `Bearer ${TOKEN}`);
const requestBody = JSON.parse(seen[0].init.body);
assert.deepEqual(requestBody.params, []);
assert.match(requestBody.sql, /FROM sqlite_master/u);
assert.match(requestBody.sql, /substr\(name, 1, 7\) <> 'sqlite_'/u);
assert.match(requestBody.sql, /d1_migrations/u);

const pairedFetch = mockFetch((url) => url.includes(CORE_ID) ? response([...CORE_OBJECTS].reverse()) : response(SEARCH_OBJECTS));
const attestation = await attestDeploymentApplicationSchemas(ENV, INPUT, CONFIG, expectedManifest(), { fetchImpl: pairedFetch });
assert.equal(attestation.protocol, DEPLOYMENT_SCHEMA_ATTESTATION_PROTOCOL);
assert.equal(attestation.state, "PASS");
assert.equal(attestation.scope, "application_schema");
assert.deepEqual(attestation.streams.map((stream) => stream.binding), ["CORE_DB", "SEARCH_DB"]);
assert.equal(attestation.streams[0].migration_bundle_sha256, "a".repeat(64));

for (const [label, observed] of [
  ["missing", [CORE_OBJECTS[0]]],
  ["extra", [...CORE_OBJECTS, { type: "view", name: "extra_view", tbl_name: "extra_view", sql: "CREATE VIEW extra_view AS SELECT 1" }]],
  ["changed", [{ ...CORE_OBJECTS[0], sql: "CREATE TABLE core_record (id INTEGER PRIMARY KEY)" }, CORE_OBJECTS[1]]],
]) {
  await assert.rejects(attestDeploymentApplicationSchemas(ENV, INPUT, CONFIG, expectedManifest(), {
    fetchImpl: mockFetch((url) => url.includes(CORE_ID) ? response(observed) : response(SEARCH_OBJECTS)),
  }), /application schema catalogue mismatch for CORE_DB/u, `${label} object set must fail closed`);
}

await assert.rejects(readDeploymentApplicationSchemaCatalogue(ENV, INPUT,
  resourceContext("CORE_DB", CORE_ID, "eliotr-core"), {
    fetchImpl: mockFetch([response(CORE_OBJECTS, { includeSentinel: false })]),
  }), /catalogue response truncated or incomplete/u);
await assert.rejects(readDeploymentApplicationSchemaCatalogue(ENV, INPUT,
  resourceContext("CORE_DB", CORE_ID, "eliotr-core"), {
    fetchImpl: mockFetch([response(CORE_OBJECTS, { sentinel: CORE_OBJECTS.length + 1 })]),
  }), /catalogue response truncated or incomplete/u);
await assert.rejects(readDeploymentApplicationSchemaCatalogue(ENV, INPUT,
  resourceContext("CORE_DB", CORE_ID, "eliotr-core"), {
    fetchImpl: mockFetch([response([
      CORE_OBJECTS[0], { ...CORE_OBJECTS[0], name: "CORE_RECORD" },
    ])]),
  }), /duplicate schema object identity/u);
await assert.rejects(readDeploymentApplicationSchemaCatalogue(ENV, INPUT,
  resourceContext("CORE_DB", CORE_ID, "eliotr-core"), {
    fetchImpl: mockFetch([response([{ ...CORE_OBJECTS[0], sql: null }])]),
  }), /malformed schema object/u);

const denialFetch = mockFetch((url) => url.includes(CORE_ID)
  ? response(CORE_OBJECTS)
  : { success: false, errors: [{ code: 10000, message: "denied" }], messages: [], result: null });
await assert.rejects(attestDeploymentApplicationSchemas(ENV, INPUT, CONFIG, expectedManifest(), {
  fetchImpl: denialFetch,
}), /D1 query denied or response envelope malformed/u, "one denied database must reject the paired attestation");

await assert.rejects(attestDeploymentApplicationSchemas(ENV, INPUT, CONFIG, {
  ...expectedManifest(), streams: [expectedManifest().streams[0]],
}, { fetchImpl: mockFetch([]) }), /expected manifest or generated D1 bindings are malformed/u,
"an incomplete expected pair must fail before a remote read");
await assert.rejects(readDeploymentApplicationSchemaCatalogue(ENV, INPUT,
  resourceContext("SEARCH_DB", CORE_ID, "eliotr-core"), { fetchImpl: mockFetch([]) }),
/invalid account or D1 resource context/u);

process.stdout.write("deployment schema attestation focused regression passed\n");
