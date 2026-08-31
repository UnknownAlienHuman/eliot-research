import type { QualificationReport, ReadinessChannel } from "@eliotr/contracts";

export function qualificationDisposition(report: QualificationReport): "QUALIFIED" | "DEGRADED" | "REJECTED" {
  if (report.checks.some((check: QualificationReport["checks"][number]) => check.disposition === "FAIL")) return "REJECTED";
  if (report.checks.some((check: QualificationReport["checks"][number]) => check.disposition === "DEGRADED")) return "DEGRADED";
  return "QUALIFIED";
}

const precisionOrder = ["byte", "line", "page", "bounding_box", "table_cell"] as const;

export function precisionAtLeast(
  actual: QualificationReport["exact_precision_ceiling"],
  required: QualificationReport["exact_precision_ceiling"],
): boolean {
  return precisionOrder.indexOf(actual) >= precisionOrder.indexOf(required);
}

export function readinessAllowedByQualification(report: QualificationReport, channel: ReadinessChannel): boolean {
  if (report.overall === "REJECTED") return false;
  if (channel === "semantic_ready") return true;
  if (channel === "exact_ready") return precisionAtLeast(report.exact_precision_ceiling, "byte");
  if (channel === "structure_qualified") return report.overall === "QUALIFIED";
  return true;
}
