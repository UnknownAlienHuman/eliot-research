import {
  BundleAdmissionReceiptSchema,
  type BundleAdmissionReceipt,
} from "@eliotr/contracts";
import type {
  BundleIngestStatus,
  BundleIngestRecovery,
  CommitBundleUploadRequest,
  CompleteBundleFileRequest,
  CompleteBundleFileResult,
  OwnerApi,
  PrepareBundleUploadRequest,
  PrepareBundleUploadResult,
  UploadBundlePartRequest,
  UploadBundlePartResult,
} from "@eliotr/interfaces";
import {
  canonicalDigest,
  residencyKeyForManifest,
  type IngestAdmissionAuthority,
  type PreparedIngestOperation,
  type StagedBundlePort,
} from "@eliotr/platform-cloudflare";
import type { SourceAdmissionService } from "./source-admission-service.js";

export type IngestServiceErrorCode =
  | "INGEST_RECOVERY_INPUT_MISMATCH"
  | "INGEST_OPERATION_NOT_FOUND"
  | "INGEST_PRINCIPAL_DENIED"
  | "INGEST_SESSION_MISMATCH"
  | "INGEST_MANIFEST_MISMATCH"
  | "INGEST_STATE_INVALID"
  | "INGEST_STAGING_CONFLICT";

export class IngestServiceError extends Error {
  public readonly code: IngestServiceErrorCode;
  public readonly status: number;
  public readonly retryable: boolean;

  public constructor(
    code: IngestServiceErrorCode,
    status: number,
    message: string,
    retryable = false,
  ) {
    super(message);
    this.name = "IngestServiceError";
    this.code = code;
    this.status = status;
    this.retryable = retryable;
  }
}

export interface IngestServiceDependencies {
  readonly authority: IngestAdmissionAuthority;
  readonly stagedBundles: StagedBundlePort;
  readonly admission: SourceAdmissionService;
  readonly now?: () => number;
}

function requireOperation(
  operation: PreparedIngestOperation | null,
): asserts operation is PreparedIngestOperation {
  if (operation === null) {
    throw new IngestServiceError(
      "INGEST_OPERATION_NOT_FOUND",
      404,
      "ingest operation does not exist for this principal",
    );
  }
}

function requireSession(
  operation: PreparedIngestOperation,
  stagingSessionRef: string,
): void {
  if (operation.staging_session_ref !== stagingSessionRef) {
    throw new IngestServiceError(
      "INGEST_SESSION_MISMATCH",
      409,
      "ingest operation is bound to another staging session",
    );
  }
}

function status(operation: PreparedIngestOperation): BundleIngestStatus {
  return {
    operation_id: operation.operation_id,
    state: operation.state,
    source_revision_ref: operation.source_revision_ref,
    ...(operation.staging_session_ref === null
      ? {}
      : { staging_session_ref: operation.staging_session_ref }),
    ...(operation.qualification_report_ref === null
      ? {}
      : { qualification_report_ref: operation.qualification_report_ref }),
    ...(operation.decision_receipt_ref === null
      ? {}
      : { decision_receipt_ref: operation.decision_receipt_ref }),
    ...(operation.promotion_receipt_ref === null
      ? {}
      : { promotion_receipt_ref: operation.promotion_receipt_ref }),
    ...(operation.bundle_receipt === null ? {} : { receipt: operation.bundle_receipt }),
    expires_at: operation.expires_at,
    updated_at: operation.updated_at,
  };
}

function recovery(operation: PreparedIngestOperation): BundleIngestRecovery {
  return { protocol: "eliotr.ingest-recovery.v1", status: status(operation),
    idempotency_key: operation.idempotency_key, manifest_sha256: operation.manifest_sha256,
    total_bytes: operation.total_bytes, file_hashes: { ...operation.file_hashes } };
}

function duplicatePrepare(operation: PreparedIngestOperation): PrepareBundleUploadResult {
  if (operation.bundle_receipt === null) {
    throw new IngestServiceError(
      "INGEST_STATE_INVALID",
      409,
      "duplicate ingest operation has no terminal receipt",
    );
  }
  return {
    operation_id: operation.operation_id,
    manifest_sha256: operation.manifest_sha256,
    disposition: operation.bundle_receipt.decision === "ADMITTED" ||
      operation.bundle_receipt.decision === "DUPLICATE"
      ? "DUPLICATE"
      : "REJECTED",
    existing_receipt: operation.bundle_receipt,
    expires_at: operation.expires_at,
    reason_codes: operation.bundle_receipt.reason_codes,
  };
}

function terminalReceipt(
  operation: PreparedIngestOperation,
  decision: "QUARANTINED" | "REJECTED",
  reasonCodes: readonly string[],
  readbackSha256: string,
  committedAt: string,
): BundleAdmissionReceipt {
  return BundleAdmissionReceiptSchema.parse({
    operation_id: operation.operation_id,
    manifest_sha256: operation.manifest_sha256,
    source_revision_ref: operation.source_revision_ref,
    object_residency_key_digest: operation.residency_key_digest,
    decision,
    reason_codes: [...new Set(reasonCodes)].sort(),
    readback_sha256: readbackSha256,
    committed_at: committedAt,
  });
}

// IMPLEMENTED_NOT_LIVE: ER-14/ER-21/ER-29 ingest requires remote R2/D1/Queue receipts.
export function createIngestService(dependencies: IngestServiceDependencies): Pick<
  OwnerApi,
  "prepareBundle" | "uploadBundlePart" | "completeBundleFile" | "commitBundle" | "getBundleStatus" | "getBundleRecovery" | "discoverBundle"
> {
  const clock = dependencies.now ?? Date.now;
  return {
    async prepareBundle(context, request: PrepareBundleUploadRequest): Promise<PrepareBundleUploadResult> {
      const prepared = await dependencies.authority.prepare({
        principal_ref: context.principal_ref,
        origin_authentication_receipt_ref: context.credential_generation,
        idempotency_key: request.idempotency_key,
        manifest: request.manifest,
        file_hashes: request.file_hashes,
        total_bytes: request.total_bytes,
        residency_key: residencyKeyForManifest(request.manifest),
      });
      if (prepared.operation.bundle_receipt !== null) return duplicatePrepare(prepared.operation);
      const staged = await dependencies.stagedBundles.prepare({
        manifest: prepared.operation.manifest,
        residency_key: prepared.operation.residency_key,
        file_hashes: prepared.operation.file_hashes,
        total_bytes: prepared.operation.total_bytes,
        idempotency_scope: prepared.operation.principal_ref,
        idempotency_key: prepared.operation.idempotency_key,
      });
      if (staged.disposition === "ALREADY_ADMITTED") {
        throw new IngestServiceError(
          "INGEST_STAGING_CONFLICT",
          409,
          "staging reports prior admission without matching D1 authority",
        );
      }
      if (staged.disposition === "REJECTED" || staged.session === undefined) {
        return {
          operation_id: prepared.operation.operation_id,
          manifest_sha256: prepared.operation.manifest_sha256,
          disposition: "REJECTED",
          expires_at: prepared.operation.expires_at,
          reason_codes: staged.reason_codes,
        };
      }
      const operation = await dependencies.authority.bindStagingSession(
        prepared.operation.operation_id,
        staged.session.session_id,
      );
      return {
        operation_id: operation.operation_id,
        manifest_sha256: operation.manifest_sha256,
        disposition: "UPLOAD_REQUIRED",
        multipart_session_ref: staged.session.session_id,
        files: staged.session.uploads.map((upload) => ({
          path: upload.path,
          expected_sha256: upload.expected_sha256,
          max_part_bytes: staged.session?.part_size_bytes ?? 0,
        })),
        expires_at: staged.session.expires_at,
        reason_codes: staged.reason_codes,
      };
    },

    async uploadBundlePart(context, request: UploadBundlePartRequest): Promise<UploadBundlePartResult> {
      const operation = await dependencies.authority.loadForPrincipal(
        request.operation_id,
        context.principal_ref,
      );
      requireOperation(operation);
      requireSession(operation, request.multipart_session_ref);
      const receipt = await dependencies.stagedBundles.uploadPart({
        session_id: request.multipart_session_ref,
        path: request.path,
        part_number: request.part_number,
        size_bytes: request.size_bytes,
        final_part: request.final_part,
        body: request.body,
      });
      return {
        operation_id: operation.operation_id,
        multipart_session_ref: receipt.session_id,
        path: receipt.path,
        part_number: receipt.part_number,
        size_bytes: receipt.size_bytes,
        etag: receipt.etag,
      };
    },

    async completeBundleFile(context, request: CompleteBundleFileRequest): Promise<CompleteBundleFileResult> {
      const operation = await dependencies.authority.loadForPrincipal(
        request.operation_id,
        context.principal_ref,
      );
      requireOperation(operation);
      requireSession(operation, request.multipart_session_ref);
      const receipt = await dependencies.stagedBundles.completeFile(
        request.multipart_session_ref,
        request.path,
        request.parts,
      );
      return {
        operation_id: operation.operation_id,
        multipart_session_ref: receipt.session_id,
        path: receipt.path,
        sha256: receipt.sha256,
        size_bytes: receipt.size_bytes,
        etag: receipt.etag,
        completed_at: receipt.completed_at,
      };
    },

    async commitBundle(context, request: CommitBundleUploadRequest): Promise<BundleAdmissionReceipt> {
      let operation = await dependencies.authority.loadForPrincipal(
        request.operation_id,
        context.principal_ref,
      );
      requireOperation(operation);
      if (operation.bundle_receipt !== null) return operation.bundle_receipt;
      requireSession(operation, request.multipart_session_ref);
      if (request.manifest_sha256 !== operation.manifest_sha256) {
        throw new IngestServiceError(
          "INGEST_MANIFEST_MISMATCH",
          409,
          "commit manifest digest does not match prepared authority",
        );
      }
      const verification = await dependencies.stagedBundles.verifyReadback(
        request.multipart_session_ref,
      );
      const evaluated = await dependencies.admission.evaluate(operation, verification);
      operation = await dependencies.authority.recordQualificationDecision({
        operation_id: operation.operation_id,
        staging_session_ref: request.multipart_session_ref,
        qualification: evaluated.qualification,
        decision: evaluated.decision,
      });
      if (evaluated.decision.decision !== "ADMITTED") {
        const committedAt = new Date(clock()).toISOString();
        const readbackSha = await canonicalDigest({ verification, ...evaluated });
        return dependencies.authority.finalizeNonAdmitted(
          operation.operation_id,
          terminalReceipt(
            operation,
            evaluated.decision.decision,
            evaluated.decision.reason_codes,
            readbackSha,
            committedAt,
          ),
        );
      }
      const promotion = await dependencies.stagedBundles.promote(
        request.multipart_session_ref,
        evaluated.decision.decision_receipt_ref,
      );
      const receipt = BundleAdmissionReceiptSchema.parse({
        operation_id: operation.operation_id,
        manifest_sha256: operation.manifest_sha256,
        source_revision_ref: operation.source_revision_ref,
        normalized_artifact_ref: promotion.canonical_manifest_ref,
        object_residency_key_digest: operation.residency_key_digest,
        decision: "ADMITTED",
        reason_codes: evaluated.decision.reason_codes,
        readback_sha256: promotion.readback_digest,
        committed_at: promotion.promoted_at,
      });
      return dependencies.authority.commitAdmitted({
        operation_id: operation.operation_id,
        staging_session_ref: request.multipart_session_ref,
        promotion_receipt: promotion,
        bundle_receipt: receipt,
      });
    },

    async getBundleRecovery(context, operationId) {
      const operation = await dependencies.authority.loadForPrincipal(operationId, context.principal_ref);
      requireOperation(operation);
      // loadForPrincipal verifies the current owner and exact admission policy. No R2 effects,
      // copied credentials, new reservation, or authority inferred from the supplied operation ID.
      return recovery(operation);
    },

    async discoverBundle(context, request) {
      const operation = await dependencies.authority.loadBySourceRevisionForPrincipal(
        request.manifest.origin.source_revision_ref, context.principal_ref);
      requireOperation(operation);
      if (request.total_bytes !== operation.total_bytes ||
          await canonicalDigest(request.manifest) !== operation.manifest_sha256 ||
          await canonicalDigest(request.file_hashes) !== await canonicalDigest(operation.file_hashes)) {
        throw new IngestServiceError("INGEST_RECOVERY_INPUT_MISMATCH", 409,
          "The selected folder differs from the existing upload. No reservation or upload was created.");
      }
      // Re-read authorization after digest work; a withdrawal/expiry during discovery cannot
      // disclose a reservation key. The response is still not authority for subsequent writes.
      const current = await dependencies.authority.loadForPrincipal(operation.operation_id, context.principal_ref);
      requireOperation(current);
      if (current.input_fingerprint !== operation.input_fingerprint) {
        throw new IngestServiceError("INGEST_RECOVERY_INPUT_MISMATCH", 409, "The original reservation changed during discovery.");
      }
      return recovery(current);
    },

    async getBundleStatus(context, operationId) {
      const operation = await dependencies.authority.loadForPrincipal(
        operationId,
        context.principal_ref,
      );
      requireOperation(operation);
      return status(operation);
    },
  };
}
