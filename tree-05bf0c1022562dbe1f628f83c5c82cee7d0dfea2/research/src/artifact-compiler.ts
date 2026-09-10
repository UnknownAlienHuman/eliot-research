import type { ArtifactRevision, ArtifactSpec, EvidenceFreeze, VersionedRef } from "@eliotr/contracts";

export type {
  ArtifactKind,
  ArtifactRevision,
  ArtifactSectionContract,
  ArtifactSectionRevision,
  ArtifactSpec,
} from "@eliotr/contracts";

export interface ArtifactCompiler {
  compile(spec: ArtifactSpec, freeze: EvidenceFreeze): Promise<ArtifactRevision>;
  reviseSection(artifactRef: VersionedRef, sectionId: string, expectedArtifactRevision: number): Promise<ArtifactRevision>;
}
