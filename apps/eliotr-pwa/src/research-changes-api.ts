import { VersionedRefSchema, type VersionedRef } from "@eliotr/contracts";
import { ApiRequestError, requestApi } from "./api.js";

const CHANGES_PATH = "/api/v1/research/changes";
const CHANGES_PROTOCOL = "eliotr.research-changes.v1" as const;
const MAX_ITEMS = 20;
const MAX_CURSOR_BYTES = 4_096;
const MAX_METADATA_BYTES = 65_536;
const SAFE_REF = /^[A-Za-z0-9][A-Za-z0-9:._/@%+-]{0,511}$/u;
const SAFE_GENERATION = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/u;
const SAFE_TRACE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const SAFE_CURSOR = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/u;
const ISO_MILLISECONDS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const CHANGE_KINDS = ["RESEARCH_COMPLETED", "ARTIFACT_DRAFTED", "WIKI_PUBLISHED"] as const;

export type ResearchChangesKind = typeof CHANGE_KINDS[number];

export interface ResearchChangeFeedItem {
  readonly kind: ResearchChangesKind;
  readonly subject_ref: string;
  readonly subject_revision: number;
  readonly occurred_at: string;
  readonly metadata: Readonly<Record<string, string | number | boolean | null>>;
}

export interface ResearchChangesView {
  readonly items: readonly ResearchChangeFeedItem[];
  readonly next_cursor: string | null;
  readonly has_more: boolean;
  readonly deployment_generation: string;
}

export interface ReadResearchChangesOptions {
  readonly afterCursor?: string | null;
  readonly startAt?: "latest";
  readonly signal?: AbortSignal;
}

type JsonRecord = Record<string, unknown>;

function invalid(message: string): never {
  throw new ApiRequestError({ status: 502, code: "RESEARCH_CHANGES_RESPONSE_INVALID", message });
}

function inputInvalid(message: string): never {
  throw new ApiRequestError({ status: 400, code: "RESEARCH_CHANGES_INPUT_INVALID", message });
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactRecord(
  value: unknown,
  required: readonly string[],
  optional: readonly string[],
  label: string,
): JsonRecord {
  if (!isRecord(value) || required.some((key) => !Object.hasOwn(value, key)) ||
      Object.keys(value).some((key) => !required.includes(key) && !optional.includes(key))) {
    invalid(`${label} has missing or unknown fields`);
  }
  return value;
}

function boundedString(value: unknown, label: string, maximum: number): string {
  if (typeof value !== "string" || value.length === 0 || value.length > maximum ||
      value !== value.trim() || /[\u0000-\u001f\u007f]/u.test(value)) {
    invalid(`${label} is invalid`);
  }
  return value;
}

function generation(value: unknown, label: string): string {
  const text = boundedString(value, label, 256);
  if (!SAFE_GENERATION.test(text)) invalid(`${label} is invalid`);
  return text;
}

function traceId(value: unknown): string {
  const text = boundedString(value, "trace_id", 128);
  if (!SAFE_TRACE_ID.test(text)) invalid("trace_id is invalid");
  return text;
}

function reference(value: unknown, label: string): string {
  const text = boundedString(value, label, 512);
  if (!SAFE_REF.test(text) || text.includes("..") || text.includes("\\")) invalid(`${label} is invalid`);
  return text;
}

function sha256(value: unknown, label: string): string {
  const text = boundedString(value, label, 64);
  if (!/^[a-f0-9]{64}$/u.test(text)) invalid(`${label} is invalid`);
  return text;
}

function timestamp(value: unknown, label: string): string {
  const text = boundedString(value, label, 64);
  if (!ISO_MILLISECONDS.test(text) || !Number.isFinite(Date.parse(text)) || new Date(text).toISOString() !== text) {
    invalid(`${label} is invalid`);
  }
  return text;
}

function positiveInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) invalid(`${label} is invalid`);
  return value;
}

function versionedRef(value: unknown, label: string): VersionedRef {
  const parsed = VersionedRefSchema.safeParse(value);
  if (!parsed.success) invalid(`${label} is invalid`);
  return parsed.data;
}

function flatMetadata(value: unknown): Readonly<Record<string, string | number | boolean | null>> {
  if (!isRecord(value)) invalid("change metadata is not a flat object");
  const keys = Object.keys(value);
  const sorted = [...keys].sort();
  if (keys.some((key, index) => key !== sorted[index] || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(key))) {
    invalid("change metadata keys are invalid or noncanonical");
  }
  const metadata: Record<string, string | number | boolean | null> = {};
  for (const key of keys) {
    const item = value[key];
    if (item !== null && typeof item !== "string" && typeof item !== "boolean" &&
        (typeof item !== "number" || !Number.isFinite(item))) {
      invalid("change metadata must contain only scalar values");
    }
    metadata[key] = item as string | number | boolean | null;
  }
  let encoded: string;
  try { encoded = JSON.stringify(metadata); }
  catch { invalid("change metadata could not be encoded"); }
  if (new TextEncoder().encode(encoded).byteLength > MAX_METADATA_BYTES) {
    invalid("change metadata exceeds its byte bound");
  }
  return metadata;
}

function cursor(value: unknown, label: string): string {
  const text = boundedString(value, label, MAX_CURSOR_BYTES);
  if (new TextEncoder().encode(text).byteLength > MAX_CURSOR_BYTES || !SAFE_CURSOR.test(text)) {
    invalid(`${label} is invalid`);
  }
  return text;
}

function decodeEnvelope(value: unknown, expectedGeneration: string): JsonRecord {
  const envelope = exactRecord(value, ["data", "trace_id", "deployment_generation"], [], "changes envelope");
  traceId(envelope.trace_id);
  const actualGeneration = generation(envelope.deployment_generation, "deployment_generation");
  if (actualGeneration !== expectedGeneration) {
    throw new ApiRequestError({
      status: 409,
      code: "RESEARCH_CHANGES_DEPLOYMENT_CHANGED",
      message: "The application changed; refresh the recent research activity.",
      retryable: true,
    });
  }
  if (!isRecord(envelope.data)) invalid("changes data is not an object");
  return envelope.data;
}

function decodeItem(value: unknown, index: number): ResearchChangeFeedItem {
  const item = exactRecord(value, [
    "sequence", "change_ref", "kind", "subject_ref", "subject_revision", "payload_ref",
    "payload_sha256", "occurred_at", "metadata",
  ], ["visibility_principal_ref", "visibility_scope_ref"], `changes.items[${index}]`);
  positiveInteger(item.sequence, `changes.items[${index}].sequence`);
  reference(item.change_ref, `changes.items[${index}].change_ref`);
  if (!CHANGE_KINDS.includes(item.kind as ResearchChangesKind)) invalid(`changes.items[${index}].kind is invalid`);
  const subjectRef = reference(item.subject_ref, `changes.items[${index}].subject_ref`);
  const subjectRevision = positiveInteger(item.subject_revision, `changes.items[${index}].subject_revision`);
  reference(item.payload_ref, `changes.items[${index}].payload_ref`);
  sha256(item.payload_sha256, `changes.items[${index}].payload_sha256`);
  const occurredAt = timestamp(item.occurred_at, `changes.items[${index}].occurred_at`);
  const metadata = flatMetadata(item.metadata);
  if (Object.hasOwn(item, "visibility_principal_ref")) {
    reference(item.visibility_principal_ref, `changes.items[${index}].visibility_principal_ref`);
  }
  if (Object.hasOwn(item, "visibility_scope_ref")) {
    versionedRef(item.visibility_scope_ref, `changes.items[${index}].visibility_scope_ref`);
  }
  return {
    kind: item.kind as ResearchChangesKind,
    subject_ref: subjectRef,
    subject_revision: subjectRevision,
    occurred_at: occurredAt,
    metadata,
  };
}

function expectedGeneration(value: string): string {
  if (typeof value !== "string" || value.length === 0 || value !== value.trim() || !SAFE_GENERATION.test(value)) {
    inputInvalid("deployment generation is invalid");
  }
  return value;
}

function requestCursor(value: string | null | undefined): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_CURSOR_BYTES ||
      !SAFE_CURSOR.test(value)) inputInvalid("afterCursor is invalid");
  return value;
}

export async function readResearchChanges(
  expectedDeploymentGeneration: string,
  options: ReadResearchChangesOptions = {},
): Promise<ResearchChangesView> {
  const expected = expectedGeneration(expectedDeploymentGeneration);
  const afterCursor = requestCursor(options.afterCursor);
  if (options.startAt !== undefined && options.startAt !== "latest") inputInvalid("startAt is invalid");
  const request: Record<string, unknown> = {
    after_cursor: afterCursor,
    limit: MAX_ITEMS,
    kinds: [...CHANGE_KINDS],
  };
  if (options.startAt !== undefined) request.start_at = options.startAt;
  const raw = await requestApi(CHANGES_PATH, {
    method: "POST",
    headers: { "content-type": "application/json", "x-eliotr-csrf": "1" },
    body: JSON.stringify(request),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });
  const data = decodeEnvelope(raw, expected);
  const response = exactRecord(data, ["protocol", "items", "next_cursor", "has_more"], [], "changes data");
  if (response.protocol !== CHANGES_PROTOCOL || !Array.isArray(response.items) || response.items.length > MAX_ITEMS ||
      typeof response.has_more !== "boolean") {
    invalid("changes result is invalid");
  }
  const items = response.items.map((item, index) => decodeItem(item, index));
  const nextCursor = response.next_cursor === null ? null : cursor(response.next_cursor, "next_cursor");
  return {
    items,
    next_cursor: nextCursor,
    has_more: response.has_more,
    deployment_generation: expected,
  };
}
