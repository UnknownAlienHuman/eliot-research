import { evidenceSha256 } from "@eliotr/cloudflare-evidence";

const CLIENT_CLASS = "owner_pwa" as const;

export interface SourceNamespaceLeaseRefreshProof {
  readonly refresh_id: string;
  readonly source_namespace_id: string;
  readonly principal_ref: string;
  readonly client_class: typeof CLIENT_CLASS;
  readonly credential_generation: string;
  readonly access_expires_at: string;
  readonly owner_incarnation_ref: string;
  readonly source_owner_generation: string;
  readonly ownership_record_revision: number;
  readonly source_admission_policy_revision: number;
  readonly policy_ref: string;
  readonly old_generation: number;
  readonly new_generation: number;
  readonly old_allowed_use_json: string;
  readonly old_disclosure_ceiling: string;
  readonly old_expires_at: string;
  readonly new_expires_at: string;
  readonly created_at: string;
}

export interface SourceNamespaceLeaseRefreshReceiptRow {
  readonly refresh_id: unknown;
  readonly source_namespace_id: unknown;
  readonly principal_ref: unknown;
  readonly client_class: unknown;
  readonly credential_generation: unknown;
  readonly access_expires_at: unknown;
  readonly owner_incarnation_ref: unknown;
  readonly source_owner_generation: unknown;
  readonly ownership_record_revision: unknown;
  readonly source_admission_policy_revision: unknown;
  readonly policy_ref: unknown;
  readonly old_generation: unknown;
  readonly new_generation: unknown;
  readonly old_allowed_use_json: unknown;
  readonly old_disclosure_ceiling: unknown;
  readonly old_expires_at: unknown;
  readonly new_expires_at: unknown;
  readonly created_at: unknown;
  readonly state: unknown;
}

export interface SourceNamespaceLeaseRefreshSession {
  readonly principal_ref: string;
  readonly credential_generation: string;
  readonly expires_at: string;
  readonly expires_at_ms: number;
}

export interface SourceNamespaceLeaseRefreshCurrent {
  readonly source_namespace_id: string;
  readonly policy_ref: string;
  readonly generation: number;
  readonly allowed_use_json: string;
  readonly disclosure_ceiling: string;
  readonly state: "ACTIVE" | "REVOKED";
  readonly expires_at: string;
  readonly owner_incarnation_ref: string;
  readonly source_owner_generation: string;
  readonly ownership_record_revision: number;
  readonly source_admission_policy_revision: number;
}

export async function createSourceNamespaceLeaseRefreshProof(input: {
  readonly namespace_id: string;
  readonly session: SourceNamespaceLeaseRefreshSession;
  readonly current: SourceNamespaceLeaseRefreshCurrent;
  readonly new_generation: number;
  readonly created_at: string;
}): Promise<SourceNamespaceLeaseRefreshProof> {
  const identity = [
    "eliotr.owner-namespace-read-policy-lease-refresh.v1",
    input.namespace_id,
    input.session.principal_ref,
    CLIENT_CLASS,
    input.session.credential_generation,
    input.session.expires_at,
    input.current.owner_incarnation_ref,
    input.current.source_owner_generation,
    input.current.ownership_record_revision,
    input.current.source_admission_policy_revision,
    input.current.policy_ref,
    input.current.generation,
    input.current.expires_at,
    input.new_generation,
  ];
  return {
    refresh_id: `scope-lease-refresh-${await evidenceSha256(identity)}`,
    source_namespace_id: input.namespace_id,
    principal_ref: input.session.principal_ref,
    client_class: CLIENT_CLASS,
    credential_generation: input.session.credential_generation,
    access_expires_at: input.session.expires_at,
    owner_incarnation_ref: input.current.owner_incarnation_ref,
    source_owner_generation: input.current.source_owner_generation,
    ownership_record_revision: input.current.ownership_record_revision,
    source_admission_policy_revision: input.current.source_admission_policy_revision,
    policy_ref: input.current.policy_ref,
    old_generation: input.current.generation,
    new_generation: input.new_generation,
    old_allowed_use_json: input.current.allowed_use_json,
    old_disclosure_ceiling: input.current.disclosure_ceiling,
    old_expires_at: input.current.expires_at,
    new_expires_at: input.session.expires_at,
    created_at: input.created_at,
  };
}

const RECEIPT_COLUMNS =
  "refresh_id,source_namespace_id,principal_ref,client_class,credential_generation,access_expires_at," +
  "owner_incarnation_ref,source_owner_generation,ownership_record_revision,source_admission_policy_revision," +
  "policy_ref,old_generation,new_generation,old_allowed_use_json,old_disclosure_ceiling,old_expires_at," +
  "new_expires_at,created_at,state";

export async function readSourceNamespaceLeaseRefreshReceipt(
  database: D1Database,
  refreshId: string,
): Promise<SourceNamespaceLeaseRefreshReceiptRow | null> {
  return database.prepare(
    `SELECT ${RECEIPT_COLUMNS} FROM scope_read_policy_lease_refresh_receipt WHERE refresh_id=?1 LIMIT 1`,
  ).bind(refreshId).first<SourceNamespaceLeaseRefreshReceiptRow>();
}

export async function readAppliedSourceNamespaceLeaseRefresh(input: {
  readonly database: D1Database;
  readonly namespace_id: string;
  readonly session: SourceNamespaceLeaseRefreshSession;
  readonly expected_generation: number;
}): Promise<SourceNamespaceLeaseRefreshReceiptRow | null> {
  const rows = (await input.database.prepare(
    `SELECT ${RECEIPT_COLUMNS} FROM scope_read_policy_lease_refresh_receipt ` +
    "WHERE source_namespace_id=?1 AND principal_ref=?2 AND client_class='owner_pwa' " +
    "AND credential_generation=?3 AND access_expires_at=?4 AND old_generation=?5 AND state='APPLIED' LIMIT 2",
  ).bind(input.namespace_id, input.session.principal_ref, input.session.credential_generation,
    input.session.expires_at, input.expected_generation).all<SourceNamespaceLeaseRefreshReceiptRow>()).results ?? [];
  if (rows.length > 1) throw new Error("ambiguous owner namespace lease refresh receipt");
  return rows[0] ?? null;
}

export function prepareSourceNamespaceLeaseRefreshInsert(
  database: D1Database,
  proof: SourceNamespaceLeaseRefreshProof,
): D1PreparedStatement {
  const columns = "refresh_id,source_namespace_id,principal_ref,client_class,credential_generation,access_expires_at," +
    "owner_incarnation_ref,source_owner_generation,ownership_record_revision,source_admission_policy_revision," +
    "policy_ref,old_generation,new_generation,old_allowed_use_json,old_disclosure_ceiling,old_expires_at," +
    "new_expires_at,created_at,state";
  const lineage = "i.source_namespace_id=?2 AND i.principal_ref=?3 AND i.owner_incarnation_ref=?7 " +
    "AND i.source_owner_generation=?8 AND i.ownership_record_revision=?9 AND i.source_admission_policy_revision=?10 " +
    "AND i.scope_policy_ref=?11 AND o.owner_system_id='eliotr' AND o.status='ACTIVE' " +
    "AND o.owner_incarnation_ref=?7 AND o.source_owner_generation=?8 AND o.ownership_record_revision=?9 " +
    "AND o.source_admission_policy_revision=?10 AND p.authorized_principal_refs_json IS NOT NULL " +
    "AND p.allowed_ownership_modes_json IS NOT NULL AND p.allowed_use_json IS NOT NULL " +
    "AND p.disclosure_ceiling IS NOT NULL AND p.instruction_taint='DATA_ONLY' AND p.allowed_effects='READ_ONLY' " +
    "AND EXISTS (SELECT 1 FROM json_each(p.authorized_principal_refs_json) WHERE json_each.value=?3) " +
    "AND EXISTS (SELECT 1 FROM json_each(p.allowed_ownership_modes_json) WHERE json_each.value='immutable_import') " +
    "AND EXISTS (SELECT 1 FROM json_each(p.allowed_use_json) WHERE json_each.value='research') " +
    "AND s.source_namespace_id=?2 AND s.principal_ref=?3 AND s.client_class='owner_pwa' AND s.policy_ref=?11 " +
    "AND s.generation=?12 AND s.allowed_use_json=?14 AND s.disclosure_ceiling=?15 AND s.state='ACTIVE' AND s.expires_at=?16 " +
    "AND p.source_namespace_id=i.source_namespace_id AND p.revision=i.source_admission_policy_revision";
  return database.prepare(
    `INSERT INTO scope_read_policy_lease_refresh_receipt (${columns}) ` +
    "SELECT ?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,'PREPARED' " +
    "WHERE julianday('now')<julianday(?6) AND EXISTS (SELECT 1 FROM source_namespace_initialization i " +
    "JOIN source_namespace_ownership o ON o.source_namespace_id=i.source_namespace_id " +
    "AND o.ownership_record_revision=i.ownership_record_revision AND o.owner_incarnation_ref=i.owner_incarnation_ref " +
    "AND o.source_owner_generation=i.source_owner_generation AND o.source_admission_policy_revision=i.source_admission_policy_revision " +
    "JOIN source_admission_policy p ON p.source_namespace_id=i.source_namespace_id AND p.revision=i.source_admission_policy_revision " +
    "JOIN scope_read_policy s ON s.source_namespace_id=i.source_namespace_id " +
    `WHERE ${lineage}) ON CONFLICT(refresh_id) DO NOTHING`,
  ).bind(proof.refresh_id, proof.source_namespace_id, proof.principal_ref, proof.client_class,
    proof.credential_generation, proof.access_expires_at, proof.owner_incarnation_ref, proof.source_owner_generation,
    proof.ownership_record_revision, proof.source_admission_policy_revision, proof.policy_ref, proof.old_generation,
    proof.new_generation, proof.old_allowed_use_json, proof.old_disclosure_ceiling, proof.old_expires_at,
    proof.new_expires_at, proof.created_at);
}

export function cleanupPreparedSourceNamespaceLeaseRefresh(
  database: D1Database,
  proof: SourceNamespaceLeaseRefreshProof,
): D1PreparedStatement {
  return database.prepare(
    "DELETE FROM scope_read_policy_lease_refresh_receipt WHERE refresh_id=?1 AND state='PREPARED' " +
    "AND source_namespace_id=?2 AND principal_ref=?3 AND client_class='owner_pwa' AND credential_generation=?4 " +
    "AND access_expires_at=?5 AND owner_incarnation_ref=?6 AND source_owner_generation=?7 " +
    "AND ownership_record_revision=?8 AND source_admission_policy_revision=?9 AND policy_ref=?10 " +
    "AND old_generation=?11 AND new_generation=?12 AND old_allowed_use_json=?13 " +
    "AND old_disclosure_ceiling=?14 AND old_expires_at=?15 AND new_expires_at=?16",
  ).bind(proof.refresh_id, proof.source_namespace_id, proof.principal_ref, proof.credential_generation,
    proof.access_expires_at, proof.owner_incarnation_ref, proof.source_owner_generation,
    proof.ownership_record_revision, proof.source_admission_policy_revision, proof.policy_ref,
    proof.old_generation, proof.new_generation, proof.old_allowed_use_json, proof.old_disclosure_ceiling,
    proof.old_expires_at, proof.new_expires_at);
}

export async function sourceNamespaceLeaseRefreshReceiptMatches(input: {
  readonly receipt: SourceNamespaceLeaseRefreshReceiptRow;
  readonly current: SourceNamespaceLeaseRefreshCurrent;
  readonly session: SourceNamespaceLeaseRefreshSession;
  readonly expected_generation: number;
  readonly refresh_id: string;
}): Promise<boolean> {
  const receipt = input.receipt;
  if (receipt.refresh_id !== input.refresh_id || receipt.source_namespace_id !== input.current.source_namespace_id ||
      receipt.principal_ref !== input.session.principal_ref || receipt.client_class !== CLIENT_CLASS ||
      receipt.credential_generation !== input.session.credential_generation ||
      receipt.access_expires_at !== input.session.expires_at ||
      receipt.owner_incarnation_ref !== input.current.owner_incarnation_ref ||
      receipt.source_owner_generation !== input.current.source_owner_generation ||
      receipt.ownership_record_revision !== input.current.ownership_record_revision ||
      receipt.source_admission_policy_revision !== input.current.source_admission_policy_revision ||
      receipt.policy_ref !== input.current.policy_ref || receipt.old_generation !== input.expected_generation ||
      receipt.new_generation !== input.expected_generation + 1 || receipt.state !== "APPLIED" ||
      receipt.old_allowed_use_json !== input.current.allowed_use_json ||
      receipt.old_disclosure_ceiling !== input.current.disclosure_ceiling ||
      receipt.new_expires_at !== input.session.expires_at || input.current.state !== "ACTIVE" ||
      input.current.generation !== receipt.new_generation || input.current.expires_at !== input.session.expires_at ||
      typeof receipt.old_expires_at !== "string" || typeof receipt.created_at !== "string") return false;
  const oldMillis = Date.parse(receipt.old_expires_at);
  const createdMillis = Date.parse(receipt.created_at);
  if (!Number.isSafeInteger(oldMillis) || new Date(oldMillis).toISOString() !== receipt.old_expires_at ||
      oldMillis >= input.session.expires_at_ms || !Number.isSafeInteger(createdMillis) ||
      new Date(createdMillis).toISOString() !== receipt.created_at || createdMillis >= input.session.expires_at_ms) return false;
  const proof = await createSourceNamespaceLeaseRefreshProof({
    namespace_id: input.current.source_namespace_id,
    session: input.session,
    current: {
      ...input.current,
      generation: input.expected_generation,
      expires_at: receipt.old_expires_at,
    },
    new_generation: input.expected_generation + 1,
    created_at: receipt.created_at,
  });
  return proof.refresh_id === input.refresh_id;
}
