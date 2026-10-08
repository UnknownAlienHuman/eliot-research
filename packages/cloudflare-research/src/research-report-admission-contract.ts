import { IdentifierSchema, type OperationIntent, type PolicyDecision } from "@eliotr/contracts";
import type { ArtifactDraftAdmissionPort } from "@eliotr/cloudflare-artifacts";
import { canonicalEvidenceJson, type NavigationReadAuthority } from "@eliotr/cloudflare-evidence";
import type { StageRequest, WorkflowPrincipal } from "@eliotr/cloudflare-workflows";
export const RESEARCH_REPORT_ADMISSION_SCHEMA = "eliotr.research.report-admission.v1" as const;
export const RESEARCH_REPORT_ADMISSION_TOPIC = "research.artifact-draft" as const;
export const RESEARCH_REPORT_OUTPUT_CLASS = "private-draft" as const;
export const RESEARCH_REPORT_PURPOSE = "research-report-materialization" as const;

const SHA256 = /^[a-f0-9]{64}$/u;

export interface ResearchReportAdmissionPolicy {
  readonly schema: typeof RESEARCH_REPORT_ADMISSION_SCHEMA | "eliotr.research.delegated-report-admission.v1";
  readonly policy_ref: string;
  readonly policy_revision: number;
  readonly config_provenance_ref: string;
  readonly principal_ref: string;
  readonly client_class: "owner_pwa" | "trusted_agent" | "named_api_client";
  readonly policy_generation: string;
  readonly policy_authority_ref: string;
  readonly allowed_use: readonly string[];
  readonly disclosure_ceiling: string;
  readonly requested_output_class: typeof RESEARCH_REPORT_OUTPUT_CLASS;
  readonly purpose: typeof RESEARCH_REPORT_PURPOSE;
  readonly expires_at: string;
}

export interface ResearchReportAdmissionInput {
  readonly database: D1Database;
  readonly navigation: NavigationReadAuthority;
  readonly request: StageRequest;
  readonly principal: WorkflowPrincipal;
  readonly policy_source: ResearchReportAdmissionPolicySource;
  readonly now?: () => number;
}

export interface ResearchReportAdmissionPolicySource {
  readonly provenance_ref: string;
  read(): Promise<ResearchReportAdmissionPolicy | null>;
}

export interface ResearchReportAdmissionPolicyConfig {
  /** Explicit installed Worker configuration; never forwarded from request bodies. */
  readonly raw?: string;
  readonly provenance_ref: string;
}

/** Decode the installed REPORT policy while retaining per-request current-authority checks. */
export function createResearchReportAdmissionPolicyConfigSource(
  config: ResearchReportAdmissionPolicyConfig,
): ResearchReportAdmissionPolicySource {
  if (config === null || typeof config !== "object") {
    fail("REPORT_ADMISSION_INPUT_INVALID", "REPORT policy configuration is invalid");
  }
  const provenanceRef = text(config.provenance_ref, "REPORT policy source provenance");
  if (config.raw === undefined || config.raw === "") {
    return Object.freeze({ provenance_ref: provenanceRef, read: async () => null });
  }
  if (typeof config.raw !== "string" || new TextEncoder().encode(config.raw).byteLength > 65536) {
    fail("REPORT_ADMISSION_INPUT_INVALID", "REPORT policy configuration must be bounded JSON");
  }
  let decoded: unknown;
  try { decoded = JSON.parse(config.raw) as unknown; }
  catch (cause) { fail("REPORT_ADMISSION_INPUT_INVALID", "REPORT policy configuration is not JSON", false, cause); }
  if (decoded === null || typeof decoded !== "object" || Array.isArray(decoded)) {
    fail("REPORT_ADMISSION_INPUT_INVALID", "REPORT policy configuration must contain one policy");
  }
  const policy = validatePolicy(decoded as ResearchReportAdmissionPolicy);
  if (policy.config_provenance_ref !== provenanceRef) {
    fail("REPORT_ADMISSION_DENIED", "REPORT policy provenance differs from the installed server source");
  }
  return Object.freeze({
    provenance_ref: provenanceRef,
    read: async () => snapshot(policy, "installed REPORT policy"),
  });
}

export interface ResearchReportAdmissionPreparation {
  readonly decision: PolicyDecision;
  readonly decision_sha256: string;
  readonly intent: OperationIntent;
  readonly authority_input_sha256: string;
  readonly admission: ArtifactDraftAdmissionPort;
}

export interface ResearchReportAdmissionResult {
  readonly decision: PolicyDecision;
  readonly decision_sha256: string;
  readonly input_sha256: string;
  readonly intent: OperationIntent;
  readonly outbox_id: string;
  readonly disposition: "CREATED" | "EXISTING";
}

export type ResearchReportAdmissionErrorCode =
  | "REPORT_ADMISSION_POLICY_MISSING"
  | "REPORT_ADMISSION_INPUT_INVALID"
  | "REPORT_ADMISSION_DENIED"
  | "REPORT_ADMISSION_AUTHORITY_STALE"
  | "REPORT_ADMISSION_CONFLICT"
  | "REPORT_ADMISSION_PERSISTENCE_UNCERTAIN";

export class ResearchReportAdmissionError extends Error {
  public readonly code: ResearchReportAdmissionErrorCode;
  public readonly retryable: boolean;

  public constructor(code: ResearchReportAdmissionErrorCode, message: string, retryable = false, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "ResearchReportAdmissionError";
    this.code = code;
    this.retryable = retryable;
  }
}

export function fail(code: ResearchReportAdmissionErrorCode, message: string, retryable = false, cause?: unknown): never {
  throw new ResearchReportAdmissionError(code, message, retryable, cause);
}

export function text(value: unknown, label: string): string {
  const parsed = IdentifierSchema.safeParse(value);
  if (!parsed.success) fail("REPORT_ADMISSION_INPUT_INVALID", `${label} is invalid`);
  return parsed.data;
}

export function digest(value: unknown, label: string): string {
  if (typeof value !== "string" || !SHA256.test(value)) fail("REPORT_ADMISSION_INPUT_INVALID", `${label} is invalid`);
  return value;
}

export function positive(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) fail("REPORT_ADMISSION_INPUT_INVALID", `${label} is invalid`);
  return value as number;
}

export function iso(value: unknown, label: string): string {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value)) || new Date(Date.parse(value)).toISOString() !== value) {
    fail("REPORT_ADMISSION_INPUT_INVALID", `${label} is not canonical UTC time`);
  }
  return value;
}

export function sameJson(left: unknown, right: unknown): boolean {
  return canonicalEvidenceJson(left) === canonicalEvidenceJson(right);
}

export function snapshot<T>(value: T, label: string): T {
  try { return Object.freeze(JSON.parse(canonicalEvidenceJson(value)) as T); }
  catch (cause) { fail("REPORT_ADMISSION_INPUT_INVALID", `${label} is not canonical`, false, cause); }
}

export function readClock(clock: () => number): number {
  const value = clock();
  if (!Number.isSafeInteger(value) || value < 0) fail("REPORT_ADMISSION_INPUT_INVALID", "REPORT admission clock is invalid");
  return value;
}

export function validatePolicy(policy: ResearchReportAdmissionPolicy | null): ResearchReportAdmissionPolicy {
  if (policy === null) fail("REPORT_ADMISSION_POLICY_MISSING", "server REPORT policy is not installed");
  const validActor = policy.schema === RESEARCH_REPORT_ADMISSION_SCHEMA ? policy.client_class === "owner_pwa"
    : policy.schema === "eliotr.research.delegated-report-admission.v1" &&
      (policy.client_class === "trusted_agent" || policy.client_class === "named_api_client");
  if (!validActor ||
      policy.requested_output_class !== RESEARCH_REPORT_OUTPUT_CLASS || policy.purpose !== RESEARCH_REPORT_PURPOSE ||
      !Array.isArray(policy.allowed_use) || policy.allowed_use.length !== 1 || policy.allowed_use[0] !== "research") {
    fail("REPORT_ADMISSION_DENIED", "installed REPORT policy does not explicitly permit private research drafts");
  }
  text(policy.policy_ref, "policy_ref");
  positive(policy.policy_revision, "policy_revision");
  text(policy.config_provenance_ref, "config_provenance_ref");
  text(policy.principal_ref, "policy principal_ref");
  text(policy.policy_generation, "policy_generation");
  text(policy.policy_authority_ref, "policy_authority_ref");
  text(policy.disclosure_ceiling, "disclosure_ceiling");
  iso(policy.expires_at, "policy.expires_at");
  return snapshot(policy, "REPORT policy");
}
