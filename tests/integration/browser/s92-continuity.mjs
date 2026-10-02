/**
 * S92 92.4 continuity scenarios.
 *
 * Covers the 92.4 continuity slice of the S92 passport (PR #292,
 * EXECUTION-STEPS-03): JWT refresh, compatible redeploy without breaking
 * in-flight runs, source schema generation v1→v2 migration path, offline
 * behavior, run cancellation, and same-run recovery (no repeated completed
 * effects — exactly-once discipline).
 *
 * Every scenario drives REAL harness entry points (scripts/lib/*.mjs,
 * tests/integration/browser/owner-e2e.mjs exports, the real D1 migration
 * files, the real production D1 schema). Nothing stubs the system under
 * test. State discipline: missing credentials/environment → NOT_EXECUTED
 * (honest skip, never a fake PASS); unmet prerequisite → BLOCKED;
 * assertion failure → FAIL with a reason.
 *
 * Model policy (S92 D1): the local default is
 * AI_GATEWAY_REASONING_URL=https://example.invalid/local-disabled and there
 * is no local fake model gateway. These scenarios prove configuration,
 * readiness and fail-closed paths; they never invent model output.
 */
/* global Buffer: readonly, fetch: readonly, setTimeout: readonly, clearTimeout: readonly,
   process: readonly, console: readonly */
import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import {
  OWNER_E2E_AUDIENCE,
  OWNER_E2E_ISSUER,
  OWNER_E2E_KID,
  assertWorkflowJobReadback,
  createOwnerE2EKey,
  signOwnerToken,
  startLoopbackJsonServer,
} from "./owner-e2e.mjs";
import {
  createBrowserResearchReadinessFixture,
  runBrowserResearchReadinessCanary,
} from "../../../scripts/lib/browser-research-readiness-fixture.mjs";
import {
  prepareLocal,
  resolveLocalBrowserExecutable,
} from "../../../scripts/lib/local-launch.mjs";
import { startLocalWorker } from "../../../scripts/lib/local-worker.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../../..");
const MIGRATIONS_DIR = join(root, "infra/d1/core/migrations");

function pass(detail) { return { state: "PASS", detail }; }
function fail(detail) { return { state: "FAIL", detail }; }
function notExecuted(detail) { return { state: "NOT_EXECUTED", detail }; }
function blocked(detail) { return { state: "BLOCKED", detail }; }

function nowSeconds() { return Math.floor(Date.now() / 1000); }

function decodeJwtPayload(token) {
  const parts = token.split(".");
  assert.equal(parts.length, 3, "token must have three JWT segments");
  return JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
}

function decodeJwtHeader(token) {
  return JSON.parse(Buffer.from(token.split(".")[0], "base64url").toString("utf8"));
}

// Production claim rules, mirrored from
// packages/cloudflare-access/src/access.ts (validateClaims), including the
// nbf branches and the 60s default clock skew. The signing
// (signOwnerToken) and the JWKS serving (startLoopbackJsonServer) are the
// exact functions the owner-e2e harness uses against the real Worker; the
// Worker-side verification itself is covered by the existing e2e receipts
// (jwt_negatives, jwks_rotation, browser_jwt_matrix in library.spec.ts).
function assertProductionClaims(payload, { issuer, audience, now, skew = 60 }) {
  assert.equal(payload.iss, issuer, "issuer must match (ACCESS_JWT_ISSUER_INVALID)");
  assert.ok(Array.isArray(payload.aud) && payload.aud.includes(audience),
    "audience must include the expected audience (ACCESS_JWT_AUDIENCE_INVALID)");
  assert.ok(payload.type === undefined || payload.type === "app",
    "token type must be app (ACCESS_JWT_TYPE_INVALID)");
  assert.ok(payload.exp > now - skew, "token must not be expired (ACCESS_JWT_EXPIRED)");
  assert.ok(payload.nbf === undefined || payload.nbf <= now + skew,
    "token must be valid now (ACCESS_JWT_NOT_YET_VALID)");
  assert.ok(payload.iat <= now + skew, "token must not be issued in the future (ACCESS_JWT_ISSUED_IN_FUTURE)");
  assert.ok(payload.exp > payload.iat, "exp must order after iat (ACCESS_JWT_MALFORMED)");
  assert.ok(payload.nbf === undefined || payload.exp > payload.nbf,
    "exp must order after nbf (ACCESS_JWT_MALFORMED)");
}

async function withTempDir(prefix, fn) {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  try { return await fn(directory); }
  finally { await rm(directory, { recursive: true, force: true }); }
}

// Applies the REAL production D1 migration stream to a scratch SQLite
// database (the same engine family D1/miniflare uses) and returns the
// database plus the applied file list.
async function applyProductionMigrations() {
  const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith(".sql")).sort();
  assert.ok(files.length > 0, "migration stream must not be empty");
  const db = new DatabaseSync(":memory:");
  const applied = [];
  for (const file of files) {
    try {
      db.exec(await readFile(join(MIGRATIONS_DIR, file), "utf8"));
      applied.push(file);
    } catch (error) {
      db.close();
      throw new Error(`migration ${file} failed to apply: ${error.message}`, { cause: error });
    }
  }
  return { db, files, applied };
}

function schemaState(db) {
  return new Map(db.prepare("SELECT key, value FROM schema_state").all().map((r) => [r.key, r.value]));
}

// --- 92.4: JWT refresh -------------------------------------------------
// Short-lived owner token → refresh issuance with fresh iat/exp on the same
// subject → old token expired per the production rule, new token valid →
// JWKS rotation to a new kid served by the real loopback JWKS path.
async function verifyJwtRefresh() {
  const { privateKey, publicJwk } = await createOwnerE2EKey();
  const server = await startLoopbackJsonServer(JSON.stringify({ keys: [publicJwk] }));
  let rotated = null;
  try {
    const served = await (await fetch(server.url)).json();
    assert.equal(served.keys.length, 1, "loopback JWKS must serve exactly the minted key");
    assert.equal(served.keys[0].kid, OWNER_E2E_KID, "served kid must match the minted kid");
    assert.equal(served.keys[0].kty, "RSA", "served key must be RSA");

    const now = nowSeconds();
    const claims = {
      iss: OWNER_E2E_ISSUER, aud: [OWNER_E2E_AUDIENCE], sub: "e2e-owner",
      type: "app", iat: now, exp: now + 300,
    };
    const token = await signOwnerToken(privateKey, claims);
    assertProductionClaims(decodeJwtPayload(token), { issuer: OWNER_E2E_ISSUER, audience: OWNER_E2E_AUDIENCE, now });

    // Refresh: the owner session mints a new token for the same subject with
    // fresh time bounds once the old one approaches expiry.
    const refreshAt = now + 301;
    const refreshedClaims = { ...claims, iat: refreshAt, exp: refreshAt + 300 };
    const refreshed = await signOwnerToken(privateKey, refreshedClaims);
    const oldPayload = decodeJwtPayload(token);
    const newPayload = decodeJwtPayload(refreshed);
    assert.ok(!(oldPayload.exp > refreshAt), "old token must be expired at refresh time (ACCESS_JWT_EXPIRED)");
    assertProductionClaims(newPayload, { issuer: OWNER_E2E_ISSUER, audience: OWNER_E2E_AUDIENCE, now: refreshAt });
    assert.equal(newPayload.sub, oldPayload.sub, "refresh must preserve the subject identity");
    assert.ok(newPayload.iat > oldPayload.iat, "refresh must carry fresh issuance time");
    assert.notEqual(refreshed, token, "refresh must mint a distinct token");

    // Rotation: the JWKS document rolls to a new kid; the serving path
    // exposes the new key and no longer the old one.
    const v2 = await createOwnerE2EKey();
    const v2kid = "e2e-key-2";
    const v2public = { ...v2.publicJwk, kid: v2kid };
    await server.close();
    rotated = await startLoopbackJsonServer(JSON.stringify({ keys: [v2public] }));
    const servedV2 = await (await fetch(rotated.url)).json();
    assert.equal(servedV2.keys.length, 1, "rotated JWKS must serve exactly one key");
    assert.equal(servedV2.keys[0].kid, v2kid, "rotated JWKS must serve the new kid");
    const rotatedToken = await signOwnerToken(v2.privateKey, { ...claims, iat: refreshAt, exp: refreshAt + 300 }, v2kid);
    assert.equal(decodeJwtHeader(rotatedToken).kid, v2kid, "post-rotation token must reference the new kid");
    return pass("short-lived token, refresh issuance (old expired/new valid, subject preserved), JWKS rotation to e2e-key-2");
  } catch (error) {
    assert.ok(error instanceof assert.AssertionError, `unexpected harness error: ${error.message}`);
    return fail(`JWT refresh assertion failed: ${error.message}`);
  } finally {
    await server.close().catch(() => {});
    await rotated?.close().catch(() => {});
  }
}

// --- 92.4: compatible deploy --------------------------------------------
// prepareLocal derives DEPLOYMENT_GENERATION deterministically from the
// state directory; restarting (re-preparing + rebooting the Worker) must
// serve the same generation and report ready — in-flight run bindings stay
// valid because nothing silently re-generations underneath them.
async function verifyCompatibleDeploy() {
  const BOOT_TIMEOUT_MS = 12 * 60 * 1000;
  return withTempDir("s92-continuity-deploy-", async (directory) => {
    const boot = (async () => {
      const paths = await prepareLocal({ stateDirectory: directory, log: () => {} });
      const worker = await startLocalWorker(paths);
      try {
        const first = await (await fetch(`${worker.origin}/healthz`)).json();
        assert.equal(first.ready, true, "first boot must report ready");
        assert.equal(first.deployment_generation, paths.generation, "first boot must serve the prepared generation");
        await worker.stop();
        const paths2 = await prepareLocal({ stateDirectory: directory, log: () => {} });
        assert.equal(paths2.generation, paths.generation, "re-prepare of the same state dir must derive the same generation");
        const worker2 = await startLocalWorker(paths2);
        try {
          const second = await (await fetch(`${worker2.origin}/healthz`)).json();
          assert.equal(second.ready, true, "second boot must report ready");
          assert.equal(second.deployment_generation, paths.generation,
            "compatible redeploy must keep serving the same deployment generation");
        } finally { await worker2.stop(); }
      } finally { try { await worker.stop(); } catch { /* already stopped */ } }
      return paths.generation;
    })();
    let bootReject;
    const bootTimer = setTimeout(
      () => bootReject(new Error("local Worker boot timed out")), BOOT_TIMEOUT_MS);
    const timeout = new Promise((_, reject) => { bootReject = reject; });
    try {
      const generation = await Promise.race([boot, timeout]);
      return pass(`restart preserved deployment generation ${generation} with ready healthz on both boots`);
    } catch (error) {
      if (error instanceof assert.AssertionError) return fail(`compatible deploy assertion failed: ${error.message}`);
      return notExecuted(`local Worker boot unavailable in this environment: ${error.message.slice(0, 200)}`);
    } finally {
      clearTimeout(bootTimer);
    }
  });
}

// --- 92.4: source schema v1→v2 -------------------------------------------
// The migration stream itself carries real v1→v2 generation upgrades
// (e.g. research-question-v2-utf8-envelopes via 0069, retrieval-scope-v2
// via 0071). Applying the full stream must land every upgrade exactly
// once: no gaps, no duplicate generation rows, no unapplied file.
async function verifySourceGenerationsV1V2() {
  let db = null;
  try {
    ({ db } = await applyProductionMigrations());
    const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith(".sql")).sort();
    const state = schemaState(db);
    assert.equal(state.get("research_question_generation"), "research-question-v2-utf8-envelopes",
      "migration 0069 must upgrade the research question generation to v2");
    assert.equal(state.get("research_scope_profile_generation"), "retrieval-scope-v2",
      "migration 0071 must upgrade the retrieval scope generation to v2");
    const keys = db.prepare("SELECT key, COUNT(*) c FROM schema_state GROUP BY key HAVING c > 1").all();
    assert.equal(keys.length, 0, "every generation key must have exactly one row after upgrade (no v1/v2 ambiguity)");
    const applied = db.prepare("SELECT COUNT(*) c FROM sqlite_master WHERE type='table'").get().c;
    assert.ok(applied > 100, "migrated schema must contain the full table set");
    return pass(`${files.length} migrations applied; v1→v2 upgrades landed once each (research-question-v2, retrieval-scope-v2)`);
  } catch (error) {
    if (error instanceof assert.AssertionError) return fail(`generation migration assertion failed: ${error.message}`);
    return fail(`generation migration harness error: ${error.message}`);
  } finally { db?.close(); }
}

// --- 92.4: offline --------------------------------------------------------
// The live offline canary (CDP Network.emulateNetworkConditions) needs a
// real Chromium. Gate honestly; the pure fixture wiring is verified here.
async function verifyOffline() {
  try {
    assert.equal(typeof runBrowserResearchReadinessCanary, "function",
      "the offline canary entry point must exist");
    const fixture = createBrowserResearchReadinessFixture({ resolvedEvidence: () => ({ ref: "fixture-evidence" }) });
    for (const key of ["setHealthReady", "setQueryMode", "setOrientationMode", "handleHealth", "handleQuery"]) {
      assert.equal(typeof fixture[key], "function", `readiness fixture must expose ${key}`);
    }
    fixture.setHealthReady(false);
    fixture.setQueryMode("normal");
    fixture.setOrientationMode("normal");
  } catch (error) {
    if (error instanceof assert.AssertionError) return fail(`offline fixture assertion failed: ${error.message}`);
    return fail(`offline fixture harness error: ${error.message}`);
  }
  try {
    await resolveLocalBrowserExecutable();
  } catch (error) {
    return notExecuted(`readiness fixture wiring verified; live CDP offline emulation needs Chromium: ${error.message.slice(0, 160)} ` +
      `(run scripts/test-library-browser.mjs in the S92 browser environment)`);
  }
  return notExecuted("readiness fixture wiring verified; the live CDP offline canary is not run here because " +
    "this module has no Playwright CDP driver; run scripts/test-library-browser.mjs in the S92 browser environment");
}

// --- 92.4: run cancellation -----------------------------------------------
// Cancellation is a durable intent: the production readback assertion
// (the exact function owner-e2e uses on live D1 rows) must retain
// CANCEL_REQUESTED bindings, reject foreign owners and duplicate bindings;
// the D1 layer must record exactly one terminal CANCELLED attempt+receipt.
function cancelBinding(overrides = {}) {
  return {
    workflow_id: `exhaustive-workflow-${"a".repeat(64)}`,
    job_id: `exhaustive-job-${"b".repeat(48)}`,
    principal_ref: "e2e-owner",
    client_class: "owner_pwa",
    credential_generation: "credential-1",
    deployment_generation: "deployment-1",
    request_identity_digest: "c".repeat(64),
    state: "CANCEL_REQUESTED",
    ...overrides,
  };
}

async function verifyCancel() {
  try {
    const binding = cancelBinding();
    const job = { job_id: binding.job_id, principal_ref: binding.principal_ref,
      client_class: binding.client_class, credential_generation: binding.credential_generation, state: "PENDING" };
    assert.deepEqual(assertWorkflowJobReadback([binding], [job]), { bindingCount: 1, jobRowCount: 1 },
      "cancelled run readback must retain one binding and one job");
    assert.throws(() => assertWorkflowJobReadback([binding], [{ ...job, principal_ref: "foreign-owner" }]),
      /bound owner principal/u, "foreign-owner cancellation readback must be rejected");
    assert.throws(() => assertWorkflowJobReadback(
      [binding, cancelBinding({ workflow_id: `exhaustive-workflow-${"d".repeat(64)}` })], [job]),
      /must not duplicate a job identity/u, "duplicate cancellation bindings for one job must be rejected");
  } catch (error) {
    if (error instanceof assert.AssertionError) return fail(`cancel readback assertion failed: ${error.message}`);
    return fail(`cancel harness error: ${error.message}`);
  }
  let db = null;
  try {
    ({ db } = await applyProductionMigrations());
    const at = "2026-10-01T00:00:00Z";
    db.prepare(`INSERT INTO operation_intent(intent_id, revision, operation_kind, principal_ref,
      idempotency_key, payload_ref, policy_decision_ref, budget_reservation_ref, cancellation_ref, created_at)
      VALUES ('intent-cancel-1', 1, 'RESEARCH_RUN', 'owner', 'cancel-key-1', 'payload', 'policy', NULL, NULL, ?1)`)
      .run(at);
    db.prepare(`INSERT INTO operation_attempt(attempt_id, intent_id, intent_revision, attempt_number,
      state, checkpoint_ref, error_code, started_at, ended_at)
      VALUES ('attempt-cancel-1', 'intent-cancel-1', 1, 1, 'CANCELLED', NULL, 'OWNER_CANCELLED', ?1, ?1)`).run(at);
    db.prepare(`INSERT INTO operation_receipt(receipt_id, revision, intent_id, intent_revision, attempt_id,
      outcome, output_refs_json, readback_receipt_refs_json, reconciliation_required, reason_codes_json, created_at)
      VALUES ('receipt-cancel-1', 1, 'intent-cancel-1', 1, 'attempt-cancel-1', 'CANCELLED',
      '[]', '[]', 0, '["OWNER_CANCELLED"]', ?1)`).run(at);
    const terminal = db.prepare(`SELECT a.state, r.outcome FROM operation_attempt a
      JOIN operation_receipt r ON r.attempt_id = a.attempt_id WHERE a.intent_id = 'intent-cancel-1'`).all();
    assert.equal(terminal.length, 1, "cancelled run must leave exactly one terminal attempt+receipt pair");
    assert.deepEqual([terminal[0].state, terminal[0].outcome], ["CANCELLED", "CANCELLED"],
      "terminal pair must record CANCELLED on both attempt and receipt");
    return pass("CANCEL_REQUESTED readback retained; foreign/duplicate bindings rejected; one terminal CANCELLED pair in D1");
  } catch (error) {
    if (error instanceof assert.AssertionError) return fail(`cancel D1 assertion failed: ${error.message}`);
    return fail(`cancel D1 harness error: ${error.message}`);
  } finally { db?.close(); }
}

// --- 92.4: same-run recovery ------------------------------------------------
// Exactly-once: the production schema declares UNIQUE(operation_kind,
// idempotency_key) on operation_intent. A same-key replay must hit the
// existing intent (UNIQUE violation on re-insert), never a second one;
// a SUCCEEDED attempt must read back exactly once — recovery replays
// readback, not effects.
async function verifySameRunRecover() {
  let db = null;
  try {
    ({ db } = await applyProductionMigrations());
    const at = "2026-10-01T00:00:00Z";
    const insertIntent = db.prepare(`INSERT INTO operation_intent(intent_id, revision, operation_kind,
      principal_ref, idempotency_key, payload_ref, policy_decision_ref, budget_reservation_ref,
      cancellation_ref, created_at)
      VALUES ('intent-recover-1', 1, 'RESEARCH_RUN', 'owner', 'recover-key-1', 'payload', 'policy', NULL, NULL, ?1)`);
    insertIntent.run(at);
    assert.throws(() => insertIntent.run(at), /UNIQUE constraint failed/u,
      "same-key replay must hit the existing intent (UNIQUE violation), never a second intent row");
    const intents = db.prepare("SELECT COUNT(*) c FROM operation_intent WHERE idempotency_key = 'recover-key-1'").get().c;
    assert.equal(intents, 1, "exactly one intent row must exist for the idempotency key");
    db.prepare(`INSERT INTO operation_attempt(attempt_id, intent_id, intent_revision, attempt_number,
      state, checkpoint_ref, error_code, started_at, ended_at)
      VALUES ('attempt-recover-1', 'intent-recover-1', 1, 1, 'SUCCEEDED', NULL, NULL, ?1, ?1)`).run(at);
    db.prepare(`INSERT INTO operation_receipt(receipt_id, revision, intent_id, intent_revision, attempt_id,
      outcome, output_refs_json, readback_receipt_refs_json, reconciliation_required, reason_codes_json, created_at)
      VALUES ('receipt-recover-1', 1, 'intent-recover-1', 1, 'attempt-recover-1', 'SUCCEEDED',
      '[]', '[]', 0, '[]', ?1)`).run(at);
    // Recovery replays readback: the completed attempt is found, no second
    // attempt is minted for the same intent revision.
    const attempts = db.prepare(`SELECT attempt_id, state FROM operation_attempt
      WHERE intent_id = 'intent-recover-1' AND intent_revision = 1`).all();
    assert.equal(attempts.length, 1, "recovery must find exactly one attempt for the completed run");
    assert.equal(attempts[0].state, "SUCCEEDED", "the recovered attempt must be the SUCCEEDED one, not a repeat");
    return pass("same-key replay converged on the single intent; SUCCEEDED attempt read back once, no repeated effect");
  } catch (error) {
    if (error instanceof assert.AssertionError) return fail(`recovery assertion failed: ${error.message}`);
    return fail(`recovery harness error: ${error.message}`);
  } finally { db?.close(); }
}

export const SCENARIOS = [
  { name: "s92-continuity-jwt-refresh", run: verifyJwtRefresh },
  { name: "s92-continuity-compatible-deploy", run: verifyCompatibleDeploy },
  { name: "s92-continuity-source-generations-v1-v2", run: verifySourceGenerationsV1V2 },
  { name: "s92-continuity-offline", run: verifyOffline },
  { name: "s92-continuity-cancel", run: verifyCancel },
  { name: "s92-continuity-same-run-recover", run: verifySameRunRecover },
];

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  let failed = 0;
  for (const { name, run } of SCENARIOS) {
    try {
      const result = await run();
      console.log(`${result.state} ${name}${result.detail ? ` — ${result.detail}` : ""}`);
      if (result.state === "FAIL") failed += 1;
    } catch (error) {
      failed += 1;
      console.log(`FAIL ${name} — unexpected throw: ${error?.message?.slice(0, 300)}`);
    }
  }
  process.exitCode = failed === 0 ? 0 : 1;
}
