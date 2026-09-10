import type {
  AllowedReferenceManifest,
  PolicyDecision,
  PolicyDecisionInput,
  ScopeSnapshot,
  VersionedRef,
} from "@eliotr/contracts";

export interface AuthenticationPort {
  authenticate(request: Request): Promise<{ principal_ref: string; credential_generation: string }>;
}

export interface ScopePolicyPort {
  freezeAuthorizedScope(input: PolicyDecisionInput): Promise<ScopeSnapshot>;
}

export interface PurgeLedgerPort {
  currentRevision(): Promise<number>;
  excludePurged(snapshot: ScopeSnapshot): Promise<ScopeSnapshot>;
}

export interface SourcePolicyPort {
  evaluateSourceUse(input: PolicyDecisionInput, snapshot: ScopeSnapshot): Promise<PolicyDecision>;
}

export interface ReferenceManifestStore {
  put(manifest: AllowedReferenceManifest): Promise<VersionedRef>;
  get(ref: VersionedRef): Promise<AllowedReferenceManifest | null>;
}

export interface DeclassificationPort {
  verify(receiptRef: VersionedRef, inputDigest: string, outputDigest: string): Promise<boolean>;
}
