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
export async function readWorkflowObject(bucket: R2Bucket, expected: WorkflowObject, immutable = false): Promise<Uint8Array> {
  if (!WorkflowObjectSchema.safeParse(expected).success) fail("WORKFLOW_INPUT_INVALID");
  const head = await bucket.head(expected.object_ref).catch(() => fail("WORKFLOW_OUTPUT_UNAVAILABLE"));
  if (head === null) fail("WORKFLOW_OUTPUT_UNAVAILABLE");
  if (!matches(head, expected, immutable)) fail("WORKFLOW_OUTPUT_CORRUPT");
  const object = await bucket.get(expected.object_ref, { onlyIf: { etagMatches: head.etag } })
    .catch(() => fail("WORKFLOW_OUTPUT_UNAVAILABLE"));
  if (object === null) fail("WORKFLOW_OUTPUT_UNAVAILABLE");
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
    fail("WORKFLOW_OUTPUT_UNAVAILABLE");
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
