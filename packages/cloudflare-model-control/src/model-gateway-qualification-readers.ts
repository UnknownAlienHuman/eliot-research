import type { DynamicRouteProvisioningErrorCode } from "@eliotr/cloudflare-ai";
import type {
  DynamicRoutePinnedQualificationReadInput,
  DynamicRouteQualificationCandidateIdentity,
  DynamicRouteQualificationLatestPointer,
  DynamicRouteQualificationProof,
  DynamicRouteQualificationProofStorePort,
  StoredDynamicRouteCandidate,
} from "./model-gateway-qualification-d1.js";

type StoredProof = Readonly<{ proof: DynamicRouteQualificationProof; sha256: string }>;

export interface DynamicRouteQualificationProofReaderDependencies {
  readonly fail: (code: DynamicRouteProvisioningErrorCode, message: string) => never;
  readonly identifier: (value: unknown, label: string, code: DynamicRouteProvisioningErrorCode) => string;
  readonly digest: (value: unknown, label: string, code: DynamicRouteProvisioningErrorCode) => string;
  readonly identityInput: (
    raw: DynamicRouteQualificationCandidateIdentity,
    code: DynamicRouteProvisioningErrorCode,
  ) => DynamicRouteQualificationCandidateIdentity;
  readonly readCandidate: (candidateRef: string) => Promise<StoredDynamicRouteCandidate | null>;
  readonly readProofByRef: (
    qualificationRef: string,
    candidate: StoredDynamicRouteCandidate,
  ) => Promise<StoredProof>;
  readonly readLatestPointer: (
    identity: DynamicRouteQualificationCandidateIdentity,
  ) => Promise<DynamicRouteQualificationLatestPointer | null>;
}

type ProofReaders = Pick<DynamicRouteQualificationProofStorePort, "readLatest" | "readPinned">;

export function createDynamicRouteQualificationProofReaders(
  dependencies: DynamicRouteQualificationProofReaderDependencies,
): ProofReaders {
  const invalid = "DYNAMIC_ROUTE_QUALIFICATION_INVALID";
  return Object.freeze({
    async readLatest(rawIdentity: DynamicRouteQualificationCandidateIdentity): Promise<DynamicRouteQualificationProof | null> {
      const identity = dependencies.identityInput(rawIdentity, invalid);
      const pointer = await dependencies.readLatestPointer(identity);
      if (pointer === null) return null;
      if (pointer.route_ref !== identity.route_ref || pointer.route_version !== identity.route_version ||
          pointer.candidate_ref !== identity.candidate_ref || pointer.candidate_sha256 !== identity.candidate_sha256) {
        dependencies.fail(invalid, "latest qualification points at another immutable candidate");
      }
      const candidate = await dependencies.readCandidate(identity.candidate_ref);
      if (candidate === null || candidate.sha256 !== identity.candidate_sha256) {
        dependencies.fail(invalid, "latest qualification candidate is missing or changed");
      }
      const stored = await dependencies.readProofByRef(pointer.qualification_ref, candidate);
      if (stored.sha256 !== pointer.qualification_sha256) {
        dependencies.fail(invalid, "latest qualification digest differs from its proof");
      }
      return stored.proof;
    },

    async readPinned(rawInput: DynamicRoutePinnedQualificationReadInput): Promise<DynamicRouteQualificationProof | null> {
      const identity = dependencies.identityInput(rawInput, invalid);
      const qualificationRef = dependencies.identifier(rawInput.qualification_ref, "pinned qualification reference", invalid);
      const qualificationSha = dependencies.digest(rawInput.qualification_sha256, "pinned qualification digest", invalid);
      const candidate = await dependencies.readCandidate(identity.candidate_ref);
      if (candidate === null || candidate.sha256 !== identity.candidate_sha256 ||
          candidate.row.route_ref !== identity.route_ref || candidate.row.route_version !== identity.route_version) {
        dependencies.fail(invalid, "pinned qualification candidate is missing or changed");
      }
      const stored = await dependencies.readProofByRef(qualificationRef, candidate);
      if (stored.sha256 !== qualificationSha || stored.proof.route_ref !== identity.route_ref ||
          stored.proof.route_version !== identity.route_version || stored.proof.candidate_ref !== identity.candidate_ref ||
          stored.proof.candidate_sha256 !== identity.candidate_sha256) {
        dependencies.fail(invalid, "pinned qualification proof identity or digest differs from the run configuration");
      }
      return stored.proof;
    },
  });
}
