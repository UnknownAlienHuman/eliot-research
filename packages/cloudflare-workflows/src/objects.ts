import { serializeObjectResidencyKey } from "@eliotr/domain";
import {
  digest, fail, MAX_WORKFLOW_OUTPUT_BYTES, WorkflowCheckpointError, WorkflowObjectSchema,
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
  const reader = object.body.getReader();
  const bytes = new Uint8Array(expected.byte_length);
  let length = 0;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      length += part.value.byteLength;
      if (length > expected.byte_length || length > MAX_WORKFLOW_OUTPUT_BYTES) {
        await reader.cancel();
        fail("WORKFLOW_OUTPUT_CORRUPT");
      }
      bytes.set(part.value, length - part.value.byteLength);
    }
  } catch (error) {
    if (error instanceof WorkflowCheckpointError) throw error;
    fail("WORKFLOW_OUTPUT_UNAVAILABLE");
  } finally { reader.releaseLock(); }
  if (length !== expected.byte_length) fail("WORKFLOW_OUTPUT_CORRUPT");
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
