import type { McpToolCallContext } from "./gemini-mcp-protocol.js";
import {
  GOOGLE_ACTIONS,
  GOOGLE_PRODUCTS,
  IDENTIFIER,
  MAX_IDENTIFIER_BYTES,
  MAX_STATUS_BYTES,
  MAX_TARGET_REF_BYTES,
  MUTATING_ACTIONS,
  GeminiMcpToolError,
  boundedString,
  decodePlanInput,
  enumValue,
  identifier,
  isoDate,
  optionalSha256,
  readbackFields,
  sha256,
  stable,
  strictRecord,
  type GeminiMcpToolDependencies,
  type GoogleSyncPlan,
  type GoogleSyncReceiptInput,
} from "./gemini-mcp-tool-common.js";

export async function createPlan(
  input: unknown,
  dependencies: GeminiMcpToolDependencies,
  context: McpToolCallContext,
): Promise<GoogleSyncPlan> {
  if (dependencies.google_transport !== "gemini-mcp") {
    throw new GeminiMcpToolError(
      "GOOGLE_TRANSPORT_DISABLED",
      dependencies.google_transport === "drive-exchange"
        ? "Gemini MCP Google orchestration is disabled while Drive Exchange owns the external transport"
        : "Gemini MCP Google orchestration is disabled",
    );
  }
  const decoded = decodePlanInput(input);
  if (decoded.google_product === "cloud" && decoded.google_project_id === undefined) {
    throw new GeminiMcpToolError("INPUT_INVALID", "google_project_id is required for Google Cloud plans");
  }
  const identity = {
    protocol: "eliotr.google-sync.plan-identity.v1",
    principal_ref: context.principal_ref,
    deployment_generation: context.deployment_generation,
    ...decoded,
  };
  const planId = `google-sync-${(await sha256(JSON.stringify(stable(identity)))).slice(0, 48)}`;
  const createdAtMs = dependencies.now();
  if (!Number.isFinite(createdAtMs) || createdAtMs < 0) {
    throw new GeminiMcpToolError("CLOCK_INVALID", "clock returned an invalid value", true);
  }
  const mutating = MUTATING_ACTIONS.has(decoded.action);
  const connector = decoded.google_product === "cloud" ? "gcloud" : "google-workspace";
  return {
    protocol: "eliotr.google-sync.plan.v1",
    plan_id: planId,
    connector,
    created_at: new Date(createdAtMs).toISOString(),
    expires_at: new Date(createdAtMs + 15 * 60 * 1000).toISOString(),
    candidate_only: true,
    effect_ceiling: "NO_EXTERNAL_EFFECT",
    confirmation_required: mutating,
    exact_readback_required: true,
    eliot_authority_changed: false,
    required_readback_fields: readbackFields(decoded.google_product),
    steps: [
      "Review this plan and the exact Google effect.",
      mutating ? "Obtain explicit user confirmation before invoking the Google tool." : "Invoke only the required read-only Google tool.",
      `Use the official ${connector} MCP extension for the external action.`,
      "Read back the exact Google resource after the action.",
      "Submit the normalized readback receipt to eliotr_validate_google_sync_receipt.",
      "Treat the validated receipt as a transport observation until an ELIOT authority path admits it.",
    ],
    ...decoded,
  };
}

function decodePlan(value: unknown): GoogleSyncPlan {
  const allowed = new Set([
    "protocol",
    "plan_id",
    "connector",
    "created_at",
    "expires_at",
    "candidate_only",
    "effect_ceiling",
    "confirmation_required",
    "exact_readback_required",
    "eliot_authority_changed",
    "required_readback_fields",
    "steps",
    "google_product",
    "action",
    "direction",
    "source_ref",
    "target_ref",
    "google_project_id",
    "expected_revision",
    "payload_sha256",
    "dry_run",
  ]);
  const record = strictRecord(value, allowed, "sync plan");
  const decodedInput = decodePlanInput({
    google_product: record.google_product,
    action: record.action,
    direction: record.direction,
    source_ref: record.source_ref,
    target_ref: record.target_ref,
    google_project_id: record.google_project_id,
    expected_revision: record.expected_revision,
    payload_sha256: record.payload_sha256,
    dry_run: record.dry_run,
  });
  if (
    record.protocol !== "eliotr.google-sync.plan.v1" ||
    typeof record.plan_id !== "string" ||
    !IDENTIFIER.test(record.plan_id) ||
    (record.connector !== "google-workspace" && record.connector !== "gcloud") ||
    record.candidate_only !== true ||
    record.effect_ceiling !== "NO_EXTERNAL_EFFECT" ||
    typeof record.confirmation_required !== "boolean" ||
    record.exact_readback_required !== true ||
    record.eliot_authority_changed !== false ||
    !Array.isArray(record.required_readback_fields) ||
    !Array.isArray(record.steps)
  ) {
    throw new GeminiMcpToolError("INPUT_INVALID", "sync plan is malformed");
  }
  const createdAt = isoDate(record.created_at, "plan.created_at");
  const expiresAt = isoDate(record.expires_at, "plan.expires_at");
  if (Date.parse(expiresAt) <= Date.parse(createdAt)) {
    throw new GeminiMcpToolError("INPUT_INVALID", "sync plan expiry is invalid");
  }
  const expectedConnector = decodedInput.google_product === "cloud" ? "gcloud" : "google-workspace";
  if (record.connector !== expectedConnector) {
    throw new GeminiMcpToolError("INPUT_INVALID", "sync plan connector does not match the Google product");
  }
  return {
    protocol: "eliotr.google-sync.plan.v1",
    plan_id: record.plan_id,
    connector: record.connector,
    created_at: createdAt,
    expires_at: expiresAt,
    candidate_only: true,
    effect_ceiling: "NO_EXTERNAL_EFFECT",
    confirmation_required: record.confirmation_required,
    exact_readback_required: true,
    eliot_authority_changed: false,
    required_readback_fields: record.required_readback_fields as readonly string[],
    steps: record.steps as readonly string[],
    ...decodedInput,
  };
}

function decodeReceiptInput(input: unknown): GoogleSyncReceiptInput {
  const root = strictRecord(input, new Set(["plan", "receipt"]), "receipt validation input");
  const plan = decodePlan(root.plan);
  const receipt = strictRecord(root.receipt, new Set([
    "connector",
    "google_product",
    "action",
    "resource_id",
    "observed_revision",
    "observed_at",
    "readback_performed",
    "readback_payload_sha256",
    "google_project_id",
    "status",
  ]), "Google readback receipt");
  const connector = enumValue(receipt.connector, ["google-workspace", "gcloud"] as const, "receipt.connector");
  const product = enumValue(receipt.google_product, GOOGLE_PRODUCTS, "receipt.google_product");
  const action = enumValue(receipt.action, GOOGLE_ACTIONS, "receipt.action");
  const resourceId = boundedString(receipt.resource_id, "receipt.resource_id", MAX_TARGET_REF_BYTES);
  const revision = boundedString(receipt.observed_revision, "receipt.observed_revision", MAX_IDENTIFIER_BYTES);
  const observedAt = isoDate(receipt.observed_at, "receipt.observed_at");
  const payloadSha = optionalSha256(receipt.readback_payload_sha256, "receipt.readback_payload_sha256");
  const projectId = identifier(receipt.google_project_id, "receipt.google_project_id", false);
  const status = boundedString(receipt.status, "receipt.status", MAX_STATUS_BYTES, false);
  return {
    plan,
    receipt: {
      connector,
      google_product: product,
      action,
      resource_id: resourceId as string,
      observed_revision: revision as string,
      observed_at: observedAt,
      readback_performed: receipt.readback_performed === true,
      ...(payloadSha === undefined ? {} : { readback_payload_sha256: payloadSha }),
      ...(projectId === undefined ? {} : { google_project_id: projectId }),
      ...(status === undefined ? {} : { status }),
    },
  };
}

export async function validateReceipt(
  input: unknown,
  dependencies: GeminiMcpToolDependencies,
  context: McpToolCallContext,
): Promise<Record<string, unknown>> {
  if (dependencies.google_transport !== "gemini-mcp") {
    throw new GeminiMcpToolError("GOOGLE_TRANSPORT_DISABLED", "Gemini MCP Google orchestration is disabled");
  }
  const decoded = decodeReceiptInput(input);
  const planIdentity = {
    protocol: "eliotr.google-sync.plan-identity.v1",
    principal_ref: context.principal_ref,
    deployment_generation: context.deployment_generation,
    google_product: decoded.plan.google_product,
    action: decoded.plan.action,
    direction: decoded.plan.direction,
    dry_run: true,
    ...(decoded.plan.source_ref === undefined ? {} : { source_ref: decoded.plan.source_ref }),
    ...(decoded.plan.target_ref === undefined ? {} : { target_ref: decoded.plan.target_ref }),
    ...(decoded.plan.google_project_id === undefined ? {} : { google_project_id: decoded.plan.google_project_id }),
    ...(decoded.plan.expected_revision === undefined ? {} : { expected_revision: decoded.plan.expected_revision }),
    ...(decoded.plan.payload_sha256 === undefined ? {} : { payload_sha256: decoded.plan.payload_sha256 }),
  };
  const expectedPlanId = `google-sync-${(await sha256(JSON.stringify(stable(planIdentity)))).slice(0, 48)}`;
  const reasons: string[] = [];
  if (decoded.plan.plan_id !== expectedPlanId) reasons.push("PLAN_ID_MISMATCH");
  if (Date.parse(decoded.plan.expires_at) < dependencies.now()) reasons.push("PLAN_EXPIRED");
  if (decoded.receipt.connector !== decoded.plan.connector) reasons.push("CONNECTOR_MISMATCH");
  if (decoded.receipt.google_product !== decoded.plan.google_product) reasons.push("PRODUCT_MISMATCH");
  if (decoded.receipt.action !== decoded.plan.action) reasons.push("ACTION_MISMATCH");
  if (!decoded.receipt.readback_performed) reasons.push("EXACT_READBACK_MISSING");
  if (
    decoded.plan.google_project_id !== undefined &&
    decoded.receipt.google_project_id !== decoded.plan.google_project_id
  ) reasons.push("GOOGLE_PROJECT_MISMATCH");
  if (
    decoded.plan.payload_sha256 !== undefined &&
    decoded.receipt.readback_payload_sha256 !== decoded.plan.payload_sha256
  ) reasons.push("PAYLOAD_DIGEST_MISMATCH");

  return {
    protocol: "eliotr.google-sync.observation.v1",
    plan_id: decoded.plan.plan_id,
    validated: reasons.length === 0,
    reason_codes: reasons,
    disposition: reasons.length === 0 ? "OBSERVED_MATCH" : "OBSERVED_MISMATCH",
    resource_id: decoded.receipt.resource_id,
    observed_revision: decoded.receipt.observed_revision,
    observed_at: decoded.receipt.observed_at,
    candidate_only: true,
    google_readback_performed_by_eliotr: false,
    canonical_eliot_state_changed: false,
    authority_reconciliation_required: true,
  };
}

