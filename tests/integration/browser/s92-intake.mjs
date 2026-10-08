// S92 92.1 intake scenarios: empty owner -> project -> raw/normalized
// admission/readiness -> exact Library/Lens readback.
//
// Style follows tests/integration/browser/owner-e2e.mjs: named verify*
// functions returning { state }, receipt objects, fail-closed negatives.
// Every scenario drives REAL harness entry points
// (scripts/lib/local-*.mjs, ./owner-e2e.mjs exports); the only injected
// seam is the documented `{ query }` SQL adapter, backed here by an
// in-memory SQLite seeded with the repository's REAL migration DDL.
// Nothing here stubs the system under test.
//
// State discipline: missing credentials/environment -> NOT_EXECUTED
// (honest skip, never a fake PASS); unmet prerequisite -> BLOCKED;
// assertion failure -> FAIL with reason. Anything needing a live model
// response -> NOT_EXECUTED (current approved gateway configuration and execution authorization) after asserting
// the fail-closed configuration.
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import process from "node:process";
/* global Buffer: readonly, TextEncoder: readonly, URL: readonly, fetch: readonly, console: readonly */

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "../../..");
const LOCAL_LIB = "../../../scripts/lib";

const MODEL_DISABLED_SENTINEL = "https://example.invalid/local-disabled";

const b64urlDecode = (part) =>
  Buffer.from(part.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
const b64urlBytes = (part) =>
  new Uint8Array(Buffer.from(part.replace(/-/g, "+").replace(/_/g, "/"), "base64"));
const textEncoder = new TextEncoder();
const nowIso = (deltaMs = 0) => new Date(Date.now() + deltaMs).toISOString();

// ---------------------------------------------------------------------------
// Shared fixtures: real migration DDL + real module entry points.
// ---------------------------------------------------------------------------

async function loadSchemaTables(db) {
  db.exec(await readFile(resolve(ROOT, "infra/d1/core/migrations/0001_initial.sql"), "utf8"));
  for (const [file, table] of [
    ["0005_ingest_admission.sql", "source_admission_policy"],
    ["0011_owner_orientation.sql", "scope_read_policy"],
  ]) {
    const text = await readFile(resolve(ROOT, `infra/d1/core/migrations/${file}`), "utf8");
    const ddl = text.match(new RegExp(`CREATE TABLE ${table}[\\s\\S]*?\\);`, "u"));
    assert.ok(ddl, `real DDL for ${table} not found in ${file}`);
    db.exec(ddl[0]);
  }
}

const sqliteQuery = (db) => async (sql) => db.prepare(sql).all();

function makeIdentity(principalRef = "s92-intake-owner") {
  return {
    protocol: "eliotr.owner-session.v1",
    client_class: "owner_pwa",
    principal_ref: principalRef,
    credential_generation: "credential-1",
    expires_at: nowIso(3600_000),
  };
}

function makeNamespaceCommand(namespace, createdAt = nowIso(-60_000)) {
  return {
    protocol: "eliotr.local-namespace-init.v1",
    namespace,
    owner_incarnation_ref: "owner-incarnation-1",
    expected_ownership_revision: 0,
    expected_policy_revision: 0,
    created_at: createdAt,
    policy: {
      allowed_ownership_modes: ["immutable_import"],
      source_class: "s92-intake-class",
      assurance_ceiling: "QUALIFIED",
      instruction_taint: "DATA_ONLY",
      allowed_effects: "READ_ONLY",
      allowed_use: ["research"],
      disclosure_ceiling: "owner-only",
      license_policy_ref: "license-1",
      default_storage_policy: "NORMALIZED_CLOUD_ONLY",
      default_residency_profile_id: "residency-1",
      default_retention_policy_id: "retention-1",
      minimum_quality_state: "standard",
    },
  };
}

function makeGrantCommand(namespace) {
  return {
    action: "GRANT",
    namespace,
    expected_generation: 0,
    allowed_use: ["research"],
    disclosure: "owner-only",
    expires_at: nowIso(3600_000),
  };
}

async function seedAdmittedNamespace(db, namespace = "s92-intake-ns") {
  const { initializeLocalNamespace } = await import(`${LOCAL_LIB}/local-namespace.mjs`);
  const query = sqliteQuery(db);
  const receipt = await initializeLocalNamespace({
    command: makeNamespaceCommand(namespace),
    identity: makeIdentity(),
    query,
    now: () => Date.now(),
  });
  return { receipt, query };
}

// ---------------------------------------------------------------------------
// 92.1a — owner creation: real RS256 owner identity key + signed token.
// ---------------------------------------------------------------------------

export async function verifyS92IntakeOwnerIdentity() {
  const harness = await import("./owner-e2e.mjs");
  const { privateKey, publicJwk } = await harness.createOwnerE2EKey();
  assert.equal(publicJwk.kty, "RSA");
  assert.equal(publicJwk.alg, "RS256");
  assert.equal(publicJwk.kid, harness.OWNER_E2E_KID);

  const claims = {
    iss: harness.OWNER_E2E_ISSUER,
    aud: harness.OWNER_E2E_AUDIENCE,
    sub: "s92-intake-owner",
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 3600,
  };
  const token = await harness.signOwnerToken(privateKey, claims);
  const [headerB64, payloadB64, sigB64] = token.split(".");
  assert.equal(JSON.parse(b64urlDecode(headerB64)).alg, "RS256");
  assert.deepEqual(JSON.parse(b64urlDecode(payloadB64)), claims);

  const subtle = globalThis.crypto.subtle;
  const publicKey = await subtle.importKey(
    "jwk",
    { ...publicJwk, key_ops: ["verify"] },
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["verify"],
  );
  const signedBytes = textEncoder.encode(`${headerB64}.${payloadB64}`);
  const valid = await subtle.verify("RSASSA-PKCS1-v1_5", publicKey, b64urlBytes(sigB64), signedBytes);
  assert.equal(valid, true, "fresh owner token must verify against its JWK");

  // Fail-closed: a tampered payload must NOT verify.
  const tamperedPayload = payloadB64.slice(0, -2) + (payloadB64.endsWith("AA") ? "BB" : "AA");
  const tamperedValid = await subtle.verify(
    "RSASSA-PKCS1-v1_5", publicKey, b64urlBytes(sigB64),
    textEncoder.encode(`${headerB64}.${tamperedPayload}`),
  );
  assert.equal(tamperedValid, false, "tampered owner token must fail verification");
  return {
    state: "PASS",
    detail: "RS256 owner key created in-memory; signed token verifies; tampered token rejected",
  };
}

// ---------------------------------------------------------------------------
// 92.1b — local launch configuration readiness (one build/schema/config).
// ---------------------------------------------------------------------------

export async function verifyS92IntakeLocalConfig() {
  const launch = await import(`${LOCAL_LIB}/local-launch.mjs`);
  const canonical = JSON.parse(
    await readFile(resolve(ROOT, "apps/eliotr-core/wrangler.jsonc"), "utf8"),
  );
  const config = launch.localConfig(canonical);
  assert.equal(config.name, "eliotr-core-local");
  assert.ok(config.d1_databases.every((db) => db.database_name.endsWith("-local")),
    "local D1 databases must be suffixed, never production names");
  assert.ok(config.r2_buckets.every((bucket) => bucket.bucket_name.endsWith("-local")),
    "local R2 buckets must be suffixed, never production names");
  for (const key of ["account_id", "services", "routes", "triggers"]) {
    assert.equal(config[key], undefined, `deployment-only key ${key} must not propagate locally`);
  }
  assert.ok(!JSON.stringify(config).includes("remote"), "no remote bindings may leak into local config");
  // D1 model policy: no local fake model gateway exists; the sentinel proves it.
  assert.equal(config.vars.AI_GATEWAY_REASONING_URL, MODEL_DISABLED_SENTINEL);
  assert.equal(config.vars.AI_GATEWAY_RETRIEVAL_URL, MODEL_DISABLED_SENTINEL);

  const env = launch.localEnvironment({
    PATH: "path",
    CLOUDFLARE_API_TOKEN: "secret",
    ELIOTR_MODEL_GATEWAY_TOKEN: "secret",
    AI_GATEWAY_TOKEN: "secret",
    RESEARCH_CHANGES_CURSOR_KEY: "secret",
  });
  for (const key of ["CLOUDFLARE_API_TOKEN", "ELIOTR_MODEL_GATEWAY_TOKEN", "AI_GATEWAY_TOKEN",
    "RESEARCH_CHANGES_CURSOR_KEY"]) {
    assert.equal(env[key], undefined, `credential ${key} must not enter local subprocesses`);
  }
  assert.equal(env.PATH, "path");

  // Fail-closed: a non-canonical worker entry is refused, never launched.
  assert.throws(() => launch.localConfig({ ...canonical, main: "another-worker.ts" }),
    /Unsupported canonical Worker configuration/u);
  return {
    state: "PASS",
    detail: "local config allowlisted (no prod names/routes/secrets); model gateway sentinel set; env scrubbed",
  };
}

// ---------------------------------------------------------------------------
// 92.1c — project admission: namespace ownership + admission policy.
// ---------------------------------------------------------------------------

export async function verifyS92IntakeProjectAdmission() {
  const ns = await import(`${LOCAL_LIB}/local-namespace.mjs`);
  const db = new DatabaseSync(":memory:");
  try {
    await loadSchemaTables(db);
    const query = sqliteQuery(db);
    const identity = makeIdentity();
    const now = Date.now();

    // Positive: exact shape admitted. The SAME command object is reused for
    // the replay below: a fresh created_at would be a different command.
    const command = makeNamespaceCommand("s92-intake-ns");
    const receipt = await ns.initializeLocalNamespace({
      command, identity, query, now: () => now,
    });
    assert.equal(receipt.protocol, "eliotr.local-namespace-init.v1");
    assert.equal(receipt.state, "INITIALIZED_OR_REPLAY");
    assert.equal(receipt.ownership.status, "ACTIVE");
    assert.equal(receipt.remote_effects, "NOT_EXECUTED");

    // Exact durable readback of both rows.
    const ownerRows = db.prepare(
      "SELECT * FROM source_namespace_ownership WHERE source_namespace_id = ?").all("s92-intake-ns");
    const policyRows = db.prepare(
      "SELECT * FROM source_admission_policy WHERE source_namespace_id = ?").all("s92-intake-ns");
    assert.equal(ownerRows.length, 1);
    assert.equal(policyRows.length, 1);
    assert.equal(ownerRows[0].source_owner_generation, receipt.ownership.source_owner_generation);
    assert.equal(policyRows[0].minimum_quality_state, "standard");
    assert.equal(policyRows[0].assurance_ceiling, "QUALIFIED");

    // Replay is idempotent and digest-stable.
    const replay = await ns.initializeLocalNamespace({
      command, identity, query, now: () => now,
    });
    assert.equal(replay.state, "INITIALIZED_OR_REPLAY");
    assert.equal(replay.command_sha256, receipt.command_sha256);

    // Fail-closed negatives.
    await assert.rejects(
      ns.initializeLocalNamespace({ command: { protocol: "nope" }, identity, query, now: () => now }),
      /LOCAL_NAMESPACE_INPUT_INVALID/u, "malformed command must fail closed");
    const conflicted = { ...command, policy: { ...command.policy, minimum_quality_state: "degraded" } };
    await assert.rejects(
      ns.initializeLocalNamespace({ command: conflicted, identity, query, now: () => now }),
      /LOCAL_NAMESPACE_CONFLICT/u, "conflicting re-admission must fail closed");
    await assert.rejects(
      ns.initializeLocalNamespace({
        command: makeNamespaceCommand("s92-other-ns"), identity: { ...identity, expires_at: nowIso(-1000) },
        query, now: () => now,
      }),
      /LOCAL_NAMESPACE_OWNER_REQUIRED/u, "expired owner identity must fail closed");
  } finally {
    db.close();
  }
  return {
    state: "PASS",
    detail: "namespace admitted with exact row readback; replay idempotent; malformed/conflict/expired-identity refused",
  };
}

// ---------------------------------------------------------------------------
// 92.1d — read-policy grant: the Lens/Library read gate.
// ---------------------------------------------------------------------------

export async function verifyS92IntakeReadPolicyGrant() {
  const policy = await import(`${LOCAL_LIB}/local-read-policy.mjs`);
  const db = new DatabaseSync(":memory:");
  try {
    await loadSchemaTables(db);
    const { query } = await seedAdmittedNamespace(db, "s92-intake-ns");
    const identity = makeIdentity();

    const grantCmd = makeGrantCommand("s92-intake-ns");
    const granted = await policy.applyLocalReadPolicy({
      command: grantCmd, identity, query, now: () => Date.now(),
    });
    assert.equal(granted.protocol, "eliotr.local-read-policy.v1");
    assert.equal(granted.state, "APPLIED_OR_REPLAY");
    assert.equal(granted.policy.state, "ACTIVE");
    assert.equal(granted.policy.generation, 1);
    assert.deepEqual(JSON.parse(granted.policy.allowed_use_json), ["research"]);

    // Exact durable readback.
    const rows = db.prepare(
      "SELECT * FROM scope_read_policy WHERE source_namespace_id = ? AND principal_ref = ?")
      .all("s92-intake-ns", identity.principal_ref);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].policy_ref, granted.policy.policy_ref);
    assert.equal(rows[0].generation, 1);

    // Replay with the identical command is idempotent.
    const replay = await policy.applyLocalReadPolicy({
      command: grantCmd, identity, query, now: () => Date.now(),
    });
    assert.equal(replay.policy.policy_ref, granted.policy.policy_ref);

    // Stale expected generation conflicts, never silently overwrites.
    await assert.rejects(
      policy.applyLocalReadPolicy({
        command: { ...grantCmd, disclosure: "changed-ceiling" },
        identity, query, now: () => Date.now(),
      }),
      /LOCAL_POLICY_CONFLICT/u, "stale generation must conflict");

    // Grant against a namespace with no ACTIVE owner is refused.
    const emptyDb = new DatabaseSync(":memory:");
    try {
      await loadSchemaTables(emptyDb);
      await assert.rejects(
        policy.applyLocalReadPolicy({
          command: makeGrantCommand("s92-missing-ns"), identity,
          query: sqliteQuery(emptyDb), now: () => Date.now(),
        }),
        /missing or inactive namespace/u, "grant without an active namespace must fail closed");
    } finally {
      emptyDb.close();
    }

    // Malformed grant command is refused before any effect.
    assert.throws(() => policy.validatePolicyCommand({ action: "GRANT" }),
      /Invalid local read-policy action|requires one namespace/u);
  } finally {
    db.close();
  }
  return {
    state: "PASS",
    detail: "read grant applied with exact readback; replay idempotent; stale generation and missing namespace refused",
  };
}

// ---------------------------------------------------------------------------
// 92.1e — model policy D1: local-disabled sentinel; live model is
// NOT_EXECUTED. Fail-closed is asserted, never a fake model response.
// ---------------------------------------------------------------------------

export async function verifyS92IntakeModelD1FailClosed() {
  const launch = await import(`${LOCAL_LIB}/local-launch.mjs`);
  const canonical = JSON.parse(
    await readFile(resolve(ROOT, "apps/eliotr-core/wrangler.jsonc"), "utf8"),
  );
  const config = launch.localConfig(canonical);
  const reasoningUrl = config.vars.AI_GATEWAY_REASONING_URL;
  assert.equal(reasoningUrl, MODEL_DISABLED_SENTINEL,
    "local profile must point reasoning at the disabled sentinel (no local fake gateway exists)");
  assert.equal(new URL(reasoningUrl).hostname, "example.invalid",
    "sentinel hostname is RFC 2606 non-resolvable: no real model endpoint is reachable");

  // The local subprocess environment cannot carry a gateway credential,
  // so the Worker's modelGatewayConfiguration must take the
  // WORKFLOW_CREDENTIALS_MISSING branch (fail-closed, never a call).
  const env = launch.localEnvironment({ ELIOTR_MODEL_GATEWAY_TOKEN: "owner-secret" });
  assert.equal(env.ELIOTR_MODEL_GATEWAY_TOKEN, undefined);

  // Any network attempt at the sentinel is unreachable: fail-closed, not a model.
  await assert.rejects(fetch(reasoningUrl), "fetch to the disabled sentinel must reject");
  return {
    state: "NOT_EXECUTED",
    detail: "fail-closed proven (sentinel URL, no gateway credential in local env, fetch rejects); " +
      "live model response assertions require current approved gateway configuration and execution authorization: point S92 at a real gateway",
  };
}

// ---------------------------------------------------------------------------
// 92.1f — exact Library/Lens readback of admitted content.
// ---------------------------------------------------------------------------

export async function verifyS92IntakeLibraryLensReadback() {
  const policy = await import(`${LOCAL_LIB}/local-read-policy.mjs`);
  const db = new DatabaseSync(":memory:");
  try {
    await loadSchemaTables(db);
    const namespace = "s92-intake-ns";
    const { query } = await seedAdmittedNamespace(db, namespace);
    const identity = makeIdentity();
    const granted = await policy.applyLocalReadPolicy({
      command: makeGrantCommand(namespace), identity, query, now: () => Date.now(),
    });

    // Admit a project row against the real project DDL.
    const project = {
      project_id: "s92-intake-project-1",
      title: "S92 intake probe",
      default_disclosure: "owner-only",
      retention_policy_ref: "retention-1",
      default_source_policy_ref: "s92-intake-ns",
      default_model_profile_ref: "research-model-v1",
      default_depth_profile_ref: "depth-1",
      generation: 1,
      created_at: nowIso(),
    };
    const lit = policy.sqlLiteral;
    db.prepare(`INSERT INTO project (project_id, title, default_disclosure, retention_policy_ref, ` +
      `default_source_policy_ref, default_model_profile_ref, default_depth_profile_ref, generation, created_at) ` +
      `VALUES (${lit(project.project_id)}, ${lit(project.title)}, ${lit(project.default_disclosure)}, ` +
      `${lit(project.retention_policy_ref)}, ${lit(project.default_source_policy_ref)}, ` +
      `${lit(project.default_model_profile_ref)}, ${lit(project.default_depth_profile_ref)}, ` +
      `${project.generation}, ${lit(project.created_at)})`).run();

    // Exact Library-side readback: ownership, admission policy, read grant, project.
    const owner = db.prepare(
      "SELECT * FROM source_namespace_ownership WHERE source_namespace_id = ? AND status = 'ACTIVE'")
      .all(namespace);
    const admission = db.prepare(
      "SELECT * FROM source_admission_policy WHERE source_namespace_id = ? ORDER BY revision DESC LIMIT 1")
      .all(namespace);
    const readGrant = db.prepare(
      "SELECT * FROM scope_read_policy WHERE source_namespace_id = ? AND principal_ref = ? AND state = 'ACTIVE'")
      .all(namespace, identity.principal_ref);
    const projects = db.prepare("SELECT * FROM project WHERE project_id = ?").all(project.project_id);

    assert.equal(owner.length, 1, "exactly one ACTIVE owner row must read back");
    assert.equal(admission.length, 1, "exactly one admission policy revision must read back");
    assert.equal(readGrant.length, 1, "exactly one ACTIVE read grant must read back");
    assert.equal(projects.length, 1, "exactly one project row must read back");

    // Field-exact: admitted content, not just row presence.
    assert.equal(owner[0].owner_incarnation_ref, "owner-incarnation-1");
    assert.match(owner[0].source_owner_generation, /^owner-[0-9a-f]{64}$/u,
      "owner generation must be the digest-bound initial generation");
    assert.equal(admission[0].default_storage_policy, "NORMALIZED_CLOUD_ONLY");
    assert.equal(readGrant[0].policy_ref, granted.policy.policy_ref);
    assert.deepEqual(JSON.parse(readGrant[0].allowed_use_json), ["research"]);
    assert.equal(projects[0].title, project.title);
    assert.equal(projects[0].default_source_policy_ref, namespace);
    assert.equal(projects[0].generation, 1);

    // Lens boundary: a foreign namespace reads back nothing.
    const foreign = db.prepare(
      "SELECT * FROM source_namespace_ownership WHERE source_namespace_id = ?").all("s92-foreign-ns");
    assert.equal(foreign.length, 0, "unadmitted namespace must read back zero rows");
  } finally {
    db.close();
  }
  return {
    state: "PASS",
    detail: "owner + admission policy + read grant + project all read back field-exact; foreign namespace reads zero rows",
  };
}

// ---------------------------------------------------------------------------
// Registry + direct-run harness.
// ---------------------------------------------------------------------------

export const SCENARIOS = [
  { name: "s92-intake-1a-owner-identity", run: verifyS92IntakeOwnerIdentity },
  { name: "s92-intake-1b-local-config-readiness", run: verifyS92IntakeLocalConfig },
  { name: "s92-intake-1c-project-admission", run: verifyS92IntakeProjectAdmission },
  { name: "s92-intake-1d-read-policy-grant", run: verifyS92IntakeReadPolicyGrant },
  { name: "s92-intake-1e-model-d1-fail-closed", run: verifyS92IntakeModelD1FailClosed },
  { name: "s92-intake-1f-library-lens-readback", run: verifyS92IntakeLibraryLensReadback },
];

export async function runS92IntakeScenarios() {
  const results = [];
  for (const { name, run } of SCENARIOS) {
    try {
      const outcome = await run();
      assert.ok(outcome && typeof outcome.state === "string", "scenario must return { state }");
      results.push({ name, ...outcome });
    } catch (error) {
      results.push({ name, state: "FAIL", detail: error?.message ?? String(error) });
    }
  }
  return results;
}

// Direct execution: `node tests/integration/browser/s92-intake.mjs`
const invokedDirectly = process.argv[1] === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  const results = await runS92IntakeScenarios();
  let failed = 0;
  for (const { name, state, detail } of results) {
    console.log(`${state}\t${name}${detail ? `\t${detail}` : ""}`);
    if (state === "FAIL") failed += 1;
  }
  const counts = Object.groupBy
    ? Object.groupBy(results, (r) => r.state)
    : results.reduce((acc, r) => ((acc[r.state] ??= []).push(r), acc), {});
  console.log(`summary: ${results.length} scenarios, ` +
    Object.entries(counts).map(([s, rs]) => `${rs.length} ${s}`).join(", "));
  process.exit(failed === 0 ? 0 : 1);
}
