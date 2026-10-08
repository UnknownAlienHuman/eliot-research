import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import {
  ResearchDeploymentAuthorityError,
  readResearchDeploymentAuthority,
  synchronizeResearchDeploymentAuthority,
} from "./lib/research-deployment-authority.mjs";

const F = "a".repeat(64);
const G = "b".repeat(64);

function response(result) {
  return new Response(JSON.stringify({ success: true, result }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function fakeD1(initial = []) {
  const rows = new Map(initial.map((row) => [row.deployment_generation, { ...row }]));
  let writes = 0;
  let lastChanges = 0;
  const fetch_impl = async (_url, init) => {
    const value = JSON.parse(init.body);
    const result = [];
    for (const statement of value.batch) {
      const { sql, params } = statement;
      let changes = 0;
      let results = [];
      if (sql.startsWith("SELECT deployment_generation,state,created_at,backend_fingerprint") && params.length === 0) {
        results = [...rows.values()].filter((row) => row.state === "ACTIVE").sort((a, b) => a.deployment_generation.localeCompare(b.deployment_generation)).slice(0, 2);
      } else if (sql.startsWith("UPDATE investigation_current_deployment SET state='RETIRED'")) {
        writes += 1;
        const [generation, fingerprint, candidateGeneration, candidateFingerprint] = params;
        const row = rows.get(generation);
        const candidate = candidateGeneration === undefined ? null : rows.get(candidateGeneration);
        const candidateMatches = !sql.includes("AND EXISTS") ||
          (candidate?.state === "RETIRED" && candidate.backend_fingerprint === candidateFingerprint);
        if (candidateMatches && row?.state === "ACTIVE" && row.backend_fingerprint === fingerprint) {
          row.state = "RETIRED";
          changes = 1;
        }
        lastChanges = changes;
      } else if (sql.startsWith("UPDATE investigation_current_deployment SET state='ACTIVE'")) {
        writes += 1;
        const [generation, created_at, backend_fingerprint] = params;
        const row = rows.get(generation);
        if ((!sql.includes("AND changes()=1") || lastChanges === 1) &&
            row?.state === "RETIRED" && row.backend_fingerprint === backend_fingerprint) {
          row.state = "ACTIVE";
          row.created_at = created_at;
          changes = 1;
        }
        lastChanges = changes;
      } else if (sql.startsWith("INSERT INTO investigation_current_deployment")) {
        writes += 1;
        const [generation, created_at, backend_fingerprint] = params;
        if (sql.includes("WHERE changes()=1") && lastChanges !== 1) {
          changes = 0;
        } else if (rows.has(generation)) {
          throw new Error("candidate primary-key conflict");
        } else {
          rows.set(generation, { deployment_generation: generation, state: "ACTIVE", created_at, backend_fingerprint });
          changes = 1;
        }
        lastChanges = changes;
      } else if (sql.startsWith("SELECT deployment_generation,state,created_at,backend_fingerprint")) {
        const selected = new Set(params);
        results = [...rows.values()].filter((row) => row.state === "ACTIVE" || selected.has(row.deployment_generation));
      } else {
        throw new Error(`unexpected SQL: ${sql}`);
      }
      result.push({ success: true, results, meta: { changes } });
    }
    return response(result);
  };
  return { rows, fetch_impl, writes: () => writes };
}

function sqliteD1(initial = [], beforeRotation = null) {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE investigation_current_deployment (
      deployment_generation TEXT PRIMARY KEY CHECK(length(deployment_generation) BETWEEN 1 AND 256),
      state TEXT NOT NULL DEFAULT 'ACTIVE' CHECK(state IN ('ACTIVE','RETIRED')),
      created_at TEXT NOT NULL,
      backend_fingerprint TEXT CHECK(backend_fingerprint IS NULL OR
        (length(backend_fingerprint)=64 AND backend_fingerprint NOT GLOB '*[^0-9a-f]*'))
    ) STRICT;
    CREATE UNIQUE INDEX investigation_current_deployment_single_active
      ON investigation_current_deployment(state) WHERE state='ACTIVE';
    CREATE TABLE investigation_ledger_epoch (
      singleton INTEGER PRIMARY KEY CHECK(singleton=1),
      generation INTEGER NOT NULL CHECK(generation>0)
    ) STRICT;
    INSERT INTO investigation_ledger_epoch(singleton,generation) VALUES (1,1);
    CREATE TRIGGER ledger_epoch_cur_deploy_update AFTER UPDATE ON investigation_current_deployment
      BEGIN UPDATE investigation_ledger_epoch SET generation=generation+1 WHERE singleton=1; END;
    CREATE TRIGGER ledger_epoch_cur_deploy_insert AFTER INSERT ON investigation_current_deployment
      BEGIN UPDATE investigation_ledger_epoch SET generation=generation+1 WHERE singleton=1; END;
  `);
  const insert = db.prepare("INSERT INTO investigation_current_deployment (deployment_generation,state,created_at,backend_fingerprint) VALUES (?1,?2,?3,?4)");
  for (const row of initial) {
    insert.run(row.deployment_generation, row.state, row.created_at, row.backend_fingerprint);
  }
  let beforeRotationPending = beforeRotation;
  let lastReportedMetaChanges = [];
  const fetch_impl = async (_url, init) => {
    const { batch } = JSON.parse(init.body);
    if (batch.length === 3 && beforeRotationPending !== null) {
      const callback = beforeRotationPending;
      beforeRotationPending = null;
      callback(db);
    }
    const transactional = batch.length > 1;
    if (transactional) db.exec("BEGIN IMMEDIATE");
    try {
      const result = [];
      lastReportedMetaChanges = [];
      for (const { sql, params } of batch) {
        let rows = [];
        let changes = 0;
        let reportedChanges = 0;
        if (sql.trimStart().startsWith("SELECT")) {
          rows = db.prepare(sql).all(...params);
        } else {
          const epochBefore = db.prepare("SELECT generation FROM investigation_ledger_epoch WHERE singleton=1").get().generation;
          changes = Number(db.prepare(sql).run(...params).changes);
          const epochAfter = db.prepare("SELECT generation FROM investigation_ledger_epoch WHERE singleton=1").get().generation;
          // D1 reports the table update and its epoch-trigger update in meta.changes.
          // SQLite changes() in the following SQL statement must still gate on the direct row count.
          reportedChanges = changes + (epochAfter - epochBefore);
        }
        result.push({ success: true, results: rows, meta: { changes: reportedChanges } });
        lastReportedMetaChanges.push(reportedChanges);
      }
      if (transactional) db.exec("COMMIT");
      return response(result);
    } catch {
      if (transactional) db.exec("ROLLBACK");
      return new Response(JSON.stringify({ success: false, result: [] }), {
        status: 400, headers: { "content-type": "application/json" },
      });
    }
  };
  const rows = () => db.prepare("SELECT deployment_generation,state,created_at,backend_fingerprint FROM investigation_current_deployment ORDER BY deployment_generation").all();
  const epoch = () => db.prepare("SELECT generation FROM investigation_ledger_epoch WHERE singleton=1").get().generation;
  return { db, fetch_impl, rows, epoch, metaChanges: () => lastReportedMetaChanges };
}

function input(fetch_impl, deployment_generation, backend_fingerprint = F) {
  return {
    account_id: "account-1",
    database_id: "database-1",
    api_token: "token",
    api_base_url: "http://127.0.0.1/client/v4",
    deployment_generation,
    backend_fingerprint,
    fetch_impl,
    now: () => Date.parse("2026-09-16T00:00:00.000Z"),
  };
}

const d1 = fakeD1();
assert.equal((await synchronizeResearchDeploymentAuthority(input(d1.fetch_impl, "deploy-a"))).state, "INITIALIZED");
assert.equal((await synchronizeResearchDeploymentAuthority(input(d1.fetch_impl, "deploy-a"))).state, "ALREADY_ACTIVE");
assert.equal((await synchronizeResearchDeploymentAuthority(input(d1.fetch_impl, "deploy-b"))).state, "ROTATED");
assert.deepEqual([...d1.rows.values()].map((row) => [row.deployment_generation, row.state, row.backend_fingerprint]).sort(), [
  ["deploy-a", "RETIRED", F], ["deploy-b", "ACTIVE", F],
]);
assert.equal((await synchronizeResearchDeploymentAuthority(input(d1.fetch_impl, "deploy-a"))).state, "ROTATED");
assert.deepEqual([...d1.rows.values()].map((row) => [row.deployment_generation, row.state]).sort(), [
  ["deploy-a", "ACTIVE"], ["deploy-b", "RETIRED"],
]);
await assert.rejects(
  synchronizeResearchDeploymentAuthority(input(d1.fetch_impl, "deploy-a", G)),
  (error) => error instanceof ResearchDeploymentAuthorityError && error.code === "RESEARCH_DEPLOYMENT_AUTHORITY_READBACK_INVALID",
);
const legacy = fakeD1([{ deployment_generation: "legacy", state: "RETIRED", created_at: "2026-09-01T00:00:00.000Z", backend_fingerprint: null }]);
await assert.rejects(
  synchronizeResearchDeploymentAuthority(input(legacy.fetch_impl, "legacy")),
  (error) => error instanceof ResearchDeploymentAuthorityError && error.code === "RESEARCH_DEPLOYMENT_AUTHORITY_READBACK_INVALID",
);

const guarded = fakeD1([
  { deployment_generation: "active", state: "ACTIVE", created_at: "2026-09-01T00:00:00.000Z", backend_fingerprint: F },
  { deployment_generation: "incompatible", state: "RETIRED", created_at: "2026-09-02T00:00:00.000Z", backend_fingerprint: G },
]);
await assert.rejects(
  synchronizeResearchDeploymentAuthority(input(guarded.fetch_impl, "incompatible", F)),
  (error) => error instanceof ResearchDeploymentAuthorityError && error.code === "RESEARCH_DEPLOYMENT_AUTHORITY_READBACK_INVALID",
);
assert.equal(guarded.rows.get("active")?.state, "ACTIVE", "an incompatible target must not retire the current deployment");

const preflight = fakeD1([
  { deployment_generation: "old", state: "ACTIVE", created_at: "2026-09-01T00:00:00.000Z", backend_fingerprint: F },
]);
const observed = await readResearchDeploymentAuthority(input(preflight.fetch_impl, "candidate", G));
assert.equal(observed.active?.deployment_generation, "old");
assert.equal(observed.target, null);
assert.equal(preflight.writes(), 0, "read-only deployment preflight must not mutate D1");
const reused = fakeD1([
  { deployment_generation: "candidate", state: "RETIRED", created_at: "2026-09-02T00:00:00.000Z", backend_fingerprint: F },
]);
await assert.rejects(
  readResearchDeploymentAuthority(input(reused.fetch_impl, "candidate", G)),
  (error) => error instanceof ResearchDeploymentAuthorityError && error.code === "RESEARCH_DEPLOYMENT_AUTHORITY_GENERATION_CONFLICT",
);
assert.equal(reused.rows.get("candidate")?.state, "RETIRED", "generation conflict is rejected by readback only");
assert.equal(reused.writes(), 0, "fingerprint conflict must be discovered before any authority mutation");

let fingerprintRaceEpoch;
const fingerprintRace = sqliteD1([
  { deployment_generation: "old", state: "ACTIVE", created_at: "2026-09-01T00:00:00.000Z", backend_fingerprint: F },
], (db) => {
  db.prepare("UPDATE investigation_current_deployment SET backend_fingerprint=?1 WHERE deployment_generation=?2").run(G, "old");
  fingerprintRaceEpoch = db.prepare("SELECT generation FROM investigation_ledger_epoch WHERE singleton=1").get().generation;
});
await assert.rejects(
  synchronizeResearchDeploymentAuthority(input(fingerprintRace.fetch_impl, "candidate", F)),
  (error) => error instanceof ResearchDeploymentAuthorityError && error.code === "RESEARCH_DEPLOYMENT_AUTHORITY_SYNC_FAILED",
);
assert.deepEqual(fingerprintRace.rows().map(({ deployment_generation, state, backend_fingerprint }) =>
  [deployment_generation, state, backend_fingerprint]), [["old", "ACTIVE", G]]);
assert.equal(fingerprintRace.epoch(), fingerprintRaceEpoch, "a stale predecessor fingerprint must not mutate authority");

let reactivationRaceEpoch;
const reactivationRace = sqliteD1([
  { deployment_generation: "old", state: "ACTIVE", created_at: "2026-09-01T00:00:00.000Z", backend_fingerprint: F },
  { deployment_generation: "candidate", state: "RETIRED", created_at: "2026-09-02T00:00:00.000Z", backend_fingerprint: F },
], (db) => {
  db.prepare("UPDATE investigation_current_deployment SET backend_fingerprint=?1 WHERE deployment_generation=?2").run(G, "candidate");
  reactivationRaceEpoch = db.prepare("SELECT generation FROM investigation_ledger_epoch WHERE singleton=1").get().generation;
});
await assert.rejects(
  synchronizeResearchDeploymentAuthority(input(reactivationRace.fetch_impl, "candidate", F)),
  (error) => error instanceof ResearchDeploymentAuthorityError && error.code === "RESEARCH_DEPLOYMENT_AUTHORITY_SYNC_FAILED",
);
assert.deepEqual(reactivationRace.rows().map(({ deployment_generation, state, backend_fingerprint }) =>
  [deployment_generation, state, backend_fingerprint]), [
  ["candidate", "RETIRED", G], ["old", "ACTIVE", F],
]);
assert.equal(reactivationRace.epoch(), reactivationRaceEpoch,
  "a changed reactivation target must not retire the active predecessor");

let stateRaceEpoch;
const stateRace = sqliteD1([
  { deployment_generation: "old", state: "ACTIVE", created_at: "2026-09-01T00:00:00.000Z", backend_fingerprint: F },
], (db) => {
  db.prepare("UPDATE investigation_current_deployment SET state='RETIRED' WHERE deployment_generation='old'").run();
  db.prepare("INSERT INTO investigation_current_deployment (deployment_generation,state,created_at,backend_fingerprint) VALUES ('other','ACTIVE','2026-09-03T00:00:00.000Z',?1)").run(G);
  stateRaceEpoch = db.prepare("SELECT generation FROM investigation_ledger_epoch WHERE singleton=1").get().generation;
});
await assert.rejects(
  synchronizeResearchDeploymentAuthority(input(stateRace.fetch_impl, "candidate", F)),
  (error) => error instanceof ResearchDeploymentAuthorityError && error.code === "RESEARCH_DEPLOYMENT_AUTHORITY_SYNC_FAILED",
);
assert.deepEqual(stateRace.rows().map(({ deployment_generation, state }) => [deployment_generation, state]), [
  ["old", "RETIRED"], ["other", "ACTIVE"],
]);
assert.equal(stateRace.epoch(), stateRaceEpoch, "a lost active-state CAS must not activate the candidate");

let candidateConflictEpoch;
const candidateConflict = sqliteD1([
  { deployment_generation: "old", state: "ACTIVE", created_at: "2026-09-01T00:00:00.000Z", backend_fingerprint: F },
], (db) => {
  db.prepare("INSERT INTO investigation_current_deployment (deployment_generation,state,created_at,backend_fingerprint) VALUES ('candidate','RETIRED','2026-09-02T00:00:00.000Z',?1)").run(G);
  candidateConflictEpoch = db.prepare("SELECT generation FROM investigation_ledger_epoch WHERE singleton=1").get().generation;
});
await assert.rejects(
  synchronizeResearchDeploymentAuthority(input(candidateConflict.fetch_impl, "candidate", F)),
  (error) => error instanceof ResearchDeploymentAuthorityError && error.code === "RESEARCH_DEPLOYMENT_AUTHORITY_SYNC_FAILED",
);
assert.deepEqual(candidateConflict.rows().map(({ deployment_generation, state, backend_fingerprint }) =>
  [deployment_generation, state, backend_fingerprint]), [
  ["candidate", "RETIRED", G], ["old", "ACTIVE", F],
]);
assert.equal(candidateConflict.epoch(), candidateConflictEpoch,
  "candidate-key conflict must roll back predecessor retirement and its trigger update");

const sqliteSuccess = sqliteD1([
  { deployment_generation: "old", state: "ACTIVE", created_at: "2026-09-01T00:00:00.000Z", backend_fingerprint: F },
]);
assert.equal((await synchronizeResearchDeploymentAuthority(input(sqliteSuccess.fetch_impl, "candidate", F))).state, "ROTATED");
assert.deepEqual(sqliteSuccess.metaChanges(), [2, 2, 0],
  "the guard uses SQLite direct changes()=1 while D1 statement metadata includes the trigger update");
assert.deepEqual(sqliteSuccess.rows().map(({ deployment_generation, state }) => [deployment_generation, state]), [
  ["candidate", "ACTIVE"], ["old", "RETIRED"],
]);
console.log("research deployment authority tests passed");
