import { authorizeProjectClientGrant, nextOrientationBoundary, type ClientGrantLease } from "@eliotr/cloudflare-navigation";
import { canonicalJson, sha256Utf8 } from "@eliotr/platform-cloudflare";
import { ROUTES, type AuthenticatedRequestContext } from "@eliotr/interfaces";
import { eligibleCount, readActiveMembershipIds } from "./project-owner-storage.js";
import { fail, nowValue, type ProjectOwnerResult, type ProjectOwnerUpdateInput } from "./project-owner-contract.js";

/** The actor journals the command; the grantor independently supplies source authority. */
export interface ProjectAttachmentBinding {
  readonly grant_id: string;
  readonly grant_revision: number;
  readonly owner_principal_ref: string;
}

/** Private command envelope, not a new public project DTO or permission store. */
export async function prepareProjectAttachment(db: D1Database, context: AuthenticatedRequestContext,
  projectId: string, input: ProjectOwnerUpdateInput, suppliedKey: string, now: () => number) {
  const maxBytes = ROUTES.find((route) => route.operation === "research.projects.update")?.maximum_request_bytes;
  if (maxBytes === undefined || new TextEncoder().encode(JSON.stringify(input)).byteLength > maxBytes) {
    fail("PROJECT_INPUT_INVALID", 400, "Project attachment exceeds the existing HTTP request envelope");
  }
  const marker = await db.prepare("SELECT value FROM schema_state WHERE key='project_client_attachment_generation'")
    .first<{ value: string }>();
  if (marker?.value !== "project-client-attachment-v1") {
    fail("PROJECT_STORAGE_UNAVAILABLE", 503, "Project attachment requires migration 0081", true);
  }
  const lease = await authorizeProjectClientGrant(db, context, { operation: "project.attach", project_id: projectId }, now);
  const grant = lease.grant;
  const record = canonicalJson(grant);
  const recordSha = await sha256Utf8(record);
  const binding: ProjectAttachmentBinding = { grant_id: grant.grant_id, grant_revision: grant.revision,
    owner_principal_ref: grant.grantor_principal_ref };
  const receiptKey = `attach-${await sha256Utf8(canonicalJson({
    protocol: "eliotr.project-attachment-command.v1", actor: grant.grantee, idempotency_key: suppliedKey,
  }))}`;
  const requestSha = await sha256Utf8(canonicalJson({
    protocol: "eliotr.project-attachment-request.v1", actor: grant.grantee, project_id: projectId,
    idempotency_key: suppliedKey, input, grant_id: grant.grant_id, grant_revision: grant.revision, grant_sha256: recordSha,
  }));
  let deadline: number | undefined;

  async function frontier(current: ClientGrantLease, sourceIds: readonly string[], instant: number): Promise<number> {
    const rows = await db.prepare("SELECT source_id,head_rev FROM source WHERE source_id IN (SELECT value FROM json_each(?1)) LIMIT 257")
      .bind(JSON.stringify(sourceIds)).all<{ source_id: string; head_rev: string | null }>();
    const expected = new Set(sourceIds);
    if (!rows.success || !Array.isArray(rows.results) || rows.results.length !== expected.size ||
        rows.results.some((row) => !expected.delete(row.source_id) || typeof row.head_rev !== "string") || expected.size) {
      fail("PROJECT_SOURCE_DENIED", 403, "One or more sources have no current revision");
    }
    return nextOrientationBoundary(db, grant.grantor_principal_ref, {
      resolved_scope_expression: { kind: "PROJECT", project_id: projectId },
      member_source_revision_refs: rows.results.map((row) => row.head_rev as string),
      expires_at: new Date(current.expires_at_ms).toISOString(),
    }, instant);
  }

  async function beforeWrite(): Promise<readonly (string | number)[]> {
    await lease.requireCurrent();
    const instant = nowValue(now).millis;
    deadline = await frontier(lease, input.source_ids, instant);
    if (await eligibleCount(db, input.source_ids, grant.grantor_principal_ref, new Date(instant).toISOString()) !== input.source_ids.length) {
      fail("PROJECT_SOURCE_DENIED", 403, "Every attached source requires current grantor admission and read authority");
    }
    const scheduled = await db.prepare("SELECT 1 AS present FROM project_source_membership WHERE project_id=?1 " +
      "AND (julianday(valid_from)>julianday(?2) OR julianday(valid_to)>julianday(?2)) LIMIT 1")
      .bind(projectId, new Date(instant).toISOString()).first();
    if (scheduled) fail("PROJECT_REVISION_CONFLICT", 409, "Scheduled memberships require owner management before attachment");
    await lease.requireCurrent();
    if (!Number.isSafeInteger(deadline) || nowValue(now).millis >= deadline) {
      fail("PROJECT_SOURCE_DENIED", 403, "Project attachment authority expired before write");
    }
    return [grant.grant_id, grant.revision, grant.grantee.issuer, grant.grantee.subject,
      recordSha, lease.authority_epoch, new Date(deadline).toISOString()];
  }

  async function disclose(result: ProjectOwnerResult): Promise<ProjectOwnerResult> {
    // A successful update changes project generation and invalidates derived scopes. Reauthorize
    // the same immutable grant, not a newer replacement, after those expected local effects.
    const current = await authorizeProjectClientGrant(db, context, {
      operation: "project.attach", project_id: projectId, required_revision: grant.revision,
    }, now);
    if (canonicalJson(current.grant) !== record || result.project_ref.id !== projectId ||
        result.owner_principal_ref !== grant.grantor_principal_ref || current.project_generation < result.revision) {
      fail("PROJECT_SOURCE_DENIED", 403, "Project attachment authority no longer matches the receipt");
    }
    const instant = nowValue(now);
    const until = await frontier(current, result.source_ids, instant.millis);
    const members = new Set(await readActiveMembershipIds(db, projectId));
    if (result.source_ids.some((id) => !members.has(id)) ||
        await eligibleCount(db, result.source_ids, grant.grantor_principal_ref, instant.iso) !== result.source_ids.length) {
      fail("PROJECT_SOURCE_DENIED", 403, "The recorded project membership is no longer readable");
    }
    await current.requireCurrent();
    if (nowValue(now).millis < instant.millis || nowValue(now).millis >= until) {
      fail("PROJECT_SOURCE_DENIED", 403, "Project attachment authority expired during readback");
    }
    return result;
  }

  return { lease, binding, receiptKey, requestSha, beforeWrite, disclose,
    guardValues: () => {
      if (deadline === undefined) fail("PROJECT_STORAGE_UNAVAILABLE", 503, "Attachment write authority was not captured", true);
      return [grant.grant_id, grant.revision, new Date(deadline).toISOString()] as const;
    } };
}

/** ?1..?8 are the existing UPDATE bindings. All checks run in the original CAS statement. */
export const PROJECT_ATTACHMENT_CAS =
  " AND title=?5 AND NOT EXISTS (SELECT 1 FROM project_source_membership m WHERE m.project_id=?1 " +
  "AND m.valid_to IS NULL AND NOT EXISTS (SELECT 1 FROM requested q WHERE q.source_id=m.source_id)) " +
  "AND NOT EXISTS (SELECT 1 FROM project_source_membership m WHERE m.project_id=?1 " +
  "AND (julianday(m.valid_from)>julianday('now') OR julianday(m.valid_to)>julianday('now'))) " +
  "AND EXISTS (SELECT 1 FROM project_attachment_authority g WHERE g.project_id=?1 AND g.grantor_principal_ref=?3 " +
  "AND g.grant_id=?9 AND g.revision=?10 AND g.grantee_issuer=?11 AND g.grantee_subject=?12 AND g.record_sha256=?13) " +
  "AND (SELECT generation FROM orientation_authority_epoch WHERE singleton=1)=?14 " +
  "AND julianday(?15)>julianday('now')";
