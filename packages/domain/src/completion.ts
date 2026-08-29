import type { CompletionDisposition } from "@eliotr/contracts";

export type InternalTerminalOutcome =
  | "SUPPORTED"
  | "COMPLETE_SCOPE_NO_MATCH"
  | "NO_NEW_EVIDENCE"
  | "SOURCE_UNAVAILABLE"
  | "STALE"
  | "POLICY_DENIED"
  | "PARTIAL"
  | "INCONCLUSIVE"
  | "BUDGET_EXHAUSTED_PARTIAL"
  | "FAILED"
  | "PURGE_BLOCKED"
  | "CANCELLED";

export function mapInternalOutcomeToDisposition(outcome: InternalTerminalOutcome): CompletionDisposition {
  switch (outcome) {
    case "SUPPORTED": return "ANSWERED_WITH_SUPPORTED_RESULT";
    case "COMPLETE_SCOPE_NO_MATCH": return "NO_MATCH_IN_COMPLETE_SCOPE";
    case "NO_NEW_EVIDENCE": return "NO_NEW_USEFUL_EVIDENCE";
    case "SOURCE_UNAVAILABLE": return "SOURCE_UNAVAILABLE";
    case "STALE": return "STALE_SOURCE_OR_INDEX";
    case "POLICY_DENIED": return "POLICY_OR_DISCLOSURE_DENIED";
    case "PARTIAL":
    case "BUDGET_EXHAUSTED_PARTIAL": return "INCOMPLETE_COVERAGE";
    case "FAILED":
    case "PURGE_BLOCKED":
    case "INCONCLUSIVE": return "INCONCLUSIVE";
    case "CANCELLED": return "CANCELLED";
  }
}

export function dispositionClosesInquiry(disposition: CompletionDisposition): boolean {
  return disposition === "ANSWERED_WITH_SUPPORTED_RESULT" || disposition === "NO_MATCH_IN_COMPLETE_SCOPE";
}
