import { z } from "zod";
import { OperationIntentSchema, PolicyDecisionSchema, VersionedRefSchema, type OperationIntent, type VersionedRef } from "@eliotr/contracts";

export const ARTIFACT_SECTION_REVISE_PROTOCOL = "eliotr.artifact.section.revise.v1" as const;
export const ARTIFACT_SECTION_REVISE_HTTP_PROTOCOL = "eliotr.artifact-section-revise.v1" as const;

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9:._/@-]{0,255}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const IDEMPOTENCY_KEY = z.string().min(1).max(256).refine((value) => !/[\u0000-\u0020\u007f]/u.test(value));

export const ArtifactSectionReportAdmissionWitnessSchema = z.object({
  protocol: z.literal("eliotr.artifact-section-report-admission.v1"),
  request: z.object({
    protocol: z.literal(ARTIFACT_SECTION_REVISE_HTTP_PROTOCOL),
    artifact_ref: VersionedRefSchema,
    section_id: z.string().regex(IDENTIFIER),
    expected_artifact_revision: z.number().int().positive(),
    idempotency_key: IDEMPOTENCY_KEY,
  }).strict(),
  policy: z.record(z.string(), z.unknown()),
  spend_policy: z.record(z.string(), z.unknown()),
  authorization: z.record(z.string(), z.unknown()),
  source_bindings: z.array(z.record(z.string(), z.unknown())),
  material: z.record(z.string(), z.unknown()),
  decision: PolicyDecisionSchema,
  decision_sha256: z.string().regex(SHA256),
  input_sha256: z.string().regex(SHA256),
}).strict();
export type ArtifactSectionReportAdmissionWitness = z.infer<typeof ArtifactSectionReportAdmissionWitnessSchema>;

export const ArtifactSectionReviseRequestSchema = z.object({
  protocol: z.literal(ARTIFACT_SECTION_REVISE_PROTOCOL),
  operation_id: z.string().regex(IDENTIFIER),
  report_intent_ref: VersionedRefSchema,
  report_admission_witness: ArtifactSectionReportAdmissionWitnessSchema,
  artifact_ref: VersionedRefSchema,
  section_id: z.string().regex(IDENTIFIER),
  spec_digest: z.string().regex(SHA256),
  evidence_freeze_ref: VersionedRefSchema,
  scope_snapshot_ref: VersionedRefSchema,
  idempotency_key: IDEMPOTENCY_KEY,
  handler_generation: z.string().regex(IDENTIFIER),
}).strict();
export type ArtifactSectionReviseRequest = z.infer<typeof ArtifactSectionReviseRequestSchema>;

export const ArtifactSectionReviseAuthoritySchema = z.object({
  principal_ref: z.string().regex(IDENTIFIER),
  credential_generation: z.string().regex(IDENTIFIER),
  deployment_generation: z.string().regex(IDENTIFIER),
  policy_generation: z.string().regex(IDENTIFIER),
  policy_authority_ref: z.string().regex(IDENTIFIER),
  authorization_receipt_ref: z.string().regex(IDENTIFIER),
  purge_revision: z.number().int().nonnegative(),
}).strict();
export type ArtifactSectionReviseAuthority = z.infer<typeof ArtifactSectionReviseAuthoritySchema>;

export interface ArtifactSectionReviseBudgetGrant {
  readonly receipt_ref: string;
  readonly expires_at_ms: number;
  readonly max_total_usd: number;
}

export interface ArtifactSectionReviseOutput {
  readonly output_object_ref: string;
  readonly output_sha256: string;
  readonly output_size_bytes: number;
  readonly readback_sha256: string;
}

export interface ArtifactSectionReviseDraftReceipt {
  readonly artifact_ref: VersionedRef;
  readonly manifest_sha256: string;
}

export type ArtifactSectionReviseAttemptState = "STARTED" | "OUTPUT_RECORDED" | "COMMITTED" | "UNKNOWN" | "CANCELLED";

export interface ArtifactSectionReviseAttempt {
  readonly request: ArtifactSectionReviseRequest;
  readonly request_json: string;
  readonly request_sha256: string;
  readonly authority: ArtifactSectionReviseAuthority;
  readonly budget: ArtifactSectionReviseBudgetGrant;
  readonly attempt_ref: string;
  readonly state: ArtifactSectionReviseAttemptState;
  readonly output?: ArtifactSectionReviseOutput;
  readonly draft?: ArtifactSectionReviseDraftReceipt;
}

export type ArtifactSectionReviseWorkflowErrorCode =
  | "ARTIFACT_COW_WORKFLOW_INPUT_INVALID"
  | "ARTIFACT_COW_WORKFLOW_AUTHORITY_STALE"
  | "ARTIFACT_COW_WORKFLOW_CONFLICT"
  | "ARTIFACT_COW_WORKFLOW_OUTPUT_CORRUPT";

export class ArtifactSectionReviseWorkflowError extends Error {
  public readonly code: ArtifactSectionReviseWorkflowErrorCode;

  public constructor(code: ArtifactSectionReviseWorkflowErrorCode, message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "ArtifactSectionReviseWorkflowError";
    this.code = code;
  }
}

interface RunRow {
  readonly operation_id: unknown;
  readonly report_intent_id: unknown;
  readonly report_intent_revision: unknown;
  readonly artifact_id: unknown;
  readonly parent_revision: unknown;
  readonly section_contract_id: unknown;
  readonly principal_ref: unknown;
  readonly credential_generation: unknown;
  readonly deployment_generation: unknown;
  readonly policy_generation: unknown;
  readonly policy_authority_ref: unknown;
  readonly authorization_receipt_ref: unknown;
  readonly scope_snapshot_id: unknown;
  readonly scope_snapshot_revision: unknown;
  readonly purge_revision: unknown;
  readonly request_json: unknown;
  readonly request_sha256: unknown;
  readonly handler_generation: unknown;
  readonly run_revision: unknown;
  readonly state: unknown;
  readonly current_attempt_ref: unknown;
}

interface AttemptRow {
  readonly operation_id: unknown;
  readonly attempt_ref: unknown;
  readonly request_json: unknown;
  readonly request_sha256: unknown;
  readonly budget_receipt_ref: unknown;
  readonly budget_expires_at_ms: unknown;
  readonly budget_max_total_usd: unknown;
  readonly state: unknown;
  readonly output_json: unknown;
  readonly expected_run_revision: unknown;
}

function fail(code: ArtifactSectionReviseWorkflowErrorCode, message: string, cause?: unknown): never {
  throw new ArtifactSectionReviseWorkflowError(code, message, cause);
}

function sameRef(left: VersionedRef, right: VersionedRef): boolean {
  return left.id === right.id && left.revision === right.revision;
}

function canonicalRequest(value: ArtifactSectionReviseRequest): string {
  return canonicalJson({
    protocol: value.protocol,
    operation_id: value.operation_id,
    report_intent_ref: { id: value.report_intent_ref.id, revision: value.report_intent_ref.revision },
    report_admission_witness: value.report_admission_witness,
    artifact_ref: { id: value.artifact_ref.id, revision: value.artifact_ref.revision },
    section_id: value.section_id,
    spec_digest: value.spec_digest,
    evidence_freeze_ref: { id: value.evidence_freeze_ref.id, revision: value.evidence_freeze_ref.revision },
    scope_snapshot_ref: { id: value.scope_snapshot_ref.id, revision: value.scope_snapshot_ref.revision },
    idempotency_key: value.idempotency_key,
    handler_generation: value.handler_generation,
  });
}

async function digest(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text);
  const owned = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(owned).set(bytes);
  const hash = await crypto.subtle.digest("SHA-256", owned);
  return [...new Uint8Array(hash)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) fail("ARTIFACT_COW_WORKFLOW_INPUT_INVALID", "canonical COW JSON contains a non-finite number");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).filter((key) => record[key] !== undefined).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
  }
  fail("ARTIFACT_COW_WORKFLOW_INPUT_INVALID", "canonical COW JSON contains an unsupported value");
}

async function verifyAdmissionWitness(request: ArtifactSectionReviseRequest): Promise<void> {
  const witness = request.report_admission_witness;
  const inputDigest = await digest(canonicalJson(witness.material));
  const decisionDigest = await digest(canonicalJson(witness.decision));
  if (inputDigest !== witness.input_sha256 || decisionDigest !== witness.decision_sha256 ||
      canonicalJson(witness.material.request) !== canonicalJson(witness.request) ||
      canonicalJson(witness.material.source_bindings) !== canonicalJson(witness.source_bindings) ||
      canonicalJson(witness.material.policy) !== canonicalJson(witness.policy) ||
      canonicalJson(witness.material.spend_policy) !== canonicalJson(witness.spend_policy) ||
      canonicalJson(witness.material.authorization) !== canonicalJson(witness.authorization) ||
      witness.decision.decision_id !== `artifact-cow-report-decision-${inputDigest}`) {
    fail("ARTIFACT_COW_WORKFLOW_AUTHORITY_STALE", "persisted REPORT admission witness digest is invalid");
  }
}

function decodeAttempt(run: RunRow, attempt: AttemptRow): ArtifactSectionReviseAttempt {
  let request: ArtifactSectionReviseRequest;
  let authority: ArtifactSectionReviseAuthority;
  let output: ArtifactSectionReviseOutput | undefined;
  let draft: ArtifactSectionReviseDraftReceipt | undefined;
  let attemptRequest: { readonly request: ArtifactSectionReviseRequest; readonly attempt_ref: string } | undefined;
  let requestValue: unknown;
  try {
    requestValue = JSON.parse(String(run.request_json)) as unknown;
    request = ArtifactSectionReviseRequestSchema.parse(requestValue);
    authority = ArtifactSectionReviseAuthoritySchema.parse({
      principal_ref: run.principal_ref,
      credential_generation: run.credential_generation,
      deployment_generation: run.deployment_generation,
      policy_generation: run.policy_generation,
      policy_authority_ref: run.policy_authority_ref,
      authorization_receipt_ref: run.authorization_receipt_ref,
      purge_revision: run.purge_revision,
    });
    const storedAttemptRequest = JSON.parse(String(attempt.request_json)) as unknown;
    attemptRequest = z.object({ request: ArtifactSectionReviseRequestSchema, attempt_ref: z.string().regex(IDENTIFIER) }).strict().parse(storedAttemptRequest);
    if (attempt.output_json !== null) {
      const raw = JSON.parse(String(attempt.output_json)) as unknown;
      const parsed = z.object({
        output: z.object({
          output_object_ref: z.string().regex(IDENTIFIER), output_sha256: z.string().regex(SHA256),
          output_size_bytes: z.number().int().nonnegative().max(8_388_608), readback_sha256: z.string().regex(SHA256),
        }).strict(),
        draft: z.object({ artifact_ref: VersionedRefSchema, manifest_sha256: z.string().regex(SHA256) }).strict().optional(),
      }).strict().parse(raw);
      output = parsed.output;
      if (output.output_sha256 !== output.readback_sha256) {
        fail("ARTIFACT_COW_WORKFLOW_OUTPUT_CORRUPT", "stored model output digest differs from its exact readback");
      }
      if (parsed.draft !== undefined && (parsed.draft.artifact_ref.id !== request.artifact_ref.id ||
          parsed.draft.artifact_ref.revision !== request.artifact_ref.revision + 1)) {
        fail("ARTIFACT_COW_WORKFLOW_OUTPUT_CORRUPT", "stored COW draft receipt does not follow the admitted parent");
      }
      draft = parsed.draft;
    }
  } catch (cause) {
    fail("ARTIFACT_COW_WORKFLOW_OUTPUT_CORRUPT", "stored COW workflow attempt is malformed", cause);
  }
  if (canonicalRequest(request) !== String(run.request_json) || run.operation_id !== request.operation_id ||
      run.report_intent_id !== request.report_intent_ref.id || run.report_intent_revision !== request.report_intent_ref.revision ||
      run.artifact_id !== request.artifact_ref.id || run.parent_revision !== request.artifact_ref.revision ||
      run.section_contract_id !== request.section_id || run.handler_generation !== request.handler_generation ||
      run.request_sha256 !== attempt.request_sha256 || canonicalRequest(attemptRequest.request) !== String(run.request_json) ||
      attemptRequest?.attempt_ref !== attempt.attempt_ref || attempt.operation_id !== run.operation_id || !Number.isSafeInteger(attempt.budget_expires_at_ms) ||
      !Number.isFinite(attempt.budget_max_total_usd) || (attempt.budget_max_total_usd as number) < 0 ||
      typeof attempt.budget_receipt_ref !== "string" || !IDENTIFIER.test(attempt.budget_receipt_ref) ||
      typeof attempt.attempt_ref !== "string" || !IDENTIFIER.test(attempt.attempt_ref) ||
      !["STARTED", "OUTPUT_RECORDED", "COMMITTED", "UNKNOWN", "CANCELLED"].includes(String(attempt.state))) {
    fail("ARTIFACT_COW_WORKFLOW_OUTPUT_CORRUPT", "stored COW workflow identity differs from its exact W2 attempt");
  }
  return {
    request,
    request_json: String(run.request_json),
    request_sha256: String(run.request_sha256),
    authority,
    budget: { receipt_ref: String(attempt.budget_receipt_ref), expires_at_ms: Number(attempt.budget_expires_at_ms),
      max_total_usd: Number(attempt.budget_max_total_usd) },
    attempt_ref: String(attempt.attempt_ref),
    state: attempt.state as ArtifactSectionReviseAttemptState,
    ...(output === undefined ? {} : { output }),
    ...(draft === undefined ? {} : { draft }),
  };
}

export interface ArtifactSectionReviseWorkflowStore {
  /** Persists the admitted attempt before any W3/model/R2 effect. */
  start(input: {
    readonly request: ArtifactSectionReviseRequest;
    /** Exact, already admitted private REPORT intent; separate from W2 operation_id. */
    readonly report_intent: OperationIntent;
    readonly authority: ArtifactSectionReviseAuthority;
    readonly budget: ArtifactSectionReviseBudgetGrant;
    readonly created_at: string;
    readonly attempt_ref: string;
    readonly now?: () => number;
  }): Promise<ArtifactSectionReviseAttempt>;
  read(operationId: string): Promise<ArtifactSectionReviseAttempt | null>;
  recordOutput(input: { readonly operation_id: string; readonly attempt_ref: string; readonly request_sha256: string; readonly output: ArtifactSectionReviseOutput; readonly created_at: string }): Promise<ArtifactSectionReviseAttempt>;
  markEffectUnknown(input: { readonly operation_id: string; readonly attempt_ref: string; readonly request_sha256: string; readonly created_at: string }): Promise<ArtifactSectionReviseAttempt>;
  cancelBeforeEffect(input: { readonly operation_id: string; readonly attempt_ref: string; readonly request_sha256: string; readonly created_at: string }): Promise<ArtifactSectionReviseAttempt>;
  commitReadback(input: { readonly operation_id: string; readonly attempt_ref: string; readonly request_sha256: string; readonly draft: ArtifactSectionReviseDraftReceipt; readonly created_at: string }): Promise<ArtifactSectionReviseAttempt>;
}

export function createArtifactSectionReviseWorkflowStore(database: D1Database): ArtifactSectionReviseWorkflowStore {
  async function read(operationId: string): Promise<ArtifactSectionReviseAttempt | null> {
    const run = await database.prepare("SELECT * FROM artifact_section_revise_run WHERE operation_id=?1 LIMIT 1")
      .bind(operationId).first<RunRow>();
    if (run === null) return null;
    if (typeof run.current_attempt_ref !== "string") fail("ARTIFACT_COW_WORKFLOW_OUTPUT_CORRUPT", "COW run does not reference its one admitted attempt");
    const attempt = await database.prepare("SELECT * FROM artifact_section_revise_attempt WHERE operation_id=?1 AND attempt_ref=?2 LIMIT 1")
      .bind(operationId, run.current_attempt_ref).first<AttemptRow>();
    if (attempt === null) fail("ARTIFACT_COW_WORKFLOW_OUTPUT_CORRUPT", "COW run attempt is missing");
    const decoded = decodeAttempt(run, attempt);
    if (await digest(decoded.request_json) !== decoded.request_sha256) fail("ARTIFACT_COW_WORKFLOW_OUTPUT_CORRUPT", "stored COW request digest differs from its canonical bytes");
    await verifyAdmissionWitness(decoded.request);
    return decoded;
  }

  async function updateAttempt(input: {
    readonly operation_id: string;
    readonly attempt_ref: string;
    readonly request_sha256: string;
    readonly state: "OUTPUT_RECORDED" | "UNKNOWN" | "CANCELLED" | "COMMITTED";
    readonly output_json?: string;
    readonly created_at: string;
  }): Promise<ArtifactSectionReviseAttempt> {
    const current = await read(input.operation_id);
    if (current === null || current.attempt_ref !== input.attempt_ref || current.request_sha256 !== input.request_sha256) {
      fail("ARTIFACT_COW_WORKFLOW_CONFLICT", "COW workflow attempt identity changed");
    }
    const replayState = current.state === input.state || input.state === "COMMITTED" && current.state === "COMMITTED";
    if (replayState) {
      if (input.output_json !== undefined) {
        const storedJson = current.draft === undefined
          ? JSON.stringify({ output: current.output })
          : JSON.stringify({ output: current.output, draft: current.draft });
        if (storedJson !== input.output_json) fail("ARTIFACT_COW_WORKFLOW_CONFLICT", "COW output replay differs from its committed immutable receipt");
      }
      return current;
    }
    const allowed = input.state === "OUTPUT_RECORDED" ? current.state === "STARTED"
      : input.state === "UNKNOWN" || input.state === "CANCELLED" ? current.state === "STARTED"
      : input.state === "COMMITTED" && current.state === "OUTPUT_RECORDED";
    if (!allowed) fail("ARTIFACT_COW_WORKFLOW_CONFLICT", "COW workflow transition is not allowed");
    const runRevision = await database.prepare("SELECT run_revision FROM artifact_section_revise_run WHERE operation_id=?1 AND state='ACTIVE' AND current_attempt_ref=?2 LIMIT 1")
      .bind(input.operation_id, input.attempt_ref).first<{ readonly run_revision: unknown }>();
    if (runRevision === null || !Number.isSafeInteger(runRevision.run_revision)) fail("ARTIFACT_COW_WORKFLOW_CONFLICT", "COW workflow run is no longer active");
    const outputJson = input.output_json ?? null;
    const statements = [database.prepare(
      "UPDATE artifact_section_revise_attempt SET state=?1,output_json=?2,updated_at=?3 WHERE operation_id=?4 AND attempt_ref=?5 AND request_sha256=?6 AND state=?7",
    ).bind(input.state === "COMMITTED" ? "COMMITTED" : input.state, outputJson, input.created_at,
      input.operation_id, input.attempt_ref, input.request_sha256, input.state === "COMMITTED" ? "OUTPUT_RECORDED" : "STARTED"),
      ...(input.state === "COMMITTED" || input.state === "CANCELLED" ? [database.prepare(
        "UPDATE artifact_section_revise_run SET state=?1,run_revision=run_revision+1,updated_at=?2 WHERE operation_id=?3 AND run_revision=?4 AND state='ACTIVE' AND current_attempt_ref=?5",
      ).bind(input.state === "COMMITTED" ? "COMPLETED" : "CANCELLED", input.created_at, input.operation_id, runRevision.run_revision, input.attempt_ref)] : []),
    ];
    try {
      const results = await database.batch(statements);
      if (results.length !== statements.length || results.some((result) => result.success !== true || result.meta?.changes !== 1)) {
        fail("ARTIFACT_COW_WORKFLOW_CONFLICT", "COW workflow transition lost its compare-and-swap");
      }
    } catch (cause) {
      const raced = await read(input.operation_id);
      if (raced?.state === input.state) return raced;
      fail("ARTIFACT_COW_WORKFLOW_CONFLICT", "COW workflow transition could not be verified", cause);
    }
    const next = await read(input.operation_id);
    if (next === null || next.state !== input.state) fail("ARTIFACT_COW_WORKFLOW_OUTPUT_CORRUPT", "COW workflow transition readback is missing");
    return next;
  }

  return Object.freeze({
    async start(input: Parameters<ArtifactSectionReviseWorkflowStore["start"]>[0]): Promise<ArtifactSectionReviseAttempt> {
      const request = ArtifactSectionReviseRequestSchema.parse(input.request);
      const authority = ArtifactSectionReviseAuthoritySchema.parse(input.authority);
      const reportIntent = OperationIntentSchema.parse(input.report_intent);
      await verifyAdmissionWitness(request);
      if (reportIntent.operation_kind !== "REPORT" || reportIntent.principal_ref !== authority.principal_ref ||
          !sameRef(reportIntent.intent_ref, request.report_intent_ref) ||
          reportIntent.policy_decision_ref !== request.report_admission_witness.decision_sha256 ||
      request.report_admission_witness.request.protocol !== ARTIFACT_SECTION_REVISE_HTTP_PROTOCOL ||
          request.report_admission_witness.request.artifact_ref.id !== request.artifact_ref.id ||
          request.report_admission_witness.request.artifact_ref.revision !== request.artifact_ref.revision ||
          request.report_admission_witness.request.section_id !== request.section_id ||
          request.report_admission_witness.request.expected_artifact_revision !== request.artifact_ref.revision ||
          request.report_admission_witness.request.idempotency_key !== request.idempotency_key ||
          request.report_admission_witness.material.principal_ref !== authority.principal_ref ||
          request.report_admission_witness.material.credential_generation !== authority.credential_generation ||
          request.report_admission_witness.material.deployment_generation !== authority.deployment_generation ||
          request.report_admission_witness.material.policy_generation !== authority.policy_generation ||
          request.report_admission_witness.material.policy_authority_ref !== authority.policy_authority_ref ||
          request.report_admission_witness.material.purge_revision !== authority.purge_revision ||
          canonicalJson(request.report_admission_witness.material.scope_snapshot_ref) !== canonicalJson(request.scope_snapshot_ref) ||
          request.report_admission_witness.material.spec_digest !== request.spec_digest ||
          canonicalJson(request.report_admission_witness.material.evidence_freeze_ref) !== canonicalJson(request.evidence_freeze_ref)) {
        fail("ARTIFACT_COW_WORKFLOW_AUTHORITY_STALE", "COW run is not bound to its exact owner REPORT intent");
      }
      if (typeof input.attempt_ref !== "string" || !IDENTIFIER.test(input.attempt_ref) ||
          typeof input.budget.receipt_ref !== "string" || !IDENTIFIER.test(input.budget.receipt_ref) ||
          !Number.isSafeInteger(input.budget.expires_at_ms) || input.budget.expires_at_ms <= (input.now?.() ?? Date.now()) ||
          !Number.isFinite(input.budget.max_total_usd) || input.budget.max_total_usd < 0 ||
          !Number.isFinite(Date.parse(input.created_at)) || new Date(input.created_at).toISOString() !== input.created_at) {
        fail("ARTIFACT_COW_WORKFLOW_INPUT_INVALID", "COW workflow attempt admission is invalid or expired");
      }
      if (request.protocol !== ARTIFACT_SECTION_REVISE_PROTOCOL) {
        fail("ARTIFACT_COW_WORKFLOW_INPUT_INVALID", "COW workflow protocol or scope is invalid");
      }
      const requestJson = canonicalRequest(request);
      const requestSha = await digest(requestJson);
      const authorityBindings = authority;
      const existing = await read(request.operation_id);
      if (existing !== null) {
        if (existing.request_json !== requestJson || existing.request_sha256 !== requestSha ||
            JSON.stringify(existing.authority) !== JSON.stringify(authorityBindings) || existing.budget.receipt_ref !== input.budget.receipt_ref ||
            existing.budget.max_total_usd !== input.budget.max_total_usd ||
            existing.attempt_ref !== input.attempt_ref) fail("ARTIFACT_COW_WORKFLOW_CONFLICT", "COW operation identity is already bound to different inputs");
        return existing;
      }
      const attemptJson = canonicalJson({ request, attempt_ref: input.attempt_ref });
      const statements = [database.prepare(
        "INSERT INTO artifact_section_revise_run(operation_id,protocol,artifact_id,parent_revision,section_contract_id,report_intent_id,report_intent_revision,principal_ref,credential_generation,deployment_generation,policy_generation,policy_authority_ref,authorization_receipt_ref,scope_snapshot_id,scope_snapshot_revision,purge_revision,idempotency_key,handler_generation,request_json,request_sha256,run_revision,state,current_attempt_ref,created_at,updated_at) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19,?20,1,'ACTIVE',?21,?22,?22)",
      ).bind(request.operation_id, request.protocol, request.artifact_ref.id, request.artifact_ref.revision,
        request.section_id, reportIntent.intent_ref.id, reportIntent.intent_ref.revision, authority.principal_ref, authority.credential_generation, authority.deployment_generation,
        authority.policy_generation, authority.policy_authority_ref, authority.authorization_receipt_ref,
        request.scope_snapshot_ref.id, request.scope_snapshot_ref.revision, authority.purge_revision,
        request.idempotency_key, request.handler_generation, requestJson, requestSha, input.attempt_ref, input.created_at),
        database.prepare(
          "INSERT INTO artifact_section_revise_attempt(operation_id,attempt_number,expected_run_revision,attempt_ref,request_json,request_sha256,budget_receipt_ref,budget_expires_at_ms,budget_max_total_usd,state,output_json,created_at,updated_at) VALUES (?1,1,1,?2,?3,?4,?5,?6,?7,'STARTED',NULL,?8,?8)",
        ).bind(request.operation_id, input.attempt_ref, attemptJson, requestSha, input.budget.receipt_ref, input.budget.expires_at_ms, input.budget.max_total_usd, input.created_at)];
      try {
        const results = await database.batch(statements);
        if (results.length !== statements.length || results.some((result) => result.success !== true || result.meta?.changes !== 1)) {
          fail("ARTIFACT_COW_WORKFLOW_CONFLICT", "COW workflow attempt was not atomically admitted");
        }
      } catch (cause) {
        const raced = await read(request.operation_id);
        if (raced !== null && raced.request_json === requestJson && raced.request_sha256 === requestSha &&
            raced.budget.receipt_ref === input.budget.receipt_ref && raced.budget.max_total_usd === input.budget.max_total_usd &&
            raced.attempt_ref === input.attempt_ref) return raced;
        fail("ARTIFACT_COW_WORKFLOW_AUTHORITY_STALE", "COW workflow admission failed its current-parent or owner-authority guard", cause);
      }
      const admitted = await read(request.operation_id);
      if (admitted === null || admitted.state !== "STARTED" || admitted.request_sha256 !== requestSha) {
        fail("ARTIFACT_COW_WORKFLOW_OUTPUT_CORRUPT", "COW workflow admission readback is incomplete");
      }
      return admitted;
    },
    read,
    recordOutput: async (input: Parameters<ArtifactSectionReviseWorkflowStore["recordOutput"]>[0]) => {
      const parsed = z.object({
        output_object_ref: z.string().regex(IDENTIFIER), output_sha256: z.string().regex(SHA256),
        output_size_bytes: z.number().int().positive().max(8_388_608), readback_sha256: z.string().regex(SHA256),
      }).strict().parse(input.output);
      if (parsed.output_sha256 !== parsed.readback_sha256) fail("ARTIFACT_COW_WORKFLOW_OUTPUT_CORRUPT", "model output readback digest differs");
      const outputJson = JSON.stringify({ output: parsed });
      return updateAttempt({ ...input, state: "OUTPUT_RECORDED", output_json: outputJson });
    },
    markEffectUnknown: (input: Parameters<ArtifactSectionReviseWorkflowStore["markEffectUnknown"]>[0]) => updateAttempt({ ...input, state: "UNKNOWN" }),
    cancelBeforeEffect: (input: Parameters<ArtifactSectionReviseWorkflowStore["cancelBeforeEffect"]>[0]) => updateAttempt({ ...input, state: "CANCELLED" }),
    commitReadback: async (input: Parameters<ArtifactSectionReviseWorkflowStore["commitReadback"]>[0]) => {
      const current = await read(input.operation_id);
      if (current === null || current.attempt_ref !== input.attempt_ref || current.request_sha256 !== input.request_sha256 ||
          current.output === undefined || current.request.artifact_ref.id !== input.draft.artifact_ref.id ||
          input.draft.artifact_ref.revision !== current.request.artifact_ref.revision + 1 || !SHA256.test(input.draft.manifest_sha256)) {
        fail("ARTIFACT_COW_WORKFLOW_OUTPUT_CORRUPT", "COW draft readback does not follow the exact admitted parent");
      }
      const outputJson = JSON.stringify({ output: current.output, draft: input.draft });
      return updateAttempt({ ...input, state: "COMMITTED", output_json: outputJson });
    },
  });
}
