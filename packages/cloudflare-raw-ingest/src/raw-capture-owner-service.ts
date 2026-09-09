import type { ObjectResidencyKey } from "@eliotr/contracts";
import { createRawCapturePort } from "./raw-ingest.js";
import { RawCaptureError, type RawCaptureAuthorityInput, type RawCaptureResult } from "./raw-ingest-types.js";
import type {
  AuthenticatedRequestContext,
  RawFileCaptureRequest,
  RawFileCaptureResult,
} from "@eliotr/interfaces";
import {
  createR2EvidenceObjectStore,
  sha256Utf8,
} from "@eliotr/platform-cloudflare";
export interface RawCaptureOwnerEnvironment {
  readonly CORE_DB: D1Database;
  readonly EVIDENCE_BUCKET: R2Bucket;
}

interface OwnerPolicyRow {
  readonly source_namespace_id: unknown;
  readonly owner_system_id: unknown;
  readonly source_owner_generation: unknown;
  readonly source_admission_policy_revision: unknown;
  readonly status: unknown;
  readonly revision: unknown;
  readonly authorized_principal_refs_json: unknown;
  readonly allowed_ownership_modes_json: unknown;
  readonly default_storage_policy: unknown;
  readonly default_residency_profile_id: unknown;
  readonly default_retention_policy_id: unknown;
}

interface RawOwnerBinding {
  readonly source_namespace_id: string;
  readonly owner_system_id: string;
  readonly source_owner_generation: string;
  readonly policy_revision: number;
  readonly storage_policy: string;
  readonly residency_profile_id: string;
  readonly retention_policy_id: string;
}

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,255}$/u;
const MAX_APPLICATION_UPLOAD_BYTES = 16 * 1024 * 1024;

function fail(code: RawCaptureError["code"], message: string, retryable = false, cause?: unknown): never {
  throw new RawCaptureError(code, message, retryable, cause);
}

function text(row: OwnerPolicyRow, key: keyof OwnerPolicyRow): string {
  const value = row[key];
  if (typeof value !== "string" || !IDENTIFIER.test(value)) fail("RAW_CAPTURE_OWNER_NOT_CURRENT", `owner field ${key} is invalid`);
  return value;
}

async function currentBinding(database: D1Database, principalRef: string, expected?: RawOwnerBinding): Promise<RawOwnerBinding> {
  let result: D1Result<OwnerPolicyRow>;
  try {
    result = await database.prepare(
      "SELECT o.source_namespace_id,o.owner_system_id,o.source_owner_generation," +
      "o.source_admission_policy_revision,o.status,p.revision,p.authorized_principal_refs_json,p.allowed_ownership_modes_json," +
      "p.default_storage_policy,p.default_residency_profile_id,p.default_retention_policy_id " +
      "FROM source_namespace_ownership o JOIN source_admission_policy p " +
      "ON p.source_namespace_id=o.source_namespace_id AND p.revision=o.source_admission_policy_revision " +
      "WHERE o.status='ACTIVE' AND EXISTS (SELECT 1 FROM json_each(p.authorized_principal_refs_json) " +
      "WHERE json_each.value=?1) ORDER BY o.ownership_record_revision DESC LIMIT 2",
    ).bind(principalRef).all<OwnerPolicyRow>();
  } catch (error) {
    fail("RAW_CAPTURE_SETTLEMENT_UNCERTAIN", "raw owner authority read is unavailable", true, error);
  }
  const rows = result.results ?? [];
  if (rows.length !== 1) fail("RAW_CAPTURE_OWNER_NOT_CURRENT", "owner has no unambiguous active source namespace");
  const row = rows[0];
  if (row === undefined || row.status !== "ACTIVE") fail("RAW_CAPTURE_OWNER_NOT_CURRENT", "owner source namespace is not active");
  const policyRevision = row.revision;
  if (typeof policyRevision !== "number" || !Number.isSafeInteger(policyRevision) || policyRevision < 1 ||
      row.source_admission_policy_revision !== policyRevision) {
    fail("RAW_CAPTURE_OWNER_NOT_CURRENT", "owner policy revision is invalid");
  }
  if (typeof row.allowed_ownership_modes_json !== "string") fail("RAW_CAPTURE_OWNER_NOT_CURRENT", "owner policy modes are invalid");
  try {
    const modes: unknown = JSON.parse(row.allowed_ownership_modes_json);
    if (!Array.isArray(modes) || modes.some((mode) => typeof mode !== "string" || !IDENTIFIER.test(mode)) ||
        !modes.includes("immutable_import")) {
      fail("RAW_CAPTURE_OWNER_NOT_CURRENT", "owner policy does not allow immutable raw capture");
    }
  } catch (error) {
    fail("RAW_CAPTURE_OWNER_NOT_CURRENT", "owner policy modes are invalid", false, error);
  }
  const binding: RawOwnerBinding = {
    source_namespace_id: text(row, "source_namespace_id"),
    owner_system_id: text(row, "owner_system_id"),
    source_owner_generation: text(row, "source_owner_generation"),
    policy_revision: policyRevision,
    storage_policy: text(row, "default_storage_policy"),
    residency_profile_id: text(row, "default_residency_profile_id"),
    retention_policy_id: text(row, "default_retention_policy_id"),
  };
  if (expected !== undefined && (binding.source_namespace_id !== expected.source_namespace_id ||
      binding.owner_system_id !== expected.owner_system_id || binding.source_owner_generation !== expected.source_owner_generation ||
      binding.policy_revision !== expected.policy_revision || binding.storage_policy !== expected.storage_policy ||
      binding.residency_profile_id !== expected.residency_profile_id || binding.retention_policy_id !== expected.retention_policy_id)) {
    fail("RAW_CAPTURE_OWNER_NOT_CURRENT", "owner policy or generation changed during raw capture");
  }
  return binding;
}

function residency(binding: RawOwnerBinding, principalRef: string, digest: string): ObjectResidencyKey {
  return {
    scope_domain_id: binding.source_namespace_id,
    access_domain_id: principalRef,
    confidentiality_domain_id: "private",
    encryption_key_domain_id: binding.residency_profile_id,
    retention_domain_id: binding.retention_policy_id,
    erasure_domain_id: binding.storage_policy,
    content_digest: { algorithm: "sha256", digest },
  };
}

async function sourceIdentity(principalRef: string, binding: RawOwnerBinding, idempotencyKey: string): Promise<{ readonly logicalId: string; readonly revisionRef: string }> {
  const token = await sha256Utf8(JSON.stringify(["eliotr.raw-source.v1", principalRef, binding.source_namespace_id, idempotencyKey]));
  return { logicalId: `raw-${token.slice(0, 48)}`, revisionRef: `raw-revision-${token.slice(0, 48)}` };
}

function authorityMatches(input: RawCaptureAuthorityInput, binding: RawOwnerBinding): boolean {
  return input.source_namespace_id === binding.source_namespace_id && input.owner_system_id === binding.owner_system_id &&
    input.source_owner_generation === binding.source_owner_generation && input.residency_key.scope_domain_id === binding.source_namespace_id &&
    input.residency_key.access_domain_id === input.principal_ref && input.residency_key.encryption_key_domain_id === binding.residency_profile_id &&
    input.residency_key.retention_domain_id === binding.retention_policy_id && input.residency_key.erasure_domain_id === binding.storage_policy;
}

export function createRawCaptureService(env: RawCaptureOwnerEnvironment) {
  const sanitized = (captured: RawCaptureResult): RawFileCaptureResult => ({
    protocol: "eliotr.raw-file-capture.v1",
    disposition: captured.disposition,
    capture_id: captured.receipt.capture_id,
    idempotency_key: captured.receipt.idempotency_key,
    original_file_name: captured.receipt.original_file_name,
    content_sha256: captured.receipt.content_sha256,
    size_bytes: captured.receipt.size_bytes,
    content_type: captured.receipt.content_type,
    captured_at: captured.receipt.captured_at,
  });
  return {
    async captureRawFile(context: AuthenticatedRequestContext, request: RawFileCaptureRequest): Promise<RawFileCaptureResult> {
      if (context.client_class !== "owner_pwa") fail("RAW_CAPTURE_OWNER_NOT_CURRENT", "raw capture requires an owner session");
      const binding = await currentBinding(env.CORE_DB, context.principal_ref);
      const ids = await sourceIdentity(context.principal_ref, binding, request.idempotency_key);
      const rawResidency = residency(binding, context.principal_ref, request.content_sha256);
      const assertCurrent = async (input: RawCaptureAuthorityInput): Promise<void> => {
        const current = await currentBinding(env.CORE_DB, context.principal_ref, binding);
        if (!authorityMatches(input, current)) fail("RAW_CAPTURE_OWNER_NOT_CURRENT", "raw capture authority changed during settlement");
      };
      const port = createRawCapturePort({
        database: env.CORE_DB,
        evidence_store: createR2EvidenceObjectStore(env.EVIDENCE_BUCKET),
        max_size_bytes: MAX_APPLICATION_UPLOAD_BYTES,
        assertCurrent,
      });
      const captured = await port.capture({
        ...request,
        principal_ref: context.principal_ref,
        owner_system_id: binding.owner_system_id,
        source_namespace_id: binding.source_namespace_id,
        source_revision_ref: ids.revisionRef,
        source_logical_id: ids.logicalId,
        source_owner_generation: binding.source_owner_generation,
        residency_key: rawResidency,
      });
      return sanitized(captured);
    },
    async readRawFile(context: AuthenticatedRequestContext, captureId: string): Promise<RawFileCaptureResult | null> {
      if (context.client_class !== "owner_pwa") fail("RAW_CAPTURE_OWNER_NOT_CURRENT", "raw capture requires an owner session");
      const port = createRawCapturePort({
        database: env.CORE_DB,
        evidence_store: createR2EvidenceObjectStore(env.EVIDENCE_BUCKET),
        max_size_bytes: MAX_APPLICATION_UPLOAD_BYTES,
        assertCurrent: async (input) => {
          const binding = await currentBinding(env.CORE_DB, context.principal_ref);
          if (!authorityMatches(input, binding)) fail("RAW_CAPTURE_OWNER_NOT_CURRENT", "raw capture authority is no longer current");
        },
      });
      const receipt = await port.read({ principal_ref: context.principal_ref, capture_id: captureId });
      return receipt === null ? null : sanitized({ disposition: "CAPTURED", receipt });
    },
    async readRawFileByIdempotency(context: AuthenticatedRequestContext, idempotencyKey: string): Promise<RawFileCaptureResult | null> {
      if (context.client_class !== "owner_pwa") fail("RAW_CAPTURE_OWNER_NOT_CURRENT", "raw capture requires an owner session");
      const port = createRawCapturePort({
        database: env.CORE_DB,
        evidence_store: createR2EvidenceObjectStore(env.EVIDENCE_BUCKET),
        max_size_bytes: MAX_APPLICATION_UPLOAD_BYTES,
        assertCurrent: async (input) => {
          const binding = await currentBinding(env.CORE_DB, context.principal_ref);
          if (!authorityMatches(input, binding)) fail("RAW_CAPTURE_OWNER_NOT_CURRENT", "raw capture authority is no longer current");
        },
      });
      const receipt = await port.read({ principal_ref: context.principal_ref, idempotency_key: idempotencyKey });
      return receipt === null ? null : sanitized({ disposition: "CAPTURED", receipt });
    },
  };
}
