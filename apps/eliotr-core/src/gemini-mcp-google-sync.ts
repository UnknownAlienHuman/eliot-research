import type { McpToolCallContext } from "./gemini-mcp-protocol.js";
import {
  GOOGLE_ACTIONS,
  GOOGLE_PRODUCTS,
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

const PLAN_TTL_MS = 15 * 60 * 1000;
const MAX_DATE_MS = 8_640_000_000_000_000;

function observedTime(now: () => number): number {
  const value = now();
  if (!Number.isSafeInteger(value) || value < 0 || value > MAX_DATE_MS) {
    throw new GeminiMcpToolError("CLOCK_INVALID", "clock returned an invalid value", true);
  }
  return value;
}

function planSteps(connector: GoogleSyncPlan["connector"], mutating: boolean): readonly string[] {
  return [
    "Review this plan and the exact Google effect.",
    mutating ? "Obtain explicit user confirmation before invoking the Google tool." : "Invoke only the required read-only Google tool.",
    `Use the official ${connector} MCP extension for the external action.`,
    "Read back the exact Google resource after the action.",
    "Submit the normalized readback receipt to eliotr_validate_google_sync_receipt.",
    "Treat the validated receipt as a transport observation until an ELIOT authority path admits it.",
  ];
}

function exactStrings(raw: unknown, expected: readonly string[]): boolean {
  return Array.isArray(raw) && raw.length === expected.length && expected.every((value, index) => raw[index] === value);
}

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
  const createdAtMs = observedTime(dependencies.now);
  if (createdAtMs > MAX_DATE_MS - PLAN_TTL_MS) {
    throw new GeminiMcpToolError("CLOCK_INVALID", "clock returned an invalid value", true);
  }
  const mutating = MUTATING_ACTIONS.has(decoded.action);
  const connector = decoded.google_product === "cloud" ? "gcloud" : "google-workspace";
  return {
    protocol: "eliotr.google-sync.plan.v1",
    plan_id: planId,
    connector,
    created_at: new Date(createdAtMs).toISOString(),
    expires_at: new Date(createdAtMs + PLAN_TTL_MS).toISOString(),
    candidate_only: true,
    effect_ceiling: "NO_EXTERNAL_EFFECT",
    confirmation_required: mutating,
    exact_readback_required: true,
    eliot_authority_changed: false,
    required_readback_fields: readbackFields(decoded.google_product),
    steps: planSteps(connector, mutating),
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
    !/^google-sync-[a-f0-9]{48}$/u.test(record.plan_id) ||
    (record.connector !== "google-workspace" && record.connector !== "gcloud") ||
    record.candidate_only !== true ||
    record.effect_ceiling !== "NO_EXTERNAL_EFFECT" ||
    typeof record.confirmation_required !== "boolean" ||
    record.exact_readback_required !== true ||
    record.eliot_authority_changed !== false ||
    record.dry_run !== true ||
    !Array.isArray(record.required_readback_fields) ||
    !Array.isArray(record.steps)
  ) {
    throw new GeminiMcpToolError("INPUT_INVALID", "sync plan is malformed");
  }
  const createdAt = isoDate(record.created_at, "plan.created_at");
  const expiresAt = isoDate(record.expires_at, "plan.expires_at");
  if (Date.parse(expiresAt) - Date.parse(createdAt) !== PLAN_TTL_MS) {
    throw new GeminiMcpToolError("INPUT_INVALID", "sync plan expiry is invalid");
  }
  const expectedConnector = decodedInput.google_product === "cloud" ? "gcloud" : "google-workspace";
  const mutating = MUTATING_ACTIONS.has(decodedInput.action);
  if (record.connector !== expectedConnector || record.confirmation_required !== mutating ||
      !exactStrings(record.required_readback_fields, readbackFields(decodedInput.google_product)) ||
      !exactStrings(record.steps, planSteps(expectedConnector, mutating))) {
    throw new GeminiMcpToolError("INPUT_INVALID", "sync plan descriptors do not match its declared operation");
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
  if (typeof receipt.readback_performed !== "boolean") {
    throw new GeminiMcpToolError("INPUT_INVALID", "receipt.readback_performed must be boolean");
  }
  return {
    plan,
    receipt: {
      connector,
      google_product: product,
      action,
      resource_id: resourceId as string,
      observed_revision: revision as string,
      observed_at: observedAt,
      readback_performed: receipt.readback_performed,
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
  // v1 plans and receipts are supplied by the caller, not signed issuance records.
  // These checks establish internal consistency only, never that a Google effect occurred.
  const now = observedTime(dependencies.now);
  const created = Date.parse(decoded.plan.created_at);
  const expiry = Date.parse(decoded.plan.expires_at);
  const observed = Date.parse(decoded.receipt.observed_at);
  if (decoded.plan.plan_id !== expectedPlanId) reasons.push("PLAN_ID_MISMATCH");
  if (created > now) reasons.push("PLAN_NOT_YET_VALID");
  if (expiry <= now) reasons.push("PLAN_EXPIRED");
  if (observed < created || observed > now || observed >= expiry) reasons.push("OBSERVATION_TIME_INVALID");
  // target_ref is an exact normalized resource ID/name, not a URL/parent-folder alias.
  // A create/search plan without that binding needs an adapter's independent readback.
  if (decoded.plan.target_ref === undefined) reasons.push("RESOURCE_IDENTITY_UNBOUND");
  else if (decoded.receipt.resource_id !== decoded.plan.target_ref) reasons.push("RESOURCE_ID_MISMATCH");
  if (decoded.plan.expected_revision !== undefined) {
    // A write's expected base and its observed result are different version axes. v1 has
    // no provider precondition receipt, so it cannot certify that CAS was actually honored.
    if (MUTATING_ACTIONS.has(decoded.plan.action)) reasons.push("REVISION_PRECONDITION_UNVERIFIED");
    else if (decoded.receipt.observed_revision !== decoded.plan.expected_revision) reasons.push("REVISION_MISMATCH");
  }
  // v1 cannot encode a typed expected Cloud/Calendar/Gmail state. A free-form status
  // cannot fill that gap or certify an action. Keep these observations unverified.
  if (["cloud", "calendar", "gmail"].includes(decoded.plan.google_product)) reasons.push("PRODUCT_STATE_UNVERIFIED");
  else if (decoded.plan.payload_sha256 === undefined) reasons.push("PAYLOAD_IDENTITY_UNBOUND");
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

