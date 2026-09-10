import { canonicalJson, canonicalDigest, activeOwner, policySnapshot } from "@eliotr/platform-cloudflare";
import type { IngestAdmissionPolicySnapshot } from "@eliotr/platform-cloudflare";
import type {
  AuthenticatedRequestContext,
  BundleIngestStatus,
  OwnerApi,
  RawNormalizedAdmissionRequest,
  RawNormalizedAdmissionResult,
} from "@eliotr/interfaces";
import {
  createSnapshotViewWitness,
  verifySnapshotViewWitness,
  prepareRawNormalizedAdmission,
  type RawNormalizedCapture,
  type RawNormalizedCandidatePolicy,
  type SnapshotViewWitness,
} from "@eliotr/cloudflare-raw-ingest";
import { readRawMarkdownCandidate } from "@eliotr/cloudflare-markdown";
import type { RawCaptureReceipt } from "@eliotr/cloudflare-raw-ingest";

const ID = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/u;
const TTL_MS = 24 * 60 * 60 * 1000;

export class RawNormalizedAdmissionError extends Error {
  public readonly code: string;
  public readonly status: number;
  public readonly retryable: boolean;
  public constructor(code: string, status: number, message: string, retryable = false, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "RawNormalizedAdmissionError";
    this.code = code;
    this.status = status;
    this.retryable = retryable;
  }
}

interface AdmissionRow {
  readonly admission_operation_id: unknown;
  readonly principal_ref: unknown;
  readonly capture_id: unknown;
  readonly conversion_operation_id: unknown;
  readonly idempotency_key: unknown;
  readonly input_fingerprint: unknown;
  readonly candidate_ref: unknown;
  readonly source_revision_ref: unknown;
  readonly source_view_ref: unknown;
  readonly snapshot_view_json: unknown;
  readonly snapshot_view_sha256: unknown;
  readonly policy_snapshot_json: unknown;
  readonly policy_snapshot_sha256: unknown;
  readonly policy_revision: unknown;
  readonly ingest_operation_id: unknown;
  readonly state: unknown;
  readonly reason_codes_json: unknown;
  readonly receipt_json: unknown;
  readonly created_at: unknown;
  readonly updated_at: unknown;
  readonly expires_at: unknown;
}

const SELECT = "SELECT admission_operation_id,principal_ref,capture_id,conversion_operation_id,idempotency_key,input_fingerprint," +
  "candidate_ref,source_revision_ref,source_view_ref,snapshot_view_json,snapshot_view_sha256,policy_snapshot_json," +
  "policy_snapshot_sha256,policy_revision,ingest_operation_id,state,reason_codes_json,receipt_json,created_at,updated_at,expires_at " +
  "FROM raw_normalized_admission ";

function validId(value: unknown): value is string { return typeof value === "string" && ID.test(value); }
function requireId(value: unknown, label: string): string {
  if (!validId(value)) throw new RawNormalizedAdmissionError("RAW_NORMALIZED_INPUT_INVALID", 400, `${label} is invalid`);
  return value;
}
function json<T>(value: unknown, label: string): T {
  if (typeof value !== "string") throw new RawNormalizedAdmissionError("RAW_NORMALIZED_STATE_INVALID", 503, `${label} is missing`, true);
  try { return JSON.parse(value) as T; } catch (cause) { throw new RawNormalizedAdmissionError("RAW_NORMALIZED_STATE_INVALID", 503, `${label} is malformed`, true, cause); }
}
function reasonCodes(value: unknown): readonly string[] {
  const parsed = json<unknown>(value, "reason codes");
  if (!Array.isArray(parsed) || parsed.some((entry) => !validId(entry))) throw new RawNormalizedAdmissionError("RAW_NORMALIZED_STATE_INVALID", 503, "reason codes are malformed", true);
  return parsed as string[];
}
function receipt(value: unknown): RawNormalizedAdmissionResult["admission_receipt"] {
  if (value === null || value === undefined) return undefined;
  return json<RawNormalizedAdmissionResult["admission_receipt"]>(value, "admission receipt");
}

function state(value: unknown): RawNormalizedAdmissionResult["state"] {
  if (value === "PREPARING" || value === "UPLOAD_REQUIRED" || value === "VERIFIED" || value === "AUTHORIZED" || value === "PROMOTED" || value === "COMMITTED" || value === "QUARANTINED" || value === "REJECTED" || value === "UNKNOWN") return value;
  throw new RawNormalizedAdmissionError("RAW_NORMALIZED_STATE_INVALID", 503, "admission state is invalid", true);
}

function resultFrom(row: AdmissionRow, status?: BundleIngestStatus): RawNormalizedAdmissionResult {
  const operationId = requireId(row.admission_operation_id, "admission_operation_id");
  const captureId = requireId(row.capture_id, "capture_id");
  const conversionId = requireId(row.conversion_operation_id, "conversion_operation_id");
  const candidateRef = requireId(row.candidate_ref, "candidate_ref");
  const sourceRevision = requireId(row.source_revision_ref, "source_revision_ref");
  const sourceView = requireId(row.source_view_ref, "source_view_ref");
  const updatedAt = requireId(row.updated_at, "updated_at");
  const expiresAt = requireId(row.expires_at, "expires_at");
  const parsedState = state(row.state);
  const storedReceipt = receipt(row.receipt_json);
  return {
    protocol: "eliotr.raw-normalized-admission.v1",
    admission_operation_id: operationId,
    capture_id: captureId,
    conversion_operation_id: conversionId,
    candidate_ref: candidateRef,
    state: status?.state ?? parsedState,
    source_revision_ref: sourceRevision,
    source_view_ref: sourceView,
    conversion_state: "COMPLETE",
    ...(status === undefined ? {} : { status }),
    ...(storedReceipt === undefined ? {} : { admission_receipt: storedReceipt }),
    reason_codes: reasonCodes(row.reason_codes_json),
    expires_at: expiresAt,
    updated_at: updatedAt,
  };
}

function captureInput(capture: RawCaptureReceipt): RawNormalizedCapture {
  return {
    capture_id: capture.capture_id,
    principal_ref: capture.principal_ref,
    owner_system_id: capture.owner_system_id,
    source_namespace_id: capture.source_namespace_id,
    source_revision_ref: capture.source_revision_ref,
    source_logical_id: capture.source_logical_id,
    source_owner_generation: capture.source_owner_generation,
    original_file_name: capture.original_file_name,
    content_sha256: capture.content_sha256,
    size_bytes: capture.size_bytes,
    content_type: capture.content_type,
    residency_key_digest: capture.residency_key_digest,
  };
}

function policyInput(policy: IngestAdmissionPolicySnapshot, principalRef: string, policySha: string): RawNormalizedCandidatePolicy {
  return {
    policy_snapshot_sha256: policySha,
    policy_revision: policy.revision,
    ownership_mode: "immutable_import",
    origin_location_class: "external",
    residency_and_disclosure: {
      scope_domain_id: policy.source_namespace_id,
      access_domain_id: principalRef,
      confidentiality_domain_id: "private",
      encryption_key_domain_id: policy.default_residency_profile_id,
      retention_domain_id: policy.default_retention_policy_id,
      erasure_domain_id: policy.default_storage_policy,
      disclosure_ceiling: policy.disclosure_ceiling,
      allowed_use: policy.allowed_use,
    },
    analyzer: "workers-ai-markdown",
    analyzer_version: "raw-markdown-v1",
    profile: "raw-markdown-v1",
    config_hash: policySha,
    purpose: "library-import",
  };
}

function body(bytes: Uint8Array): ReadableStream<Uint8Array> {
  const response = new Response(bytes.slice().buffer as ArrayBuffer);
  if (response.body === null) throw new Error("unable to create upload body");
  return response.body;
}

function terminal(row: AdmissionRow): boolean {
  return row.state === "COMMITTED" || row.state === "QUARANTINED" || row.state === "REJECTED";
}

function receiptState(decision: "ADMITTED" | "DUPLICATE" | "QUARANTINED" | "REJECTED"): "COMMITTED" | "QUARANTINED" | "REJECTED" {
  return decision === "ADMITTED" || decision === "DUPLICATE" ? "COMMITTED" : decision;
}

export function createRawNormalizedAdmissionService(input: {
  readonly database: D1Database;
  readonly bucket: R2Bucket;
  readonly owner: Pick<OwnerApi, "prepareBundle" | "uploadBundlePart" | "completeBundleFile" | "commitBundle" | "getBundleStatus" | "getBundleRecovery">;
  readonly readCapture: (context: AuthenticatedRequestContext, captureId: string) => Promise<RawCaptureReceipt | null>;
  readonly now?: () => number;
}) {
  const now = input.now ?? Date.now;
  async function load(operationId: string): Promise<AdmissionRow | null> {
    return input.database.prepare(`${SELECT}WHERE admission_operation_id=?1 LIMIT 1`).bind(operationId).first<AdmissionRow>();
  }
  async function statusFor(row: AdmissionRow, context: AuthenticatedRequestContext): Promise<BundleIngestStatus | undefined> {
    if (typeof row.ingest_operation_id !== "string") return undefined;
    return input.owner.getBundleStatus(context, row.ingest_operation_id);
  }
  async function storedResult(row: AdmissionRow, context: AuthenticatedRequestContext): Promise<RawNormalizedAdmissionResult> {
    const status = await statusFor(row, context);
    return resultFrom(row, status);
  }
  async function assertRowCurrent(row: AdmissionRow, context: AuthenticatedRequestContext): Promise<RawCaptureReceipt> {
    if (row.principal_ref !== context.principal_ref) throw new RawNormalizedAdmissionError("RAW_NORMALIZED_NOT_FOUND", 404, "raw normalized admission is not available");
    const captureId = requireId(row.capture_id, "capture_id");
    const captureReceipt = await input.readCapture(context, captureId);
    if (captureReceipt === null) throw new RawNormalizedAdmissionError("RAW_NORMALIZED_SOURCE_UNAVAILABLE", 404, "raw capture is not available");
    const capture = captureInput(captureReceipt);
    const owner = await activeOwner(input.database, capture.source_namespace_id);
    if (owner.owner_system_id !== capture.owner_system_id || owner.source_owner_generation !== capture.source_owner_generation || typeof owner.source_admission_policy_revision !== "number") {
      throw new RawNormalizedAdmissionError("RAW_NORMALIZED_AUTHORITY_STALE", 409, "raw capture owner is no longer current");
    }
    const currentPolicy = await policySnapshot(input.database, capture.source_namespace_id, owner.source_admission_policy_revision);
    const currentPolicySha = await canonicalDigest(currentPolicy);
    if (!currentPolicy.authorized_principal_refs.includes(context.principal_ref) || !currentPolicy.allowed_ownership_modes.includes("immutable_import") || row.policy_snapshot_sha256 !== currentPolicySha || String(row.policy_revision) !== String(currentPolicy.revision)) {
      throw new RawNormalizedAdmissionError("RAW_NORMALIZED_AUTHORITY_STALE", 409, "admission policy is no longer current");
    }
    const witness = json<SnapshotViewWitness>(row.snapshot_view_json, "snapshot view");
    const storedPolicy = json<IngestAdmissionPolicySnapshot>(row.policy_snapshot_json, "policy snapshot");
    if (await canonicalDigest(storedPolicy) !== currentPolicySha || row.policy_snapshot_sha256 !== currentPolicySha) {
      throw new RawNormalizedAdmissionError("RAW_NORMALIZED_STATE_INVALID", 503, "stored policy snapshot is invalid", true);
    }
    if (typeof row.snapshot_view_sha256 !== "string" || await canonicalDigest(witness) !== row.snapshot_view_sha256 || row.source_view_ref !== witness.source_view_ref) {
      throw new RawNormalizedAdmissionError("RAW_NORMALIZED_STATE_INVALID", 503, "stored snapshot view witness is invalid", true);
    }
    try {
      await verifySnapshotViewWitness(witness, capture, { policy_snapshot_sha256: currentPolicySha, policy_revision: currentPolicy.revision });
    } catch (cause) {
      throw new RawNormalizedAdmissionError("RAW_NORMALIZED_AUTHORITY_STALE", 409, "stored snapshot view witness is no longer current", false, cause);
    }
    if (!terminal(row)) {
      const expiry = typeof row.expires_at === "string" ? Date.parse(row.expires_at) : Number.NaN;
      if (!Number.isFinite(expiry) || expiry <= now()) throw new RawNormalizedAdmissionError("RAW_NORMALIZED_EXPIRED", 409, "raw normalized admission reservation has expired");
    }
    return captureReceipt;
  }
  async function update(rowId: string, fields: { readonly state?: string; readonly ingest_operation_id?: string; readonly reason_codes_json?: string; readonly receipt_json?: string | null }): Promise<void> {
    const sets: string[] = ["updated_at=?2"]; const values: unknown[] = [rowId, new Date(now()).toISOString()];
    if (fields.state !== undefined) { sets.push("state=?3"); values.push(fields.state); }
    if (fields.ingest_operation_id !== undefined) { sets.push(`ingest_operation_id=?${values.length + 1}`); values.push(fields.ingest_operation_id); }
    if (fields.reason_codes_json !== undefined) { sets.push(`reason_codes_json=?${values.length + 1}`); values.push(fields.reason_codes_json); }
    if (fields.receipt_json !== undefined) { sets.push(`receipt_json=?${values.length + 1}`); values.push(fields.receipt_json); }
    await input.database.prepare(`UPDATE raw_normalized_admission SET ${sets.join(",")} WHERE admission_operation_id=?1 AND state NOT IN ('COMMITTED','QUARANTINED','REJECTED')`).bind(...values).run();
  }
  async function admit(context: AuthenticatedRequestContext, captureId: string, request: RawNormalizedAdmissionRequest): Promise<RawNormalizedAdmissionResult> {
    if (context.client_class !== "owner_pwa") throw new RawNormalizedAdmissionError("RAW_NORMALIZED_OWNER_REQUIRED", 403, "raw normalized admission requires an owner session");
    const cid = requireId(captureId, "capture_id");
    const idem = requireId(request.idempotency_key, "idempotency_key");
    const conversionId = requireId(request.conversion_operation_id, "conversion_operation_id");
    // The operation identity is scoped to the caller's idempotency key. Payload changes
    // therefore resolve to a typed conflict against the same durable reservation.
    const stableAdmissionId = await canonicalDigest(["eliotr.raw-normalized-admission.v1", context.principal_ref, idem]);
    const prior = await load(stableAdmissionId);
    if (prior !== null) {
      if (prior.principal_ref !== context.principal_ref || prior.capture_id !== cid || prior.conversion_operation_id !== conversionId || prior.idempotency_key !== idem) throw new RawNormalizedAdmissionError("RAW_NORMALIZED_IDEMPOTENCY_CONFLICT", 409, "admission identity is bound to different input");
      if (terminal(prior)) { await assertRowCurrent(prior, context); return storedResult(prior, context); }
      await assertRowCurrent(prior, context);
    }
    const captureReceipt = await input.readCapture(context, cid);
    if (captureReceipt === null) throw new RawNormalizedAdmissionError("RAW_NORMALIZED_SOURCE_UNAVAILABLE", 404, "raw capture is not available");
    const capture = captureInput(captureReceipt);
    const owner = await activeOwner(input.database, capture.source_namespace_id);
    if (typeof owner.source_admission_policy_revision !== "number" || !Number.isSafeInteger(owner.source_admission_policy_revision) || owner.source_admission_policy_revision < 1) {
      throw new RawNormalizedAdmissionError("RAW_NORMALIZED_POLICY_DENIED", 503, "active owner policy revision is invalid", true);
    }
    const policy = await policySnapshot(input.database, capture.source_namespace_id, owner.source_admission_policy_revision);
    if (owner.owner_system_id !== capture.owner_system_id || owner.source_owner_generation !== capture.source_owner_generation ||
        !policy.authorized_principal_refs.includes(context.principal_ref) || !policy.allowed_ownership_modes.includes("immutable_import")) {
      throw new RawNormalizedAdmissionError("RAW_NORMALIZED_POLICY_DENIED", 403, "raw normalized admission is not authorized");
    }
    const policySha = await canonicalDigest(policy);
    let witness: SnapshotViewWitness;
    let policyValue: RawNormalizedCandidatePolicy;
    if (prior !== null) {
      witness = json<SnapshotViewWitness>(prior.snapshot_view_json, "snapshot view");
      policyValue = policyInput(policy, context.principal_ref, policySha);
      if (prior.source_view_ref !== witness.source_view_ref || prior.policy_snapshot_sha256 !== policySha || await canonicalDigest(witness) !== prior.snapshot_view_sha256 || await canonicalDigest(json<IngestAdmissionPolicySnapshot>(prior.policy_snapshot_json, "policy snapshot")) !== policySha) {
        throw new RawNormalizedAdmissionError("RAW_NORMALIZED_STATE_INVALID", 503, "durable admission witness is inconsistent", true);
      }
      await verifySnapshotViewWitness(witness, capture, { policy_snapshot_sha256: policySha, policy_revision: policy.revision });
    } else {
      // The source observation time is immutable capture history, never admission wall-clock time.
      witness = await createSnapshotViewWitness({ capture, policy_snapshot_sha256: policySha, policy_revision: policy.revision, observed_at: captureReceipt.captured_at, observation_freshness: "observed_with_age" });
      policyValue = policyInput(policy, context.principal_ref, policySha);
    }
    const assertCurrent = async (): Promise<void> => {
      if (context.request.signal.aborted) throw new RawNormalizedAdmissionError("RAW_NORMALIZED_AUTHORITY_STALE", 409, "owner or policy changed during conversion readback");
      const currentOwner = await activeOwner(input.database, capture.source_namespace_id);
      if (currentOwner.owner_system_id !== capture.owner_system_id || currentOwner.source_owner_generation !== capture.source_owner_generation || currentOwner.source_admission_policy_revision !== policy.revision) {
        throw new RawNormalizedAdmissionError("RAW_NORMALIZED_AUTHORITY_STALE", 409, "owner or policy changed during conversion readback");
      }
      const currentPolicy = await policySnapshot(input.database, capture.source_namespace_id, policy.revision);
      if (!currentPolicy.authorized_principal_refs.includes(context.principal_ref) || !currentPolicy.allowed_ownership_modes.includes("immutable_import") || await canonicalDigest(currentPolicy) !== policySha) throw new RawNormalizedAdmissionError("RAW_NORMALIZED_AUTHORITY_STALE", 409, "admission policy changed during conversion readback");
    };
    const conversion = await readRawMarkdownCandidate(input.database, input.bucket, { principal_ref: context.principal_ref }, captureReceipt, conversionId, { assertCurrent, signal: context.request.signal });
    if (conversion === null) throw new RawNormalizedAdmissionError("RAW_NORMALIZED_CONVERSION_UNAVAILABLE", 409, "complete conversion candidate is unavailable");
    const prepared = await prepareRawNormalizedAdmission({ capture, conversion: conversion.conversion, output: conversion.output, snapshot_view: witness, policy: policyValue }, `raw-normalized:${stableAdmissionId}`);
    await assertCurrent();
    const inputFingerprint = await canonicalDigest([prepared.candidate.candidate_ref, witness.source_view_ref, policySha, capture.content_sha256, conversionId]);
    const createdAt = new Date(now()); const expiresAt = new Date(createdAt.getTime() + TTL_MS).toISOString();
    if (prior === null) {
      try {
        await input.database.prepare("INSERT INTO raw_normalized_admission(admission_operation_id,principal_ref,capture_id,conversion_operation_id,idempotency_key,input_fingerprint,candidate_ref,source_revision_ref,source_view_ref,snapshot_view_json,snapshot_view_sha256,policy_snapshot_json,policy_snapshot_sha256,policy_revision,state,reason_codes_json,created_at,updated_at,expires_at) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,'PREPARING','[]',?15,?15,?16)")
          .bind(stableAdmissionId, context.principal_ref, cid, conversionId, idem, inputFingerprint, prepared.candidate.candidate_ref, capture.source_revision_ref, witness.source_view_ref, canonicalJson(witness), await canonicalDigest(witness), canonicalJson(policy), policySha, policy.revision, createdAt.toISOString(), expiresAt).run();
      } catch (cause) {
        const raced = await load(stableAdmissionId);
        if (raced === null) throw new RawNormalizedAdmissionError("RAW_NORMALIZED_RESERVATION_UNKNOWN", 503, "admission reservation outcome is uncertain", true, cause);
        if (raced.principal_ref !== context.principal_ref || raced.capture_id !== cid || raced.conversion_operation_id !== conversionId || raced.idempotency_key !== idem) throw new RawNormalizedAdmissionError("RAW_NORMALIZED_IDEMPOTENCY_CONFLICT", 409, "admission identity is bound to different input");
        return admit(context, cid, request);
      }
    }
    try {
      let preparedBundle: Awaited<ReturnType<OwnerApi["prepareBundle"]>>;
      if (prior !== null && typeof prior.ingest_operation_id === "string") {
        const recovery = await input.owner.getBundleRecovery(context, prior.ingest_operation_id);
        if (recovery.status.receipt !== undefined) {
          await update(stableAdmissionId, { state: receiptState(recovery.status.receipt.decision), reason_codes_json: canonicalJson(recovery.status.receipt.reason_codes), receipt_json: canonicalJson(recovery.status.receipt) });
          const row = await load(stableAdmissionId); if (row === null) throw new RawNormalizedAdmissionError("RAW_NORMALIZED_STATE_INVALID", 503, "admission readback is missing", true); return storedResult(row, context);
        }
        if (recovery.status.staging_session_ref === undefined) throw new RawNormalizedAdmissionError("RAW_NORMALIZED_STATE_INVALID", 503, "recovery session is missing", true);
        const files = Object.entries(recovery.file_hashes).sort(([left], [right]) => left.localeCompare(right)).map(([path, digest]) => ({ path, expected_sha256: digest, max_part_bytes: 8 * 1024 * 1024 }));
        if (await canonicalDigest(prepared.request.manifest) !== recovery.manifest_sha256 || await canonicalDigest(prepared.request.file_hashes) !== await canonicalDigest(recovery.file_hashes)) throw new RawNormalizedAdmissionError("RAW_NORMALIZED_STATE_INVALID", 503, "recovery manifest is inconsistent", true);
        preparedBundle = { operation_id: recovery.status.operation_id, manifest_sha256: recovery.manifest_sha256, disposition: "UPLOAD_REQUIRED", multipart_session_ref: recovery.status.staging_session_ref, files, expires_at: recovery.status.expires_at, reason_codes: [] };
      } else {
        preparedBundle = await input.owner.prepareBundle(context, prepared.request);
      }
      if (preparedBundle.disposition === "DUPLICATE" && preparedBundle.existing_receipt !== undefined) {
        await update(stableAdmissionId, { state: receiptState(preparedBundle.existing_receipt.decision), ingest_operation_id: preparedBundle.operation_id, reason_codes_json: canonicalJson(preparedBundle.reason_codes), receipt_json: canonicalJson(preparedBundle.existing_receipt) });
        const row = await load(stableAdmissionId); if (row === null) throw new RawNormalizedAdmissionError("RAW_NORMALIZED_STATE_INVALID", 503, "admission readback is missing", true); return storedResult(row, context);
      }
      if (preparedBundle.disposition === "REJECTED") {
        await update(stableAdmissionId, { state: "REJECTED", reason_codes_json: canonicalJson(preparedBundle.reason_codes) });
        const row = await load(stableAdmissionId); if (row === null) throw new RawNormalizedAdmissionError("RAW_NORMALIZED_STATE_INVALID", 503, "admission rejection readback is missing", true); return storedResult(row, context);
      }
      if (preparedBundle.multipart_session_ref === undefined || preparedBundle.files === undefined) throw new RawNormalizedAdmissionError("RAW_NORMALIZED_STATE_INVALID", 503, "normalized staging session is incomplete", true);
      await update(stableAdmissionId, { state: "UPLOAD_REQUIRED", ingest_operation_id: preparedBundle.operation_id });
      const bytesByPath: Readonly<Record<string, Uint8Array>> = { "content.md": conversion.output.bytes, "manifest.json": prepared.candidate.manifest_bytes, "hashes.sha256": prepared.candidate.hashes_bytes };
      for (const file of preparedBundle.files) {
        const bytes = bytesByPath[file.path]; if (bytes === undefined) throw new RawNormalizedAdmissionError("RAW_NORMALIZED_STATE_INVALID", 503, "staging requested an unknown candidate file", true);
        await assertCurrent();
        try {
          await input.owner.completeBundleFile(context, { operation_id: preparedBundle.operation_id, multipart_session_ref: preparedBundle.multipart_session_ref, path: file.path, parts: [] });
        } catch {
          await assertCurrent();
          const uploaded = await input.owner.uploadBundlePart(context, { operation_id: preparedBundle.operation_id, multipart_session_ref: preparedBundle.multipart_session_ref, path: file.path, part_number: 1, size_bytes: bytes.byteLength, final_part: true, body: body(bytes) });
          await assertCurrent();
          await input.owner.completeBundleFile(context, { operation_id: preparedBundle.operation_id, multipart_session_ref: preparedBundle.multipart_session_ref, path: file.path, parts: [{ part_number: uploaded.part_number, size_bytes: uploaded.size_bytes, etag: uploaded.etag }] });
        }
      }
      await assertCurrent();
      const admissionReceipt = await input.owner.commitBundle(context, { operation_id: preparedBundle.operation_id, multipart_session_ref: preparedBundle.multipart_session_ref, manifest_sha256: preparedBundle.manifest_sha256 });
      const terminalState = receiptState(admissionReceipt.decision);
      await update(stableAdmissionId, { state: terminalState, reason_codes_json: canonicalJson(admissionReceipt.reason_codes), receipt_json: canonicalJson(admissionReceipt) });
      const row = await load(stableAdmissionId); if (row === null) throw new RawNormalizedAdmissionError("RAW_NORMALIZED_STATE_INVALID", 503, "admission completion readback is missing", true); return storedResult(row, context);
    } catch (cause) {
      if (cause instanceof RawNormalizedAdmissionError) throw cause;
      try { await update(stableAdmissionId, { state: "UNKNOWN", reason_codes_json: canonicalJson(["ADMISSION_OUTCOME_UNKNOWN"]) }); } catch { /* status remains recoverable through existing ingest operation */ }
      throw new RawNormalizedAdmissionError("RAW_NORMALIZED_OUTCOME_UNKNOWN", 503, "raw normalized admission outcome is uncertain; inspect durable status", true, cause);
    }
  }
  async function getStatus(context: AuthenticatedRequestContext, captureId: string, admissionOperationId: string): Promise<RawNormalizedAdmissionResult> {
    if (context.client_class !== "owner_pwa") throw new RawNormalizedAdmissionError("RAW_NORMALIZED_OWNER_REQUIRED", 403, "raw normalized admission requires an owner session");
    const row = await load(requireId(admissionOperationId, "admission_operation_id"));
    if (row === null || row.capture_id !== requireId(captureId, "capture_id")) throw new RawNormalizedAdmissionError("RAW_NORMALIZED_NOT_FOUND", 404, "raw normalized admission is not available");
    await assertRowCurrent(row, context);
    return storedResult(row, context);
  }
  return { admit, getStatus };
}
