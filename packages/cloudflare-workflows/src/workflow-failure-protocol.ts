import { z } from "zod";
import { ResearchWorkflowStageSchema } from "@eliotr/contracts";

/** Closed transport vocabulary. Never serialize messages, stacks or nested causes. */
export const WORKFLOW_FAILURE_CODES = [
  "WORKFLOW_INPUT_INVALID",
  "WORKFLOW_CONFLICT",
  "WORKFLOW_AUTHORITY_STALE",
  "WORKFLOW_STAGE_OUT_OF_ORDER",
  "WORKFLOW_CANCELLED",
  "WORKFLOW_BUDGET_STOP",
  "WORKFLOW_EFFECT_UNCERTAIN",
  "WORKFLOW_OUTPUT_UNAVAILABLE",
  "WORKFLOW_OUTPUT_CORRUPT",
  "WORKFLOW_CONFIGURATION_MISSING",
  "WORKFLOW_CONFIGURATION_INVALID",
  "WORKFLOW_CREDENTIALS_MISSING",
  "WORKFLOW_CREDENTIALS_INVALID",
  "WORKFLOW_STORAGE_UNAVAILABLE",
  "WORKFLOW_QUALIFICATION_STALE",
  "WORKFLOW_PREPARATION_FAILED",
  "RESEARCH_QUALIFICATION_RENEWAL_READ_TOKEN_REQUIRED",
  "RESEARCH_QUALIFICATION_RENEWAL_AUTHORITY_STALE",
  "RESEARCH_QUALIFICATION_RENEWAL_UNAVAILABLE",
  "RESEARCH_QUALIFICATION_RENEWAL_ROUTE_UNAVAILABLE",
  "MODEL_ATTEMPT_INPUT_INVALID",
  "MODEL_ATTEMPT_AUTHORITY_STALE",
  "MODEL_ATTEMPT_IDENTITY_CONFLICT",
  "MODEL_ATTEMPT_BUDGET_EXPIRED",
  "MODEL_ATTEMPT_CONFLICT",
  "MODEL_ATTEMPT_SETTLEMENT_UNCERTAIN",
  "MODEL_ATTEMPT_READBACK_CORRUPT",
  "MODEL_GATEWAY_DEPLOYMENT_MISSING",
  "MODEL_GATEWAY_PROMPT_COMPILE_FAILED",
  "MODEL_GATEWAY_REQUEST_INVALID",
  "MODEL_GATEWAY_CREDENTIAL_INVALID",
  "MODEL_GATEWAY_TRANSPORT_FAILED",
  "MODEL_GATEWAY_AUTH_REJECTED",
  "MODEL_GATEWAY_LIMIT_REJECTED",
  "MODEL_GATEWAY_POLICY_REJECTED",
  "MODEL_GATEWAY_UPSTREAM_REJECTED",
  "MODEL_GATEWAY_RESPONSE_INVALID",
  "MODEL_GATEWAY_OUTPUT_TRUNCATED",
  "MODEL_GATEWAY_OUTPUT_PERSIST_FAILED",
  "MODEL_GATEWAY_FINGERPRINT_PERSIST_FAILED",
  "MODEL_GATEWAY_PRICING_FAILED",
  "MODEL_PROFILE_BINDING_INPUT_INVALID",
  "MODEL_PROFILE_BINDING_CONFIG_MISSING",
  "MODEL_PROFILE_BINDING_CONFIG_INVALID",
  "MODEL_PROFILE_BINDING_AUTHORITY_STALE",
  "MODEL_PROFILE_BINDING_DEPLOYMENT_MISSING",
  "MODEL_PROFILE_BINDING_DEPLOYMENT_MISMATCH",
  "MODEL_PROFILE_BINDING_EXPIRED",
  "REFERENCE_MANIFEST_INPUT_INVALID",
  "REFERENCE_MANIFEST_SCOPE_STALE",
  "REFERENCE_MANIFEST_EVIDENCE_INVALID",
  "REFERENCE_MANIFEST_POLICY_INVALID",
  "REFERENCE_MANIFEST_PERSISTENCE_UNCERTAIN",
  "EVIDENCE_INPUT_INVALID",
  "EVIDENCE_SCOPE_NOT_FOUND",
  "EVIDENCE_SCOPE_INVALIDATED",
  "EVIDENCE_SCOPE_EXPIRED",
  "EVIDENCE_AUTHORIZATION_DENIED",
  "EVIDENCE_SOURCE_NOT_FOUND",
  "EVIDENCE_SOURCE_NOT_LIVE",
  "EVIDENCE_OWNER_GENERATION_MISMATCH",
  "EVIDENCE_SCOPE_MISMATCH",
  "EVIDENCE_LOCATOR_NOT_RESOLVABLE",
  "EVIDENCE_PRECISION_UNSUPPORTED",
  "EVIDENCE_OBJECT_NOT_FOUND",
  "EVIDENCE_OBJECT_INTEGRITY",
  "EVIDENCE_RANGE_INVALID",
  "EVIDENCE_HANDLE_NOT_FOUND",
  "EVIDENCE_HANDLE_NOT_LIVE",
  "EVIDENCE_IDENTITY_CONFLICT",
  "EVIDENCE_SETTLEMENT_UNCERTAIN",
  "CITATION_SET_INVALID",
  "EVIDENCE_FREEZE_INPUT_INVALID",
  "EVIDENCE_FREEZE_SCOPE_STALE",
  "EVIDENCE_FREEZE_EVIDENCE_INVALID",
  "EVIDENCE_FREEZE_AUTHORITY_INVALID",
  "EVIDENCE_FREEZE_SETTLEMENT_UNCERTAIN",
] as const;

export const WorkflowFailureSchema = z.object({
  code: z.enum(WORKFLOW_FAILURE_CODES),
  phase: z.enum(["PREPARATION", "STAGE", "RECOVERY"]),
  stage: ResearchWorkflowStageSchema.optional(),
  retryable: z.boolean(),
}).strict().refine((value) => value.phase === "PREPARATION" ? value.stage === undefined : value.stage !== undefined)
  .refine((value) => !value.retryable || (value.phase === "PREPARATION" && value.code === "WORKFLOW_STORAGE_UNAVAILABLE"));
export type WorkflowFailure = z.infer<typeof WorkflowFailureSchema>;

/** Existing Eliot dispatch-state vocabulary, kept independent from retryability. */
export const WorkflowFailureDispatchStateSchema = z.enum([
  "NOT_STARTED",
  "OUTCOME_UNKNOWN",
  "RESPONSE_RECEIVED",
]);
export type WorkflowFailureDispatchState = z.infer<typeof WorkflowFailureDispatchStateSchema>;

export const WorkflowFailureReferencesIntactSchema = z.enum(["INTACT", "UNKNOWN"]);
export type WorkflowFailureReferencesIntact = z.infer<typeof WorkflowFailureReferencesIntactSchema>;

export const WorkflowFailureRecoveryActionSchema = z.enum(["NONE", "READBACK", "RECONCILE"]);
export type WorkflowFailureRecoveryAction = z.infer<typeof WorkflowFailureRecoveryActionSchema>;

/** Versioned safe diagnostic; retryable is a hint, never permission to repeat an unknown effect. */
export const WorkflowFailureOutcomeSchema = z.object({
  protocol: z.literal("eliotr.workflow-failure-outcome.v1"),
  code: z.enum(WORKFLOW_FAILURE_CODES),
  phase: z.enum(["PREPARATION", "STAGE", "RECOVERY"]),
  stage: ResearchWorkflowStageSchema.optional(),
  retryable: z.boolean(),
  dispatch_state: WorkflowFailureDispatchStateSchema,
  references_intact: WorkflowFailureReferencesIntactSchema,
  recovery_action: WorkflowFailureRecoveryActionSchema,
}).strict().refine((value) => value.phase === "PREPARATION" ? value.stage === undefined : value.stage !== undefined)
  .refine((value) => value.dispatch_state !== "OUTCOME_UNKNOWN" || (
    value.references_intact === "UNKNOWN" && value.recovery_action !== "NONE"
  ));
export type WorkflowFailureOutcome = z.infer<typeof WorkflowFailureOutcomeSchema>;

/** Persisted append-only first-cause plus consequence history; null represents a legacy empty row. */
export const WorkflowFailureHistorySchema = z.object({
  protocol: z.literal("eliotr.workflow-failure-history.v1"),
  first_cause: WorkflowFailureOutcomeSchema.nullable(),
  consequences: z.array(WorkflowFailureOutcomeSchema).max(16),
}).strict().refine((value) => value.first_cause !== null || value.consequences.length === 0);
type WorkflowFailureHistoryValue = z.infer<typeof WorkflowFailureHistorySchema>;
export type WorkflowFailureHistory = Readonly<Omit<WorkflowFailureHistoryValue, "consequences">> & {
  readonly consequences: readonly WorkflowFailureOutcome[];
};

/** Read old persisted/native V1 failures and the versioned outcome form without rewriting V1 bytes. */
export const WorkflowFailureCompatibleSchema = z.union([
  WorkflowFailureSchema,
  WorkflowFailureOutcomeSchema,
]);
export type WorkflowFailureCompatible = z.infer<typeof WorkflowFailureCompatibleSchema>;
