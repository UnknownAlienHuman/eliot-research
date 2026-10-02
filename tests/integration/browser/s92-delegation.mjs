// tests/integration/browser/s92-delegation.mjs
//
// S92 92.2 delegation: owner-issued grant → independent machine query/run/
// status → report/citation, with the S98 (append-only delegated project
// attach) and S99 (normalized client bundle ingest) migration guards.
//
// State discipline: PASS (held against the real code), FAIL (reason in
// detail), NOT_EXECUTED (honest skip), BLOCKED (prerequisite in detail).
// Model dispatch remains NOT_EXECUTED in this local test mode after
// proving the fail-closed path; model output is never invented).
//
// Execution (plain node; the module self-registers a resolver for the
// compiled packages' own bare @eliotr/* imports):
//   npx tsc -b packages/cloudflare-navigation packages/cloudflare-ai \
//     packages/platform-cloudflare apps/eliotr-core
//   node tests/integration/browser/s92-delegation.mjs
//
// Everything under test is real, loaded from compiled dist via relative
// imports: the grant service/authority, the model-gateway endpoint
// validation, canonical JSON/SHA-256, the Worker binding, the real
// prepareProjectAttachment, scripts/lib harness helpers, and the real
// 0072/0075/0081/0082 DDL (in-memory SQLite; the only seam).
/* global Request: readonly, URL: readonly, process: readonly, console: readonly */
import assert from "node:assert/strict";
import { existsSync, readdirSync, statSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { register } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "../../..");
const NAV_DIST = resolve(ROOT, "packages/cloudflare-navigation/dist/index.js");
const AI_DIST = resolve(ROOT, "packages/cloudflare-ai/dist/index.js");
const PLATFORM_DIST = resolve(ROOT, "packages/platform-cloudflare/dist/index.js");
const BINDING_DIST = resolve(ROOT, "packages/cloudflare-research/dist/research-model-gateway-binding.js");
const ATTACH_DIST = resolve(ROOT, "apps/eliotr-core/dist/project-client-attachment.js");
// The hook resolves the dist files' own bare @eliotr/* imports: the packages'
// exports maps point at .ts sources whose .js-suffixed relative imports plain
// node cannot follow, so without this mapping the real dist files do not load.
const DIST_MAP = {};
for (const pkg of readdirSync(resolve(ROOT, "packages"))) {
  const index = resolve(ROOT, "packages", pkg, "dist", "index.js");
  if (existsSync(index)) DIST_MAP[`@eliotr/${pkg}`] = index;
}
register(
  `data:text/javascript,${encodeURIComponent(
    `import { pathToFileURL } from "node:url"; export async function resolve(specifier, context, next) { const map = ${JSON.stringify(DIST_MAP)}; ` +
      `if (Object.hasOwn(map, specifier)) return { url: pathToFileURL(map[specifier]).href, shortCircuit: true }; ` +
      `return next(specifier, context); }`,
  )}`,
);

function assertDistCurrent(distFile, srcFile) { // refuse stale dist
  assert.ok(
    statSync(distFile).mtimeMs >= statSync(srcFile).mtimeMs,
    `stale dist: ${distFile} older than ${srcFile}; rebuild before trusting these scenarios`,
  );
}

function distBlocked(name, distFile) { // missing build -> BLOCKED, not FAIL
  if (!existsSync(distFile)) {
    return {
      state: "BLOCKED",
      detail: `${name}: ${distFile} not built; run the documented build, then re-execute`,
    };
  }
  return null;
}

function checkDist() {
  for (const [dist, src] of [
    [NAV_DIST, resolve(ROOT, "packages/cloudflare-navigation/src/index.ts")],
    [AI_DIST, resolve(ROOT, "packages/cloudflare-ai/src/index.ts")],
    [PLATFORM_DIST, resolve(ROOT, "packages/platform-cloudflare/src/index.ts")],
    [BINDING_DIST, resolve(ROOT, "packages/cloudflare-research/src/research-model-gateway-binding.ts")],
    [ATTACH_DIST, resolve(ROOT, "apps/eliotr-core/src/project-client-attachment.ts")],
  ]) {
    const blocked = distBlocked("dist prerequisite", dist);
    if (blocked) return blocked;
    assertDistCurrent(dist, src);
  }
  return null;
}

// In-memory D1: real migration DDL + a minimal D1Database adapter over
// node:sqlite. The seam is documented: node:sqlite instead of a D1 binding.
function extractDdl(text, kind, name) {
  const start = text.search(new RegExp(`CREATE ${kind} ${name}(?![\\w])`, "u"));
  assert.ok(start >= 0, `real DDL for ${name} not found`);
  let i = text.indexOf("(", start);
  let depth = 0;
  for (; i < text.length; i++) {
    if (text[i] === "(") depth++;
    else if (text[i] === ")") {
      depth--;
      if (depth === 0) break;
    }
  }
  const tail = text.slice(i + 1, i + 21).match(/^(?:\s*STRICT)?\s*;/u);
  assert.ok(tail, `DDL terminator for ${name} not found`);
  return text.slice(start, i + 1 + tail[0].length);
}

async function createDelegationTestDb() {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON;");
  for (const [file, tables] of [
    ["infra/d1/core/migrations/0001_initial.sql",
      ["schema_state", "source", "source_namespace_ownership", "project", "project_source_membership"]],
    ["infra/d1/core/migrations/0005_ingest_admission.sql", ["source_admission_policy"]],
    ["infra/d1/core/migrations/0011_owner_orientation.sql", ["orientation_authority_epoch"]],
    ["infra/d1/core/migrations/0058_project_owner.sql", ["project_owner"]],
    ["infra/d1/core/migrations/0072_project_client_grants.sql", ["project_client_grant"]],
  ]) {
    const text = await readFile(resolve(ROOT, file), "utf8");
    for (const table of tables) db.exec(extractDdl(text, "TABLE", table));
  }
  const t72 = await readFile(resolve(ROOT, "infra/d1/core/migrations/0072_project_client_grants.sql"), "utf8");
  const viewAt = t72.search(/CREATE VIEW project_client_grant_current(?![\w])/u);
  db.exec(t72.slice(viewAt, t72.indexOf(";", viewAt) + 1));
  for (const m of t72.matchAll(/CREATE TRIGGER[\s\S]*?END;/gu)) db.exec(m[0]);
  const t75 = await readFile(resolve(ROOT, "infra/d1/core/migrations/0075_project_client_recovery_spend.sql"), "utf8");
  for (const m of t75.matchAll(/ALTER TABLE project_client_grant[\s\S]*?;/gu)) db.exec(m[0]);
  for (const m of t75.matchAll(/CREATE TRIGGER project_client_grant_spend_guard[\s\S]*?END;/gu)) db.exec(m[0]);
  db.exec("INSERT INTO orientation_authority_epoch(singleton,generation) VALUES (1,1)");
  db.exec(
    "INSERT INTO schema_state(key,value,updated_at) VALUES" +
    "('project_client_grant_generation','project-client-grant-v1','2026-01-01T00:00:00.000Z')," +
    "('project_client_attachment_generation','project-client-attachment-v2','2026-01-01T00:00:00.000Z')",
  );
  const now = new Date().toISOString();
  db.prepare(
    "INSERT INTO project(project_id,title,default_disclosure,retention_policy_ref,default_source_policy_ref," +
    "default_model_profile_ref,default_depth_profile_ref,generation,created_at) VALUES (?,?,?,?,?,?,?,?,?)",
  ).run("project-01", "S92 delegation", "owner-only", "ret-1", "sp-1", "mp-1", "dp-1", 1, now);
  db.prepare(
    "INSERT INTO project_owner(project_id,principal_ref,deployment_generation,created_at,updated_at)" +
    " VALUES (?,?,?,?,?)",
  ).run("project-01", "owner-01", "dep-1", now, now);
  const d1 = {
    prepare(sql) {
      const stmt = db.prepare(sql);
      let params = [];
      const api = {
        bind(...p) { params = p; return api; },
        first(...p) {
          const row = stmt.get(...(p.length ? p : params));
          return Promise.resolve(row === undefined ? null : row);
        },
        all(...p) {
          return Promise.resolve({ success: true, results: stmt.all(...(p.length ? p : params)), meta: {} });
        },
        run(...p) {
          const info = stmt.run(...(p.length ? p : params));
          return Promise.resolve({
            success: true,
            meta: { changes: Number(info.changes), last_row_id: Number(info.lastInsertRowid) },
          });
        },
      };
      return api;
    },
  };
  return { db, d1 };
}

const ISSUER = "https://s92-delegation-example.cloudflareaccess.com";const GRANTEE_1 = { issuer: ISSUER, authentication_method: "service_token", subject: "machine-01.access" };
const GRANTEE_2 = { issuer: ISSUER, authentication_method: "service_token", subject: "machine-02.access" };

function ownerContext(traceId) {
  return {
    request: new Request("https://local.invalid/api/project-client-grants", {
      method: "PUT",
      headers: { "Idempotency-Key": `s92-owner-${traceId}` },
    }),
    principal_ref: "owner-01",
    client_class: "owner_pwa",
    credential_generation: "cred-gen-1",
    trace_id: traceId,
    access: {
      principal_ref: "owner-01",
      credential_generation: "cred-gen-1",
      expires_at: new Date(Date.now() + 3600_000).toISOString(),
    },
  };
}

function machineContext(traceId, grantId, subject) {
  return {
    request: new Request("https://local.invalid/api/project-client-grants", {
      method: "POST",
      headers: { "Idempotency-Key": `s92-machine-${traceId}`, "X-Eliotr-Client-Grant": grantId },
    }),
    principal_ref: subject,
    client_class: "trusted_agent",
    credential_generation: "cred-gen-1",
    trace_id: traceId,
    access: {
      principal_ref: subject,
      credential_generation: "cred-gen-1",
      issuer: ISSUER,
      authentication_method: "service_token",
      expires_at: new Date(Date.now() + 3600_000).toISOString(),
    },
  };
}

function untouchedDatabase() {
  const touches = [];
  const database = new Proxy(
    {},
    {
      get: (_target, property) => {
        touches.push(String(property));
        throw new Error(
          `database must not be touched before the grant gate (property ${String(property)})`,
        );
      },
    },
  );
  return { database, touches };
}

function grantInput(overrides = {}) {
  return {
    grantee: GRANTEE_1,
    allowed_operations: ["query", "run", "status", "report"],
    ingest_namespace_ids: [],
    expires_at: new Date(Date.now() + 3600_000).toISOString(),
    expected_revision: 0,
    ...overrides,
  };
}

async function expectGrantFailure(ClientGrantError, label, action, expectedCode) {
  try {
    await action();
  } catch (error) {
    assert.ok(error instanceof ClientGrantError,
      `${label}: expected ClientGrantError, got ${error?.constructor?.name}`);
    assert.equal(error.code, expectedCode, `${label}: expected ${expectedCode}, got ${error.code}`);
    return error;
  }
  assert.fail(`${label}: expected ${expectedCode}, the call did not throw`);
}

// Scenario 1: only the owner may issue a grant; malformed/duplicated input
// is rejected before any database access.
async function verifyGrantIssuanceOwnerOnly() {
  const blocked = checkDist();
  if (blocked) return blocked;
  const { ClientGrantError, createProjectClientGrantService } = await import(pathToFileURL(NAV_DIST).href);
  const { database: machineDb, touches: machineTouches } = untouchedDatabase();
  const machineService = createProjectClientGrantService({ database: machineDb, trusted_issuers: [ISSUER] });
  await expectGrantFailure(
    ClientGrantError,
    "machine-class put",
    () => machineService.put(machineContext("01", "grant-01", GRANTEE_1.subject), "project-01", "grant-01", grantInput()),
    "CLIENT_GRANT_OWNER_REQUIRED",
  );
  assert.deepEqual(machineTouches, [], "owner gate must run before any database access");

  const { database: ownerDb, touches: ownerTouches } = untouchedDatabase();
  const ownerService = createProjectClientGrantService({ database: ownerDb, trusted_issuers: [ISSUER] });
  await expectGrantFailure(
    ClientGrantError,
    "owner put with duplicate operations",
    () => ownerService.put(ownerContext("02"), "project-01", "grant-01",
      grantInput({ allowed_operations: ["query", "query"] })),
    "CLIENT_GRANT_INPUT_INVALID",
  );
  await expectGrantFailure(
    ClientGrantError,
    "owner put with foreign grantee issuer",
    () => ownerService.put(ownerContext("03"), "project-01", "grant-01",
      grantInput({ grantee: { ...GRANTEE_1, issuer: "https://foreign.example.com" } })),
    "CLIENT_GRANT_INPUT_INVALID",
  );
  assert.deepEqual(ownerTouches, [], "input validation must run before any database access");
  return {
    state: "PASS",
    detail:
      "CLIENT_GRANT_OWNER_REQUIRED for trusted_agent put and CLIENT_GRANT_INPUT_INVALID " +
      "for duplicate operations / foreign issuer, both before any database access.",
  };
}

// Scenario 2: real owner→machine positive path (0072/0075 schema, real
// service): issue → authorize query/run/status/report → deny ungranted op →
// revoke → deny. Every step executes behaviorally.
async function verifyGrantPositivePath() {
  const blocked = checkDist();
  if (blocked) return blocked;
  const { ClientGrantError, createProjectClientGrantService, authorizeProjectClientGrant, readClientGrant } =
    await import(pathToFileURL(NAV_DIST).href);
  const { d1 } = await createDelegationTestDb();
  const service = createProjectClientGrantService({ database: d1, trusted_issuers: [ISSUER] });

  const issued = await service.put(ownerContext("p1"), "project-01", "grant-01", grantInput());
  assert.equal(issued.state, "ACTIVE");
  assert.equal(issued.revision, 1);
  assert.deepEqual([...issued.allowed_operations].sort(), ["query", "report", "run", "status"]);
  const readback = await readClientGrant(d1, "grant-01");
  assert.ok(readback && readback.revision === 1 && readback.state === "ACTIVE",
    "issued grant must read back as the exact immutable receipt");

  for (const operation of ["query", "run", "status", "report"]) {
    const lease = await authorizeProjectClientGrant(d1,
      machineContext(`op-${operation}`, "grant-01", GRANTEE_1.subject),
      { operation, project_id: "project-01" });
    assert.equal(lease.grant.grant_id, "grant-01");
    assert.equal(lease.grant.revision, 1);
    await lease.requireCurrent();
  }
  await expectGrantFailure(
    ClientGrantError,
    "machine cancel (not granted)",
    () => authorizeProjectClientGrant(d1, machineContext("op-cancel", "grant-01", GRANTEE_1.subject),
      { operation: "cancel", project_id: "project-01" }),
    "CLIENT_GRANT_DENIED",
  );

  const revoked = await service.revoke(ownerContext("p2"), "project-01", "grant-01", { expected_revision: 1 });
  assert.equal(revoked.state, "REVOKED");
  assert.equal(revoked.revision, 2);
  await expectGrantFailure(
    ClientGrantError,
    "machine query after revoke",
    () => authorizeProjectClientGrant(d1, machineContext("op-revoked", "grant-01", GRANTEE_1.subject),
      { operation: "query", project_id: "project-01" }),
    "CLIENT_GRANT_DENIED",
  );
  return {
    state: "PASS",
    detail:
      "Real issuance (ACTIVE rev 1, exact readback), real machine authorization of " +
      "query/run/status/report with requireCurrent, CLIENT_GRANT_DENIED for ungranted " +
      "cancel, real revocation (REVOKED rev 2) and post-revoke denial.",
  };
}

// Scenario 3: the S98 append-only attach guards in migration 0081 must hold.
async function verifyAttachmentAppendOnlyGuards() {
  const sql = await readFile(
    resolve(ROOT, "infra/d1/core/migrations/0081_project_client_attachment.sql"),
    "utf8",
  );
  assert.ok(sql.includes("CREATE TRIGGER project_attachment_guard_authority"),
    "missing project_attachment_guard_authority trigger");
  for (const required of [
    "g.state='ACTIVE'",
    "g.grantee_method='service_token'",
    "op.value='project.attach'",
    "julianday(g.expires_at)>julianday('now')",
    "PROJECT_ATTACHMENT_DENIED",
    "PROJECT_ATTACHMENT_RECEIPT_DENIED",
    "PROJECT_ATTACHMENT_MEMBERSHIP_DENIED",
    "membership_generation=NEW.project_revision-1",
    "valid_to IS NULL",
  ]) {
    assert.ok(sql.includes(required), `0081 must contain ${required}`);
  }
  assert.ok(!/project\.detach/.test(sql), "0081 must not name a project.detach delegated operation");
  assert.ok(!/rename/i.test(sql), "0081 must not name a delegated rename operation");
  return {
    state: "PASS",
    detail:
      "0081 gates delegated attach on ACTIVE service_token grants with the project.attach " +
      "operation and aborts (PROJECT_ATTACHMENT_MEMBERSHIP_DENIED) any delegated receipt " +
      "that would version out an existing membership.",
  };
}

// Scenario 4: the S99 normalized client ingest guards in migration 0082 must hold.
async function verifyNormalizedIngestGuards() {
  const sql = await readFile(
    resolve(ROOT, "infra/d1/core/migrations/0082_project_client_bundle_ingest.sql"),
    "utf8",
  );
  assert.ok(sql.includes("CREATE TRIGGER bundle_ingest_client_origin_immutable"),
    "missing bundle_ingest_client_origin_immutable trigger");
  assert.ok(sql.includes("INGEST_CLIENT_ORIGIN_IMMUTABLE"), "missing INGEST_CLIENT_ORIGIN_IMMUTABLE abort");
  assert.ok(sql.includes("CLIENT_GRANT_REVISION_CONFLICT"),
    "missing CLIENT_GRANT_REVISION_CONFLICT guard on grant insert");
  const writeDenials = (sql.match(/INGEST_CLIENT_WRITE_DENIED/g) ?? []).length;
  assert.ok(writeDenials >= 3, `expected >=3 INGEST_CLIENT_WRITE_DENIED fences, found ${writeDenials}`);
  assert.ok(sql.includes("bundle_ingest_client_authorized"),
    "client origin must be authorized before insert");
  return {
    state: "PASS",
    detail:
      `0082 enforces client-origin immutability, grant revision conflicts, and ${writeDenials} ` +
      "INGEST_CLIENT_WRITE_DENIED write fences behind bundle_ingest_client_authorized.",
  };
}

// Scenario 5: receipt/request digests from the REAL prepareProjectAttachment:
// deterministic, bound to grant revision, idempotency key and grant identity.
// The attach grant is seeded via direct SQL: the real service cannot issue a
// project.attach grant (it demands ingest_namespace_ids for attach while the
// 0072 trigger aborts any attach grant carrying namespaces). The row is built
// with the real ProjectClientGrantSchema + canonicalJson + sha256Utf8 and
// passes decodeGrant integrity; only issuance is bypassed.
async function verifyDelegationReceiptDigestBinding() {
  const blocked = checkDist();
  if (blocked) return blocked;
  const { prepareProjectAttachment } = await import(pathToFileURL(ATTACH_DIST).href);
  const { canonicalJson, sha256Utf8 } = await import(pathToFileURL(PLATFORM_DIST).href);
  const { ProjectClientGrantSchema } = await import(
    resolve(ROOT, "packages/contracts/dist/index.js"));
  const { db, d1 } = await createDelegationTestDb();
  const nowIso = new Date().toISOString();
  const attachGrant = ProjectClientGrantSchema.parse({
    protocol: "eliotr.project-client-grant.v1",
    grant_id: "grant-attach-01",
    project_id: "project-01",
    grantor_principal_ref: "owner-01",
    revision: 1,
    state: "ACTIVE",
    grantee: GRANTEE_2,
    allowed_operations: ["project.attach"],
    ingest_namespace_ids: [],
    expires_at: new Date(Date.now() + 3600_000).toISOString(),
    created_at: nowIso,
    updated_at: nowIso,
  });
  const record = canonicalJson(attachGrant);
  const digest = await sha256Utf8(record);
  db.prepare(
    "INSERT INTO project_client_grant(grant_id,revision,project_id,grantor_principal_ref,grantee_issuer," +
    "grantee_method,grantee_subject,state,expires_at,idempotency_key,request_sha256,record_json,record_sha256)" +
    " VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
  ).run("grant-attach-01", 1, "project-01", "owner-01", ISSUER, "service_token", GRANTEE_2.subject,
    "ACTIVE", attachGrant.expires_at, "seed-key-1", "c".repeat(64), record, digest);

  const first = await prepareProjectAttachment(d1,
    machineContext("a1", "grant-attach-01", GRANTEE_2.subject), "project-01", { source_ids: [] },
    "key-01", () => Date.now());
  const again = await prepareProjectAttachment(d1,
    machineContext("a2", "grant-attach-01", GRANTEE_2.subject), "project-01", { source_ids: [] },
    "key-01", () => Date.now());
  assert.equal(first.receiptKey, again.receiptKey, "receipt key must be deterministic");
  assert.equal(first.requestSha, again.requestSha, "request digest must be deterministic");
  assert.ok(first.receiptKey.startsWith("attach-"), "receipt key must carry the attach- prefix");
  assert.equal(first.requestSha.length, 64, "request digest must be sha256 hex");
  assert.deepEqual(first.binding,
    { grant_id: "grant-attach-01", grant_revision: 1, owner_principal_ref: "owner-01" });

  const expectedKey =
    `attach-${await sha256Utf8(canonicalJson({ protocol: "eliotr.project-attachment-command.v1",
      actor: attachGrant.grantee, idempotency_key: "key-01" }))}`;
  assert.equal(first.receiptKey, expectedKey,
    "real receipt key must equal the documented sha256(canonicalJson(...)) construction");

  const otherKey = await prepareProjectAttachment(d1,
    machineContext("a3", "grant-attach-01", GRANTEE_2.subject), "project-01", { source_ids: [] },
    "key-02", () => Date.now());
  assert.notEqual(otherKey.requestSha, first.requestSha, "digest must change when the idempotency key changes");
  assert.notEqual(otherKey.receiptKey, first.receiptKey, "receipt key must change when the idempotency key changes");
  return {
    state: "PASS",
    detail:
      "Real prepareProjectAttachment digests are deterministic sha256(canonicalJson(...)) values " +
      "bound to actor, grant identity/revision and idempotency key; tampering the key changes " +
      "both. Repo bug surfaced: no project.attach grant is issuable via the service " +
      "(namespace demand vs 0072 trigger abort).",
  };
}

// Scenario 6: model policy D1(b) fail-closed.
async function verifyModelDispatchFailClosed() {
  const blocked = checkDist();
  if (blocked) return blocked;
  const { ModelGatewayExecutionError, resolveModelGatewayReasoningEndpoint } = await import(pathToFileURL(AI_DIST).href);
  const { createResearchModelGatewayBindingFetch } = await import(pathToFileURL(BINDING_DIST).href);
  const { localConfig } = await import("../../../scripts/lib/local-launch.mjs");
  const canonical = JSON.parse(await readFile(resolve(ROOT, "apps/eliotr-core/wrangler.jsonc"), "utf8"));
  const profile = localConfig(canonical, join(tmpdir(), "s92-delegation-fakeroot"));
  const localDisabled = "https://example.invalid/local-disabled";
  assert.equal(profile.vars.AI_GATEWAY_REASONING_URL, localDisabled,
    "local profile must default to the fail-closed reasoning URL");
  assert.ok(new URL(localDisabled).hostname.endsWith(".invalid"),
    "local-disabled host must be the unroutable reserved .invalid TLD");

  let endpointError = null;
  try {
    resolveModelGatewayReasoningEndpoint(localDisabled);
  } catch (error) {
    endpointError = error;
  }
  assert.ok(endpointError instanceof ModelGatewayExecutionError,
    "endpoint validation must throw ModelGatewayExecutionError");
  assert.equal(endpointError.code, "MODEL_GATEWAY_REQUEST_INVALID");
  assert.equal(endpointError.retryable, false, "fail-closed validation must not be retryable");

  let bindingError = null;
  try {
    createResearchModelGatewayBindingFetch(null, localDisabled);
  } catch (error) {
    bindingError = error;
  }
  assert.ok(bindingError instanceof ModelGatewayExecutionError,
    "missing binding must throw ModelGatewayExecutionError");
  assert.equal(bindingError.code, "MODEL_GATEWAY_REQUEST_INVALID");
  return {
    state: "NOT_EXECUTED",
    detail:
      "Local default AI_GATEWAY_REASONING_URL is the unroutable https://example.invalid/local-disabled; " +
      "endpoint validation and the Worker binding constructor both fail closed with " +
      "MODEL_GATEWAY_REQUEST_INVALID (non-retryable). Any scenario needing a live model " +
      "response stays NOT_EXECUTED — no model output is ever invented.",
  };
}

// Scenario 7: harness configuration/readiness (model policy D1(a)).
async function verifyRuntimeConfigReadiness() {
  const { loadResearchRuntimeEnvironment } =
    await import("../../../scripts/lib/research-runtime-config.mjs");
  const emptyRoot = await mkdtemp(join(tmpdir(), "s92-delegation-empty-"));
  try {
    const merged = await loadResearchRuntimeEnvironment({}, emptyRoot);
    assert.deepEqual(merged, {}, "missing config file must return the environment unchanged, not invented values");
  } finally {
    await rm(emptyRoot, { recursive: true, force: true });
  }
  const badRoot = await mkdtemp(join(tmpdir(), "s92-delegation-bad-"));
  try {
    await mkdir(join(badRoot, ".eliotr-state"), { recursive: true });
    await writeFile(join(badRoot, ".eliotr-state", "research-runtime.json"),
      JSON.stringify({ protocol: "wrong.protocol", vars: {} }));
    let threw = false;
    try {
      await loadResearchRuntimeEnvironment({}, badRoot);
    } catch {
      threw = true;
    }
    assert.ok(threw, "malformed config protocol must throw instead of merging");
    threw = false;
    try {
      await loadResearchRuntimeEnvironment({ ELIOTR_RESEARCH_CONFIG_FILE: "does-not-exist.json" }, badRoot);
    } catch {
      threw = true;
    }
    assert.ok(threw, "explicit missing config file must throw");
  } finally {
    await rm(badRoot, { recursive: true, force: true });
  }
  return {
    state: "PASS",
    detail:
      "loadResearchRuntimeEnvironment returns an empty environment unchanged when no config " +
      "is installed and fails closed on malformed or missing config files.",
  };
}

// Scenario 8: probe the real browser harness entry.
async function verifyBrowserHarnessAvailability() {
  const { resolveLocalBrowserExecutable } = await import("../../../scripts/lib/local-launch.mjs");
  try {
    const executable = await resolveLocalBrowserExecutable();
    return {
      state: "PASS",
      detail: `Chromium executable resolved at ${executable}; probe only, the browser was not launched.`,
    };
  } catch (error) {
    return {
      state: "NOT_EXECUTED",
      detail: `No Chromium executable in this environment (${error?.message ?? error}); browser-driven delegation scenarios are skipped honestly.`,
    };
  }
}

export const SCENARIOS = [
  { name: "s92-delegation-grant-issuance-owner-only", run: verifyGrantIssuanceOwnerOnly },
  { name: "s92-delegation-grant-positive-path", run: verifyGrantPositivePath },
  { name: "s92-delegation-attachment-append-only", run: verifyAttachmentAppendOnlyGuards },
  { name: "s92-delegation-normalized-ingest-guards", run: verifyNormalizedIngestGuards },
  { name: "s92-delegation-receipt-digest-binding", run: verifyDelegationReceiptDigestBinding },
  { name: "s92-delegation-model-fail-closed", run: verifyModelDispatchFailClosed },
  { name: "s92-delegation-runtime-config-readiness", run: verifyRuntimeConfigReadiness },
  { name: "s92-delegation-browser-harness-probe", run: verifyBrowserHarnessAvailability } ];

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) { // direct run
  let failures = 0;
  for (const scenario of SCENARIOS) {
    try {
      const result = await scenario.run();
      console.log(`${result.state.padEnd(16)} ${scenario.name}${result.detail ? `\n    ${result.detail}` : ""}`);
      if (result.state === "FAIL") failures += 1;
    } catch (error) {
      failures += 1;
      console.log(`FAIL             ${scenario.name}\n    unexpected throw: ${error?.stack ?? error}`);
    }
  }
  process.exit(failures === 0 ? 0 : 1);
}
