import type { AllowedReferenceManifest, VersionedRef } from "@eliotr/contracts";
import { domainError, err, ok, type DomainError, type Result } from "@eliotr/domain";

export interface ReferenceUse {
  readonly source_revision_ref?: string;
  readonly evidence_handle_ref?: VersionedRef;
  readonly tool_definition_ref?: string;
  readonly verifier_ref?: string;
}

function refKey(ref: VersionedRef): string {
  return `${ref.id}@${ref.revision}`;
}

export function validateReferenceUse(
  manifest: AllowedReferenceManifest,
  use: ReferenceUse,
): Result<void, DomainError> {
  if (use.source_revision_ref !== undefined && !manifest.allowed_source_revision_refs.includes(use.source_revision_ref)) {
    return err(domainError("SCOPE_REFERENCE_UNKNOWN", "source revision is outside AllowedReferenceManifest"));
  }
  if (use.evidence_handle_ref !== undefined) {
    const allowed = new Set(manifest.allowed_evidence_handle_refs.map(refKey));
    if (!allowed.has(refKey(use.evidence_handle_ref))) {
      return err(domainError("SCOPE_REFERENCE_UNKNOWN", "evidence handle is outside AllowedReferenceManifest"));
    }
  }
  if (use.tool_definition_ref !== undefined && !manifest.allowed_tool_definition_refs.includes(use.tool_definition_ref)) {
    return err(domainError("SCOPE_REFERENCE_UNKNOWN", "tool is outside AllowedReferenceManifest"));
  }
  if (use.verifier_ref !== undefined && !manifest.allowed_verifier_refs.includes(use.verifier_ref)) {
    return err(domainError("SCOPE_REFERENCE_UNKNOWN", "verifier is outside AllowedReferenceManifest"));
  }
  return ok(undefined);
}

export function mayExpandReferenceManifest(
  manifest: AllowedReferenceManifest,
  route: string,
): boolean {
  return manifest.permitted_acquisition_or_expansion_routes.includes(route);
}
