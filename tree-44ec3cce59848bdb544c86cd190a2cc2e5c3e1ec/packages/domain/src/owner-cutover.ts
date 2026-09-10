import type { SourceNamespaceOwnership, SourceOwnerCutoverReceipt } from "@eliotr/contracts";
import { domainError, type DomainError } from "./errors.js";
import { err, ok, type Result } from "./result.js";

export interface CutoverValidationContext {
  readonly oldOwnerRecord: SourceNamespaceOwnership;
  readonly newOwnerRecord: SourceNamespaceOwnership;
  readonly expectedIdentityMappingDigest: string;
  readonly expectedFinalSourceViewRef: string;
}

export function validateSourceOwnerCutover(
  receipt: SourceOwnerCutoverReceipt,
  context: CutoverValidationContext,
): Result<SourceOwnerCutoverReceipt, DomainError> {
  const { oldOwnerRecord, newOwnerRecord } = context;
  if (receipt.cutover.source_namespace_id !== oldOwnerRecord.source_namespace_id || receipt.cutover.source_namespace_id !== newOwnerRecord.source_namespace_id) {
    return err(domainError("CUTOVER_RECEIPT_INVALID", "receipt namespace does not match both ownership records"));
  }
  if (receipt.cutover.identity_mapping_digest !== context.expectedIdentityMappingDigest) {
    return err(domainError("CUTOVER_RECEIPT_INVALID", "identity mapping digest mismatch"));
  }
  if (receipt.old_owner.owner_system_id !== oldOwnerRecord.owner_system_id || receipt.new_owner.owner_system_id !== newOwnerRecord.owner_system_id) {
    return err(domainError("CUTOVER_RECEIPT_INVALID", "receipt owner identity mismatch"));
  }
  if (oldOwnerRecord.status !== receipt.old_owner.terminal_status || !["FENCED", "RETIRED"].includes(oldOwnerRecord.status)) {
    return err(domainError("CUTOVER_RECEIPT_INVALID", "old owner must already be fenced or retired"));
  }
  if (newOwnerRecord.status !== "ACTIVE" || receipt.new_owner.status !== "ACTIVE") {
    return err(domainError("CUTOVER_RECEIPT_INVALID", "new owner must already be active"));
  }
  if (oldOwnerRecord.source_owner_generation !== receipt.old_owner.source_owner_generation_before_fence) {
    return err(domainError("OWNER_GENERATION_MISMATCH", "old owner generation mismatch"));
  }
  if (newOwnerRecord.source_owner_generation !== receipt.new_owner.source_owner_generation_after_activation) {
    return err(domainError("OWNER_GENERATION_MISMATCH", "new owner generation mismatch"));
  }
  if (receipt.old_owner.final_source_view_ref !== context.expectedFinalSourceViewRef) {
    return err(domainError("CUTOVER_RECEIPT_INVALID", "final source view mismatch"));
  }
  if (receipt.old_owner.final_revision_set_digest !== receipt.new_owner.admitted_revision_set_digest) {
    return err(domainError("REVISION_SET_MISMATCH", "old final and new admitted revision-set digests differ"));
  }
  if (receipt.authorization.old_owner_authorization_ref.length === 0 || receipt.authorization.new_owner_authorization_ref.length === 0) {
    return err(domainError("CUTOVER_RECEIPT_INVALID", "both owner authorizations are required"));
  }
  return ok(receipt);
}
