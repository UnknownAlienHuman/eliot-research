import type { VersionedRef } from "@eliotr/contracts";
import { WorkflowObjectSchema, type WorkflowObject } from "./types.js";

export interface ResearchWorkflowRunParams<QualificationRenewalMarker extends string = string> {
  readonly workflow_kind?: "RESEARCH";
  readonly operation_id: string;
  readonly investigation_ref: VersionedRef;
  readonly idempotency_key: string;
  readonly handler_generation: string;
  readonly initial_input_manifest: WorkflowObject;
  readonly principal_ref: string;
  readonly credential_generation: string;
  readonly deployment_generation: string;
  readonly requested_by_principal_ref?: string;
  readonly qualification_renewal?: QualificationRenewalMarker;
}

export interface ResearchWorkflowExhaustiveParams<ExhaustiveRequest> {
  readonly workflow_kind: "EXHAUSTIVE_QUERY";
  readonly operation_id: string;
  readonly idempotency_key: string;
  readonly principal_ref: string;
  readonly credential_generation: string;
  readonly deployment_generation: string;
  readonly exhaustive_request: ExhaustiveRequest;
}

export type ResearchWorkflowParams<
  ExhaustiveRequest,
  QualificationRenewalMarker extends string = string,
> = ResearchWorkflowRunParams<QualificationRenewalMarker> | ResearchWorkflowExhaustiveParams<ExhaustiveRequest>;

type DeclaredResearchWorkflowKind =
  | NonNullable<ResearchWorkflowRunParams["workflow_kind"]>
  | ResearchWorkflowExhaustiveParams<unknown>["workflow_kind"];

/** A persisted envelope may omit the discriminant or carry one of the two declared literals. */
function isDeclaredWorkflowKind(value: unknown): value is DeclaredResearchWorkflowKind {
  return value === "RESEARCH" || value === "EXHAUSTIVE_QUERY";
}

function failWorkflow(code: "WORKFLOW_INPUT_INVALID" | "WORKFLOW_CONFLICT"): never {
  const error = new Error(code) as Error & { code: string };
  error.code = code;
  throw error;
}

/** Parse the shared Workflow envelope while Core supplies application-owned payload parsing and marker identity. */
export function parseResearchWorkflowParams<
  ExhaustiveRequest,
  QualificationRenewalMarker extends string,
>(raw: unknown, options: Readonly<{
  parse_exhaustive_request: (value: unknown) => ExhaustiveRequest;
  qualification_renewal_marker: QualificationRenewalMarker;
}>): ResearchWorkflowParams<ExhaustiveRequest, QualificationRenewalMarker> {
  if (typeof raw !== "object" || raw === null) failWorkflow("WORKFLOW_INPUT_INVALID");
  const value = raw as Record<string, unknown>;
  if (value.workflow_kind !== undefined && !isDeclaredWorkflowKind(value.workflow_kind)) {
    failWorkflow("WORKFLOW_INPUT_INVALID");
  }
  if (value.workflow_kind === "EXHAUSTIVE_QUERY") {
    const allowed = new Set(["workflow_kind", "operation_id", "idempotency_key", "principal_ref",
      "credential_generation", "deployment_generation", "exhaustive_request"]);
    if (Object.keys(value).some((key) => !allowed.has(key)) || Object.keys(value).length !== allowed.size) {
      failWorkflow("WORKFLOW_INPUT_INVALID");
    }
    const operation_id = value.operation_id;
    const idempotency_key = value.idempotency_key;
    const principal_ref = value.principal_ref;
    const credential_generation = value.credential_generation;
    const deployment_generation = value.deployment_generation;
    if (typeof operation_id !== "string" || operation_id.length < 1 || operation_id.length > 128 ||
        typeof idempotency_key !== "string" || idempotency_key.length < 1 || idempotency_key.length > 256 ||
        typeof principal_ref !== "string" || principal_ref.length < 1 ||
        typeof credential_generation !== "string" || credential_generation.length < 1 ||
        typeof deployment_generation !== "string" || deployment_generation.length < 1) {
      failWorkflow("WORKFLOW_INPUT_INVALID");
    }
    const exhaustive_request = options.parse_exhaustive_request(value.exhaustive_request);
    return { workflow_kind: "EXHAUSTIVE_QUERY", operation_id, idempotency_key, principal_ref,
      credential_generation, deployment_generation, exhaustive_request };
  }
  const operation_id = value.operation_id;
  const investigation_ref = value.investigation_ref as VersionedRef | undefined;
  const idempotency_key = value.idempotency_key;
  const handler_generation = value.handler_generation;
  const initial_input_manifest = value.initial_input_manifest;
  const principal_ref = value.principal_ref ?? value.requested_by_principal_ref;
  const credential_generation = value.credential_generation;
  const deployment_generation = value.deployment_generation;
  if (typeof operation_id !== "string" || operation_id.length < 1 || operation_id.length > 128) {
    failWorkflow("WORKFLOW_INPUT_INVALID");
  }
  if (typeof investigation_ref !== "object" || investigation_ref === null ||
      typeof (investigation_ref as VersionedRef).id !== "string" ||
      !Number.isSafeInteger((investigation_ref as VersionedRef).revision)) failWorkflow("WORKFLOW_INPUT_INVALID");
  if (typeof idempotency_key !== "string" || idempotency_key.length < 1 || idempotency_key.length > 256) {
    failWorkflow("WORKFLOW_INPUT_INVALID");
  }
  if (typeof handler_generation !== "string" || handler_generation.length < 1) failWorkflow("WORKFLOW_INPUT_INVALID");
  if (typeof principal_ref !== "string" || principal_ref.length < 1) failWorkflow("WORKFLOW_INPUT_INVALID");
  if (typeof credential_generation !== "string" || credential_generation.length < 1) failWorkflow("WORKFLOW_INPUT_INVALID");
  if (typeof deployment_generation !== "string" || deployment_generation.length < 1) failWorkflow("WORKFLOW_INPUT_INVALID");
  const manifest = WorkflowObjectSchema.safeParse(initial_input_manifest);
  if (!manifest.success) failWorkflow("WORKFLOW_INPUT_INVALID");
  const requested = value.requested_by_principal_ref;
  if (requested !== undefined && requested !== principal_ref) failWorkflow("WORKFLOW_CONFLICT");
  const qualificationRenewal = value.qualification_renewal;
  if (qualificationRenewal !== undefined && qualificationRenewal !== options.qualification_renewal_marker) {
    failWorkflow("WORKFLOW_INPUT_INVALID");
  }
  const allowed = new Set(["workflow_kind", "operation_id", "investigation_ref", "idempotency_key", "handler_generation",
    "initial_input_manifest", "principal_ref", "credential_generation", "deployment_generation", "requested_by_principal_ref",
    "qualification_renewal"]);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) failWorkflow("WORKFLOW_INPUT_INVALID");
  }
  const parsedInvestigationRef = investigation_ref as VersionedRef;
  return {
    operation_id,
    investigation_ref: { ...parsedInvestigationRef },
    idempotency_key,
    handler_generation,
    initial_input_manifest: manifest.data as WorkflowObject,
    principal_ref,
    credential_generation,
    deployment_generation,
    ...(value.requested_by_principal_ref === undefined
      ? {}
      : { requested_by_principal_ref: value.requested_by_principal_ref as string }),
    ...(qualificationRenewal === undefined ? {} : { qualification_renewal: qualificationRenewal as QualificationRenewalMarker }),
  };
}
