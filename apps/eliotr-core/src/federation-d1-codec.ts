import {
  AllowedReferenceManifestSchema,
  CompletionDispositionSchema,
  FederationEvidenceBundleSchema,
  FederationJobStatusSchema,
  FederationRequestSchema,
  IdentifierSchema,
  Sha256Schema,
  VersionedRefSchema,
  type AllowedReferenceManifest,
  type CompletionDisposition,
  type FederationEvidenceBundle,
  type FederationRequest,
  type VersionedRef,
} from "@eliotr/contracts";
import type {
  FederationAuthorityBinding,
  FederationJobRecord,
  FederationReferenceManifestAuthority,
  FederationSubmission,
} from "./federation-service.js";

export const FEDERATION_MANIFEST_SELECT =
  "SELECT manifest_id,revision,manifest_json,manifest_digest,scope_snapshot_id," +
  "scope_snapshot_revision,client_fence_ref,expires_at,created_at " +
  "FROM federation_reference_manifest ";
export const FEDERATION_JOB_SELECT =
  "SELECT job_id,exchange_id,idempotency_key,request_digest,request_json," +
  "requester_principal_ref,requester_credential_generation,server_principal_ref," +
  "server_credential_generation,bridge_generation,client_fence_ref," +
  "allowed_manifest_id,allowed_manifest_revision,origin_trace_id,attempt," +
  "transport_state,status_json,observed_completion_disposition,result_json," +
  "cancellation_reason,cancelled_at,created_at,updated_at FROM federation_job ";
export const FEDERATION_ACTIVE_STATES = new Set([
  "ACCEPTED",
  "RUNNING",
  "PARTIAL",
  "BLOCKED",
]);
const MAX_REASON_BYTES = 4 * 1024;
const encoder = new TextEncoder();

export type FederationD1AuthorityErrorCode =
  | "FEDERATION_D1_INPUT_INVALID"
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

export interface FederationManifestStore extends FederationReferenceManifestAuthority {
  put(manifest: AllowedReferenceManifest): Promise<{
    readonly disposition: "CREATED" | "EXISTING";
    readonly manifest: AllowedReferenceManifest;
  }>;
}

interface ManifestRow {
  readonly manifest_id: unknown;
  readonly revision: unknown;
  readonly manifest_json: unknown;
  readonly manifest_digest: unknown;
  readonly scope_snapshot_id: unknown;
  readonly scope_snapshot_revision: unknown;
  readonly client_fence_ref: unknown;
  readonly expires_at: unknown;
  readonly created_at: unknown;
}

interface JobRow {
  readonly job_id: unknown;
  readonly exchange_id: unknown;
  readonly idempotency_key: unknown;
  readonly request_digest: unknown;
  readonly request_json: unknown;
  readonly requester_principal_ref: unknown;
  readonly requester_credential_generation: unknown;
  readonly server_principal_ref: unknown;
  readonly server_credential_generation: unknown;
  readonly bridge_generation: unknown;
  readonly client_fence_ref: unknown;
  readonly allowed_manifest_id: unknown;
  readonly allowed_manifest_revision: unknown;
  readonly origin_trace_id: unknown;
  readonly attempt: unknown;
  readonly transport_state: unknown;
  readonly status_json: unknown;
  readonly observed_completion_disposition: unknown;
  readonly result_json: unknown;
  readonly cancellation_reason: unknown;
  readonly cancelled_at: unknown;
  readonly created_at: unknown;
  readonly updated_at: unknown;
}

export interface DecodedFederationJob {
  readonly binding: FederationAuthorityBinding;
  readonly request: FederationRequest;
  readonly record: FederationJobRecord;
  readonly cancellationReason: string | null;
  readonly updatedAt: string;
}

export function federationD1Fail(
  code: FederationD1AuthorityErrorCode,
  message: string,
  retryable = false,
  cause?: unknown,
): never {
  throw new FederationD1AuthorityError(code, message, retryable, cause);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function federationCanonicalJson(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
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
    return `[${value.map(federationCanonicalJson).join(",")}]`;
  }
  if (!isRecord(value)) {
    federationD1Fail(
      "FEDERATION_D1_INPUT_INVALID",
      "canonical JSON contains an unsupported value",
    );
  }
  return `{${Object.keys(value).sort().map(
    (key) => `${JSON.stringify(key)}:${federationCanonicalJson(value[key])}`,
  ).join(",")}}`;
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

export function federationVersionedRef(value: unknown, label: string): VersionedRef {
  const parsed = VersionedRefSchema.safeParse(value);
  if (!parsed.success) {
    federationD1Fail("FEDERATION_D1_INPUT_INVALID", `${label} is invalid`);
  }
  return parsed.data;
}

function sha256(value: unknown, label: string): string {
  const parsed = Sha256Schema.safeParse(value);
  if (!parsed.success) {
    federationD1Fail("FEDERATION_D1_INPUT_INVALID", `${label} is invalid`);
  }
  return parsed.data;
}

export function federationTimestamp(value: unknown, label: string): string {
  if (typeof value !== "string") {
    federationD1Fail("FEDERATION_D1_INPUT_INVALID", `${label} is invalid`);
  }
  const epoch = Date.parse(value);
  if (!Number.isSafeInteger(epoch) || new Date(epoch).toISOString() !== value) {
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
  if (!Number.isSafeInteger(epoch) || epoch < 0) {
    federationD1Fail(
      "FEDERATION_D1_INPUT_INVALID",
      "federation authority clock is invalid",
    );
  }
  return { epoch, iso: new Date(epoch).toISOString() };
}

function parseCanonical(text: unknown, label: string): unknown {
  if (typeof text !== "string") {
    federationD1Fail("FEDERATION_D1_INPUT_INVALID", `${label} is not JSON text`);
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
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

export function normalizeFederationBinding(
  value: FederationAuthorityBinding,
): FederationAuthorityBinding {
  return {
    requester_principal_ref: federationIdentifier(
      value.requester_principal_ref,
      "requester principal",
    ),
    requester_credential_generation: federationIdentifier(
      value.requester_credential_generation,
      "requester credential generation",
    ),
    server_principal_ref: federationIdentifier(
      value.server_principal_ref,
      "server principal",
    ),
    server_credential_generation: federationIdentifier(
      value.server_credential_generation,
      "server credential generation",
    ),
    bridge_generation: federationIdentifier(
      value.bridge_generation,
      "bridge generation",
    ),
    client_fence_ref: federationIdentifier(value.client_fence_ref, "client fence"),
    allowed_reference_manifest_ref: federationVersionedRef(
      value.allowed_reference_manifest_ref,
      "manifest ref",
    ),
    trace_id: federationIdentifier(value.trace_id, "trace id"),
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
  return parsed.data;
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
  const { manifest_digest: _manifestDigest, ...payload } = parsed.data;
  if (await federationDigest(payload) !== parsed.data.manifest_digest) {
    federationD1Fail("FEDERATION_D1_INPUT_INVALID", "manifest digest mismatch");
  }
  return parsed.data;
}

async function decodeManifest(row: ManifestRow): Promise<AllowedReferenceManifest> {
  const manifest = await parseFederationManifest(
    parseCanonical(row.manifest_json, "stored manifest"),
  );
  const storedRef = federationVersionedRef(
    { id: row.manifest_id, revision: row.revision },
    "stored manifest ref",
  );
  const storedScope = federationVersionedRef(
    { id: row.scope_snapshot_id, revision: row.scope_snapshot_revision },
    "stored scope ref",
  );
  const fence = row.client_fence_ref === null
    ? undefined
    : federationIdentifier(row.client_fence_ref, "stored client fence");
  if (
    !sameRef(manifest.manifest_ref, storedRef) ||
    !sameRef(manifest.scope_snapshot_ref, storedScope) ||
    manifest.manifest_digest !== sha256(
      row.manifest_digest,
      "stored manifest digest",
    ) ||
    manifest.client_fence_ref !== fence ||
    manifest.expires_at !== row.expires_at
  ) {
    federationD1Fail(
      "FEDERATION_D1_INPUT_INVALID",
      "stored manifest columns diverge from canonical bytes",
    );
  }
  federationTimestamp(row.created_at, "stored manifest created_at");
  return manifest;
}

export async function readFederationManifest(
  database: D1Database,
  ref: VersionedRef,
): Promise<AllowedReferenceManifest | null> {
  const row = await database.prepare(
    `${FEDERATION_MANIFEST_SELECT}WHERE manifest_id=?1 AND revision=?2 LIMIT 1`,
  ).bind(ref.id, ref.revision).first<ManifestRow>();
  return row === null ? null : decodeManifest(row);
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
    binding.server_principal_ref,
    binding.bridge_generation,
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

async function decodeFederationJob(row: JobRow): Promise<DecodedFederationJob> {
  const request = normalizeFederationRequest(
    parseCanonical(row.request_json, "stored request"),
  );
  const requestDigest = sha256(row.request_digest, "stored request digest");
  if (await federationDigest(request) !== requestDigest) {
    federationD1Fail(
      "FEDERATION_D1_INPUT_INVALID",
      "stored request digest mismatch",
    );
  }
  const statusParsed = FederationJobStatusSchema.safeParse(
    parseCanonical(row.status_json, "stored status"),
  );
  if (!statusParsed.success) {
    federationD1Fail("FEDERATION_D1_INPUT_INVALID", "stored status is invalid");
  }
  const status = statusParsed.data;
  const binding: FederationAuthorityBinding = {
    requester_principal_ref: federationIdentifier(
      row.requester_principal_ref,
      "stored requester",
    ),
    requester_credential_generation: federationIdentifier(
      row.requester_credential_generation,
      "stored requester generation",
    ),
    server_principal_ref: federationIdentifier(
      row.server_principal_ref,
      "stored server",
    ),
    server_credential_generation: federationIdentifier(
      row.server_credential_generation,
      "stored server generation",
    ),
    bridge_generation: federationIdentifier(
      row.bridge_generation,
      "stored bridge generation",
    ),
    client_fence_ref: federationIdentifier(
      row.client_fence_ref,
      "stored client fence",
    ),
    allowed_reference_manifest_ref: federationVersionedRef(
      { id: row.allowed_manifest_id, revision: row.allowed_manifest_revision },
      "stored manifest ref",
    ),
    trace_id: federationIdentifier(row.origin_trace_id, "stored trace id"),
  };
  const exchangeId = federationIdentifier(row.exchange_id, "stored exchange id");
  const idempotencyKey = federationIdentifier(
    row.idempotency_key,
    "stored idempotency key",
  );
  const jobId = federationIdentifier(row.job_id, "stored job id");
  if (
    request.exchange_id !== exchangeId ||
    request.idempotency_key !== idempotencyKey ||
    request.requester_principal_ref !== binding.requester_principal_ref ||
    request.bridge_generation !== binding.bridge_generation ||
    request.client_fence_ref !== binding.client_fence_ref ||
    status.exchange_id !== exchangeId ||
    status.idempotency_key !== idempotencyKey ||
    status.job_id !== jobId ||
    status.attempt !== row.attempt ||
    status.transport_state !== row.transport_state ||
    await stableFederationJobId(binding, request, requestDigest) !== jobId
  ) {
    federationD1Fail(
      "FEDERATION_D1_INPUT_INVALID",
      "stored job columns diverge from canonical bytes",
    );
  }
  let observed: CompletionDisposition | null = null;
  if (row.observed_completion_disposition !== null) {
    const parsed = CompletionDispositionSchema.safeParse(
      row.observed_completion_disposition,
    );
    if (!parsed.success) {
      federationD1Fail(
        "FEDERATION_D1_INPUT_INVALID",
        "stored disposition is invalid",
      );
    }
    observed = parsed.data;
  }
  let result: FederationEvidenceBundle | null = null;
  if (row.result_json !== null) {
    const parsed = FederationEvidenceBundleSchema.safeParse(
      parseCanonical(row.result_json, "stored result"),
    );
    if (!parsed.success) {
      federationD1Fail("FEDERATION_D1_INPUT_INVALID", "stored result is invalid");
    }
    result = parsed.data;
    if (
      result.exchange_id !== exchangeId ||
      result.job_id !== jobId ||
      result.request_digest !== requestDigest
    ) {
      federationD1Fail(
        "FEDERATION_D1_INPUT_INVALID",
        "stored result belongs to another job",
      );
    }
  }
  const cancellationReason = row.cancellation_reason === null
    ? null
    : validateFederationReason(row.cancellation_reason);
  const cancelledAt = row.cancelled_at === null
    ? null
    : federationTimestamp(row.cancelled_at, "cancelled_at");
  const activeOrFailed = FEDERATION_ACTIVE_STATES.has(status.transport_state) ||
    status.transport_state === "FAILED";
  const invalidState = status.transport_state === "CANCELLED"
    ? status.completion_disposition !== "CANCELLED" ||
      observed !== "CANCELLED" ||
      cancellationReason === null ||
      cancelledAt === null ||
      result !== null
    : cancellationReason !== null ||
      cancelledAt !== null ||
      (activeOrFailed &&
        (status.completion_disposition !== null ||
          observed !== null ||
          result !== null)) ||
      (status.transport_state === "COMPLETED" && observed === null);
  if (invalidState) {
    federationD1Fail(
      "FEDERATION_D1_INPUT_INVALID",
      "stored terminal state is inconsistent",
    );
  }
  federationTimestamp(row.created_at, "stored created_at");
  return {
    binding,
    request,
    record: {
      request_digest: requestDigest,
      status,
      observed_completion_disposition: observed,
      result,
    },
    cancellationReason,
    updatedAt: federationTimestamp(row.updated_at, "stored updated_at"),
  };
}

export async function readFederationJob(
  database: D1Database,
  exchangeId: string,
  idempotencyKey: string,
): Promise<DecodedFederationJob | null> {
  const row = await database.prepare(
    `${FEDERATION_JOB_SELECT}WHERE exchange_id=?1 AND idempotency_key=?2 LIMIT 1`,
  ).bind(exchangeId, idempotencyKey).first<JobRow>();
  return row === null ? null : decodeFederationJob(row);
}

export function sameFederationSubmission(
  existing: DecodedFederationJob,
  submission: FederationSubmission,
): boolean {
  return existing.record.request_digest === submission.request_digest &&
    federationCanonicalJson(existing.request) ===
      federationCanonicalJson(submission.request) &&
    sameFederationBinding(existing.binding, submission.binding);
}

export function federationMutationApplied(result: D1Result<unknown>): boolean {
  return (result.meta?.changes ?? 0) === 1;
}
