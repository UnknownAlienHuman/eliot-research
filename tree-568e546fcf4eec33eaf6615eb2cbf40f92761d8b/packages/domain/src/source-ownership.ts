import type { SourceNamespaceOwnership, SourceOwnerStatus } from "@eliotr/contracts";
import { domainError, type DomainError } from "./errors.js";
import { err, ok, type Result } from "./result.js";

const ALLOWED_TRANSITIONS: Readonly<Record<SourceOwnerStatus, readonly SourceOwnerStatus[]>> = {
  ACTIVE: ["CUTOVER_PREPARED", "FENCED", "RETIRED"],
  CUTOVER_PREPARED: ["ACTIVE", "FENCED", "RETIRED"],
  FENCED: ["RETIRED"],
  RETIRED: [],
};

export interface OwnershipTransitionInput {
  readonly current: SourceNamespaceOwnership;
  readonly next: SourceNamespaceOwnership;
  readonly cutoverReceiptPresent: boolean;
}

export function validateOwnershipTransition(input: OwnershipTransitionInput): Result<SourceNamespaceOwnership, DomainError> {
  const { current, next } = input;
  if (current.source_namespace_id !== next.source_namespace_id) {
    return err(domainError("INVALID_TRANSITION", "source namespace cannot change during an ownership transition"));
  }
  if (next.ownership_record_revision !== current.ownership_record_revision + 1) {
    return err(domainError("INVALID_TRANSITION", "ownership record revision must increment by exactly one"));
  }
  const allowed = ALLOWED_TRANSITIONS[current.status] ?? [];
  if (!allowed.includes(next.status)) {
    return err(domainError("INVALID_TRANSITION", `${current.status} cannot transition to ${next.status}`));
  }
  if (current.source_owner_generation === next.source_owner_generation) {
    return err(domainError("OWNER_GENERATION_MISMATCH", "owner generation must change on every ownership lifecycle transition"));
  }
  if ((next.status === "ACTIVE" || next.status === "RETIRED") && next.owner_system_id !== current.owner_system_id && !input.cutoverReceiptPresent) {
    return err(domainError("CUTOVER_RECEIPT_INVALID", "owner change requires a bilateral cutover receipt"));
  }
  return ok(next);
}

export function assertSingleActiveOwner(records: readonly SourceNamespaceOwnership[]): Result<void, DomainError> {
  const activeByNamespace = new Map<string, number>();
  for (const record of records) {
    if (record.status !== "ACTIVE") continue;
    const count = (activeByNamespace.get(record.source_namespace_id) ?? 0) + 1;
    activeByNamespace.set(record.source_namespace_id, count);
    if (count > 1) {
      return err(domainError("DUAL_ACTIVE_OWNER", `namespace ${record.source_namespace_id} has multiple active owners`));
    }
  }
  return ok(undefined);
}
