import { serializeObjectResidencyKey } from "@eliotr/domain";
import { readStreamWithinBytes, RuntimeLimitError } from "@eliotr/platform-cloudflare";
import {
  digest, fail, WorkflowCheckpointError, WorkflowObjectSchema,
  type WorkflowObject,
} from "./types.js";

function checksum(object: R2Object): string | null {
  const value = object.checksums.sha256;
  return value === undefined ? null : Array.from(new Uint8Array(value), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
function matches(object: R2Object, expected: WorkflowObject, immutable: boolean): boolean {
  return object.key === expected.object_ref && object.size === expected.byte_length && checksum(object) === expected.sha256 &&
    (!immutable || (object.customMetadata?.immutable === "true" &&
      object.customMetadata.residency === serializeObjectResidencyKey(expected.residency)));
}
function readUnavailable(expected: WorkflowObject, phase: "HEAD" | "GET" | "BODY", cause?: unknown): never {
  let reason = cause === undefined ? "OBJECT_MISSING" : "READ_FAILED";
  try {
    const message = cause instanceof Error ? cause.message : "";
    if (/too many subrequests|subrequest.*(?:limit|exceed)/iu.test(message)) reason = "SUBREQUEST_LIMIT";
    else if (/request context|I\/O context|different request|context has ended/iu.test(message)) reason = "REQUEST_CONTEXT";
    else if (/network|connection|timeout|timed out|temporarily unavailable/iu.test(message)) reason = "UPSTREAM_UNAVAILABLE";
  } catch { /* Diagnostic classification never changes the original read failure. */ }
  // Do not log raw exceptions, source bytes, object keys, or credentials.
  console.warn(JSON.stringify({ event: "workflow_object_read_unavailable", phase, reason,
    content_sha256: expected.sha256, expected_bytes: expected.byte_length }));
  return fail("WORKFLOW_OUTPUT_UNAVAILABLE");
}
export async function readWorkflowObject(bucket: R2Bucket, expected: WorkflowObject, immutable = false): Promise<Uint8Array> {
  if (!WorkflowObjectSchema.safeParse(expected).success) fail("WORKFLOW_INPUT_INVALID");
  const head = await bucket.head(expected.object_ref).catch((cause: unknown) => readUnavailable(expected, "HEAD", cause));
  if (head === null) readUnavailable(expected, "HEAD");
  if (!matches(head, expected, immutable)) fail("WORKFLOW_OUTPUT_CORRUPT");
  const object = await bucket.get(expected.object_ref, { onlyIf: { etagMatches: head.etag } })
    .catch((cause: unknown) => readUnavailable(expected, "GET", cause));
  if (object === null) readUnavailable(expected, "GET");
  if (!("body" in object) || !matches(object, expected, immutable)) fail("WORKFLOW_OUTPUT_CORRUPT");
  let bytes: Uint8Array;
  try {
    bytes = await readStreamWithinBytes(object.body, {
      label: "workflow.output.object",
      max_bytes: Math.max(expected.byte_length, 1),
      max_chunks: 4096,
    });
  } catch (error) {
    if (error instanceof RuntimeLimitError) {
      switch (error.code) {
        case "LIMIT_EXCEEDED":
        case "STREAM_CHUNK_LIMIT_EXCEEDED":
        case "STREAM_CHUNK_INVALID":
          fail("WORKFLOW_OUTPUT_CORRUPT");
      }
    }
    if (error instanceof WorkflowCheckpointError) throw error;
    readUnavailable(expected, "BODY", error);
  }
  if (bytes.byteLength !== expected.byte_length) fail("WORKFLOW_OUTPUT_CORRUPT");
  if (await digest(bytes) !== expected.sha256) fail("WORKFLOW_OUTPUT_CORRUPT");
  return bytes;
}

/** The D1 output intent MUST exist before this call. A lost PUT ACK never means repeat a model. */
export async function writeWorkflowObject(bucket: R2Bucket, expected: WorkflowObject, bytes: Uint8Array): Promise<void> {
  if (bytes.byteLength !== expected.byte_length || await digest(bytes) !== expected.sha256) fail("WORKFLOW_OUTPUT_CORRUPT");
  try {
    await bucket.put(expected.object_ref, bytes, {
      onlyIf: { etagDoesNotMatch: "*" }, sha256: expected.sha256,
      customMetadata: { residency: serializeObjectResidencyKey(expected.residency), immutable: "true" },
    });
  } catch {
    // Both a lost ACK and a conditional-write conflict require independent exact readback.
  }
  await readWorkflowObject(bucket, expected, true);
}
