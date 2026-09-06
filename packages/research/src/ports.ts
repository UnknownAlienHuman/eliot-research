import type {
  ClaimAuditItem,
  CompletionDisposition,
  CoverageReceipt,
  EvidenceFreeze,
  Investigation,
  InquiryProtocolProfile,
  ResearchWorkflowStage,
  VersionedRef,
} from "@eliotr/contracts";
import type { EvidencePack, RetrievalRequest, RetrievalResult } from "@eliotr/retrieval";
import { z } from "zod";

export interface InvestigationRepository {
  get(ref: VersionedRef): Promise<Investigation | null>;
  appendEvent(investigationId: string, expectedRevision: number, event: InvestigationEvent): Promise<VersionedRef>;
  checkpoint(investigationId: string, expectedRevision: number, stage: ResearchWorkflowStage, checkpointRef: string): Promise<VersionedRef>;
}

export interface InvestigationEvent {
  readonly event_id: string;
  readonly kind: string;
  readonly payload_ref: string;
  readonly created_at: string;
  readonly actor_ref: string;
}

export interface ResearchRetrievalPort {
  retrieve(request: RetrievalRequest): Promise<RetrievalResult>;
}

export interface ModelRoutePort {
  execute(input: ModelCallInput): Promise<ModelCallReceipt>;
}

export interface ModelCallInput {
  readonly route_ref: string;
  readonly prompt_generation: string;
  readonly schema_generation: string;
  readonly evidence_pack: EvidencePack;
  readonly output_object_ref: string;
  readonly max_input_bytes: number;
  readonly max_output_bytes: number;
  readonly budget_reservation_ref: string;
  readonly cancellation_ref?: string;
}

export interface ModelCallReceipt {
  readonly receipt_ref: string;
  readonly route_fingerprint_ref: string;
  readonly output_object_ref: string;
  readonly output_sha256: string;
  readonly input_tokens: number;
  readonly output_tokens: number;
  readonly billed_usd: number;
}

export interface ResearchArtifactStore {
  putImmutable(ref: string, body: ReadableStream<Uint8Array>, expectedSha256: string): Promise<{ object_ref: string; readback_sha256: string }>;
  read(ref: string): Promise<ReadableStream<Uint8Array> | null>;
}

export interface ResearchAuditPort {
  freeze(investigation: Investigation): Promise<EvidenceFreeze>;
  auditClaims(investigation: Investigation, freeze: EvidenceFreeze): Promise<readonly ClaimAuditItem[]>;
  calculateCoverage(investigation: Investigation): Promise<CoverageReceipt>;
}

export interface ResearchRunResult {
  readonly investigation_ref: VersionedRef;
  readonly artifact_refs: readonly VersionedRef[];
  readonly coverage_receipt_ref: VersionedRef;
  readonly completion_disposition: CompletionDisposition;
  readonly reopen_conditions: readonly string[];
}

export interface ProtocolRegistry {
  get(ref: VersionedRef): Promise<InquiryProtocolProfile | null>;
}

export type LedgerErrorCode =
  | "LEDGER_INPUT_INVALID"
  | "LEDGER_CONFLICT"
  | "LEDGER_STALE_HEAD"
  | "LEDGER_PRINCIPAL_DENIED"
  | "LEDGER_SCOPE_FOREIGN"
  | "LEDGER_POLICY_STALE"
  | "LEDGER_DEPLOYMENT_STALE"
  | "LEDGER_PURGE_STALE"
  | "LEDGER_VERIFIER_DENIED"
  | "LEDGER_SUPERSESSION_REQUIRED"
  | "LEDGER_HANDLE_MISSING"
  | "LEDGER_SETTLEMENT_UNCERTAIN";

export class LedgerError extends Error {
  readonly code: LedgerErrorCode;
  readonly retryable: boolean;
  constructor(code: LedgerErrorCode, message: string, retryable = false, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "LedgerError";
    this.code = code;
    this.retryable = retryable;
  }
}

export type LedgerStatus = "OPEN" | "CLOSED" | "SUPERSEDED";
export type LedgerEventKind =
  | "CREATED"
  | "LANE_REGISTERED"
  | "OBLIGATION_REGISTERED"
  | "OBLIGATION_ACCEPTED"
  | "CHECKPOINT"
  | "HYPOTHESIS_RECORDED"
  | "OBSERVED"
  | "DEVIATION"
  | "SUPERSEDED"
  | "CLOSED"
  | "REOPENED";

export interface LedgerObligation {
  readonly obligation_id: string;
  readonly verifier_ref: string;
  readonly lane: "confirmatory" | "exploratory";
  readonly metric_ref: string;
  readonly status: "REGISTERED" | "ACCEPTED" | "DEVIATED";
  readonly exposed: boolean;
}

export interface LedgerHead {
  readonly investigation_id: string;
  readonly revision: number;
  readonly protocol_version: string;
  readonly goal: string;
  readonly scope_snapshot_id: string;
  readonly scope_snapshot_revision: number;
  readonly evidence_grade: "E0" | "E1" | "E2" | "E3";
  readonly lane: "confirmatory" | "exploratory" | "mixed_with_declared_split";
  readonly lane_registrations: readonly string[];
  readonly obligations: readonly LedgerObligation[];
  readonly hypotheses: readonly string[];
  readonly portfolio_ref: string;
  readonly debt_refs: readonly string[];
  readonly checkpoint_head: number;
  readonly principal_ref: string;
  readonly input_digest: string;
  readonly policy_generation: string;
  readonly policy_authority_ref: string;
  readonly deployment_generation: string;
  readonly idempotency_key: string;
  readonly model_profile_ref: string;
  readonly observed_execution: string | null;
  readonly observed_fidelity: string | null;
  readonly observed_assurance: string | null;
  readonly status: LedgerStatus;
  readonly supersedes_id: string | null;
  readonly supersession_reason: string | null;
  readonly event_head: number;
  readonly created_at: string;
  readonly updated_at: string;
}

export interface LedgerEvent {
  readonly investigation_id: string;
  readonly sequence: number;
  readonly event_id: string;
  readonly kind: LedgerEventKind;
  readonly payload_handle_ref: string;
  readonly payload_digest: string;
  readonly actor_ref: string;
  readonly verifier_ref: string | null;
  readonly created_at: string;
}

export interface LedgerSnapshot {
  readonly head: LedgerHead;
  readonly events: readonly LedgerEvent[];
}

export interface LedgerAuthorityFence {
  readonly principal_ref: string;
  readonly scope_snapshot_id: string;
  readonly scope_snapshot_revision: number;
  readonly policy_generation: string;
  readonly deployment_generation: string;
  readonly purge_revision: number;
  readonly scope_purge_revision: number;
}

export interface InvestigationLedgerStore {
  create(head: LedgerHead, firstEvent: LedgerEvent): Promise<{ head: LedgerHead; disposition: "CREATED" | "EXISTING" }>;
  read(investigationId: string): Promise<LedgerSnapshot | null>;
  readByIdempotency(idempotencyKey: string): Promise<LedgerSnapshot | null>;
  append(head: LedgerHead, expectedRevision: number, event: LedgerEvent): Promise<LedgerHead>;
  supersede(oldHead: LedgerHead, oldEvent: LedgerEvent, expectedOldRevision: number, newHead: LedgerHead, newEvent: LedgerEvent): Promise<{ oldHead: LedgerHead; newHead: LedgerHead }>;
}

export const LedgerIdSchema = z.string().min(1).max(128);
export const LedgerRefSchema = z.string().min(1).max(256);
const LedgerGoalSchema = z.string().min(1).max(2000);
const LedgerHandleSchema = z.string().min(1).max(256);
const LedgerDigestSchema = z.string().regex(/^[a-f0-9]{64}$/);
const LedgerIsoSchema = z.string().datetime({ offset: true });
const LedgerGenerationSchema = z.string().min(1).max(256);
export const LedgerObligationSchema = z.object({
  obligation_id: LedgerIdSchema, verifier_ref: LedgerRefSchema,
  lane: z.enum(["confirmatory", "exploratory"]), metric_ref: LedgerRefSchema,
  status: z.enum(["REGISTERED", "ACCEPTED", "DEVIATED"]), exposed: z.boolean(),
}).strict();
export const LedgerHeadSchema = z.object({
  investigation_id: LedgerIdSchema, revision: z.number().int().min(1).max(1000000),
  protocol_version: z.literal("eliotr.investigation.v1"), goal: LedgerGoalSchema,
  scope_snapshot_id: LedgerRefSchema, scope_snapshot_revision: z.number().int().min(1).max(1000000),
  evidence_grade: z.enum(["E0", "E1", "E2", "E3"]),
  lane: z.enum(["confirmatory", "exploratory", "mixed_with_declared_split"]),
  lane_registrations: z.array(LedgerRefSchema).max(16),
  obligations: z.array(LedgerObligationSchema).max(32),
  hypotheses: z.array(z.string().min(1).max(1024)).max(32), portfolio_ref: LedgerHandleSchema,
  debt_refs: z.array(LedgerRefSchema).max(32), checkpoint_head: z.number().int().min(0).max(1000000),
  principal_ref: LedgerRefSchema, input_digest: LedgerDigestSchema,
  policy_generation: LedgerGenerationSchema, policy_authority_ref: LedgerRefSchema,
  deployment_generation: LedgerGenerationSchema, idempotency_key: LedgerRefSchema,
  model_profile_ref: LedgerRefSchema,
  observed_execution: z.string().min(1).max(1024).nullable(),
  observed_fidelity: z.string().min(1).max(1024).nullable(),
  observed_assurance: z.string().min(1).max(1024).nullable(),
  status: z.enum(["OPEN", "CLOSED", "SUPERSEDED"]),
  supersedes_id: z.string().min(1).max(128).nullable(),
  supersession_reason: z.string().min(1).max(1024).nullable(),
  event_head: z.number().int().min(0).max(1000000), created_at: LedgerIsoSchema, updated_at: LedgerIsoSchema,
}).strict();
export const LedgerEventSchema = z.object({
  investigation_id: LedgerIdSchema, sequence: z.number().int().min(1).max(1000000),
  event_id: LedgerIdSchema,
  kind: z.enum(["CREATED", "LANE_REGISTERED", "OBLIGATION_REGISTERED", "OBLIGATION_ACCEPTED", "CHECKPOINT", "HYPOTHESIS_RECORDED", "OBSERVED", "DEVIATION", "SUPERSEDED", "CLOSED", "REOPENED"]),
  payload_handle_ref: LedgerHandleSchema, payload_digest: LedgerDigestSchema,
  actor_ref: LedgerRefSchema, verifier_ref: LedgerRefSchema.nullable(), created_at: LedgerIsoSchema,
}).strict();
export const LEDGER_SQL = {
  selectByIdempotency: "SELECT * FROM investigation_ledger_head WHERE idempotency_key = ?1 LIMIT 1",
  selectHead: "SELECT * FROM investigation_ledger_head WHERE investigation_id = ?1 LIMIT 1",
  selectByEventId: "SELECT * FROM investigation_ledger_event WHERE event_id = ?1 LIMIT 1",
  selectEvents: "SELECT * FROM investigation_ledger_event WHERE investigation_id = ?1 ORDER BY sequence ASC",
  insertHead: "INSERT INTO investigation_ledger_head (investigation_id, revision, protocol_version, goal,scope_snapshot_id, scope_snapshot_revision, evidence_grade, lane, lane_registrations_json,obligations_json, hypotheses_json, portfolio_ref, debt_refs_json, checkpoint_head, principal_ref,input_digest, policy_generation, policy_authority_ref, deployment_generation, idempotency_key,model_profile_ref, observed_execution, observed_fidelity, observed_assurance, status,supersedes_id, supersession_reason, event_head, created_at, updated_at) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19,?20,?21,?22,?23,?24,?25,?26,?27,?28,?29,?30)",
  insertHeadIfEvent: "INSERT INTO investigation_ledger_head (investigation_id, revision, protocol_version, goal,scope_snapshot_id, scope_snapshot_revision, evidence_grade, lane, lane_registrations_json,obligations_json, hypotheses_json, portfolio_ref, debt_refs_json, checkpoint_head, principal_ref,input_digest, policy_generation, policy_authority_ref, deployment_generation, idempotency_key,model_profile_ref, observed_execution, observed_fidelity, observed_assurance, status,supersedes_id, supersession_reason, event_head, created_at, updated_at) SELECT ?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19,?20,?21,?22,?23,?24,?25,?26,?27,?28,?29,?30 WHERE EXISTS (SELECT 1 FROM investigation_ledger_event WHERE event_id = ?31)",
  insertSupersedeMarkEvent: "INSERT INTO investigation_ledger_event (investigation_id, sequence, event_id, kind,payload_handle_ref, payload_digest, actor_ref, verifier_ref, created_at) SELECT ?1,?2,?3,?4,?5,?6,?7,?8,?9 WHERE EXISTS (SELECT 1 FROM investigation_ledger_head WHERE investigation_id = ?1 AND revision = ?10 AND status = 'SUPERSEDED' AND supersession_reason = ?11)",
  insertEvent: "INSERT INTO investigation_ledger_event (investigation_id, sequence, event_id, kind,payload_handle_ref, payload_digest, actor_ref, verifier_ref, created_at) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9)",
  insertEventIfRevision: "INSERT INTO investigation_ledger_event (investigation_id, sequence, event_id, kind,payload_handle_ref, payload_digest, actor_ref, verifier_ref, created_at) SELECT ?1,?2,?3,?4,?5,?6,?7,?8,?9 WHERE EXISTS (SELECT 1 FROM investigation_ledger_head WHERE investigation_id = ?1 AND revision = ?10)",
  casHead: "UPDATE investigation_ledger_head SET revision = ?3, lane_registrations_json = ?4,obligations_json = ?5, hypotheses_json = ?6, portfolio_ref = ?7, debt_refs_json = ?8,checkpoint_head = ?9, observed_execution = ?10, observed_fidelity = ?11, observed_assurance = ?12,status = ?13, supersedes_id = ?14, supersession_reason = ?15, event_head = ?16, updated_at = ?17 WHERE investigation_id = ?1 AND revision = ?2 AND principal_ref = ?18 AND scope_snapshot_id = ?19 AND scope_snapshot_revision = ?20 AND policy_generation = ?21 AND deployment_generation = ?22",
} as const;
export function sameLedgerFence(left: LedgerAuthorityFence, right: LedgerAuthorityFence): boolean {
  return left.principal_ref === right.principal_ref && left.scope_snapshot_id === right.scope_snapshot_id &&
    left.scope_snapshot_revision === right.scope_snapshot_revision && left.policy_generation === right.policy_generation &&
    left.deployment_generation === right.deployment_generation && left.purge_revision === right.purge_revision &&
    left.scope_purge_revision === right.scope_purge_revision;
}
export function ledgerFenceDriftCode(pre: LedgerAuthorityFence, post: LedgerAuthorityFence): LedgerErrorCode {
  if (post.principal_ref !== pre.principal_ref) return "LEDGER_PRINCIPAL_DENIED";
  if (post.scope_snapshot_id !== pre.scope_snapshot_id || post.scope_snapshot_revision !== pre.scope_snapshot_revision) return "LEDGER_SCOPE_FOREIGN";
  if (post.policy_generation !== pre.policy_generation) return "LEDGER_POLICY_STALE";
  if (post.deployment_generation !== pre.deployment_generation) return "LEDGER_DEPLOYMENT_STALE";
  return "LEDGER_PURGE_STALE";
}
