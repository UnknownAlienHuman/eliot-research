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
  try { text = new TextDecoder("utf-8", { fatal: true }).decode(selected); }
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
      return { resolved_evidence: resolved, handle: resolved.handle };
    },
    async open(context, handleRef, range) {
      const resolved = await resolver.resolveHandle({
        handle_ref: handleRef,
        access: access(context),
      });
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
