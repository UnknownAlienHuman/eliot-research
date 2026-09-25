import { ApiRequestError, requestApi } from "./api.js";

const SAFE_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/u;
const SAFE_TRACE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const CLIENT_CLASSES = new Set(["owner_pwa", "named_api_client", "trusted_agent", "federation_client"]);

export interface OwnerSession {
  readonly principal_ref: string;
  readonly credential_generation: string;
  readonly expires_at: string;
  readonly client_class: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function schemaError(message: string): never {
  throw new ApiRequestError({ status: 502, code: "API_RESPONSE_SCHEMA_MISMATCH", message });
}

function exactKeys(value: Record<string, unknown>, required: readonly string[], label: string): void {
  const keys = Object.keys(value);
  if (keys.length !== required.length || required.some((key) => !Object.hasOwn(value, key))) {
    schemaError(`${label} has missing or unknown fields`);
  }
}

function identifier(value: unknown, label: string, pattern = SAFE_IDENTIFIER): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 256 || value !== value.trim() ||
      /[\u0000-\u001f\u007f]/u.test(value) || !pattern.test(value)) {
    schemaError(`${label} is invalid`);
  }
  return value;
}

function timestamp(value: unknown, label: string): string {
  const text = identifier(value, label, /^.{1,64}$/u);
  const milliseconds = Date.parse(text);
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== text) schemaError(`${label} is invalid`);
  return text;
}

export function decodeOwnerSessionEnvelope(value: unknown, expectedGeneration: string): OwnerSession {
  if (!isRecord(value)) schemaError("owner session envelope is not an object");
  exactKeys(value, ["data", "trace_id", "deployment_generation"], "owner session envelope");
  const envelopeGeneration = identifier(value.deployment_generation, "envelope deployment generation");
  if (envelopeGeneration !== expectedGeneration) {
    throw new ApiRequestError({ status: 409, code: "API_GENERATION_MISMATCH", message: "Owner session belongs to another deployment" });
  }
  const trace = identifier(value.trace_id, "envelope trace id", SAFE_TRACE_ID);
  if (!SAFE_TRACE_ID.test(trace)) schemaError("envelope trace id is invalid");
  if (!isRecord(value.data)) schemaError("owner session data is not an object");
  exactKeys(value.data, ["protocol", "principal_ref", "client_class", "credential_generation", "expires_at"], "owner session data");
  if (value.data.protocol !== "eliotr.owner-session.v1") schemaError("owner session protocol is invalid");
  const clientClass = identifier(value.data.client_class, "owner session client class");
  if (!CLIENT_CLASSES.has(clientClass)) schemaError("owner session client class is invalid");
  return {
    principal_ref: identifier(value.data.principal_ref, "owner session principal"),
    credential_generation: identifier(value.data.credential_generation, "owner session credential generation"),
    expires_at: timestamp(value.data.expires_at, "owner session expiry"),
    client_class: clientClass,
  };
}

export async function readOwnerSession(generation: string, signal?: AbortSignal): Promise<OwnerSession> {
  return decodeOwnerSessionEnvelope(await requestApi("/api/v1/system/session", signal === undefined ? {} : { signal }), generation);
}
