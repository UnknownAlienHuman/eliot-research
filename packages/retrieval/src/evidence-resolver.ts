import type {
  CitationResolutionReceipt,
  EvidenceHandle,
  LocatorCandidate,
  ResolvedEvidence,
  ScopeSnapshot,
  VersionedRef,
} from "@eliotr/contracts";

export interface EvidenceResolutionContext {
  readonly principal_ref: string;
  readonly client_class: "owner_pwa" | "named_api_client" | "trusted_agent" | "federation_client";
  readonly credential_generation: string;
}

export interface EvidenceResolver {
  resolveCandidate(
    candidate: LocatorCandidate,
    scope: ScopeSnapshot,
    context: EvidenceResolutionContext,
  ): Promise<ResolvedEvidence>;
  resolveHandle(
    handle: EvidenceHandle,
    expectedScope: ScopeSnapshot,
    context: EvidenceResolutionContext,
  ): Promise<ResolvedEvidence>;
  resolveCitationSet(
    handleRefs: readonly VersionedRef[],
    expectedScope: ScopeSnapshot,
    context: EvidenceResolutionContext,
  ): Promise<{
    readonly receipt: CitationResolutionReceipt;
    readonly resolved_evidence: readonly ResolvedEvidence[];
  }>;
}

export interface ExactEvidenceResolutionPort {
  resolveCandidate(
    candidate: LocatorCandidate,
    scope: ScopeSnapshot,
    context: EvidenceResolutionContext,
  ): Promise<ResolvedEvidence>;
  resolveHandle(
    handle: EvidenceHandle,
    expectedScope: ScopeSnapshot,
    context: EvidenceResolutionContext,
  ): Promise<ResolvedEvidence>;
  resolveCitationSet(
    handleRefs: readonly VersionedRef[],
    expectedScope: ScopeSnapshot,
    context: EvidenceResolutionContext,
  ): Promise<{
    readonly receipt: CitationResolutionReceipt;
    readonly resolved_evidence: readonly ResolvedEvidence[];
  }>;
}

export function createEvidenceResolver(port: ExactEvidenceResolutionPort): EvidenceResolver {
  return {
    resolveCandidate: (candidate, scope, context) => port.resolveCandidate(candidate, scope, context),
    resolveHandle: (handle, scope, context) => port.resolveHandle(handle, scope, context),
    resolveCitationSet: (refs, scope, context) => port.resolveCitationSet(refs, scope, context),
  };
}

export const EVIDENCE_RESOLUTION_CHECKS = [
  "current authorization",
  "source owner generation",
  "purge and terminal state",
  "exact admitted source revision digest",
  "native or normalized coordinate map",
  "excerpt SHA-256 and UTF-8 byte length",
  "frozen ScopeSnapshot binding",
  "durable resolution receipt",
] as const;
