import type { ProjectAttachmentBinding } from "./project-client-attachment.js";
import { sha256Utf8 } from "@eliotr/platform-cloudflare";
import {
  MAX_PROJECTS,
  MAX_RESPONSE_BYTES,
  MAX_SOURCE_IDS,
  PROJECT_PROTOCOL,
  canonicalTime,
  fail,
  storedIdentifier,
  storedSha,
  type MembershipRow,
  type MutationReceiptRow,
  type ProjectBase,
  type ProjectBaseRow,
  type ProjectOwnerResult,
  type StoredMutation,
} from "./project-owner-contract.js";

export interface ProjectBasePage {
  readonly bases: readonly ProjectBase[];
  readonly has_more: boolean;
}

export interface StoredProjectMembershipRow {
  readonly source_id: unknown;
}

function balancedAnd(predicates: readonly string[]): string {
  let level = [...predicates];
  while (level.length > 1) {
    const next: string[] = [];
    for (let index = 0; index < level.length; index += 2) {
      const left = level[index];
      if (left === undefined) continue;
      const right = level[index + 1];
      next.push(right === undefined ? left : `(${left} AND ${right})`);
    }
    level = next;
  }
  return level[0] ?? "1";
}

export function currentSourcePredicate(principal: string, observed: string): string {
  return balancedAnd([
    "r.source_revision_ref=s.head_rev",
    "r.purge_state='LIVE'",
    "o.source_namespace_id=s.source_namespace_id",
    "o.status='ACTIVE'",
    "o.owner_system_id=s.source_owner_system_id",
    "o.source_owner_generation=s.source_owner_generation",
    "r.source_owner_generation=s.source_owner_generation",
    "ap.source_namespace_id=o.source_namespace_id",
    "ap.revision=o.source_admission_policy_revision",
    "json_type(ap.allowed_use_json)='array'",
    "json_type(ap.allowed_ownership_modes_json)='array'",
    "EXISTS (SELECT 1 FROM json_each(ap.allowed_use_json) WHERE json_each.value='research')",
    "EXISTS (SELECT 1 FROM json_each(ap.allowed_ownership_modes_json) WHERE json_each.value=s.ownership_mode)",
    "d.source_revision_ref=r.source_revision_ref",
    "d.decision='ADMITTED'",
    "d.decision_receipt_ref=(SELECT chosen.decision_receipt_ref FROM source_admission_decision chosen " +
      "WHERE chosen.source_revision_ref=r.source_revision_ref AND chosen.decision='ADMITTED' " +
      "ORDER BY chosen.created_at DESC, chosen.decision_receipt_ref DESC LIMIT 1)",
    "d.owner_system_id=o.owner_system_id",
    "d.source_namespace_id=s.source_namespace_id",
    "d.source_owner_generation=s.source_owner_generation",
    "d.source_class=ap.source_class",
    "(d.expires_at IS NULL OR julianday(d.expires_at)>julianday(" + observed + "))",
    "d.disclosure_ceiling=rp.disclosure_ceiling",
    "json_type(d.allowed_use_json)='array'",
    "json_type(rp.allowed_use_json)='array'",
    "EXISTS (SELECT 1 FROM json_each(d.allowed_use_json) WHERE json_each.value='research')",
    "NOT EXISTS (SELECT 1 FROM json_each(d.allowed_use_json) used " +
      "WHERE NOT EXISTS (SELECT 1 FROM json_each(rp.allowed_use_json) permitted WHERE permitted.value=used.value))",
    "rp.source_namespace_id=s.source_namespace_id",
    "rp.principal_ref=" + principal,
    "rp.client_class='owner_pwa'",
    "rp.state='ACTIVE'",
    "julianday(rp.expires_at)>julianday(" + observed + ")",
  ]);
}

export function currentMembershipsReadableGuard(): string {
  // Keep the authority predicate in the sibling CTE. Referencing its result
  // here avoids nesting the full JSON/admission policy expression below the
  // project UPDATE, which exceeds D1's expression-depth limit.
  return "NOT EXISTS (SELECT 1 FROM project_source_membership old " +
    "WHERE old.project_id=?1 AND old.valid_to IS NULL " +
    "AND NOT EXISTS (SELECT 1 FROM current_readable_sources readable " +
    "WHERE readable.source_id=old.source_id))";
}

export function eligibleSourceCte(sourceJson: string, principal: string, observed: string, projectId?: string): string {
  // Factor the complete authority/readability predicate once. The
  // mutation statements only join this bounded projection, keeping their
  // nested expression depth below the Cloudflare D1 limit.
  const projectCandidates = projectId === undefined ? "NULL" : projectId;
  return `WITH requested AS (SELECT value AS source_id FROM json_each(${sourceJson})), candidate_source_ids AS (` +
    "SELECT source_id FROM requested UNION SELECT old.source_id FROM project_source_membership old " +
    `WHERE old.project_id=${projectCandidates} AND old.valid_to IS NULL), current_readable_sources AS (` +
    "SELECT DISTINCT s.source_id FROM candidate_source_ids candidate " +
    "JOIN source s ON s.source_id=candidate.source_id " +
    "JOIN source_revision r ON r.source_id=s.source_id " +
    "JOIN source_namespace_ownership o ON o.source_namespace_id=s.source_namespace_id " +
    "JOIN source_admission_policy ap ON ap.source_namespace_id=o.source_namespace_id " +
    "JOIN source_admission_decision d ON d.source_revision_ref=r.source_revision_ref " +
    "JOIN scope_read_policy rp ON rp.source_namespace_id=s.source_namespace_id " +
    `WHERE ${currentSourcePredicate(principal, observed)}), eligible AS (` +
    "SELECT DISTINCT q.source_id FROM requested q JOIN current_readable_sources readable " +
    "ON readable.source_id=q.source_id)";
}

function sourceReadJoins(principal: string, observed: string): string {
  return "JOIN source s ON s.source_id=m.source_id " +
    "JOIN source_revision r ON r.source_id=s.source_id " +
    "JOIN source_namespace_ownership o ON o.source_namespace_id=s.source_namespace_id " +
    "JOIN source_admission_policy ap ON ap.source_namespace_id=o.source_namespace_id " +
    "JOIN source_admission_decision d ON d.source_revision_ref=r.source_revision_ref " +
    "JOIN scope_read_policy rp ON rp.source_namespace_id=s.source_namespace_id " +
    `WHERE ${currentSourcePredicate(principal, observed)}`;
}

function decodeBase(row: ProjectBaseRow): ProjectBase {
  const projectId = storedIdentifier(row.project_id, "project id");
  const title = typeof row.title === "string" && row.title.length > 0 && row.title.length <= 512 &&
      row.title.length === row.title.trim().length && row.title === row.title.trim() &&
      new TextEncoder().encode(row.title).byteLength <= 4 * 1024 && !/[\u0000-\u001f\u007f]/u.test(row.title)
    ? row.title : null;
  if (title === null) fail("PROJECT_STORAGE_UNAVAILABLE", 503, "stored project title is invalid", true);
  if (!Number.isSafeInteger(row.generation) || Number(row.generation) < 1) {
    fail("PROJECT_STORAGE_UNAVAILABLE", 503, "stored project revision is invalid", true);
  }
  const createdAt = canonicalTime(row.created_at, "stored project creation time", "PROJECT_STORAGE_UNAVAILABLE", true);
  return {
    project_id: projectId,
    title,
    revision: Number(row.generation),
    created_at: createdAt,
    principal_ref: storedIdentifier(row.principal_ref, "project owner principal"),
    deployment_generation: storedIdentifier(row.deployment_generation, "project deployment generation"),
  };
}

function normalizeStoredTitle(value: unknown): string {
  if (typeof value !== "string" || value.length < 1 || value.length > 512 || value !== value.trim() ||
      new TextEncoder().encode(value).byteLength > 4 * 1024 || /[\u0000-\u001f\u007f]/u.test(value)) {
    fail("PROJECT_STORAGE_UNAVAILABLE", 503, "stored project response title is invalid", true);
  }
  return value;
}

function normalizeStoredSourceIds(value: unknown): readonly string[] {
  if (!Array.isArray(value) || value.length > MAX_SOURCE_IDS ||
      value.some((id) => typeof id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/u.test(id))) {
    fail("PROJECT_STORAGE_UNAVAILABLE", 503, "stored project response source_ids are invalid", true);
  }
  const ids = [...value] as string[];
  if (new Set(ids).size !== ids.length || ids.some((id, index) => {
    const previousId = index > 0 ? ids[index - 1] : undefined;
    return previousId !== undefined && previousId >= id;
  })) {
    fail("PROJECT_STORAGE_UNAVAILABLE", 503, "stored project response source_ids are not canonical", true);
  }
  return Object.freeze(ids);
}

export function projectResult(base: ProjectBase, sourceIds: readonly string[]): ProjectOwnerResult {
  const ids = [...sourceIds].sort();
  if (new Set(ids).size !== ids.length || ids.some((id) => !/^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/u.test(id))) {
    fail("PROJECT_STORAGE_UNAVAILABLE", 503, "stored project membership is invalid", true);
  }
  return Object.freeze({
    protocol: PROJECT_PROTOCOL,
    project_ref: Object.freeze({ id: base.project_id, revision: base.revision }),
    title: base.title,
    revision: base.revision,
    owner_principal_ref: base.principal_ref,
    deployment_generation: base.deployment_generation,
    source_ids: Object.freeze(ids),
    created_at: base.created_at,
  });
}

function decodeProjectResult(value: unknown, principal: string): ProjectOwnerResult {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail("PROJECT_STORAGE_UNAVAILABLE", 503, "stored project response is invalid", true);
  }
  const record = value as Record<string, unknown>;
  const keys = ["protocol", "project_ref", "title", "revision", "owner_principal_ref", "deployment_generation", "source_ids", "created_at"];
  if (Object.keys(record).length !== keys.length || keys.some((key) => !Object.prototype.hasOwnProperty.call(record, key)) ||
      record.protocol !== PROJECT_PROTOCOL || record.owner_principal_ref !== principal ||
      !Number.isSafeInteger(record.revision) || Number(record.revision) < 1) {
    fail("PROJECT_STORAGE_UNAVAILABLE", 503, "stored project response shape is invalid", true);
  }
  const ref = record.project_ref;
  if (ref === null || typeof ref !== "object" || Array.isArray(ref)) {
    fail("PROJECT_STORAGE_UNAVAILABLE", 503, "stored project reference is invalid", true);
  }
  const refRecord = ref as Record<string, unknown>;
  if (Object.keys(refRecord).length !== 2 || !Object.prototype.hasOwnProperty.call(refRecord, "id") ||
      !Object.prototype.hasOwnProperty.call(refRecord, "revision") ||
      !/^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/u.test(String(refRecord.id)) ||
      !Number.isSafeInteger(refRecord.revision) || Number(refRecord.revision) !== Number(record.revision)) {
    fail("PROJECT_STORAGE_UNAVAILABLE", 503, "stored project reference is invalid", true);
  }
  const title = normalizeStoredTitle(record.title);
  const deployment = storedIdentifier(record.deployment_generation, "project response deployment generation");
  const createdAt = canonicalTime(record.created_at, "stored project response creation time", "PROJECT_STORAGE_UNAVAILABLE", true);
  const sourceIds = normalizeStoredSourceIds(record.source_ids);
  return Object.freeze({
    protocol: PROJECT_PROTOCOL,
    project_ref: Object.freeze({ id: String(refRecord.id), revision: Number(refRecord.revision) }),
    title,
    revision: Number(record.revision),
    owner_principal_ref: principal,
    deployment_generation: deployment,
    source_ids: sourceIds,
    created_at: createdAt,
  });
}

export async function readBase(database: D1Database, principal: string, projectId: string): Promise<ProjectBase | null> {
  let row: ProjectBaseRow | null;
  try {
    row = await database.prepare(
      "SELECT p.project_id,p.title,p.generation,p.created_at,o.principal_ref,o.deployment_generation " +
      "FROM project p JOIN project_owner o ON o.project_id=p.project_id " +
      "WHERE p.project_id=?1 AND o.principal_ref=?2 LIMIT 1",
    ).bind(projectId, principal).first<ProjectBaseRow>();
  } catch (cause) {
    fail("PROJECT_STORAGE_UNAVAILABLE", 503, "project owner read is unavailable", true, cause);
  }
  return row === null ? null : decodeBase(row);
}

export async function readProjectBases(database: D1Database, principal: string, afterProjectId?: string): Promise<ProjectBasePage> {
  const limit = MAX_PROJECTS + 1;
  const afterClause = afterProjectId === undefined ? "" : " AND p.project_id>?2";
  const statement = "SELECT p.project_id,p.title,p.generation,p.created_at,o.principal_ref,o.deployment_generation " +
    "FROM project p JOIN project_owner o ON o.project_id=p.project_id WHERE o.principal_ref=?1" + afterClause +
    ` ORDER BY p.project_id LIMIT ?${afterProjectId === undefined ? 2 : 3}`;
  let result: { readonly results?: readonly ProjectBaseRow[] };
  try {
    result = afterProjectId === undefined
      ? await database.prepare(statement).bind(principal, limit).all<ProjectBaseRow>()
      : await database.prepare(statement).bind(principal, afterProjectId, limit).all<ProjectBaseRow>();
  } catch (cause) {
    fail("PROJECT_STORAGE_UNAVAILABLE", 503, "project list is unavailable", true, cause);
  }
  if (!Array.isArray(result.results) || result.results.length > limit) {
    fail("PROJECT_STORAGE_UNAVAILABLE", 503, "project list returned an invalid bounded page", true);
  }
  const hasMore = result.results.length === limit;
  return { bases: Object.freeze(result.results.slice(0, MAX_PROJECTS).map(decodeBase)), has_more: hasMore };
}

export async function readMembershipIds(database: D1Database, principal: string, projectIds: readonly string[], observed: string): Promise<readonly MembershipRow[]> {
  if (projectIds.length === 0) return [];
  const limit = projectIds.length * MAX_SOURCE_IDS + 1;
  let result: { readonly results?: readonly MembershipRow[] };
  try {
    result = await database.prepare(
      "SELECT DISTINCT m.project_id,m.source_id FROM project_source_membership m " +
      "JOIN project p ON p.project_id=m.project_id AND p.generation=m.membership_generation " + sourceReadJoins("?2", "?3") +
      " AND m.project_id IN (SELECT value FROM json_each(?1)) " +
      "AND m.valid_to IS NULL AND julianday(m.valid_from)<=julianday(?3) " +
      "ORDER BY m.project_id,m.source_id LIMIT ?4",
    ).bind(JSON.stringify(projectIds), principal, observed, limit).all<MembershipRow>();
  } catch (cause) {
    fail("PROJECT_STORAGE_UNAVAILABLE", 503, "project memberships read is unavailable", true, cause);
  }
  if (!Array.isArray(result.results) || result.results.length >= limit) {
    fail("PROJECT_STORAGE_UNAVAILABLE", 503, "project memberships exceed the bounded envelope", true);
  }
  return result.results;
}

export async function readActiveMembershipIds(database: D1Database, projectId: string): Promise<readonly string[]> {
  let result: { readonly results?: readonly StoredProjectMembershipRow[] };
  try {
    result = await database.prepare(
      "SELECT source_id FROM project_source_membership WHERE project_id=?1 AND valid_to IS NULL " +
      "ORDER BY source_id LIMIT ?2",
    ).bind(projectId, MAX_SOURCE_IDS + 1).all<StoredProjectMembershipRow>();
  } catch (cause) {
    fail("PROJECT_STORAGE_UNAVAILABLE", 503, "project memberships read is unavailable", true, cause);
  }
  if (!Array.isArray(result.results) || result.results.length > MAX_SOURCE_IDS) {
    fail("PROJECT_STORAGE_UNAVAILABLE", 503, "project has too many active memberships", true);
  }
  const ids = result.results.map((row) => storedIdentifier(row.source_id, "active membership source id"));
  if (new Set(ids).size !== ids.length) fail("PROJECT_STORAGE_UNAVAILABLE", 503, "project has duplicate active memberships", true);
  return Object.freeze(ids);
}

export function groupMemberships(rows: readonly MembershipRow[], projectIds: readonly string[]): Map<string, string[]> {
  const grouped = new Map(projectIds.map((projectId) => [projectId, [] as string[]]));
  for (const row of rows) {
    const projectId = storedIdentifier(row.project_id, "membership project id");
    const sourceId = storedIdentifier(row.source_id, "membership source id");
    const values = grouped.get(projectId);
    if (values === undefined) fail("PROJECT_STORAGE_UNAVAILABLE", 503, "membership returned for an unknown project", true);
    if (values.includes(sourceId)) fail("PROJECT_STORAGE_UNAVAILABLE", 503, "duplicate active project membership", true);
    values.push(sourceId);
  }
  return grouped;
}

function decodeReceiptRow(row: MutationReceiptRow, principal: string, attachment?: ProjectAttachmentBinding): StoredMutation {
  if (attachment === undefined ? row.project_client_grant_id !== null || row.project_client_grant_revision !== null
    : row.project_client_grant_id !== attachment.grant_id || row.project_client_grant_revision !== attachment.grant_revision) {
    fail("PROJECT_IDEMPOTENCY_CONFLICT", 409, "Idempotency key belongs to another project authority revision");
  }
  const rowPrincipal = storedIdentifier(row.principal_ref, "receipt principal");
  const key = storedIdentifier(row.idempotency_key, "receipt idempotency key");
  const operation = row.operation === "CREATE" || row.operation === "UPDATE" ? row.operation : null;
  if (operation === null) fail("PROJECT_STORAGE_UNAVAILABLE", 503, "stored receipt operation is invalid", true);
  const projectId = storedIdentifier(row.project_id, "receipt project id");
  const requestSha = storedSha(row.request_sha256, "receipt request digest");
  const responseJson = typeof row.response_json === "string" ? row.response_json : null;
  if (responseJson === null || new TextEncoder().encode(responseJson).byteLength < 1 ||
      new TextEncoder().encode(responseJson).byteLength > MAX_RESPONSE_BYTES) {
    fail("PROJECT_STORAGE_UNAVAILABLE", 503, "stored receipt response is invalid", true);
  }
  const responseSha = storedSha(row.response_sha256, "receipt response digest");
  if (!Number.isSafeInteger(row.project_revision) || Number(row.project_revision) < 1) {
    fail("PROJECT_STORAGE_UNAVAILABLE", 503, "stored receipt revision is invalid", true);
  }
  const deployment = storedIdentifier(row.deployment_generation, "receipt deployment generation");
  const createdAt = canonicalTime(row.created_at, "stored receipt creation time", "PROJECT_STORAGE_UNAVAILABLE", true);
  if (rowPrincipal !== principal) fail("PROJECT_STORAGE_UNAVAILABLE", 503, "stored receipt principal is inconsistent", true);
  let parsed: unknown;
  try { parsed = JSON.parse(responseJson); } catch (cause) {
    fail("PROJECT_STORAGE_UNAVAILABLE", 503, "stored receipt response is not JSON", true, cause);
  }
  const result = decodeProjectResult(parsed, attachment?.owner_principal_ref ?? principal);
  if (result.project_ref.id !== projectId || result.revision !== Number(row.project_revision) ||
      result.deployment_generation !== deployment || result.protocol !== PROJECT_PROTOCOL) {
    fail("PROJECT_STORAGE_UNAVAILABLE", 503, "stored receipt response does not match its row", true);
  }
  return {
    principal_ref: rowPrincipal,
    idempotency_key: key,
    operation,
    project_id: projectId,
    request_sha256: requestSha,
    response_sha256: responseSha,
    project_revision: Number(row.project_revision),
    deployment_generation: deployment,
    created_at: createdAt,
    result,
  };
}

export async function readReceipt(database: D1Database, principal: string, key: string, attachment?: ProjectAttachmentBinding): Promise<StoredMutation | null> {
  let row: MutationReceiptRow | null;
  try {
    row = await database.prepare(
      "SELECT principal_ref,idempotency_key,operation,project_id,request_sha256,response_json,response_sha256," +
      "project_revision,deployment_generation,created_at,project_client_grant_id,project_client_grant_revision FROM project_mutation_receipt " +
      "WHERE principal_ref=?1 AND idempotency_key=?2 LIMIT 1",
    ).bind(principal, key).first<MutationReceiptRow>();
  } catch (cause) {
    fail("PROJECT_STORAGE_UNAVAILABLE", 503, "project mutation receipt read is unavailable", true, cause);
  }
  if (row === null) return null;
  const receipt = decodeReceiptRow(row, principal, attachment);
  if (await sha256Utf8(JSON.stringify(receipt.result)) !== receipt.response_sha256) {
    fail("PROJECT_STORAGE_UNAVAILABLE", 503, "stored receipt response digest does not match", true);
  }
  return receipt;
}

export function checkExisting(existing: StoredMutation | null, operation: "CREATE" | "UPDATE", projectId: string, requestSha: string): ProjectOwnerResult | null {
  if (existing === null) return null;
  if (existing.operation !== operation || existing.project_id !== projectId || existing.request_sha256 !== requestSha) {
    fail("PROJECT_IDEMPOTENCY_CONFLICT", 409, "idempotency key is bound to different project input");
  }
  return existing.result;
}

export function exactBatchResults(results: readonly D1Result<unknown>[], expected: readonly (number | null)[]): void {
  if (results.length !== expected.length || results.some((result, index) => result?.success !== true ||
      (expected[index] !== null && (result.meta?.changes ?? 0) !== expected[index]))) {
    fail("PROJECT_SETTLEMENT_UNCERTAIN", 503, "project mutation batch did not settle exactly", true);
  }
}

export async function eligibleCount(database: D1Database, sourceIds: readonly string[], principal: string, observed: string): Promise<number> {
  const sourceJson = JSON.stringify(sourceIds);
  const cte = eligibleSourceCte("?1", "?2", "?3");
  let row: { readonly requested_count: unknown; readonly eligible_count: unknown } | null;
  try {
    row = await database.prepare(`${cte} SELECT (SELECT COUNT(*) FROM requested) AS requested_count,COUNT(*) AS eligible_count FROM eligible`)
      .bind(sourceJson, principal, observed).first<{ requested_count: unknown; eligible_count: unknown }>();
  } catch (cause) {
    fail("PROJECT_STORAGE_UNAVAILABLE", 503, "source authority read is unavailable", true, cause);
  }
  if (row === null || !Number.isSafeInteger(row.requested_count) || !Number.isSafeInteger(row.eligible_count) ||
      Number(row.requested_count) !== sourceIds.length || Number(row.eligible_count) < 0 || Number(row.eligible_count) > sourceIds.length) {
    fail("PROJECT_STORAGE_UNAVAILABLE", 503, "source authority returned an invalid count", true);
  }
  return Number(row.eligible_count);
}

export function createReceiptJson(base: ProjectBase, sourceIds: readonly string[]): string {
  return JSON.stringify(projectResult(base, sourceIds));
}

export function sourceMembershipsReadable(current: readonly string[], readable: readonly string[]): boolean {
  const readableSet = new Set(readable);
  return current.every((sourceId) => readableSet.has(sourceId));
}
