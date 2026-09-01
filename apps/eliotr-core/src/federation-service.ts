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
import type {
  FederationApiV1,
  FederationAuthenticatedContext,
  FederationBundleRange,
  FederationChangePage,
} from "@eliotr/interfaces";

const MAX_REQUEST_BYTES = 256 * 1024;
const MAX_QUESTION_BYTES = 32 * 1024;
const MAX_EXPECTED_RESULT_BYTES = 16 * 1024;
const MAX_REASON_BYTES = 4 * 1024;
const MAX_CURSOR_BYTES = 2 * 1024;
const MAX_SOURCE_CLASSES = 64;
const MAX_INPUT_HANDLES = 256;
const MAX_SCOPE_DEPTH = 32;
const MAX_SELECTED_SOURCES = 1_000;
const MAX_CHANGE_SCOPES = 64;
const MAX_CHANGE_REFS = 1_000;
const MAX_RANGE_BYTES = 8 * 1024 * 1024;

const encoder = new TextEncoder();

export class FederationServiceError extends Error {
  public readonly code: string;
  public readonly retryable: boolean;

  public constructor(code: string, message: string, retryable = false) {
    super(message);
    this.name = "FederationServiceError";
    this.code = code;
    this.retryable = retryable;
  }
}

export interface FederationLocalIdentity {
  readonly principal_ref: string;
  readonly credential_generation: string;
  readonly bridge_generation: string;
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
  reserve(submission: FederationSubmission): Promise<FederationSubmissionReservation>;
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

export interface FederationReferenceManifestAuthority {
  get(ref: VersionedRef): Promise<AllowedReferenceManifest | null>;
}

export interface FederationBundleAuthority {
  readAuthorizedManifest(
    binding: FederationAuthorityBinding,
    bundleRef: VersionedRef,
  ): Promise<FederationEvidenceBundle | null>;
  readAuthorizedBytes(
    binding: FederationAuthorityBinding,
    bundleRef: VersionedRef,
    range?: FederationBundleRange,
  ): Promise<ReadableStream<Uint8Array> | null>;
}

export interface FederationChangeAuthority {
  readAuthorized(
    binding: FederationAuthorityBinding,
    afterCursor: string,
    allowedScopeRefs: readonly VersionedRef[],
  ): Promise<FederationChangePage>;
}

export interface FederationServiceDependencies {
  readonly identity: FederationLocalIdentity;
  readonly jobs: FederationJobAuthority;
  readonly manifests: FederationReferenceManifestAuthority;
  readonly bundles: FederationBundleAuthority;
  readonly changes: FederationChangeAuthority;
  readonly now?: () => number;
}

function fail(code: string, message: string, retryable = false): never {
  throw new FederationServiceError(code, message, retryable);
}

function utf8Length(value: string): number {
  return encoder.encode(value).byteLength;
}

function identifier(value: unknown, label: string): string {
  const parsed = IdentifierSchema.safeParse(value);
  if (!parsed.success) fail("FEDERATION_IDENTIFIER_INVALID", `${label} is invalid`);
  return parsed.data;
}

function versionedRef(value: unknown, label: string): VersionedRef {
  const parsed = VersionedRefSchema.safeParse(value);
  if (!parsed.success) fail("FEDERATION_REFERENCE_INVALID", `${label} is invalid`);
  return parsed.data;
}

function refKey(ref: VersionedRef): string {
  return `${ref.id}@${ref.revision}`;
}

function assertUnique(values: readonly string[], code: string, message: string): void {
  if (new Set(values).size !== values.length) fail(code, message);
}

function canonicalJson(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) fail("FEDERATION_REQUEST_INVALID", "request contains an unsupported number");
    return String(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value !== "object") fail("FEDERATION_REQUEST_INVALID", "request contains an unsupported value");
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function scopeDepth(scope: FederationRequest["scope_expression"]): number {
  if (scope.kind !== "UNION" && scope.kind !== "INTERSECT" && scope.kind !== "EXCEPT") return 1;
  return 1 + Math.max(scopeDepth(scope.left), scopeDepth(scope.right));
}

function selectedSourceCount(scope: FederationRequest["scope_expression"]): number {
  if (scope.kind === "SELECTED_SOURCES") return scope.source_ids.length;
  if (scope.kind !== "UNION" && scope.kind !== "INTERSECT" && scope.kind !== "EXCEPT") return 0;
  return selectedSourceCount(scope.left) + selectedSourceCount(scope.right);
}

function parseRequest(value: unknown, now: number): FederationRequest {
  const parsed = FederationRequestSchema.safeParse(value);
  if (!parsed.success) fail("FEDERATION_REQUEST_INVALID", "federation request failed strict schema validation");
  const request = parsed.data;
  const canonical = canonicalJson(request);
  if (utf8Length(canonical) > MAX_REQUEST_BYTES) {
    fail("FEDERATION_REQUEST_TOO_LARGE", `federation request exceeds ${MAX_REQUEST_BYTES} UTF-8 bytes`);
  }
  if (utf8Length(request.question) > MAX_QUESTION_BYTES) {
    fail("FEDERATION_QUESTION_TOO_LARGE", `question exceeds ${MAX_QUESTION_BYTES} UTF-8 bytes`);
  }
  if (utf8Length(request.expected_decision_or_artifact) > MAX_EXPECTED_RESULT_BYTES) {
    fail("FEDERATION_RESULT_CONTRACT_TOO_LARGE", "expected result contract is too large");
  }
  if (request.source_classes.length > MAX_SOURCE_CLASSES) {
    fail("FEDERATION_SOURCE_CLASS_LIMIT", `source_classes exceeds ${MAX_SOURCE_CLASSES} entries`);
  }
  assertUnique(request.source_classes, "FEDERATION_SOURCE_CLASS_DUPLICATE", "source_classes contains duplicates");
  if (request.allowed_input_handle_refs.length > MAX_INPUT_HANDLES) {
    fail("FEDERATION_REFERENCE_LIMIT", `allowed_input_handle_refs exceeds ${MAX_INPUT_HANDLES} entries`);
  }
  assertUnique(
    request.allowed_input_handle_refs.map(refKey),
    "FEDERATION_REFERENCE_DUPLICATE",
    "allowed_input_handle_refs contains duplicates",
  );
  if (scopeDepth(request.scope_expression) > MAX_SCOPE_DEPTH) {
    fail("FEDERATION_SCOPE_TOO_DEEP", `scope expression exceeds depth ${MAX_SCOPE_DEPTH}`);
  }
  if (selectedSourceCount(request.scope_expression) > MAX_SELECTED_SOURCES) {
    fail("FEDERATION_SCOPE_TOO_LARGE", `scope selects more than ${MAX_SELECTED_SOURCES} source entries`);
  }
  const deadline = Date.parse(request.deadline);
  if (!Number.isFinite(deadline) || deadline <= now) {
    fail("FEDERATION_DEADLINE_EXPIRED", "federation request deadline is not in the future");
  }
  return request;
}

function validateIdentity(identity: FederationLocalIdentity): FederationLocalIdentity {
  return {
    principal_ref: identifier(identity.principal_ref, "server principal_ref"),
    credential_generation: identifier(identity.credential_generation, "server credential_generation"),
    bridge_generation: identifier(identity.bridge_generation, "server bridge_generation"),
  };
}

function validateContext(
  context: FederationAuthenticatedContext,
  identity: FederationLocalIdentity,
): FederationAuthorityBinding {
  if (context.client_class !== "federation_client") {
    fail("FEDERATION_AUTH_REQUIRED", "federation endpoint requires a federation client identity");
  }
  const requesterPrincipal = identifier(context.principal_ref, "requester principal_ref");
  const requesterGeneration = identifier(context.credential_generation, "requester credential_generation");
  const clientFence = identifier(context.client_fence_ref, "client_fence_ref");
  const serverPrincipal = identifier(context.server_principal_ref, "target server_principal_ref");
  const serverGeneration = identifier(context.server_credential_generation, "target server_credential_generation");
  const traceId = identifier(context.trace_id, "trace_id");
  if (serverPrincipal !== identity.principal_ref || serverGeneration !== identity.credential_generation) {
    fail("FEDERATION_SERVER_IDENTITY_MISMATCH", "federation call targets another server identity or generation");
  }
  return {
    requester_principal_ref: requesterPrincipal,
    requester_credential_generation: requesterGeneration,
    server_principal_ref: identity.principal_ref,
    server_credential_generation: identity.credential_generation,
    bridge_generation: identity.bridge_generation,
    client_fence_ref: clientFence,
    allowed_reference_manifest_ref: versionedRef(
      context.allowed_reference_manifest_ref,
      "allowed_reference_manifest_ref",
    ),
    trace_id: traceId,
  };
}

function parseManifest(value: unknown): AllowedReferenceManifest {
  const parsed = AllowedReferenceManifestSchema.safeParse(value);
  if (!parsed.success) fail("FEDERATION_MANIFEST_INVALID", "AllowedReferenceManifest failed strict validation");
  return parsed.data;
}

async function loadManifest(
  dependencies: FederationServiceDependencies,
  binding: FederationAuthorityBinding,
  operation: string,
  now: number,
): Promise<AllowedReferenceManifest> {
  const raw = await dependencies.manifests.get(binding.allowed_reference_manifest_ref);
  if (raw === null) fail("FEDERATION_MANIFEST_NOT_FOUND", "AllowedReferenceManifest was not found");
  const manifest = parseManifest(raw);
  if (refKey(manifest.manifest_ref) !== refKey(binding.allowed_reference_manifest_ref)) {
    fail("FEDERATION_MANIFEST_MISMATCH", "manifest authority returned another manifest revision");
  }
  if (manifest.client_fence_ref !== binding.client_fence_ref) {
    fail("FEDERATION_CLIENT_FENCE_MISMATCH", "AllowedReferenceManifest is not bound to this client fence");
  }
  if (Date.parse(manifest.expires_at) <= now) {
    fail("FEDERATION_MANIFEST_EXPIRED", "AllowedReferenceManifest has expired");
  }
  if (!manifest.allowed_use.includes(operation)) {
    fail("FEDERATION_OPERATION_DENIED", `AllowedReferenceManifest does not permit ${operation}`);
  }
  if (
    manifest.provider_and_policy_generations[binding.requester_principal_ref] !==
      binding.requester_credential_generation ||
    manifest.provider_and_policy_generations[binding.server_principal_ref] !==
      binding.server_credential_generation
  ) {
    fail("FEDERATION_GENERATION_MISMATCH", "AllowedReferenceManifest is stale for a federation identity");
  }
  return manifest;
}

function assertAllowedHandleRefs(
  manifest: AllowedReferenceManifest,
  refs: readonly VersionedRef[],
): void {
  const allowed = new Set(manifest.allowed_evidence_handle_refs.map(refKey));
  for (const ref of refs) {
    if (!allowed.has(refKey(ref))) {
      fail("FEDERATION_REFERENCE_DENIED", "reference is outside AllowedReferenceManifest");
    }
  }
}

function parseStatus(value: unknown): FederationJobStatus {
  const parsed = FederationJobStatusSchema.safeParse(value);
  if (!parsed.success) fail("FEDERATION_AUTHORITY_INVALID", "job authority returned an invalid status");
  return parsed.data;
}

function parseBundle(value: unknown): FederationEvidenceBundle {
  const parsed = FederationEvidenceBundleSchema.safeParse(value);
  if (!parsed.success) fail("FEDERATION_AUTHORITY_INVALID", "bundle authority returned an invalid evidence bundle");
  return parsed.data;
}

function normalizeRecord(
  record: FederationJobRecord,
  exchangeId: string,
  idempotencyKey: string,
): FederationJobRecord {
  const requestDigest = Sha256Schema.safeParse(record.request_digest);
  if (!requestDigest.success) fail("FEDERATION_AUTHORITY_INVALID", "job authority returned an invalid request digest");
  const status = parseStatus(record.status);
  if (status.exchange_id !== exchangeId || status.idempotency_key !== idempotencyKey) {
    fail("FEDERATION_AUTHORITY_MISMATCH", "job authority returned another idempotency identity");
  }
  const observed = record.observed_completion_disposition === null
    ? null
    : CompletionDispositionSchema.safeParse(record.observed_completion_disposition);
  if (observed !== null && !observed.success) {
    fail("FEDERATION_AUTHORITY_INVALID", "job authority returned an invalid observed disposition");
  }
  const observedDisposition = observed === null ? null : observed.data;
  const active = status.transport_state === "ACCEPTED" || status.transport_state === "RUNNING" ||
    status.transport_state === "PARTIAL" || status.transport_state === "BLOCKED";
  if (active && (observedDisposition !== null || status.completion_disposition !== null || record.result !== null)) {
    fail("FEDERATION_AUTHORITY_INVALID", "non-terminal transport state exposed a terminal research outcome");
  }
  if (status.transport_state === "COMPLETED" && observedDisposition === null) {
    fail("FEDERATION_AUTHORITY_INVALID", "completed transport lacks an observed research disposition");
  }
  if (status.transport_state === "CANCELLED" && observedDisposition !== null && observedDisposition !== "CANCELLED") {
    fail("FEDERATION_AUTHORITY_INVALID", "cancelled transport has a non-cancelled research disposition");
  }
  const effectiveDisposition = status.transport_state === "CANCELLED"
    ? "CANCELLED"
    : observedDisposition ?? status.completion_disposition;
  const normalizedStatus: FederationJobStatus = {
    ...status,
    completion_disposition: effectiveDisposition,
  };
  if (record.result === null) {
    return { ...record, request_digest: requestDigest.data, status: normalizedStatus };
  }
  if (status.transport_state !== "COMPLETED" || effectiveDisposition === null) {
    fail("FEDERATION_AUTHORITY_INVALID", "terminal evidence bundle is exposed before completed transport");
  }
  const bundle = parseBundle(record.result);
  if (
    bundle.exchange_id !== exchangeId ||
    bundle.job_id !== status.job_id ||
    bundle.request_digest !== requestDigest.data
  ) {
    fail("FEDERATION_AUTHORITY_MISMATCH", "evidence bundle is not bound to the selected job");
  }
  const normalizedBundle = FederationEvidenceBundleSchema.safeParse({
    ...bundle,
    completion_disposition: effectiveDisposition,
    coverage_receipt: {
      ...bundle.coverage_receipt,
      terminal_disposition: effectiveDisposition,
    },
  });
  if (!normalizedBundle.success) {
    fail("FEDERATION_AUTHORITY_INVALID", "observed disposition is incompatible with the evidence bundle");
  }
  return {
    ...record,
    request_digest: requestDigest.data,
    status: normalizedStatus,
    observed_completion_disposition: effectiveDisposition,
    result: normalizedBundle.data,
  };
}

function validateReason(reason: unknown): string {
  if (
    typeof reason !== "string" ||
    reason.length === 0 ||
    reason !== reason.trim() ||
    utf8Length(reason) > MAX_REASON_BYTES ||
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(reason)
  ) {
    fail("FEDERATION_CANCEL_REASON_INVALID", "cancellation reason is invalid");
  }
  return reason;
}

function validateRange(range: FederationBundleRange | undefined): FederationBundleRange | undefined {
  if (range === undefined) return undefined;
  if (
    !Number.isSafeInteger(range.start) ||
    !Number.isSafeInteger(range.endExclusive) ||
    range.start < 0 ||
    range.endExclusive <= range.start ||
    range.endExclusive - range.start > MAX_RANGE_BYTES
  ) {
    fail("FEDERATION_RANGE_INVALID", `bundle range must be positive and at most ${MAX_RANGE_BYTES} bytes`);
  }
  return { start: range.start, endExclusive: range.endExclusive };
}

function validateCursor(value: unknown): string {
  if (
    typeof value !== "string" ||
    utf8Length(value) > MAX_CURSOR_BYTES ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    fail("FEDERATION_CURSOR_INVALID", "change cursor is invalid");
  }
  return value;
}

function validateChangePage(value: FederationChangePage): FederationChangePage {
  const nextCursor = validateCursor(value.next_cursor);
  if (!Array.isArray(value.changed_refs) || value.changed_refs.length > MAX_CHANGE_REFS) {
    fail("FEDERATION_AUTHORITY_INVALID", "change authority returned too many references");
  }
  const changedRefs = value.changed_refs.map((ref) => versionedRef(ref, "changed reference"));
  assertUnique(changedRefs.map(refKey), "FEDERATION_AUTHORITY_INVALID", "change authority returned duplicate references");
  return { next_cursor: nextCursor, changed_refs: changedRefs };
}

function requestBindingMatches(request: FederationRequest, binding: FederationAuthorityBinding): boolean {
  return request.requester_principal_ref === binding.requester_principal_ref &&
    request.client_fence_ref === binding.client_fence_ref &&
    request.bridge_generation === binding.bridge_generation;
}

// IMPLEMENTED_NOT_LIVE: ER-22 federation boundary requires ER-24 composition and retained boundary receipts.
export function createFederationService(dependencies: FederationServiceDependencies): FederationApiV1 {
  const identity = validateIdentity(dependencies.identity);
  const now = dependencies.now ?? Date.now;

  async function authorize(
    context: FederationAuthenticatedContext,
    operation: string,
  ): Promise<{ binding: FederationAuthorityBinding; manifest: AllowedReferenceManifest; now: number }> {
    const observedNow = now();
    if (!Number.isSafeInteger(observedNow) || observedNow < 0) {
      fail("FEDERATION_CLOCK_INVALID", "federation clock returned an invalid timestamp");
    }
    const binding = validateContext(context, identity);
    const manifest = await loadManifest(dependencies, binding, operation, observedNow);
    return { binding, manifest, now: observedNow };
  }

  return {
    async submit(context, rawRequest) {
      const authorized = await authorize(context, "federation.submit");
      const request = parseRequest(rawRequest, authorized.now);
      if (!requestBindingMatches(request, authorized.binding)) {
        fail("FEDERATION_REQUEST_BINDING_MISMATCH", "request identity, bridge generation, or client fence does not match authentication");
      }
      assertAllowedHandleRefs(authorized.manifest, request.allowed_input_handle_refs);
      const requestDigest = await sha256Hex(canonicalJson(request));
      const reservation = await dependencies.jobs.reserve({
        binding: authorized.binding,
        request,
        request_digest: requestDigest,
      });
      if (reservation.outcome === "CONFLICT") {
        fail("FEDERATION_IDEMPOTENCY_CONFLICT", "idempotency identity is already bound to another request");
      }
      if (reservation.request_digest !== requestDigest) {
        fail("FEDERATION_AUTHORITY_MISMATCH", "job authority replayed another request digest");
      }
      const normalized = normalizeRecord(reservation.record, request.exchange_id, request.idempotency_key);
      if (normalized.request_digest !== requestDigest) {
        fail("FEDERATION_AUTHORITY_MISMATCH", "job record is bound to another request digest");
      }
      return normalized.status;
    },

    async status(context, rawExchangeId, rawIdempotencyKey) {
      const { binding } = await authorize(context, "federation.status");
      const exchangeId = identifier(rawExchangeId, "exchange_id");
      const idempotencyKey = identifier(rawIdempotencyKey, "idempotency_key");
      const record = await dependencies.jobs.read(binding, exchangeId, idempotencyKey);
      return record === null ? null : normalizeRecord(record, exchangeId, idempotencyKey).status;
    },

    async result(context, rawExchangeId, rawIdempotencyKey) {
      const { binding, manifest } = await authorize(context, "federation.result");
      const exchangeId = identifier(rawExchangeId, "exchange_id");
      const idempotencyKey = identifier(rawIdempotencyKey, "idempotency_key");
      const record = await dependencies.jobs.read(binding, exchangeId, idempotencyKey);
      if (record === null) return null;
      const result = normalizeRecord(record, exchangeId, idempotencyKey).result;
      if (result === null) return null;
      assertAllowedHandleRefs(manifest, result.exact_citation_handle_refs);
      return result;
    },

    async cancel(context, rawExchangeId, rawIdempotencyKey, rawReason) {
      const { binding } = await authorize(context, "federation.cancel");
      const exchangeId = identifier(rawExchangeId, "exchange_id");
      const idempotencyKey = identifier(rawIdempotencyKey, "idempotency_key");
      const record = await dependencies.jobs.cancel(
        binding,
        exchangeId,
        idempotencyKey,
        validateReason(rawReason),
      );
      if (record === null) fail("FEDERATION_JOB_NOT_FOUND", "federation job was not found");
      return normalizeRecord(record, exchangeId, idempotencyKey).status;
    },

    async readBundle(context, rawBundleRef, rawRange) {
      const { binding, manifest } = await authorize(context, "federation.bundle.read");
      const bundleRef = versionedRef(rawBundleRef, "bundle_ref");
      const bundle = await dependencies.bundles.readAuthorizedManifest(binding, bundleRef);
      if (bundle === null) fail("FEDERATION_BUNDLE_NOT_FOUND", "federation bundle was not found");
      const parsedBundle = parseBundle(bundle);
      assertAllowedHandleRefs(manifest, parsedBundle.exact_citation_handle_refs);
      const range = validateRange(rawRange);
      const stream = range === undefined
        ? await dependencies.bundles.readAuthorizedBytes(binding, bundleRef)
        : await dependencies.bundles.readAuthorizedBytes(binding, bundleRef, range);
      if (stream === null) fail("FEDERATION_BUNDLE_NOT_FOUND", "federation bundle bytes were not found");
      return stream;
    },

    async readBundleManifest(context, rawBundleRef) {
      const { binding, manifest } = await authorize(context, "federation.bundle.manifest");
      const bundleRef = versionedRef(rawBundleRef, "bundle_ref");
      const bundle = await dependencies.bundles.readAuthorizedManifest(binding, bundleRef);
      if (bundle === null) fail("FEDERATION_BUNDLE_NOT_FOUND", "federation bundle was not found");
      const parsedBundle = parseBundle(bundle);
      assertAllowedHandleRefs(manifest, parsedBundle.exact_citation_handle_refs);
      return parsedBundle;
    },

    async changes(context, rawAfterCursor, rawAllowedScopeRefs) {
      const { binding, manifest } = await authorize(context, "federation.changes");
      const afterCursor = validateCursor(rawAfterCursor);
      if (!Array.isArray(rawAllowedScopeRefs) || rawAllowedScopeRefs.length === 0 || rawAllowedScopeRefs.length > MAX_CHANGE_SCOPES) {
        fail("FEDERATION_SCOPE_REFERENCE_INVALID", `changes requires 1-${MAX_CHANGE_SCOPES} scope references`);
      }
      const allowedScopeRefs = rawAllowedScopeRefs.map((ref) => versionedRef(ref, "allowed scope reference"));
      assertUnique(allowedScopeRefs.map(refKey), "FEDERATION_SCOPE_REFERENCE_INVALID", "allowed scope references contain duplicates");
      const admittedScope = refKey(manifest.scope_snapshot_ref);
      if (allowedScopeRefs.some((ref) => refKey(ref) !== admittedScope)) {
        fail("FEDERATION_REFERENCE_DENIED", "scope reference is outside AllowedReferenceManifest");
      }
      return validateChangePage(await dependencies.changes.readAuthorized(binding, afterCursor, allowedScopeRefs));
    },
  };
}
