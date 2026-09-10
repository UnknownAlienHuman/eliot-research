import {
  WORKSPACE_MCP_OBSERVATION_V2_PROTOCOL,
  WORKSPACE_MCP_PLAN_V2_PROTOCOL,
  WorkspaceMcpObservationV2Schema,
  WorkspaceMcpPlanV2InputSchema,
  WorkspaceMcpPlanV2Schema,
  WorkspaceMcpPlanV2ResultSchema,
  WorkspaceMcpReceiptV2Schema,
  type WorkspaceMcpObservationV2,
  type WorkspaceMcpPlanV2,
  type WorkspaceMcpPlanV2Result,
  type WorkspaceMcpReceiptV2,
} from "@eliotr/contracts";
import type { McpToolCallContext } from "./gemini-mcp-protocol.js";
import {
  GeminiMcpToolError,
  boundedString,
  identifier,
  isoDate,
  optionalSha256,
  sha256,
  stable,
  strictRecord,
  type GeminiMcpToolDependencies,
} from "./gemini-mcp-tool-common.js";
import type {
  WorkspaceMcpCandidateStore,
  WorkspaceMcpPlanStoreResult,
  WorkspaceMcpObservationStoreResult,
} from "./workspace-mcp-ledger.js";

const PLAN_TTL_MS = 15 * 60 * 1000;
const MAX_DATE_MS = 8_640_000_000_000_000;
const WORKSPACE_RECEIPT_KEYS = new Set([
  "connector", "google_product", "action", "resource_id", "observed_revision",
  "observed_at", "readback_performed", "readback_payload_sha256", "status",
]);

function asZod<T>(schema: { safeParse(value: unknown): { success: boolean; data?: T } }, value: unknown, label: string): T {
  const result = schema.safeParse(value);
  if (!result.success || result.data === undefined) throw new GeminiMcpToolError("INPUT_INVALID", `${label} is malformed`);
  return result.data;
}

function nowMs(now: () => number): number {
  const value = now();
  if (!Number.isSafeInteger(value) || value < 0 || value > MAX_DATE_MS - PLAN_TTL_MS) {
    throw new GeminiMcpToolError("CLOCK_INVALID", "clock returned an invalid value", true);
  }
  return value;
}

function profile(dependencies: GeminiMcpToolDependencies): "service-token" | "managed-oauth" {
  return dependencies.mcp_auth_profile ?? "service-token";
}

function v2Input(value: unknown) {
  const record = strictRecord(value, new Set([
    "protocol", "idempotency_key", "google_product", "action", "direction",
    "source_ref", "target_ref", "expected_revision", "payload_sha256", "dry_run",
  ]), "Workspace MCP v2 plan input");
  const normalized = {
    protocol: record.protocol,
    idempotency_key: identifier(record.idempotency_key, "idempotency_key"),
    google_product: record.google_product,
    action: record.action,
    direction: record.direction,
    ...(record.source_ref === undefined ? {} : { source_ref: identifier(record.source_ref, "source_ref") }),
    ...(record.target_ref === undefined ? {} : { target_ref: boundedString(record.target_ref, "target_ref", 2048) }),
    ...(record.expected_revision === undefined ? {} : { expected_revision: identifier(record.expected_revision, "expected_revision") }),
    ...(record.payload_sha256 === undefined ? {} : { payload_sha256: optionalSha256(record.payload_sha256, "payload_sha256") }),
    dry_run: record.dry_run,
  };
  return asZod(WorkspaceMcpPlanV2InputSchema, normalized, "Workspace MCP v2 plan input");
}

function planWithoutDigest(plan: WorkspaceMcpPlanV2): Record<string, unknown> {
  const { plan_sha256: _ignored, ...rest } = plan;
  return rest;
}

function planForStore(result: WorkspaceMcpPlanStoreResult): WorkspaceMcpPlanV2 {
  if (result.state !== "COMMITTED" && result.state !== "REPLAY") {
    throw new GeminiMcpToolError("WORKSPACE_LEDGER_UNAVAILABLE", "Workspace candidate ledger write did not commit", true);
  }
  return asZod(WorkspaceMcpPlanV2Schema, result.plan, "stored Workspace MCP plan");
}

function unknownPlan(input: ReturnType<typeof v2Input>, inputFingerprint: string, planId: string): WorkspaceMcpPlanV2Result {
  const result = {
    protocol: WORKSPACE_MCP_PLAN_V2_PROTOCOL,
    state: "UNKNOWN" as const,
    idempotency_key: input.idempotency_key,
    input_fingerprint: inputFingerprint,
    plan_id: planId,
    reconciliation: {
      idempotency_key: input.idempotency_key,
      plan_id: planId,
      write_state: "UNKNOWN" as const,
      retry: "SAME_KEY" as const,
    },
  };
  return asZod(WorkspaceMcpPlanV2ResultSchema, result, "unknown Workspace MCP plan result");
}

export async function createWorkspacePlan(
  input: unknown,
  dependencies: GeminiMcpToolDependencies,
  context: McpToolCallContext,
): Promise<WorkspaceMcpPlanV2Result> {
  if (dependencies.google_transport !== "gemini-mcp") {
    throw new GeminiMcpToolError("GOOGLE_TRANSPORT_DISABLED", "Gemini MCP Google orchestration is disabled");
  }
  const decoded = v2Input(input);
  const authProfile = profile(dependencies);
  const inputFingerprint = await sha256(JSON.stringify(stable(decoded)));
  const planId = `workspace-mcp-plan-${await sha256(JSON.stringify(stable([
    "eliotr.workspace-mcp.plan-id.v2", context.principal_ref, context.deployment_generation,
    authProfile, "gemini-mcp", decoded.idempotency_key,
  ])))}`;
  const issuedMs = nowMs(dependencies.now);
  const issuedAt = new Date(issuedMs).toISOString();
  const expiresAt = new Date(issuedMs + PLAN_TTL_MS).toISOString();
  const planBase = {
    ...decoded,
    plan_id: planId,
    input_fingerprint: inputFingerprint,
    issued_at: issuedAt,
    expires_at: expiresAt,
    deployment_generation: context.deployment_generation,
    auth_profile: authProfile,
    google_transport: "gemini-mcp" as const,
    connector: "google-workspace" as const,
    candidate_only: true as const,
    effect_ceiling: "NO_EXTERNAL_EFFECT" as const,
    candidate_ledger_mutation: "ISSUED" as const,
    exact_readback_required: true as const,
    eliot_authority_changed: false as const,
    confirmation_required: ["create", "append", "update"].includes(decoded.action),
    required_readback_fields: ["resource_id", "observed_revision", "observed_at", "readback_performed"],
  };
  const planSha = await sha256(JSON.stringify(stable(planBase)));
  const plan = asZod(WorkspaceMcpPlanV2Schema, { ...planBase, plan_sha256: planSha }, "Workspace MCP v2 plan");
  const store = dependencies.workspaceCandidateStore;
  if (store === undefined) throw new GeminiMcpToolError("WORKSPACE_LEDGER_UNAVAILABLE", "Workspace candidate ledger is not configured", true);
  const result = await store.issuePlan({
    principal_ref: context.principal_ref,
    deployment_generation: context.deployment_generation,
    auth_profile: authProfile,
    google_transport: "gemini-mcp",
    idempotency_key: decoded.idempotency_key,
    input_fingerprint: inputFingerprint,
    plan_id: planId,
    plan_sha256: planSha,
    issued_at: issuedAt,
    expires_at: expiresAt,
    plan,
  });
  if (result.state === "CONFLICT") throw new GeminiMcpToolError(result.code, result.code === "PLAN_EXPIRED" ? "Idempotency key has expired; use a new key" : "Idempotency key is bound to different intent");
  if (result.state === "UNKNOWN") return unknownPlan(decoded, inputFingerprint, result.plan_id ?? planId);
  return { ...planForStore(result), state: "ISSUED" };
}

function receiptInput(value: unknown): WorkspaceMcpReceiptV2 {
  const record = strictRecord(value, new Set(["plan", "receipt"]), "Workspace MCP v2 receipt input");
  const receipt = strictRecord(record.receipt, WORKSPACE_RECEIPT_KEYS, "Workspace MCP v2 receipt");
  const normalized = {
    connector: receipt.connector,
    google_product: receipt.google_product,
    action: receipt.action,
    resource_id: boundedString(receipt.resource_id, "receipt.resource_id", 2048),
    observed_revision: identifier(receipt.observed_revision, "receipt.observed_revision"),
    observed_at: isoDate(receipt.observed_at, "receipt.observed_at"),
    readback_performed: receipt.readback_performed,
    ...(receipt.readback_payload_sha256 === undefined ? {} : { readback_payload_sha256: optionalSha256(receipt.readback_payload_sha256, "receipt.readback_payload_sha256") }),
    ...(receipt.status === undefined ? {} : { status: boundedString(receipt.status, "receipt.status", 8192, false) }),
  };
  return asZod(WorkspaceMcpReceiptV2Schema, normalized, "Workspace MCP v2 receipt");
}

function planFromCaller(value: unknown): WorkspaceMcpPlanV2 {
  if (typeof value === "object" && value !== null && (value as Record<string, unknown>).state === "ISSUED") {
    const { state: _state, ...plan } = value as Record<string, unknown>;
    return asZod(WorkspaceMcpPlanV2Schema, plan, "Workspace MCP v2 plan");
  }
  return asZod(WorkspaceMcpPlanV2Schema, value, "Workspace MCP v2 plan");
}

function reasonCodes(plan: WorkspaceMcpPlanV2, receipt: WorkspaceMcpReceiptV2, now: number): string[] {
  const reasons: string[] = [];
  if (receipt.status === "UNKNOWN") reasons.push("OBSERVATION_DISPOSITION_UNKNOWN");
  if (Date.parse(plan.issued_at) > now) reasons.push("PLAN_NOT_YET_VALID");
  if (Date.parse(plan.expires_at) <= now) reasons.push("PLAN_EXPIRED");
  if (receipt.connector !== plan.connector) reasons.push("CONNECTOR_MISMATCH");
  if (receipt.google_product !== plan.google_product) reasons.push("PRODUCT_MISMATCH");
  if (receipt.action !== plan.action) reasons.push("ACTION_MISMATCH");
  if (plan.target_ref !== undefined && receipt.resource_id !== plan.target_ref) reasons.push("RESOURCE_ID_MISMATCH");
  if (plan.target_ref === undefined) reasons.push("RESOURCE_IDENTITY_UNBOUND");
  if (!receipt.readback_performed) reasons.push("EXACT_READBACK_MISSING");
  const observed = Date.parse(receipt.observed_at);
  if (observed < Date.parse(plan.issued_at) || observed > now || observed >= Date.parse(plan.expires_at)) reasons.push("OBSERVATION_TIME_INVALID");
  if (plan.expected_revision !== undefined && receipt.observed_revision !== plan.expected_revision) reasons.push("REVISION_MISMATCH");
  if (plan.payload_sha256 !== undefined && receipt.readback_payload_sha256 !== plan.payload_sha256) reasons.push("PAYLOAD_DIGEST_MISMATCH");
  return reasons;
}

export async function validateWorkspaceReceipt(
  input: unknown,
  dependencies: GeminiMcpToolDependencies,
  context: McpToolCallContext,
): Promise<WorkspaceMcpObservationV2> {
  if (dependencies.google_transport !== "gemini-mcp") throw new GeminiMcpToolError("GOOGLE_TRANSPORT_DISABLED", "Gemini MCP Google orchestration is disabled");
  const root = strictRecord(input, new Set(["plan", "receipt"]), "Workspace MCP v2 receipt input");
  const callerPlan = planFromCaller(root.plan);
  const receipt = receiptInput(input);
  const store = dependencies.workspaceCandidateStore;
  if (store === undefined) throw new GeminiMcpToolError("WORKSPACE_LEDGER_UNAVAILABLE", "Workspace candidate ledger is not configured", true);
  const lookup = await store.loadPlan({
    principal_ref: context.principal_ref,
    deployment_generation: context.deployment_generation,
    auth_profile: profile(dependencies),
    google_transport: "gemini-mcp",
    idempotency_key: callerPlan.idempotency_key,
    plan_id: callerPlan.plan_id,
  });
  if (lookup.state === "UNKNOWN") throw new GeminiMcpToolError("WORKSPACE_LEDGER_UNAVAILABLE", "Workspace candidate ledger read is uncertain", true);
  if (lookup.state === "NOT_FOUND") throw new GeminiMcpToolError("PLAN_NOT_FOUND", "Workspace MCP plan is not an issued ledger record");
  const issuedPlan = asZod(WorkspaceMcpPlanV2Schema, lookup.plan, "stored Workspace MCP plan");
  if (JSON.stringify(stable(issuedPlan)) !== JSON.stringify(stable(callerPlan))) throw new GeminiMcpToolError("PLAN_BINDING_MISMATCH", "Workspace MCP plan does not match the issued ledger record");
  const reasons = reasonCodes(issuedPlan, receipt, nowMs(dependencies.now));
  const receiptSha = await sha256(JSON.stringify(stable(receipt)));
  const observationId = `workspace-mcp-observation-${await sha256(JSON.stringify(stable([
    "eliotr.workspace-mcp.observation-id.v2", issuedPlan.plan_id, receiptSha,
  ])))}`;
  const observationBase = {
    protocol: WORKSPACE_MCP_OBSERVATION_V2_PROTOCOL,
    observation_id: observationId,
    plan_id: issuedPlan.plan_id,
    idempotency_key: issuedPlan.idempotency_key,
    plan_sha256: issuedPlan.plan_sha256,
    state: "OBSERVED" as const,
    disposition: receipt.status === "UNKNOWN"
      ? "UNKNOWN" as const
      : reasons.length === 0 ? "OBSERVED_MATCH" as const : "OBSERVED_MISMATCH" as const,
    receipt_sha256: receiptSha,
    reason_codes: reasons,
    candidate_only: true as const,
    source_evidence_authority_changed: false as const,
    candidate_ledger_mutation: "OBSERVED" as const,
    reconciliation: { idempotency_key: issuedPlan.idempotency_key, plan_id: issuedPlan.plan_id, plan_sha256: issuedPlan.plan_sha256, write_state: "COMMITTED" as const, retry: "SAME_KEY" as const },
  };
  const observation = asZod(WorkspaceMcpObservationV2Schema, observationBase, "Workspace MCP v2 observation");
  const observationSha = await sha256(JSON.stringify(stable(observation)));
  const stored = await store.recordObservation({
    principal_ref: context.principal_ref,
    deployment_generation: context.deployment_generation,
    auth_profile: profile(dependencies),
    google_transport: "gemini-mcp",
    idempotency_key: issuedPlan.idempotency_key,
    plan_id: issuedPlan.plan_id,
    plan_sha256: issuedPlan.plan_sha256,
    observation_id: observationId,
    observation_sha256: observationSha,
    receipt_sha256: receiptSha,
    disposition: observation.disposition as "OBSERVED_MATCH" | "OBSERVED_MISMATCH" | "UNKNOWN",
    reason_codes: reasons,
    receipt,
    observation,
    observed_at: receipt.observed_at,
  });
  if (stored.state === "UNKNOWN") {
    return asZod(WorkspaceMcpObservationV2Schema, {
      ...observationBase,
      state: "UNKNOWN",
      disposition: "UNKNOWN",
      receipt_sha256: undefined,
      candidate_ledger_mutation: undefined,
      reason_codes: ["OBSERVATION_WRITE_UNKNOWN"],
      reconciliation: { idempotency_key: issuedPlan.idempotency_key, plan_id: issuedPlan.plan_id, plan_sha256: issuedPlan.plan_sha256, write_state: "UNKNOWN", retry: "SAME_KEY" },
    }, "unknown Workspace MCP observation");
  }
  return asZod(WorkspaceMcpObservationV2Schema, stored.observation, "stored Workspace MCP observation");
}
