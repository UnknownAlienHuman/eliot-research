import assert from "node:assert/strict";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { ROOT } from "./lib/local-launch.mjs";
import { applyLocalReadPolicy, sqlLiteral, validatePolicyCommand } from "./lib/local-read-policy.mjs";

const now = Date.now();
const identity = { protocol: "eliotr.owner-session.v1", principal_ref: "owner'identity", client_class: "owner_pwa",
  credential_generation: "verified-token-generation", expires_at: new Date(now + 3600000).toISOString() };
const command = { action: "GRANT", namespace: "ns'quoted", expected_generation: 0,
  allowed_use: ["research"], disclosure: "private", expires_at: new Date(now + 86400000).toISOString() };
function fixture() {
  const db = new DatabaseSync(":memory:"); db.exec("PRAGMA foreign_keys=ON");
  for (const file of readdirSync(resolve(ROOT, "infra/d1/core/migrations")).sort()) {
    if (file.endsWith(".sql")) db.exec(readFileSync(resolve(ROOT, "infra/d1/core/migrations", file), "utf8"));
  }
  db.prepare("INSERT INTO source_namespace_ownership (source_namespace_id,ownership_record_revision,owner_system_id,owner_incarnation_ref,source_owner_generation,source_admission_policy_revision,status,created_at) VALUES (?,1,'eliotr','incarnation','owner-gen',1,'ACTIVE',?)")
    .run(command.namespace, new Date(now).toISOString());
  const sql = [];
  const query = async (statement) => { sql.push(statement); return db.prepare(statement).all().map((row) => ({ ...row })); };
  return { db, sql, query };
}
const invoke = (value, input = command) => applyLocalReadPolicy({ command: input, identity, query: value.query, now: () => now });

test("explicit operator grant persists exact fields and replay does not mutate or broaden access", async () => {
  const value = fixture();
  try {
    const first = await invoke(value); assert.equal(first.policy.generation, 1); assert.equal(first.policy.principal_ref, identity.principal_ref);
    assert.equal(first.policy.allowed_use_json, '["research"]'); assert.equal(first.policy.state, "ACTIVE");
    const mutations = () => value.sql.filter((sql) => /^(INSERT|UPDATE)/u.test(sql)).length;
    assert.equal(mutations(), 1); assert.deepEqual(await invoke(value), first); assert.equal(mutations(), 1);
    await assert.rejects(invoke(value, { ...command, disclosure: "public" }), /CONFLICT/u);
    assert.equal(mutations(), 1);
  } finally { value.db.close(); }
});
test("renewal and revocation use explicit generation CAS; replay cannot revive a revoked policy", async () => {
  const value = fixture();
  try {
    await invoke(value);
    const renewal = { ...command, expected_generation: 1, expires_at: new Date(now + 2 * 86400000).toISOString() };
    const next = await invoke(value, renewal); assert.equal(next.policy.generation, 2);
    const revocation = { action: "REVOKE", namespace: command.namespace, expected_generation: 2 };
    const revoked = await invoke(value, revocation); assert.equal(revoked.policy.state, "REVOKED"); assert.equal(revoked.policy.generation, 3);
    assert.deepEqual(await invoke(value, revocation), revoked);
    await assert.rejects(invoke(value, renewal), /CONFLICT/u); await assert.rejects(invoke(value), /CONFLICT/u);
    assert.equal(value.db.prepare("SELECT state FROM scope_read_policy").get().state, "REVOKED");
  } finally { value.db.close(); }
});
test("lost mutation ACK reconciles by readback without a second write; absent readback is uncertain", async () => {
  for (const applied of [true, false]) {
    const value = fixture(); const original = value.query; let writes = 0;
    value.query = async (sql) => {
      if (/^INSERT INTO scope_read_policy/u.test(sql)) {
        writes += 1; if (applied) await original(sql); throw new Error("secret upstream diagnostic");
      }
      return original(sql);
    };
    try {
      if (applied) assert.equal((await invoke(value)).policy.state, "ACTIVE");
      else await assert.rejects(invoke(value), /SETTLEMENT_UNCERTAIN/u);
      assert.equal(writes, 1);
    } finally { value.db.close(); }
  }
});
test("owner rotation and generation races prevent the stale write", async () => {
  const value = fixture(); const original = value.query;
  value.query = async (sql) => {
    if (/^INSERT INTO scope_read_policy/u.test(sql)) value.db.exec("UPDATE source_namespace_ownership SET status='RETIRED'");
    return original(sql);
  };
  try { await assert.rejects(invoke(value)); assert.equal(value.db.prepare("SELECT COUNT(*) AS n FROM scope_read_policy").get().n, 0); }
  finally { value.db.close(); }
});
test("missing namespaces, service identities and malformed commands fail before mutation", async () => {
  const value = fixture();
  try {
    await assert.rejects(invoke(value, { ...command, namespace: "absent" }));
    await assert.rejects(applyLocalReadPolicy({ command, identity: { ...identity, client_class: "trusted_agent" }, query: () => assert.fail() }));
    for (const fields of [{ expected_generation: -1 }, { expected_generation: 0.5 }, { allowed_use: [] }, { allowed_use: ["research", "research"] },
      { expires_at: "invalid" }, { expires_at: new Date(0).toISOString() }, { namespace: "bad\0" }, { principal_ref: "attacker" }]) {
      assert.throws(() => validatePolicyCommand({ ...command, ...fields }, now));
    }
    assert.equal(value.sql.filter((sql) => /^(INSERT|UPDATE)/u.test(sql)).length, 0);
    assert.equal(sqlLiteral("'; DROP TABLE source;--"), "'''; DROP TABLE source;--'");
    assert.throws(() => sqlLiteral(NaN)); assert.throws(() => sqlLiteral({ malicious: true }));
  } finally { value.db.close(); }
});
