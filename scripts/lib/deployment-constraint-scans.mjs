import { readDeploymentJson } from "./deployment-verification.mjs";

const NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/u;
const object = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const keys = (v, expected) => object(v) && Object.keys(v).length === expected.length &&
  expected.every((key) => Object.hasOwn(v, key));

// This is a bound on the observed rows admitted before apply, not an atomic
// cap on SQLite's CHECK validation work. Concurrent growth remains reviewed risk.
export function validConstraintScanBounds(bounds) {
  return Array.isArray(bounds) && bounds.length <= 64 && bounds.every((entry, index) =>
    keys(entry, ["table_name", "max_rows", "validation_count"]) && NAME.test(entry.table_name) &&
    !entry.table_name.toLowerCase().startsWith("sqlite_") && entry.table_name === entry.table_name.toLowerCase() &&
    (index === 0 || bounds[index - 1].table_name < entry.table_name) &&
    Number.isSafeInteger(entry.max_rows) && entry.max_rows >= 0 && entry.max_rows <= 1000 &&
    Number.isSafeInteger(entry.validation_count) && entry.validation_count >= 1 && entry.validation_count <= 64);
}

export function assertConstraintScanCoverage(derived, bounds) {
  if (!validConstraintScanBounds(bounds) || derived.length !== bounds.length || derived.some((entry, index) =>
    entry.table_name !== bounds[index].table_name || entry.validation_count !== bounds[index].validation_count)) {
    throw new Error("CHECK validation scan bounds do not cover the exact derived tables and validation counts");
  }
}

export function validConstraintScanObservations(observations, bounds, { required = false } = {}) {
  return Array.isArray(observations) && observations.length <= bounds.length &&
    (!required || observations.length === bounds.length) && observations.every((entry, index) => {
      const bound = bounds[index];
      return keys(entry, ["table_name", "max_rows", "validation_count", "observed_rows", "observed_at", "state"]) &&
        entry.table_name === bound.table_name && entry.max_rows === bound.max_rows &&
        entry.validation_count === bound.validation_count && typeof entry.observed_at === "string" &&
        Number.isFinite(Date.parse(entry.observed_at)) && new Date(Date.parse(entry.observed_at)).toISOString() === entry.observed_at &&
        (entry.observed_rows === null || (Number.isSafeInteger(entry.observed_rows) && entry.observed_rows >= 0 &&
          entry.observed_rows <= bound.max_rows + 1)) &&
        ((entry.state === "PASS" && entry.observed_rows !== null && entry.observed_rows <= bound.max_rows) ||
          (entry.state === "EXCEEDED" && entry.observed_rows === bound.max_rows + 1) ||
          (entry.state === "UNAVAILABLE" && entry.observed_rows === null)) && (!required || entry.state === "PASS");
    });
}

export async function readConstraintScanPreconditions(input, intent, headers, {
  fetchImpl = fetch, signal, timeoutMs = 30_000, now = Date.now,
} = {}) {
  const bounds = intent.risk_review.constraint_scan_bounds;
  if (!validConstraintScanBounds(bounds)) throw new Error("Invalid CHECK validation scan bounds");
  const observations = [];
  const cutoff = now() + timeoutMs;
  for (const bound of bounds) {
    const observation = { ...bound, observed_rows: null, observed_at: new Date(now()).toISOString(), state: "UNAVAILABLE" };
    observations.push(observation);
    const remaining = Math.floor(cutoff - now());
    if (remaining < 1 || signal?.aborted) return { state: "UNAVAILABLE", observations };
    const url = `${input.apiBase}/accounts/${encodeURIComponent(intent.account_id)}/d1/database/${encodeURIComponent(intent.database.database_id)}/query`;
    const body = JSON.stringify({ sql: `SELECT COUNT(*) AS n FROM (SELECT 1 FROM "${bound.table_name}" LIMIT ${bound.max_rows + 1})`, params: [] });
    const request = (address, init) => fetchImpl(address, { ...init, method: "POST", body,
      ...(signal === undefined ? {} : { signal: AbortSignal.any([init.signal, signal]) }) });
    try {
      const { data } = await readDeploymentJson(url, headers, { fetchImpl: request, timeoutMs: remaining, maxBytes: 16 * 1024 });
      const result = data?.result?.[0];
      const row = result?.results?.[0];
      if (data?.success !== true || (Array.isArray(data.errors) && data.errors.length > 0) ||
          !Array.isArray(data.result) || data.result.length !== 1 || result?.success !== true ||
          !Array.isArray(result.results) || result.results.length !== 1 || !keys(row, ["n"]) ||
          !Number.isSafeInteger(row.n) || row.n < 0 || row.n > bound.max_rows + 1 ||
          result.meta?.changed_db !== false || result.meta?.rows_written !== 0) return { state: "UNAVAILABLE", observations };
      observation.observed_rows = row.n;
      observation.state = row.n <= bound.max_rows ? "PASS" : "EXCEEDED";
      if (observation.state !== "PASS") return { state: observation.state, observations };
    } catch { return { state: "UNAVAILABLE", observations }; }
  }
  return { state: "PASS", observations };
}
