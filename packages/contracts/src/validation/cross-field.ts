import { NORMALIZED_BUNDLE_PROTOCOL } from "../normalized-bundle.js";
import {
  SOURCE_OWNER_CUTOVER_PROTOCOL,
  type SourceOwnerCutoverReceipt,
} from "../owner-cutover.js";
import type { CoverageReceipt } from "../research.js";

export type ContractIssueCode =
  | "INVALID_PROTOCOL"
  | "INVALID_ENUM_VALUE"
  | "MISSING_CONDITIONAL_FIELD"
  | "FORBIDDEN_CONDITIONAL_FIELD"
  | "CUTOVER_GENERATION_NOT_FENCED"
  | "CUTOVER_GENERATION_NOT_ACTIVE"
  | "CUTOVER_REVISION_SET_MISMATCH"
  | "CUTOVER_AUTHORIZATION_MISSING"
  | "CUTOVER_OWNER_COLLISION"
  | "CUTOVER_GENERATION_COLLISION"
  | "CUTOVER_TIME_ORDER_INVALID"
  | "ABSENCE_WITHOUT_COMPLETE_DENOMINATOR"
  | "ABSENCE_WITHOUT_FROZEN_SCOPE"
  | "ABSENCE_WITHOUT_COVERAGE_DENOMINATOR";

export interface ContractIssue {
  readonly code: ContractIssueCode;
  readonly path: readonly (string | number)[];
  readonly message: string;
}

export class ContractInvariantError extends Error {
  public readonly issues: readonly ContractIssue[];

  public constructor(issues: readonly ContractIssue[]) {
    super(issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; "));
    this.name = "ContractInvariantError";
    this.issues = issues;
  }
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function hasOwn(object: object, key: PropertyKey): boolean {
  return Object.prototype.hasOwnProperty.call(object, key);
}

function isVersionedRefLike(value: unknown): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return isNonEmptyString(record.id) && Number.isInteger(record.revision) && Number(record.revision) > 0;
}

export type NormalizedOwnershipMode =
  | "federated_reference"
  | "immutable_import"
  | "ownership_cutover";

export interface NormalizedBundleOwnershipFields {
  readonly protocol?: unknown;
  readonly origin?: {
    readonly ownership_mode?: unknown;
    readonly ownership_cutover_receipt_ref?: unknown;
  };
}

/**
 * Enforces the load-bearing ownership rule that cannot be represented by independent field types:
 * a cutover receipt is required exactly for ownership_cutover and MUST be absent otherwise.
 */
export function validateNormalizedBundleOwnership(
  value: NormalizedBundleOwnershipFields,
): readonly ContractIssue[] {
  const issues: ContractIssue[] = [];
  if (value.protocol !== NORMALIZED_BUNDLE_PROTOCOL) {
    issues.push({
      code: "INVALID_PROTOCOL",
      path: ["protocol"],
      message: `expected ${NORMALIZED_BUNDLE_PROTOCOL}`,
    });
  }

  const origin = value.origin;
  const mode = origin?.ownership_mode;
  const allowedModes: readonly NormalizedOwnershipMode[] = [
    "federated_reference",
    "immutable_import",
    "ownership_cutover",
  ];
  if (!allowedModes.includes(mode as NormalizedOwnershipMode)) {
    issues.push({
      code: "INVALID_ENUM_VALUE",
      path: ["origin", "ownership_mode"],
      message: "unknown ownership mode",
    });
    return issues;
  }

  const receiptPresent = origin !== undefined && hasOwn(origin, "ownership_cutover_receipt_ref");
  const receipt = origin?.ownership_cutover_receipt_ref;
  if (mode === "ownership_cutover" && !isNonEmptyString(receipt)) {
    issues.push({
      code: "MISSING_CONDITIONAL_FIELD",
      path: ["origin", "ownership_cutover_receipt_ref"],
      message: "ownership_cutover requires a non-empty separate cutover receipt reference",
    });
  }
  if (mode !== "ownership_cutover" && receiptPresent) {
    issues.push({
      code: "FORBIDDEN_CONDITIONAL_FIELD",
      path: ["origin", "ownership_cutover_receipt_ref"],
      message: "cutover receipt field must be absent outside ownership_cutover mode",
    });
  }
  return issues;
}

export interface SourceOwnerCutoverFields {
  readonly protocol?: unknown;
  readonly cutover?: Partial<SourceOwnerCutoverReceipt["cutover"]>;
  readonly old_owner?: Partial<SourceOwnerCutoverReceipt["old_owner"]>;
  readonly new_owner?: Partial<SourceOwnerCutoverReceipt["new_owner"]>;
  readonly validation?: Partial<SourceOwnerCutoverReceipt["validation"]>;
  readonly authorization?: Partial<SourceOwnerCutoverReceipt["authorization"]>;
}

/**
 * Cross-field validation only. Signature/authentication, exact source-view fencing and revision-set
 * readback remain application ports and must run after this validator.
 */
export function validateSourceOwnerCutover(
  value: SourceOwnerCutoverFields,
): readonly ContractIssue[] {
  const issues: ContractIssue[] = [];
  if (value.protocol !== SOURCE_OWNER_CUTOVER_PROTOCOL) {
    issues.push({
      code: "INVALID_PROTOCOL",
      path: ["protocol"],
      message: `expected ${SOURCE_OWNER_CUTOVER_PROTOCOL}`,
    });
  }
  if (value.old_owner?.terminal_status !== "FENCED" && value.old_owner?.terminal_status !== "RETIRED") {
    issues.push({
      code: "CUTOVER_GENERATION_NOT_FENCED",
      path: ["old_owner", "terminal_status"],
      message: "old owner must already be FENCED or RETIRED",
    });
  }
  if (value.new_owner?.status !== "ACTIVE") {
    issues.push({
      code: "CUTOVER_GENERATION_NOT_ACTIVE",
      path: ["new_owner", "status"],
      message: "new owner must already be ACTIVE",
    });
  }
  if (
    !isNonEmptyString(value.old_owner?.final_revision_set_digest) ||
    value.old_owner.final_revision_set_digest !== value.new_owner?.admitted_revision_set_digest
  ) {
    issues.push({
      code: "CUTOVER_REVISION_SET_MISMATCH",
      path: ["new_owner", "admitted_revision_set_digest"],
      message: "admitted revision set must exactly match the old owner's final revision set",
    });
  }
  if (
    !isNonEmptyString(value.authorization?.old_owner_authorization_ref) ||
    !isNonEmptyString(value.authorization?.new_owner_authorization_ref)
  ) {
    issues.push({
      code: "CUTOVER_AUTHORIZATION_MISSING",
      path: ["authorization"],
      message: "both owners must authorize the same cutover receipt",
    });
  }

  const oldOwnerId = value.old_owner?.owner_system_id;
  const newOwnerId = value.new_owner?.owner_system_id;
  if (isNonEmptyString(oldOwnerId) && oldOwnerId === newOwnerId) {
    issues.push({
      code: "CUTOVER_OWNER_COLLISION",
      path: ["new_owner", "owner_system_id"],
      message: "ownership cutover requires distinct old and new owner systems",
    });
  }

  const oldGeneration = value.old_owner?.source_owner_generation_before_fence;
  const newGeneration = value.new_owner?.source_owner_generation_after_activation;
  if (
    !isNonEmptyString(oldGeneration) ||
    !isNonEmptyString(newGeneration) ||
    oldGeneration === newGeneration
  ) {
    issues.push({
      code: "CUTOVER_GENERATION_COLLISION",
      path: ["new_owner", "source_owner_generation_after_activation"],
      message: "cutover must bind distinct non-empty owner generations",
    });
  }

  const preparedAt = value.cutover?.prepared_at;
  const effectiveAt = value.cutover?.effective_at;
  if (
    isNonEmptyString(preparedAt) &&
    isNonEmptyString(effectiveAt) &&
    Date.parse(preparedAt) > Date.parse(effectiveAt)
  ) {
    issues.push({
      code: "CUTOVER_TIME_ORDER_INVALID",
      path: ["cutover", "effective_at"],
      message: "effective_at must not precede prepared_at",
    });
  }
  return issues;
}

export type CoverageDenominatorKind = "complete_scope" | "sampled_with_method" | "unknown";

export type CoverageClosureFields = Partial<Pick<
  CoverageReceipt,
  | "denominator_kind"
  | "terminal_disposition"
  | "frozen_scope_snapshot_ref"
  | "coverage_denominator_ref"
>>;

/** A scoped absence is legal only against a frozen and identified complete-scope denominator. */
export function validateCoverageClosure(value: CoverageClosureFields): readonly ContractIssue[] {
  if (value.terminal_disposition !== "NO_MATCH_IN_COMPLETE_SCOPE") return [];

  const issues: ContractIssue[] = [];
  if (value.denominator_kind !== "complete_scope") {
    issues.push({
      code: "ABSENCE_WITHOUT_COMPLETE_DENOMINATOR",
      path: ["terminal_disposition"],
      message: "NO_MATCH_IN_COMPLETE_SCOPE requires denominator_kind=complete_scope",
    });
  }
  if (!isVersionedRefLike(value.frozen_scope_snapshot_ref)) {
    issues.push({
      code: "ABSENCE_WITHOUT_FROZEN_SCOPE",
      path: ["frozen_scope_snapshot_ref"],
      message: "scoped absence requires a concrete frozen scope snapshot reference",
    });
  }
  if (!isVersionedRefLike(value.coverage_denominator_ref)) {
    issues.push({
      code: "ABSENCE_WITHOUT_COVERAGE_DENOMINATOR",
      path: ["coverage_denominator_ref"],
      message: "scoped absence requires a concrete coverage denominator reference",
    });
  }
  return issues;
}

export type ResearchClosingDisposition =
  | "ANSWERED_WITH_SUPPORTED_RESULT"
  | "NO_MATCH_IN_COMPLETE_SCOPE";

/** Transport state is intentionally not accepted: transport completion never closes research. */
export function isResearchClosingDisposition(value: unknown): value is ResearchClosingDisposition {
  return value === "ANSWERED_WITH_SUPPORTED_RESULT" || value === "NO_MATCH_IN_COMPLETE_SCOPE";
}

export interface SafeContractSchema<T> {
  safeParse(input: unknown):
    | { readonly success: true; readonly data: T }
    | { readonly success: false; readonly error: unknown };
}

export class ContractDecodeError extends Error {
  public constructor(message: string, cause: unknown) {
    super(message, { cause });
    this.name = "ContractDecodeError";
  }
}

/**
 * Single decoder contour for wire schemas and generated adapters: structural parse first, then every
 * named cross-field invariant. Callers never receive partially validated data.
 */
export function decodeContractWithInvariants<T>(
  schema: SafeContractSchema<T>,
  input: unknown,
  validators: readonly ((value: T) => readonly ContractIssue[])[],
): T {
  const parsed = schema.safeParse(input);
  if (!parsed.success) throw new ContractDecodeError("wire schema validation failed", parsed.error);
  const issues = validators.flatMap((validator) => validator(parsed.data));
  assertContractInvariants(issues);
  return parsed.data;
}

export function assertContractInvariants(issues: readonly ContractIssue[]): void {
  if (issues.length > 0) throw new ContractInvariantError(issues);
}
