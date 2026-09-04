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
  type FederationJobStatus,
  type FederationRequest,
  type VersionedRef,
} from "@eliotr/contracts";
import { canonicalDigest } from "./d1-ingest-validation.js";
import { canonicalJson } from "./ingest-validation.js";

const MANIFEST_SELECT =
  "SELECT manifest_id, revision, manifest_json, manifest_digest, scope_snapshot_id, " +
  "scope_snapshot_revision, client_fence_ref, expires_at, created_at " +
  "FROM federation_reference_manifest ";
const JOB_SELECT =
  "SELECT job_id, exchange_id, idempotency_key, request_digest, request_json, " +
  "requester_principal_ref, requester_credential_generation, server_principal_ref, " +
  "server_credential_generation, bridge_generation, client_fence_ref, " +
  "allowed_manifest_id, allowed_manifest_revision, origin_trace_id, attempt, " +
  "transport_state, status_json, observed_completion_disposition, result_json, " +
  "cancellation_reason, cancelled_at, created_at, updated_at FROM federation_job ";
const MAX_CANCEL_REASON_BYTES = 4 * 1024;
const ACTIVE_TRANSPORT_STATES = new Set([
  "ACCEPTED",
  "RUNNING",
  "PARTIAL",
  "BLOCKED",
]);
const encoder = new TextEncoder();

export type FederationD1AuthorityErrorCode =
  | "FEDERATION_D1_INPUT_INVALID"
  | "FEDERATION_D1_MANIFEST_CONFLICT"
  | "FEDERATION_D1_BINDING_MISMATCH"
  | "FEDERATION_D1_STATE_CONFLICT"
  | "FEDERATION_D1_SETTLEMENT_UNCERTAIN";

export class FederationD1AuthorityError extends Error {
  public readonly code: FederationD1AuthorityErrorCode;
  public readonly retryable: boolean;

  public constructor(
    code: FederationD1AuthorityErrorCode,
    message: string,
    retryable = false,
    cause?: unknown,
  ) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "FederationD1AuthorityError";
    this.code = code;
    this.retryable = retryable;
  }
}

export interface FederationAuthorityBindingInput {
  readonly requester_principal_ref: string;
  readonly requester_credential_generation: string;
  readonly server_principal_ref: string;
  readonly server_credential_generation: string;
  readonly bridge_generation: string;
  readonly client_fence_ref: string;
  readonly allowed_reference_manifest_ref: VersionedRef;
  readonly trace_id: string;
}

export interface FederationJobRecordValue {
  readonly request_digest: string;
  readonly status: FederationJobStatus;
  readonly observed_completion_disposition: CompletionDisposition | null;
  readonly result: FederationEvidenceBundle | null;
}

export interface FederationSubmissionInput {
  readonly binding: FederationAuthorityBindingInput;
  readonly request: FederationRequest;
  readonly request_digest: string;
}

export type FederationSubmissionReservationValue =
  | {
      readonly outcome: "CREATED" | "REPLAY";
      readonly request_digest: string;
      readonly record: FederationJobRecordValue;
    }
  | {
      readonly outcome: "CONFLICT";
      readonly existing_request_digest: string;
    };

export interface D1FederationJobAuthority {
  reserve(input: FederationSubmissionInput): Promise<FederationSubmissionReservationValue>;
  read(
    binding: FederationAuthorityBindingInput,
    exchangeId: string,
    idempotencyKey: string,
  ): Promise<FederationJobRecordValue | null>;
  cancel(
    binding: FederationAuthorityBindingInput,
    exchangeId: string,
    idempotencyKey: string,
    reason: string,
  ): Promise<FederationJobRecordValue | null>;
}

export interface D1FederationReferenceManifestAuthority {
  get(ref: VersionedRef): Promise<AllowedReferenceManifest | null>;
  put(manifest: AllowedReferenceManifest): Promise<{
    readonly disposition: "CREATED" | "EXISTING";
    readonly manifest: AllowedReferenceManifest;
  }>;
}

export interface D1FederationAuthorityDependencies {
  readonly now?: () => number;
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

interface DecodedJob {
  readonly binding: FederationAuthorityBindingInput;
  readonly request: FederationRequest;
  readonly record: FederationJobRecordValue;
  readonly cancellation_reason: string | null;
  readonly cancelled_at: string | null;
  readonly created_at: string;
  readonly updated_at: string;
}

function fail(
  code: FederationD1AuthorityErrorCode,
  message: string,
  retryable = false,
  cause?: unknown,
): never {
  throw new FederationD1AuthorityError(code, message, retryable, cause);
}

function identifier(value: unknown, label: string): string {
  const parsed = IdentifierSchema.safeParse(value);
  if (!parsed.success) fail("FEDERATION_D1_INPUT_INVALID", `${label} is invalid`);
  return parsed.data;
}

function positiveInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    fail("FEDERATION_D1_INPUT_INVALID", `${label} is not a positive safe integer`);
  }
  return value;
}

function sha256(value: unknown, label: string): string {
  const parsed = Sha256Schema.safeParse(value);
  if (!parsed.success) fail("FEDERATION_D1_INPUT_INVALID", `${label} is not a SHA-256 digest`);
  return parsed.data;
}

function versionedRef(value: unknown, label: string): VersionedRef {
  const parsed = VersionedRefSchema.safeParse(value);
  if (!parsed.success) fail("FEDERATION_D1_INPUT_INVALID", `${label} is invalid`);
  return parsed.data;
}

function canonicalTimestamp(value: unknown, label: string): string {
  if (typeof value !== "string") {
    fail("FEDERATION_D1_INPUT_INVALID", `${label} is not a canonical timestamp`);
  }
  const epoch = Date.parse(value);
  if (!Number.isSafeInteger(epoch) || new Date(epoch).toISOString() !== value) {
    fail("FEDERATION_D1_INPUT_INVALID", `${label} is not canonical ISO-8601 UTC`);
  }
  return value;
}

function clockTimestamp(clock: () => number): { readonly epoch: number; readonly iso: string } {
  const epoch = clock();
  if (!Number.isSafeInteger(epoch) || epoch < 0) {
    fail("FEDERATION_D1_INPUT_INVALID", "federation authority clock is invalid");
  }
  return { epoch, iso: new Date(epoch).toISOString() };
}

function parseCanonicalJson(value: unknown, label: string): unknown {
  if (typeof value !== "string") {
    fail("FEDERATION_D1_INPUT_INVALID", `${label} is not JSON text`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch (cause) {
    fail("FEDERATION_D1_INPUT_INVALID", `${label} is malformed JSON`, false, cause);
  }
  try {
    if (canonicalJson(parsed) !== value) {
      fail("FEDERATION_D1_INPUT_INVALID", `${label} is not canonical JSON`);
    }
  } catch (cause) {
    if (cause instanceof FederationD1AuthorityError) throw cause;
    fail("FEDERATION_D1_INPUT_INVALID", `${label} cannot be canonicalized`, false, cause);
  }
  return parsed;
}

function normalizeBinding(raw: FederationAuthorityBindingInput): FederationAuthorityBindingInput {
  return {
    requester_principal_ref: identifier(
      raw.requester_principal_ref,
      "requester principal_ref",
    ),
    requester_credential_generation: identifier(
      raw.requester_credential_generation,
      "requester credential_generation",
    ),
    server_principal_ref: identifier(raw.server_principal_ref, "server principal_ref"),
    server_credential_generation: identifier(
      raw.server_credential_generation,
      "server credential_generation",
    ),
    bridge_generation: identifier(raw.bridge_generation, "bridge generation"),
    client_fence_ref: identifier(raw.client_fence_ref, "client fence"),
    allowed_reference_manifest_ref: versionedRef(
      raw.allowed_reference_manifest_ref,
      "AllowedReferenceManifest ref",
    ),
    trace_id: identifier(raw.trace_id, "trace_id"),
  };
}

function sameVersionedRef(left: VersionedRef, right: VersionedRef): boolean {
  return left.id === right.id && left.revision === right.revision;
}

function sameBindingIdentity(
  left: FederationAuthorityBindingInput,
  right: FederationAuthorityBindingInput,
): boolean {
  return left.requester_principal_ref === right.requester_principal_ref &&
    left.requester_credential_generation === right.requester_credential_generation &&
    left.server_principal_ref === right.server_principal_ref &&
    left.server_credential_generation === right.server_credential_generation &&
    left.bridge_generation === right.bridge_generation &&
    left.client_fence_ref === right.client_fence_ref &&
    sameVersionedRef(
      left.allowed_reference_manifest_ref,
      right.allowed_reference_manifest_ref,
    );
}

function assertBindingIdentity(
  stored: FederationAuthorityBindingInput,
  requested: FederationAuthorityBindingInput,
): void {
  if (!sameBindingIdentity(stored, requested)) {
    fail(
      "FEDERATION_D1_BINDING_MISMATCH",
      "federation job is bound to another principal, generation, fence, or manifest",
    );
  }
}

async function digestWithoutManifestDigest(
  manifest: AllowedReferenceManifest,
): Promise<string> {
  const { manifest_digest: _manifestDigest, ...payload } = manifest;
  return canonicalDigest(payload);
}

async function parseManifest(value: unknown, label: string): Promise<AllowedReferenceManifest> {
  const parsed = AllowedReferenceManifestSchema.safeParse(value);
  if (!parsed.success) {
    fail("FEDERATION_D1_INPUT_INVALID", `${label} failed strict contract validation`);
  }
  if (await digestWithoutManifestDigest(parsed.data) !== parsed.data.manifest_digest) {
    fail("FEDERATION_D1_INPUT_INVALID", `${label} digest does not match its content`);
  }
  return parsed.data;
}

async function decodeManifestRow(row: ManifestRow): Promise<AllowedReferenceManifest> {
  const manifest = await parseManifest(
    parseCanonicalJson(row.manifest_json, "stored federation manifest"),
    "stored federation manifest",
  );
  const manifestRef = versionedRef({
    id: row.manifest_id,
    revision: row.revision,
  }, "stored federation manifest ref");
  const scopeRef = versionedRef({
    id: row.scope_snapshot_id,
    revision: row.scope_snapshot_revision,
  }, "stored federation scope ref");
  const storedDigest = sha256(row.manifest_digest, "stored federation manifest digest");
  const clientFence = row.client_fence_ref === null
    ? undefined
    : identifier(row.client_fence_ref, "stored federation client fence");
  const expiresAt = typeof row.expires_at === "string" ? row.expires_at : "";
  if (
    !sameVersionedRef(manifest.manifest_ref, manifestRef) ||
    !sameVersionedRef(manifest.scope_snapshot_ref, scopeRef) ||
    manifest.manifest_digest !== storedDigest ||
    manifest.expires_at !== expiresAt ||
    manifest.client_fence_ref !== clientFence
  ) {
    fail(
      "FEDERATION_D1_INPUT_INVALID",
      "stored federation manifest columns diverge from canonical manifest bytes",
    );
  }
  canonicalTimestamp(row.created_at, "stored federation manifest created_at");
  return manifest;
}

async function readManifest(
  database: D1Database,
  ref: VersionedRef,
): Promise<AllowedReferenceManifest | null> {
  const row = await database.prepare(
    `${MANIFEST_SELECT}WHERE manifest_id = ?1 AND revision = ?2 LIMIT 1`,
  ).bind(ref.id, ref.revision).first<ManifestRow>();
  return row === null ? null : decodeManifestRow(row);
}

function assertSameManifest(
  existing: AllowedReferenceManifest,
  expected: AllowedReferenceManifest,
): void {
  if (canonicalJson(existing) !== canonicalJson(expected)) {
    fail(
      "FEDERATION_D1_MANIFEST_CONFLICT",
      "manifest revision is already bound to different canonical bytes",
    );
  }
}

function normalizeRequest(raw: FederationRequest): FederationRequest {
  const parsed = FederationRequestSchema.safeParse(raw);
  if (!parsed.success) {
    fail("FEDERATION_D1_INPUT_INVALID", "federation request failed strict validation");
  }
  return parsed.data;
}

async function stableJobId(
  binding: FederationAuthorityBindingInput,
  request: FederationRequest,
  requestDigest: string,
): Promise<string> {
  const digest = await canonicalDigest([
    "federation-job",
    request.exchange_id,
    request.idempotency_key,
    requestDigest,
    binding.requester_principal_ref,
    binding.server_principal_ref,
    binding.bridge_generation,
  ]);
  return `fjob-${digest.slice(0, 48)}`;
}

async function cancellationReceiptRef(jobId: string, reason: string): Promise<string> {
  const digest = await canonicalDigest(["federation-cancel", jobId, reason]);
  return `federation-cancel-${digest.slice(0, 48)}`;
}

function initialStatus(request: FederationRequest, jobId: string): FederationJobStatus {
  return FederationJobStatusSchema.parse({
    exchange_id: request.exchange_id,
    idempotency_key: request.idempotency_key,
    job_id: jobId,
    attempt: 1,
    transport_state: "ACCEPTED",
    completion_disposition: null,
    completed_obligation_refs: [],
    partial_bundle_refs: [],
    open_research_debt_refs: [],
  });
}

function validateCancellationReason(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value !== value.trim() ||
    encoder.encode(value).byteLength > MAX_CANCEL_REASON_BYTES ||
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value)
  ) {
    fail("FEDERATION_D1_INPUT_INVALID", "federation cancellation reason is invalid");
  }
  return value;
}

async function decodeJobRow(row: JobRow): Promise<DecodedJob> {
  const requestValue = parseCanonicalJson(row.request_json, "stored federation request");
  const request = normalizeRequest(requestValue as FederationRequest);
  const requestDigest = sha256(row.request_digest, "stored federation request digest");
  if (await canonicalDigest(request) !== requestDigest) {
    fail("FEDERATION_D1_INPUT_INVALID", "stored federation request digest mismatch");
  }
  const statusValue = parseCanonicalJson(row.status_json, "stored federation status");
  const statusParsed = FederationJobStatusSchema.safeParse(statusValue);
  if (!statusParsed.success) {
    fail("FEDERATION_D1_INPUT_INVALID", "stored federation status failed strict validation");
  }
  const status = statusParsed.data;
  const binding: FederationAuthorityBindingInput = {
    requester_principal_ref: identifier(
      row.requester_principal_ref,
      "stored requester principal_ref",
    ),
    requester_credential_generation: identifier(
      row.requester_credential_generation,
      "stored requester credential generation",
    ),
    server_principal_ref: identifier(row.server_principal_ref, "stored server principal_ref"),
    server_credential_generation: identifier(
      row.server_credential_generation,
      "stored server credential generation",
    ),
    bridge_generation: identifier(row.bridge_generation, "stored bridge generation"),
    client_fence_ref: identifier(row.client_fence_ref, "stored client fence"),
    allowed_reference_manifest_ref: versionedRef({
      id: row.allowed_manifest_id,
      revision: row.allowed_manifest_revision,
    }, "stored AllowedReferenceManifest ref"),
    trace_id: identifier(row.origin_trace_id, "stored origin trace_id"),
  };
  const exchangeId = identifier(row.exchange_id, "stored exchange_id");
  const idempotencyKey = identifier(row.idempotency_key, "stored idempotency_key");
  const jobId = identifier(row.job_id, "stored federation job_id");
  const attempt = positiveInteger(row.attempt, "stored federation attempt");
  const transportState = identifier(row.transport_state, "stored federation transport state");
  const expectedJobId = await stableJobId(binding, request, requestDigest);
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
    status.transport_state !== transportState ||
    expectedJobId !== jobId
  ) {
    fail(
      "FEDERATION_D1_INPUT_INVALID",
      "stored federation job columns diverge from request/status authority",
    );
  }
  let observed: CompletionDisposition | null = null;
  if (row.observed_completion_disposition !== null) {
    const parsed = CompletionDispositionSchema.safeParse(row.observed_completion_disposition);
    if (!parsed.success) {
      fail("FEDERATION_D1_INPUT_INVALID", "stored observed disposition is invalid");
    }
    observed = parsed.data;
  }
  let result: FederationEvidenceBundle | null = null;
  if (row.result_json !== null) {
    const parsed = FederationEvidenceBundleSchema.safeParse(
      parseCanonicalJson(row.result_json, "stored federation result"),
    );
    if (!parsed.success) {
      fail("FEDERATION_D1_INPUT_INVALID", "stored federation result failed strict validation");
    }
    result = parsed.data;
    if (
      result.exchange_id !== exchangeId ||
      result.job_id !== jobId ||
      result.request_digest !== requestDigest
    ) {
      fail("FEDERATION_D1_INPUT_INVALID", "stored federation result is bound to another job");
    }
  }
  const cancellationReason = row.cancellation_reason === null
    ? null
    : validateCancellationReason(row.cancellation_reason);
  const cancelledAt = row.cancelled_at === null
    ? null
    : canonicalTimestamp(row.cancelled_at, "stored federation cancelled_at");
  if (
    status.transport_state === "CANCELLED"
      ? status.completion_disposition !== "CANCELLED" ||
        observed !== "CANCELLED" ||
        cancellationReason === null ||
        cancelledAt === null ||
        result !== null
      : cancellationReason !== null || cancelledAt !== null
  ) {
    fail("FEDERATION_D1_INPUT_INVALID", "stored federation cancellation state is inconsistent");
  }
  return {
    binding,
    request,
    record: {
      request_digest: requestDigest,
      status,
      observed_completion_disposition: observed,
      result,
    },
    cancellation_reason: cancellationReason,
    cancelled_at: cancelledAt,
    created_at: canonicalTimestamp(row.created_at, "stored federation created_at"),
    updated_at: canonicalTimestamp(row.updated_at, "stored federation updated_at"),
  };
}

async function readJob(
  database: D1Database,
  exchangeId: string,
  idempotencyKey: string,
): Promise<DecodedJob | null> {
  const row = await database.prepare(
    `${JOB_SELECT}WHERE exchange_id = ?1 AND idempotency_key = ?2 LIMIT 1`,
  ).bind(exchangeId, idempotencyKey).first<JobRow>();
  return row === null ? null : decodeJobRow(row);
}

function submissionMatches(existing: DecodedJob, input: FederationSubmissionInput): boolean {
  return existing.record.request_digest === input.request_digest &&
    canonicalJson(existing.request) === canonicalJson(input.request) &&
    sameBindingIdentity(existing.binding, input.binding);
}

function assertManifestAuthorizesBinding(
  manifest: AllowedReferenceManifest,
  binding: FederationAuthorityBindingInput,
): void {
  if (
    manifest.client_fence_ref !== binding.client_fence_ref ||
    manifest.provider_and_policy_generations[binding.requester_principal_ref] !==
      binding.requester_credential_generation ||
    manifest.provider_and_policy_generations[binding.server_principal_ref] !==
      binding.server_credential_generation
  ) {
    fail(
      "FEDERATION_D1_BINDING_MISMATCH",
      "AllowedReferenceManifest does not authorize the exact federation binding",
    );
  }
}

function mutationChangedExactlyOne(result: D1Result<unknown>): boolean {
  return (result.meta?.changes ?? 0) === 1;
}

export function createD1FederationReferenceManifestAuthority(
  database: D1Database,
  dependencies: D1FederationAuthorityDependencies = {},
): D1FederationReferenceManifestAuthority {
  const clock = dependencies.now ?? Date.now;
  return {
    async get(rawRef) {
      return readManifest(database, versionedRef(rawRef, "federation manifest ref"));
    },
    async put(rawManifest) {
      const manifest = await parseManifest(rawManifest, "federation manifest");
      const prior = await readManifest(database, manifest.manifest_ref);
      if (prior !== null) {
        assertSameManifest(prior, manifest);
        return { disposition: "EXISTING", manifest: prior };
      }
      const created = clockTimestamp(clock);
      if (Date.parse(manifest.expires_at) <= created.epoch) {
        fail("FEDERATION_D1_INPUT_INVALID", "cannot persist a newly expired federation manifest");
      }
      const manifestJson = canonicalJson(manifest);
      try {
        const result = await database.prepare(
          "INSERT INTO federation_reference_manifest(" +
          "manifest_id, revision, manifest_json, manifest_digest, scope_snapshot_id, " +
          "scope_snapshot_revision, client_fence_ref, expires_at, created_at) " +
          "VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9)",
        ).bind(
          manifest.manifest_ref.id,
          manifest.manifest_ref.revision,
          manifestJson,
          manifest.manifest_digest,
          manifest.scope_snapshot_ref.id,
          manifest.scope_snapshot_ref.revision,
          manifest.client_fence_ref ?? null,
          manifest.expires_at,
          created.iso,
        ).run();
        if (!mutationChangedExactlyOne(result)) {
          fail(
            "FEDERATION_D1_SETTLEMENT_UNCERTAIN",
            "federation manifest insert did not mutate exactly one row",
            true,
          );
        }
      } catch (cause) {
        const raced = await readManifest(database, manifest.manifest_ref);
        if (raced !== null) {
          assertSameManifest(raced, manifest);
          return { disposition: "EXISTING", manifest: raced };
        }
        if (cause instanceof FederationD1AuthorityError) throw cause;
        fail(
          "FEDERATION_D1_SETTLEMENT_UNCERTAIN",
          "federation manifest insertion failed without authoritative readback",
          true,
          cause,
        );
      }
      const readback = await readManifest(database, manifest.manifest_ref);
      if (readback === null) {
        fail(
          "FEDERATION_D1_SETTLEMENT_UNCERTAIN",
          "federation manifest insertion readback is missing",
          true,
        );
      }
      assertSameManifest(readback, manifest);
      return { disposition: "CREATED", manifest: readback };
    },
  };
}

export function createD1FederationJobAuthority(
  database: D1Database,
  dependencies: D1FederationAuthorityDependencies = {},
): D1FederationJobAuthority {
  const clock = dependencies.now ?? Date.now;
  return {
    async reserve(rawInput) {
      const binding = normalizeBinding(rawInput.binding);
      const request = normalizeRequest(rawInput.request);
      const requestDigest = sha256(rawInput.request_digest, "federation request digest");
      if (await canonicalDigest(request) !== requestDigest) {
        fail("FEDERATION_D1_INPUT_INVALID", "federation request digest mismatch");
      }
      if (
        request.requester_principal_ref !== binding.requester_principal_ref ||
        request.bridge_generation !== binding.bridge_generation ||
        request.client_fence_ref !== binding.client_fence_ref
      ) {
        fail("FEDERATION_D1_BINDING_MISMATCH", "federation request does not match its binding");
      }
      const input: FederationSubmissionInput = { binding, request, request_digest: requestDigest };
      const manifest = await readManifest(database, binding.allowed_reference_manifest_ref);
      if (manifest === null) {
        fail("FEDERATION_D1_BINDING_MISMATCH", "federation manifest authority is missing");
      }
      assertManifestAuthorizesBinding(manifest, binding);
      const existing = await readJob(database, request.exchange_id, request.idempotency_key);
      if (existing !== null) {
        return submissionMatches(existing, input)
          ? {
              outcome: "REPLAY",
              request_digest: requestDigest,
              record: existing.record,
            }
          : {
              outcome: "CONFLICT",
              existing_request_digest: existing.record.request_digest,
            };
      }
      const jobId = await stableJobId(binding, request, requestDigest);
      const status = initialStatus(request, jobId);
      const createdAt = clockTimestamp(clock).iso;
      const requestJson = canonicalJson(request);
      const statusJson = canonicalJson(status);
      try {
        const result = await database.prepare(
          "INSERT INTO federation_job(" +
          "job_id, exchange_id, idempotency_key, request_digest, request_json, " +
          "requester_principal_ref, requester_credential_generation, server_principal_ref, " +
          "server_credential_generation, bridge_generation, client_fence_ref, " +
          "allowed_manifest_id, allowed_manifest_revision, origin_trace_id, attempt, " +
          "transport_state, status_json, observed_completion_disposition, result_json, " +
          "cancellation_reason, cancelled_at, created_at, updated_at) VALUES (" +
          "?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,1,'ACCEPTED'," +
          "?15,NULL,NULL,NULL,NULL,?16,?16)",
        ).bind(
          jobId,
          request.exchange_id,
          request.idempotency_key,
          requestDigest,
          requestJson,
          binding.requester_principal_ref,
          binding.requester_credential_generation,
          binding.server_principal_ref,
          binding.server_credential_generation,
          binding.bridge_generation,
          binding.client_fence_ref,
          binding.allowed_reference_manifest_ref.id,
          binding.allowed_reference_manifest_ref.revision,
          binding.trace_id,
          statusJson,
          createdAt,
        ).run();
        if (!mutationChangedExactlyOne(result)) {
          fail(
            "FEDERATION_D1_SETTLEMENT_UNCERTAIN",
            "federation job reservation did not mutate exactly one row",
            true,
          );
        }
      } catch (cause) {
        const raced = await readJob(database, request.exchange_id, request.idempotency_key);
        if (raced !== null) {
          return submissionMatches(raced, input)
            ? { outcome: "REPLAY", request_digest: requestDigest, record: raced.record }
            : {
                outcome: "CONFLICT",
                existing_request_digest: raced.record.request_digest,
              };
        }
        if (cause instanceof FederationD1AuthorityError) throw cause;
        fail(
          "FEDERATION_D1_SETTLEMENT_UNCERTAIN",
          "federation job reservation failed without authoritative readback",
          true,
          cause,
        );
      }
      const readback = await readJob(database, request.exchange_id, request.idempotency_key);
      if (readback === null || !submissionMatches(readback, input)) {
        fail(
          "FEDERATION_D1_SETTLEMENT_UNCERTAIN",
          "federation job reservation readback mismatch",
          true,
        );
      }
      return { outcome: "CREATED", request_digest: requestDigest, record: readback.record };
    },

    async read(rawBinding, rawExchangeId, rawIdempotencyKey) {
      const binding = normalizeBinding(rawBinding);
      const exchangeId = identifier(rawExchangeId, "exchange_id");
      const idempotencyKey = identifier(rawIdempotencyKey, "idempotency_key");
      const existing = await readJob(database, exchangeId, idempotencyKey);
      if (existing === null) return null;
      assertBindingIdentity(existing.binding, binding);
      return existing.record;
    },

    async cancel(rawBinding, rawExchangeId, rawIdempotencyKey, rawReason) {
      const binding = normalizeBinding(rawBinding);
      const exchangeId = identifier(rawExchangeId, "exchange_id");
      const idempotencyKey = identifier(rawIdempotencyKey, "idempotency_key");
      const reason = validateCancellationReason(rawReason);
      const existing = await readJob(database, exchangeId, idempotencyKey);
      if (existing === null) return null;
      assertBindingIdentity(existing.binding, binding);
      if (existing.record.status.transport_state === "CANCELLED") {
        if (existing.cancellation_reason !== reason) {
          fail(
            "FEDERATION_D1_STATE_CONFLICT",
            "cancelled federation job is bound to another cancellation reason",
          );
        }
        return existing.record;
      }
      if (!ACTIVE_TRANSPORT_STATES.has(existing.record.status.transport_state)) {
        fail(
          "FEDERATION_D1_STATE_CONFLICT",
          "terminal federation job cannot be cancelled",
        );
      }
      const cancelledAt = clockTimestamp(clock).iso;
      const receiptRef = await cancellationReceiptRef(existing.record.status.job_id, reason);
      const cancelledStatus = FederationJobStatusSchema.parse({
        ...existing.record.status,
        transport_state: "CANCELLED",
        completion_disposition: "CANCELLED",
        cancellation_receipt_ref: receiptRef,
        terminal_receipt_ref: receiptRef,
      });
      let mutationError: unknown;
      try {
        const result = await database.prepare(
          "UPDATE federation_job SET transport_state = 'CANCELLED', status_json = ?1, " +
          "observed_completion_disposition = 'CANCELLED', cancellation_reason = ?2, " +
          "cancelled_at = ?3, updated_at = ?3 WHERE job_id = ?4 AND transport_state = ?5 " +
          "AND status_json = ?6 AND updated_at = ?7",
        ).bind(
          canonicalJson(cancelledStatus),
          reason,
          cancelledAt,
          existing.record.status.job_id,
          existing.record.status.transport_state,
          canonicalJson(existing.record.status),
          existing.updated_at,
        ).run();
        if (!mutationChangedExactlyOne(result)) {
          mutationError = new Error("federation cancellation compare-and-swap changed no row");
        }
      } catch (cause) {
        mutationError = cause;
      }
      const readback = await readJob(database, exchangeId, idempotencyKey);
      if (
        readback !== null &&
        readback.record.status.transport_state === "CANCELLED" &&
        readback.cancellation_reason === reason &&
        canonicalJson(readback.record.status) === canonicalJson(cancelledStatus)
      ) {
        assertBindingIdentity(readback.binding, binding);
        return readback.record;
      }
      if (mutationError instanceof FederationD1AuthorityError) throw mutationError;
      fail(
        "FEDERATION_D1_SETTLEMENT_UNCERTAIN",
        "federation cancellation did not produce exact durable readback",
        true,
        mutationError,
      );
    },
  };
}
