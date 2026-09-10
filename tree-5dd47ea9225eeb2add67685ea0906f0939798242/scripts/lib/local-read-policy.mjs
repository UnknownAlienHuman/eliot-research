import { createHash } from "node:crypto";
import { executeLocal, wranglerArgs } from "./local-launch.mjs";

const COLUMNS = ["source_namespace_id", "principal_ref", "client_class", "policy_ref", "generation", "allowed_use_json",
  "disclosure_ceiling", "state", "expires_at", "created_at"];
const id = (value) => typeof value === "string" && value.length > 0 && value === value.trim() &&
  Buffer.byteLength(value) <= 512 && !/[\u0000-\u001f\u007f]/u.test(value);
// Wrangler's CLI has no SQL parameter-binding option. Quote values, never identifiers or arbitrary expressions.
export const sqlLiteral = (value) => {
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return String(value);
  if (!id(value) && !(typeof value === "string" && value.startsWith("[") && value.length < 4096 && !value.includes("\0"))) {
    throw new Error("Invalid local policy SQL value");
  }
  return `'${value.replaceAll("'", "''")}'`;
};
export function localPolicyQuery(paths) {
  return async (sql) => {
    const text = executeLocal(wranglerArgs(paths, ["d1", "execute", "CORE_DB", "--command", sql, "--json"]), { capture: true });
    const batches = JSON.parse(text);
    if (!Array.isArray(batches) || batches.length !== 1 || batches[0]?.success !== true ||
        !Array.isArray(batches[0].results) || batches[0].results.length > 1) throw new Error("Local policy D1 readback is invalid");
    return batches[0].results;
  };
}
export function validatePolicyCommand(command, now = Date.now()) {
  if (!command || typeof command !== "object" || !["GRANT", "REVOKE"].includes(command.action)) throw new Error("Invalid local read-policy action");
  const keys = command.action === "GRANT" ? ["action", "namespace", "expected_generation", "allowed_use", "disclosure", "expires_at"] :
    ["action", "namespace", "expected_generation"];
  if (Object.keys(command).sort().join(",") !== keys.sort().join(",") || !id(command.namespace) ||
      !Number.isSafeInteger(command.expected_generation) || command.expected_generation < 0 || command.expected_generation >= 2147483647) {
    throw new Error("Policy requires one namespace and an explicit nonnegative expected generation");
  }
  if (command.action === "GRANT") {
    if (!Array.isArray(command.allowed_use) || !command.allowed_use.includes("research") || command.allowed_use.length > 16 ||
        command.allowed_use.some((use) => !id(use)) || Buffer.byteLength(JSON.stringify(command.allowed_use)) > 4096 || new Set(command.allowed_use).size !== command.allowed_use.length ||
        !id(command.disclosure) || typeof command.expires_at !== "string" ||
        !Number.isFinite(Date.parse(command.expires_at)) || new Date(command.expires_at).toISOString() !== command.expires_at ||
        Date.parse(command.expires_at) <= now || Date.parse(command.expires_at) > now + 7 * 86400000) {
      throw new Error("Grant requires explicit uses including research, disclosure and canonical UTC expiry within seven days");
    }
  } else if (command.expected_generation === 0) throw new Error("Revocation requires the current positive generation");
  return { ...command, ...(command.action === "GRANT" ? { allowed_use: [...command.allowed_use].sort() } : {}) };
}

/** Local OS operator authority only: never exported as a browser API or a remote provisioning action. */
export async function applyLocalReadPolicy({ command, identity, query, now = Date.now } = {}) {
  const input = validatePolicyCommand(command, now());
  if (identity?.protocol !== "eliotr.owner-session.v1" || identity.client_class !== "owner_pwa" || !id(identity.principal_ref) ||
      !id(identity.credential_generation) || Date.parse(identity.expires_at) <= now() || !Number.isFinite(Date.parse(identity.expires_at))) {
    throw new Error("An unexpired Worker-verified owner identity is required");
  }
  const namespace = sqlLiteral(input.namespace), principal = sqlLiteral(identity.principal_ref);
  const where = `source_namespace_id=${namespace} AND principal_ref=${principal} AND client_class='owner_pwa'`;
  const read = async () => {
    const rows = await query(`SELECT ${COLUMNS.map((key) => key === "allowed_use_json" ?
      "CASE WHEN length(CAST(allowed_use_json AS BLOB))<=4096 THEN allowed_use_json ELSE NULL END AS allowed_use_json" : key).join(",")} ` +
      `FROM scope_read_policy WHERE ${where} LIMIT 1`);
    const row = rows[0] ?? null;
    if (row && (rows.length !== 1 || COLUMNS.some((key) => key === "generation" ? !Number.isSafeInteger(row[key]) || row[key] < 1 : key === "allowed_use_json" ? typeof row[key] !== "string" || Buffer.byteLength(row[key]) > 4096 : !id(row[key])) ||
        !["ACTIVE", "REVOKED"].includes(row.state) || !Number.isFinite(Date.parse(row.created_at)) || !Number.isFinite(Date.parse(row.expires_at)))) throw new Error("Stored read policy is corrupt");
    return row;
  };
  const previous = await read();
  if (input.action === "REVOKE" && !previous) throw new Error("Read policy does not exist");
  const material = { source_namespace_id: input.namespace, principal_ref: identity.principal_ref, client_class: "owner_pwa",
    generation: input.expected_generation + 1,
    allowed_use_json: input.action === "GRANT" ? JSON.stringify(input.allowed_use) : previous.allowed_use_json,
    disclosure_ceiling: input.action === "GRANT" ? input.disclosure : previous.disclosure_ceiling,
    state: input.action === "GRANT" ? "ACTIVE" : "REVOKED",
    expires_at: input.action === "GRANT" ? input.expires_at : previous.expires_at };
  const policyRef = `local-read-${createHash("sha256").update(JSON.stringify(material)).digest("hex")}`;
  const target = { ...material, policy_ref: policyRef, created_at: previous?.created_at ?? new Date(now()).toISOString() };
  const exact = (row) => row !== null && COLUMNS.every((key) => row[key] === target[key]);
  if (exact(previous)) return { protocol: "eliotr.local-read-policy.v1", state: "APPLIED_OR_REPLAY", policy: previous };
  if ((previous?.generation ?? 0) !== input.expected_generation) throw new Error("LOCAL_POLICY_CONFLICT: inspect the current generation before changing access");
  // Grant only within an existing active namespace, fenced to the ownership row seen by the operator.
  let ownership;
  if (input.action === "GRANT") {
    const rows = await query(`SELECT ownership_record_revision,source_owner_generation FROM source_namespace_ownership ` +
      `WHERE source_namespace_id=${namespace} AND status='ACTIVE' LIMIT 1`);
    ownership = rows[0];
    if (!ownership || !Number.isSafeInteger(ownership.ownership_record_revision) || !id(ownership.source_owner_generation)) {
      throw new Error("Cannot grant read access to a missing or inactive namespace");
    }
  }
  const ownerGuard = ownership ? `EXISTS (SELECT 1 FROM source_namespace_ownership WHERE source_namespace_id=${namespace} ` +
    `AND status='ACTIVE' AND ownership_record_revision=${sqlLiteral(ownership.ownership_record_revision)} ` +
    `AND source_owner_generation=${sqlLiteral(ownership.source_owner_generation)})` : "1=1";
  const sql = !previous ? `INSERT INTO scope_read_policy (${COLUMNS.join(",")}) SELECT ${COLUMNS.map((key) => sqlLiteral(target[key])).join(",")} ` +
    `WHERE ${ownerGuard} ON CONFLICT DO NOTHING` :
    `UPDATE scope_read_policy SET ${COLUMNS.filter((key) => key !== "created_at").map((key) => `${key}=${sqlLiteral(target[key])}`).join(",")} ` +
    `WHERE ${where} AND ${COLUMNS.map((key) => `${key}=${sqlLiteral(previous[key])}`).join(" AND ")} AND ${ownerGuard}`;
  // Exactly one mutation. Even a lost ACK must reconcile through exact durable state, not a retry.
  try { await query(sql); } catch { /* Do not reflect SQL or credential-bearing subprocess errors. */ }
  let committed;
  try { committed = await read(); } catch { throw new Error("LOCAL_POLICY_SETTLEMENT_UNCERTAIN: do not blindly retry with a new generation"); }
  if (!exact(committed)) throw new Error("LOCAL_POLICY_SETTLEMENT_UNCERTAIN: requested policy did not read back exactly");
  return { protocol: "eliotr.local-read-policy.v1", state: "APPLIED_OR_REPLAY", policy: committed };
}
