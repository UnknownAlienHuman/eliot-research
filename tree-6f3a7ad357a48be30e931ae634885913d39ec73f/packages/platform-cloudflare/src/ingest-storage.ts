import { sha256Utf8 } from "./r2.js";
import { completionKey, readImmutableJson, sessionKey } from "./ingest-state.js";
import type {
  BundlePromotionAuthorization,
  InternalStagedBundleSession,
  MultipartFileUploadSession,
} from "./ingest-types.js";
import {
  assertOpaqueToken,
  canonicalJson,
  contentType,
  fail,
  utf8Bytes,
} from "./ingest-validation.js";

export interface ImmutableJsonReadback {
  readonly created: boolean;
  readonly recovered_after_write_error: boolean;
  readonly value: unknown;
}

function sameEntries(
  left: Readonly<Record<string, string>> | undefined,
  right: Readonly<Record<string, string>>,
): boolean {
  const actual = Object.entries(left ?? {}).sort(([a], [b]) => a.localeCompare(b));
  const expected = Object.entries(right).sort(([a], [b]) => a.localeCompare(b));
  return JSON.stringify(actual) === JSON.stringify(expected);
}

export async function writeImmutableJsonCandidate(
  bucket: R2Bucket,
  key: string,
  value: unknown,
  maximumBytes: number,
): Promise<ImmutableJsonReadback> {
  const text = canonicalJson(value);
  if (utf8Bytes(text) > maximumBytes) {
    fail("STAGING_STATE_CONFLICT", `${key} exceeds its immutable JSON byte limit`);
  }
  const digest = await sha256Utf8(text);
  let created = false;
  let writeError: unknown;
  try {
    created = await bucket.put(key, text, {
      onlyIf: { etagDoesNotMatch: "*" },
      sha256: digest,
      httpMetadata: { contentType: "application/json; charset=utf-8" },
      customMetadata: { eliotr_sha256: digest, eliotr_immutable: "true" },
    }) !== null;
  } catch (error) {
    writeError = error;
  }

  let winner: unknown | null;
  try {
    winner = await readImmutableJson(bucket, key, maximumBytes);
  } catch (readError) {
    fail(
      "STAGING_STATE_CONFLICT",
      `${key} write completed ambiguously and immutable readback failed`,
      true,
      { write_error: writeError, read_error: readError },
    );
  }
  if (winner === null) {
    fail(
      "STAGING_STATE_CONFLICT",
      `${key} has no immutable winner after conditional write`,
      true,
      writeError,
    );
  }
  return {
    created,
    recovered_after_write_error: writeError !== undefined,
    value: winner,
  };
}

export async function abortMultipartUploads(
  bucket: R2Bucket,
  uploads: readonly MultipartFileUploadSession[],
): Promise<void> {
  await Promise.all(uploads.map(async (upload) => {
    try {
      await bucket.resumeMultipartUpload(upload.staging_key, upload.upload_id).abort();
    } catch {
      // Completed or already-aborted uploads are reconciled by object cleanup/readback.
    }
  }));
}

export async function cleanupSessionArtifacts(
  bucket: R2Bucket,
  session: InternalStagedBundleSession,
): Promise<void> {
  await abortMultipartUploads(bucket, session.uploads);
  const keys = [
    ...session.uploads.map((upload) => upload.staging_key),
    ...await Promise.all(session.uploads.map((upload) =>
      completionKey(session.session_id, upload.path))),
    sessionKey(session.session_id),
  ];
  try {
    for (let index = 0; index < keys.length; index += 1000) {
      await bucket.delete(keys.slice(index, index + 1000));
    }
    for (let index = 0; index < keys.length; index += 32) {
      const remaining = await Promise.all(
        keys.slice(index, index + 32).map((key) => bucket.head(key)),
      );
      if (remaining.some((object) => object !== null)) {
        fail(
          "STAGING_CLEANUP_FAILED",
          `staging cleanup for ${session.session_id} failed readback`,
          true,
        );
      }
    }
  } catch (error) {
    if (error instanceof Error && error.name === "IngestStorageError") throw error;
    fail(
      "STAGING_CLEANUP_FAILED",
      `staging cleanup for ${session.session_id} failed`,
      true,
      error,
    );
  }
}

export async function assertStagingObject(
  object: R2ObjectBody,
  session: InternalStagedBundleSession,
  upload: MultipartFileUploadSession,
  expectedSize: number,
): Promise<void> {
  if (object.size !== expectedSize) {
    fail(
      "STAGING_FILE_INTEGRITY_FAILURE",
      `staging file ${upload.path} size disagrees with the completion envelope`,
    );
  }
  try {
    assertOpaqueToken(object.etag, `staging file ${upload.path} ETag`);
  } catch (error) {
    fail(
      "STAGING_FILE_INTEGRITY_FAILURE",
      `staging file ${upload.path} has an invalid ETag`,
      false,
      error,
    );
  }
  const expectedMetadata = {
    eliotr_session_id: session.session_id,
    eliotr_logical_path_sha256: await sha256Utf8(upload.path),
    eliotr_expected_sha256: upload.expected_sha256,
  };
  if (
    object.httpMetadata?.contentType !== contentType(upload.path) ||
    !sameEntries(object.customMetadata, expectedMetadata)
  ) {
    fail(
      "STAGING_FILE_INTEGRITY_FAILURE",
      `staging file ${upload.path} metadata or media type changed after prepare`,
    );
  }
}

export function promotionAuthorization(
  session: InternalStagedBundleSession,
): BundlePromotionAuthorization {
  return {
    session_id: session.session_id,
    input_fingerprint: session.input_fingerprint,
    residency_key_digest: session.residency_key_digest,
    owner_system_id: session.manifest.origin.owner_system_id,
    source_namespace_id: session.manifest.origin.source_namespace_id,
    source_owner_generation: session.manifest.origin.source_owner_generation,
    source_revision_ref: session.manifest.origin.source_revision_ref,
  };
}
