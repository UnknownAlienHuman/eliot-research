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
export const LEDGER_SCHEMA_SQL = [
  "CREATE TABLE IF NOT EXISTS investigation_ledger_head (investigation_id TEXT PRIMARY KEY CHECK(length(investigation_id) BETWEEN 1 AND 128),revision INTEGER NOT NULL CHECK(revision BETWEEN 1 AND 1000000),protocol_version TEXT NOT NULL CHECK(protocol_version='eliotr.investigation.v1'),goal TEXT NOT NULL CHECK(length(goal) BETWEEN 1 AND 2000),scope_snapshot_id TEXT NOT NULL CHECK(length(scope_snapshot_id) BETWEEN 1 AND 256),scope_snapshot_revision INTEGER NOT NULL CHECK(scope_snapshot_revision BETWEEN 1 AND 1000000),evidence_grade TEXT NOT NULL CHECK(evidence_grade IN ('E0','E1','E2','E3')),lane TEXT NOT NULL CHECK(lane IN ('confirmatory','exploratory','mixed_with_declared_split')),lane_registrations_json TEXT NOT NULL CHECK(json_valid(lane_registrations_json) AND length(lane_registrations_json)<=8192),obligations_json TEXT NOT NULL CHECK(json_valid(obligations_json) AND length(obligations_json)<=16384),hypotheses_json TEXT NOT NULL CHECK(json_valid(hypotheses_json) AND length(hypotheses_json)<=16384),portfolio_ref TEXT NOT NULL CHECK(length(portfolio_ref) BETWEEN 1 AND 256),debt_refs_json TEXT NOT NULL CHECK(json_valid(debt_refs_json) AND length(debt_refs_json)<=8192),checkpoint_head INTEGER NOT NULL CHECK(checkpoint_head BETWEEN 0 AND 1000000),principal_ref TEXT NOT NULL CHECK(length(principal_ref) BETWEEN 1 AND 256),input_digest TEXT NOT NULL CHECK(length(input_digest)=64 AND input_digest NOT GLOB '*[^0-9a-f]*'),policy_generation TEXT NOT NULL CHECK(length(policy_generation) BETWEEN 1 AND 256),policy_authority_ref TEXT NOT NULL CHECK(length(policy_authority_ref) BETWEEN 1 AND 256),deployment_generation TEXT NOT NULL CHECK(length(deployment_generation) BETWEEN 1 AND 256),idempotency_key TEXT NOT NULL UNIQUE CHECK(length(idempotency_key) BETWEEN 1 AND 256),model_profile_ref TEXT NOT NULL CHECK(length(model_profile_ref) BETWEEN 1 AND 256),observed_execution TEXT CHECK(observed_execution IS NULL OR length(observed_execution) BETWEEN 1 AND 1024),observed_fidelity TEXT CHECK(observed_fidelity IS NULL OR length(observed_fidelity) BETWEEN 1 AND 1024),observed_assurance TEXT CHECK(observed_assurance IS NULL OR length(observed_assurance) BETWEEN 1 AND 1024),status TEXT NOT NULL CHECK(status IN ('OPEN','CLOSED','SUPERSEDED')),supersedes_id TEXT CHECK(supersedes_id IS NULL OR length(supersedes_id) BETWEEN 1 AND 128),supersession_reason TEXT CHECK(supersession_reason IS NULL OR length(supersession_reason) BETWEEN 1 AND 1024),event_head INTEGER NOT NULL CHECK(event_head BETWEEN 0 AND 1000000),created_at TEXT NOT NULL,updated_at TEXT NOT NULL) STRICT",
  "CREATE TABLE IF NOT EXISTS investigation_ledger_event (investigation_id TEXT NOT NULL CHECK(length(investigation_id) BETWEEN 1 AND 128),sequence INTEGER NOT NULL CHECK(sequence BETWEEN 1 AND 1000000),event_id TEXT NOT NULL UNIQUE CHECK(length(event_id) BETWEEN 1 AND 128),kind TEXT NOT NULL CHECK(kind IN ('CREATED','LANE_REGISTERED','OBLIGATION_REGISTERED','OBLIGATION_ACCEPTED','CHECKPOINT','HYPOTHESIS_RECORDED','OBSERVED','DEVIATION','SUPERSEDED','CLOSED','REOPENED')),payload_handle_ref TEXT NOT NULL CHECK(length(payload_handle_ref) BETWEEN 1 AND 256),payload_digest TEXT NOT NULL CHECK(length(payload_digest)=64 AND payload_digest NOT GLOB '*[^0-9a-f]*'),actor_ref TEXT NOT NULL CHECK(length(actor_ref) BETWEEN 1 AND 256),verifier_ref TEXT CHECK(verifier_ref IS NULL OR length(verifier_ref) BETWEEN 1 AND 256),created_at TEXT NOT NULL,PRIMARY KEY(investigation_id, sequence)) STRICT",
  "CREATE TRIGGER IF NOT EXISTS investigation_ledger_event_no_update BEFORE UPDATE ON investigation_ledger_event BEGIN SELECT RAISE(ABORT,'ledger events are append-only'); END",
  "CREATE TRIGGER IF NOT EXISTS investigation_ledger_event_no_delete BEFORE DELETE ON investigation_ledger_event BEGIN SELECT RAISE(ABORT,'ledger events are append-only'); END",
  "CREATE TRIGGER IF NOT EXISTS investigation_ledger_grade_protocol_frozen BEFORE UPDATE ON investigation_ledger_head WHEN OLD.evidence_grade IS NOT NEW.evidence_grade OR OLD.protocol_version IS NOT NEW.protocol_version BEGIN SELECT RAISE(ABORT,'protocol/grade change requires explicit supersession'); END",
] as const;
export const LEDGER_SQL = {
  selectByIdempotency: "SELECT * FROM investigation_ledger_head WHERE idempotency_key = ?1 LIMIT 1",
  selectHead: "SELECT * FROM investigation_ledger_head WHERE investigation_id = ?1 LIMIT 1",
  selectByEventId: "SELECT * FROM investigation_ledger_event WHERE event_id = ?1 LIMIT 1",
  selectEvents: "SELECT * FROM investigation_ledger_event WHERE investigation_id = ?1 ORDER BY sequence ASC",
  insertHead: "INSERT INTO investigation_ledger_head (investigation_id, revision, protocol_version, goal,scope_snapshot_id, scope_snapshot_revision, evidence_grade, lane, lane_registrations_json,obligations_json, hypotheses_json, portfolio_ref, debt_refs_json, checkpoint_head, principal_ref,input_digest, policy_generation, policy_authority_ref, deployment_generation, idempotency_key,model_profile_ref, observed_execution, observed_fidelity, observed_assurance, status,supersedes_id, supersession_reason, event_head, created_at, updated_at) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19,?20,?21,?22,?23,?24,?25,?26,?27,?28,?29,?30)",
  insertEvent: "INSERT INTO investigation_ledger_event (investigation_id, sequence, event_id, kind,payload_handle_ref, payload_digest, actor_ref, verifier_ref, created_at) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9)",
  casHead: "UPDATE investigation_ledger_head SET revision = ?3, lane_registrations_json = ?4,obligations_json = ?5, hypotheses_json = ?6, portfolio_ref = ?7, debt_refs_json = ?8,checkpoint_head = ?9, observed_execution = ?10, observed_fidelity = ?11, observed_assurance = ?12,status = ?13, supersedes_id = ?14, supersession_reason = ?15, event_head = ?16, updated_at = ?17 WHERE investigation_id = ?1 AND revision = ?2",
} as const;
