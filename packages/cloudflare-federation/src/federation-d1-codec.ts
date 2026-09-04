import {
  CompletionDispositionSchema,
  FederationEvidenceBundleSchema,
  FederationJobStatusSchema,
  type AllowedReferenceManifest,
  type CompletionDisposition,
  type FederationEvidenceBundle,
  type VersionedRef,
} from "@eliotr/contracts";
import {
  FEDERATION_ACTIVE_STATES,
  FEDERATION_MANIFEST_JSON_MAX_BYTES,
  FEDERATION_REQUEST_JSON_MAX_BYTES,
  FEDERATION_RESULT_JSON_MAX_BYTES,
  FEDERATION_STATUS_JSON_MAX_BYTES,
  FederationD1AuthorityError,
  federationCancellationReceiptRef,
  federationCanonicalJson,
  federationD1Fail,
  federationDigest,
  federationIdentifier,
  federationParseCanonical,
  federationSha256,
  federationTimestamp,
  federationVersionedRef,
  normalizeFederationRequest,
  parseFederationManifest,
  sameFederationBinding,
  stableFederationJobId,
  validateFederationReason,
  type FederationAuthorityBinding,
  type FederationJobRecord,
  type FederationSubmission,
} from "./federation-d1-common.js";

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
  readonly request: FederationSubmission["request"];
  readonly record: FederationJobRecord;
  readonly cancellationReason: string | null;
  readonly updatedAt: string;
}

function positiveInteger(value: unknown, label: string): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 1
  ) {
    federationD1Fail("FEDERATION_D1_INPUT_INVALID", `${label} is invalid`);
  }
  return value;
}

function sameRef(left: VersionedRef, right: VersionedRef): boolean {
  return left.id === right.id && left.revision === right.revision;
}

async function decodeManifest(
  row: ManifestRow,
): Promise<AllowedReferenceManifest> {
  const manifest = await parseFederationManifest(
    federationParseCanonical(
      row.manifest_json,
      "stored manifest",
      FEDERATION_MANIFEST_JSON_MAX_BYTES,
    ),
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
  const expiresAt = federationTimestamp(
    row.expires_at,
    "stored manifest expires_at",
  );
  const createdAt = federationTimestamp(
    row.created_at,
    "stored manifest created_at",
  );
  if (
    !sameRef(manifest.manifest_ref, storedRef) ||
    !sameRef(manifest.scope_snapshot_ref, storedScope) ||
    manifest.manifest_digest !== federationSha256(
      row.manifest_digest,
      "stored manifest digest",
    ) ||
    manifest.client_fence_ref !== fence ||
    manifest.expires_at !== expiresAt ||
    Date.parse(createdAt) >= Date.parse(expiresAt)
  ) {
    federationD1Fail(
      "FEDERATION_D1_INPUT_INVALID",
      "stored manifest columns diverge from canonical bytes",
    );
  }
  return manifest;
}

function readFailed(label: string, cause: unknown): never {
  if (cause instanceof FederationD1AuthorityError) throw cause;
  federationD1Fail(
    "FEDERATION_D1_READ_FAILED",
    `${label} read failed`,
    true,
    cause,
  );
}

export async function readFederationManifest(
  database: D1Database,
  rawRef: VersionedRef,
): Promise<AllowedReferenceManifest | null> {
  const ref = federationVersionedRef(rawRef, "manifest ref");
  let row: ManifestRow | null;
  try {
    row = await database.prepare(
      `${FEDERATION_MANIFEST_SELECT}WHERE manifest_id=?1 AND revision=?2 LIMIT 1`,
    ).bind(ref.id, ref.revision).first<ManifestRow>();
  } catch (cause) {
    return readFailed("federation manifest", cause);
  }
  return row === null ? null : decodeManifest(row);
}

function decodeDisposition(value: unknown): CompletionDisposition | null {
  if (value === null) return null;
  const parsed = CompletionDispositionSchema.safeParse(value);
  if (!parsed.success) {
    federationD1Fail(
      "FEDERATION_D1_INPUT_INVALID",
      "stored disposition is invalid",
    );
  }
  return parsed.data;
}

function decodeBinding(row: JobRow): FederationAuthorityBinding {
  return {
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
}

function decodeResult(
  row: JobRow,
  exchangeId: string,
  jobId: string,
  requestDigest: string,
): FederationEvidenceBundle | null {
  if (row.result_json === null) return null;
  const parsed = FederationEvidenceBundleSchema.safeParse(
    federationParseCanonical(
      row.result_json,
      "stored result",
      FEDERATION_RESULT_JSON_MAX_BYTES,
    ),
  );
  if (!parsed.success) {
    federationD1Fail("FEDERATION_D1_INPUT_INVALID", "stored result is invalid");
  }
  if (
    parsed.data.exchange_id !== exchangeId ||
    parsed.data.job_id !== jobId ||
    parsed.data.request_digest !== requestDigest
  ) {
    federationD1Fail(
      "FEDERATION_D1_INPUT_INVALID",
      "stored result belongs to another job",
    );
  }
  return parsed.data;
}

async function assertJobState(
  status: FederationJobRecord["status"],
  observed: CompletionDisposition | null,
  result: FederationEvidenceBundle | null,
  cancellationReason: string | null,
  cancelledAt: string | null,
  updatedAt: string,
  jobId: string,
): Promise<void> {
  const active = FEDERATION_ACTIVE_STATES.has(
    status.transport_state as "ACCEPTED" | "RUNNING" | "PARTIAL" | "BLOCKED",
  );
  const expectedReceipt =
    status.transport_state === "CANCELLED" && cancellationReason !== null
      ? await federationCancellationReceiptRef(jobId, cancellationReason)
      : null;
  const terminalWithoutReceipt =
    (status.transport_state === "COMPLETED" ||
      status.transport_state === "FAILED") &&
    status.terminal_receipt_ref === undefined;
  const invalid = status.transport_state === "CANCELLED"
    ? status.completion_disposition !== "CANCELLED" ||
      observed !== "CANCELLED" ||
      cancellationReason === null ||
      cancelledAt === null ||
      cancelledAt !== updatedAt ||
      result !== null ||
      status.cancellation_receipt_ref !== expectedReceipt ||
      status.terminal_receipt_ref !== expectedReceipt
    : cancellationReason !== null ||
      cancelledAt !== null ||
      status.cancellation_receipt_ref !== undefined ||
      (active && status.terminal_receipt_ref !== undefined) ||
      terminalWithoutReceipt ||
      ((active || status.transport_state === "FAILED") &&
        (status.completion_disposition !== null ||
          observed !== null ||
          result !== null)) ||
      (status.transport_state === "COMPLETED" && observed === null);
  if (invalid) {
    federationD1Fail(
      "FEDERATION_D1_INPUT_INVALID",
      "stored terminal state is inconsistent",
    );
  }
}

async function decodeFederationJob(
  row: JobRow,
): Promise<DecodedFederationJob> {
  const request = normalizeFederationRequest(
    federationParseCanonical(
      row.request_json,
      "stored request",
      FEDERATION_REQUEST_JSON_MAX_BYTES,
    ),
  );
  const requestDigest = federationSha256(
    row.request_digest,
    "stored request digest",
  );
  if (await federationDigest(request) !== requestDigest) {
    federationD1Fail(
      "FEDERATION_D1_INPUT_INVALID",
      "stored request digest mismatch",
    );
  }
  const statusParsed = FederationJobStatusSchema.safeParse(
    federationParseCanonical(
      row.status_json,
      "stored status",
      FEDERATION_STATUS_JSON_MAX_BYTES,
    ),
  );
  if (!statusParsed.success) {
    federationD1Fail("FEDERATION_D1_INPUT_INVALID", "stored status is invalid");
  }
  const status = statusParsed.data;
  const binding = decodeBinding(row);
  const exchangeId = federationIdentifier(row.exchange_id, "stored exchange id");
  const idempotencyKey = federationIdentifier(
    row.idempotency_key,
    "stored idempotency key",
  );
  const jobId = federationIdentifier(row.job_id, "stored job id");
  const attempt = positiveInteger(row.attempt, "stored attempt");
  if (
    request.exchange_id !== exchangeId ||
    request.idempotency_key !== idempotencyKey ||
    request.requester_principal_ref !== binding.requester_principal_ref ||
    request.bridge_generation !== binding.bridge_generation ||
    request.client_fence_ref !== binding.client_fence_ref ||
    status.exchange_id !== exchangeId ||
    status.idempotency_key !== idempotencyKey ||
    status.job_id !== jobId ||
    status.attempt !== attempt ||
    status.transport_state !== row.transport_state ||
    await stableFederationJobId(binding, request, requestDigest) !== jobId
  ) {
    federationD1Fail(
      "FEDERATION_D1_INPUT_INVALID",
      "stored job columns diverge from canonical bytes",
    );
  }

  const observed = decodeDisposition(row.observed_completion_disposition);
  const result = decodeResult(row, exchangeId, jobId, requestDigest);
  const cancellationReason = row.cancellation_reason === null
    ? null
    : validateFederationReason(row.cancellation_reason);
  const cancelledAt = row.cancelled_at === null
    ? null
    : federationTimestamp(row.cancelled_at, "cancelled_at");
  const createdAt = federationTimestamp(row.created_at, "stored created_at");
  const updatedAt = federationTimestamp(row.updated_at, "stored updated_at");
  if (Date.parse(updatedAt) < Date.parse(createdAt)) {
    federationD1Fail(
      "FEDERATION_D1_INPUT_INVALID",
      "stored job update precedes creation",
    );
  }
  await assertJobState(
    status,
    observed,
    result,
    cancellationReason,
    cancelledAt,
    updatedAt,
    jobId,
  );
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
    updatedAt,
  };
}

export async function readFederationJob(
  database: D1Database,
  rawExchangeId: string,
  rawIdempotencyKey: string,
): Promise<DecodedFederationJob | null> {
  const exchangeId = federationIdentifier(rawExchangeId, "exchange id");
  const idempotencyKey = federationIdentifier(
    rawIdempotencyKey,
    "idempotency key",
  );
  let row: JobRow | null;
  try {
    row = await database.prepare(
      `${FEDERATION_JOB_SELECT}WHERE exchange_id=?1 AND idempotency_key=?2 LIMIT 1`,
    ).bind(exchangeId, idempotencyKey).first<JobRow>();
  } catch (cause) {
    return readFailed("federation job", cause);
  }
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
