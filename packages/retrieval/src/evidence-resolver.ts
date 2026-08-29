import type { EvidenceHandle, LocatorCandidate, ResolvedEvidence, ScopeSnapshot } from "@eliotr/contracts";
import type { EvidenceMaterializerPort, EvidenceRegistryPort } from "./ports.js";

export interface EvidenceResolutionDependencies {
  readonly registry: EvidenceRegistryPort;
  readonly materializer: EvidenceMaterializerPort;
}

export interface EvidenceResolver {
  resolveCandidate(candidate: LocatorCandidate, scope: ScopeSnapshot): Promise<ResolvedEvidence>;
  resolveHandle(handle: EvidenceHandle, expectedScope: ScopeSnapshot): Promise<ResolvedEvidence>;
}

export const EVIDENCE_RESOLUTION_CHECKS = [
  "current authorization",
  "source owner generation",
  "purge and terminal state",
  "exact admitted source revision digest",
  "native or normalized coordinate map",
  "excerpt SHA-256 and UTF-8 byte length",
  "frozen ScopeSnapshot binding",
] as const;
