import type { SourceAcquisitionCandidate, SourceAdmissionDecision } from "@eliotr/contracts";
import type { SourceAdmissionPrerequisites } from "@eliotr/domain";

export interface SourceAdmissionRepository {
  getCandidate(candidateId: string): Promise<SourceAcquisitionCandidate | null>;
  persistDecision(decision: SourceAdmissionDecision): Promise<void>;
}

export interface SourceAdmissionService {
  decide(candidateId: string, prerequisites: SourceAdmissionPrerequisites): Promise<SourceAdmissionDecision>;
}

export function createSourceAdmissionService(_repository: SourceAdmissionRepository): SourceAdmissionService {
  return {
    async decide(): Promise<never> {
      throw new Error("ER-29 implementation required; candidates never become sources implicitly");
    },
  };
}
