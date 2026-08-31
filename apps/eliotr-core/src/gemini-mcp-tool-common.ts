import type { McpToolCallContext } from "./gemini-mcp-protocol.js";

export type GoogleExternalTransport = "disabled" | "gemini-mcp" | "drive-exchange";

export interface GeminiMcpToolDependencies {
  readonly google_transport: GoogleExternalTransport;
  readonly now: () => number;
  readonly systemStatus: (context: McpToolCallContext) => Promise<unknown>;
  readonly catalog: (
    input: { readonly project_id?: string; readonly cursor?: string; readonly limit: number },
    context: McpToolCallContext,
  ) => Promise<unknown>;
}

export class GeminiMcpToolError extends Error {
  public readonly code: string;
  public readonly retryable: boolean;

  public constructor(code: string, message: string, retryable = false, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "GeminiMcpToolError";
    this.code = code;
    this.retryable = retryable;
  }
}
export const MAX_IDENTIFIER_BYTES = 256;
export const MAX_CURSOR_BYTES = 2 * 1024;
export const MAX_TARGET_REF_BYTES = 2 * 1024;
export const MAX_STATUS_BYTES = 8 * 1024;
export const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/u;
export const SHA256 = /^[a-f0-9]{64}$/u;
export const GOOGLE_PRODUCTS = [
  "drive",
  "docs",
  "sheets",
  "slides",
  "calendar",
  "gmail",
  "cloud",
] as const;
export const GOOGLE_ACTIONS = [
  "inspect",
  "read",
  "search",
  "create",
  "append",
  "update",
  "export",
  "deploy",
] as const;
export const SYNC_DIRECTIONS = [
  "google_to_eliot_candidate",
  "eliot_to_google",
  "bidirectional_candidate",
] as const;
export const MUTATING_ACTIONS = new Set(["create", "append", "update", "deploy"]);
export const STRICT_EMPTY_KEYS = new Set<string>();

export interface GoogleSyncPlanInput {
  readonly google_product: typeof GOOGLE_PRODUCTS[number];
  readonly action: typeof GOOGLE_ACTIONS[number];
  readonly direction: typeof SYNC_DIRECTIONS[number];
  readonly source_ref?: string;
  readonly target_ref?: string;
  readonly google_project_id?: string;
  readonly expected_revision?: string;
  readonly payload_sha256?: string;
  readonly dry_run: true;
}

export interface GoogleSyncPlan extends GoogleSyncPlanInput {
  readonly protocol: "eliotr.google-sync.plan.v1";
  readonly plan_id: string;
  readonly connector: "google-workspace" | "gcloud";
  readonly created_at: string;
  readonly expires_at: string;
  readonly candidate_only: true;
  readonly effect_ceiling: "NO_EXTERNAL_EFFECT";
  readonly confirmation_required: boolean;
  readonly exact_readback_required: true;
  readonly eliot_authority_changed: false;
  readonly required_readback_fields: readonly string[];
  readonly steps: readonly string[];
}

export interface GoogleSyncReceiptInput {
  readonly plan: GoogleSyncPlan;
  readonly receipt: {
    readonly connector: "google-workspace" | "gcloud";
    readonly google_product: typeof GOOGLE_PRODUCTS[number];
    readonly action: typeof GOOGLE_ACTIONS[number];
    readonly resource_id: string;
    readonly observed_revision: string;
    readonly observed_at: string;
    readonly readback_performed: boolean;
    readonly readback_payload_sha256?: string;
    readonly google_project_id?: string;
    readonly status?: string;
  };
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}
export function strictRecord(value: unknown, allowed: ReadonlySet<string>, label: string): Record<string, unknown> {
  if (!isRecord(value)) throw new GeminiMcpToolError("INPUT_INVALID", `${label} must be an object`);
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknown.length > 0) {
    throw new GeminiMcpToolError(
      "INPUT_INVALID",
      `${label} contains unsupported fields: ${unknown.slice(0, 8).join(", ")}`,
    );
  }
  return value;
}
export function boundedString(
  value: unknown,
  label: string,
  maximumBytes: number,
  required = true,
): string | undefined {
  if (value === undefined && !required) return undefined;
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value !== value.trim() ||
    utf8Bytes(value) > maximumBytes ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw new GeminiMcpToolError("INPUT_INVALID", `${label} is missing or invalid`);
  }
  return value;
}
export function identifier(value: unknown, label: string, required = true): string | undefined {
  const decoded = boundedString(value, label, MAX_IDENTIFIER_BYTES, required);
  if (decoded === undefined) return undefined;
  if (!IDENTIFIER.test(decoded)) {
    throw new GeminiMcpToolError("INPUT_INVALID", `${label} must be a bounded identifier`);
  }
  return decoded;
}
export function enumValue<const T extends readonly string[]>(
  value: unknown,
  allowed: T,
  label: string,
): T[number] {
  if (typeof value !== "string" || !allowed.includes(value)) {
    throw new GeminiMcpToolError(
      "INPUT_INVALID",
      `${label} must be one of ${allowed.join(", ")}`,
    );
  }
  return value as T[number];
}
export function optionalSha256(value: unknown, label: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !SHA256.test(value)) {
    throw new GeminiMcpToolError("INPUT_INVALID", `${label} must be a lowercase SHA-256 digest`);
  }
  return value;
}
export function isoDate(value: unknown, label: string): string {
  const decoded = boundedString(value, label, 128);
  if (decoded === undefined || Number.isNaN(Date.parse(decoded))) {
    throw new GeminiMcpToolError("INPUT_INVALID", `${label} must be an ISO date-time`);
  }
  return new Date(decoded).toISOString();
}
export function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, stable(child)]),
    );
  }
  return value;
}
export async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}
export function decodeCatalogInput(input: unknown): {
  readonly project_id?: string;
  readonly cursor?: string;
  readonly limit: number;
} {
  const record = strictRecord(input, new Set(["project_id", "cursor", "limit"]), "catalog input");
  const projectId = identifier(record.project_id, "project_id", false);
  const cursor = boundedString(record.cursor, "cursor", MAX_CURSOR_BYTES, false);
  const limit = record.limit ?? 50;
  if (!Number.isSafeInteger(limit) || (limit as number) < 1 || (limit as number) > 100) {
    throw new GeminiMcpToolError("INPUT_INVALID", "limit must be an integer in [1, 100]");
  }
  return {
    limit: limit as number,
    ...(projectId === undefined ? {} : { project_id: projectId }),
    ...(cursor === undefined ? {} : { cursor }),
  };
}

export function decodePlanInput(input: unknown): GoogleSyncPlanInput {
  const allowed = new Set([
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
  const record = strictRecord(input, allowed, "Google sync plan input");
  if (record.dry_run !== undefined && record.dry_run !== true) {
    throw new GeminiMcpToolError(
      "DIRECT_EFFECT_DENIED",
      "ELIOT MCP can only create a plan; dry_run=false is prohibited",
    );
  }
  const sourceRef = identifier(record.source_ref, "source_ref", false);
  const targetRef = boundedString(record.target_ref, "target_ref", MAX_TARGET_REF_BYTES, false);
  const projectId = identifier(record.google_project_id, "google_project_id", false);
  const revision = boundedString(record.expected_revision, "expected_revision", MAX_IDENTIFIER_BYTES, false);
  const payloadSha = optionalSha256(record.payload_sha256, "payload_sha256");
  return {
    google_product: enumValue(record.google_product, GOOGLE_PRODUCTS, "google_product"),
    action: enumValue(record.action, GOOGLE_ACTIONS, "action"),
    direction: enumValue(record.direction, SYNC_DIRECTIONS, "direction"),
    dry_run: true,
    ...(sourceRef === undefined ? {} : { source_ref: sourceRef }),
    ...(targetRef === undefined ? {} : { target_ref: targetRef }),
    ...(projectId === undefined ? {} : { google_project_id: projectId }),
    ...(revision === undefined ? {} : { expected_revision: revision }),
    ...(payloadSha === undefined ? {} : { payload_sha256: payloadSha }),
  };
}

export function readbackFields(product: GoogleSyncPlanInput["google_product"]): readonly string[] {
  if (product === "cloud") {
    return ["google_project_id", "resource_id", "observed_revision", "observed_state", "observed_at"];
  }
  if (product === "calendar" || product === "gmail") {
    return ["resource_id", "observed_revision", "observed_at", "status"];
  }
  return ["resource_id", "observed_revision", "observed_at", "readback_payload_sha256"];
}

