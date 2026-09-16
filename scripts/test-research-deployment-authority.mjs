import assert from "node:assert/strict";
import {
  ResearchDeploymentAuthorityError,
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
        const row = rows.get(params[0]);
        if (row?.state === "ACTIVE") { row.state = "RETIRED"; changes = 1; }
      } else if (sql.startsWith("INSERT INTO investigation_current_deployment")) {
        const [generation, created_at, backend_fingerprint] = params;
        const row = rows.get(generation);
        if (row === undefined) {
          rows.set(generation, { deployment_generation: generation, state: "ACTIVE", created_at, backend_fingerprint });
          changes = 1;
        } else if (row.state === "RETIRED" && row.backend_fingerprint === backend_fingerprint) {
          row.state = "ACTIVE";
          row.created_at = created_at;
          changes = 1;
        }
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
  return { rows, fetch_impl };
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
console.log("research deployment authority tests passed");
