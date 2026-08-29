import type { CoverageReceipt } from "@eliotr/contracts";
import { domainError, type DomainError } from "./errors.js";
import { err, ok, type Result } from "./result.js";

export function validateCoverageReceipt(receipt: CoverageReceipt): Result<CoverageReceipt, DomainError> {
  if (receipt.terminal_disposition === "NO_MATCH_IN_COMPLETE_SCOPE" && receipt.denominator_kind !== "complete_scope") {
    return err(domainError("ABSENCE_WITHOUT_COMPLETE_DENOMINATOR", "scoped absence requires complete_scope denominator"));
  }
  const eligible = new Set(receipt.eligible_source_refs);
  for (const represented of receipt.represented_source_refs) {
    if (!eligible.has(represented)) {
      return err(domainError("SCOPE_REFERENCE_UNKNOWN", `represented source ${represented} is outside the denominator`));
    }
  }
  for (const cited of receipt.cited_source_refs) {
    if (!eligible.has(cited)) {
      return err(domainError("SCOPE_REFERENCE_UNKNOWN", `cited source ${cited} is outside the denominator`));
    }
  }
  return ok(receipt);
}
