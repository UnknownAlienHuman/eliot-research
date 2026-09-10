import {
  QualificationReportSchema,
  SourceAdmissionDecisionSchema,
  type QualificationReport,
  type SourceAdmissionDecision,
} from "@eliotr/contracts";
import {
  qualificationDisposition,
  sourceAdmissionBlockingReasons,
  type SourceAdmissionPrerequisites,
} from "@eliotr/domain";
import {
  canonicalDigest,
  stableIngestId,
  type PreparedIngestOperation,
  type StagedBundleVerification,
} from "@eliotr/platform-cloudflare";

export interface SourceAdmissionEvaluation {
  readonly qualification: QualificationReport;
  readonly decision: SourceAdmissionDecision;
}

export interface SourceAdmissionService {
  evaluate(
    operation: PreparedIngestOperation,
    verification: StagedBundleVerification,
  ): Promise<SourceAdmissionEvaluation>;
}

export interface SourceAdmissionServiceDependencies {
  readonly now?: () => number;
}

const QUALITY_RANK = {
  degraded: 0,
  standard: 1,
  high_fidelity: 2,
} as const;
const ASSURANCE_RANK = {
  UNVERIFIED: 0,
  LOCATOR_ONLY: 1,
  CAPTURED: 2,
  QUALIFIED: 3,
  EXACT: 4,
} as const;

function exactHashSet(
  expected: Readonly<Record<string, string>>,
  observed: Readonly<Record<string, string>>,
): boolean {
  const left = Object.entries(expected).sort(([a], [b]) => a.localeCompare(b));
  const right = Object.entries(observed).sort(([a], [b]) => a.localeCompare(b));
  return JSON.stringify(left) === JSON.stringify(right);
}

function exactSizeTotal(operation: PreparedIngestOperation, verification: StagedBundleVerification): boolean {
  return verification.total_bytes === operation.total_bytes &&
    Object.values(verification.sizes).every((size) => Number.isSafeInteger(size) && size >= 0);
}

function precisionCeiling(operation: PreparedIngestOperation): QualificationReport["exact_precision_ceiling"] {
  const { capabilities, content } = operation.manifest;
  if (capabilities.tables && content.tables !== undefined && content.mappings !== undefined) {
    return "table_cell";
  }
  if (capabilities.bounding_boxes && content.mappings !== undefined) return "bounding_box";
  if (capabilities.pages && content.mappings !== undefined) return "page";
  if (capabilities.text_ranges) return "line";
  return "byte";
}

function checks(
  operation: PreparedIngestOperation,
  verification: StagedBundleVerification,
): QualificationReport["checks"] {
  const manifest = operation.manifest;
  const mappingRequired = manifest.capabilities.pages ||
    manifest.capabilities.bounding_boxes ||
    manifest.capabilities.tables;
  const mappingPresent = manifest.content.mappings !== undefined;
  const tablesComplete = !manifest.capabilities.tables ||
    (manifest.content.tables !== undefined && mappingPresent);
  const parserWarnings = manifest.quality.warnings;
  return [
    {
      check: "extraction_coverage",
      disposition: verification.verified && exactSizeTotal(operation, verification) ? "PASS" : "FAIL",
      measurement: {
        expected_total_bytes: operation.total_bytes,
        observed_total_bytes: verification.total_bytes,
      },
      reason_codes: verification.verified && exactSizeTotal(operation, verification)
        ? []
        : ["STAGING_READBACK_INCOMPLETE"],
    },
    {
      check: "source_mapping_completeness",
      disposition: mappingRequired && !mappingPresent ? "DEGRADED" : "PASS",
      measurement: {
        mapping_required: mappingRequired,
        mapping_present: mappingPresent,
      },
      reason_codes: mappingRequired && !mappingPresent ? ["SOURCE_MAPPING_MISSING"] : [],
    },
    {
      check: "tables_and_cell_mapping",
      disposition: manifest.capabilities.tables
        ? tablesComplete ? "PASS" : "FAIL"
        : "NOT_APPLICABLE",
      measurement: {
        tables_claimed: manifest.capabilities.tables,
        table_artifact_present: manifest.content.tables !== undefined,
        mapping_present: mappingPresent,
      },
      reason_codes: manifest.capabilities.tables && !tablesComplete
        ? ["TABLE_MAPPING_INCOMPLETE"]
        : [],
    },
    {
      check: "parser_warnings",
      disposition: parserWarnings.length === 0 ? "PASS" : "DEGRADED",
      measurement: { warning_count: parserWarnings.length },
      reason_codes: parserWarnings.length === 0 ? [] : ["PARSER_WARNINGS_PRESENT"],
    },
    {
      check: "identity_title_authors",
      disposition: manifest.source.original_name.trim().length > 0 ? "PASS" : "FAIL",
      reason_codes: manifest.source.original_name.trim().length > 0
        ? []
        : ["SOURCE_IDENTITY_INCOMPLETE"],
    },
  ];
}

function observedAssurance(
  overall: QualificationReport["overall"],
): SourceAdmissionDecision["assurance_ceiling"] {
  if (overall === "QUALIFIED") return "QUALIFIED";
  if (overall === "DEGRADED") return "CAPTURED";
  return "UNVERIFIED";
}

function capAssurance(
  observed: SourceAdmissionDecision["assurance_ceiling"],
  policy: SourceAdmissionDecision["assurance_ceiling"],
): SourceAdmissionDecision["assurance_ceiling"] {
  return ASSURANCE_RANK[observed] <= ASSURANCE_RANK[policy] ? observed : policy;
}

function qualityMeetsPolicy(operation: PreparedIngestOperation): boolean {
  return QUALITY_RANK[operation.manifest.quality.state] >=
    QUALITY_RANK[operation.policy.minimum_quality_state];
}

function uniqueReasonCodes(values: readonly string[]): readonly string[] {
  return [...new Set(values)].sort();
}

function prerequisites(
  operation: PreparedIngestOperation,
  verification: StagedBundleVerification,
  qualification: QualificationReport,
): SourceAdmissionPrerequisites {
  return {
    captured: operation.staging_session_ref !== null,
    stagingReadbackVerified: verification.verified && exactSizeTotal(operation, verification),
    hashesVerified: exactHashSet(operation.file_hashes, verification.hashes),
    originAuthenticated: operation.origin_authentication_receipt_ref.length > 0,
    residencyResolved: operation.residency_key_digest.length === 64,
    policyAllowed: operation.policy.authorized_principal_refs.includes(operation.principal_ref) &&
      operation.policy.allowed_ownership_modes.includes(operation.manifest.origin.ownership_mode),
    licenseAllowed: operation.policy.license_policy_ref.length > 0,
    qualificationCompleted: qualification.overall !== "REJECTED",
    ownerGenerationCurrent: true,
    cutoverReceiptValid: operation.manifest.origin.ownership_mode === "ownership_cutover"
      ? operation.manifest.origin.ownership_cutover_receipt_ref !== undefined
      : "NOT_REQUIRED",
  };
}

export function createSourceAdmissionService(
  dependencies: SourceAdmissionServiceDependencies = {},
): SourceAdmissionService {
  const clock = dependencies.now ?? Date.now;
  return {
    async evaluate(operation, verification) {
      const createdEpoch = clock();
      if (!Number.isSafeInteger(createdEpoch) || createdEpoch < 0) {
        throw new RangeError("source admission clock is invalid");
      }
      const createdAt = new Date(createdEpoch).toISOString();
      const reportId = await stableIngestId("qualification", operation.operation_id);
      const reportChecks = checks(operation, verification);
      const provisional = {
        report_ref: { id: reportId, revision: 1 },
        source_revision_ref: operation.source_revision_ref,
        parser_profile_generation: `parser:${operation.manifest.normalization.config_hash}`,
        checks: reportChecks,
        overall: "QUALIFIED" as const,
        exact_precision_ceiling: precisionCeiling(operation),
        warnings: [...operation.manifest.quality.warnings],
        created_at: createdAt,
      };
      const overall = qualificationDisposition(provisional);
      const qualification = QualificationReportSchema.parse({ ...provisional, overall });
      const blockers = sourceAdmissionBlockingReasons(
        prerequisites(operation, verification, qualification),
      );
      const minimumQualityMet = qualityMeetsPolicy(operation);
      const decisionKind: SourceAdmissionDecision["decision"] = blockers.length > 0 ||
        qualification.overall === "REJECTED"
        ? "REJECTED"
        : minimumQualityMet
          ? "ADMITTED"
          : "QUARANTINED";
      const reasonCodes = uniqueReasonCodes([
        ...blockers,
        ...qualification.checks.flatMap((check) => check.reason_codes),
        ...(minimumQualityMet ? [] : ["QUALITY_BELOW_POLICY_MINIMUM"]),
        ...(qualification.overall === "DEGRADED" ? ["QUALIFICATION_DEGRADED"] : []),
      ]);
      const decisionId = await stableIngestId(
        "admission",
        operation.operation_id,
        await canonicalDigest(qualification),
        decisionKind,
      );
      const decision = SourceAdmissionDecisionSchema.parse({
        source_namespace_id: operation.source_namespace_id,
        owner_system_id: operation.owner_system_id,
        source_owner_generation: operation.source_owner_generation,
        source_revision_ref: operation.source_revision_ref,
        origin_authentication_receipt_ref: operation.origin_authentication_receipt_ref,
        source_class: operation.policy.source_class,
        assurance_ceiling: capAssurance(
          observedAssurance(qualification.overall),
          operation.policy.assurance_ceiling,
        ),
        instruction_taint: operation.policy.instruction_taint,
        allowed_effects: operation.policy.allowed_effects,
        object_residency_key_digest: operation.residency_key_digest,
        allowed_use: [...operation.manifest.residency_and_disclosure.allowed_use],
        disclosure_ceiling: operation.policy.disclosure_ceiling,
        license_policy_ref: operation.policy.license_policy_ref,
        ...(operation.manifest.residency_and_disclosure.expiry === undefined
          ? {}
          : { expires_at: operation.manifest.residency_and_disclosure.expiry }),
        decision: decisionKind,
        reason_codes: reasonCodes,
        decision_receipt_ref: decisionId,
      });
      return { qualification, decision };
    },
  };
}
