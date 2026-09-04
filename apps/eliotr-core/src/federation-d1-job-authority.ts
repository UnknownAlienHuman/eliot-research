import {
  CompletionDispositionSchema,
  FederationEvidenceBundleSchema,
  FederationJobStatusSchema,
  FederationRequestSchema,
  IdentifierSchema,
  Sha256Schema,
  VersionedRefSchema,
  type CompletionDisposition,
  type FederationEvidenceBundle,
  type FederationJobStatus,
  type FederationRequest,
  type VersionedRef,
} from "@eliotr/contracts";
import {
  canonicalFederationJson,
  federationSha256Hex,
  type FederationAuthorityBinding,
  type FederationJobAuthority,
  type FederationJobRecord,
  type FederationSubmission,
  type FederationSubmissionReservation,
} from "./federation-service.js";

const MAX_REQUEST_BYTES = 256 * 1024;
const MAX_STATUS_BYTES = 256 * 1024;
const MAX_RESULT_BYTES = 1024 * 1024;
const encoder = new TextEncoder();
const COLUMN_ORDER = [
  "requester_principal_ref",
  "requester_credential_generation",
  "server_principal_ref",
  "server_credential_generation",
  "bridge_generation",
  "client_fence_ref",
  "allowed_reference_manifest_id",
  "allowed_reference_manifest_revision",
  "exchange_id",
  "idempotency_key",
  "request_digest",
  "request_json",
  "job_id",
  "attempt",
  "transport_state",
  "completion_disposition",
  "status_json",
  "observed_completion_disposition",
  "result_json",
  "cancellation_reason",
  "state_version",
  "created_at",
  "updated_at",
] as const;
const ROW_KEYS = new Set<string>(COLUMN_ORDER);
const SELECT_COLUMNS = COLUMN_ORDER.join(", ");
const ACTIVE_STATES = new Set(["ACCEPTED", "RUNNING", "PARTIAL", "BLOCKED"]);

export class FederationD1JobAuthorityError extends Error {
  public readonly code: string;
  public readonly retryable: boolean;
  public readonly ambiguous_effect?: "FEDERATION_JOB_WRITE";

  public constructor(
    code: string,
    message: string,
    options: {
      readonly retryable?: boolean;
      readonly ambiguous_effect?: "FEDERATION_JOB_WRITE";
      readonly cause?: unknown;
    } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "FederationD1JobAuthorityError";
    this.code = code;
    this.retryable = options.retryable ?? false;
    this.ambiguous_effect = options.ambiguous_effect;
  }
}

interface FederationJobRow {
  readonly requester_principal_ref: unknown;
  readonly requester_credential_generation: unknown;
  readonly server_principal_ref: unknown;
  readonly server_credential_generation: unknown;
  readonly bridge_generation: unknown;
  readonly client_fence_ref: unknown;
  readonly allowed_reference_manifest_id: unknown;
  readonly allowed_reference_manifest_revision: unknown;
  readonly exchange_id: unknown;
  readonly idempotency_key: unknown;
  readonly request_digest: unknown;
  readonly request_json: unknown;
  readonly job_id: unknown;
  readonly attempt: unknown;
  readonly transport_state: unknown;
  readonly completion_disposition: unknown;
  readonly status_json: unknown;
  readonly observed_completion_disposition: unknown;
  readonly result_json: unknown;
  readonly cancellation_reason: unknown;
  readonly state_version: unknown;
  readonly created_at: unknown;
  readonly updated_at: unknown;
}

interface DecodedFederationJobRow {
  readonly binding: FederationAuthorityBinding;
  readonly request: FederationRequest;
  readonly request_json: string;
  readonly record: FederationJobRecord;
  readonly cancellation_reason: string | null;
  readonly state_version: number;
  readonly created_at: string;
  readonly updated_at: string;
}

export interface D1FederationJobAuthorityOptions {
  readonly now?: () => string;
}

function fail(
  code: string,
  message: string,
  options: ConstructorParameters<typeof FederationD1JobAuthorityError>[2] = {},
): never {
  throw new FederationD1JobAuthorityError(code, message, options);
}

function plainRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail("FEDERATION_JOB_READBACK_INVALID", `${label} must be a plain object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    fail("FEDERATION_JOB_READBACK_INVALID", `${label} must be a plain object`);
  }
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!ROW_KEYS.has(key)) {
      fail(
        "FEDERATION_JOB_READBACK_INVALID",
        `${label} contains unsupported field ${key}`,
      );
    }
  }
  for (const key of ROW_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(record, key)) {
      fail("FEDERATION_JOB_READBACK_INVALID", `${label} is missing field ${key}`);
    }
  }
  return record;
}

function identifier(value: unknown, label: string): string {
  const parsed = IdentifierSchema.safeParse(value);
  if (!parsed.success) {
    fail("FEDERATION_JOB_READBACK_INVALID", `${label} is invalid`);
  }
  return parsed.data;
}

function positiveInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    fail("FEDERATION_JOB_READBACK_INVALID", `${label} must be a positive safe integer`);
  }
  return value;
}

function timestamp(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length < 20 || value.length > 35) {
    fail("FEDERATION_JOB_READBACK_INVALID", `${label} is not a bounded timestamp`);
  }
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) {
    fail("FEDERATION_JOB_READBACK_INVALID", `${label} is not canonical UTC ISO-8601`);
  }
  return value;
}

function nullableString(value: unknown, label: string, maxBytes: number): string | null {
  if (value === null) return null;
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    encoder.encode(value).byteLength > maxBytes
  ) {
    fail("FEDERATION_JOB_READBACK_INVALID", `${label} is invalid`);
  }
  return value;
}

function jsonValue(value: unknown, label: string, maxBytes: number): {
  readonly text: string;
  readonly parsed: unknown;
} {
  if (typeof value !== "string" || encoder.encode(value).byteLength > maxBytes) {
    fail("FEDERATION_JOB_READBACK_INVALID", `${label} exceeds its byte envelope`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch (cause) {
    fail("FEDERATION_JOB_READBACK_INVALID", `${label} is not valid JSON`, { cause });
  }
  if (canonicalFederationJson(parsed) !== value) {
    fail("FEDERATION_JOB_READBACK_INVALID", `${label} is not canonical JSON`);
  }
  return { text: value, parsed };
}

function parseDisposition(value: unknown, label: string): CompletionDisposition | null {
  if (value === null) return null;
  const parsed = CompletionDispositionSchema.safeParse(value);
  if (!parsed.success) {
    fail("FEDERATION_JOB_READBACK_INVALID", `${label} is invalid`);
  }
  return parsed.data;
}

function parseManifestRef(row: Record<string, unknown>): VersionedRef {
  const parsed = VersionedRefSchema.safeParse({
    id: row.allowed_reference_manifest_id,
    revision: row.allowed_reference_manifest_revision,
  });
  if (!parsed.success) {
    fail("FEDERATION_JOB_READBACK_INVALID", "stored manifest reference is invalid");
  }
  return parsed.data;
}

function sameRef(left: VersionedRef, right: VersionedRef): boolean {
  return left.id === right.id && left.revision === right.revision;
}

function sameBinding(left: FederationAuthorityBinding, right: FederationAuthorityBinding): boolean {
  return (
    left.requester_principal_ref === right.requester_principal_ref &&
    left.requester_credential_generation === right.requester_credential_generation &&
    left.server_principal_ref === right.server_principal_ref &&
    left.server_credential_generation === right.server_credential_generation &&
    left.bridge_generation === right.bridge_generation &&
    left.client_fence_ref === right.client_fence_ref &&
    sameRef(left.allowed_reference_manifest_ref, right.allowed_reference_manifest_ref)
  );
}

function decodeRow(raw: unknown): DecodedFederationJobRow {
  const row = plainRecord(raw, "federation job row");
  const manifestRef = parseManifestRef(row);
  const binding: FederationAuthorityBinding = {
    requester_principal_ref: identifier(row.requester_principal_ref, "requester principal"),
    requester_credential_generation: identifier(
      row.requester_credential_generation,
      "requester credential generation",
    ),
    server_principal_ref: identifier(row.server_principal_ref, "server principal"),
    server_credential_generation: identifier(
      row.server_credential_generation,
      "server credential generation",
    ),
    bridge_generation: identifier(row.bridge_generation, "bridge generation"),
    client_fence_ref: identifier(row.client_fence_ref, "client fence"),
    allowed_reference_manifest_ref: manifestRef,
    trace_id: "stored-federation-job",
  };
  const requestValue = jsonValue(row.request_json, "request_json", MAX_REQUEST_BYTES);
  const request = FederationRequestSchema.safeParse(requestValue.parsed);
  if (!request.success) {
    fail("FEDERATION_JOB_READBACK_INVALID", "stored federation request is invalid");
  }
  const digest = Sha256Schema.safeParse(row.request_digest);
  if (!digest.success) {
    fail("FEDERATION_JOB_READBACK_INVALID", "stored request digest is invalid");
  }
  const statusValue = jsonValue(row.status_json, "status_json", MAX_STATUS_BYTES);
  const status = FederationJobStatusSchema.safeParse(statusValue.parsed);
  if (!status.success) {
    fail("FEDERATION_JOB_READBACK_INVALID", "stored federation status is invalid");
  }
  const attempt = positiveInteger(row.attempt, "attempt");
  const transportState = identifier(row.transport_state, "transport state");
  const completion = parseDisposition(row.completion_disposition, "completion disposition");
  const observed = parseDisposition(
    row.observed_completion_disposition,
    "observed completion disposition",
  );
  if (
    request.data.requester_principal_ref !== binding.requester_principal_ref ||
    request.data.bridge_generation !== binding.bridge_generation ||
    request.data.client_fence_ref !== binding.client_fence_ref ||
    request.data.exchange_id !== identifier(row.exchange_id, "exchange id") ||
    request.data.idempotency_key !== identifier(row.idempotency_key, "idempotency key")
  ) {
    fail("FEDERATION_JOB_READBACK_INVALID", "stored request identity differs from row authority");
  }
  if (canonicalFederationJson(request.data) !== requestValue.text) {
    fail("FEDERATION_JOB_READBACK_INVALID", "stored request bytes differ after strict decoding");
  }
  if (
    status.data.exchange_id !== request.data.exchange_id ||
    status.data.idempotency_key !== request.data.idempotency_key ||
    status.data.job_id !== identifier(row.job_id, "job id") ||
    status.data.attempt !== attempt ||
    status.data.transport_state !== transportState ||
    status.data.completion_disposition !== completion
  ) {
    fail("FEDERATION_JOB_READBACK_INVALID", "stored status identity differs from row authority");
  }

  const resultValue = row.result_json === null
    ? null
    : jsonValue(row.result_json, "result_json", MAX_RESULT_BYTES);
  let result: FederationEvidenceBundle | null = null;
  if (resultValue !== null) {
    const parsed = FederationEvidenceBundleSchema.safeParse(resultValue.parsed);
    if (!parsed.success) {
      fail("FEDERATION_JOB_READBACK_INVALID", "stored evidence bundle is invalid");
    }
    if (
      parsed.data.exchange_id !== request.data.exchange_id ||
      parsed.data.job_id !== status.data.job_id ||
      parsed.data.request_digest !== digest.data ||
      canonicalFederationJson(parsed.data) !== resultValue.text
    ) {
      fail("FEDERATION_JOB_READBACK_INVALID", "stored evidence bundle identity differs from job");
    }
    result = parsed.data;
  }

  if (
    (ACTIVE_STATES.has(status.data.transport_state) || status.data.transport_state === "FAILED") &&
    (completion !== null || observed !== null || result !== null)
  ) {
    fail("FEDERATION_JOB_READBACK_INVALID", "non-completed job exposes a terminal outcome");
  }
  const cancellationReason = nullableString(row.cancellation_reason, "cancellation reason", 4096);
  if (
    status.data.transport_state === "CANCELLED" &&
    (completion !== "CANCELLED" || observed !== "CANCELLED" || result !== null || cancellationReason === null)
  ) {
    fail("FEDERATION_JOB_READBACK_INVALID", "cancelled job authority is inconsistent");
  }
  if (
    status.data.transport_state === "COMPLETED" &&
    (completion === null || observed === null)
  ) {
    fail("FEDERATION_JOB_READBACK_INVALID", "completed job lacks terminal dispositions");
  }
  if (status.data.transport_state !== "CANCELLED" && cancellationReason !== null) {
    fail("FEDERATION_JOB_READBACK_INVALID", "non-cancelled job carries a cancellation reason");
  }

  return {
    binding,
    request: request.data,
    request_json: requestValue.text,
    record: {
      request_digest: digest.data,
      status: status.data,
      observed_completion_disposition: observed,
      result,
    },
    cancellation_reason: cancellationReason,
    state_version: positiveInteger(row.state_version, "state version"),
    created_at: timestamp(row.created_at, "created_at"),
    updated_at: timestamp(row.updated_at, "updated_at"),
  };
}

function identityValues(
  binding: FederationAuthorityBinding,
  exchangeId: string,
  idempotencyKey: string,
): readonly unknown[] {
  return [
    binding.requester_principal_ref,
    binding.requester_credential_generation,
    binding.server_principal_ref,
    binding.server_credential_generation,
    binding.bridge_generation,
    binding.client_fence_ref,
    exchangeId,
    idempotencyKey,
  ];
}

function identityWhere(): string {
  return (
    "requester_principal_ref=?1 AND requester_credential_generation=?2 " +
    "AND server_principal_ref=?3 AND server_credential_generation=?4 " +
    "AND bridge_generation=?5 AND client_fence_ref=?6 " +
    "AND exchange_id=?7 AND idempotency_key=?8"
  );
}

async function readRow(
  database: D1Database,
  binding: FederationAuthorityBinding,
  exchangeId: string,
  idempotencyKey: string,
): Promise<DecodedFederationJobRow | null> {
  let raw: FederationJobRow | null;
  try {
    raw = await database
      .prepare(`SELECT ${SELECT_COLUMNS} FROM federation_job WHERE ${identityWhere()} LIMIT 1`)
      .bind(...identityValues(binding, exchangeId, idempotencyKey))
      .first<FederationJobRow>();
  } catch (cause) {
    fail("FEDERATION_JOB_READ_FAILED", "federation job read failed", {
      retryable: true,
      cause,
    });
  }
  if (raw === null) return null;
  const decoded = decodeRow(raw);
  if (!sameBinding(decoded.binding, binding)) {
    fail("FEDERATION_JOB_AUTHORITY_MISMATCH", "federation job belongs to another manifest authority");
  }
  return decoded;
}

function sameImmutableSubmission(
  row: DecodedFederationJobRow,
  submission: FederationSubmission,
  requestJson: string,
  jobId: string,
): boolean {
  return (
    sameBinding(row.binding, submission.binding) &&
    row.request_json === requestJson &&
    row.record.request_digest === submission.request_digest &&
    row.record.status.job_id === jobId
  );
}

async function deterministicJobId(submission: FederationSubmission): Promise<string> {
  const digest = await federationSha256Hex(
    canonicalFederationJson({
      bridge_generation: submission.binding.bridge_generation,
      client_fence_ref: submission.binding.client_fence_ref,
      exchange_id: submission.request.exchange_id,
      idempotency_key: submission.request.idempotency_key,
      request_digest: submission.request_digest,
      requester_credential_generation: submission.binding.requester_credential_generation,
      requester_principal_ref: submission.binding.requester_principal_ref,
      server_credential_generation: submission.binding.server_credential_generation,
      server_principal_ref: submission.binding.server_principal_ref,
    }),
  );
  return `fjob-${digest}`;
}

function currentTimestamp(now: () => string): string {
  return timestamp(now(), "federation authority clock");
}

function recordReservation(
  outcome: "CREATED" | "REPLAY",
  row: DecodedFederationJobRow,
): FederationSubmissionReservation {
  return {
    outcome,
    request_digest: row.record.request_digest,
    record: row.record,
  };
}

/**
 * Implements the ER-22 job port against one strict CORE_DB row. Unknown D1
 * mutation effects are reconciled by one exact read and are never retried.
 */
export function createD1FederationJobAuthority(
  database: D1Database,
  options: D1FederationJobAuthorityOptions = {},
): FederationJobAuthority {
  if (
    typeof database !== "object" ||
    database === null ||
    typeof database.prepare !== "function"
  ) {
    fail("FEDERATION_JOB_CONFIGURATION_INVALID", "CORE_DB binding is invalid");
  }
  const now = options.now ?? (() => new Date().toISOString());

  return Object.freeze({
    async reserve(submission): Promise<FederationSubmissionReservation> {
      const requestJson = canonicalFederationJson(submission.request);
      if (
        encoder.encode(requestJson).byteLength > MAX_REQUEST_BYTES ||
        await federationSha256Hex(requestJson) !== submission.request_digest
      ) {
        fail("FEDERATION_JOB_SUBMISSION_INVALID", "submission request digest or bytes are invalid");
      }
      const jobId = await deterministicJobId(submission);
      const observedAt = currentTimestamp(now);
      const status: FederationJobStatus = {
        exchange_id: submission.request.exchange_id,
        idempotency_key: submission.request.idempotency_key,
        job_id: jobId,
        attempt: 1,
        transport_state: "ACCEPTED",
        completion_disposition: null,
        completed_obligation_refs: [],
        partial_bundle_refs: [],
        open_research_debt_refs: [],
      };
      const statusJson = canonicalFederationJson(status);
      const values = [
        submission.binding.requester_principal_ref,
        submission.binding.requester_credential_generation,
        submission.binding.server_principal_ref,
        submission.binding.server_credential_generation,
        submission.binding.bridge_generation,
        submission.binding.client_fence_ref,
        submission.binding.allowed_reference_manifest_ref.id,
        submission.binding.allowed_reference_manifest_ref.revision,
        submission.request.exchange_id,
        submission.request.idempotency_key,
        submission.request_digest,
        requestJson,
        jobId,
        1,
        "ACCEPTED",
        null,
        statusJson,
        null,
        null,
        null,
        1,
        observedAt,
        observedAt,
      ] as const;
      const sql =
        `INSERT INTO federation_job(${SELECT_COLUMNS}) VALUES (` +
        values.map((_, index) => `?${index + 1}`).join(",") +
        `) ON CONFLICT DO NOTHING RETURNING ${SELECT_COLUMNS}`;

      let raw: FederationJobRow | null;
      try {
        raw = await database.prepare(sql).bind(...values).first<FederationJobRow>();
      } catch (cause) {
        try {
          const observed = await readRow(
            database,
            submission.binding,
            submission.request.exchange_id,
            submission.request.idempotency_key,
          );
          if (
            observed !== null &&
            sameImmutableSubmission(observed, submission, requestJson, jobId)
          ) {
            return recordReservation("REPLAY", observed);
          }
        } catch {
          // Preserve the original ambiguous write classification.
        }
        fail("FEDERATION_JOB_WRITE_UNCERTAIN", "federation job reservation effect is unknown", {
          ambiguous_effect: "FEDERATION_JOB_WRITE",
          cause,
        });
      }
      if (raw !== null) {
        const created = decodeRow(raw);
        if (!sameImmutableSubmission(created, submission, requestJson, jobId)) {
          fail("FEDERATION_JOB_READBACK_INVALID", "created federation job differs from submission");
        }
        return recordReservation("CREATED", created);
      }

      const existing = await readRow(
        database,
        submission.binding,
        submission.request.exchange_id,
        submission.request.idempotency_key,
      );
      if (existing === null) {
        fail("FEDERATION_JOB_WRITE_FAILED", "reservation returned no row and no authority state", {
          retryable: true,
        });
      }
      if (sameImmutableSubmission(existing, submission, requestJson, jobId)) {
        return recordReservation("REPLAY", existing);
      }
      return {
        outcome: "CONFLICT",
        existing_request_digest: existing.record.request_digest,
      };
    },

    async read(binding, exchangeId, idempotencyKey): Promise<FederationJobRecord | null> {
      return (await readRow(database, binding, exchangeId, idempotencyKey))?.record ?? null;
    },

    async cancel(binding, exchangeId, idempotencyKey, reason): Promise<FederationJobRecord | null> {
      const current = await readRow(database, binding, exchangeId, idempotencyKey);
      if (current === null) return null;
      if (current.record.status.transport_state === "CANCELLED") {
        if (current.cancellation_reason !== reason) {
          fail("FEDERATION_JOB_CANCEL_CONFLICT", "job was cancelled with another reason");
        }
        return current.record;
      }
      if (!ACTIVE_STATES.has(current.record.status.transport_state)) {
        fail("FEDERATION_JOB_TERMINAL", "terminal federation job cannot be cancelled");
      }

      const cancellationReceiptRef = `cancel-${await federationSha256Hex(
        canonicalFederationJson({
          job_id: current.record.status.job_id,
          reason,
          state_version: current.state_version,
        }),
      )}`;
      const cancelledStatus: FederationJobStatus = {
        ...current.record.status,
        transport_state: "CANCELLED",
        completion_disposition: "CANCELLED",
        cancellation_receipt_ref: cancellationReceiptRef,
      };
      const statusJson = canonicalFederationJson(cancelledStatus);
      const observedAt = currentTimestamp(now);
      const nextVersion = current.state_version + 1;
      const updateSql =
        "UPDATE federation_job SET transport_state='CANCELLED', " +
        "completion_disposition='CANCELLED', status_json=?9, " +
        "observed_completion_disposition='CANCELLED', result_json=NULL, " +
        "cancellation_reason=?10, state_version=?11, updated_at=?12 " +
        `WHERE ${identityWhere()} AND state_version=?13 ` +
        "AND transport_state IN ('ACCEPTED','RUNNING','PARTIAL','BLOCKED') " +
        `RETURNING ${SELECT_COLUMNS}`;
      const updateValues = [
        ...identityValues(binding, exchangeId, idempotencyKey),
        statusJson,
        reason,
        nextVersion,
        observedAt,
        current.state_version,
      ] as const;

      let raw: FederationJobRow | null;
      try {
        raw = await database
          .prepare(updateSql)
          .bind(...updateValues)
          .first<FederationJobRow>();
      } catch (cause) {
        try {
          const observed = await readRow(database, binding, exchangeId, idempotencyKey);
          if (
            observed !== null &&
            observed.record.status.transport_state === "CANCELLED" &&
            observed.cancellation_reason === reason &&
            observed.record.status.cancellation_receipt_ref === cancellationReceiptRef
          ) {
            return observed.record;
          }
        } catch {
          // Preserve the original ambiguous write classification.
        }
        fail("FEDERATION_JOB_WRITE_UNCERTAIN", "federation cancellation effect is unknown", {
          ambiguous_effect: "FEDERATION_JOB_WRITE",
          cause,
        });
      }
      if (raw !== null) return decodeRow(raw).record;

      const observed = await readRow(database, binding, exchangeId, idempotencyKey);
      if (
        observed !== null &&
        observed.record.status.transport_state === "CANCELLED" &&
        observed.cancellation_reason === reason &&
        observed.record.status.cancellation_receipt_ref === cancellationReceiptRef
      ) {
        return observed.record;
      }
      fail("FEDERATION_JOB_WRITE_CONFLICT", "federation job changed before cancellation CAS", {
        retryable: true,
      });
    },
  });
}
