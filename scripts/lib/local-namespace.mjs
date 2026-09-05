import { sqlLiteral } from "./local-sql.mjs";

const PROTOCOL = "eliotr.local-namespace-init.v1";
const ID = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/u;
const OWNER_COLUMNS = ["source_namespace_id", "ownership_record_revision", "owner_system_id", "owner_incarnation_ref",
  "source_owner_generation", "source_admission_policy_revision", "status", "cutover_receipt_ref", "created_at"];
const POLICY_COLUMNS = ["source_namespace_id", "revision", "authorized_principal_refs_json", "allowed_ownership_modes_json",
  "source_class", "assurance_ceiling", "instruction_taint", "allowed_effects", "allowed_use_json", "disclosure_ceiling",
  "license_policy_ref", "default_storage_policy", "default_residency_profile_id", "default_retention_policy_id",
  "minimum_quality_state", "created_at"];
const POLICY_KEYS = ["allowed_ownership_modes", "source_class", "assurance_ceiling", "instruction_taint", "allowed_effects",
  "allowed_use", "disclosure_ceiling", "license_policy_ref", "default_storage_policy", "default_residency_profile_id",
  "default_retention_policy_id", "minimum_quality_state"];
const fail = (code) => { throw new Error(code); };
const exactKeys = (object, keys) => {
  if (!object || typeof object !== "object" || Object.getPrototypeOf(object) !== Object.prototype ||
      Object.keys(object).length !== keys.length || keys.some((key) => !Object.hasOwn(object, key))) fail("LOCAL_NAMESPACE_INPUT_INVALID");
};
const canonicalTime = (value) => typeof value === "string" && Number.isSafeInteger(Date.parse(value)) &&
  new Date(value).toISOString() === value;
const digest = async (value) => {
  const bytes = new globalThis.TextEncoder().encode(JSON.stringify(value));
  const hashed = new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", bytes));
  return Array.from(hashed, (byte) => byte.toString(16).padStart(2, "0")).join("");
};
const equalRow = (row, target, keys) => row !== null && keys.every((key) => row[key] === target[key]);
const literal = (value) => value === null ? "NULL" : sqlLiteral(value);

/** Narrow initial-import profile. It cannot activate, fence, transfer or recreate an existing owner. */
export function validateNamespaceCommand(command, now = Date.now()) {
  exactKeys(command, ["protocol", "namespace", "owner_incarnation_ref", "expected_ownership_revision",
    "expected_policy_revision", "created_at", "policy"]);
  if (command.protocol !== PROTOCOL || typeof command.namespace !== "string" || !ID.test(command.namespace) ||
      typeof command.owner_incarnation_ref !== "string" || !ID.test(command.owner_incarnation_ref) ||
      command.expected_ownership_revision !== 0 || command.expected_policy_revision !== 0 || !Number.isSafeInteger(now) ||
      !canonicalTime(command.created_at) || Date.parse(command.created_at) > now || Date.parse(command.created_at) < now - 7 * 86400000) {
    fail("LOCAL_NAMESPACE_INPUT_INVALID");
  }
  exactKeys(command.policy, POLICY_KEYS);
  const policy = command.policy;
  for (const key of POLICY_KEYS.filter((key) => !["allowed_use", "allowed_ownership_modes"].includes(key))) {
    if (typeof policy[key] !== "string" || !ID.test(policy[key])) fail("LOCAL_NAMESPACE_INPUT_INVALID");
  }
  // This command creates a NEW ERC-owned import namespace, not a federated origin or an ownership cutover.
  if (!Array.isArray(policy.allowed_ownership_modes) || policy.allowed_ownership_modes.length !== 1 ||
      policy.allowed_ownership_modes[0] !== "immutable_import" || !Array.isArray(policy.allowed_use) ||
      policy.allowed_use.length < 1 || policy.allowed_use.length > 16 ||
      policy.allowed_use.some((use) => typeof use !== "string" || !ID.test(use)) ||
      new Set(policy.allowed_use).size !== policy.allowed_use.length ||
      !["LOCATOR_ONLY", "CAPTURED", "QUALIFIED"].includes(policy.assurance_ceiling) ||
      !["DATA_ONLY", "UNTRUSTED", "COMMAND_LIKE"].includes(policy.instruction_taint) ||
      !["READ_ONLY", "CANDIDATE_ONLY", "NO_EXTERNAL_EFFECT"].includes(policy.allowed_effects) ||
      policy.default_storage_policy !== "NORMALIZED_CLOUD_ONLY" ||
      !["high_fidelity", "standard", "degraded"].includes(policy.minimum_quality_state)) fail("LOCAL_NAMESPACE_PROFILE_UNSUPPORTED");
  const normalized = { ...command, policy: { ...policy, allowed_ownership_modes: ["immutable_import"], allowed_use: [...policy.allowed_use].sort() } };
  if (new globalThis.TextEncoder().encode(JSON.stringify(normalized)).byteLength > 8192) fail("LOCAL_NAMESPACE_INPUT_TOO_LARGE");
  return normalized;
}

async function targetRows(input, principal) {
  // Domain-separated opaque initial token binds exactly the ownership axes, not the admission-policy axis.
  const ownerGeneration = `owner-${await digest(["eliotr.source-owner.initial.v1", input.namespace, "eliotr",
    input.owner_incarnation_ref, 1, "ACTIVE"])}`;
  const owner = { source_namespace_id: input.namespace, ownership_record_revision: 1, owner_system_id: "eliotr",
    owner_incarnation_ref: input.owner_incarnation_ref, source_owner_generation: ownerGeneration,
    source_admission_policy_revision: 1, status: "ACTIVE", cutover_receipt_ref: null, created_at: input.created_at };
  const policy = { source_namespace_id: input.namespace, revision: 1, authorized_principal_refs_json: JSON.stringify([principal]),
    allowed_ownership_modes_json: '["immutable_import"]', ...Object.fromEntries(POLICY_KEYS
      .filter((key) => !["allowed_use", "allowed_ownership_modes"].includes(key)).map((key) => [key, input.policy[key]])),
    allowed_use_json: JSON.stringify(input.policy.allowed_use), created_at: input.created_at };
  return { owner, policy };
}

/** Trusted local OS operator action. No browser endpoint and no remote flag or credential transport. */
export async function initializeLocalNamespace({ command, identity, query, now = Date.now } = {}) {
  const input = validateNamespaceCommand(command, now());
  const liveIdentity = () => {
    const timestamp = now();
    if (!Number.isSafeInteger(timestamp) || timestamp < Date.parse(input.created_at)) fail("LOCAL_NAMESPACE_OWNER_REQUIRED");
    if (identity?.protocol !== "eliotr.owner-session.v1" || identity.client_class !== "owner_pwa" ||
        typeof identity.principal_ref !== "string" || !ID.test(identity.principal_ref) ||
        typeof identity.credential_generation !== "string" || !ID.test(identity.credential_generation) ||
        !canonicalTime(identity.expires_at) || Date.parse(identity.expires_at) <= timestamp) fail("LOCAL_NAMESPACE_OWNER_REQUIRED");
  };
  liveIdentity();
  const { owner, policy } = await targetRows(input, identity.principal_ref);
  const namespace = literal(input.namespace);
  const call = async (sql) => { liveIdentity(); let rows;
    try { rows = await query(sql); } catch { fail("LOCAL_NAMESPACE_D1_OBSERVATION_FAILED"); }
    liveIdentity();
    if (!Array.isArray(rows) || rows.length > 1) fail("LOCAL_NAMESPACE_READBACK_INVALID"); return rows; };
  const read = async (table, keys) => {
    const bounded = keys.map((key) => ["authorized_principal_refs_json", "allowed_ownership_modes_json", "allowed_use_json"].includes(key)
      ? `CASE WHEN length(CAST(${key} AS BLOB))<=8192 THEN ${key} ELSE NULL END AS ${key}` : key);
    const rows = await call(`SELECT ${bounded.join(",")},(SELECT COUNT(*) FROM ${table} WHERE source_namespace_id=${namespace}) AS row_count ` +
      `FROM ${table} WHERE source_namespace_id=${namespace} ORDER BY ${table === "source_namespace_ownership" ? "ownership_record_revision" : "revision"} DESC LIMIT 1`);
    const row = rows[0] ?? null;
    if (row && (!Number.isSafeInteger(row.row_count) || row.row_count !== 1)) fail("LOCAL_NAMESPACE_CONFLICT");
    return row;
  };
  const readOwner = () => read("source_namespace_ownership", OWNER_COLUMNS);
  const readPolicy = () => read("source_admission_policy", POLICY_COLUMNS);
  const noLineage = ["source", "bundle_ingest_operation"].map((table) =>
    `NOT EXISTS (SELECT 1 FROM ${table} WHERE source_namespace_id=${namespace})`).join(" AND ");
  const noOwner = `NOT EXISTS (SELECT 1 FROM source_namespace_ownership WHERE source_namespace_id=${namespace})`;
  const onlyTargetPolicy = `EXISTS (SELECT 1 FROM source_admission_policy WHERE ${POLICY_COLUMNS.map((key) => `${key}=${literal(policy[key])}`).join(" AND ")})` +
    ` AND NOT EXISTS (SELECT 1 FROM source_admission_policy WHERE source_namespace_id=${namespace} AND revision<>1)`;
  const exactCurrent = async () => {
    const ownerWhere = OWNER_COLUMNS.map((key) => `o.${key}${owner[key] === null ? " IS NULL" : `=${literal(owner[key])}`}`).join(" AND ");
    const policyWhere = POLICY_COLUMNS.map((key) => `p.${key}=${literal(policy[key])}`).join(" AND ");
    const rows = await call(`SELECT COUNT(*) AS n FROM source_namespace_ownership o JOIN source_admission_policy p ` +
      `ON p.source_namespace_id=o.source_namespace_id AND p.revision=o.source_admission_policy_revision ` +
      `WHERE ${ownerWhere} AND ${policyWhere} ` +
      `AND (SELECT COUNT(*) FROM source_namespace_ownership WHERE source_namespace_id=${namespace})=1 ` +
      `AND (SELECT COUNT(*) FROM source_admission_policy WHERE source_namespace_id=${namespace})=1`);
    if (rows[0]?.n !== 1) fail("LOCAL_NAMESPACE_CONFLICT");
  };
  const receipt = async () => ({ protocol: PROTOCOL, state: "INITIALIZED_OR_REPLAY", ownership: owner,
    admission_policy: policy, command_sha256: await digest([PROTOCOL, owner, POLICY_COLUMNS.map((key) => [key, policy[key]])]),
    read_access_granted: false, remote_effects: "NOT_EXECUTED" });
  const [priorOwner, priorPolicy] = [await readOwner(), await readPolicy()];
  if (priorOwner) {
    if (!equalRow(priorOwner, owner, OWNER_COLUMNS) || !equalRow(priorPolicy, policy, POLICY_COLUMNS)) fail("LOCAL_NAMESPACE_CONFLICT");
    // A replay may follow successful imports, but can never revive a retired/fenced/replaced owner.
    await exactCurrent();
    return receipt();
  }
  if (priorPolicy && !equalRow(priorPolicy, policy, POLICY_COLUMNS)) fail("LOCAL_NAMESPACE_CONFLICT");
  const lineage = await call(`SELECT CASE WHEN ${noLineage} THEN 0 ELSE 1 END AS present`);
  if (lineage[0]?.present !== 0) fail("LOCAL_NAMESPACE_EXISTING_LINEAGE");
  if (!priorPolicy) {
    // A policy without an ACTIVE ownership row has no ingest authority. Activate only after exact readback.
    try { await call(`INSERT INTO source_admission_policy (${POLICY_COLUMNS.join(",")}) SELECT ` +
      `${POLICY_COLUMNS.map((key) => literal(policy[key])).join(",")} WHERE ${noOwner} AND ${noLineage} ` +
      `AND NOT EXISTS (SELECT 1 FROM source_admission_policy WHERE source_namespace_id=${namespace}) ON CONFLICT DO NOTHING`); }
    catch { /* One attempt only. Resolve an ambiguous write through exact authoritative readback. */ }
    if (!equalRow(await readPolicy(), policy, POLICY_COLUMNS)) fail("LOCAL_NAMESPACE_SETTLEMENT_UNCERTAIN");
  }
  try { await call(`INSERT INTO source_namespace_ownership (${OWNER_COLUMNS.join(",")}) SELECT ` +
    `${OWNER_COLUMNS.map((key) => literal(owner[key])).join(",")} WHERE ${noOwner} AND ${noLineage} AND ${onlyTargetPolicy} ON CONFLICT DO NOTHING`); }
  catch { /* No retry and no cleanup of an unconfirmed effect. */ }
  const [observedOwner, observedPolicy] = [await readOwner(), await readPolicy()];
  if (!equalRow(observedOwner, owner, OWNER_COLUMNS) || !equalRow(observedPolicy, policy, POLICY_COLUMNS)) {
    fail("LOCAL_NAMESPACE_SETTLEMENT_UNCERTAIN");
  }
  await exactCurrent();
  return receipt();
}
