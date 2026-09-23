import type {
  AuthenticatedRequestContext,
  VerifyEvidenceRequest,
  VerifyEvidenceResult,
} from "@eliotr/interfaces";
import {
  createCloudflareEvidenceResolver,
  createD1EvidenceAuthorityPort,
  createR2EvidenceContentPort,
  type CloudflareEvidenceResolver,
  type EvidenceAccessContext,
} from "@eliotr/cloudflare-evidence";
import type { VersionedRef } from "@eliotr/contracts";
import type { Env } from "./env.js";
import { authorizeProjectClientGrant, ClientGrantError } from "@eliotr/cloudflare-navigation";

export interface EvidenceService {
  verify(
    context: AuthenticatedRequestContext,
    request: VerifyEvidenceRequest,
  ): Promise<VerifyEvidenceResult>;
  open(
    context: AuthenticatedRequestContext,
    handleRef: VersionedRef,
    range?: { readonly start: number; readonly end: number },
  ): Promise<Response>;
}

export interface EvidenceServiceDependencies {
  readonly resolver?: CloudflareEvidenceResolver;
}

function access(context: AuthenticatedRequestContext): EvidenceAccessContext {
  return {
    principal_ref: context.principal_ref,
    client_class: context.client_class,
    credential_generation: context.credential_generation,
  };
}

/** Public evidence reads require their own operation; query's internal resolver has no such HTTP capability. */
async function requireDelegatedEvidence(db: D1Database, context: AuthenticatedRequestContext,
  target: { readonly scope_ref: VersionedRef } | { readonly handle_ref: VersionedRef }): Promise<() => Promise<void>> {
  if (context.client_class === "owner_pwa") return async () => {};
  const ref = "scope_ref" in target ? target.scope_ref : target.handle_ref;
  const handleJoin = "handle_ref" in target
    ? "JOIN evidence_handle h ON h.scope_snapshot_id=g.snapshot_id AND h.scope_snapshot_revision=g.snapshot_revision "
    : "";
  const targetWhere = "handle_ref" in target ? "h.handle_id=?1 AND h.revision=?2" : "g.snapshot_id=?1 AND g.snapshot_revision=?2";
  let row: { grant_id: string; revision: number; project_id: string; project_generation: number } | null;
  try {
    row = await db.prepare("SELECT g.project_client_grant_id AS grant_id,g.project_client_grant_revision AS revision," +
      "d.project_id,g.project_client_project_generation AS project_generation FROM scope_access_grant g " + handleJoin +
      "JOIN project_client_grant d ON d.grant_id=g.project_client_grant_id AND d.revision=g.project_client_grant_revision " +
      `WHERE ${targetWhere} AND g.principal_ref=?3 AND g.client_class=?4 AND g.credential_generation=?5`)
      .bind(ref.id, ref.revision, context.principal_ref, context.client_class, context.credential_generation)
      .first<{ grant_id: string; revision: number; project_id: string; project_generation: number }>();
  } catch {
    throw new ClientGrantError("CLIENT_SCOPE_NOT_READY", 503, "Evidence scope authorization is unavailable; migration 0073 is required", true);
  }
  // Non-delegated legacy grants retain their original resolver path. Missing grants are denied there.
  if (row === null) return async () => {};
  const lease = await authorizeProjectClientGrant(db, context, {
    operation: "evidence", project_id: row.project_id, required_revision: row.revision,
  });
  if (lease.grant.grant_id !== row.grant_id || lease.project_generation !== row.project_generation) {
    throw new ClientGrantError("CLIENT_SCOPE_AUTHORITY_STALE", 403, "Evidence scope belongs to a different delegation");
  }
  await lease.requireCurrent();
  return lease.requireCurrent;
}

function sliceUtf8(
  value: string,
  range: { readonly start: number; readonly end: number } | undefined,
): { readonly text: string; readonly bytes: Uint8Array; readonly partial: boolean } {
  const bytes = new TextEncoder().encode(value);
  if (range === undefined) return { text: value, bytes, partial: false };
  if (
    !Number.isSafeInteger(range.start) || !Number.isSafeInteger(range.end) ||
    range.start < 0 || range.end <= range.start || range.end > bytes.byteLength
  ) {
    throw new RangeError("requested evidence response range is invalid");
  }
  const selected = bytes.slice(range.start, range.end);
  let text: string;
  try { text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(selected); }
  catch { throw new RangeError("requested evidence response range cuts a UTF-8 code point"); }
  return { text, bytes: selected, partial: true };
}

// IMPLEMENTED_NOT_LIVE: ER-07/ER-11 exact evidence requires live D1/R2 range readback receipts.
export function createEvidenceService(
  env: Env,
  dependencies: EvidenceServiceDependencies = {},
): EvidenceService {
  const resolver = dependencies.resolver ?? createCloudflareEvidenceResolver({
    authority: createD1EvidenceAuthorityPort({
      core_database: env.CORE_DB,
      search_database: env.SEARCH_DB,
    }),
    content: createR2EvidenceContentPort({ evidence_bucket: env.EVIDENCE_BUCKET }),
  });
  return {
    async verify(context, request) {
      const requireCurrent = await requireDelegatedEvidence(env.CORE_DB, context, { scope_ref: request.scope_snapshot_ref });
      const resolved = "locator_candidate" in request
        ? await resolver.resolveCandidate({
          candidate: request.locator_candidate,
          scope_snapshot_ref: request.scope_snapshot_ref,
          access: access(context),
        })
        : await resolver.resolveHandle({
          handle_ref: request.handle_ref,
          expected_scope_snapshot_ref: request.scope_snapshot_ref,
          access: access(context),
        });
      await requireCurrent();
      return { resolved_evidence: resolved, handle: resolved.handle };
    },
    async open(context, handleRef, range) {
      const requireCurrent = await requireDelegatedEvidence(env.CORE_DB, context, { handle_ref: handleRef });
      const resolved = await resolver.resolveHandle({
        handle_ref: handleRef,
        access: access(context),
      });
      await requireCurrent();
      const selected = sliceUtf8(resolved.exact_excerpt, range);
      const headers = new Headers({
        "content-type": "text/plain; charset=utf-8",
        "content-length": String(selected.bytes.byteLength),
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
        "x-eliotr-evidence-handle": `${resolved.handle.handle_ref.id}:${resolved.handle.handle_ref.revision}`,
        "x-eliotr-excerpt-sha256": resolved.handle.excerpt_sha256,
        "x-eliotr-verification-receipt": resolved.verification_receipt_ref,
      });
      if (selected.partial && range !== undefined) {
        headers.set(
          "content-range",
          `bytes ${range.start}-${range.end - 1}/${resolved.handle.excerpt_byte_length}`,
        );
      }
      const responseBody = new ArrayBuffer(selected.bytes.byteLength);
      new Uint8Array(responseBody).set(selected.bytes);
      return new Response(responseBody, { status: selected.partial ? 206 : 200, headers });
    },
  };
}
