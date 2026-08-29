import type { EvidenceGrade } from "@eliotr/contracts";
import { domainError, type DomainError } from "./errors.js";
import { err, ok, type Result } from "./result.js";

function evidenceGradeRank(grade: EvidenceGrade): 0 | 1 | 2 | 3 {
  switch (grade) {
    case "E0": return 0;
    case "E1": return 1;
    case "E2": return 2;
    case "E3": return 3;
    default: throw new Error(`unknown evidence grade: ${String(grade)}`);
  }
}

export interface EvidenceGradeTransition {
  readonly from: EvidenceGrade;
  readonly to: EvidenceGrade;
  readonly versionedSupersessionReceiptPresent: boolean;
  readonly freshConfirmatoryEvidencePresent: boolean;
}

export function validateEvidenceGradeTransition(input: EvidenceGradeTransition): Result<EvidenceGrade, DomainError> {
  if (evidenceGradeRank(input.to) < evidenceGradeRank(input.from) && !input.versionedSupersessionReceiptPresent) {
    return err(domainError("GRADE_DOWNGRADE_REQUIRES_SUPERSESSION", "lowering an unchanged claim grade requires versioned supersession"));
  }
  if (input.to === "E3" && input.from !== "E3" && !input.freshConfirmatoryEvidencePresent) {
    return err(domainError("INVALID_TRANSITION", "E3 promotion requires fresh confirmatory evidence, not relabeling"));
  }
  return ok(input.to);
}
