import {
  IdentifierSchema,
  IsoDateTimeSchema,
  VersionedRefSchema,
  type VersionedRef,
} from "@eliotr/contracts";
import { ApiRequestError, requestApiWithStatuses } from "./api.js";

const NAMESPACE_PATH = "/api/v1/library/namespaces";
const CATALOG_PROTOCOL = "eliotr.owner-namespaces.v1";
const NAMESPACE_PROTOCOL = "eliotr.owner-namespace.v1";
const SAFE_TRACE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const SAFE_GENERATION = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/u;
const SAFE_IDEMPOTENCY = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/u;

type JsonRecord = Record<string, unknown>;

export interface SourceNamespaceProfile {
  readonly profile_ref: VersionedRef;
  readonly title: string;
}

export interface SourceNamespaceSummary {
  readonly source_namespace_id: string;
  readonly title: string;
}

export interface SourceNamespaceCatalog {
  readonly protocol: typeof CATALOG_PROTOCOL;
  readonly profiles: readonly SourceNamespaceProfile[];
  readonly namespaces: readonly SourceNamespaceSummary[];
  readonly trace_id: string;
  readonly deployment_generation: string;
}

export interface CreatedSourceNamespace {
  readonly protocol: typeof NAMESPACE_PROTOCOL;
  readonly source_namespace_id: string;
  readonly title: string;
  readonly created_at: string;
  readonly trace_id: string;
  readonly deployment_generation: string;
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function schemaFailure(message: string): never {
  throw new ApiRequestError({ status: 502, code: "API_RESPONSE_SCHEMA_MISMATCH", message });
}

function generationFailure(): never {
  throw new ApiRequestError({
    status: 409,
    code: "API_GENERATION_MISMATCH",
    message: "The workspace changed; refresh the workspace list and try again.",
    retryable: true,
  });
}

function exactRecord(
  value: unknown,
  required: readonly string[],
  label: string,
  optional: readonly string[] = [],
): JsonRecord {
  const allowed = new Set([...required, ...optional]);
  if (!isRecord(value) || required.some((key) => !Object.hasOwn(value, key)) ||
      Object.keys(value).some((key) => !allowed.has(key))) {
    schemaFailure(`${label} has missing or unknown fields`);
  }
  return value;
}

function boundedText(value: unknown, label: string, maximumLength: number): string {
  if (typeof value !== "string" || value.length === 0 || value.length > maximumLength ||
      value !== value.trim() || /[\u0000-\u001f\u007f]/u.test(value)) {
    schemaFailure(`${label} is not a valid bounded string`);
  }
  return value;
}

function identifier(value: unknown, label: string): string {
  const text = boundedText(value, label, 256);
  if (!IdentifierSchema.safeParse(text).success) schemaFailure(`${label} is not a valid identifier`);
  return text;
}

function versionedRef(value: unknown, label: string): VersionedRef {
  const parsed = VersionedRefSchema.safeParse(value);
  if (!parsed.success) schemaFailure(`${label} is not a valid profile reference`);
  return parsed.data;
}

function timestamp(value: unknown): string {
  const text = boundedText(value, "created_at", 64);
  if (!IsoDateTimeSchema.safeParse(text).success) schemaFailure("created_at is not a valid timestamp");
  return text;
}

function traceId(value: unknown): string {
  const trace = boundedText(value, "trace_id", 128);
  if (!SAFE_TRACE.test(trace)) schemaFailure("trace_id is invalid");
  return trace;
}

function expectedGeneration(value: string): string {
  const generation = boundedText(value, "expected deployment generation", 256);
  if (!SAFE_GENERATION.test(generation)) generationFailure();
  return generation;
}

function responseEnvelope(value: unknown, expected: string): {
  readonly data: JsonRecord;
  readonly trace_id: string;
  readonly deployment_generation: string;
} {
  const envelope = exactRecord(value, ["data", "trace_id", "deployment_generation"], "namespace response envelope");
  const generation = identifier(envelope.deployment_generation, "deployment_generation");
  if (!SAFE_GENERATION.test(generation) || generation !== expected) generationFailure();
  if (!isRecord(envelope.data)) schemaFailure("namespace response data must be an object");
  return { data: envelope.data, trace_id: traceId(envelope.trace_id), deployment_generation: generation };
}

function namespaceProfile(value: unknown, index: number): SourceNamespaceProfile {
  const profile = exactRecord(value, ["profile_ref", "title"], `namespace profile ${index}`);
  return {
    profile_ref: versionedRef(profile.profile_ref, `namespace profile ${index} reference`),
    title: boundedText(profile.title, `namespace profile ${index} title`, 256),
  };
}

function namespaceSummary(value: unknown, index: number): SourceNamespaceSummary {
  const namespace = exactRecord(value, ["source_namespace_id", "title"], `namespace ${index}`);
  return {
    source_namespace_id: identifier(namespace.source_namespace_id, `namespace ${index} ID`),
    title: boundedText(namespace.title, `namespace ${index} title`, 120),
  };
}

function decodeCatalog(value: unknown, expected: string): SourceNamespaceCatalog {
  const response = responseEnvelope(value, expected);
  const data = exactRecord(response.data, ["protocol", "profiles", "namespaces"], "namespace catalog");
  if (data.protocol !== CATALOG_PROTOCOL) schemaFailure("namespace catalog protocol is invalid");
  if (!Array.isArray(data.profiles) || data.profiles.length > 128) schemaFailure("namespace profiles are invalid");
  if (!Array.isArray(data.namespaces) || data.namespaces.length > 256) schemaFailure("namespaces are invalid");
  const profiles = data.profiles.map(namespaceProfile);
  const namespaces = data.namespaces.map(namespaceSummary);
  if (new Set(profiles.map((profile) => `${profile.profile_ref.id}@${profile.profile_ref.revision}`)).size !== profiles.length) {
    schemaFailure("namespace profiles contain duplicates");
  }
  if (new Set(namespaces.map((namespace) => namespace.source_namespace_id)).size !== namespaces.length) {
    schemaFailure("namespaces contain duplicates");
  }
  return { protocol: CATALOG_PROTOCOL, profiles, namespaces, trace_id: response.trace_id, deployment_generation: response.deployment_generation };
}

function decodeCreated(value: unknown, expected: string): CreatedSourceNamespace {
  const response = responseEnvelope(value, expected);
  const data = exactRecord(response.data, ["protocol", "source_namespace_id", "title", "created_at"], "created namespace");
  if (data.protocol !== NAMESPACE_PROTOCOL) schemaFailure("created namespace protocol is invalid");
  return {
    protocol: NAMESPACE_PROTOCOL,
    source_namespace_id: identifier(data.source_namespace_id, "created namespace ID"),
    title: boundedText(data.title, "created namespace title", 120),
    created_at: timestamp(data.created_at),
    trace_id: response.trace_id,
    deployment_generation: response.deployment_generation,
  };
}

export async function readSourceNamespaces(
  expectedDeploymentGeneration: string,
  signal?: AbortSignal,
): Promise<SourceNamespaceCatalog> {
  const expected = expectedGeneration(expectedDeploymentGeneration);
  const raw = await requestApiWithStatuses(
    NAMESPACE_PATH,
    signal === undefined ? {} : { signal },
    [200],
  );
  return decodeCatalog(raw, expected);
}

export async function createSourceNamespace(
  profileRef: VersionedRef,
  title: string,
  idempotencyKey: string,
  expectedDeploymentGeneration: string,
  signal?: AbortSignal,
): Promise<CreatedSourceNamespace> {
  const expected = expectedGeneration(expectedDeploymentGeneration);
  const profile = versionedRef(profileRef, "profile_ref");
  const name = boundedText(title, "workspace title", 120);
  const key = boundedText(idempotencyKey, "idempotency_key", 256);
  if (!SAFE_IDEMPOTENCY.test(key)) {
    throw new ApiRequestError({ status: 400, code: "NAMESPACE_INPUT_INVALID", message: "The workspace request is invalid." });
  }
  const raw = await requestApiWithStatuses(NAMESPACE_PATH, {
    method: "POST",
    headers: { "content-type": "application/json", "x-eliotr-csrf": "1" },
    body: JSON.stringify({ profile_ref: profile, title: name, idempotency_key: key }),
    ...(signal === undefined ? {} : { signal }),
  }, [200, 201]);
  return decodeCreated(raw, expected);
}
