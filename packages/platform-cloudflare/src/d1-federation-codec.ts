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
import type {
  DecodedFederationJob,
  FederationAuthorityBindingInput,
  FederationJobRow,
  FederationManifestRow,
  FederationSubmissionInput,
} from "./d1-federation-types.js";
import {
  FederationD1AuthorityError,
  federationD1Fail,
} from "./d1-federation-types.js";
import { canonicalJson } from "./ingest-validation.js";

export const FEDERATION_MANIFEST_SELECT =
  "SELECT manifest_id, revision, manifest_json, manifest_digest, scope_snapshot_id, " +
  "scope_snapshot_revision, client_fence_ref, expires_at, created_at " +
  "FROM federation_reference_manifest ";
export const FEDERATION_JOB_SELECT =
  "SELECT job_id, exchange_id, idempotency_key, request_digest, request_json, " +
  "requester_principal_ref, requester_credential_generation, server_principal_ref, " +
  "server_credential_generation, bridge_generation, client_fence_ref, " +
  "allowed_manifest_id, allowed_manifest_revision, origin_trace_id, attempt, " +
  "transport_state, status_json, observed_completion_disposition, result_json, " +
  "cancellation_reason, cancelled_at, created_at, updated_at FROM federation_job ";
export const ACTIVE_FEDERATION_TRANSPORT_STATES = new Set([
  "ACCEPTED",
  "RUNNING",
  "PARTIAL",
  "BLOCKED",
]);
const MAX_CANCEL_REASON_BYTES = 4 * 1024;
const encoder = new TextEncoder();

export function federationIdentifier(value: unknown, label: string): string {
  const parsed = IdentifierSchema.safeParse(value);
  if (!parsed.success) federationD1Fail("FEDERATION_D1_INPUT_INVALID", `${label} is invalid`);
  return parsed.data;
}

function positiveInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    federationD1Fail(
      "FEDERATION_D1_INPUT_INVALID",
      `${label} is not a positive safe integer`,
    );
  }
  return value;
}

function sha256(value: unknown, label: string): string {
  const parsed = Sha256Schema.safeParse(value);
  if (!parsed.success) {
    federationD1Fail("FEDERATION_D1_INPUT_INVALID", `${label} is not a SHA-256 digest`);
  }
  return parsed.data;
}

export function federationVersionedRef(value: unknown, label: string): VersionedRef {
  const parsed = VersionedRefSchema.safeParse(value);
  if (!parsed.success) federationD1Fail("FEDERATION_D1_INPUT_INVALID", `${label} is invalid`);
  return parsed.data;
}

export function federationCanonicalTimestamp(value: unknown, label: string): string {
  if (typeof value !== "string") {
    federationD1Fail("FEDERATION_D1_INPUT_INVALID", `${label} is not a canonical timestamp`);
  }
  const epoch = Date.parse(value);
  if (!Number.isSafeInteger(epoch) || new Date(epoch).toISOString() !== value) {
    federationD1Fail(
      "FEDERATION_D1_INPUT_INVALID",
      `${label} is not canonical ISO-8601 UTC`,
    );
  }
  return value;
}

export function federationClockTimestamp(
  clock: () => number,
): { readonly epoch: number; readonly iso: string } {
  const epoch = clock();
  if (!Number.isSafeInteger(epoch) || epoch < 0) {
    federationD1Fail("FEDERATION_D1_INPUT_INVALID", "federation authority clock is invalid");
  }
  return { epoch, iso: new Date(epoch).toISOString() };
}

function parseCanonicalJson(value: unknown, label: string): unknown {
  if (typeof value !== "string") {
    federationD1Fail("FEDERATION_D1_INPUT_INVALID", `${label} is not JSON text`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch (cause) {
    federationD1Fail("FEDERATION_D1_INPUT_INVALID", `${label} is malformed JSON`, false, cause);
  }
  try {
    if (canonicalJson(parsed) !== value) {
      federationD1Fail("FEDERATION_D1_INPUT_INVALID", `${label} is not canonical JSON`);
    }
  } catch (cause) {
    if (cause instanceof FederationD1AuthorityError) throw cause;
    federationD1Fail(
      "FEDERATION_D1_INPUT_INVALID",
      `${label} cannot be canonicalized`,
      false,
      cause,
    );
  }
  return parsed;
}

export function normalizeFederationBinding(
  raw: FederationAuthorityBindingInput,
): FederationAuthorityBindingInput {
  return {
    requester_principal_ref: federationIdentifier(
      raw.requester_principal_ref,
      "requester principal_ref",
    ),
    requester_credential_generation: federationIdentifier(
      raw.requester_credential_generation,
      "requester credential_generation",
    ),
    server_principal_ref: federationIdentifier(raw.server_principal_ref, "server principal_ref"),
    server_credential_generation: federationIdentifier(
      raw.server_credential_generation,
      "server credential_generation",
    ),
    bridge_generation: federationIdentifier(raw.bridge_generation, "bridge generation"),
    client_fence_ref: federationIdentifier(raw.client_fence_ref, "client fence"),
    allowed_reference_manifest_ref: federationVersionedRef(
      raw.allowed_reference_manifest_ref,
      "AllowedReferenceManifest ref",
    ),
    trace_id: federationIdentifier(raw.trace_id, "trace_id"),
  };
}

export function sameFederationVersionedRef(
  left: VersionedRef,
  right: VersionedRef,
): boolean {
  return left.id === right.id && left.revision === right.revision;
}

export function sameFederationBindingIdentity(
  left: FederationAuthorityBindingInput,
  right: FederationAuthorityBindingInput,
): boolean {
  return left.requester_principal_ref === right.requester_principal_ref &&
    left.requester_credential_generation === right.requester_credential_generation &&
    left.server_principal_ref === right.server_principal_ref &&
    left.server_credential_generation === right.server_credential_generation &&
    left.bridge_generation === right.bridge_generation &&
    left.client_fence_ref === right.client_fence_ref &&
    sameFederationVersionedRef(
      left.allowed_reference_manifest_ref,
      right.allowed_reference_manifest_ref,
    );
}

export function assertFederationBindingIdentity(
  stored: FederationAuthorityBindingInput,
  requested: FederationAuthorityBindingInput,
): void {
  if (!sameFederationBindingIdentity(stored, requested)) {
    federationD1Fail(
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

export async function parseFederationManifest(
  value: unknown,
  label: string,
): Promise<AllowedReferenceManifest> {
  const parsed = AllowedReferenceManifestSchema.safeParse(value);
  if (!parsed.success) {
    federationD1Fail(
      "FEDERATION_D1_INPUT_INVALID",
      `${label} failed strict contract validation`,
    );
  }
  if (await digestWithoutManifestDigest(parsed.data) !== parsed.data.manifest_digest) {
    federationD1Fail("FEDERATION_D1_INPUT_INVALID", `${label} digest does not match its content`);
  }
  return parsed.data;
}

async function decodeManifestRow(row: FederationManifestRow): Promise<AllowedReferenceManifest> {
  const manifest = await parseFederationManifest(
    parseCanonicalJson(row.manifest_json, "stored federation manifest"),
    "stored federation manifest",
  );
  const manifestRef = federationVersionedRef({
    id: row.manifest_id,
    revision: row.revision,
  }, "stored federation manifest ref");
  const scopeRef = federationVersionedRef({
    id: row.scope_snapshot_id,
    revision: row.scope_snapshot_revision,
  }, "stored federation scope ref");
  const storedDigest = sha256(row.manifest_digest, "stored federation manifest digest");
  const clientFence = row.client_fence_ref === null
    ? undefined
    : federationIdentifier(row.client_fence_ref, "stored federation client fence");
  const expiresAt = typeof row.expires_at === "string" ? row.expires_at : "";
  if (
    !sameFederationVersionedRef(manifest.manifest_ref, manifestRef) ||
    !sameFederationVersionedRef(manifest.scope_snapshot_ref, scopeRef) ||
    manifest.manifest_digest !== storedDigest ||
    manifest.expires_at !== expiresAt ||
    manifest.client_fence_ref !== clientFence
  ) {
    federationD1Fail(
      "FEDERATION_D1_INPUT_INVALID",
      "stored federation manifest columns diverge from canonical manifest bytes",
    );
  }
  federationCanonicalTimestamp(row.created_at, "stored federation manifest created_at");
  return manifest;
}

export async function readFederationManifest(
  database: D1Database,
  ref: VersionedRef,
): Promise<AllowedReferenceManifest | null> {
  const row = await database.prepare(
    `${FEDERATION_MANIFEST_SELECT}WHERE manifest_id = ?1 AND revision = ?2 LIMIT 1`,
  ).bind(ref.id, ref.revision).first<FederationManifestRow>();
  return row === null ? null : decodeManifestRow(row);
}

export function assertSameFederationManifest(
  existing: AllowedReferenceManifest,
  expected: AllowedReferenceManifest,
): void {
  if (canonicalJson(existing) !== canonicalJson(expected)) {
    federationD1Fail(
      "FEDERATION_D1_MANIFEST_CONFLICT",
      "manifest revision is already bound to different canonical bytes",
    );
  }
}

export function normalizeFederationRequest(raw: FederationRequest): FederationRequest {
  const parsed = FederationRequestSchema.safeParse(raw);
  if (!parsed.success) {
    federationD1Fail(
      "FEDERATION_D1_INPUT_INVALID",
      "federation request failed strict validation",
    );
  }
  return parsed.data;
}

export async function stableFederationJobId(
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

export async function federationCancellationReceiptRef(
  jobId: string,
  reason: string,
): Promise<string> {
  const digest = await canonicalDigest(["federation-cancel", jobId, reason]);
  return `federation-cancel-${digest.slice(0, 48)}`;
}

export function initialFederationStatus(
  request: FederationRequest,
  jobId: string,
): FederationJobStatus {
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

export function validateFederationCancellationReason(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value !== value.trim() ||
    encoder.encode(value).byteLength > MAX_CANCEL_REASON_BYTES ||
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value)
  ) {
    federationD1Fail(
      "FEDERATION_D1_INPUT_INVALID",
      "federation cancellation reason is invalid",
    );
  }
  return value;
}

export async function decodeFederationJobRow(
  row: FederationJobRow,
): Promise<DecodedFederationJob> {
  const requestValue = parseCanonicalJson(row.request_json, "stored federation request");
  const request = normalizeFederationRequest(requestValue as FederationRequest);
  const requestDigest = sha256(row.request_digest, "stored federation request digest");
  if (await canonicalDigest(request) !== requestDigest) {
    federationD1Fail(
      "FEDERATION_D1_INPUT_INVALID",
      "stored federation request digest mismatch",
    );
  }
  const statusValue = parseCanonicalJson(row.status_json, "stored federation status");
  const statusParsed = FederationJobStatusSchema.safeParse(statusValue);
  if (!statusParsed.success) {
    federationD1Fail(
      "FEDERATION_D1_INPUT_INVALID",
      "stored federation status failed strict validation",
    );
  }
  const status = statusParsed.data;
  const binding: FederationAuthorityBindingInput = {
    requester_principal_ref: federationIdentifier(
      row.requester_principal_ref,
      "stored requester principal_ref",
    ),
    requester_credential_generation: federationIdentifier(
      row.requester_credential_generation,
      "stored requester credential generation",
    ),
    server_principal_ref: federationIdentifier(
      row.server_principal_ref,
      "stored server principal_ref",
    ),
    server_credential_generation: federationIdentifier(
      row.server_credential_generation,
      "stored server credential generation",
    ),
    bridge_generation: federationIdentifier(row.bridge_generation, "stored bridge generation"),
    client_fence_ref: federationIdentifier(row.client_fence_ref, "stored client fence"),
    allowed_reference_manifest_ref: federationVersionedRef({
      id: row.allowed_manifest_id,
      revision: row.allowed_manifest_revision,
    }, "stored AllowedReferenceManifest ref"),
    trace_id: federationIdentifier(row.origin_trace_id, "stored origin trace_id"),
  };
  const exchangeId = federationIdentifier(row.exchange_id, "stored exchange_id");
  const idempotencyKey = federationIdentifier(row.idempotency_key, "stored idempotency_key");
  const jobId = federationIdentifier(row.job_id, "stored federation job_id");
  const attempt = positiveInteger(row.attempt, "stored federation attempt");
  const transportState = federationIdentifier(
    row.transport_state,
    "stored federation transport state",
  );
  const expectedJobId = await stableFederationJobId(binding, request, requestDigest);
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
    federationD1Fail(
      "FEDERATION_D1_INPUT_INVALID",
      "stored federation job columns diverge from request/status authority",
    );
  }
  let observed: CompletionDisposition | null = null;
  if (row.observed_completion_disposition !== null) {
    const parsed = CompletionDispositionSchema.safeParse(row.observed_completion_disposition);
    if (!parsed.success) {
      federationD1Fail(
        "FEDERATION_D1_INPUT_INVALID",
        "stored observed disposition is invalid",
      );
    }
    observed = parsed.data;
  }
  let result: FederationEvidenceBundle | null = null;
  if (row.result_json !== null) {
    const parsed = FederationEvidenceBundleSchema.safeParse(
      parseCanonicalJson(row.result_json, "stored federation result"),
    );
    if (!parsed.success) {
      federationD1Fail(
        "FEDERATION_D1_INPUT_INVALID",
        "stored federation result failed strict validation",
      );
    }
    result = parsed.data;
    if (
      result.exchange_id !== exchangeId ||
      result.job_id !== jobId ||
      result.request_digest !== requestDigest
    ) {
      federationD1Fail(
        "FEDERATION_D1_INPUT_INVALID",
        "stored federation result is bound to another job",
      );
    }
  }
  const cancellationReason = row.cancellation_reason === null
    ? null
    : validateFederationCancellationReason(row.cancellation_reason);
  const cancelledAt = row.cancelled_at === null
    ? null
    : federationCanonicalTimestamp(row.cancelled_at, "stored federation cancelled_at");
  const cancellationInvalid = status.transport_state === "CANCELLED"
    ? status.completion_disposition !== "CANCELLED" ||
      observed !== "CANCELLED" ||
      cancellationReason === null ||
      cancelledAt === null ||
      result !== null
    : cancellationReason !== null || cancelledAt !== null;
  if (cancellationInvalid) {
    federationD1Fail(
      "FEDERATION_D1_INPUT_INVALID",
      "stored federation cancellation state is inconsistent",
    );
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
    created_at: federationCanonicalTimestamp(
      row.created_at,
      "stored federation created_at",
    ),
    updated_at: federationCanonicalTimestamp(
      row.updated_at,
      "stored federation updated_at",
    ),
  };
}

export async function readFederationJob(
  database: D1Database,
  exchangeId: string,
  idempotencyKey: string,
): Promise<DecodedFederationJob | null> {
  const row = await database.prepare(
    `${FEDERATION_JOB_SELECT}WHERE exchange_id = ?1 AND idempotency_key = ?2 LIMIT 1`,
  ).bind(exchangeId, idempotencyKey).first<FederationJobRow>();
  return row === null ? null : decodeFederationJobRow(row);
}

export function federationSubmissionMatches(
  existing: DecodedFederationJob,
  input: FederationSubmissionInput,
): boolean {
  return existing.record.request_digest === input.request_digest &&
    canonicalJson(existing.request) === canonicalJson(input.request) &&
    sameFederationBindingIdentity(existing.binding, input.binding);
}

export function assertManifestAuthorizesFederationBinding(
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
    federationD1Fail(
      "FEDERATION_D1_BINDING_MISMATCH",
      "AllowedReferenceManifest does not authorize the exact federation binding",
    );
  }
}

export function federationMutationChangedExactlyOne(result: D1Result<unknown>): boolean {
  return (result.meta?.changes ?? 0) === 1;
}
