import {
  ErasureRequestSchema,
  type ErasureRequest,
  type PurgeLocation,
} from "@eliotr/contracts";

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const MAX_TEXT_BYTES = 4096;

export type ErasureRuntimeErrorCode =
  | "ERASURE_INPUT_INVALID"
  | "ERASURE_IDENTITY_CONFLICT"
  | "ERASURE_LEASE_LOST"
  | "ERASURE_CLOSURE_INCOMPLETE"
  | "ERASURE_LOCATION_UNAVAILABLE"
  | "ERASURE_ABSENCE_UNPROVEN"
  | "ERASURE_SETTLEMENT_UNCERTAIN";

export class ErasureRuntimeError extends Error {
  public readonly code: ErasureRuntimeErrorCode;
  public readonly retryable: boolean;

  public constructor(
    code: ErasureRuntimeErrorCode,
    message: string,
    retryable = false,
    cause?: unknown,
  ) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "ErasureRuntimeError";
    this.code = code;
    this.retryable = retryable;
  }
}

export function erasureFail(
  code: ErasureRuntimeErrorCode,
  message: string,
  retryable = false,
  cause?: unknown,
): never {
  throw new ErasureRuntimeError(code, message, retryable, cause);
}

export function utf8ErasureLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

export function assertErasureIdentifier(value: unknown, label: string): string {
  if (typeof value !== "string" || !IDENTIFIER.test(value)) {
    erasureFail("ERASURE_INPUT_INVALID", `${label} is invalid`);
  }
  return value;
}

export function assertErasureText(
  value: unknown,
  label: string,
  maximumBytes = MAX_TEXT_BYTES,
): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value !== value.trim() ||
    utf8ErasureLength(value) > maximumBytes ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    erasureFail("ERASURE_INPUT_INVALID", `${label} is invalid`);
  }
  return value;
}

export function assertErasureSha256(value: unknown, label: string): string {
  if (typeof value !== "string" || !SHA256.test(value)) {
    erasureFail("ERASURE_INPUT_INVALID", `${label} is not a lowercase SHA-256 digest`);
  }
  return value;
}

export function assertErasureInteger(
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
    erasureFail("ERASURE_INPUT_INVALID", `${label} is outside its allowed range`);
  }
  return value;
}

export function canonicalErasureJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      erasureFail("ERASURE_INPUT_INVALID", "canonical JSON contains a non-finite number");
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalErasureJson).join(",")}]`;
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalErasureJson(record[key])}`)
      .join(",")}}`;
  }
  erasureFail("ERASURE_INPUT_INVALID", "canonical JSON contains a non-JSON value");
}

function hex(input: ArrayBuffer): string {
  return [...new Uint8Array(input)]
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("");
}

export async function erasureSha256Utf8(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  return hex(await crypto.subtle.digest("SHA-256", buffer));
}

export async function erasureDigest(value: unknown): Promise<string> {
  return erasureSha256Utf8(canonicalErasureJson(value));
}

export async function stableErasureId(
  prefix: string,
  ...parts: readonly string[]
): Promise<string> {
  assertErasureIdentifier(prefix, "stable ID prefix");
  const digest = await erasureSha256Utf8([prefix, ...parts].join("\u0000"));
  return `${prefix}-${digest.slice(0, 48)}`;
}

export function validateErasureRequest(raw: ErasureRequest): ErasureRequest {
  let request: ErasureRequest;
  try { request = ErasureRequestSchema.parse(raw); }
  catch (cause) {
    erasureFail("ERASURE_INPUT_INVALID", "erasure request failed strict validation", false, cause);
  }
  const subjects = [...new Set(request.exact_subject_refs)];
  const locations = [...new Set(request.required_locations)];
  if (subjects.length !== request.exact_subject_refs.length) {
    erasureFail("ERASURE_INPUT_INVALID", "exact_subject_refs must be unique");
  }
  if (locations.length !== request.required_locations.length) {
    erasureFail("ERASURE_INPUT_INVALID", "required_locations must be unique");
  }
  for (const subject of subjects) assertErasureIdentifier(subject, "exact subject ref");
  const admitted = Date.parse(request.admitted_at);
  const deadline = Date.parse(request.deadline);
  if (!Number.isFinite(admitted) || !Number.isFinite(deadline) || deadline <= admitted) {
    erasureFail("ERASURE_INPUT_INVALID", "erasure deadline must follow admission time");
  }
  return {
    ...request,
    exact_subject_refs: subjects.sort(),
    required_locations: [...sortedLocations(locations)],
  };
}

export function sortedLocations(values: readonly PurgeLocation[]): readonly PurgeLocation[] {
  return [...new Set(values)].sort();
}

export function exactLocationEquality(
  requested: readonly PurgeLocation[],
  completed: readonly PurgeLocation[],
): boolean {
  const left = sortedLocations(requested);
  const right = sortedLocations(completed);
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

export type ParsedErasureSubject =
  | { readonly kind: "source_revision"; readonly source_revision_ref: string }
  | { readonly kind: "source"; readonly source_id: string }
  | { readonly kind: "evidence_handle"; readonly handle_id: string; readonly revision: number }
  | { readonly kind: "scope_snapshot"; readonly snapshot_id: string; readonly revision: number };

export function parseErasureSubject(value: string): ParsedErasureSubject {
  assertErasureIdentifier(value, "exact subject ref");
  if (value.startsWith("source-revision:")) {
    return {
      kind: "source_revision",
      source_revision_ref: assertErasureIdentifier(value.slice("source-revision:".length), "source revision ref"),
    };
  }
  if (value.startsWith("source:")) {
    return {
      kind: "source",
      source_id: assertErasureIdentifier(value.slice("source:".length), "source ID"),
    };
  }
  for (const [prefix, kind] of [
    ["evidence-handle:", "evidence_handle"],
    ["scope-snapshot:", "scope_snapshot"],
  ] as const) {
    if (!value.startsWith(prefix)) continue;
    const body = value.slice(prefix.length);
    const separator = body.lastIndexOf(":");
    if (separator < 1) erasureFail("ERASURE_INPUT_INVALID", `${kind} subject lacks a revision`);
    const id = assertErasureIdentifier(body.slice(0, separator), `${kind} ID`);
    const revisionText = body.slice(separator + 1);
    if (!/^[1-9][0-9]*$/u.test(revisionText)) {
      erasureFail("ERASURE_INPUT_INVALID", `${kind} revision is invalid`);
    }
    const revision = assertErasureInteger(Number(revisionText), `${kind} revision`, 1, Number.MAX_SAFE_INTEGER);
    return kind === "evidence_handle"
      ? { kind, handle_id: id, revision }
      : { kind, snapshot_id: id, revision };
  }
  erasureFail("ERASURE_INPUT_INVALID", `unsupported exact subject ref ${value}`);
}

export function isoFromMs(value: number): string {
  assertErasureInteger(value, "timestamp", 0, 253_402_300_799_999);
  return new Date(value).toISOString();
}
