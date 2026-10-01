import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { readDeploymentJson } from "./deployment-verification.mjs";

const NAME = /^\d{4}_[A-Za-z0-9_-]+\.sql$/u;
const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/iu;
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const fail = () => { throw new Error("Deployment D1 migration plan or ledger readback mismatch"); };

// Only the two repository migration streams are deployable. A generated config
// cannot substitute a different directory, ledger table or discovery pattern.
export function validateDeploymentMigrationDirectories(config, { root } = {}) {
  if (typeof root !== "string" || !Array.isArray(config?.d1_databases) || config.d1_databases.length !== 2) fail();
  for (const [binding, stream] of [["CORE_DB", "core"], ["SEARCH_DB", "search"]]) {
    const matches = config.d1_databases.filter((db) => db?.binding === binding);
    if (matches.length !== 1) fail();
    const db = matches[0];
    const directory = resolve(root, "infra/d1", stream, "migrations");
    // Wrangler otherwise discovers its default migrations/ directory beside
    // the generated config, which is not the byte bundle attested below.
    if (typeof db.migrations_dir !== "string" || db.migrations_dir.trim() === "" ||
        resolve(root, "apps/eliotr-core", db.migrations_dir) !== directory) fail();
    if ((db.migrations_table !== undefined && db.migrations_table !== "d1_migrations") ||
        db.migrations_pattern !== undefined) fail();
  }
}

export async function readDeploymentMigrationPlan(config, { root } = {}) {
  validateDeploymentMigrationDirectories(config, { root });
  const streams = [];
  for (const [binding, stream] of [["CORE_DB", "core"], ["SEARCH_DB", "search"]]) {
    const db = config.d1_databases.find((item) => item.binding === binding);
    if (!UUID.test(db.database_id ?? "")) fail();
    const directory = resolve(root, "infra/d1", stream, "migrations");
    const entries = (await readdir(directory, { withFileTypes: true })).filter((entry) => entry.name.endsWith(".sql"));
    if (entries.length < 1 || entries.length > 2048 || entries.some((entry) => !entry.isFile() || !NAME.test(entry.name))) fail();
    const names = entries.map((entry) => entry.name).sort();
    const bundle = [];
    for (const name of names) bundle.push({ name, sha256: sha256(await readFile(resolve(directory, name))) });
    streams.push(Object.freeze({ binding, database_id: db.database_id,
      migration_names: Object.freeze(names), local_migration_bundle_sha256: sha256(JSON.stringify(bundle)) }));
  }
  return Object.freeze(streams);
}

export async function requireUnchangedMigrationPlan(config, plan, options) {
  if (JSON.stringify(await readDeploymentMigrationPlan(config, options)) !== JSON.stringify(plan)) fail();
}

// D1's ledger records applied names, not SQL checksums. The local bundle digest
// is build evidence only; it is deliberately not presented as remote byte proof.
export async function verifyDeploymentMigrationLedgers(env, input, plan, { fetchImpl = fetch } = {}) {
  if (!Array.isArray(plan) || plan.length !== 2 || plan[0]?.binding !== "CORE_DB" || plan[1]?.binding !== "SEARCH_DB") fail();
  const streams = [];
  for (const expected of plan) {
    const names = expected.migration_names;
    if (!Array.isArray(names) || names.length < 1 || names.length > 2048 ||
        new Set(names).size !== names.length || names.some((name) => !NAME.test(name)) ||
        !UUID.test(expected.database_id ?? "")) fail();
    const url = `${input.apiBase}/accounts/${encodeURIComponent(env.CLOUDFLARE_ACCOUNT_ID)}/d1/database/${encodeURIComponent(expected.database_id)}/query`;
    const body = JSON.stringify({ sql: `SELECT name FROM d1_migrations ORDER BY name LIMIT ${names.length + 1}`, params: [] });
    const { data } = await readDeploymentJson(url, {
      Authorization: `Bearer ${env.CLOUDFLARE_API_TOKEN}`, "Content-Type": "application/json",
    }, { maxBytes: 256 * 1024, fetchImpl: (target, init) => fetchImpl(target, { ...init, method: "POST", body }) });
    const result = data?.result?.[0];
    if (data?.success !== true || (Array.isArray(data.errors) && data.errors.length > 0) ||
        !Array.isArray(data.result) || data.result.length !== 1 || result?.success !== true ||
        !Array.isArray(result.results) || result.results.length !== names.length ||
        result.meta?.changed_db === true || (result.meta?.rows_written ?? 0) !== 0) fail();
    const actual = result.results.map((row) => {
      if (row === null || typeof row !== "object" || Array.isArray(row) ||
          Object.keys(row).length !== 1 || typeof row.name !== "string") fail();
      return row.name;
    });
    if (JSON.stringify(actual) !== JSON.stringify(names)) fail();
    streams.push({ ...expected, migration_names: [...actual] });
  }
  return { state: "PASS", streams };
}
