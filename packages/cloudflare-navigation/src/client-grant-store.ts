import { ProjectClientGrantSchema, type ProjectClientGrant, type ProjectClientGrantee } from "@eliotr/contracts";
import { canonicalJson, sha256Utf8 } from "@eliotr/platform-cloudflare";

export const CLIENT_GRANT_MAX_BYTES = 24 * 1024;
export class ClientGrantError extends Error {
  public constructor(public readonly code: string, public readonly status: number,
    message: string, public readonly retryable = false) {
    super(message); this.name = "ClientGrantError";
  }
}
export function grantFail(code: string, status: number, message: string, retryable = false): never {
  throw new ClientGrantError(code, status, message, retryable);
}
export function grantId(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/u.test(value)) {
    grantFail("CLIENT_GRANT_INPUT_INVALID", 400, "A bounded identifier is required");
  }
  return value;
}
export function grantNow(now: () => number): number {
  const instant = now();
  if (!Number.isSafeInteger(instant) || instant < 0 || instant > 8_640_000_000_000_000) {
    grantFail("CLIENT_GRANT_CLOCK_INVALID", 503, "Grant clock is unavailable", true);
  }
  return instant;
}
export async function grantRead<T>(work: () => Promise<T>): Promise<T> {
  try { return await work(); } catch (error) {
    if (error instanceof ClientGrantError) throw error;
    grantFail("CLIENT_GRANT_STORAGE_UNAVAILABLE", 503, "Grant storage is unavailable; migration 0072 is required", true);
  }
}
export async function requireGrantOwner(db: D1Database, projectId: string, principal: string): Promise<number> {
  const row = await grantRead(() => db.prepare("SELECT p.generation FROM project p JOIN project_owner o " +
    "ON o.project_id=p.project_id WHERE p.project_id=?1 AND o.principal_ref=?2")
    .bind(projectId, principal).first<{ generation: number }>());
  if (!row) grantFail("CLIENT_GRANT_PROJECT_UNAVAILABLE", 404, "Project is not available to this owner");
  if (!Number.isSafeInteger(row.generation) || row.generation < 1) {
    grantFail("CLIENT_GRANT_STORAGE_CORRUPT", 503, "Project generation is invalid");
  }
  return row.generation;
}
export async function grantEpoch(db: D1Database): Promise<number> {
  const row = await grantRead(() => db.prepare("SELECT generation FROM orientation_authority_epoch WHERE singleton=1")
    .first<{ generation: number }>());
  if (!row || !Number.isSafeInteger(row.generation) || row.generation < 1) {
    grantFail("CLIENT_GRANT_STORAGE_UNAVAILABLE", 503, "Grant authority epoch is unavailable", true);
  }
  return row.generation;
}
interface GrantRow {
  grant_id: string; revision: number; project_id: string; grantor_principal_ref: string;
  grantee_issuer: string; grantee_method: string; grantee_subject: string;
  state: string; expires_at: string; record_json: string; record_sha256: string; request_sha256: string;
}
const columns = "grant_id,revision,project_id,grantor_principal_ref,grantee_issuer,grantee_method,grantee_subject," +
  "state,expires_at,record_sha256,request_sha256,CASE WHEN length(CAST(record_json AS BLOB))<=24576 " +
  "THEN record_json ELSE NULL END AS record_json";

export async function decodeGrant(row: GrantRow): Promise<ProjectClientGrant> {
  const corrupt = () => grantFail("CLIENT_GRANT_STORAGE_CORRUPT", 503, "Stored grant failed integrity validation");
  if (typeof row.record_json !== "string" || await sha256Utf8(row.record_json) !== row.record_sha256) corrupt();
  let raw: unknown;
  try { raw = JSON.parse(row.record_json); } catch { corrupt(); }
  const parsed = ProjectClientGrantSchema.safeParse(raw);
  if (!parsed.success) return corrupt();
  const grant = parsed.data;
  if (canonicalJson(grant) !== row.record_json || grant.grant_id !== row.grant_id || grant.revision !== row.revision ||
      grant.project_id !== row.project_id || grant.grantor_principal_ref !== row.grantor_principal_ref ||
      grant.grantee.issuer !== row.grantee_issuer || grant.grantee.authentication_method !== row.grantee_method ||
      grant.grantee.subject !== row.grantee_subject || grant.state !== row.state || grant.expires_at !== row.expires_at ||
      new Set(grant.allowed_operations).size !== grant.allowed_operations.length ||
      new Set(grant.ingest_namespace_ids).size !== grant.ingest_namespace_ids.length) corrupt();
  Object.freeze(grant.grantee); Object.freeze(grant.allowed_operations); Object.freeze(grant.ingest_namespace_ids);
  return Object.freeze(grant);
}
export async function readClientGrant(db: D1Database, grantId: string): Promise<ProjectClientGrant | null> {
  const row = await grantRead(() => db.prepare(`SELECT ${columns} FROM project_client_grant WHERE grant_id=?1 ORDER BY revision DESC LIMIT 1`)
    .bind(grantId).first<GrantRow>());
  return row === null ? null : decodeGrant(row);
}
export async function findClientGrant(db: D1Database, projectId: string, actor: ProjectClientGrantee): Promise<ProjectClientGrant | null> {
  const row = await grantRead(() => db.prepare(`SELECT ${columns} FROM project_client_grant WHERE project_id=?1 ` +
    "AND grantee_issuer=?2 AND grantee_method=?3 AND grantee_subject=?4 ORDER BY revision DESC LIMIT 1")
    .bind(projectId, actor.issuer, actor.authentication_method, actor.subject).first<GrantRow>());
  return row === null ? null : decodeGrant(row);
}
export async function readGrantReplay(db: D1Database, principal: string, key: string, digest: string): Promise<ProjectClientGrant | null> {
  const row = await grantRead(() => db.prepare(`SELECT ${columns} FROM project_client_grant WHERE grantor_principal_ref=?1 AND idempotency_key=?2`)
    .bind(principal, key).first<GrantRow>());
  if (!row) return null;
  if (row.request_sha256 !== digest) grantFail("CLIENT_GRANT_IDEMPOTENCY_CONFLICT", 409, "Idempotency key belongs to a different grant mutation");
  return decodeGrant(row);
}
export async function readClientGrantPage(db: D1Database, projectId: string, after: string): Promise<ProjectClientGrant[]> {
  const result = await grantRead(() => db.prepare(`SELECT ${columns} FROM project_client_grant_current ` +
    "WHERE project_id=?1 AND grant_id>?2 ORDER BY grant_id LIMIT 21").bind(projectId, after).all<GrantRow>());
  if (!result.success || !Array.isArray(result.results) || result.results.length > 21) {
    grantFail("CLIENT_GRANT_STORAGE_UNAVAILABLE", 503, "Grant page is unavailable", true);
  }
  return Promise.all(result.results.map(decodeGrant));
}

/** Private grant columns bind explicit sponsorship to the exact installed approval.
 * They are not caller-controlled DTO fields or a second permission store. */
export interface ClientGrantSpendBinding {
  readonly policy_sha256: string;
  readonly deployment_generation: string;
  readonly expires_at: string;
}
export async function readClientGrantSpend(db: D1Database, grant: ProjectClientGrant): Promise<ClientGrantSpendBinding | null> {
  const row = await grantRead(() => db.prepare("SELECT spend_policy_sha256 AS policy_sha256, " +
    "spend_deployment_generation AS deployment_generation, spend_expires_at AS expires_at, record_sha256 " +
    "FROM project_client_grant WHERE grant_id=?1 AND revision=?2")
    .bind(grant.grant_id, grant.revision).first<ClientGrantSpendBinding & { record_sha256: string }>());
  if (!row || row.record_sha256 !== await sha256Utf8(canonicalJson(grant))) {
    grantFail("CLIENT_GRANT_STORAGE_CORRUPT", 503, "Sponsorship is not bound to the exact grant revision");
  }
  if (row.policy_sha256 === null && row.deployment_generation === null && row.expires_at === null &&
      grant.spend_policy_ref === undefined) return null;
  if (grant.spend_policy_ref === undefined || typeof row.policy_sha256 !== "string" ||
      !/^[0-9a-f]{64}$/u.test(row.policy_sha256) || typeof row.deployment_generation !== "string" ||
      typeof row.expires_at !== "string" || !Number.isFinite(Date.parse(row.expires_at))) {
    grantFail("CLIENT_GRANT_STORAGE_CORRUPT", 503, "Stored sponsorship binding is invalid");
  }
  return Object.freeze({ policy_sha256: row.policy_sha256, deployment_generation: grantId(row.deployment_generation),
    expires_at: row.expires_at });
}
