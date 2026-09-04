import {
  AllowedReferenceManifestSchema, CompletionDispositionSchema, FederationEvidenceBundleSchema,
  FederationJobStatusSchema, FederationRequestSchema, IdentifierSchema, Sha256Schema,
  VersionedRefSchema, type AllowedReferenceManifest, type CompletionDisposition,
  type FederationEvidenceBundle, type FederationJobStatus, type FederationRequest, type VersionedRef,
} from "@eliotr/contracts";
import { canonicalDigest } from "@eliotr/platform-cloudflare";
import type { FederationAuthorityBinding, FederationJobAuthority, FederationJobRecord,
  FederationReferenceManifestAuthority, FederationSubmission, FederationSubmissionReservation } from "./federation-service.js";
const MANIFEST_SELECT =
  "SELECT manifest_id,revision,manifest_json,manifest_digest,scope_snapshot_id," +
  "scope_snapshot_revision,client_fence_ref,expires_at,created_at " +
  "FROM federation_reference_manifest ";
const JOB_SELECT =
  "SELECT job_id,exchange_id,idempotency_key,request_digest,request_json," +
  "requester_principal_ref,requester_credential_generation,server_principal_ref," +
  "server_credential_generation,bridge_generation,client_fence_ref," +
  "allowed_manifest_id,allowed_manifest_revision,origin_trace_id,attempt," +
  "transport_state,status_json,observed_completion_disposition,result_json," +
  "cancellation_reason,cancelled_at,created_at,updated_at FROM federation_job ";
const ACTIVE = new Set(["ACCEPTED", "RUNNING", "PARTIAL", "BLOCKED"]);
const encoder = new TextEncoder();
export type FederationD1ErrorCode =
  "FEDERATION_D1_INPUT_INVALID" | "FEDERATION_D1_MANIFEST_CONFLICT" |
  "FEDERATION_D1_BINDING_MISMATCH" | "FEDERATION_D1_STATE_CONFLICT" |
  "FEDERATION_D1_SETTLEMENT_UNCERTAIN";
export class FederationD1Error extends Error {
  public constructor(
    public readonly code: FederationD1ErrorCode,
    message: string,
    public readonly retryable = false,
    cause?: unknown,
  ) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "FederationD1Error";
  }
}
export interface FederationManifestStore extends FederationReferenceManifestAuthority {
  put(manifest: AllowedReferenceManifest): Promise<{
    readonly disposition: "CREATED" | "EXISTING";
    readonly manifest: AllowedReferenceManifest;
  }>;
}
interface DecodedJob {
  readonly binding: FederationAuthorityBinding;
  readonly request: FederationRequest;
  readonly record: FederationJobRecord;
  readonly cancellationReason: string | null;
  readonly updatedAt: string;
}
function fail(code: FederationD1ErrorCode, message: string, retryable = false, cause?: unknown): never {
  throw new FederationD1Error(code, message, retryable, cause);
}
function record(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function canonical(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) {
      fail("FEDERATION_D1_INPUT_INVALID", "canonical JSON contains an unsupported number");
    }
    return String(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (!record(value)) {
    fail("FEDERATION_D1_INPUT_INVALID", "canonical JSON contains an unsupported value");
  }
  return `{${Object.keys(value).sort().map(
    (key) => `${JSON.stringify(key)}:${canonical(value[key])}`,
  ).join(",")}}`;
}
function parseJson(value: unknown, label: string): unknown {
  if (typeof value !== "string") {
    fail("FEDERATION_D1_INPUT_INVALID", `${label} is not JSON text`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch (cause) {
    fail("FEDERATION_D1_INPUT_INVALID", `${label} is malformed JSON`, false, cause);
  }
  if (canonical(parsed) !== value) {
    fail("FEDERATION_D1_INPUT_INVALID", `${label} is not canonical JSON`);
  }
  return parsed;
}
function id(value: unknown, label: string): string {
  const parsed = IdentifierSchema.safeParse(value);
  if (!parsed.success) fail("FEDERATION_D1_INPUT_INVALID", `${label} is invalid`);
  return parsed.data;
}
function ref(value: unknown, label: string): VersionedRef {
  const parsed = VersionedRefSchema.safeParse(value);
  if (!parsed.success) fail("FEDERATION_D1_INPUT_INVALID", `${label} is invalid`);
  return parsed.data;
}
function sha(value: unknown, label: string): string {
  const parsed = Sha256Schema.safeParse(value);
  if (!parsed.success) fail("FEDERATION_D1_INPUT_INVALID", `${label} is invalid`);
  return parsed.data;
}
function iso(value: unknown, label: string): string {
  if (typeof value !== "string") fail("FEDERATION_D1_INPUT_INVALID", `${label} is invalid`);
  const epoch = Date.parse(value);
  if (!Number.isSafeInteger(epoch) || new Date(epoch).toISOString() !== value) {
    fail("FEDERATION_D1_INPUT_INVALID", `${label} is not canonical UTC`);
  }
  return value;
}
function tick(clock: () => number): { readonly epoch: number; readonly iso: string } {
  const epoch = clock();
  if (!Number.isSafeInteger(epoch) || epoch < 0) {
    fail("FEDERATION_D1_INPUT_INVALID", "federation authority clock is invalid");
  }
  return { epoch, iso: new Date(epoch).toISOString() };
}
function changed(result: D1Result<unknown>): boolean { return (result.meta?.changes ?? 0) === 1; }
function sameRef(left: VersionedRef, right: VersionedRef): boolean { return left.id === right.id && left.revision === right.revision; }
function sameBinding(left: FederationAuthorityBinding, right: FederationAuthorityBinding): boolean {
  return left.requester_principal_ref === right.requester_principal_ref &&
    left.requester_credential_generation === right.requester_credential_generation &&
    left.server_principal_ref === right.server_principal_ref &&
    left.server_credential_generation === right.server_credential_generation &&
    left.bridge_generation === right.bridge_generation &&
    left.client_fence_ref === right.client_fence_ref &&
    sameRef(left.allowed_reference_manifest_ref, right.allowed_reference_manifest_ref);
}
function requireBinding(stored: FederationAuthorityBinding, requested: FederationAuthorityBinding): void {
  if (!sameBinding(stored, requested)) {
    fail(
      "FEDERATION_D1_BINDING_MISMATCH",
      "job is bound to another principal, generation, fence, or manifest",
    );
  }
}
function normalizeBinding(value: FederationAuthorityBinding): FederationAuthorityBinding {
  return {
    requester_principal_ref: id(value.requester_principal_ref, "requester principal"),
    requester_credential_generation: id(
      value.requester_credential_generation, "requester credential generation",
    ),
    server_principal_ref: id(value.server_principal_ref, "server principal"),
    server_credential_generation: id(
      value.server_credential_generation, "server credential generation",
    ),
    bridge_generation: id(value.bridge_generation, "bridge generation"),
    client_fence_ref: id(value.client_fence_ref, "client fence"),
    allowed_reference_manifest_ref: ref(value.allowed_reference_manifest_ref, "manifest ref"),
    trace_id: id(value.trace_id, "trace id"),
  };
}
function normalizeRequest(value: unknown): FederationRequest {
  const parsed = FederationRequestSchema.safeParse(value);
  if (!parsed.success) fail("FEDERATION_D1_INPUT_INVALID", "request is invalid");
  return parsed.data;
}
async function normalizeManifest(value: unknown): Promise<AllowedReferenceManifest> {
  const parsed = AllowedReferenceManifestSchema.safeParse(value);
  if (!parsed.success) fail("FEDERATION_D1_INPUT_INVALID", "manifest is invalid");
  const { manifest_digest: _digest, ...payload } = parsed.data;
  if (await canonicalDigest(payload) !== parsed.data.manifest_digest) {
    fail("FEDERATION_D1_INPUT_INVALID", "manifest digest mismatch");
  }
  return parsed.data;
}
async function decodeManifest(row: Record<string, unknown>): Promise<AllowedReferenceManifest> {
  const manifest = await normalizeManifest(parseJson(row.manifest_json, "stored manifest"));
  const storedRef = ref(
    { id: row.manifest_id, revision: row.revision }, "stored manifest ref",
  );
  const storedScope = ref(
    { id: row.scope_snapshot_id, revision: row.scope_snapshot_revision }, "stored scope ref",
  );
  const fence = row.client_fence_ref === null
    ? undefined
    : id(row.client_fence_ref, "stored client fence");
  if (
    !sameRef(manifest.manifest_ref, storedRef) ||
    !sameRef(manifest.scope_snapshot_ref, storedScope) ||
    manifest.manifest_digest !== sha(row.manifest_digest, "stored manifest digest") ||
    manifest.client_fence_ref !== fence ||
    manifest.expires_at !== row.expires_at
  ) {
    fail("FEDERATION_D1_INPUT_INVALID", "stored manifest columns diverge");
  }
  iso(row.created_at, "stored manifest created_at");
  return manifest;
}
async function readManifest(database: D1Database, value: VersionedRef): Promise<AllowedReferenceManifest | null> {
  const row = await database.prepare(
    `${MANIFEST_SELECT}WHERE manifest_id=?1 AND revision=?2 LIMIT 1`,
  ).bind(value.id, value.revision).first<Record<string, unknown>>();
  return row === null ? null : decodeManifest(row);
}
async function stableJobId(binding: FederationAuthorityBinding, request: FederationRequest, requestDigest: string): Promise<string> {
  const digest = await canonicalDigest([
    "federation-job", request.exchange_id, request.idempotency_key, requestDigest,
    binding.requester_principal_ref, binding.requester_credential_generation,
    binding.server_principal_ref, binding.server_credential_generation,
    binding.bridge_generation, binding.client_fence_ref,
    binding.allowed_reference_manifest_ref.id, binding.allowed_reference_manifest_ref.revision,
  ]);
  return `fjob-${digest.slice(0, 48)}`;
}
async function cancelRef(jobId: string, reason: string): Promise<string> {
  const digest = await canonicalDigest(["federation-cancel", jobId, reason]);
  return `federation-cancel-${digest.slice(0, 48)}`;
}
function cancelReason(value: unknown): string {
  if (
    typeof value !== "string" || value.length === 0 || value !== value.trim() ||
    encoder.encode(value).byteLength > 4096 ||
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value)
  ) {
    fail("FEDERATION_D1_INPUT_INVALID", "cancellation reason is invalid");
  }
  return value;
}
async function decodeJob(row: Record<string, unknown>): Promise<DecodedJob> {
  const request = normalizeRequest(parseJson(row.request_json, "stored request"));
  const requestDigest = sha(row.request_digest, "stored request digest");
  if (await canonicalDigest(request) !== requestDigest) {
    fail("FEDERATION_D1_INPUT_INVALID", "stored request digest mismatch");
  }
  const parsedStatus = FederationJobStatusSchema.safeParse(
    parseJson(row.status_json, "stored status"),
  );
  if (!parsedStatus.success) fail("FEDERATION_D1_INPUT_INVALID", "stored status is invalid");
  const status = parsedStatus.data;
  const binding: FederationAuthorityBinding = {
    requester_principal_ref: id(row.requester_principal_ref, "stored requester"),
    requester_credential_generation: id(
      row.requester_credential_generation, "stored requester generation",
    ),
    server_principal_ref: id(row.server_principal_ref, "stored server"),
    server_credential_generation: id(
      row.server_credential_generation, "stored server generation",
    ),
    bridge_generation: id(row.bridge_generation, "stored bridge generation"),
    client_fence_ref: id(row.client_fence_ref, "stored client fence"),
    allowed_reference_manifest_ref: ref(
      { id: row.allowed_manifest_id, revision: row.allowed_manifest_revision },
      "stored manifest ref",
    ),
    trace_id: id(row.origin_trace_id, "stored trace id"),
  };
  const exchangeId = id(row.exchange_id, "stored exchange id");
  const idempotencyKey = id(row.idempotency_key, "stored idempotency key");
  const jobId = id(row.job_id, "stored job id");
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
    await stableJobId(binding, request, requestDigest) !== jobId
  ) {
    fail("FEDERATION_D1_INPUT_INVALID", "stored job columns diverge");
  }
  let observed: CompletionDisposition | null = null;
  if (row.observed_completion_disposition !== null) {
    const parsed = CompletionDispositionSchema.safeParse(row.observed_completion_disposition);
    if (!parsed.success) fail("FEDERATION_D1_INPUT_INVALID", "stored disposition is invalid");
    observed = parsed.data;
  }
  let result: FederationEvidenceBundle | null = null;
  if (row.result_json !== null) {
    const parsed = FederationEvidenceBundleSchema.safeParse(
      parseJson(row.result_json, "stored result"),
    );
    if (!parsed.success) fail("FEDERATION_D1_INPUT_INVALID", "stored result is invalid");
    result = parsed.data;
    if (
      result.exchange_id !== exchangeId || result.job_id !== jobId ||
      result.request_digest !== requestDigest
    ) {
      fail("FEDERATION_D1_INPUT_INVALID", "stored result belongs to another job");
    }
  }
  const reason = row.cancellation_reason === null
    ? null
    : cancelReason(row.cancellation_reason);
  const cancelledAt = row.cancelled_at === null ? null : iso(row.cancelled_at, "cancelled_at");
  const openOrFailed = ACTIVE.has(status.transport_state) || status.transport_state === "FAILED";
  const invalid = status.transport_state === "CANCELLED"
    ? status.completion_disposition !== "CANCELLED" ||
      observed !== "CANCELLED" || reason === null || cancelledAt === null || result !== null
    : reason !== null || cancelledAt !== null ||
      (openOrFailed &&
        (status.completion_disposition !== null || observed !== null || result !== null)) ||
      (status.transport_state === "COMPLETED" && observed === null);
  if (invalid) fail("FEDERATION_D1_INPUT_INVALID", "stored terminal state is inconsistent");
  if (status.transport_state === "CANCELLED") {
    const expected = await cancelRef(jobId, reason as string);
    if (status.cancellation_receipt_ref !== expected || status.terminal_receipt_ref !== expected) {
      fail("FEDERATION_D1_INPUT_INVALID", "stored cancellation receipt is not deterministic");
    }
  }
  iso(row.created_at, "stored created_at");
  return {
    binding,
    request,
    record: {
      request_digest: requestDigest,
      status,
      observed_completion_disposition: observed,
      result,
    },
    cancellationReason: reason,
    updatedAt: iso(row.updated_at, "stored updated_at"),
  };
}
async function readJob(database: D1Database, exchangeId: string, idempotencyKey: string): Promise<DecodedJob | null> {
  const row = await database.prepare(
    `${JOB_SELECT}WHERE exchange_id=?1 AND idempotency_key=?2 LIMIT 1`,
  ).bind(exchangeId, idempotencyKey).first<Record<string, unknown>>();
  return row === null ? null : decodeJob(row);
}
function sameSubmission(job: DecodedJob, value: FederationSubmission): boolean {
  return job.record.request_digest === value.request_digest &&
    canonical(job.request) === canonical(value.request) &&
    sameBinding(job.binding, value.binding);
}
function manifestAuthorizes(manifest: AllowedReferenceManifest, binding: FederationAuthorityBinding, now: number): void {
  if (
    manifest.client_fence_ref !== binding.client_fence_ref ||
    manifest.provider_and_policy_generations[binding.requester_principal_ref] !==
      binding.requester_credential_generation ||
    manifest.provider_and_policy_generations[binding.server_principal_ref] !==
      binding.server_credential_generation ||
    Date.parse(manifest.expires_at) <= now
  ) {
    fail("FEDERATION_D1_BINDING_MISMATCH", "manifest does not authorize this binding");
  }
}
export function createD1FederationManifestStore(
  database: D1Database,
  clock: () => number = Date.now,
): FederationManifestStore {
  return {
    get: (value) => readManifest(database, ref(value, "manifest ref")),
    async put(value) {
      const manifest = await normalizeManifest(value);
      const prior = await readManifest(database, manifest.manifest_ref);
      if (prior !== null) {
        if (canonical(prior) !== canonical(manifest)) {
          fail("FEDERATION_D1_MANIFEST_CONFLICT", "manifest revision has different bytes");
        }
        return { disposition: "EXISTING", manifest: prior };
      }
      const created = tick(clock);
      if (Date.parse(manifest.expires_at) <= created.epoch) {
        fail("FEDERATION_D1_INPUT_INVALID", "cannot persist an expired manifest");
      }
      let mutationError: unknown;
      try {
        const mutation = await database.prepare(
          "INSERT INTO federation_reference_manifest(" +
          "manifest_id,revision,manifest_json,manifest_digest,scope_snapshot_id," +
          "scope_snapshot_revision,client_fence_ref,expires_at,created_at)" +
          " VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9)",
        ).bind(
          manifest.manifest_ref.id, manifest.manifest_ref.revision,
          canonical(manifest), manifest.manifest_digest,
          manifest.scope_snapshot_ref.id, manifest.scope_snapshot_ref.revision,
          manifest.client_fence_ref ?? null, manifest.expires_at, created.iso,
        ).run();
        if (!changed(mutation)) mutationError = new Error("manifest insert changed no row");
      } catch (cause) {
        mutationError = cause;
      }
      const stored = await readManifest(database, manifest.manifest_ref);
      if (stored !== null) {
        if (canonical(stored) !== canonical(manifest)) {
          fail("FEDERATION_D1_MANIFEST_CONFLICT", "manifest raced with different bytes");
        }
        return {
          disposition: mutationError === undefined ? "CREATED" : "EXISTING",
          manifest: stored,
        };
      }
      fail(
        "FEDERATION_D1_SETTLEMENT_UNCERTAIN",
        "manifest mutation lacks exact readback",
        true,
        mutationError,
      );
    },
  };
}
function accepted(request: FederationRequest, jobId: string): FederationJobStatus {
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
export function createD1FederationJobAuthority(
  database: D1Database,
  clock: () => number = Date.now,
): FederationJobAuthority {
  return {
    async reserve(raw): Promise<FederationSubmissionReservation> {
      const binding = normalizeBinding(raw.binding);
      const request = normalizeRequest(raw.request);
      const requestDigest = sha(raw.request_digest, "request digest");
      if (await canonicalDigest(request) !== requestDigest) {
        fail("FEDERATION_D1_INPUT_INVALID", "request digest mismatch");
      }
      if (
        request.requester_principal_ref !== binding.requester_principal_ref ||
        request.bridge_generation !== binding.bridge_generation ||
        request.client_fence_ref !== binding.client_fence_ref
      ) {
        fail("FEDERATION_D1_BINDING_MISMATCH", "request does not match its binding");
      }
      const value: FederationSubmission = {
        binding, request, request_digest: requestDigest,
      };
      const observed = tick(clock);
      const manifest = await readManifest(database, binding.allowed_reference_manifest_ref);
      if (manifest === null) {
        fail("FEDERATION_D1_BINDING_MISMATCH", "manifest authority is missing");
      }
      manifestAuthorizes(manifest, binding, observed.epoch);
      const prior = await readJob(database, request.exchange_id, request.idempotency_key);
      if (prior !== null) {
        requireBinding(prior.binding, binding);
        return sameSubmission(prior, value)
          ? { outcome: "REPLAY", request_digest: requestDigest, record: prior.record }
          : { outcome: "CONFLICT", existing_request_digest: prior.record.request_digest };
      }
      const jobId = await stableJobId(binding, request, requestDigest);
      const status = accepted(request, jobId);
      let mutationError: unknown;
      try {
        const mutation = await database.prepare(
          "INSERT INTO federation_job(" +
          "job_id,exchange_id,idempotency_key,request_digest,request_json," +
          "requester_principal_ref,requester_credential_generation,server_principal_ref," +
          "server_credential_generation,bridge_generation,client_fence_ref," +
          "allowed_manifest_id,allowed_manifest_revision,origin_trace_id,attempt," +
          "transport_state,status_json,observed_completion_disposition,result_json," +
          "cancellation_reason,cancelled_at,created_at,updated_at) VALUES (" +
          "?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,1,'ACCEPTED'," +
          "?15,NULL,NULL,NULL,NULL,?16,?16)",
        ).bind(
          jobId, request.exchange_id, request.idempotency_key, requestDigest,
          canonical(request), binding.requester_principal_ref,
          binding.requester_credential_generation, binding.server_principal_ref,
          binding.server_credential_generation, binding.bridge_generation,
          binding.client_fence_ref, binding.allowed_reference_manifest_ref.id,
          binding.allowed_reference_manifest_ref.revision, binding.trace_id,
          canonical(status), observed.iso,
        ).run();
        if (!changed(mutation)) mutationError = new Error("reservation changed no row");
      } catch (cause) {
        mutationError = cause;
      }
      const stored = await readJob(database, request.exchange_id, request.idempotency_key);
      if (stored !== null) {
        requireBinding(stored.binding, binding);
        if (sameSubmission(stored, value)) {
          return {
            outcome: mutationError === undefined ? "CREATED" : "REPLAY",
            request_digest: requestDigest,
            record: stored.record,
          };
        }
        if (mutationError !== undefined) {
          return {
            outcome: "CONFLICT",
            existing_request_digest: stored.record.request_digest,
          };
        }
        fail("FEDERATION_D1_SETTLEMENT_UNCERTAIN", "reservation read back other bytes", true);
      }
      fail(
        "FEDERATION_D1_SETTLEMENT_UNCERTAIN",
        "reservation lacks exact readback",
        true,
        mutationError,
      );
    },
    async read(rawBinding, rawExchangeId, rawIdempotencyKey) {
      const binding = normalizeBinding(rawBinding);
      const stored = await readJob(
        database,
        id(rawExchangeId, "exchange id"),
        id(rawIdempotencyKey, "idempotency key"),
      );
      if (stored === null) return null;
      requireBinding(stored.binding, binding);
      return stored.record;
    },
    async cancel(rawBinding, rawExchangeId, rawIdempotencyKey, rawReason) {
      const binding = normalizeBinding(rawBinding);
      const exchangeId = id(rawExchangeId, "exchange id");
      const idempotencyKey = id(rawIdempotencyKey, "idempotency key");
      const reason = cancelReason(rawReason);
      const prior = await readJob(database, exchangeId, idempotencyKey);
      if (prior === null) return null;
      requireBinding(prior.binding, binding);
      if (prior.record.status.transport_state === "CANCELLED") {
        if (prior.cancellationReason !== reason) {
          fail("FEDERATION_D1_STATE_CONFLICT", "job was cancelled for another reason");
        }
        return prior.record;
      }
      if (!ACTIVE.has(prior.record.status.transport_state)) {
        fail("FEDERATION_D1_STATE_CONFLICT", "terminal job cannot be cancelled");
      }
      const cancelledAt = tick(clock).iso;
      const receipt = await cancelRef(prior.record.status.job_id, reason);
      const status = FederationJobStatusSchema.parse({
        ...prior.record.status,
        transport_state: "CANCELLED",
        completion_disposition: "CANCELLED",
        cancellation_receipt_ref: receipt,
        terminal_receipt_ref: receipt,
      });
      let mutationError: unknown;
      try {
        const mutation = await database.prepare(
          "UPDATE federation_job SET transport_state='CANCELLED',status_json=?1," +
          "observed_completion_disposition='CANCELLED',cancellation_reason=?2," +
          "cancelled_at=?3,updated_at=?3 WHERE job_id=?4 AND transport_state=?5 " +
          "AND status_json=?6 AND updated_at=?7",
        ).bind(
          canonical(status), reason, cancelledAt, prior.record.status.job_id,
          prior.record.status.transport_state, canonical(prior.record.status),
          prior.updatedAt,
        ).run();
        if (!changed(mutation)) mutationError = new Error("cancellation changed no row");
      } catch (cause) {
        mutationError = cause;
      }
      const stored = await readJob(database, exchangeId, idempotencyKey);
      if (
        stored !== null &&
        stored.record.status.transport_state === "CANCELLED" &&
        stored.cancellationReason === reason &&
        canonical(stored.record.status) === canonical(status)
      ) {
        requireBinding(stored.binding, binding);
        return stored.record;
      }
      if (stored !== null && mutationError !== undefined) {
        fail("FEDERATION_D1_STATE_CONFLICT", "job changed during cancellation", true);
      }
      fail(
        "FEDERATION_D1_SETTLEMENT_UNCERTAIN",
        "cancellation lacks exact readback",
        true,
        mutationError,
      );
    },
  };
}
export { canonical as federationCanonicalJson, stableJobId as stableFederationJobId, cancelRef as federationCancellationReceiptRef };
