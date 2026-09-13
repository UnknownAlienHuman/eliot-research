import {
  OperationIntentSchema,
  OperationKindSchema,
  type OperationIntent,
  type VersionedRef,
} from "@eliotr/contracts";
import {
  canonicalJson,
  decodeModelRouteDeployment,
  type ModelRouteDeployment,
} from "@eliotr/platform-cloudflare";
import { modelGatewaySha256 } from "@eliotr/cloudflare-ai";
import { StageRequestSchema, textDigest, type StageRequest } from "@eliotr/cloudflare-workflows";
import { ModelAttemptError, type ModelAttemptAuthority, type ModelCostQuote } from "./model-attempt-types.js";
import type {
  SpendAuthorizationReadback,
  SpendAuthorizationReadRequest,
  SpendAuthorizationReader,
} from "./research-model-attempt-revalidator.js";
import type {
  ResearchSynthesisSpendAdmissionReadRequest,
  ResearchSynthesisSpendAdmissionRecord,
} from "./research-synthesis-preparation.js";

export const RESEARCH_MODEL_SPEND_ADMISSION_PROTOCOL = "eliotr.research-model-spend-admission.v1" as const;
export const RESEARCH_MODEL_SPEND_APPROVAL_PROTOCOL = "eliotr.research-model-spend-approval.v1" as const;

type ErrorCode = ConstructorParameters<typeof ModelAttemptError>[0];
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9:._/@-]{0,255}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const MAX_JSON_BYTES = 64 * 1024;
const MAX_CALL_BYTES = 256 * 1024;
const STAGES = { 12: "SYNTHESIZE", 13: "VERIFY", 14: "AUDIT_CLAIMS" } as const;
const CLIENT_CLASSES = ["owner_pwa", "named_api_client", "trusted_agent", "federation_client"] as const;

export interface ResearchModelSpendApproval {
  readonly protocol: typeof RESEARCH_MODEL_SPEND_APPROVAL_PROTOCOL;
  readonly approved: true;
  readonly authorization_ref: string;
  readonly decision_digest: string;
  readonly policy_decision_ref: string;
  readonly policy_generation: string;
  readonly currentness_digest: string;
  readonly expires_at: string;
  readonly expected_deployment: ModelRouteDeployment;
}

export interface ResearchModelSpendCurrentAuthority {
  readonly authority: ModelAttemptAuthority;
  readonly expected_deployment: ModelRouteDeployment;
}

export interface ResearchModelSpendAdmissionOptions {
  /** Server-owned current W2 grant/policy/deployment read; request data is revalidated. */
  readonly read_current_authority: (request: SpendAuthorizationReadRequest) => Promise<ResearchModelSpendCurrentAuthority | null>;
  /** The authority clock used for all expiry checks. */
  readonly now?: () => number;
}

export interface ResearchModelSpendAdmissionInput {
  /** W3 model operation identity and exact post-reservation tuple. */
  readonly request: SpendAuthorizationReadRequest;
  /** W2 operation owning the STARTED stage attempt. */
  readonly workflow_operation_id: string;
  readonly stage_index: 12 | 13 | 14;
  /** Exact JSON bytes stored by W2, not a reconstructed request. */
  readonly stage_request_json: string;
  readonly workflow_budget_receipt_ref: string;
  readonly intent: OperationIntent;
  readonly quote: ModelCostQuote;
  readonly authority: ModelAttemptAuthority;
  readonly expected_deployment: ModelRouteDeployment;
  /** Explicit server policy decision; this adapter never creates or infers one. */
  readonly approval: ResearchModelSpendApproval;
  /** Server-selected bounds retained for preparation readback. */
  readonly max_input_bytes: number;
  readonly max_output_bytes: number;
}

/** Full immutable record used by a pre-W3 server preparation boundary. */
export interface ResearchModelSpendAdmissionRecord extends SpendAuthorizationReadback {
  readonly admission_ref: VersionedRef;
  readonly admission_sha256: string;
  readonly workflow_operation_id: string;
  readonly stage_index: 12 | 13 | 14;
  readonly stage_request_json: string;
  readonly workflow_budget_receipt_ref: string;
  readonly intent: OperationIntent;
  readonly quote: ModelCostQuote;
  readonly authority: ModelAttemptAuthority;
  readonly approval: ResearchModelSpendApproval;
  readonly max_input_bytes: number;
  readonly max_output_bytes: number;
  readonly created_at: string;
}

export interface ResearchModelSpendAdmissionPort extends SpendAuthorizationReader {
  admit(input: ResearchModelSpendAdmissionInput): Promise<ResearchModelSpendAdmissionRecord>;
  readPreparation(input: ResearchSynthesisSpendAdmissionReadRequest): Promise<ResearchSynthesisSpendAdmissionRecord | null>;
}

function fail(code: ErrorCode, message: string, retryable = false, cause?: unknown): never {
  throw new ModelAttemptError(code, message, retryable, cause);
}

function plain(value: unknown, keys: ReadonlySet<string>, label: string, code: ErrorCode): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) fail(code, `${label} must be an object`);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) fail(code, `${label} must be a plain object`);
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some((key) => !keys.has(key))) fail(code, `${label} contains unsupported fields`);
  return record;
}

function id(value: unknown, label: string, code: ErrorCode): string {
  if (typeof value !== "string" || !IDENTIFIER.test(value)) fail(code, `${label} is invalid`);
  return value;
}

function sha(value: unknown, label: string, code: ErrorCode): string {
  if (typeof value !== "string" || !SHA256.test(value)) fail(code, `${label} is invalid`);
  return value;
}

function time(value: unknown, label: string, code: ErrorCode): string {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value)) || new Date(Date.parse(value)).toISOString() !== value) {
    fail(code, `${label} is not canonical UTC time`);
  }
  return value;
}

function nonnegative(value: unknown, label: string, code: ErrorCode): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) fail(code, `${label} is invalid`);
  return value as number;
}

function bounded(value: unknown, label: string, code: ErrorCode): number {
  const result = nonnegative(value, label, code);
  if (result < 1 || result > MAX_CALL_BYTES) fail(code, `${label} is outside the model call bound`);
  return result;
}

function finite(value: unknown, label: string, code: ErrorCode): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) fail(code, `${label} is invalid`);
  return value;
}

function ref(value: unknown, label: string, code: ErrorCode): VersionedRef {
  const record = plain(value, new Set(["id", "revision"]), label, code);
  return Object.freeze({ id: id(record.id, `${label}.id`, code), revision: bounded(record.revision, `${label}.revision`, code) });
}

function canonical(value: unknown, label: string, code: ErrorCode): string {
  let result: string;
  try { result = canonicalJson(value); } catch (cause) { fail(code, `${label} is not canonical JSON`, false, cause); }
  if (new TextEncoder().encode(result).byteLength > MAX_JSON_BYTES) fail(code, `${label} exceeds the D1 metadata bound`);
  return result;
}

function storedJson(value: unknown, label: string): unknown {
  if (typeof value !== "string" || value.length === 0 || new TextEncoder().encode(value).byteLength > MAX_JSON_BYTES) {
    fail("MODEL_ATTEMPT_READBACK_CORRUPT", `${label} is missing or exceeds the D1 bound`);
  }
  try {
    const parsed = JSON.parse(value) as unknown;
    if (canonicalJson(parsed) !== value) fail("MODEL_ATTEMPT_READBACK_CORRUPT", `${label} is not canonical JSON`);
    return parsed;
  } catch (cause) {
    if (cause instanceof ModelAttemptError) throw cause;
    fail("MODEL_ATTEMPT_READBACK_CORRUPT", `${label} is not valid JSON`, false, cause);
  }
}

function deployment(value: unknown, code: ErrorCode, label: string): ModelRouteDeployment {
  try { return decodeModelRouteDeployment(value); } catch (cause) { fail(code, `${label} is malformed`, false, cause); }
}

function authority(value: unknown, code: ErrorCode, label: string): ModelAttemptAuthority {
  const record = plain(value, new Set(["principal_ref", "client_class", "policy_decision_ref", "scope_snapshot_ref", "credential_generation", "deployment_generation", "policy_generation", "currentness_digest", "expires_at"]), label, code);
  if (!CLIENT_CLASSES.includes(record.client_class as typeof CLIENT_CLASSES[number])) fail(code, `${label}.client_class is invalid`);
  return Object.freeze({
    principal_ref: id(record.principal_ref, `${label}.principal_ref`, code),
    client_class: record.client_class as ModelAttemptAuthority["client_class"],
    policy_decision_ref: id(record.policy_decision_ref, `${label}.policy_decision_ref`, code),
    scope_snapshot_ref: ref(record.scope_snapshot_ref, `${label}.scope_snapshot_ref`, code),
    credential_generation: id(record.credential_generation, `${label}.credential_generation`, code),
    deployment_generation: id(record.deployment_generation, `${label}.deployment_generation`, code),
    policy_generation: id(record.policy_generation, `${label}.policy_generation`, code),
    currentness_digest: sha(record.currentness_digest, `${label}.currentness_digest`, code),
    expires_at: time(record.expires_at, `${label}.expires_at`, code),
  });
}

const QUOTE_KEYS = new Set(["quote_ref", "reservation_id", "operation_kind", "estimated_model_calls", "estimated_input_tokens", "estimated_output_tokens", "estimated_embedding_tokens", "quoted_neurons", "selected_routes", "platform_usd", "workers_ai_usd", "byok_usd", "max_total_usd", "workflow_steps", "expected_sources", "expected_sections", "confidence", "expires_at"]);
function quote(value: unknown, code: ErrorCode, label: string): ModelCostQuote {
  const record = plain(value, QUOTE_KEYS, label, code);
  const operation = OperationKindSchema.safeParse(record.operation_kind);
  if (!operation.success) fail(code, `${label}.operation_kind is invalid`);
  for (const key of ["estimated_model_calls", "estimated_input_tokens", "estimated_output_tokens", "estimated_embedding_tokens", "workflow_steps", "expected_sources", "expected_sections"] as const) nonnegative(record[key], `${label}.${key}`, code);
  for (const key of ["quoted_neurons", "platform_usd", "workers_ai_usd", "byok_usd", "max_total_usd"] as const) finite(record[key], `${label}.${key}`, code);
  if (typeof record.confidence !== "number" || !Number.isFinite(record.confidence) || record.confidence < 0 || record.confidence > 1) fail(code, `${label}.confidence is invalid`);
  if (!Array.isArray(record.selected_routes) || record.selected_routes.length !== 1 || record.selected_routes.some((route) => typeof route !== "string" || !IDENTIFIER.test(route))) fail(code, `${label}.selected_routes must contain one route`);
  return Object.freeze({
    quote_ref: id(record.quote_ref, `${label}.quote_ref`, code), reservation_id: id(record.reservation_id, `${label}.reservation_id`, code), operation_kind: operation.data,
    estimated_model_calls: record.estimated_model_calls as number, estimated_input_tokens: record.estimated_input_tokens as number, estimated_output_tokens: record.estimated_output_tokens as number,
    estimated_embedding_tokens: record.estimated_embedding_tokens as number, quoted_neurons: record.quoted_neurons as number, selected_routes: Object.freeze([record.selected_routes[0] as string]),
    platform_usd: record.platform_usd as number, workers_ai_usd: record.workers_ai_usd as number, byok_usd: record.byok_usd as number, max_total_usd: record.max_total_usd as number,
    workflow_steps: record.workflow_steps as number, expected_sources: record.expected_sources as number, expected_sections: record.expected_sections as number,
    confidence: record.confidence as number, expires_at: time(record.expires_at, `${label}.expires_at`, code),
  });
}

function intent(value: unknown, code: ErrorCode, label: string): OperationIntent {
  const result = OperationIntentSchema.safeParse(value);
  if (!result.success) fail(code, `${label} is invalid`, false, result.error);
  try { return Object.freeze(JSON.parse(canonicalJson(result.data)) as OperationIntent); } catch (cause) { fail(code, `${label} is not canonical`, false, cause); }
}

function approval(value: unknown, code: ErrorCode): ResearchModelSpendApproval {
  const record = plain(value, new Set(["protocol", "approved", "authorization_ref", "decision_digest", "policy_decision_ref", "policy_generation", "currentness_digest", "expires_at", "expected_deployment"]), "spend approval", code);
  if (record.protocol !== RESEARCH_MODEL_SPEND_APPROVAL_PROTOCOL || record.approved !== true) fail(code, "spend approval is not explicitly approved");
  return Object.freeze({ protocol: RESEARCH_MODEL_SPEND_APPROVAL_PROTOCOL, approved: true,
    authorization_ref: id(record.authorization_ref, "approval.authorization_ref", code), decision_digest: sha(record.decision_digest, "approval.decision_digest", code),
    policy_decision_ref: id(record.policy_decision_ref, "approval.policy_decision_ref", code), policy_generation: id(record.policy_generation, "approval.policy_generation", code),
    currentness_digest: sha(record.currentness_digest, "approval.currentness_digest", code), expires_at: time(record.expires_at, "approval.expires_at", code),
    expected_deployment: deployment(record.expected_deployment, code, "approval.expected_deployment") });
}

const READ_KEYS = new Set(["operation_id", "principal_ref", "stage_attempt_ref", "stage_request_sha256", "reservation_id", "quote_ref", "route_ref", "scope_snapshot_ref", "workflow_authorization_receipt_ref"]);
function readRequest(value: unknown, code: ErrorCode = "MODEL_ATTEMPT_INPUT_INVALID"): SpendAuthorizationReadRequest {
  const record = plain(value, READ_KEYS, "spend authorization request", code);
  return Object.freeze({ operation_id: id(record.operation_id, "request.operation_id", code), principal_ref: id(record.principal_ref, "request.principal_ref", code),
    stage_attempt_ref: id(record.stage_attempt_ref, "request.stage_attempt_ref", code), stage_request_sha256: sha(record.stage_request_sha256, "request.stage_request_sha256", code),
    reservation_id: id(record.reservation_id, "request.reservation_id", code), quote_ref: id(record.quote_ref, "request.quote_ref", code), route_ref: id(record.route_ref, "request.route_ref", code),
    scope_snapshot_ref: ref(record.scope_snapshot_ref, "request.scope_snapshot_ref", code), workflow_authorization_receipt_ref: id(record.workflow_authorization_receipt_ref, "request.workflow_authorization_receipt_ref", code) });
}

const PREPARATION_KEYS = new Set(["operation_id", "stage_index", "stage_attempt_ref", "stage_request_sha256", "workflow_budget_receipt_ref", "principal_ref", "credential_generation", "deployment_generation"]);
function preparationRequest(value: unknown): ResearchSynthesisSpendAdmissionReadRequest {
  const record = plain(value, PREPARATION_KEYS, "synthesis spend admission request", "MODEL_ATTEMPT_INPUT_INVALID");
  const code: ErrorCode = "MODEL_ATTEMPT_INPUT_INVALID";
  if (record.stage_index !== 12 && record.stage_index !== 14) fail(code, "synthesis spend admission stage is invalid");
  return Object.freeze({ operation_id: id(record.operation_id, "synthesis.operation_id", code), stage_index: record.stage_index,
    stage_attempt_ref: id(record.stage_attempt_ref, "synthesis.stage_attempt_ref", code), stage_request_sha256: sha(record.stage_request_sha256, "synthesis.stage_request_sha256", code), workflow_budget_receipt_ref: id(record.workflow_budget_receipt_ref, "synthesis.workflow_budget_receipt_ref", code),
    principal_ref: id(record.principal_ref, "synthesis.principal_ref", code), credential_generation: id(record.credential_generation, "synthesis.credential_generation", code), deployment_generation: id(record.deployment_generation, "synthesis.deployment_generation", code) });
}

function stageRequest(value: unknown, code: ErrorCode): { readonly raw: string; readonly request: StageRequest } {
  if (typeof value !== "string" || value.length === 0 || new TextEncoder().encode(value).byteLength > MAX_JSON_BYTES) fail(code, "W2 stage request JSON is invalid");
  try {
    const request = StageRequestSchema.parse(JSON.parse(value));
    if (JSON.stringify(request) !== value) fail(code, "W2 stage request JSON is not the exact stored encoding");
    return Object.freeze({ raw: value, request });
  } catch (cause) {
    if (cause instanceof ModelAttemptError) throw cause;
    fail(code, "W2 stage request JSON is malformed", false, cause);
  }
}

function sameRef(left: VersionedRef, right: VersionedRef): boolean { return left.id === right.id && left.revision === right.revision; }
function sameDeployment(left: ModelRouteDeployment, right: ModelRouteDeployment): boolean {
  return left.route_ref === right.route_ref && left.route_version === right.route_version && left.prompt_generation === right.prompt_generation && left.schema_generation === right.schema_generation && left.parameters_digest === right.parameters_digest && left.pricing_snapshot_ref === right.pricing_snapshot_ref;
}
function sameAuthority(left: ModelAttemptAuthority, right: ModelAttemptAuthority): boolean {
  return left.principal_ref === right.principal_ref && left.client_class === right.client_class && left.policy_decision_ref === right.policy_decision_ref && sameRef(left.scope_snapshot_ref, right.scope_snapshot_ref) && left.credential_generation === right.credential_generation && left.deployment_generation === right.deployment_generation && left.policy_generation === right.policy_generation && left.currentness_digest === right.currentness_digest && left.expires_at === right.expires_at;
}

function admissionMaterial(input: ResearchModelSpendAdmissionInput & { readonly created_at: string }): Record<string, unknown> {
  return { protocol: RESEARCH_MODEL_SPEND_ADMISSION_PROTOCOL, authorization_ref: input.approval.authorization_ref, operation_id: input.request.operation_id, workflow_operation_id: input.workflow_operation_id, stage_index: input.stage_index, stage_attempt_ref: input.request.stage_attempt_ref, stage_request_sha256: input.request.stage_request_sha256, stage_request_json: input.stage_request_json, workflow_budget_receipt_ref: input.workflow_budget_receipt_ref, intent: input.intent, quote: input.quote, authority: input.authority, expected_deployment: input.expected_deployment, approval: input.approval, max_input_bytes: input.max_input_bytes, max_output_bytes: input.max_output_bytes, expires_at: input.approval.expires_at, created_at: input.created_at };
}
async function admissionDigest(input: ResearchModelSpendAdmissionInput & { readonly created_at: string }): Promise<string> { return modelGatewaySha256(canonicalJson(admissionMaterial(input))); }
async function approvalDigest(value: ResearchModelSpendApproval): Promise<string> { return modelGatewaySha256(canonicalJson({ protocol: value.protocol, approved: value.approved, authorization_ref: value.authorization_ref, policy_decision_ref: value.policy_decision_ref, policy_generation: value.policy_generation, currentness_digest: value.currentness_digest, expires_at: value.expires_at, expected_deployment: value.expected_deployment })); }

interface AdmissionRow {
  readonly authorization_ref: unknown; readonly operation_id: unknown; readonly workflow_operation_id: unknown; readonly stage_index: unknown; readonly stage_attempt_ref: unknown; readonly stage_request_sha256: unknown; readonly stage_request_json: unknown; readonly workflow_budget_receipt_ref: unknown;
  readonly intent_id: unknown; readonly intent_revision: unknown; readonly intent_json: unknown; readonly reservation_id: unknown; readonly quote_ref: unknown; readonly quote_json: unknown; readonly authority_json: unknown; readonly principal_ref: unknown; readonly client_class: unknown; readonly credential_generation: unknown; readonly deployment_generation: unknown;
  readonly policy_decision_ref: unknown; readonly policy_generation: unknown; readonly currentness_digest: unknown; readonly scope_snapshot_id: unknown; readonly scope_snapshot_revision: unknown; readonly workflow_authorization_receipt_ref: unknown; readonly route_ref: unknown; readonly expected_deployment_json: unknown; readonly approval_json: unknown; readonly admission_revision: unknown; readonly admission_sha256: unknown; readonly decision_digest: unknown; readonly max_input_bytes: unknown; readonly max_output_bytes: unknown; readonly expires_at: unknown; readonly created_at: unknown;
  readonly [key: string]: unknown;
}
const COLUMNS = ["authorization_ref", "operation_id", "workflow_operation_id", "stage_index", "stage_attempt_ref", "stage_request_sha256", "stage_request_json", "workflow_budget_receipt_ref", "intent_id", "intent_revision", "intent_json", "reservation_id", "quote_ref", "quote_json", "authority_json", "principal_ref", "client_class", "credential_generation", "deployment_generation", "policy_decision_ref", "policy_generation", "currentness_digest", "scope_snapshot_id", "scope_snapshot_revision", "workflow_authorization_receipt_ref", "route_ref", "expected_deployment_json", "approval_json", "admission_revision", "admission_sha256", "decision_digest", "max_input_bytes", "max_output_bytes", "expires_at", "created_at"] as const;
function columns(prefix?: string): string { return COLUMNS.map((column) => prefix === undefined ? column : `${prefix}.${column}`).join(","); }

function clock(now: () => number): number {
  let value: number;
  try { value = now(); } catch (cause) { fail("MODEL_ATTEMPT_AUTHORITY_STALE", "spend admission clock is unavailable", true, cause); }
  if (!Number.isSafeInteger(value) || value < 0) fail("MODEL_ATTEMPT_AUTHORITY_STALE", "spend admission clock is invalid", true);
  return value;
}
function unexpired(value: string, nowMs: number, label: string): void { if (Date.parse(value) <= nowMs) fail("MODEL_ATTEMPT_BUDGET_EXPIRED", `${label} has expired`); }

function validateInput(input: ResearchModelSpendAdmissionInput): { readonly request: SpendAuthorizationReadRequest; readonly stage: ReturnType<typeof stageRequest>; readonly owner: ModelAttemptAuthority; readonly cost: ModelCostQuote; readonly expected: ModelRouteDeployment; readonly operation: OperationIntent; readonly decision: ResearchModelSpendApproval } {
  const request = readRequest(input.request);
  if (!(input.stage_index === 12 || input.stage_index === 13 || input.stage_index === 14)) fail("MODEL_ATTEMPT_INPUT_INVALID", "spend admission stage index is invalid");
  const stage = stageRequest(input.stage_request_json, "MODEL_ATTEMPT_INPUT_INVALID");
  const operation = intent(input.intent, "MODEL_ATTEMPT_INPUT_INVALID", "spend admission intent");
  const cost = quote(input.quote, "MODEL_ATTEMPT_INPUT_INVALID", "spend admission quote");
  const owner = authority(input.authority, "MODEL_ATTEMPT_INPUT_INVALID", "spend admission authority");
  const expected = deployment(input.expected_deployment, "MODEL_ATTEMPT_INPUT_INVALID", "spend admission deployment");
  const decision = approval(input.approval, "MODEL_ATTEMPT_INPUT_INVALID");
  id(input.workflow_operation_id, "workflow operation", "MODEL_ATTEMPT_INPUT_INVALID"); id(input.workflow_budget_receipt_ref, "workflow budget receipt", "MODEL_ATTEMPT_INPUT_INVALID"); bounded(input.max_input_bytes, "max_input_bytes", "MODEL_ATTEMPT_INPUT_INVALID"); bounded(input.max_output_bytes, "max_output_bytes", "MODEL_ATTEMPT_INPUT_INVALID");
  if (stage.request.operation_id !== input.workflow_operation_id || stage.request.stage !== STAGES[input.stage_index]) fail("MODEL_ATTEMPT_INPUT_INVALID", "W2 stage does not match its admission key");
  if (request.operation_id !== operation.intent_ref.id || request.principal_ref !== owner.principal_ref || request.reservation_id !== cost.reservation_id || request.quote_ref !== cost.quote_ref || request.route_ref !== expected.route_ref || !sameRef(request.scope_snapshot_ref, owner.scope_snapshot_ref) || operation.principal_ref !== owner.principal_ref || operation.budget_reservation_ref !== cost.reservation_id || operation.policy_decision_ref !== owner.policy_decision_ref || cost.operation_kind !== operation.operation_kind || cost.selected_routes[0] !== expected.route_ref || decision.policy_decision_ref !== owner.policy_decision_ref || decision.policy_generation !== owner.policy_generation || decision.currentness_digest !== owner.currentness_digest || !sameDeployment(decision.expected_deployment, expected) || Date.parse(decision.expires_at) > Date.parse(cost.expires_at) || Date.parse(decision.expires_at) > Date.parse(owner.expires_at)) fail("MODEL_ATTEMPT_INPUT_INVALID", "spend admission fields are not bound to one explicit decision");
  return { request, stage, owner, cost, expected, operation, decision };
}

async function decodeRow(row: AdmissionRow): Promise<ResearchModelSpendAdmissionRecord> {
  const code: ErrorCode = "MODEL_ATTEMPT_READBACK_CORRUPT";
  const authorizationRef = id(row.authorization_ref, "stored authorization_ref", code), operationId = id(row.operation_id, "stored operation_id", code), workflowOperationId = id(row.workflow_operation_id, "stored workflow_operation_id", code);
  const stageIndex = nonnegative(row.stage_index, "stored stage_index", code); if (!(stageIndex === 12 || stageIndex === 13 || stageIndex === 14)) fail(code, "stored stage index is unsupported");
  const stageRaw = stageRequest(row.stage_request_json, code), stageSha = sha(row.stage_request_sha256, "stored stage request digest", code); if (await textDigest(stageRaw.raw) !== stageSha) fail(code, "stored W2 stage request digest differs from its bytes");
  const attemptRef = id(row.stage_attempt_ref, "stored stage attempt", code), workflowBudget = id(row.workflow_budget_receipt_ref, "stored workflow budget receipt", code);
  const storedIntent = intent(storedJson(row.intent_json, "stored intent"), code, "stored intent"), storedQuote = quote(storedJson(row.quote_json, "stored quote"), code, "stored quote"), storedAuthority = authority(storedJson(row.authority_json, "stored authority"), code, "stored authority");
  const storedDeployment = deployment(storedJson(row.expected_deployment_json, "stored deployment"), code, "stored deployment"), storedApproval = approval(storedJson(row.approval_json, "stored approval"), code);
  const intentId = id(row.intent_id, "stored intent id", code), intentRevision = bounded(row.intent_revision, "stored intent revision", code), reservationId = id(row.reservation_id, "stored reservation id", code), quoteRef = id(row.quote_ref, "stored quote ref", code), principalRef = id(row.principal_ref, "stored principal", code), clientClass = id(row.client_class, "stored client class", code), credentialGeneration = id(row.credential_generation, "stored credential generation", code), deploymentGeneration = id(row.deployment_generation, "stored deployment generation", code), policyDecisionRef = id(row.policy_decision_ref, "stored policy decision", code), policyGeneration = id(row.policy_generation, "stored policy generation", code), currentnessDigest = sha(row.currentness_digest, "stored currentness digest", code), scopeId = id(row.scope_snapshot_id, "stored scope id", code), scopeRevision = bounded(row.scope_snapshot_revision, "stored scope revision", code), workflowReceipt = id(row.workflow_authorization_receipt_ref, "stored workflow receipt", code), routeRef = id(row.route_ref, "stored route", code), admissionRevision = bounded(row.admission_revision, "stored admission revision", code), admissionSha = sha(row.admission_sha256, "stored admission digest", code), decisionDigest = sha(row.decision_digest, "stored decision digest", code), maxInput = bounded(row.max_input_bytes, "stored max_input_bytes", code), maxOutput = bounded(row.max_output_bytes, "stored max_output_bytes", code), expiresAt = time(row.expires_at, "stored expiry", code), createdAt = time(row.created_at, "stored creation time", code);
  if (admissionRevision !== 1 || Date.parse(expiresAt) <= Date.parse(createdAt) || storedApproval.expires_at !== expiresAt || Date.parse(expiresAt) > Date.parse(storedQuote.expires_at) || Date.parse(expiresAt) > Date.parse(storedAuthority.expires_at)) fail(code, "stored admission expiry is not bound to its approval");
  if (stageRaw.request.operation_id !== workflowOperationId || stageRaw.request.stage !== STAGES[stageIndex] || storedIntent.intent_ref.id !== intentId || storedIntent.intent_ref.revision !== intentRevision || storedIntent.principal_ref !== principalRef || storedIntent.policy_decision_ref !== policyDecisionRef || storedIntent.budget_reservation_ref !== reservationId || storedQuote.quote_ref !== quoteRef || storedQuote.reservation_id !== reservationId || storedQuote.operation_kind !== storedIntent.operation_kind || storedAuthority.principal_ref !== principalRef || storedAuthority.client_class !== clientClass || storedAuthority.credential_generation !== credentialGeneration || storedAuthority.deployment_generation !== deploymentGeneration || storedAuthority.policy_decision_ref !== policyDecisionRef || storedAuthority.policy_generation !== policyGeneration || storedAuthority.currentness_digest !== currentnessDigest || storedAuthority.scope_snapshot_ref.id !== scopeId || storedAuthority.scope_snapshot_ref.revision !== scopeRevision || storedDeployment.route_ref !== routeRef || storedApproval.authorization_ref !== authorizationRef || storedApproval.decision_digest !== decisionDigest || storedApproval.policy_decision_ref !== policyDecisionRef || storedApproval.policy_generation !== policyGeneration || storedApproval.currentness_digest !== currentnessDigest || !sameDeployment(storedApproval.expected_deployment, storedDeployment) || await approvalDigest(storedApproval) !== decisionDigest) fail(code, "stored spend admission fields disagree");
  const material = { request: { operation_id: operationId, stage_attempt_ref: attemptRef, stage_request_sha256: stageSha, reservation_id: reservationId, quote_ref: quoteRef, route_ref: routeRef, scope_snapshot_ref: { id: scopeId, revision: scopeRevision }, workflow_authorization_receipt_ref: workflowReceipt }, workflow_operation_id: workflowOperationId, stage_index: stageIndex as 12 | 13 | 14, stage_request_json: stageRaw.raw, workflow_budget_receipt_ref: workflowBudget, intent: storedIntent, quote: storedQuote, authority: storedAuthority, expected_deployment: storedDeployment, approval: storedApproval, max_input_bytes: maxInput, max_output_bytes: maxOutput, created_at: createdAt } as ResearchModelSpendAdmissionInput & { readonly created_at: string };
  if (await admissionDigest(material) !== admissionSha) fail(code, "stored admission digest differs from canonical bytes");
  return Object.freeze({ authorization_ref: authorizationRef, decision_digest: decisionDigest, operation_id: operationId, principal_ref: principalRef, stage_attempt_ref: attemptRef, stage_request_sha256: stageSha, reservation_id: reservationId, quote_ref: quoteRef, route_ref: routeRef, scope_snapshot_ref: Object.freeze({ id: scopeId, revision: scopeRevision }), workflow_authorization_receipt_ref: workflowReceipt, policy_generation: policyGeneration, currentness_digest: currentnessDigest, expires_at: expiresAt, expected_deployment: storedDeployment, admission_ref: Object.freeze({ id: authorizationRef, revision: admissionRevision }), admission_sha256: admissionSha, workflow_operation_id: workflowOperationId, stage_index: stageIndex as 12 | 13 | 14, stage_request_json: stageRaw.raw, workflow_budget_receipt_ref: workflowBudget, intent: storedIntent, quote: storedQuote, authority: storedAuthority, approval: storedApproval, max_input_bytes: maxInput, max_output_bytes: maxOutput, created_at: createdAt });
}

function assertRequest(record: ResearchModelSpendAdmissionRecord, request: SpendAuthorizationReadRequest): void {
  if (record.operation_id !== request.operation_id || record.principal_ref !== request.principal_ref || record.stage_attempt_ref !== request.stage_attempt_ref || record.stage_request_sha256 !== request.stage_request_sha256 || record.reservation_id !== request.reservation_id || record.quote_ref !== request.quote_ref || record.route_ref !== request.route_ref || !sameRef(record.scope_snapshot_ref, request.scope_snapshot_ref) || record.workflow_authorization_receipt_ref !== request.workflow_authorization_receipt_ref) fail("MODEL_ATTEMPT_IDENTITY_CONFLICT", "stored spend admission does not match the requested tuple");
}

async function current(dependency: ResearchModelSpendAdmissionOptions["read_current_authority"], request: SpendAuthorizationReadRequest): Promise<ResearchModelSpendCurrentAuthority | null> {
  let value: ResearchModelSpendCurrentAuthority | null;
  try { value = await dependency(request); } catch (cause) { if (cause instanceof ModelAttemptError) throw cause; fail("MODEL_ATTEMPT_AUTHORITY_STALE", "current spend authority could not be read", true, cause); }
  if (value === null) return null;
  return Object.freeze({ authority: authority(value.authority, "MODEL_ATTEMPT_AUTHORITY_STALE", "current spend authority"), expected_deployment: deployment(value.expected_deployment, "MODEL_ATTEMPT_AUTHORITY_STALE", "current spend deployment") });
}
function assertCurrent(value: ResearchModelSpendCurrentAuthority | null, expected: { readonly authority: ModelAttemptAuthority; readonly expected_deployment: ModelRouteDeployment }, nowMs: number): void {
  if (value === null || !sameAuthority(value.authority, expected.authority) || !sameDeployment(value.expected_deployment, expected.expected_deployment)) fail("MODEL_ATTEMPT_AUTHORITY_STALE", "current spend authority differs from the admitted decision", true);
  unexpired(value.authority.expires_at, nowMs, "current spend authority");
}

function rowBaseQuery(): string { return `SELECT ${columns("s")} FROM research_model_spend_admission s `; }
async function readPreparationRow(database: D1Database, input: ResearchSynthesisSpendAdmissionReadRequest): Promise<AdmissionRow | null> {
  return database.prepare(rowBaseQuery() + "JOIN research_workflow_current r ON r.operation_id=s.workflow_operation_id JOIN research_workflow_attempt w ON w.operation_id=r.operation_id AND w.stage_index=s.stage_index JOIN scope_access_grant g ON g.snapshot_id=r.scope_snapshot_id AND g.snapshot_revision=r.scope_snapshot_revision AND g.principal_ref=r.principal_ref WHERE s.workflow_operation_id=?1 AND s.stage_index=?2 AND s.stage_attempt_ref=?3 AND s.stage_request_sha256=?4 AND s.principal_ref=?5 AND s.credential_generation=?6 AND s.deployment_generation=?7 AND s.workflow_budget_receipt_ref=?8 AND r.state='ACTIVE' AND r.next_stage_index=s.stage_index AND r.current_revision=w.expected_revision AND r.ledger_revision=w.expected_revision AND w.state='STARTED' AND w.output_json IS NULL AND w.attempt_ref=s.stage_attempt_ref AND w.request_sha256=s.stage_request_sha256 AND w.budget_receipt_ref=s.workflow_budget_receipt_ref AND w.budget_expires_at_ms>CAST(unixepoch('subsec')*1000 AS INTEGER) AND json_extract(w.request_json,'$.protocol') IS 'eliotr.workflow-stage.v1' AND json_extract(w.request_json,'$.stage') IS CASE s.stage_index WHEN 12 THEN 'SYNTHESIZE' WHEN 14 THEN 'AUDIT_CLAIMS' END AND json_extract(w.request_json,'$.operation_id') IS r.operation_id AND json_extract(w.request_json,'$.investigation_ref.id') IS r.investigation_id AND json_extract(w.request_json,'$.investigation_ref.revision') IS r.current_revision AND r.principal_ref=s.principal_ref AND r.credential_generation=s.credential_generation AND r.deployment_generation=s.deployment_generation AND r.policy_generation=s.policy_generation AND r.scope_snapshot_id=s.scope_snapshot_id AND r.scope_snapshot_revision=s.scope_snapshot_revision AND r.authorization_receipt_ref=s.workflow_authorization_receipt_ref AND g.state='ACTIVE' AND g.credential_generation=s.credential_generation AND g.policy_authority_ref=r.policy_authority_ref AND g.authorization_receipt_ref=s.workflow_authorization_receipt_ref AND json_type(g.allowed_use_json)='array' AND EXISTS (SELECT 1 FROM json_each(g.allowed_use_json) u WHERE u.type='text' AND u.value='research') LIMIT 1").bind(input.operation_id, input.stage_index, input.stage_attempt_ref, input.stage_request_sha256, input.principal_ref, input.credential_generation, input.deployment_generation, input.workflow_budget_receipt_ref).first<AdmissionRow>();
}

function w3Query(): string {
  return rowBaseQuery() + ",i.intent_id AS w3_intent_id,i.revision AS w3_intent_revision,i.operation_kind AS w3_operation_kind,i.principal_ref AS w3_intent_principal_ref,i.idempotency_key AS w3_idempotency_key,i.policy_decision_ref AS w3_intent_policy_decision_ref,i.budget_reservation_ref AS w3_intent_reservation_id,b.state AS w3_reservation_state,b.principal_ref AS w3_reservation_principal_ref,b.idempotency_key AS w3_reservation_idempotency_key,b.policy_decision_ref AS w3_reservation_policy_decision_ref,b.credential_generation AS w3_reservation_credential_generation,b.deployment_generation AS w3_reservation_deployment_generation,b.quote_ref AS w3_reservation_quote_ref,b.stage_attempt_ref AS w3_reservation_stage_attempt_ref,b.stage_request_sha256 AS w3_reservation_stage_request_sha256,b.quote_json AS w3_reservation_quote_json,b.authority_json AS w3_reservation_authority_json,b.expires_at AS w3_reservation_expires_at,m.state AS w3_model_state,m.intent_id AS w3_model_intent_id,m.intent_revision AS w3_model_intent_revision,m.reservation_id AS w3_model_reservation_id,m.principal_ref AS w3_model_principal_ref,m.operation_kind AS w3_model_operation_kind,m.idempotency_key AS w3_model_idempotency_key,m.route_ref AS w3_model_route_ref,m.prompt_generation AS w3_model_prompt_generation,m.schema_generation AS w3_model_schema_generation,m.credential_generation AS w3_model_credential_generation,m.deployment_generation AS w3_model_deployment_generation,m.stage_attempt_ref AS w3_model_stage_attempt_ref,m.stage_request_sha256 AS w3_model_stage_request_sha256,m.output_object_ref AS w3_model_output_object_ref,oa.state AS w3_operation_attempt_state,w.budget_expires_at_ms AS w2_budget_expires_at_ms JOIN research_workflow_current r ON r.operation_id=s.workflow_operation_id JOIN research_workflow_attempt w ON w.operation_id=r.operation_id AND w.stage_index=s.stage_index JOIN scope_access_grant g ON g.snapshot_id=r.scope_snapshot_id AND g.snapshot_revision=r.scope_snapshot_revision AND g.principal_ref=r.principal_ref JOIN operation_intent i ON i.intent_id=s.intent_id AND i.revision=s.intent_revision JOIN budget_reservation b ON b.reservation_id=s.reservation_id JOIN research_model_attempt m ON m.intent_id=s.intent_id AND m.intent_revision=s.intent_revision AND m.reservation_id=s.reservation_id JOIN operation_attempt oa ON oa.attempt_id=m.attempt_id WHERE s.operation_id=?1 AND s.principal_ref=?2 AND s.stage_attempt_ref=?3 AND s.stage_request_sha256=?4 AND s.reservation_id=?5 AND s.quote_ref=?6 AND s.route_ref=?7 AND s.scope_snapshot_id=?8 AND s.scope_snapshot_revision=?9 AND s.workflow_authorization_receipt_ref=?10 AND r.state='ACTIVE' AND r.next_stage_index=s.stage_index AND r.current_revision=w.expected_revision AND r.ledger_revision=w.expected_revision AND w.state='STARTED' AND w.output_json IS NULL AND w.attempt_ref=s.stage_attempt_ref AND w.request_sha256=s.stage_request_sha256 AND w.budget_receipt_ref=s.workflow_budget_receipt_ref AND w.budget_expires_at_ms>CAST(unixepoch('subsec')*1000 AS INTEGER) AND r.principal_ref=s.principal_ref AND r.credential_generation=s.credential_generation AND r.deployment_generation=s.deployment_generation AND r.policy_generation=s.policy_generation AND r.scope_snapshot_id=s.scope_snapshot_id AND r.scope_snapshot_revision=s.scope_snapshot_revision AND r.authorization_receipt_ref=s.workflow_authorization_receipt_ref AND g.client_class=s.client_class AND g.credential_generation=s.credential_generation AND g.policy_authority_ref=r.policy_authority_ref AND g.authorization_receipt_ref=s.workflow_authorization_receipt_ref AND g.state='ACTIVE' AND json_type(g.allowed_use_json)='array' AND EXISTS (SELECT 1 FROM json_each(g.allowed_use_json) u WHERE u.type='text' AND u.value='research') AND i.operation_kind=json_extract(s.intent_json,'$.operation_kind') AND i.principal_ref=s.principal_ref AND i.idempotency_key=json_extract(s.intent_json,'$.idempotency_key') AND i.policy_decision_ref=s.policy_decision_ref AND i.budget_reservation_ref=s.reservation_id AND b.state='RESERVED' AND b.principal_ref=s.principal_ref AND b.idempotency_key=i.idempotency_key AND b.policy_decision_ref=s.policy_decision_ref AND b.credential_generation=s.credential_generation AND b.deployment_generation=s.deployment_generation AND b.quote_ref=s.quote_ref AND b.stage_attempt_ref=s.stage_attempt_ref AND b.stage_request_sha256=s.stage_request_sha256 AND m.state='STARTED' AND m.output_object_ref IS NULL AND m.intent_id=s.intent_id AND m.intent_revision=s.intent_revision AND m.reservation_id=s.reservation_id AND m.principal_ref=s.principal_ref AND m.operation_kind=i.operation_kind AND m.idempotency_key=i.idempotency_key AND m.route_ref=s.route_ref AND m.credential_generation=s.credential_generation AND m.deployment_generation=s.deployment_generation AND m.stage_attempt_ref=s.stage_attempt_ref AND m.stage_request_sha256=s.stage_request_sha256 AND oa.state='STARTED' LIMIT 1";
}

function assertW3(row: AdmissionRow, nowMs: number): void {
  const expected: readonly [unknown, unknown, string][] = [[row.w3_intent_id, row.intent_id, "W3 intent"], [row.w3_intent_revision, row.intent_revision, "W3 intent revision"], [row.w3_intent_principal_ref, row.principal_ref, "W3 intent principal"], [row.w3_intent_policy_decision_ref, row.policy_decision_ref, "W3 policy decision"], [row.w3_intent_reservation_id, row.reservation_id, "W3 intent reservation"], [row.w3_reservation_principal_ref, row.principal_ref, "W3 reservation principal"], [row.w3_reservation_idempotency_key, (JSON.parse(row.intent_json as string) as { idempotency_key?: unknown }).idempotency_key, "W3 reservation idempotency"], [row.w3_reservation_policy_decision_ref, row.policy_decision_ref, "W3 reservation policy"], [row.w3_reservation_credential_generation, row.credential_generation, "W3 reservation credential"], [row.w3_reservation_deployment_generation, row.deployment_generation, "W3 reservation deployment"], [row.w3_reservation_quote_ref, row.quote_ref, "W3 reservation quote"], [row.w3_reservation_stage_attempt_ref, row.stage_attempt_ref, "W3 reservation stage"], [row.w3_reservation_stage_request_sha256, row.stage_request_sha256, "W3 reservation request"], [row.w3_model_intent_id, row.intent_id, "W3 model intent"], [row.w3_model_intent_revision, row.intent_revision, "W3 model intent revision"], [row.w3_model_reservation_id, row.reservation_id, "W3 model reservation"], [row.w3_model_principal_ref, row.principal_ref, "W3 model principal"], [row.w3_model_route_ref, row.route_ref, "W3 model route"], [row.w3_model_credential_generation, row.credential_generation, "W3 model credential"], [row.w3_model_deployment_generation, row.deployment_generation, "W3 model deployment"], [row.w3_model_stage_attempt_ref, row.stage_attempt_ref, "W3 model stage"], [row.w3_model_stage_request_sha256, row.stage_request_sha256, "W3 model request"], [row.w3_reservation_state, "RESERVED", "W3 reservation state"], [row.w3_model_state, "STARTED", "W3 model state"], [row.w3_model_output_object_ref, null, "W3 output"], [row.w3_operation_attempt_state, "STARTED", "W3 operation attempt state"]];
  for (const [actual, expectedValue, label] of expected) if (actual !== expectedValue) fail("MODEL_ATTEMPT_IDENTITY_CONFLICT", `${label} does not match the admitted operation`);
  if (!Number.isSafeInteger(row.w2_budget_expires_at_ms) || (row.w2_budget_expires_at_ms as number) <= nowMs) fail("MODEL_ATTEMPT_BUDGET_EXPIRED", "W2 budget has expired");
  unexpired(time(row.w3_reservation_expires_at, "W3 reservation expiry", "MODEL_ATTEMPT_READBACK_CORRUPT"), nowMs, "W3 reservation");
}

function synthesisRecord(record: ResearchModelSpendAdmissionRecord, expected: ResearchSynthesisSpendAdmissionReadRequest): ResearchSynthesisSpendAdmissionRecord {
  const stage = stageRequest(record.stage_request_json, "MODEL_ATTEMPT_READBACK_CORRUPT").request;
  if (record.workflow_operation_id !== expected.operation_id || record.stage_index !== expected.stage_index || record.stage_attempt_ref !== expected.stage_attempt_ref || record.stage_request_sha256 !== expected.stage_request_sha256 || record.principal_ref !== expected.principal_ref || record.authority.credential_generation !== expected.credential_generation || record.authority.deployment_generation !== expected.deployment_generation || record.workflow_budget_receipt_ref !== expected.workflow_budget_receipt_ref || stage.operation_id !== expected.operation_id || stage.stage !== STAGES[expected.stage_index] || record.approval.authorization_ref !== record.authorization_ref) fail("MODEL_ATTEMPT_IDENTITY_CONFLICT", "spend admission does not match the exact W2 request");
  return Object.freeze({ ...expected, authorization_ref: record.authorization_ref, decision_digest: record.decision_digest, reservation_id: record.reservation_id, quote_ref: record.quote_ref, route_ref: record.route_ref, scope_snapshot_ref: record.scope_snapshot_ref, workflow_authorization_receipt_ref: record.workflow_authorization_receipt_ref, policy_generation: record.policy_generation, currentness_digest: record.currentness_digest, expires_at: record.expires_at, intent: record.intent, quote: record.quote, authority: record.authority, deployment: record.expected_deployment, max_input_bytes: record.max_input_bytes, max_output_bytes: record.max_output_bytes, admission_ref: record.admission_ref, admission_sha256: record.admission_sha256, created_at: record.created_at });
}

export function createD1ResearchModelSpendAdmissionPort(database: D1Database, options: ResearchModelSpendAdmissionOptions): ResearchModelSpendAdmissionPort {
  if (typeof database !== "object" || database === null || typeof database.prepare !== "function") fail("MODEL_ATTEMPT_INPUT_INVALID", "spend admission database binding is invalid");
  if (typeof options !== "object" || options === null || typeof options.read_current_authority !== "function") fail("MODEL_ATTEMPT_INPUT_INVALID", "spend admission authority reader is unavailable");
  const now = options.now ?? (() => Date.now());
  return Object.freeze({
    async admit(raw: ResearchModelSpendAdmissionInput): Promise<ResearchModelSpendAdmissionRecord> {
      const input = validateInput(raw); if (await textDigest(input.stage.raw) !== input.request.stage_request_sha256) fail("MODEL_ATTEMPT_INPUT_INVALID", "W2 stage request digest differs from its bytes");
      if (await approvalDigest(input.decision) !== input.decision.decision_digest) fail("MODEL_ATTEMPT_INPUT_INVALID", "spend approval digest does not match its canonical decision");
      const nowMs = clock(now); unexpired(input.decision.expires_at, nowMs, "spend approval");
      const before = await current(options.read_current_authority, input.request); if (before === null) fail("MODEL_ATTEMPT_AUTHORITY_STALE", "current spend authority is unavailable", true); assertCurrent(before, { authority: input.owner, expected_deployment: input.expected }, nowMs);
      const createdAt = new Date(nowMs).toISOString();
      const admissionSha = await admissionDigest({ ...raw, request: input.request, stage_request_json: input.stage.raw, intent: input.operation, quote: input.cost, authority: input.owner, expected_deployment: input.expected, approval: input.decision, created_at: createdAt });
      const statement = database.prepare(`INSERT INTO research_model_spend_admission(${columns()}) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19,?20,?21,?22,?23,?24,?25,?26,?27,?28,?29,?30,?31,?32,?33,?34,?35) ON CONFLICT(operation_id,stage_index) DO NOTHING RETURNING ${columns()}`).bind(input.decision.authorization_ref, input.request.operation_id, raw.workflow_operation_id, raw.stage_index, input.request.stage_attempt_ref, input.request.stage_request_sha256, input.stage.raw, raw.workflow_budget_receipt_ref, input.operation.intent_ref.id, input.operation.intent_ref.revision, canonical(input.operation, "intent", "MODEL_ATTEMPT_INPUT_INVALID"), input.cost.reservation_id, input.cost.quote_ref, canonical(input.cost, "quote", "MODEL_ATTEMPT_INPUT_INVALID"), canonical(input.owner, "authority", "MODEL_ATTEMPT_INPUT_INVALID"), input.owner.principal_ref, input.owner.client_class, input.owner.credential_generation, input.owner.deployment_generation, input.owner.policy_decision_ref, input.owner.policy_generation, input.owner.currentness_digest, input.owner.scope_snapshot_ref.id, input.owner.scope_snapshot_ref.revision, input.request.workflow_authorization_receipt_ref, input.expected.route_ref, canonical(input.expected, "expected deployment", "MODEL_ATTEMPT_INPUT_INVALID"), canonical(input.decision, "approval", "MODEL_ATTEMPT_INPUT_INVALID"), 1, admissionSha, input.decision.decision_digest, raw.max_input_bytes, raw.max_output_bytes, input.decision.expires_at, createdAt);
      let row: AdmissionRow | null = null; let writeError: unknown;
      try { row = await statement.first<AdmissionRow>(); } catch (cause) { writeError = cause; }
      if (row === null) {
        try { row = await database.prepare(`SELECT ${columns()} FROM research_model_spend_admission WHERE operation_id=?1 AND stage_index=?2 LIMIT 1`).bind(input.request.operation_id, raw.stage_index).first<AdmissionRow>(); } catch (cause) { fail("MODEL_ATTEMPT_SETTLEMENT_UNCERTAIN", "spend admission write readback is unavailable", true, { writeError, cause }); }
      }
      if (row === null) {
        const sameAuthorization = await database.prepare("SELECT authorization_ref FROM research_model_spend_admission WHERE authorization_ref=?1 LIMIT 1").bind(input.decision.authorization_ref).first<{ readonly authorization_ref: unknown }>();
        if (sameAuthorization !== null) fail("MODEL_ATTEMPT_IDENTITY_CONFLICT", "spend authorization is already bound to another operation");
        fail("MODEL_ATTEMPT_SETTLEMENT_UNCERTAIN", "spend admission write readback is missing", true, writeError);
      }
      const record = await decodeRow(row);
      const expectedAdmissionSha = await admissionDigest({ ...raw, request: input.request, stage_request_json: input.stage.raw, intent: input.operation, quote: input.cost, authority: input.owner, expected_deployment: input.expected, approval: input.decision, created_at: record.created_at });
      if (record.operation_id !== input.request.operation_id || record.workflow_operation_id !== raw.workflow_operation_id || record.stage_index !== raw.stage_index || record.stage_request_json !== input.stage.raw || record.authorization_ref !== input.decision.authorization_ref || record.admission_sha256 !== expectedAdmissionSha || record.max_input_bytes !== raw.max_input_bytes || record.max_output_bytes !== raw.max_output_bytes || !sameAuthority(record.authority, input.owner) || !sameDeployment(record.expected_deployment, input.expected) || canonicalJson(record.intent) !== canonicalJson(input.operation) || canonicalJson(record.quote) !== canonicalJson(input.cost)) fail("MODEL_ATTEMPT_IDENTITY_CONFLICT", "spend admission write readback differs from the trusted decision");
      const after = await current(options.read_current_authority, input.request); if (after === null) fail("MODEL_ATTEMPT_AUTHORITY_STALE", "current spend authority changed after admission", true); assertCurrent(after, record, clock(now)); return record;
    },
    async read(rawRequest: SpendAuthorizationReadRequest): Promise<SpendAuthorizationReadback | null> {
      const request = readRequest(rawRequest), nowMs = clock(now), before = await current(options.read_current_authority, request); if (before === null) return null;
      const row = await database.prepare(w3Query()).bind(request.operation_id, request.principal_ref, request.stage_attempt_ref, request.stage_request_sha256, request.reservation_id, request.quote_ref, request.route_ref, request.scope_snapshot_ref.id, request.scope_snapshot_ref.revision, request.workflow_authorization_receipt_ref).first<AdmissionRow>(); if (row === null) return null;
      const record = await decodeRow(row); assertRequest(record, request); assertW3(row, nowMs); unexpired(record.expires_at, nowMs, "spend admission"); assertCurrent(before, record, nowMs);
      const after = await current(options.read_current_authority, request); if (after === null) fail("MODEL_ATTEMPT_AUTHORITY_STALE", "current spend authority changed during spend read", true); assertCurrent(after, record, clock(now));
      return Object.freeze({ authorization_ref: record.authorization_ref, decision_digest: record.decision_digest, operation_id: record.operation_id, principal_ref: record.principal_ref, stage_attempt_ref: record.stage_attempt_ref, stage_request_sha256: record.stage_request_sha256, reservation_id: record.reservation_id, quote_ref: record.quote_ref, route_ref: record.route_ref, scope_snapshot_ref: record.scope_snapshot_ref, workflow_authorization_receipt_ref: record.workflow_authorization_receipt_ref, policy_generation: record.policy_generation, currentness_digest: record.currentness_digest, expires_at: record.expires_at, expected_deployment: record.expected_deployment });
    },
    async readPreparation(rawInput: ResearchSynthesisSpendAdmissionReadRequest): Promise<ResearchSynthesisSpendAdmissionRecord | null> {
      const input = preparationRequest(rawInput), row = await readPreparationRow(database, input); if (row === null) return null;
      const record = await decodeRow(row), request = readRequest({ operation_id: record.operation_id, principal_ref: record.principal_ref, stage_attempt_ref: record.stage_attempt_ref, stage_request_sha256: record.stage_request_sha256, reservation_id: record.reservation_id, quote_ref: record.quote_ref, route_ref: record.route_ref, scope_snapshot_ref: record.scope_snapshot_ref, workflow_authorization_receipt_ref: record.workflow_authorization_receipt_ref });
      const before = await current(options.read_current_authority, request); if (before === null) fail("MODEL_ATTEMPT_AUTHORITY_STALE", "current spend authority is unavailable", true); assertCurrent(before, record, clock(now));
      const synthesis = synthesisRecord(record, input); const after = await current(options.read_current_authority, request); if (after === null) fail("MODEL_ATTEMPT_AUTHORITY_STALE", "current spend authority changed during preparation read", true); assertCurrent(after, record, clock(now)); return synthesis;
    },
  });
}
