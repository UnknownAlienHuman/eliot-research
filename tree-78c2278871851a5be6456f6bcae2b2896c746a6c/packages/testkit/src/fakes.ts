import type { EvidenceHandle, ResolvedEvidence, ScopeSnapshot, VersionedRef } from "@eliotr/contracts";
import type { EvidenceMaterializerPort, EvidenceRegistryPort } from "@eliotr/retrieval";

function key(ref: VersionedRef): string { return `${ref.id}@${ref.revision}`; }

export class InMemoryEvidenceRegistry implements EvidenceRegistryPort {
  private readonly handles = new Map<string, EvidenceHandle>();
  public seed(handle: EvidenceHandle): void { this.handles.set(key(handle.handle_ref), handle); }
  public async loadHandle(ref: VersionedRef): Promise<EvidenceHandle | null> { return this.handles.get(key(ref)) ?? null; }
  public async findOrCreateHandle(): Promise<EvidenceHandle> { throw new Error("test must seed exact evidence handles"); }
}

export class InMemoryEvidenceMaterializer implements EvidenceMaterializerPort {
  private readonly resolved = new Map<string, ResolvedEvidence>();
  public seed(value: ResolvedEvidence): void { this.resolved.set(key(value.handle.handle_ref), value); }
  public async materialize(handle: EvidenceHandle): Promise<ResolvedEvidence> {
    const value = this.resolved.get(key(handle.handle_ref));
    if (value === undefined) throw new Error(`missing materialized evidence ${key(handle.handle_ref)}`);
    return value;
  }
}

export class ScopeFixtureBuilder {
  public static empty(): ScopeSnapshot {
    return {
      snapshot_id: "scope-1", revision: 1, resolved_scope_expression: { kind: "GLOBAL_LIBRARY" },
      participant_generations: {}, member_source_revision_refs: [], source_owner_generations: {},
      policy_authority_ref: "policy-1", disclosure_closure_digest: "0".repeat(64), purge_ledger_revision: 1,
      digest: "1".repeat(64), created_at: "2026-08-28T00:00:00Z", expires_at: "2026-08-29T00:00:00Z",
    };
  }
}
