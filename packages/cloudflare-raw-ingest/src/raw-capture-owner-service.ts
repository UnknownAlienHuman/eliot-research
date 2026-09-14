import type { ObjectResidencyKey } from "@eliotr/contracts";
import { createRawCapturePort } from "./raw-ingest.js";
import { RawCaptureError, type RawCaptureAuthorityInput, type RawCaptureReceipt, type RawCaptureResult } from "./raw-ingest-types.js";
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

interface ExistingSourceRow {
  readonly source_id: unknown;
  readonly source_namespace_id: unknown;
  readonly source_owner_system_id: unknown;
  readonly source_owner_generation: unknown;
  readonly ownership_mode: unknown;
  readonly head_rev: unknown;
}

interface SourceRevisionRow {
  readonly source_id: unknown;
  readonly source_owner_generation: unknown;
  readonly purge_state: unknown;
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

async function assertSourceNotPurged(database: D1Database, sourceRevisionRef: string): Promise<void> {
  let row: { readonly purge_state: unknown } | null;
  try {
    row = await database.prepare("SELECT purge_state FROM source_revision WHERE source_revision_ref=?1 LIMIT 1")
      .bind(sourceRevisionRef).first<{ readonly purge_state: unknown }>();
  } catch (cause) {
    fail("RAW_CAPTURE_SETTLEMENT_UNCERTAIN", "source erasure state is unavailable", true, cause);
  }
  // Before admission there is no source revision. Once it exists, source
  // quarantine or deletion also revokes access to its raw transport copies.
  if (row !== null && row.purge_state !== "LIVE") {
    fail("RAW_CAPTURE_OWNER_NOT_CURRENT", "source is quarantined or erased");
  }
}

async function currentBinding(database: D1Database, principalRef: string, expected?: RawOwnerBinding,
  namespaceId: string | undefined = expected?.source_namespace_id): Promise<RawOwnerBinding> {
  if (namespaceId !== undefined && !IDENTIFIER.test(namespaceId)) fail("RAW_CAPTURE_OWNER_NOT_CURRENT", "source namespace locator is invalid");
  let result: D1Result<OwnerPolicyRow>;
  try {
    result = await database.prepare(
      "SELECT o.source_namespace_id,o.owner_system_id,o.source_owner_generation," +
      "o.source_admission_policy_revision,o.status,p.revision,p.authorized_principal_refs_json,p.allowed_ownership_modes_json," +
      "p.default_storage_policy,p.default_residency_profile_id,p.default_retention_policy_id " +
      "FROM source_namespace_ownership o JOIN source_admission_policy p " +
      "ON p.source_namespace_id=o.source_namespace_id AND p.revision=o.source_admission_policy_revision " +
      "WHERE o.status='ACTIVE' AND EXISTS (SELECT 1 FROM json_each(p.authorized_principal_refs_json) " +
      "WHERE json_each.value=?1) AND (?2 IS NULL OR o.source_namespace_id=?2) ORDER BY o.ownership_record_revision DESC LIMIT 2",
    ).bind(principalRef, namespaceId ?? null).all<OwnerPolicyRow>();
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

async function existingSource(database: D1Database, sourceId: string): Promise<ExistingSourceRow> {
  let row: ExistingSourceRow | null;
  try {
    row = await database.prepare(
      "SELECT source_id,source_namespace_id,source_owner_system_id,source_owner_generation,ownership_mode,head_rev " +
      "FROM source WHERE source_id=?1 LIMIT 1",
    ).bind(sourceId).first<ExistingSourceRow>();
  } catch (cause) {
    fail("RAW_CAPTURE_SETTLEMENT_UNCERTAIN", "target source read is unavailable", true, cause);
  }
  if (row === null) fail("RAW_CAPTURE_OWNER_NOT_CURRENT", "target source is not available to this owner");
  for (const [label, value] of Object.entries({
    source_id: row.source_id,
    source_namespace_id: row.source_namespace_id,
    source_owner_system_id: row.source_owner_system_id,
    source_owner_generation: row.source_owner_generation,
  })) {
    if (typeof value !== "string" || !IDENTIFIER.test(value)) fail("RAW_CAPTURE_SETTLEMENT_UNCERTAIN", `target source ${label} is malformed`, true);
  }
  if (row.source_id !== sourceId || row.ownership_mode !== "immutable_import" ||
      (row.head_rev !== null && (typeof row.head_rev !== "string" || !IDENTIFIER.test(row.head_rev)))) {
    fail("RAW_CAPTURE_SETTLEMENT_UNCERTAIN", "target source identity is malformed", true);
  }
  return row;
}

async function assertTargetSourceCurrent(
  database: D1Database,
  binding: RawOwnerBinding,
  targetSourceId: string,
  expectedHead: string,
  requireExpectedHead = true,
): Promise<void> {
  const target = await existingSource(database, targetSourceId);
  if (target.source_namespace_id !== binding.source_namespace_id ||
      target.source_owner_system_id !== binding.owner_system_id ||
      target.source_owner_generation !== binding.source_owner_generation) {
    fail("RAW_CAPTURE_OWNER_NOT_CURRENT", "target source owner generation is not current");
  }
  if (requireExpectedHead && target.head_rev !== expectedHead) {
    fail("RAW_CAPTURE_STATE_CONFLICT", "target source head changed since the requested capture");
  }
  let revision: SourceRevisionRow | null;
  try {
    revision = await database.prepare(
      "SELECT source_id,source_owner_generation,purge_state FROM source_revision WHERE source_revision_ref=?1 LIMIT 1",
    ).bind(expectedHead).first<SourceRevisionRow>();
  } catch (cause) {
    fail("RAW_CAPTURE_SETTLEMENT_UNCERTAIN", "target source head read is unavailable", true, cause);
  }
  if (revision === null || revision.source_id !== targetSourceId ||
      revision.source_owner_generation !== binding.source_owner_generation) {
    fail("RAW_CAPTURE_OWNER_NOT_CURRENT", "target source head revision is not bound to the owner source");
  }
  if (revision.purge_state !== "LIVE") fail("RAW_CAPTURE_OWNER_NOT_CURRENT", "target source head is quarantined or erased");
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

async function sourceIdentity(
  principalRef: string,
  binding: RawOwnerBinding,
  idempotencyKey: string,
  targetSourceId?: string,
  expectedHead?: string,
): Promise<{ readonly logicalId: string; readonly revisionRef: string }> {
  if (targetSourceId !== undefined && expectedHead !== undefined) {
    const token = await sha256Utf8(JSON.stringify([
      "eliotr.raw-source-revision.v2", principalRef, binding.owner_system_id, binding.source_namespace_id,
      binding.source_owner_generation, targetSourceId, expectedHead, idempotencyKey,
    ]));
    return { logicalId: targetSourceId, revisionRef: `raw-revision-${token.slice(0, 48)}` };
  }
  const token = await sha256Utf8(JSON.stringify(["eliotr.raw-source.v1", principalRef, binding.source_namespace_id, idempotencyKey]));
  return { logicalId: `raw-${token.slice(0, 48)}`, revisionRef: `raw-revision-${token.slice(0, 48)}` };
}

function authorityMatches(input: RawCaptureAuthorityInput, binding: RawOwnerBinding): boolean {
  return (input.target_source_id === undefined) === (input.expected_head_revision_ref === undefined) &&
    (input.target_source_id === undefined || input.source_logical_id === input.target_source_id) &&
    input.source_namespace_id === binding.source_namespace_id && input.owner_system_id === binding.owner_system_id &&
    input.source_owner_generation === binding.source_owner_generation && input.residency_key.scope_domain_id === binding.source_namespace_id &&
    input.residency_key.access_domain_id === input.principal_ref && input.residency_key.encryption_key_domain_id === binding.residency_profile_id &&
    input.residency_key.retention_domain_id === binding.retention_policy_id && input.residency_key.erasure_domain_id === binding.storage_policy;
}

function replayMatches(
  receipt: RawCaptureReceipt,
  request: RawFileCaptureRequest,
  binding: RawOwnerBinding,
  ids: { readonly logicalId: string; readonly revisionRef: string },
): boolean {
  return (request.source_namespace_id === undefined || request.source_namespace_id === receipt.source_namespace_id) &&
    receipt.source_namespace_id === binding.source_namespace_id && receipt.source_logical_id === ids.logicalId &&
    receipt.source_revision_ref === ids.revisionRef && receipt.target_source_id === request.target_source_id &&
    receipt.expected_head_revision_ref === request.expected_head_revision_ref &&
    receipt.original_file_name === request.original_file_name && receipt.content_sha256 === request.content_sha256 &&
    receipt.size_bytes === request.size_bytes && receipt.content_type === request.content_type;
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
  const assertContextCurrent = async (
    context: AuthenticatedRequestContext,
    input: RawCaptureAuthorityInput,
    expected?: RawOwnerBinding,
    requireTargetHead = false,
  ): Promise<void> => {
    const binding = await currentBinding(env.CORE_DB, context.principal_ref, expected, input.source_namespace_id);
    await assertSourceNotPurged(env.CORE_DB, input.source_revision_ref);
    if (!authorityMatches(input, binding)) fail("RAW_CAPTURE_OWNER_NOT_CURRENT", "raw capture authority is no longer current");
    if (input.target_source_id !== undefined && input.expected_head_revision_ref !== undefined) {
      await assertTargetSourceCurrent(env.CORE_DB, binding, input.target_source_id, input.expected_head_revision_ref, requireTargetHead);
    }
  };
  return {
    /** Server-only bridge for capability composition; the public OwnerApi never exposes storage identity. */
    async readRawCaptureForServer(context: AuthenticatedRequestContext, captureId: string) {
      if (context.client_class !== "owner_pwa") fail("RAW_CAPTURE_OWNER_NOT_CURRENT", "raw capture requires an owner session");
      const port = createRawCapturePort({
        database: env.CORE_DB,
        evidence_store: createR2EvidenceObjectStore(env.EVIDENCE_BUCKET),
        max_size_bytes: MAX_APPLICATION_UPLOAD_BYTES,
        assertCurrent: (input) => assertContextCurrent(context, input),
      });
      return port.read({ principal_ref: context.principal_ref, capture_id: captureId });
    },
    async captureRawFile(context: AuthenticatedRequestContext, request: RawFileCaptureRequest): Promise<RawFileCaptureResult> {
      if (context.client_class !== "owner_pwa") fail("RAW_CAPTURE_OWNER_NOT_CURRENT", "raw capture requires an owner session");
      if ((request.target_source_id === undefined) !== (request.expected_head_revision_ref === undefined)) {
        fail("RAW_CAPTURE_INPUT_INVALID", "target source and expected head must be supplied together");
      }
      if (request.target_source_id !== undefined && !IDENTIFIER.test(request.target_source_id)) {
        fail("RAW_CAPTURE_INPUT_INVALID", "target source locator is invalid");
      }
      if (request.expected_head_revision_ref !== undefined && !IDENTIFIER.test(request.expected_head_revision_ref)) {
        fail("RAW_CAPTURE_INPUT_INVALID", "expected source head is invalid");
      }
      const target = request.target_source_id === undefined
        ? undefined
        : await existingSource(env.CORE_DB, request.target_source_id);
      if (target !== undefined && request.source_namespace_id !== undefined &&
          request.source_namespace_id !== target.source_namespace_id) {
        fail("RAW_CAPTURE_OWNER_NOT_CURRENT", "target source is outside the requested namespace");
      }
      const targetNamespaceId = target === undefined
        ? request.source_namespace_id
        : target.source_namespace_id as string;
      const binding = await currentBinding(
        env.CORE_DB,
        context.principal_ref,
        undefined,
        targetNamespaceId,
      );
      const targetSourceId = request.target_source_id;
      const expectedHead = request.expected_head_revision_ref;
      const ids = await sourceIdentity(context.principal_ref, binding, request.idempotency_key, targetSourceId, expectedHead);
      await assertSourceNotPurged(env.CORE_DB, ids.revisionRef);
      const rawResidency = residency(binding, context.principal_ref, request.content_sha256);
      if (targetSourceId !== undefined && expectedHead !== undefined) {
        const replayPort = createRawCapturePort({
          database: env.CORE_DB,
          evidence_store: createR2EvidenceObjectStore(env.EVIDENCE_BUCKET),
          max_size_bytes: MAX_APPLICATION_UPLOAD_BYTES,
          assertCurrent: (input) => assertContextCurrent(context, input),
        });
        const replay = await replayPort.read({ principal_ref: context.principal_ref, idempotency_key: request.idempotency_key });
        if (replay !== null) {
          if (!replayMatches(replay, request, binding, ids)) {
            fail("RAW_CAPTURE_IDEMPOTENCY_CONFLICT", "raw capture idempotency identity is bound to different input or source head");
          }
          return sanitized({ disposition: "CAPTURED", receipt: replay });
        }
        await assertTargetSourceCurrent(env.CORE_DB, binding, targetSourceId, expectedHead);
      }
      const assertCurrent = async (input: RawCaptureAuthorityInput): Promise<void> => {
        await assertContextCurrent(context, input, binding, true);
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
        ...(targetSourceId === undefined ? {} : { target_source_id: targetSourceId, expected_head_revision_ref: expectedHead as string }),
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
        assertCurrent: (input) => assertContextCurrent(context, input),
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
        assertCurrent: (input) => assertContextCurrent(context, input),
      });
      const receipt = await port.read({ principal_ref: context.principal_ref, idempotency_key: idempotencyKey });
      return receipt === null ? null : sanitized({ disposition: "CAPTURED", receipt });
    },
  };
}
