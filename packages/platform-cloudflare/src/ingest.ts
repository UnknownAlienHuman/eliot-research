import {
  NormalizedBundleManifestSchema,
  ObjectResidencyKeySchema,
} from "@eliotr/contracts";
import {
  createR2EvidenceObjectStore,
  objectResidencyKeyDigest,
  sha256Utf8,
} from "./r2.js";
import {
  assertActive,
  loadSession,
  parseSession,
  promotionKey,
  publicSession,
  readImmutableJson,
  readPromotionReceipt,
  readTombstone,
  sessionKey,
  tombstoneKey,
  type StagingTombstone,
} from "./ingest-state.js";
import {
  abortMultipartUploads,
  cleanupSessionArtifacts,
  promotionAuthorization,
  writeImmutableJsonCandidate,
} from "./ingest-storage.js";
import {
  completeStagedFile,
  uploadStagedPart,
} from "./ingest-multipart.js";
import { promoteStagedSession } from "./ingest-promotion.js";
import { verifyStagedBundle } from "./ingest-verification.js";
import type {
  BundlePrepareInput,
  BundlePrepareResult,
  InternalStagedBundleSession,
  MultipartFileUploadSession,
  R2StagedBundleDependencies,
  StagedBundlePort,
  StagingCleanupReceipt,
} from "./ingest-types.js";
import {
  SESSION_PROTOCOL,
  TOMBSTONE_PROTOCOL,
  IngestStorageError,
  assertIdentifier,
  assertOpaqueToken,
  assertSafeInteger,
  canonicalJson,
  contentType,
  fail,
  iso,
  safeHashEntries,
  validateFileSet,
  validateResidency,
} from "./ingest-validation.js";

export { IngestStorageError, type IngestStorageErrorCode } from "./ingest-validation.js";
export type {
  BundlePrepareInput,
  BundlePrepareResult,
  BundlePromotionAuthorization,
  BundlePromotionReceipt,
  CompletedPart,
  MultipartFileUploadSession,
  MultipartUploadSession,
  PromotedObjectReceipt,
  R2StagedBundleDependencies,
  StagedBundlePort,
  StagedBundleVerification,
  StagedFileCompletionReceipt,
  StagingCleanupReceipt,
  UploadPartInput,
  UploadPartReceipt,
} from "./ingest-types.js";

const DEFAULT_PART_SIZE = 8 * 1024 * 1024;
const MIN_NONFINAL_PART_SIZE = 5 * 1024 * 1024;
const DEFAULT_SESSION_TTL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_MAX_FILES = 128;
const DEFAULT_MAX_TOTAL_BYTES = 5 * 1024 * 1024 * 1024;
const HARD_MAX_TOTAL_BYTES = 50 * 1024 * 1024 * 1024;
const MAX_SESSION_DOCUMENT_BYTES = 1024 * 1024;

interface ParsedPrepareInput {
  readonly manifest: ReturnType<typeof NormalizedBundleManifestSchema.parse>;
  readonly residency: ReturnType<typeof ObjectResidencyKeySchema.parse>;
  readonly files: ReturnType<typeof safeHashEntries>;
  readonly total_bytes: number;
  readonly idempotency_scope: string;
  readonly idempotency_key: string;
}

function parsePrepareInput(
  input: BundlePrepareInput,
  maxFiles: number,
  maxTotalBytes: number,
): ParsedPrepareInput {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    fail("BUNDLE_INPUT_INVALID", "bundle prepare input must be an object");
  }
  try {
    const manifest = NormalizedBundleManifestSchema.parse(input.manifest);
    const residency = ObjectResidencyKeySchema.parse(input.residency_key);
    assertIdentifier(input.idempotency_scope, "idempotency_scope");
    assertIdentifier(input.idempotency_key, "idempotency_key");
    assertSafeInteger(input.total_bytes, "total_bytes", 1, maxTotalBytes);
    const files = safeHashEntries(input.file_hashes, maxFiles);
    validateFileSet(manifest, files);
    validateResidency(manifest, residency);
    return {
      manifest,
      residency,
      files,
      total_bytes: input.total_bytes,
      idempotency_scope: input.idempotency_scope,
      idempotency_key: input.idempotency_key,
    };
  } catch (error) {
    if (error instanceof IngestStorageError) throw error;
    fail("BUNDLE_INPUT_INVALID", "bundle prepare input failed strict schema validation", false, error);
  }
}

async function createMultipartUploads(
  bucket: R2Bucket,
  sessionId: string,
  prefix: string,
  files: ParsedPrepareInput["files"],
): Promise<MultipartFileUploadSession[]> {
  const uploads: MultipartFileUploadSession[] = [];
  try {
    for (const file of files) {
      const key = `${prefix}/files/${file.path}`;
      const upload = await bucket.createMultipartUpload(key, {
        httpMetadata: { contentType: contentType(file.path) },
        customMetadata: {
          eliotr_session_id: sessionId,
          eliotr_logical_path_sha256: await sha256Utf8(file.path),
          eliotr_expected_sha256: file.sha256,
        },
      });
      assertOpaqueToken(upload.uploadId, "multipart upload_id");
      uploads.push({
        path: file.path,
        staging_key: key,
        upload_id: upload.uploadId,
        expected_sha256: file.sha256,
      });
    }
    return uploads;
  } catch (error) {
    await abortMultipartUploads(bucket, uploads);
    throw error;
  }
}

export function createR2StagedBundlePort(
  dependencies: R2StagedBundleDependencies,
): StagedBundlePort {
  if (typeof dependencies.authorize_promotion !== "function") {
    fail(
      "PROMOTION_NOT_AUTHORIZED",
      "staging promotion requires an explicit admission-authority verifier",
    );
  }
  const work = dependencies.work_bucket;
  const evidence = dependencies.evidence_store ?? createR2EvidenceObjectStore(
    dependencies.evidence_bucket,
    dependencies.create_sha256_sink === undefined
      ? {}
      : { createSha256Sink: dependencies.create_sha256_sink },
  );
  const now = dependencies.now ?? Date.now;
  const sessionTtl = dependencies.session_ttl_ms ?? DEFAULT_SESSION_TTL_MS;
  const partSize = dependencies.part_size_bytes ?? DEFAULT_PART_SIZE;
  const maxFiles = dependencies.max_files ?? DEFAULT_MAX_FILES;
  const maxTotalBytes = dependencies.max_total_bytes ?? DEFAULT_MAX_TOTAL_BYTES;
  assertSafeInteger(sessionTtl, "session_ttl_ms", 60_000, 7 * 24 * 60 * 60 * 1000);
  assertSafeInteger(partSize, "part_size_bytes", MIN_NONFINAL_PART_SIZE, 256 * 1024 * 1024);
  assertSafeInteger(maxFiles, "max_files", 3, 1024);
  assertSafeInteger(maxTotalBytes, "max_total_bytes", 1, HARD_MAX_TOTAL_BYTES);

  const port: StagedBundlePort = {
    async prepare(rawInput): Promise<BundlePrepareResult> {
      const input = parsePrepareInput(rawInput, maxFiles, maxTotalBytes);
      const admitted = await dependencies.find_existing_admission?.(
        input.idempotency_scope,
        input.idempotency_key,
      ) ?? null;
      if (admitted !== null) {
        return { disposition: "ALREADY_ADMITTED", existing_receipt: admitted, reason_codes: [] };
      }

      const identity = await sha256Utf8(
        `${input.idempotency_scope}\u0000${input.idempotency_key}`,
      );
      const sessionId = `session-${identity}`;
      if (await readPromotionReceipt(work, sessionId) !== null) {
        return { disposition: "REJECTED", reason_codes: ["ALREADY_PROMOTED"] };
      }
      if (await readTombstone(work, sessionId) !== null) {
        return { disposition: "REJECTED", reason_codes: ["IDEMPOTENCY_ABORTED"] };
      }

      const residencyDigest = await objectResidencyKeyDigest(input.residency);
      const fingerprint = await sha256Utf8(canonicalJson({
        manifest: input.manifest,
        residency_key: input.residency,
        file_hashes: input.files,
        total_bytes: input.total_bytes,
      }));
      if (await readImmutableJson(work, sessionKey(sessionId), MAX_SESSION_DOCUMENT_BYTES) !== null) {
        const session = await loadSession(work, sessionId);
        if (session.input_fingerprint !== fingerprint) {
          fail(
            "STAGING_SESSION_CONFLICT",
            "idempotency identity is already bound to different bundle input",
          );
        }
        assertActive(session, now());
        return {
          disposition: "UPLOAD_REQUIRED",
          session: publicSession(session),
          reason_codes: ["RESUMED"],
        };
      }

      const prefix = `staging/session/${sessionId}`;
      const uploads = await createMultipartUploads(work, sessionId, prefix, input.files);
      try {
        const createdAt = now();
        const candidate: InternalStagedBundleSession = {
          protocol: SESSION_PROTOCOL,
          session_id: sessionId,
          staging_prefix: prefix,
          created_at: iso(createdAt),
          expires_at: iso(createdAt + sessionTtl),
          idempotency_scope: input.idempotency_scope,
          idempotency_key: input.idempotency_key,
          input_fingerprint: fingerprint,
          part_size_bytes: partSize,
          total_bytes: input.total_bytes,
          residency_key_digest: residencyDigest,
          residency_key: input.residency,
          manifest: input.manifest,
          file_hashes: input.files,
          uploads,
        };
        const result = await writeImmutableJsonCandidate(
          work,
          sessionKey(sessionId),
          candidate,
          MAX_SESSION_DOCUMENT_BYTES,
        );
        const winner = await loadSession(work, sessionId);
        if (winner.input_fingerprint !== fingerprint) {
          await abortMultipartUploads(work, uploads);
          fail(
            "STAGING_SESSION_CONFLICT",
            "concurrent prepare bound idempotency to different input",
          );
        }
        if (canonicalJson(winner.uploads) !== canonicalJson(candidate.uploads)) {
          await abortMultipartUploads(work, uploads);
        }
        return {
          disposition: "UPLOAD_REQUIRED",
          session: publicSession(winner),
          reason_codes: result.created
            ? []
            : result.recovered_after_write_error
              ? ["READBACK_RECOVERED"]
              : ["CONCURRENT_RESUME"],
        };
      } catch (error) {
        await abortMultipartUploads(work, uploads);
        throw error;
      }
    },

    async uploadPart(input) {
      const session = await loadSession(work, input.session_id);
      assertActive(session, now());
      return uploadStagedPart(work, session, input);
    },

    async completeFile(sessionId, path, parts) {
      const session = await loadSession(work, sessionId);
      assertActive(session, now());
      return completeStagedFile({
        bucket: work,
        session,
        path,
        parts,
        now,
        ...(dependencies.create_sha256_sink === undefined
          ? {}
          : { create_sha256_sink: dependencies.create_sha256_sink }),
      });
    },

    async verifyReadback(sessionId) {
      const session = await loadSession(work, sessionId);
      assertActive(session, now());
      return verifyStagedBundle({
        bucket: work,
        session,
        ...(dependencies.create_sha256_sink === undefined
          ? {}
          : { create_sha256_sink: dependencies.create_sha256_sink }),
      });
    },

    async promote(sessionId, admissionReceiptRef) {
      assertIdentifier(sessionId, "session_id");
      assertIdentifier(admissionReceiptRef, "admissionReceiptRef");
      const terminal = await readPromotionReceipt(work, sessionId, admissionReceiptRef);
      if (terminal !== null) return terminal;
      const session = await loadSession(work, sessionId);
      assertActive(session, now());
      if (!await dependencies.authorize_promotion(
        promotionAuthorization(session),
        admissionReceiptRef,
      )) {
        fail(
          "PROMOTION_NOT_AUTHORIZED",
          "admission authority did not authorize staging promotion",
        );
      }
      return promoteStagedSession({
        work_bucket: work,
        evidence_store: evidence,
        session,
        admission_receipt_ref: admissionReceiptRef,
        now,
        ...(dependencies.create_sha256_sink === undefined
          ? {}
          : { create_sha256_sink: dependencies.create_sha256_sink }),
      });
    },

    async abort(sessionId, reasonCode): Promise<void> {
      assertIdentifier(sessionId, "session_id");
      assertIdentifier(reasonCode, "reasonCode");
      if (await readPromotionReceipt(work, sessionId) !== null) {
        fail("STAGING_STATE_CONFLICT", "promoted staging session cannot be aborted");
      }
      const existingTombstone = await readTombstone(work, sessionId);
      const rawSession = await readImmutableJson(
        work,
        sessionKey(sessionId),
        MAX_SESSION_DOCUMENT_BYTES,
      );
      if (rawSession === null) {
        if (existingTombstone !== null) return;
        fail("STAGING_SESSION_NOT_FOUND", `staging session ${sessionId} does not exist`);
      }
      const session = parseSession(rawSession, sessionId);
      let tombstone: StagingTombstone;
      if (existingTombstone === null) {
        const candidate: StagingTombstone = {
          protocol: TOMBSTONE_PROTOCOL,
          session_id: sessionId,
          input_fingerprint: session.input_fingerprint,
          reason_code: reasonCode,
          aborted_at: iso(now()),
        };
        await writeImmutableJsonCandidate(
          work,
          tombstoneKey(sessionId),
          candidate,
          64 * 1024,
        );
        const winner = await readTombstone(work, sessionId);
        if (winner === null) {
          fail("STAGING_STATE_CONFLICT", "staging tombstone is missing after publication", true);
        }
        tombstone = winner;
      } else {
        tombstone = existingTombstone;
      }
      if (tombstone.input_fingerprint !== session.input_fingerprint) {
        fail("STAGING_SESSION_CORRUPT", "staging tombstone is bound to another input fingerprint");
      }
      await cleanupSessionArtifacts(work, session);
    },

    async cleanupExpired(limit): Promise<StagingCleanupReceipt> {
      assertSafeInteger(limit, "cleanup limit", 1, 1000);
      let cursor: string | undefined;
      let scanned = 0;
      let aborted = 0;
      let cleanedPromoted = 0;
      let resumedAborted = 0;
      let skipped = 0;
      while (scanned < limit) {
        const page = await work.list({
          prefix: "staging/session/",
          delimiter: "/",
          limit: Math.min(1000, limit - scanned),
          ...(cursor === undefined ? {} : { cursor }),
        });
        for (const prefix of page.delimitedPrefixes ?? []) {
          if (scanned >= limit) break;
          scanned += 1;
          const sessionId = prefix.split("/").filter(Boolean).at(-1);
          if (sessionId === undefined) {
            skipped += 1;
            continue;
          }
          try {
            const session = await loadSession(work, sessionId);
            if (await readPromotionReceipt(work, sessionId, undefined, session) !== null) {
              await cleanupSessionArtifacts(work, session);
              cleanedPromoted += 1;
              continue;
            }
            const tombstone = await readTombstone(work, sessionId);
            if (tombstone !== null) {
              if (tombstone.input_fingerprint !== session.input_fingerprint) {
                fail("STAGING_SESSION_CORRUPT", "staging tombstone fingerprint mismatch");
              }
              await cleanupSessionArtifacts(work, session);
              resumedAborted += 1;
              continue;
            }
            if (Date.parse(session.expires_at) <= now()) {
              await port.abort(sessionId, "SESSION_EXPIRED");
              aborted += 1;
            } else {
              skipped += 1;
            }
          } catch {
            skipped += 1;
          }
        }
        if (!page.truncated || page.cursor === undefined) break;
        cursor = page.cursor;
      }
      return {
        scanned_sessions: scanned,
        aborted_sessions: aborted,
        cleaned_promoted_sessions: cleanedPromoted,
        resumed_aborted_sessions: resumedAborted,
        skipped_sessions: skipped,
      };
    },
  };
  return port;
}
