import { createHash } from "node:crypto";
import { readFile, readdir, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { readDeploymentJson } from "./deployment-verification.mjs";

const NAME = /^\d{4}_[A-Za-z0-9_-]+\.sql$/u;
const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/iu;
const DATABASE_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/u;
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const fail = () => { throw new Error("Deployment D1 migration plan or ledger readback mismatch"); };

function migrationDirectory(config, binding, root, { requireName = true } = {}) {
  validateDeploymentMigrationDirectories(config, { root });
  if (binding !== "CORE_DB" && binding !== "SEARCH_DB") fail();
  const stream = binding === "CORE_DB" ? "core" : "search";
  const db = config.d1_databases.find((item) => item.binding === binding);
  if (!UUID.test(db.database_id ?? "") || (requireName && !DATABASE_NAME.test(db.database_name ?? ""))) fail();
  return { db, directory: resolve(root, "infra/d1", stream, "migrations") };
}

async function readMigrationEntries(directory, { maxTotalBytes } = {}) {
  const entries = (await readdir(directory, { withFileTypes: true })).filter((entry) => entry.name.endsWith(".sql"));
  if (entries.length < 1 || entries.length > 2048 || entries.some((entry) => !entry.isFile() || !NAME.test(entry.name))) fail();
  const names = entries.map((entry) => entry.name).sort();
  const bundle = [];
  let totalBytes = 0;
  for (const name of names) {
    const path = resolve(directory, name);
    const fileStat = await stat(path);
    if (!fileStat.isFile() || (maxTotalBytes !== undefined && totalBytes + fileStat.size > maxTotalBytes)) fail();
    const bytes = await readFile(path);
    if (maxTotalBytes !== undefined && (bytes.byteLength > maxTotalBytes || totalBytes + bytes.byteLength > maxTotalBytes)) fail();
    totalBytes += bytes.byteLength;
    if (maxTotalBytes !== undefined && totalBytes > maxTotalBytes) fail();
    bundle.push({ name, sha256: sha256(bytes) });
  }
  return { bundle, totalBytes };
}

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
  for (const binding of ["CORE_DB", "SEARCH_DB"]) {
    const { db, directory } = migrationDirectory(config, binding, root, { requireName: false });
    const { bundle } = await readMigrationEntries(directory);
    streams.push(Object.freeze({ binding, database_id: db.database_id,
      migration_names: Object.freeze(bundle.map((entry) => entry.name)), local_migration_bundle_sha256: sha256(JSON.stringify(bundle)) }));
  }
  return Object.freeze(streams);
}

// The scoped maintenance runner needs exact per-file pins as well as the
// existing aggregate plan. Keep this separate so the deployment plan's public
// shape remains unchanged.
export async function readDeploymentMigrationEntries(config, binding, { root, maxTotalBytes = 4 * 1024 * 1024 } = {}) {
  if (!Number.isSafeInteger(maxTotalBytes) || maxTotalBytes < 1 || maxTotalBytes > 16 * 1024 * 1024) fail();
  const { db, directory } = migrationDirectory(config, binding, root);
  const { bundle: entries, totalBytes } = await readMigrationEntries(directory, { maxTotalBytes });
  return Object.freeze({ binding, database_name: db.database_name, database_id: db.database_id,
    migration_entries: Object.freeze(entries.map((entry) => Object.freeze({ ...entry }))),
    migration_names: Object.freeze(entries.map((entry) => entry.name)),
    local_migration_bundle_sha256: sha256(JSON.stringify(entries)), total_sql_bytes: totalBytes });
}

// This deliberately issues SELECT only against the existing ledger. In
// particular, it never calls `wrangler d1 migrations list`: Wrangler may
// create d1_migrations as a side effect of that command.
export async function inspectDeploymentMigrationLedger(env, input, target, localNames, {
  fetchImpl = fetch, signal, timeoutMs = 30_000,
} = {}) {
  if (!UUID.test(target?.database_id ?? "") || !DATABASE_NAME.test(target?.database_name ?? "") ||
      !["CORE_DB", "SEARCH_DB"].includes(target?.binding) || env?.CLOUDFLARE_ACCOUNT_ID !== input?.accountId ||
      typeof env?.CLOUDFLARE_API_TOKEN !== "string" || env.CLOUDFLARE_API_TOKEN.length < 1 ||
      !Array.isArray(localNames) || localNames.length < 1 || localNames.length > 2048 ||
      localNames.some((name, index) => !NAME.test(name) || (index > 0 && localNames[index - 1] >= name)) ||
      !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000) fail();

  const url = `${input.apiBase}/accounts/${encodeURIComponent(input.accountId)}/d1/database/${encodeURIComponent(target.database_id)}/query`;
  const sql = `SELECT name FROM d1_migrations ORDER BY name LIMIT ${localNames.length + 1}`;
  const body = JSON.stringify({ sql, params: [] });
  const request = (address, init) => fetchImpl(address, { ...init,
    ...(signal === undefined ? {} : { signal: AbortSignal.any([init.signal, signal]) }),
    method: "POST", body });
  const { data } = await readDeploymentJson(url, {
    Authorization: `Bearer ${env.CLOUDFLARE_API_TOKEN}`, "Content-Type": "application/json",
  }, { maxBytes: 256 * 1024, timeoutMs, fetchImpl: request });
  const result = data?.result?.[0];
  if (data?.success !== true || (Array.isArray(data.errors) && data.errors.length > 0) ||
      !Array.isArray(data.result) || data.result.length !== 1 || result?.success !== true ||
      !Array.isArray(result.results) || result.results.length > localNames.length ||
      result.meta?.changed_db !== false || result.meta?.rows_written !== 0) fail();
  const actual = result.results.map((row) => {
    if (row === null || typeof row !== "object" || Array.isArray(row) ||
        Object.keys(row).length !== 1 || typeof row.name !== "string" || !NAME.test(row.name)) fail();
    return row.name;
  });
  if (new Set(actual).size !== actual.length ||
      JSON.stringify(actual) !== JSON.stringify(localNames.slice(0, actual.length))) fail();
  return Object.freeze({ ledger_state: "EXISTING", applied_names: Object.freeze(actual),
    pending_names: Object.freeze(localNames.slice(actual.length)) });
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
