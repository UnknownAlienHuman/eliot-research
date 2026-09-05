import { hashReadableStream, type Sha256DigestSinkFactory } from "./r2.js";
import {
  completionKey,
  readCompletionReceipt,
} from "./ingest-state.js";
import {
  assertStagingObject,
  writeImmutableJsonCandidate,
} from "./ingest-storage.js";
import type {
  CompletedPart,
  InternalStagedBundleSession,
  StagedFileCompletionReceipt,
  UploadPartInput,
  UploadPartReceipt,
} from "./ingest-types.js";
import {
  COMPLETION_PROTOCOL,
  IngestStorageError,
  assertOpaqueToken,
  assertPath,
  assertSafeInteger,
  exactSizeStream,
  fail,
  iso,
} from "./ingest-validation.js";

const MAX_PARTS_PER_FILE = 10_000;
const MAX_COMPLETION_RECEIPT_BYTES = 64 * 1024;

function findUpload(session: InternalStagedBundleSession, path: string) {
  const upload = session.uploads.find((candidate) => candidate.path === path);
  if (upload === undefined) {
    fail("STAGING_FILE_UNKNOWN", `bundle path ${path} is not part of the prepared session`);
  }
  return upload;
}

function validateCompletedParts(
  session: InternalStagedBundleSession,
  parts: readonly CompletedPart[],
): { readonly size: number; readonly uploadedParts: R2UploadedPart[] } {
  if (parts.length < 1 || parts.length > MAX_PARTS_PER_FILE) {
    fail("STAGING_PART_INVALID", "completed multipart list is empty or too large");
  }
  let declaredSize = 0;
  const uploadedParts = parts.map((part, index) => {
    assertSafeInteger(part.part_number, "part_number", 1, MAX_PARTS_PER_FILE);
    if (part.part_number !== index + 1) {
      fail("STAGING_PART_INVALID", "multipart parts must be contiguous and ordered from one");
    }
    const final = index === parts.length - 1;
    assertSafeInteger(
      part.size_bytes,
      "part size",
      final ? 1 : session.part_size_bytes,
      session.part_size_bytes,
    );
    if (!final && part.size_bytes !== session.part_size_bytes) {
      fail("STAGING_PART_INVALID", "non-final multipart part size does not match the session");
    }
    try {
      assertOpaqueToken(part.etag, "multipart ETag");
    } catch (error) {
      fail("STAGING_PART_INVALID", "multipart ETag is invalid", false, error);
    }
    declaredSize += part.size_bytes;
    if (!Number.isSafeInteger(declaredSize) || declaredSize > session.total_bytes) {
      fail("STAGING_PART_INVALID", "multipart file size exceeds the prepared bundle envelope");
    }
    return { partNumber: part.part_number, etag: part.etag };
  });
  return { size: declaredSize, uploadedParts };
}

export async function uploadStagedPart(
  bucket: R2Bucket,
  session: InternalStagedBundleSession,
  input: UploadPartInput,
): Promise<UploadPartReceipt> {
  assertPath(input.path);
  assertSafeInteger(input.part_number, "part_number", 1, MAX_PARTS_PER_FILE);
  assertSafeInteger(
    input.size_bytes,
    "size_bytes",
    input.final_part ? 1 : session.part_size_bytes,
    session.part_size_bytes,
  );
  if (!input.final_part && input.size_bytes !== session.part_size_bytes) {
    fail("STAGING_PART_INVALID", "non-final multipart part must equal the negotiated part size");
  }
  const upload = findUpload(session, input.path);
  if (await readCompletionReceipt(bucket, session, input.path) !== null) {
    fail("STAGING_STATE_CONFLICT", `staging file ${input.path} is already completed`);
  }

  // Validation transforms lose the runtime's known-length marker. R2 requires it even
  // for a bounded input; do not buffer the entire part to work around this boundary.
  const checked = exactSizeStream(input.body, input.size_bytes);
  const fixed = typeof FixedLengthStream === "function"
    ? new FixedLengthStream(input.size_bytes) : undefined;
  const controller = new AbortController();
  let uploaded: R2UploadedPart;
  try {
    const pumping = fixed === undefined ? Promise.resolve()
      : checked.pipeTo(fixed.writable, { signal: controller.signal });
    [uploaded] = await Promise.all([
      Promise.resolve().then(() => bucket.resumeMultipartUpload(upload.staging_key, upload.upload_id)
        .uploadPart(input.part_number, fixed?.readable ?? checked)),
      pumping,
    ]);
  } catch (error) {
    if (error instanceof IngestStorageError) throw error;
    fail("STAGING_STATE_CONFLICT", `multipart upload for ${input.path} failed`, true, error);
  } finally {
    controller.abort();
  }
  if (uploaded.partNumber !== input.part_number) {
    fail("STAGING_PART_INVALID", "R2 returned a multipart part-number mismatch");
  }
  try {
    assertOpaqueToken(uploaded.etag, "multipart ETag");
  } catch (error) {
    fail("STAGING_PART_INVALID", "R2 returned an invalid multipart ETag", false, error);
  }
  return {
    session_id: session.session_id,
    path: input.path,
    part_number: input.part_number,
    size_bytes: input.size_bytes,
    etag: uploaded.etag,
  };
}

export async function completeStagedFile(input: {
  readonly bucket: R2Bucket;
  readonly session: InternalStagedBundleSession;
  readonly path: string;
  readonly parts: readonly CompletedPart[];
  readonly now: () => number;
  readonly create_sha256_sink?: Sha256DigestSinkFactory;
}): Promise<StagedFileCompletionReceipt> {
  const { bucket, session } = input;
  assertPath(input.path);
  const upload = findUpload(session, input.path);
  const prior = await readCompletionReceipt(bucket, session, input.path);
  let expectedSize: number;
  let object = await bucket.get(upload.staging_key);

  if (prior !== null) {
    expectedSize = prior.size_bytes;
  } else {
    const completed = validateCompletedParts(session, input.parts);
    expectedSize = completed.size;
    if (object === null) {
      try {
        await bucket.resumeMultipartUpload(upload.staging_key, upload.upload_id)
          .complete(completed.uploadedParts);
      } catch (error) {
        object = await bucket.get(upload.staging_key);
        if (object === null) {
          fail(
            "STAGING_STATE_CONFLICT",
            `multipart completion for ${input.path} failed without readable output`,
            true,
            error,
          );
        }
      }
      object ??= await bucket.get(upload.staging_key);
    }
  }

  if (object === null) {
    fail("STAGING_FILE_INTEGRITY_FAILURE", `completed staging file ${input.path} is missing`);
  }
  await assertStagingObject(object, session, upload, expectedSize);
  const hash = await hashReadableStream(object.body, expectedSize, input.create_sha256_sink);
  if (hash.sha256 !== upload.expected_sha256 || hash.size_bytes !== expectedSize) {
    await bucket.delete(upload.staging_key);
    fail("STAGING_FILE_INTEGRITY_FAILURE", `staging file ${input.path} failed SHA-256 readback`);
  }

  if (prior !== null) {
    if (prior.sha256 !== hash.sha256 || prior.size_bytes !== hash.size_bytes || prior.etag !== object.etag) {
      fail("STAGING_SESSION_CORRUPT", `completion receipt for ${input.path} disagrees with staged bytes`);
    }
    return prior;
  }

  const candidate: StagedFileCompletionReceipt = {
    protocol: COMPLETION_PROTOCOL,
    session_id: session.session_id,
    path: input.path,
    sha256: hash.sha256,
    size_bytes: hash.size_bytes,
    etag: object.etag,
    completed_at: iso(input.now()),
  };
  await writeImmutableJsonCandidate(
    bucket,
    await completionKey(session.session_id, input.path),
    candidate,
    MAX_COMPLETION_RECEIPT_BYTES,
  );
  const winner = await readCompletionReceipt(bucket, session, input.path);
  if (
    winner === null ||
    winner.sha256 !== hash.sha256 ||
    winner.size_bytes !== hash.size_bytes ||
    winner.etag !== object.etag
  ) {
    fail("STAGING_STATE_CONFLICT", `completion receipt race for ${input.path} disagreed with staged bytes`);
  }
  return winner;
}
