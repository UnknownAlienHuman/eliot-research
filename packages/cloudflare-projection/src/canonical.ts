import type {
  ProjectionExecutionProfile,
  ProjectionSourceContext,
} from "./types.js";

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;

export class ProjectionRuntimeError extends Error {
  public readonly code:
    | "PROJECTION_INPUT_INVALID"
    | "PROJECTION_AUTHORITY_CONFLICT"
    | "PROJECTION_SETTLEMENT_UNCERTAIN";
  public readonly retryable: boolean;

  public constructor(
    code: ProjectionRuntimeError["code"],
    message: string,
    retryable = false,
    cause?: unknown,
  ) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "ProjectionRuntimeError";
    this.code = code;
    this.retryable = retryable;
  }
}

export function projectionFail(
  code: ProjectionRuntimeError["code"],
  message: string,
  retryable = false,
  cause?: unknown,
): never {
  throw new ProjectionRuntimeError(code, message, retryable, cause);
}

export function assertProjectionIdentifier(value: unknown, label: string): string {
  if (typeof value !== "string" || !IDENTIFIER.test(value)) {
    projectionFail("PROJECTION_INPUT_INVALID", `${label} is invalid`);
  }
  return value;
}


export function assertProjectionText(
  value: unknown,
  label: string,
  maximumBytes = 4096,
): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value !== value.trim() ||
    new TextEncoder().encode(value).byteLength > maximumBytes ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    projectionFail("PROJECTION_INPUT_INVALID", `${label} is invalid`);
  }
  return value;
}

export function assertProjectionSha256(value: unknown, label: string): string {
  if (typeof value !== "string" || !SHA256.test(value)) {
    projectionFail("PROJECTION_INPUT_INVALID", `${label} is not a lowercase SHA-256 digest`);
  }
  return value;
}

export function assertProjectionInteger(
  value: unknown,
  label: string,
  minimum: number,
  maximum: number,
): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < minimum ||
    value > maximum
  ) {
    projectionFail("PROJECTION_INPUT_INVALID", `${label} is outside its allowed range`);
  }
  return value;
}

export function canonicalProjectionJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      projectionFail("PROJECTION_INPUT_INVALID", "canonical JSON contains a non-finite number");
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalProjectionJson).join(",")}]`;
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalProjectionJson(record[key])}`)
      .join(",")}}`;
  }
  projectionFail("PROJECTION_INPUT_INVALID", "canonical JSON contains a non-JSON value");
}

function hex(input: ArrayBuffer): string {
  return [...new Uint8Array(input)]
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("");
}

export async function projectionSha256Bytes(value: Uint8Array): Promise<string> {
  return hex(await crypto.subtle.digest("SHA-256", value));
}

export async function projectionSha256Utf8(value: string): Promise<string> {
  return projectionSha256Bytes(new TextEncoder().encode(value));
}

export async function projectionDigest(value: unknown): Promise<string> {
  return projectionSha256Utf8(canonicalProjectionJson(value));
}

export async function stableProjectionId(
  prefix: string,
  ...parts: readonly string[]
): Promise<string> {
  assertProjectionIdentifier(prefix, "stable ID prefix");
  const digest = await projectionSha256Utf8([prefix, ...parts].join("\u0000"));
  return `${prefix}-${digest.slice(0, 48)}`;
}

export async function projectionGeneration(
  context: ProjectionSourceContext,
  profile: ProjectionExecutionProfile,
): Promise<string> {
  return stableProjectionId(
    "projection",
    context.source_revision.source_revision_ref,
    context.source_revision.content_sha256,
    context.source_revision.object_residency_key_digest,
    profile.projector_profile,
  );
}

export function utf8ProjectionBytes(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

export function utf8ProjectionLength(value: string): number {
  return utf8ProjectionBytes(value).byteLength;
}

export function projectionByteStream(value: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(value);
      controller.close();
    },
  });
}

export function projectionReceiptRef(id: string, revision = 1): string {
  assertProjectionIdentifier(id, "receipt ID");
  assertProjectionInteger(revision, "receipt revision", 1, Number.MAX_SAFE_INTEGER);
  return `receipt:${id}:${revision}`;
}

export function profileIsValid(profile: ProjectionExecutionProfile): void {
  assertProjectionIdentifier(profile.projector_profile, "projector_profile");
  assertProjectionIdentifier(profile.managed_instance_id, "managed_instance_id");
  assertProjectionIdentifier(profile.managed_generation, "managed_generation");
  if (typeof profile.managed_generation_active !== "boolean") {
    projectionFail("PROJECTION_INPUT_INVALID", "managed_generation_active must be boolean");
  }
  assertProjectionInteger(
    profile.maximum_markdown_bytes,
    "maximum_markdown_bytes",
    1024,
    16 * 1024 * 1024,
  );
  assertProjectionInteger(
    profile.maximum_synchronous_items,
    "maximum_synchronous_items",
    1,
    128,
  );
  assertProjectionInteger(
    profile.target_item_utf8_bytes,
    "target_item_utf8_bytes",
    1024,
    256 * 1024,
  );
  assertProjectionInteger(
    profile.maximum_item_utf8_bytes,
    "maximum_item_utf8_bytes",
    profile.target_item_utf8_bytes,
    256 * 1024,
  );
  assertProjectionInteger(
    profile.managed_poll_interval_ms,
    "managed_poll_interval_ms",
    100,
    60_000,
  );
  assertProjectionInteger(
    profile.managed_timeout_ms,
    "managed_timeout_ms",
    profile.managed_poll_interval_ms,
    5 * 60_000,
  );
}
