import assert from "node:assert/strict";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { ROOT } from "./lib/local-launch.mjs";
import { initializeLocalNamespace, validateNamespaceCommand } from "./lib/local-namespace.mjs";

const now = Date.now();
const identity = { protocol: "eliotr.owner-session.v1", principal_ref: "signed-owner", client_class: "owner_pwa",
  credential_generation: "credential-1", expires_at: new Date(now + 3600000).toISOString() };
const command = { protocol: "eliotr.local-namespace-init.v1", namespace: "local-imports", owner_incarnation_ref: "installation-1",
  expected_ownership_revision: 0, expected_policy_revision: 0, created_at: new Date(now).toISOString(), policy: {
    allowed_ownership_modes: ["immutable_import"], source_class: "document", assurance_ceiling: "QUALIFIED",
    instruction_taint: "DATA_ONLY", allowed_effects: "READ_ONLY", allowed_use: ["research"], disclosure_ceiling: "owner-only",
    license_policy_ref: "license-1", default_storage_policy: "NORMALIZED_CLOUD_ONLY",
    default_residency_profile_id: "residency-1", default_retention_policy_id: "retention-1", minimum_quality_state: "standard",
  } };
function fixture() {
  const db = new DatabaseSync(":memory:"); db.exec("PRAGMA foreign_keys=ON");
  for (const file of readdirSync(resolve(ROOT, "infra/d1/core/migrations")).sort()) {
    if (file.endsWith(".sql")) db.exec(readFileSync(resolve(ROOT, "infra/d1/core/migrations", file), "utf8"));
  }
  const statements = [];
  return { db, statements, query: async (sql) => { statements.push(sql); return db.prepare(sql).all().map((row) => ({ ...row })); } };
}
const invoke = (value, input = command, extra = {}) => initializeLocalNamespace({ command: input, identity, query: value.query, now: () => now, ...extra });
const count = (value, table) => value.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;

test("initializes one new namespace and explicit admission policy without read access, source or outbox", async () => {
  const value = fixture();
  try {
    const receipt = await invoke(value);
    assert.equal(receipt.ownership.owner_system_id, "eliotr");
    assert.match(receipt.ownership.source_owner_generation, /^owner-[a-f0-9]{64}$/u);
    assert.equal(receipt.admission_policy.authorized_principal_refs_json, '["signed-owner"]');
    assert.equal(receipt.admission_policy.allowed_ownership_modes_json, '["immutable_import"]');
    assert.equal(receipt.read_access_granted, false);
    assert.equal(count(value, "source_namespace_ownership"), 1); assert.equal(count(value, "source_admission_policy"), 1);
    for (const table of ["source", "source_revision", "scope_read_policy", "outbox"]) assert.equal(count(value, table), 0);
    assert.deepEqual(await invoke(value), receipt);
    assert.equal(value.statements.filter((sql) => sql.startsWith("INSERT")).length, 2);
    assert.deepEqual(value.db.prepare("PRAGMA foreign_key_check").all(), []);
  } finally { value.db.close(); }
});
test("binds the initial ownership token to namespace/incarnation, not policy settings", async () => {
  const a = fixture(); const b = fixture(); const c = fixture();
  try {
    const first = await invoke(a);
    const changedPolicy = await invoke(b, { ...command, policy: { ...command.policy, minimum_quality_state: "degraded" } });
    const changedIncarnation = await invoke(c, { ...command, owner_incarnation_ref: "installation-2" });
    assert.equal(first.ownership.source_owner_generation, changedPolicy.ownership.source_owner_generation);
    assert.notEqual(first.command_sha256, changedPolicy.command_sha256);
    assert.notEqual(first.ownership.source_owner_generation, changedIncarnation.ownership.source_owner_generation);
  } finally { a.db.close(); b.db.close(); c.db.close(); }
});
test("rejects command, identity and policy drift on exact replay", async () => {
  const value = fixture();
  try {
    await invoke(value);
    for (const altered of [{ ...command, owner_incarnation_ref: "other" },
      { ...command, policy: { ...command.policy, disclosure_ceiling: "public" } }]) {
      await assert.rejects(invoke(value, altered), /CONFLICT/u);
    }
    await assert.rejects(invoke(value, command, { identity: { ...identity, principal_ref: "other-owner" } }), /CONFLICT/u);
    assert.equal(value.statements.filter((sql) => sql.startsWith("INSERT")).length, 2);
  } finally { value.db.close(); }
});
test("cannot resurrect a fenced/retired owner or change an existing policy revision", async () => {
  for (const mutation of ["UPDATE source_namespace_ownership SET status='FENCED'", "UPDATE source_namespace_ownership SET status='RETIRED'",
    "UPDATE source_namespace_ownership SET owner_system_id='external'", "UPDATE source_namespace_ownership SET source_admission_policy_revision=2"]) {
    const value = fixture();
    try { await invoke(value); value.db.exec(mutation); await assert.rejects(invoke(value), /CONFLICT/u); }
    finally { value.db.close(); }
  }
});
test("reconciles lost acknowledgement at each write without replaying that mutation", async () => {
  for (const table of ["source_admission_policy", "source_namespace_ownership"]) {
    const value = fixture(); const original = value.query; let attempts = 0;
    value.query = async (sql) => {
      if (sql.startsWith(`INSERT INTO ${table}`)) { ++attempts; await original(sql); throw new Error("secret provider diagnostic"); }
      return original(sql);
    };
    try { assert.equal((await invoke(value)).state, "INITIALIZED_OR_REPLAY"); assert.equal(attempts, 1); }
    finally { value.db.close(); }
  }
});
test("an unconfirmed policy write leaves no owner and no success; later retry resumes exact intent", async () => {
  const value = fixture(); const original = value.query;
  value.query = async (sql) => { if (sql.startsWith("INSERT INTO source_admission_policy")) throw new Error("secret"); return original(sql); };
  try {
    await assert.rejects(invoke(value), /SETTLEMENT_UNCERTAIN/u); assert.equal(count(value, "source_namespace_ownership"), 0);
    value.query = original; assert.equal((await invoke(value)).state, "INITIALIZED_OR_REPLAY");
  } finally { value.db.close(); }
});
test("restart resumes policy-only preparation; a different principal cannot take over the prepared policy", async () => {
  const value = fixture(); const original = value.query;
  value.query = async (sql) => { if (sql.startsWith("INSERT INTO source_namespace_ownership")) throw new Error("interrupted"); return original(sql); };
  try {
    await assert.rejects(invoke(value), /SETTLEMENT_UNCERTAIN/u);
    assert.equal(count(value, "source_admission_policy"), 1); assert.equal(count(value, "source_namespace_ownership"), 0);
    value.query = original;
    await assert.rejects(invoke(value, command, { identity: { ...identity, principal_ref: "other" } }), /CONFLICT/u);
    assert.equal((await invoke(value)).state, "INITIALIZED_OR_REPLAY");
  } finally { value.db.close(); }
});
test("concurrent identical initializations converge without two owners or policies", async () => {
  const value = fixture();
  try { const receipts = await Promise.all([invoke(value), invoke(value)]); assert.deepEqual(receipts[0], receipts[1]);
    assert.equal(count(value, "source_namespace_ownership"), 1); assert.equal(count(value, "source_admission_policy"), 1); }
  finally { value.db.close(); }
});
test("policy substitution between preparation and activation cannot authorize the owner", async () => {
  const value = fixture(); const original = value.query;
  value.query = async (sql) => {
    if (sql.startsWith("INSERT INTO source_namespace_ownership")) value.db.exec("UPDATE source_admission_policy SET authorized_principal_refs_json='[\"attacker\"]'");
    return original(sql);
  };
  try { await assert.rejects(invoke(value), /SETTLEMENT_UNCERTAIN/u); assert.equal(count(value, "source_namespace_ownership"), 0); }
  finally { value.db.close(); }
});
test("last joined readback detects a withdrawal racing the receipt", async () => {
  const value = fixture(); const original = value.query;
  value.query = async (sql) => {
    if (sql.startsWith("SELECT COUNT(*) AS n FROM source_namespace_ownership o")) value.db.exec("UPDATE source_admission_policy SET authorized_principal_refs_json='[\"other\"]'");
    return original(sql);
  };
  try { await assert.rejects(invoke(value), /CONFLICT/u); } finally { value.db.close(); }
});
test("expiry between writes stops activation and never grants implicit source access", async () => {
  const value = fixture(); const original = value.query; let clock = now;
  value.query = async (sql) => { const rows = await original(sql);
    if (sql.startsWith("INSERT INTO source_admission_policy")) clock += 7200000; return rows; };
  try { await assert.rejects(invoke(value, command, { now: () => clock }), /OWNER_REQUIRED/u);
    assert.equal(count(value, "source_namespace_ownership"), 0); }
  finally { value.db.close(); }
});
test("strict local profile rejects unknown fields, takeover modes, unsafe IDs, fabricated high assurance and service identities", async () => {
  for (const fields of [{ expected_ownership_revision: 1 }, { expected_policy_revision: 1 }, { namespace: 42 },
    { namespace: "bad'namespace" }, { owner_system_id: "external" }, { owner_incarnation_ref: null },
    { created_at: "bad" }, { created_at: new Date(now + 1).toISOString() }, { principal_ref: "attacker" }]) {
    assert.throws(() => validateNamespaceCommand({ ...command, ...fields }, now));
  }
  for (const fields of [{ allowed_ownership_modes: ["ownership_cutover"] }, { allowed_use: ["research", "research"] },
    { authorized_principal_refs: ["other"] }, { instruction_taint: "CLEARED" }, { assurance_ceiling: "EXACT" },
    { default_storage_policy: "FULL_CLOUD_COPY" }, { unknown: true }]) {
    assert.throws(() => validateNamespaceCommand({ ...command, policy: { ...command.policy, ...fields } }, now));
  }
  await assert.rejects(initializeLocalNamespace({ command, identity: { ...identity, client_class: "trusted_agent" },
    query: () => assert.fail("must not issue SQL"), now: () => now }), /OWNER_REQUIRED/u);
});

test("a regressing or invalid operator clock cannot activate ownership", async () => {
  for (const observed of [NaN, Infinity, now - 1]) {
    let reads = 0;
    await assert.rejects(initializeLocalNamespace({ command, identity, query: () => assert.fail("no SQL with invalid time"),
      now: () => ++reads === 1 ? now : observed }), /OWNER_REQUIRED/u);
  }
});
