import {
  canonicalModelGatewayJson,
  modelGatewaySha256,
  type ModelGatewayExecutionError,
  type ModelGatewayExecutionErrorCode,
} from "@eliotr/cloudflare-ai";
import {
  responseInvalidReason,
  transportFailureReason,
  typedUpstreamStatus,
  type QualificationResponseInvalidReason,
  type QualificationTransportReason,
} from "./research-model-qualification-http-error-classifier.js";

export const RESEARCH_MODEL_QUALIFICATION_FAILURE_SUMMARY_PROTOCOL =
  "eliotr.model-route-qualification-failure-summary.v1" as const;
export const RESEARCH_MODEL_QUALIFICATION_FAILURE_SUMMARY_PHASE =
  "MODEL_GATEWAY_EXECUTION" as const;

const FAILURE_CODES = new Set<ModelGatewayExecutionErrorCode>([
  "MODEL_GATEWAY_DEPLOYMENT_MISSING", "MODEL_GATEWAY_PROMPT_COMPILE_FAILED",
  "MODEL_GATEWAY_REQUEST_INVALID", "MODEL_GATEWAY_CREDENTIAL_INVALID",
  "MODEL_GATEWAY_TRANSPORT_FAILED", "MODEL_GATEWAY_AUTH_REJECTED",
  "MODEL_GATEWAY_LIMIT_REJECTED", "MODEL_GATEWAY_POLICY_REJECTED",
  "MODEL_GATEWAY_UPSTREAM_REJECTED", "MODEL_GATEWAY_RESPONSE_INVALID",
  "MODEL_GATEWAY_OUTPUT_TRUNCATED", "MODEL_GATEWAY_OUTPUT_PERSIST_FAILED",
  "MODEL_GATEWAY_FINGERPRINT_PERSIST_FAILED", "MODEL_GATEWAY_PRICING_FAILED",
]);
const RESPONSE_REASONS = new Set<QualificationResponseInvalidReason>([
  "FINGERPRINT_INVALID", "LOG_READBACK_UNAVAILABLE", "LOG_CORRELATION_INVALID",
  "LOG_ID_MISSING", "LOG_ID_INVALID", "CONTENT_TYPE_INVALID", "BODY_TOO_LARGE",
  "BODY_JSON_INVALID", "BODY_SHAPE_INVALID", "MODEL_ID_INVALID", "CACHE_INVALID",
  "UNCLASSIFIED",
]);
const TRANSPORT_REASONS = new Set<QualificationTransportReason>([
  "CANCELLED", "DEADLINE_EXCEEDED", "REDIRECTED", "BODY_TOO_LARGE",
  "BODY_READ_FAILED", "NETWORK_CONNECTION_LOST", "FETCH_TYPE_ERROR", "FETCH_ERROR",
  "ILLEGAL_INVOCATION", "FETCH_NOT_SUPPORTED", "UNCLASSIFIED",
]);
const IDENTIFIER = /^[A-Za-z0-9._:@/-]{1,256}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;

export interface ResearchModelQualificationFailureSummary {
  readonly probe_idempotency_key: string;
  readonly probe_input_sha256: string;
  readonly claim_ref: string;
  readonly phase: typeof RESEARCH_MODEL_QUALIFICATION_FAILURE_SUMMARY_PHASE;
  readonly failure_code: ModelGatewayExecutionErrorCode;
  readonly safe_response_reason: QualificationResponseInvalidReason | null;
  readonly transport_failure_reason: QualificationTransportReason | null;
  readonly observed_http_status: number | null;
  readonly summary_sha256: string;
  readonly observed_at: string;
}

export interface ResearchModelQualificationFailureSummaryInput {
  readonly probe_idempotency_key: string;
  readonly probe_input_sha256: string;
  readonly claim_ref: string;
  readonly error: ModelGatewayExecutionError;
}

export class ResearchModelQualificationFailureSummaryError extends Error {
  public constructor(message = "qualification failure summary persistence is unavailable") {
    super(message);
    this.name = "ResearchModelQualificationFailureSummaryError";
  }
}

interface FailureSummaryRow extends Record<string, unknown> {
  readonly probe_idempotency_key: unknown;
  readonly probe_input_sha256: unknown;
  readonly claim_ref: unknown;
  readonly phase: unknown;
  readonly failure_code: unknown;
  readonly safe_response_reason: unknown;
  readonly transport_failure_reason: unknown;
  readonly observed_http_status: unknown;
  readonly summary_sha256: unknown;
  readonly observed_at: unknown;
}

interface DispatchIdentityRow extends Record<string, unknown> {
  readonly probe_input_sha256: unknown;
  readonly claim_ref: unknown;
  readonly state: unknown;
  readonly observation_sha256: unknown;
  readonly observation_json: unknown;
  readonly completed_at: unknown;
}

function identifier(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !IDENTIFIER.test(value)) throw new ResearchModelQualificationFailureSummaryError(`${label} is invalid`);
}

function digest(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !SHA256.test(value)) throw new ResearchModelQualificationFailureSummaryError(`${label} is invalid`);
}

function responseReason(error: ModelGatewayExecutionError): QualificationResponseInvalidReason | null {
  const projected = (error as ModelGatewayExecutionError & { readonly safe_response_reason?: unknown }).safe_response_reason;
  if (typeof projected === "string" && RESPONSE_REASONS.has(projected as QualificationResponseInvalidReason)) {
    return projected as QualificationResponseInvalidReason;
  }
  return responseInvalidReason(error) ?? null;
}

function typedFields(input: ResearchModelQualificationFailureSummaryInput) {
  const { error } = input;
  if (!FAILURE_CODES.has(error.code)) throw new ResearchModelQualificationFailureSummaryError("failure code is not persistable");
  identifier(input.probe_idempotency_key, "probe idempotency key");
  digest(input.probe_input_sha256, "probe input digest");
  identifier(input.claim_ref, "claim reference");
  const response = error.code === "MODEL_GATEWAY_RESPONSE_INVALID"
    ? responseReason(error) ?? "UNCLASSIFIED"
    : null;
  const transport = error.code === "MODEL_GATEWAY_TRANSPORT_FAILED"
    ? transportFailureReason(error) ?? "UNCLASSIFIED"
    : null;
  const status = typedUpstreamStatus(error) ?? null;
  return Object.freeze({
    protocol: RESEARCH_MODEL_QUALIFICATION_FAILURE_SUMMARY_PROTOCOL,
    phase: RESEARCH_MODEL_QUALIFICATION_FAILURE_SUMMARY_PHASE,
    probe_idempotency_key: input.probe_idempotency_key,
    probe_input_sha256: input.probe_input_sha256,
    claim_ref: input.claim_ref,
    failure_code: error.code,
    safe_response_reason: response,
    transport_failure_reason: transport,
    observed_http_status: status,
  });
}

async function summaryDigest(fields: ReturnType<typeof typedFields>): Promise<string> {
  return modelGatewaySha256(canonicalModelGatewayJson(fields));
}

function parseSummary(row: FailureSummaryRow, expected?: Pick<ResearchModelQualificationFailureSummaryInput, "probe_idempotency_key" | "probe_input_sha256" | "claim_ref">): ResearchModelQualificationFailureSummary {
  identifier(row.probe_idempotency_key, "stored failure summary probe key");
  digest(row.probe_input_sha256, "stored failure summary probe digest");
  identifier(row.claim_ref, "stored failure summary claim reference");
  digest(row.summary_sha256, "stored failure summary digest");
  if (row.phase !== RESEARCH_MODEL_QUALIFICATION_FAILURE_SUMMARY_PHASE ||
      typeof row.failure_code !== "string" || !FAILURE_CODES.has(row.failure_code as ModelGatewayExecutionErrorCode)) {
    throw new ResearchModelQualificationFailureSummaryError("stored failure summary type is invalid");
  }
  const response = row.safe_response_reason === null ? null : row.safe_response_reason;
  const transport = row.transport_failure_reason === null ? null : row.transport_failure_reason;
  if ((response !== null && (typeof response !== "string" || !RESPONSE_REASONS.has(response as QualificationResponseInvalidReason))) ||
      (transport !== null && (typeof transport !== "string" || !TRANSPORT_REASONS.has(transport as QualificationTransportReason)))) {
    throw new ResearchModelQualificationFailureSummaryError("stored failure summary reason is invalid");
  }
  const status = row.observed_http_status === null ? null : row.observed_http_status;
  if (status !== null && (typeof status !== "number" || !Number.isInteger(status) || status < 100 || status > 599)) {
    throw new ResearchModelQualificationFailureSummaryError("stored failure summary status is invalid");
  }
  if (typeof row.observed_at !== "string" || !Number.isFinite(Date.parse(row.observed_at)) ||
      new Date(Date.parse(row.observed_at)).toISOString() !== row.observed_at) {
    throw new ResearchModelQualificationFailureSummaryError("stored failure summary time is invalid");
  }
  if ((row.failure_code === "MODEL_GATEWAY_RESPONSE_INVALID" && response === null) ||
      (row.failure_code !== "MODEL_GATEWAY_RESPONSE_INVALID" && response !== null) ||
      (row.failure_code === "MODEL_GATEWAY_TRANSPORT_FAILED" && transport === null) ||
      (row.failure_code !== "MODEL_GATEWAY_TRANSPORT_FAILED" && transport !== null)) {
    throw new ResearchModelQualificationFailureSummaryError("stored failure summary reason is bound to the wrong failure code");
  }
  if (expected !== undefined && (row.probe_idempotency_key !== expected.probe_idempotency_key ||
      row.probe_input_sha256 !== expected.probe_input_sha256 || row.claim_ref !== expected.claim_ref)) {
    throw new ResearchModelQualificationFailureSummaryError("stored failure summary identity differs from dispatch claim");
  }
  return Object.freeze({
    probe_idempotency_key: row.probe_idempotency_key,
    probe_input_sha256: row.probe_input_sha256,
    claim_ref: row.claim_ref,
    phase: RESEARCH_MODEL_QUALIFICATION_FAILURE_SUMMARY_PHASE,
    failure_code: row.failure_code as ModelGatewayExecutionErrorCode,
    safe_response_reason: response as QualificationResponseInvalidReason | null,
    transport_failure_reason: transport as QualificationTransportReason | null,
    observed_http_status: status as number | null,
    summary_sha256: row.summary_sha256,
    observed_at: row.observed_at,
  });
}

export async function readResearchModelQualificationFailureSummary(
  database: D1Database,
  identity: Pick<ResearchModelQualificationFailureSummaryInput, "probe_idempotency_key" | "probe_input_sha256" | "claim_ref">,
): Promise<ResearchModelQualificationFailureSummary | null> {
  try {
    const row = await database.prepare(
      "SELECT probe_idempotency_key,probe_input_sha256,claim_ref,phase,failure_code,safe_response_reason,transport_failure_reason,observed_http_status,summary_sha256,observed_at FROM model_route_qualification_failure_summary WHERE probe_idempotency_key=?1 LIMIT 1",
    ).bind(identity.probe_idempotency_key).first<FailureSummaryRow>();
    if (row === null) return null;
    const parsed = parseSummary(row, identity);
    const dispatch = await database.prepare(
      "SELECT probe_input_sha256,claim_ref,state,observation_sha256,observation_json,completed_at FROM model_route_qualification_dispatch WHERE probe_idempotency_key=?1 LIMIT 1",
    ).bind(identity.probe_idempotency_key).first<DispatchIdentityRow>();
    if (dispatch === null || dispatch.probe_input_sha256 !== identity.probe_input_sha256 ||
        dispatch.claim_ref !== identity.claim_ref || dispatch.state !== "STARTED" ||
        dispatch.observation_sha256 !== null || dispatch.observation_json !== null || dispatch.completed_at !== null) {
      throw new ResearchModelQualificationFailureSummaryError("failure summary dispatch readback is not unfinished");
    }
    const fields = Object.freeze({
      protocol: RESEARCH_MODEL_QUALIFICATION_FAILURE_SUMMARY_PROTOCOL,
      phase: parsed.phase,
      probe_idempotency_key: parsed.probe_idempotency_key,
      probe_input_sha256: parsed.probe_input_sha256,
      claim_ref: parsed.claim_ref,
      failure_code: parsed.failure_code,
      safe_response_reason: parsed.safe_response_reason,
      transport_failure_reason: parsed.transport_failure_reason,
      observed_http_status: parsed.observed_http_status,
    });
    if (await summaryDigest(fields) !== parsed.summary_sha256) {
      throw new ResearchModelQualificationFailureSummaryError("failure summary digest does not match its safe fields");
    }
    return parsed;
  } catch (cause) {
    if (cause instanceof ResearchModelQualificationFailureSummaryError) throw cause;
    throw new ResearchModelQualificationFailureSummaryError();
  }
}

export async function recordResearchModelQualificationFailureSummary(
  database: D1Database,
  input: ResearchModelQualificationFailureSummaryInput,
): Promise<ResearchModelQualificationFailureSummary> {
  const fields = typedFields(input);
  const summarySha256 = await summaryDigest(fields);
  try {
    await database.prepare(
      "INSERT INTO model_route_qualification_failure_summary(probe_idempotency_key,probe_input_sha256,claim_ref,phase,failure_code,safe_response_reason,transport_failure_reason,observed_http_status,summary_sha256) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9) ON CONFLICT(probe_idempotency_key) DO NOTHING",
    ).bind(fields.probe_idempotency_key, fields.probe_input_sha256, fields.claim_ref, fields.phase,
      fields.failure_code, fields.safe_response_reason, fields.transport_failure_reason,
      fields.observed_http_status, summarySha256).run();
  } catch {
    // The exact readback below reconciles a lost acknowledgement.  A row that
    // does not match remains a fail-closed persistence error.
  }
  let persisted: ResearchModelQualificationFailureSummary | null;
  try {
    persisted = await readResearchModelQualificationFailureSummary(database, input);
  } catch {
    throw new ResearchModelQualificationFailureSummaryError();
  }
  if (persisted === null || persisted.summary_sha256 !== summarySha256) {
    throw new ResearchModelQualificationFailureSummaryError();
  }
  return persisted;
}
