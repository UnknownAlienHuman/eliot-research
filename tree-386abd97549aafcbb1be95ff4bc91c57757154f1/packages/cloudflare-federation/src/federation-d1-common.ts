import {
  AllowedReferenceManifestSchema,
  FederationRequestSchema,
  IdentifierSchema,
  Sha256Schema,
  VersionedRefSchema,
  type AllowedReferenceManifest,
  type CompletionDisposition,
  type FederationEvidenceBundle,
  type FederationJobStatus,
  type FederationRequest,
  type VersionedRef,
} from "@eliotr/contracts";

export const FEDERATION_MANIFEST_JSON_MAX_BYTES = 512 * 1024;
export const FEDERATION_REQUEST_JSON_MAX_BYTES = 256 * 1024;
export const FEDERATION_STATUS_JSON_MAX_BYTES = 256 * 1024;
export const FEDERATION_RESULT_JSON_MAX_BYTES = 1024 * 1024;
export const FEDERATION_ACTIVE_STATES = new Set([
  "ACCEPTED",
  "RUNNING",
  "PARTIAL",
  "BLOCKED",
] as const);

const MAX_REASON_BYTES = 4 * 1024;
const MAX_CANONICAL_DEPTH = 64;
const MAX_DATE_EPOCH = 8_640_000_000_000_000;
const encoder = new TextEncoder();

export type FederationD1AuthorityErrorCode =
  | "FEDERATION_D1_INPUT_INVALID"
  | "FEDERATION_D1_READ_FAILED"
  | "FEDERATION_D1_MANIFEST_CONFLICT"
  | "FEDERATION_D1_BINDING_MISMATCH"
  | "FEDERATION_D1_STATE_CONFLICT"
  | "FEDERATION_D1_SETTLEMENT_UNCERTAIN";

export class FederationD1AuthorityError extends Error {
  public constructor(
    public readonly code: FederationD1AuthorityErrorCode,
    message: string,
    public readonly retryable = false,
    cause?: unknown,
  ) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "FederationD1AuthorityError";
  }
}

export interface FederationAuthorityBinding {
  readonly requester_principal_ref: string;
  readonly requester_credential_generation: string;
  readonly server_principal_ref: string;
  readonly server_credential_generation: string;
  readonly bridge_generation: string;
  readonly client_fence_ref: string;
  readonly allowed_reference_manifest_ref: VersionedRef;
  readonly trace_id: string;
}

export interface FederationJobRecord {
  readonly request_digest: string;
  readonly status: FederationJobStatus;
  readonly observed_completion_disposition: CompletionDisposition | null;
  readonly result: FederationEvidenceBundle | null;
}

export interface FederationSubmission {
  readonly binding: FederationAuthorityBinding;
  readonly request: FederationRequest;
  readonly request_digest: string;
}

export type FederationSubmissionReservation =
  | {
      readonly outcome: "CREATED" | "REPLAY";
      readonly request_digest: string;
      readonly record: FederationJobRecord;
    }
  | {
      readonly outcome: "CONFLICT";
      readonly existing_request_digest: string;
    };

export interface FederationJobAuthority {
  reserve(
    submission: FederationSubmission,
  ): Promise<FederationSubmissionReservation>;
  read(
    binding: FederationAuthorityBinding,
    exchangeId: string,
    idempotencyKey: string,
  ): Promise<FederationJobRecord | null>;
  cancel(
    binding: FederationAuthorityBinding,
    exchangeId: string,
    idempotencyKey: string,
    reason: string,
  ): Promise<FederationJobRecord | null>;
}

export interface FederationManifestStore {
  get(ref: VersionedRef): Promise<AllowedReferenceManifest | null>;
  put(manifest: AllowedReferenceManifest): Promise<{
    readonly disposition: "CREATED" | "EXISTING";
    readonly manifest: AllowedReferenceManifest;
  }>;
}

export function federationD1Fail(
  code: FederationD1AuthorityErrorCode,
  message: string,
  retryable = false,
  cause?: unknown,
): never {
  throw new FederationD1AuthorityError(code, message, retryable, cause);
}

export function federationAssertDatabase(
  database: unknown,
): asserts database is D1Database {
  if (
    typeof database !== "object" ||
    database === null ||
    typeof (database as { prepare?: unknown }).prepare !== "function"
  ) {
    federationD1Fail(
      "FEDERATION_D1_INPUT_INVALID",
      "federation D1 binding is invalid",
    );
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactObject(
  value: unknown,
  keys: ReadonlySet<string>,
  label: string,
): Record<string, unknown> {
  if (!isRecord(value)) {
    federationD1Fail("FEDERATION_D1_INPUT_INVALID", `${label} must be an object`);
  }
  for (const key of Object.keys(value)) {
    if (!keys.has(key)) {
      federationD1Fail(
        "FEDERATION_D1_INPUT_INVALID",
        `${label} contains unsupported field ${key}`,
      );
    }
  }
  return value;
}

function canonicalJson(value: unknown, depth: number): string {
  if (depth > MAX_CANONICAL_DEPTH) {
    federationD1Fail(
      "FEDERATION_D1_INPUT_INVALID",
      "canonical JSON exceeds the nesting ceiling",
    );
  }
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) {
      federationD1Fail(
        "FEDERATION_D1_INPUT_INVALID",
        "canonical JSON contains an unsupported number",
      );
    }
    return String(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalJson(entry, depth + 1)).join(",")}]`;
  }
  if (!isRecord(value)) {
    federationD1Fail(
      "FEDERATION_D1_INPUT_INVALID",
      "canonical JSON contains an unsupported value",
    );
  }
  return `{${Object.keys(value).sort().map(
    (key) => `${JSON.stringify(key)}:${canonicalJson(value[key], depth + 1)}`,
  ).join(",")}}`;
}

export function federationCanonicalJson(value: unknown): string {
  return canonicalJson(value, 0);
}

export function federationAssertUtf8Limit(
  text: string,
  maxBytes: number,
  label: string,
): void {
  if (encoder.encode(text).byteLength > maxBytes) {
    federationD1Fail(
      "FEDERATION_D1_INPUT_INVALID",
      `${label} exceeds ${maxBytes} UTF-8 bytes`,
    );
  }
}

export function federationCanonicalJsonWithin(
  value: unknown,
  maxBytes: number,
  label: string,
): string {
  const text = federationCanonicalJson(value);
  federationAssertUtf8Limit(text, maxBytes, label);
  return text;
}

export function federationParseCanonical(
  text: unknown,
  label: string,
  maxBytes: number,
): unknown {
  if (typeof text !== "string") {
    federationD1Fail("FEDERATION_D1_INPUT_INVALID", `${label} is not JSON text`);
  }
  federationAssertUtf8Limit(text, maxBytes, label);
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch (cause) {
    federationD1Fail(
      "FEDERATION_D1_INPUT_INVALID",
      `${label} is malformed JSON`,
      false,
      cause,
    );
  }
  if (federationCanonicalJson(value) !== text) {
    federationD1Fail(
      "FEDERATION_D1_INPUT_INVALID",
      `${label} is not canonical JSON`,
    );
  }
  return value;
}

export async function federationDigest(value: unknown): Promise<string> {
  const hash = await crypto.subtle.digest(
    "SHA-256",
    encoder.encode(federationCanonicalJson(value)),
  );
  return [...new Uint8Array(hash)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export function federationIdentifier(value: unknown, label: string): string {
  const parsed = IdentifierSchema.safeParse(value);
  if (!parsed.success) {
    federationD1Fail("FEDERATION_D1_INPUT_INVALID", `${label} is invalid`);
  }
  return parsed.data;
}

export function federationVersionedRef(
  value: unknown,
  label: string,
): VersionedRef {
  const parsed = VersionedRefSchema.safeParse(value);
  if (!parsed.success) {
    federationD1Fail("FEDERATION_D1_INPUT_INVALID", `${label} is invalid`);
  }
  return parsed.data;
}

export function federationSha256(value: unknown, label: string): string {
  const parsed = Sha256Schema.safeParse(value);
  if (!parsed.success) {
    federationD1Fail("FEDERATION_D1_INPUT_INVALID", `${label} is invalid`);
  }
  return parsed.data;
}

function isoFromEpoch(
  epoch: number,
  label: string,
  nonnegative: boolean,
): string {
  if (
    !Number.isSafeInteger(epoch) ||
    Math.abs(epoch) > MAX_DATE_EPOCH ||
    (nonnegative && epoch < 0)
  ) {
    federationD1Fail("FEDERATION_D1_INPUT_INVALID", `${label} is invalid`);
  }
  try {
    return new Date(epoch).toISOString();
  } catch (cause) {
    federationD1Fail(
      "FEDERATION_D1_INPUT_INVALID",
      `${label} is outside the supported date range`,
      false,
      cause,
    );
  }
}

export function federationTimestamp(value: unknown, label: string): string {
  if (typeof value !== "string") {
    federationD1Fail("FEDERATION_D1_INPUT_INVALID", `${label} is invalid`);
  }
  const epoch = Date.parse(value);
  if (
    !Number.isFinite(epoch) ||
    !Number.isSafeInteger(epoch) ||
    isoFromEpoch(epoch, label, false) !== value
  ) {
    federationD1Fail(
      "FEDERATION_D1_INPUT_INVALID",
      `${label} is not canonical UTC`,
    );
  }
  return value;
}

export function federationNow(
  clock: () => number,
): { readonly epoch: number; readonly iso: string } {
  const epoch = clock();
  return {
    epoch,
    iso: isoFromEpoch(epoch, "federation authority clock", true),
  };
}

function sameRef(left: VersionedRef, right: VersionedRef): boolean {
  return left.id === right.id && left.revision === right.revision;
}

export function sameFederationBinding(
  left: FederationAuthorityBinding,
  right: FederationAuthorityBinding,
): boolean {
  return left.requester_principal_ref === right.requester_principal_ref &&
    left.requester_credential_generation === right.requester_credential_generation &&
    left.server_principal_ref === right.server_principal_ref &&
    left.server_credential_generation === right.server_credential_generation &&
    left.bridge_generation === right.bridge_generation &&
    left.client_fence_ref === right.client_fence_ref &&
    sameRef(
      left.allowed_reference_manifest_ref,
      right.allowed_reference_manifest_ref,
    );
}

export function requireFederationBinding(
  stored: FederationAuthorityBinding,
  requested: FederationAuthorityBinding,
): void {
  if (!sameFederationBinding(stored, requested)) {
    federationD1Fail(
      "FEDERATION_D1_BINDING_MISMATCH",
      "job is bound to another principal, generation, fence, or manifest",
    );
  }
}

const BINDING_KEYS = new Set([
  "requester_principal_ref",
  "requester_credential_generation",
  "server_principal_ref",
  "server_credential_generation",
  "bridge_generation",
  "client_fence_ref",
  "allowed_reference_manifest_ref",
  "trace_id",
]);

export function normalizeFederationBinding(
  value: unknown,
): FederationAuthorityBinding {
  const binding = exactObject(value, BINDING_KEYS, "federation binding");
  return {
    requester_principal_ref: federationIdentifier(
      binding.requester_principal_ref,
      "requester principal",
    ),
    requester_credential_generation: federationIdentifier(
      binding.requester_credential_generation,
      "requester credential generation",
    ),
    server_principal_ref: federationIdentifier(
      binding.server_principal_ref,
      "server principal",
    ),
    server_credential_generation: federationIdentifier(
      binding.server_credential_generation,
      "server credential generation",
    ),
    bridge_generation: federationIdentifier(
      binding.bridge_generation,
      "bridge generation",
    ),
    client_fence_ref: federationIdentifier(
      binding.client_fence_ref,
      "client fence",
    ),
    allowed_reference_manifest_ref: federationVersionedRef(
      binding.allowed_reference_manifest_ref,
      "manifest ref",
    ),
    trace_id: federationIdentifier(binding.trace_id, "trace id"),
  };
}

export function normalizeFederationRequest(value: unknown): FederationRequest {
  const parsed = FederationRequestSchema.safeParse(value);
  if (!parsed.success) {
    federationD1Fail(
      "FEDERATION_D1_INPUT_INVALID",
      "request failed strict validation",
    );
  }
  federationCanonicalJsonWithin(
    parsed.data,
    FEDERATION_REQUEST_JSON_MAX_BYTES,
    "federation request",
  );
  return parsed.data;
}

const SUBMISSION_KEYS = new Set(["binding", "request", "request_digest"]);

export function normalizeFederationSubmission(
  value: unknown,
): FederationSubmission {
  const submission = exactObject(
    value,
    SUBMISSION_KEYS,
    "federation submission",
  );
  return {
    binding: normalizeFederationBinding(submission.binding),
    request: normalizeFederationRequest(submission.request),
    request_digest: federationSha256(
      submission.request_digest,
      "request digest",
    ),
  };
}

export async function parseFederationManifest(
  value: unknown,
): Promise<AllowedReferenceManifest> {
  const parsed = AllowedReferenceManifestSchema.safeParse(value);
  if (!parsed.success) {
    federationD1Fail(
      "FEDERATION_D1_INPUT_INVALID",
      "manifest failed strict validation",
    );
  }
  federationCanonicalJsonWithin(
    parsed.data,
    FEDERATION_MANIFEST_JSON_MAX_BYTES,
    "federation manifest",
  );
  const { manifest_digest: _manifestDigest, ...payload } = parsed.data;
  if (await federationDigest(payload) !== parsed.data.manifest_digest) {
    federationD1Fail("FEDERATION_D1_INPUT_INVALID", "manifest digest mismatch");
  }
  return parsed.data;
}

export async function stableFederationJobId(
  binding: FederationAuthorityBinding,
  request: FederationRequest,
  requestDigest: string,
): Promise<string> {
  const value = await federationDigest([
    "federation-job",
    request.exchange_id,
    request.idempotency_key,
    requestDigest,
    binding.requester_principal_ref,
    binding.requester_credential_generation,
    binding.server_principal_ref,
    binding.server_credential_generation,
    binding.bridge_generation,
    binding.client_fence_ref,
    binding.allowed_reference_manifest_ref.id,
    binding.allowed_reference_manifest_ref.revision,
  ]);
  return `fjob-${value.slice(0, 48)}`;
}

export async function federationCancellationReceiptRef(
  jobId: string,
  reason: string,
): Promise<string> {
  const value = await federationDigest(["federation-cancel", jobId, reason]);
  return `federation-cancel-${value.slice(0, 48)}`;
}

export function validateFederationReason(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value !== value.trim() ||
    encoder.encode(value).byteLength > MAX_REASON_BYTES ||
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value)
  ) {
    federationD1Fail(
      "FEDERATION_D1_INPUT_INVALID",
      "cancellation reason is invalid",
    );
  }
  return value;
}

export function federationMutationApplied(result: D1Result<unknown>): boolean {
  return (result.meta?.changes ?? 0) === 1;
}
