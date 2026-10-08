import type { VerifyEvidenceRequest, VerifyEvidenceResult, VersionedRef } from "@eliotr/contracts";
import type { EvidenceAccessContext, CloudflareEvidenceResolver } from "./types.js";

export type EvidenceRange = { readonly start: number; readonly end: number };
export type RequireEvidenceCurrent = () => Promise<void>;

function sliceUtf8(
  value: string,
  range: EvidenceRange | undefined,
): { readonly bytes: Uint8Array; readonly partial: boolean } {
  const bytes = new TextEncoder().encode(value);
  if (range === undefined) return { bytes, partial: false };
  if (
    !Number.isSafeInteger(range.start) || !Number.isSafeInteger(range.end) ||
    range.start < 0 || range.end <= range.start || range.end > bytes.byteLength
  ) {
    throw new RangeError("requested evidence response range is invalid");
  }
  const selected = bytes.slice(range.start, range.end);
  try { new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(selected); }
  catch { throw new RangeError("requested evidence response range cuts a UTF-8 code point"); }
  return { bytes: selected, partial: true };
}

/** Resolver-backed evidence operations. Core supplies verified access and the live grant recheck. */
export function createEvidenceServiceCapability(resolver: CloudflareEvidenceResolver) {
  return {
    async verify(
      access: EvidenceAccessContext,
      request: VerifyEvidenceRequest,
      requireCurrent: RequireEvidenceCurrent,
    ): Promise<VerifyEvidenceResult> {
      const resolved = "locator_candidate" in request
        ? await resolver.resolveCandidate({
          candidate: request.locator_candidate,
          scope_snapshot_ref: request.scope_snapshot_ref,
          access,
        })
        : await resolver.resolveHandle({
          handle_ref: request.handle_ref,
          expected_scope_snapshot_ref: request.scope_snapshot_ref,
          access,
        });
      await requireCurrent();
      return { resolved_evidence: resolved, handle: resolved.handle };
    },
    async open(
      access: EvidenceAccessContext,
      handleRef: VersionedRef,
      range: EvidenceRange | undefined,
      requireCurrent: RequireEvidenceCurrent,
    ): Promise<Response> {
      const resolved = await resolver.resolveHandle({ handle_ref: handleRef, access });
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
        headers.set("content-range", `bytes ${range.start}-${range.end - 1}/${resolved.handle.excerpt_byte_length}`);
      }
      const responseBody = new ArrayBuffer(selected.bytes.byteLength);
      new Uint8Array(responseBody).set(selected.bytes);
      return new Response(responseBody, { status: selected.partial ? 206 : 200, headers });
    },
  };
}
