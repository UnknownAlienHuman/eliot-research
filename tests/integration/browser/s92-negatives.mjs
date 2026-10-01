// S92 92.6 — negative actor/scope/revoke/purge/corrupt/CAS/late-reply scenarios.
/* global process: readonly, console: readonly */
//
// Every scenario drives REAL harness entry points (scripts/lib/local-*.mjs and
// tests/integration/browser/owner-e2e.mjs exports) with injected fakes only at
// the documented transport seams (D1 query, fetch). The system under test is
// never stubbed: validation, conflict detection, revocation, settlement and
// terminal classification all execute for real.
//
// State discipline: missing credentials/environment -> NOT_EXECUTED (honest
// skip, never a fake PASS); unmet prerequisite -> BLOCKED; any assertion
// failure -> FAIL with the reason. Every negative asserts the fail-closed
// outcome AND that nothing was partially committed.
//
// Model policy (D1): local default AI_GATEWAY_REASONING_URL is
// https://example.invalid/local-disabled and there is no local fake model
// gateway. These scenarios never touch a model and never invent model output.

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { applyLocalReadPolicy, validatePolicyCommand } from "../../../scripts/lib/local-read-policy.mjs";
import { initializeLocalNamespace, validateNamespaceCommand } from "../../../scripts/lib/local-namespace.mjs";
import { validateWorkerOrigin, readOwnerIdentity } from "../../../scripts/lib/local-owner-login.mjs";
import { sqlLiteral } from "../../../scripts/lib/local-sql.mjs";
import { createRequestTerminalTracker, readbackWithBoundedRetry } from "./owner-e2e.mjs";

const NOW = Date.parse("2026-10-01T12:00:00.000Z");
const nowFn = () => NOW;
const isoHours = (hours) => new Date(NOW + hours * 3600_000).toISOString();

const POLICY_COLUMNS = ["source_namespace_id", "principal_ref", "client_class", "policy_ref", "generation",
  "allowed_use_json", "disclosure_ceiling", "state", "expires_at", "created_at"];

function ownerIdentity(overrides = {}) {
  return {
    protocol: "eliotr.owner-session.v1",
    client_class: "owner_pwa",
    principal_ref: "e2e-owner",
    credential_generation: "cred-gen-1",
    expires_at: isoHours(1),
    ...overrides,
  };
}

function grantCommand(overrides = {}) {
  return {
    action: "GRANT",
    namespace: "s92-neg-ns",
    expected_generation: 0,
    allowed_use: ["research"],
    disclosure: "internal",
    expires_at: isoHours(24),
    ...overrides,
  };
}

function revokeCommand(expectedGeneration, overrides = {}) {
  return { action: "REVOKE", namespace: "s92-neg-ns", expected_generation: expectedGeneration, ...overrides };
}

function namespaceCommand(overrides = {}) {
  return {
    protocol: "eliotr.local-namespace-init.v1",
    namespace: "s92-neg-ns",
    owner_incarnation_ref: "owner-inc-1",
    expected_ownership_revision: 0,
    expected_policy_revision: 0,
    created_at: new Date(NOW).toISOString(),
    policy: {
      allowed_ownership_modes: ["immutable_import"],
      source_class: "test-class",
      assurance_ceiling: "CAPTURED",
      instruction_taint: "UNTRUSTED",
      allowed_effects: "NO_EXTERNAL_EFFECT",
      allowed_use: ["research"],
      disclosure_ceiling: "internal",
      license_policy_ref: "lic-1",
      default_storage_policy: "NORMALIZED_CLOUD_ONLY",
      default_residency_profile_id: "res-1",
      default_retention_policy_id: "ret-1",
      minimum_quality_state: "standard",
    },
    ...overrides,
  };
}

// In-memory D1 fake for the scope_read_policy / source_namespace_ownership
// tables. Applies INSERT/UPDATE mutations from parsed SQL so the harness's
// exact-readback settlement check runs against real stored state.
function createPolicyD1Fake({ ownership = null, policy = null } = {}) {
  const statements = [];
  let ownershipRow = ownership ? { ...ownership } : null;
  let policyRow = policy ? { ...policy } : null;

  const splitList = (text) => {
    const parts = [];
    let current = "", inQuote = false;
    for (let i = 0; i < text.length; i += 1) {
      const ch = text[i];
      if (ch === "'") {
        if (inQuote && text[i + 1] === "'") { current += "''"; i += 1; continue; }
        inQuote = !inQuote;
        current += ch;
        continue;
      }
      if (ch === "," && !inQuote) { parts.push(current.trim()); current = ""; continue; }
      current += ch;
    }
    parts.push(current.trim());
    return parts;
  };
  const unquote = (token) => {
    if (/^-?\d+$/.test(token)) return Number(token);
    if (token.length >= 2 && token.startsWith("'") && token.endsWith("'")) {
      return token.slice(1, -1).replaceAll("''", "'");
    }
    throw new Error(`fake D1 cannot parse literal: ${token.slice(0, 40)}`);
  };

  const query = async (sql) => {
    statements.push(sql);
    const head = sql.trimStart().slice(0, 6).toUpperCase();
    if (head === "SELECT") {
      if (sql.includes("FROM scope_read_policy")) return policyRow ? [{ ...policyRow }] : [];
      if (sql.includes("FROM source_namespace_ownership")) {
        if (sql.includes("status='ACTIVE'")) {
          if (!ownershipRow || ownershipRow.status !== "ACTIVE") return [];
          return [{
            ownership_record_revision: ownershipRow.ownership_record_revision,
            source_owner_generation: ownershipRow.source_owner_generation,
          }];
        }
        return ownershipRow ? [{ ...ownershipRow }] : [];
      }
      throw new Error(`fake D1: unexpected SELECT ${sql.slice(0, 80)}`);
    }
    if (head === "INSERT") {
      const selectIdx = sql.indexOf("SELECT");
      const whereIdx = sql.indexOf(" WHERE ", selectIdx);
      const literals = splitList(sql.slice(selectIdx + 6, whereIdx)).map(unquote);
      const guardOk = !sql.includes("status='ACTIVE'") || (ownershipRow !== null && ownershipRow.status === "ACTIVE");
      if (guardOk && policyRow === null) {
        policyRow = Object.fromEntries(POLICY_COLUMNS.map((key, index) => [key, literals[index]]));
      }
      return [];
    }
    if (head === "UPDATE") {
      const setIdx = sql.indexOf(" SET ") + 5;
      const whereIdx = sql.indexOf(" WHERE ", setIdx);
      for (const pair of splitList(sql.slice(setIdx, whereIdx))) {
        const eq = pair.indexOf("=");
        if (policyRow !== null) policyRow[pair.slice(0, eq)] = unquote(pair.slice(eq + 1));
      }
      return [];
    }
    throw new Error(`fake D1: unexpected statement ${sql.slice(0, 80)}`);
  };

  return {
    query,
    statements: () => [...statements],
    mutationCount: () => statements.filter((s) => /^(INSERT|UPDATE)/.test(s.trimStart())).length,
    policyRow: () => (policyRow ? { ...policyRow } : null),
    setOwnership: (row) => { ownershipRow = row ? { ...row } : null; },
  };
}

const activeOwnership = () => ({ ownership_record_revision: 1, source_owner_generation: "owner-gen-1", status: "ACTIVE" });

// Reconstructs the exact ownership row initializeLocalNamespace derives, so a
// replay test can differ in exactly one axis (e.g. retired status).
function expectedOwnerRow(namespace, ownerIncarnationRef, principalRef, createdAt, status = "ACTIVE") {
  const digest = createHash("sha256")
    .update(JSON.stringify(["eliotr.source-owner.initial.v1", namespace, "eliotr", ownerIncarnationRef, 1, "ACTIVE"]))
    .digest("hex");
  return {
    source_namespace_id: namespace,
    ownership_record_revision: 1,
    owner_system_id: "eliotr",
    owner_incarnation_ref: ownerIncarnationRef,
    source_owner_generation: `owner-${digest}`,
    source_admission_policy_revision: 1,
    status,
    cutover_receipt_ref: null,
    created_at: createdAt,
    row_count: 1,
  };
}

function expectedPolicyRow(command, principalRef) {
  const policy = command.policy;
  return {
    source_namespace_id: command.namespace,
    revision: 1,
    authorized_principal_refs_json: JSON.stringify([principalRef]),
    allowed_ownership_modes_json: '["immutable_import"]',
    source_class: policy.source_class,
    assurance_ceiling: policy.assurance_ceiling,
    instruction_taint: policy.instruction_taint,
    allowed_effects: policy.allowed_effects,
    allowed_use_json: JSON.stringify([...policy.allowed_use].sort()),
    disclosure_ceiling: policy.disclosure_ceiling,
    license_policy_ref: policy.license_policy_ref,
    default_storage_policy: policy.default_storage_policy,
    default_residency_profile_id: policy.default_residency_profile_id,
    default_retention_policy_id: policy.default_retention_policy_id,
    minimum_quality_state: policy.minimum_quality_state,
    created_at: command.created_at,
    row_count: 1,
  };
}

// D1 fake for initializeLocalNamespace read() paths only; any mutation attempt
// is recorded and rejected loudly (these scenarios never reach a write).
function createNamespaceReadFake({ ownerRow = null, policyRow = null } = {}) {
  const statements = [];
  const query = async (sql) => {
    statements.push(sql);
    const head = sql.trimStart().slice(0, 6).toUpperCase();
    if (head !== "SELECT") throw new Error(`namespace fake: unexpected write ${sql.slice(0, 60)}`);
    if (sql.includes("FROM source_namespace_ownership")) return ownerRow ? [{ ...ownerRow }] : [];
    if (sql.includes("FROM source_admission_policy")) return policyRow ? [{ ...policyRow }] : [];
    throw new Error(`namespace fake: unexpected SELECT ${sql.slice(0, 80)}`);
  };
  return { query, statements: () => [...statements] };
}

function fakeFetchJson(envelope, { status = 200, contentType = "application/json" } = {}) {
  return async () => ({
    status,
    redirected: false,
    headers: { get: (name) => (name.toLowerCase() === "content-type" ? contentType : null) },
    body: {
      getReader() {
        const bytes = new globalThis.TextEncoder().encode(JSON.stringify(envelope));
        let consumed = false;
        return {
          async read() {
            if (consumed) return { done: true, value: undefined };
            consumed = true;
            return { done: false, value: new Uint8Array(bytes) };
          },
          cancel() { return Promise.resolve(); },
        };
      },
    },
  });
}

function validSessionEnvelope(generation = "dep-gen-1") {
  return {
    data: {
      protocol: "eliotr.owner-session.v1",
      client_class: "owner_pwa",
      principal_ref: "e2e-owner",
      credential_generation: "cred-gen-1",
      expires_at: isoHours(1),
    },
    deployment_generation: generation,
    trace_id: "trace-1",
  };
}

async function scenarioActorUnauthorizedDenied() {
  // Wrong-protocol identity: denied before any D1 observation.
  {
    const fake = createPolicyD1Fake({ ownership: activeOwnership() });
    await assert.rejects(
      applyLocalReadPolicy({ command: grantCommand(), identity: ownerIdentity({ protocol: "wrong" }), query: fake.query, now: nowFn }),
      /unexpired Worker-verified owner identity/,
      "wrong-protocol actor must be denied");
    assert.equal(fake.statements().length, 0, "denied actor must cause zero D1 statements");
    assert.equal(fake.policyRow(), null, "denied actor must commit nothing");
  }
  // Expired identity: denied before any D1 observation.
  {
    const fake = createPolicyD1Fake({ ownership: activeOwnership() });
    await assert.rejects(
      applyLocalReadPolicy({ command: grantCommand(), identity: ownerIdentity({ expires_at: isoHours(-1) }), query: fake.query, now: nowFn }),
      /unexpired Worker-verified owner identity/,
      "expired identity must be denied");
    assert.equal(fake.statements().length, 0, "expired identity must cause zero D1 statements");
  }
  // Machine (non-owner) client class: denied.
  {
    const fake = createPolicyD1Fake({ ownership: activeOwnership() });
    await assert.rejects(
      applyLocalReadPolicy({ command: grantCommand(), identity: ownerIdentity({ client_class: "machine" }), query: fake.query, now: nowFn }),
      /unexpired Worker-verified owner identity/,
      "non-owner client class must be denied");
    assert.equal(fake.statements().length, 0, "machine actor must cause zero D1 statements");
  }
  // Worker identity readback with a generation mismatch: the real
  // readOwnerIdentity rejects the envelope instead of minting a session.
  await assert.rejects(
    readOwnerIdentity("http://127.0.0.1:8787", "token", "dep-gen-1",
      { fetchImpl: fakeFetchJson(validSessionEnvelope("other-gen")), now: nowFn }),
    /rejected the exact owner identity/,
    "generation-mismatched session envelope must be rejected");
  // Non-JSON session body: rejected, never parsed as identity.
  await assert.rejects(
    readOwnerIdentity("http://127.0.0.1:8787", "token", "dep-gen-1",
      { fetchImpl: fakeFetchJson(validSessionEnvelope(), { contentType: "text/html" }), now: nowFn }),
    /Deployment readback rejected/,
    "non-JSON session body must be rejected");
  // Positive control: the exact envelope is accepted.
  const identity = await readOwnerIdentity("http://127.0.0.1:8787", "token", "dep-gen-1",
    { fetchImpl: fakeFetchJson(validSessionEnvelope()), now: nowFn });
  assert.equal(identity.principal_ref, "e2e-owner", "exact session envelope must be accepted");
  return { state: "PASS", detail: "5 denials + 1 positive control; zero D1 statements on every denial" };
}

async function scenarioScopeOutOfScopeDenied() {
  // Grant against a namespace with no ACTIVE ownership: denied, nothing stored.
  {
    const fake = createPolicyD1Fake({ ownership: null });
    await assert.rejects(
      applyLocalReadPolicy({ command: grantCommand(), identity: ownerIdentity(), query: fake.query, now: nowFn }),
      /missing or inactive namespace/,
      "grant without an active namespace must be denied");
    assert.equal(fake.policyRow(), null, "out-of-scope grant must store no policy row");
    assert.equal(fake.mutationCount(), 0, "out-of-scope grant must issue no mutation");
  }
  // Grant against a retired namespace: denied the same way.
  {
    const fake = createPolicyD1Fake({ ownership: { ...activeOwnership(), status: "RETIRED" } });
    await assert.rejects(
      applyLocalReadPolicy({ command: grantCommand(), identity: ownerIdentity(), query: fake.query, now: nowFn }),
      /missing or inactive namespace/,
      "grant against a retired namespace must be denied");
    assert.equal(fake.policyRow(), null, "retired-namespace grant must store no policy row");
  }
  // Grant whose allowed_use omits research: rejected at validation, pre-D1.
  {
    const fake = createPolicyD1Fake({ ownership: activeOwnership() });
    await assert.rejects(
      applyLocalReadPolicy({ command: grantCommand({ allowed_use: ["other"] }), identity: ownerIdentity(), query: fake.query, now: nowFn }),
      /Grant requires explicit uses/,
      "grant without the research use must be rejected");
    assert.equal(fake.statements().length, 0, "invalid grant must cause zero D1 statements");
  }
  // Namespace init for a foreign-shaped namespace id: rejected at validation.
  assert.throws(
    () => validateNamespaceCommand(namespaceCommand({ namespace: "not a valid id!" }), NOW),
    /LOCAL_NAMESPACE_INPUT_INVALID/,
    "malformed namespace id must be rejected");
  return { state: "PASS", detail: "4 denials; no policy row and no mutation on any denial" };
}

async function scenarioRevokeEnforced() {
  const fake = createPolicyD1Fake({ ownership: activeOwnership() });
  const identity = ownerIdentity();
  const granted = await applyLocalReadPolicy({ command: grantCommand(), identity, query: fake.query, now: nowFn });
  assert.equal(granted.state, "APPLIED_OR_REPLAY");
  assert.equal(granted.policy.state, "ACTIVE");
  assert.equal(granted.policy.generation, 1);
  assert.equal(fake.mutationCount(), 1, "grant must be exactly one mutation");

  const revoked = await applyLocalReadPolicy({ command: revokeCommand(1), identity, query: fake.query, now: nowFn });
  assert.equal(revoked.state, "APPLIED_OR_REPLAY");
  assert.equal(revoked.policy.state, "REVOKED", "revocation must flip the durable state");
  assert.equal(revoked.policy.generation, 2, "revocation must advance the generation");
  assert.equal(fake.mutationCount(), 2, "revoke must be exactly one more mutation");

  const readback = fake.policyRow();
  assert.equal(readback.state, "REVOKED", "durable readback must show REVOKED");
  assert.equal(readback.generation, 2);

  // Replaying the same revocation is idempotent: the existing row is returned,
  // no second effect is minted.
  const replayed = await applyLocalReadPolicy({ command: revokeCommand(1), identity, query: fake.query, now: nowFn });
  assert.equal(replayed.state, "APPLIED_OR_REPLAY");
  assert.equal(replayed.policy.generation, 2);
  assert.equal(fake.mutationCount(), 2, "idempotent revoke replay must issue no mutation");

  // A revocation against a generation that was never current is a CAS
  // conflict, not a second revoke.
  await assert.rejects(
    applyLocalReadPolicy({ command: revokeCommand(5), identity, query: fake.query, now: nowFn }),
    /LOCAL_POLICY_CONFLICT/,
    "revocation at a never-current generation must conflict");
  assert.equal(fake.mutationCount(), 2, "conflicted revocation must issue no mutation");
  assert.equal(fake.policyRow().generation, 2, "conflict must leave the row untouched");

  // Revoking a nonexistent policy is an error, not a silent no-op.
  const empty = createPolicyD1Fake({ ownership: activeOwnership() });
  await assert.rejects(
    applyLocalReadPolicy({ command: revokeCommand(1), identity, query: empty.query, now: nowFn }),
    /Read policy does not exist/,
    "revoke of a missing policy must fail");
  return { state: "PASS", detail: "grant->revoke->stale-conflict; durable REVOKED at generation 2" };
}

async function scenarioPurgeSemanticsSticky() {
  const fake = createPolicyD1Fake({ ownership: activeOwnership() });
  const identity = ownerIdentity();
  await applyLocalReadPolicy({ command: grantCommand(), identity, query: fake.query, now: nowFn });
  await applyLocalReadPolicy({ command: revokeCommand(1), identity, query: fake.query, now: nowFn });
  // Purge: the namespace ownership is retired.
  fake.setOwnership({ ...activeOwnership(), status: "RETIRED" });

  // A fresh grant after purge is denied by the ownership guard even with a
  // current generation: retirement is sticky, no resurrection.
  await assert.rejects(
    applyLocalReadPolicy({ command: grantCommand({ expected_generation: 2 }), identity, query: fake.query, now: nowFn }),
    /missing or inactive namespace/,
    "post-purge grant must be denied");
  const row = fake.policyRow();
  assert.equal(row.state, "REVOKED", "post-purge policy must stay REVOKED");
  assert.equal(row.generation, 2, "post-purge denial must not advance the generation");
  assert.equal(fake.mutationCount(), 2, "post-purge denial must issue no mutation");

  // A namespace-init replay against the retired owner conflicts: a retired
  // owner can never be revived by replaying initialization.
  const command = namespaceCommand();
  const nsFake = createNamespaceReadFake({
    ownerRow: expectedOwnerRow(command.namespace, command.owner_incarnation_ref, identity.principal_ref, command.created_at, "RETIRED"),
    policyRow: expectedPolicyRow(command, identity.principal_ref),
  });
  await assert.rejects(
    initializeLocalNamespace({ command, identity, query: nsFake.query, now: nowFn }),
    /LOCAL_NAMESPACE_CONFLICT/,
    "init replay against a retired owner must conflict");
  assert.ok(nsFake.statements().every((s) => s.trimStart().startsWith("SELECT")),
    "conflicted replay must issue no mutation");
  return { state: "PASS", detail: "purge retires ownership; grant denied, replay conflicts, REVOKED row intact" };
}

async function scenarioCorruptInputRejected() {
  const explosiveQuery = async () => { throw new Error("query must not be reached during pure validation"); };
  const policyCases = [
    ["bad action", { ...grantCommand(), action: "DELETE" }, /Invalid local read-policy action/],
    ["extra key", { ...grantCommand(), extra: 1 }, /Policy requires one namespace/],
    ["negative generation", grantCommand({ expected_generation: -1 }), /Policy requires one namespace/],
    ["generation at int32 limit", grantCommand({ expected_generation: 2147483647 }), /Policy requires one namespace/],
    ["grant without research use", grantCommand({ allowed_use: ["other"] }), /Grant requires explicit uses/],
    ["duplicate uses", grantCommand({ allowed_use: ["research", "research"] }), /Grant requires explicit uses/],
    ["non-canonical expiry", grantCommand({ expires_at: "2026-10-02 12:00:00" }), /Grant requires explicit uses/],
    ["expired expiry", grantCommand({ expires_at: isoHours(-1) }), /Grant requires explicit uses/],
    ["expiry beyond seven days", grantCommand({ expires_at: isoHours(24 * 8) }), /Grant requires explicit uses/],
    ["revoke at generation zero", revokeCommand(0), /Revocation requires the current positive generation/],
  ];
  for (const [label, command, pattern] of policyCases) {
    assert.throws(() => validatePolicyCommand(command, NOW), pattern, `policy: ${label}`);
  }
  const namespaceCases = [
    ["wrong protocol", namespaceCommand({ protocol: "wrong" }), /LOCAL_NAMESPACE_INPUT_INVALID/],
    ["future created_at", namespaceCommand({ created_at: isoHours(1) }), /LOCAL_NAMESPACE_INPUT_INVALID/],
    ["stale created_at", namespaceCommand({ created_at: isoHours(-24 * 8) }), /LOCAL_NAMESPACE_INPUT_INVALID/],
    ["unsupported ceiling", namespaceCommand({ policy: { ...namespaceCommand().policy, assurance_ceiling: "TOP_SECRET" } }), /LOCAL_NAMESPACE_PROFILE_UNSUPPORTED/],
    ["malformed namespace", namespaceCommand({ namespace: "bad id!" }), /LOCAL_NAMESPACE_INPUT_INVALID/],
  ];
  for (const [label, command, pattern] of namespaceCases) {
    assert.throws(() => validateNamespaceCommand(command, NOW), pattern, `namespace: ${label}`);
  }
  // None of the pure validators may touch D1.
  await assert.rejects(
    applyLocalReadPolicy({ command: { ...grantCommand(), action: "DELETE" }, identity: ownerIdentity(), query: explosiveQuery, now: nowFn }),
    /Invalid local read-policy action/);
  // Worker origin validation: loopback only.
  assert.throws(() => validateWorkerOrigin("https://example.com/"), /fixed IPv4 loopback/, "https origin must be rejected");
  assert.throws(() => validateWorkerOrigin("http://example.com:8080"), /fixed IPv4 loopback/, "non-loopback host must be rejected");
  assert.equal(validateWorkerOrigin("http://127.0.0.1:8787"), "http://127.0.0.1:8787", "loopback origin must be accepted");
  // SQL quoting neutralizes injection shapes instead of executing them.
  assert.equal(sqlLiteral("a'b"), "'a''b'", "single quotes must be doubled");
  return { state: "PASS", detail: `${policyCases.length + namespaceCases.length} corrupt inputs rejected; zero D1 reach` };
}

async function scenarioCasConflictSingleFlight() {
  // Stale-generation grant: exactly one winner. An identical replay is
  // idempotent; a divergent second grant at the old generation conflicts.
  {
    const fake = createPolicyD1Fake({ ownership: activeOwnership() });
    const identity = ownerIdentity();
    const first = await applyLocalReadPolicy({ command: grantCommand(), identity, query: fake.query, now: nowFn });
    assert.equal(first.policy.generation, 1);
    const replay = await applyLocalReadPolicy({ command: grantCommand(), identity, query: fake.query, now: nowFn });
    assert.equal(replay.state, "APPLIED_OR_REPLAY", "identical grant replay must be idempotent");
    assert.equal(fake.mutationCount(), 1, "idempotent replay must issue no mutation");
    await assert.rejects(
      applyLocalReadPolicy({ command: grantCommand({ disclosure: "other" }), identity, query: fake.query, now: nowFn }),
      /LOCAL_POLICY_CONFLICT/,
      "divergent grant at a stale generation must conflict");
    assert.equal(fake.mutationCount(), 1, "conflicted grant must issue no mutation");
    assert.equal(fake.policyRow().generation, 1, "conflict must leave the winner's row intact");
    assert.equal(fake.policyRow().state, "ACTIVE");
    assert.equal(fake.policyRow().disclosure_ceiling, "internal", "conflict must not smuggle the loser's disclosure");
  }
  // Lost acknowledgement: the harness reports SETTLEMENT_UNCERTAIN instead of
  // silently passing or minting a new generation.
  {
    const fake = createPolicyD1Fake({ ownership: activeOwnership() });
    let reads = 0;
    const flakyQuery = async (sql) => {
      reads += 1;
      if (reads === 3) throw new Error("SQLITE_BUSY: database is locked");
      return fake.query(sql);
    };
    await assert.rejects(
      applyLocalReadPolicy({ command: grantCommand(), identity: ownerIdentity(), query: flakyQuery, now: nowFn }),
      /LOCAL_POLICY_SETTLEMENT_UNCERTAIN/,
      "lost readback acknowledgement must be settlement-uncertain");
  }
  // Divergent namespace replay: same namespace, different incarnation conflicts.
  {
    const command = namespaceCommand();
    const nsFake = createNamespaceReadFake({
      ownerRow: expectedOwnerRow(command.namespace, "different-incarnation", ownerIdentity().principal_ref, command.created_at),
      policyRow: expectedPolicyRow(command, ownerIdentity().principal_ref),
    });
    await assert.rejects(
      initializeLocalNamespace({ command, identity: ownerIdentity(), query: nsFake.query, now: nowFn }),
      /LOCAL_NAMESPACE_CONFLICT/,
      "divergent replay must conflict");
    assert.ok(nsFake.statements().every((s) => s.trimStart().startsWith("SELECT")),
      "conflicted replay must issue no mutation");
  }
  return { state: "PASS", detail: "stale grant conflicts; lost ACK is SETTLEMENT_UNCERTAIN; divergent replay conflicts" };
}

async function scenarioLateReplyClassified() {
  const tracker = createRequestTerminalTracker();
  // A late duplicate response for an already-terminal request fails closed:
  // exactly one terminal outcome per request.
  assert.equal(tracker.noteResponse(7, 200), true, "first contract response must be recorded");
  assert.throws(() => tracker.noteResponse(7, 200), /duplicate response reqId 7 fails closed/,
    "late duplicate response must fail closed");
  // A late reply arriving after a failure terminal is rejected, not merged.
  tracker.noteFailure(8);
  assert.throws(() => tracker.noteResponse(8, 200), /response conflicts with failure terminal reqId 8/,
    "late reply after failure terminal must be rejected");
  // The legitimate late-reply path: an abort arriving after an accepted async
  // launch (202) is classified benign and suppressed, not a new failure.
  assert.equal(tracker.noteResponse(9, 202), true, "async launch 202 must be recorded");
  assert.equal(tracker.shouldSuppressFailure(9), true, "late abort after accepted 202 must be suppressed");
  // ...but only for contract outcomes: a late failure after a non-contract
  // response stays a real failure.
  assert.equal(tracker.noteResponse(10, 500), false, "non-contract status must be recorded as non-contract");
  assert.equal(tracker.shouldSuppressFailure(10), false, "late failure after non-contract response must not be suppressed");

  // Deterministic authority failures never retry: a "late" retry of a settled
  // conflict would be wrong, so exactly one attempt happens.
  let deterministicAttempts = 0;
  await assert.rejects(
    readbackWithBoundedRetry("s92-late-deterministic", async () => {
      deterministicAttempts += 1;
      throw new Error("LOCAL_POLICY_CONFLICT");
    }, { attempts: 3, delayMs: 1 }),
    /LOCAL_POLICY_CONFLICT/);
  assert.equal(deterministicAttempts, 1, "deterministic failure must not be retried");
  // Transient locks get exactly one bounded retry, then the late reply wins.
  let transientAttempts = 0;
  const value = await readbackWithBoundedRetry("s92-late-transient", async () => {
    transientAttempts += 1;
    if (transientAttempts === 1) {
      const error = new Error("d1 busy");
      error.cause = { diagnostic: "TRANSIENT_D1_LOCK" };
      throw error;
    }
    return "readback";
  }, { attempts: 3, delayMs: 1 });
  assert.equal(value, "readback");
  assert.equal(transientAttempts, 2, "transient lock must receive exactly one bounded retry");
  return { state: "PASS", detail: "late duplicates rejected; 202-abort suppressed; deterministic never retried; transient retried once" };
}

async function runScenario(name, run) {
  try {
    const result = await run();
    assert.ok(result && typeof result.state === "string", "scenario must return a { state } result");
    return { name, ...result };
  } catch (error) {
    return { name, state: "FAIL", detail: String(error?.message ?? error).slice(0, 500) };
  }
}

export const SCENARIOS = [
  { name: "s92-92.6-actor-unauthorized-denied", run: scenarioActorUnauthorizedDenied },
  { name: "s92-92.6-scope-out-of-scope-denied", run: scenarioScopeOutOfScopeDenied },
  { name: "s92-92.6-revoke-enforced", run: scenarioRevokeEnforced },
  { name: "s92-92.6-purge-semantics-sticky", run: scenarioPurgeSemanticsSticky },
  { name: "s92-92.6-corrupt-input-rejected", run: scenarioCorruptInputRejected },
  { name: "s92-92.6-cas-conflict-single-flight", run: scenarioCasConflictSingleFlight },
  { name: "s92-92.6-late-reply-classified", run: scenarioLateReplyClassified },
];

export async function runAll() {
  const results = [];
  for (const { name, run } of SCENARIOS) results.push(await runScenario(name, run));
  return results;
}

// Direct execution: run every scenario and print a summary.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const results = await runAll();
  let failed = 0;
  for (const result of results) {
    if (result.state === "FAIL") failed += 1;
    console.log(`${result.state.padEnd(16)} ${result.name}${result.detail ? ` — ${result.detail}` : ""}`);
  }
  console.log(`\n${results.length - failed}/${results.length} non-failing`);
  process.exit(failed === 0 ? 0 : 1);
}
