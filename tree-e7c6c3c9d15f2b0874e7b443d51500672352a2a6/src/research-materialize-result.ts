import { IdentifierSchema, Sha256Schema, VersionedRefSchema, type VersionedRef } from "@eliotr/contracts";
import { canonicalEvidenceJson, evidenceSha256Bytes } from "@eliotr/cloudflare-evidence";
import { RUNTIME_LIMITS, assertWithinBytes } from "@eliotr/platform-cloudflare";
import type { PrepareArtifactDraftResult } from "./artifact-draft-types.js";
<<<<<<< HEAD
=======
import { materializeResearchArtifactDraft, type ResearchArtifactDraftMaterializationInput } from "./research-artifact-draft.js";
>>>>>>> b27dc136cbba12e13064d131d02dabb46f8dfae6
import type { ResearchSynthesisOutputReadback } from "./research-synthesis-output-reader.js";

const PROTOCOL = "eliotr.research.materialize-result.v1" as const;
const STAGE = "MATERIALIZE" as const;
const REF = /^[A-Za-z0-9][A-Za-z0-9:._/@-]{0,255}$/u;

export type ResearchMaterializeResultErrorCode =
  | "MATERIALIZE_RESULT_INPUT_INVALID"
  | "MATERIALIZE_RESULT_CORRUPT";

export class ResearchMaterializeResultError extends Error {
  public readonly code: ResearchMaterializeResultErrorCode;

  public constructor(code: ResearchMaterializeResultErrorCode, message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "ResearchMaterializeResultError";
    this.code = code;
  }
}

export interface ResearchMaterializeResultPayload {
  readonly protocol: typeof PROTOCOL;
  readonly operation_id: string;
  readonly stage: typeof STAGE;
  readonly stage_attempt_ref: string;
  readonly stage_request_sha256: string;
  readonly synthesis: {
    readonly stage_attempt_ref: string;
    readonly stage_request_sha256: string;
    readonly output_object_ref: string;
    readonly output_sha256: string;
  };
  readonly draft: {
    readonly artifact_ref: VersionedRef;
    readonly manifest: {
      readonly key: string;
      readonly sha256: string;
      readonly size_bytes: number;
    };
  };
}

export interface ResearchMaterializeResultInput {
  /** The server-created MATERIALIZE workflow operation and stage attempt. */
  readonly operation_id: string;
  readonly stage_attempt_ref: string;
  readonly stage_request_sha256: string;
  /** Committed W2 SYNTHESIZE readback; output identity is never caller supplied. */
  readonly synthesis_readback: ResearchSynthesisOutputReadback;
  /** The result returned by the actual DRAFT prepare transaction. */
  readonly draft_result: PrepareArtifactDraftResult;
}

<<<<<<< HEAD
=======
export interface ResearchMaterializeResultWriterInput extends ResearchArtifactDraftMaterializationInput {
  /** Server-created MATERIALIZE attempt identity, separate from SYNTHESIZE lineage. */
  readonly stage_attempt_ref: string;
  readonly stage_request_sha256: string;
}

>>>>>>> b27dc136cbba12e13064d131d02dabb46f8dfae6
function fail(code: ResearchMaterializeResultErrorCode, message: string, cause?: unknown): never {
  throw new ResearchMaterializeResultError(code, message, cause);
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value) ||
      (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) {
    fail("MATERIALIZE_RESULT_CORRUPT", `${label} is not a plain object`);
  }
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[], label: string): void {
  const expected = new Set(keys);
  if (Object.keys(value).length !== keys.length || Object.keys(value).some((key) => !expected.has(key))) {
    fail("MATERIALIZE_RESULT_CORRUPT", `${label} contains unsupported fields`);
  }
}

function boundedRef(value: unknown, label: string): string {
  if (typeof value !== "string" || !REF.test(value)) fail("MATERIALIZE_RESULT_CORRUPT", `${label} is invalid`);
  return value;
}

function identifier(value: unknown, label: string): string {
  const parsed = IdentifierSchema.safeParse(value);
  if (!parsed.success) fail("MATERIALIZE_RESULT_CORRUPT", `${label} is invalid`);
  return parsed.data;
}

function sha256(value: unknown, label: string): string {
  const parsed = Sha256Schema.safeParse(value);
  if (!parsed.success) fail("MATERIALIZE_RESULT_CORRUPT", `${label} is invalid`);
  return parsed.data;
}

function versionedRef(value: unknown, label: string): VersionedRef {
  const parsed = VersionedRefSchema.safeParse(value);
  if (!parsed.success) fail("MATERIALIZE_RESULT_CORRUPT", `${label} is invalid`);
  return Object.freeze({ ...parsed.data });
}

function size(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > RUNTIME_LIMITS.workflow_step_result_bytes) {
    fail("MATERIALIZE_RESULT_CORRUPT", `${label} is invalid`);
  }
  return value;
}

function freezePayload(value: ResearchMaterializeResultPayload): ResearchMaterializeResultPayload {
  Object.freeze(value.synthesis);
  Object.freeze(value.draft.manifest);
  Object.freeze(value.draft);
  return Object.freeze(value);
}

function decodeValue(value: unknown): ResearchMaterializeResultPayload {
  const root = record(value, "materialize result");
  exactKeys(root, ["protocol", "operation_id", "stage", "stage_attempt_ref", "stage_request_sha256", "synthesis", "draft"], "materialize result");
  if (root.protocol !== PROTOCOL || root.stage !== STAGE) fail("MATERIALIZE_RESULT_CORRUPT", "materialize result protocol or stage is invalid");
  const synthesis = record(root.synthesis, "synthesis");
  exactKeys(synthesis, ["stage_attempt_ref", "stage_request_sha256", "output_object_ref", "output_sha256"], "synthesis");
  const draft = record(root.draft, "draft");
  exactKeys(draft, ["artifact_ref", "manifest"], "draft");
  const manifest = record(draft.manifest, "draft manifest");
  exactKeys(manifest, ["key", "sha256", "size_bytes"], "draft manifest");
  return freezePayload({
    protocol: PROTOCOL,
    operation_id: identifier(root.operation_id, "operation_id"),
    stage: STAGE,
    stage_attempt_ref: boundedRef(root.stage_attempt_ref, "stage_attempt_ref"),
    stage_request_sha256: sha256(root.stage_request_sha256, "stage_request_sha256"),
    synthesis: {
      stage_attempt_ref: boundedRef(synthesis.stage_attempt_ref, "synthesis stage_attempt_ref"),
      stage_request_sha256: sha256(synthesis.stage_request_sha256, "synthesis stage_request_sha256"),
      output_object_ref: boundedRef(synthesis.output_object_ref, "synthesis output_object_ref"),
      output_sha256: sha256(synthesis.output_sha256, "synthesis output_sha256"),
    },
    draft: {
      artifact_ref: versionedRef(draft.artifact_ref, "draft artifact_ref"),
      manifest: {
        key: boundedRef(manifest.key, "draft manifest key"),
        sha256: sha256(manifest.sha256, "draft manifest sha256"),
        size_bytes: size(manifest.size_bytes, "draft manifest size_bytes"),
      },
    },
  });
}

/** Decode only the canonical stage17 payload; durable lineage is checked by the caller. */
export function decodeResearchMaterializeResult(bytes: Uint8Array): ResearchMaterializeResultPayload {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength < 1 || bytes.byteLength > RUNTIME_LIMITS.workflow_step_result_bytes) {
    fail("MATERIALIZE_RESULT_CORRUPT", "materialize result bytes exceed the workflow step bound");
  }
  let text: string;
  try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
  catch (cause) { fail("MATERIALIZE_RESULT_CORRUPT", "materialize result is not valid UTF-8", cause); }
  let value: unknown;
  try { value = JSON.parse(text) as unknown; }
  catch (cause) { fail("MATERIALIZE_RESULT_CORRUPT", "materialize result is not valid JSON", cause); }
  const payload = decodeValue(value);
  if (canonicalEvidenceJson(payload) !== text) fail("MATERIALIZE_RESULT_CORRUPT", "materialize result is not canonical JSON");
  return payload;
}

/** Build the immutable MATERIALIZE output from committed W2 and DRAFT readbacks. */
export async function encodeResearchMaterializeResult(input: ResearchMaterializeResultInput): Promise<Uint8Array> {
  if (input === null || typeof input !== "object") fail("MATERIALIZE_RESULT_INPUT_INVALID", "materialize result input is invalid");
  const operationId = identifier(input.operation_id, "operation_id");
  const stageAttemptRef = boundedRef(input.stage_attempt_ref, "stage_attempt_ref");
  const stageRequestSha = sha256(input.stage_request_sha256, "stage_request_sha256");
  const synthesis = input.synthesis_readback;
  if (synthesis.operation_id !== operationId || synthesis.stage !== "SYNTHESIZE" ||
      synthesis.workflow_receipt.operation_id !== operationId ||
      synthesis.stage_attempt_ref !== synthesis.workflow_receipt.attempt_ref ||
      synthesis.stage_request_sha256 !== synthesis.workflow_receipt.request_sha256 ||
      synthesis.output.output_object_ref !== synthesis.model_attempt.output?.output_object_ref ||
      synthesis.output.output_sha256 !== synthesis.model_attempt.output?.output_sha256 ||
      synthesis.output.readback_sha256 !== synthesis.output.output_sha256 ||
      synthesis.bytes.byteLength !== synthesis.output.output_size_bytes ||
      await evidenceSha256Bytes(synthesis.bytes) !== synthesis.output.output_sha256) {
    fail("MATERIALIZE_RESULT_INPUT_INVALID", "SYNTHESIZE readback is not a committed immutable output");
  }
  const draft = input.draft_result;
  const manifest = draft.manifest;
  const receipt = manifest.receipt;
  if (manifest.object_kind !== "MANIFEST" || manifest.object_ref !== "manifest" ||
      receipt.expected_sha256 !== receipt.readback_sha256 || receipt.expected_sha256 !== manifest.residency.content_digest.digest ||
      !Number.isSafeInteger(receipt.size_bytes) || receipt.size_bytes < 0 ||
      !VersionedRefSchema.safeParse(draft.artifact_ref).success) {
    fail("MATERIALIZE_RESULT_INPUT_INVALID", "DRAFT manifest receipt is not an exact committed readback");
  }
  const payload = decodeValue({
    protocol: PROTOCOL,
    operation_id: operationId,
    stage: STAGE,
    stage_attempt_ref: stageAttemptRef,
    stage_request_sha256: stageRequestSha,
    synthesis: {
      stage_attempt_ref: synthesis.stage_attempt_ref,
      stage_request_sha256: synthesis.stage_request_sha256,
      output_object_ref: synthesis.output.output_object_ref,
      output_sha256: synthesis.output.output_sha256,
    },
    draft: {
      artifact_ref: draft.artifact_ref,
      manifest: { key: receipt.key, sha256: receipt.readback_sha256, size_bytes: receipt.size_bytes },
    },
  });
  const text = canonicalEvidenceJson(payload);
  const bytes = new TextEncoder().encode(text);
  try { assertWithinBytes("materialize result", bytes.byteLength, RUNTIME_LIMITS.workflow_step_result_bytes); }
  catch (cause) { fail("MATERIALIZE_RESULT_INPUT_INVALID", "materialize result exceeds the workflow step bound", cause); }
  return bytes;
}

/** Stage handlers use the writer name; it returns bytes for the existing W2 object store. */
export async function writeResearchMaterializeResult(input: ResearchMaterializeResultInput): Promise<Uint8Array> {
  return encodeResearchMaterializeResult(input);
}
<<<<<<< HEAD
=======

/** Run the existing server-authorized DRAFT materializer, then emit its W2 stage payload. */
export async function materializeResearchResult(input: ResearchMaterializeResultWriterInput): Promise<Uint8Array> {
  const draft = await materializeResearchArtifactDraft(input);
  return writeResearchMaterializeResult({
    operation_id: input.operation_id,
    stage_attempt_ref: input.stage_attempt_ref,
    stage_request_sha256: input.stage_request_sha256,
    synthesis_readback: input.synthesis_readback,
    draft_result: draft,
  });
}
>>>>>>> b27dc136cbba12e13064d131d02dabb46f8dfae6
