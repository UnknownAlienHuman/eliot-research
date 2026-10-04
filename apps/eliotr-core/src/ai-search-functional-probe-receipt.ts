import { EvidenceHandleSchema, type EvidenceHandle, type ScopeSnapshot } from "@eliotr/contracts";
import {
  AI_SEARCH_PRIMARY_GENERATION,
  AI_SEARCH_PRIMARY_NAMESPACE,
} from "@eliotr/cloudflare-ai";
import type { EvidenceObjectStore } from "@eliotr/platform-cloudflare";
import type { EvidenceAccessContext } from "@eliotr/cloudflare-evidence";
import { z } from "zod";

export const AI_SEARCH_FUNCTIONAL_PROBE_PROTOCOL = "eliotr.ai-search-functional-probe.v1" as const;
export const AI_SEARCH_FUNCTIONAL_PROBE_RECEIPT_MAX_BYTES = 16 * 1024;
const CONTENT_TYPE = "application/json";
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;

export type AiSearchFunctionalProbeOutcome = "SUCCEEDED" | "NO_MATCH" | "UNKNOWN";
export interface AiSearchFunctionalProbeResponse {
  readonly protocol: typeof AI_SEARCH_FUNCTIONAL_PROBE_PROTOCOL;
  readonly qualification: "NONE";
  readonly outcome: AiSearchFunctionalProbeOutcome;
  readonly functional_ref?: string;
  readonly evidence_handle?: EvidenceHandle;
  readonly source_revision_ref: string;
  readonly registry_revision: number;
  readonly registry_artifact_sha256: string;
  readonly query_sha256: string;
  readonly reason_code?: string;
}

export interface FunctionalProbeReceiptContext {
  readonly access: EvidenceAccessContext;
  readonly project_id: string;
  readonly source_id: string;
  readonly source_revision_ref: string;
  readonly scope_snapshot: ScopeSnapshot;
  readonly query_sha256: string;
  readonly registry_revision: number;
  readonly registry_artifact_sha256: string;
}

export const FunctionalProbeReceiptSchema = z.object({
  protocol: z.literal(AI_SEARCH_FUNCTIONAL_PROBE_PROTOCOL), qualification: z.literal("NONE"),
  outcome: z.enum(["SUCCEEDED", "NO_MATCH", "UNKNOWN"]), functional_ref: z.string().regex(IDENTIFIER),
  request_sha256: z.string().regex(SHA256), query_sha256: z.string().regex(SHA256),
  principal_ref: z.string().regex(IDENTIFIER), credential_generation: z.string().regex(IDENTIFIER),
  project_id: z.string().regex(IDENTIFIER), source_id: z.string().regex(IDENTIFIER),
  source_revision_ref: z.string().regex(IDENTIFIER), scope_snapshot_id: z.string().regex(IDENTIFIER),
  scope_snapshot_revision: z.number().int().positive(), scope_snapshot_digest: z.string().regex(SHA256),
  namespace: z.literal(AI_SEARCH_PRIMARY_NAMESPACE), generation: z.literal(AI_SEARCH_PRIMARY_GENERATION),
  registry_revision: z.number().int().positive(), registry_artifact_sha256: z.string().regex(SHA256),
  evidence_handle: EvidenceHandleSchema.optional(), reason_code: z.string().regex(IDENTIFIER).optional(),
  created_at: z.string().datetime({ offset: true }),
}).strict().superRefine((receipt, context) => {
  if ((receipt.outcome === "SUCCEEDED") !== (receipt.evidence_handle !== undefined)) {
    context.addIssue({ code: "custom", path: ["evidence_handle"], message: "only success carries an EvidenceHandle" });
  }
  const handle = receipt.evidence_handle;
  if (handle !== undefined && (handle.source_revision_ref !== receipt.source_revision_ref ||
      handle.scope_snapshot_ref.id !== receipt.scope_snapshot_id ||
      handle.scope_snapshot_ref.revision !== receipt.scope_snapshot_revision || handle.terminal_state !== "LIVE")) {
    context.addIssue({ code: "custom", path: ["evidence_handle"], message: "handle is outside the exact live scope" });
  }
});
export type FunctionalProbeReceipt = z.infer<typeof FunctionalProbeReceiptSchema>;

export function canonicalProbeJson(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) throw new Error("AI_SEARCH_FUNCTIONAL_PROBE_JSON_INVALID");
    return String(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalProbeJson).join(",")}]`;
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).filter((key) => record[key] !== undefined).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalProbeJson(record[key])}`).join(",")}}`;
  }
  throw new Error("AI_SEARCH_FUNCTIONAL_PROBE_JSON_INVALID");
}

export async function probeSha256(bytes: Uint8Array): Promise<string> {
  const copy = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(copy).set(bytes);
  const digest = await crypto.subtle.digest("SHA-256", copy);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function probeBodyStream(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream({ start(controller) { controller.enqueue(bytes); controller.close(); } });
}

export async function createFunctionalProbeReceipt(
  context: FunctionalProbeReceiptContext,
  requestSha: string,
  outcome: AiSearchFunctionalProbeOutcome,
  nowMs: number,
  evidenceHandle?: EvidenceHandle,
  reasonCode?: string,
): Promise<FunctionalProbeReceipt> {
  const receipt = {
    protocol: AI_SEARCH_FUNCTIONAL_PROBE_PROTOCOL, qualification: "NONE" as const, outcome,
    functional_ref: `functional-probe:${requestSha}`, request_sha256: requestSha, query_sha256: context.query_sha256,
    principal_ref: context.access.principal_ref, credential_generation: context.access.credential_generation,
    project_id: context.project_id, source_id: context.source_id, source_revision_ref: context.source_revision_ref,
    scope_snapshot_id: context.scope_snapshot.snapshot_id, scope_snapshot_revision: context.scope_snapshot.revision,
    scope_snapshot_digest: context.scope_snapshot.digest, namespace: AI_SEARCH_PRIMARY_NAMESPACE,
    generation: AI_SEARCH_PRIMARY_GENERATION, registry_revision: context.registry_revision,
    registry_artifact_sha256: context.registry_artifact_sha256,
    ...(evidenceHandle === undefined ? {} : { evidence_handle: evidenceHandle }),
    ...(reasonCode === undefined ? {} : { reason_code: reasonCode }), created_at: new Date(nowMs).toISOString(),
  };
  return FunctionalProbeReceiptSchema.parse(receipt);
}

export function functionalProbePublicResponse(receipt: FunctionalProbeReceipt): AiSearchFunctionalProbeResponse {
  return Object.freeze({
    protocol: AI_SEARCH_FUNCTIONAL_PROBE_PROTOCOL, qualification: "NONE", outcome: receipt.outcome,
    functional_ref: receipt.functional_ref,
    ...(receipt.evidence_handle === undefined ? {} : { evidence_handle: receipt.evidence_handle }),
    source_revision_ref: receipt.source_revision_ref, registry_revision: receipt.registry_revision,
    registry_artifact_sha256: receipt.registry_artifact_sha256, query_sha256: receipt.query_sha256,
    ...(receipt.reason_code === undefined ? {} : { reason_code: receipt.reason_code }),
  });
}

async function readBounded(stream: ReadableStream<Uint8Array>, expectedSize: number): Promise<Uint8Array> {
  if (!Number.isSafeInteger(expectedSize) || expectedSize < 0 || expectedSize > AI_SEARCH_FUNCTIONAL_PROBE_RECEIPT_MAX_BYTES) {
    throw new Error("AI_SEARCH_FUNCTIONAL_PROBE_RECEIPT_TOO_LARGE");
  }
  const reader = stream.getReader(), chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > expectedSize || size > AI_SEARCH_FUNCTIONAL_PROBE_RECEIPT_MAX_BYTES) throw new Error("AI_SEARCH_FUNCTIONAL_PROBE_RECEIPT_TOO_LARGE");
      chunks.push(next.value);
    }
  } finally { reader.releaseLock(); }
  if (size !== expectedSize) throw new Error("AI_SEARCH_FUNCTIONAL_PROBE_RECEIPT_SIZE_MISMATCH");
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes;
}

export async function readFunctionalProbeReceipt(
  store: Pick<EvidenceObjectStore, "open">,
  key: string,
  requestSha: string,
  context: FunctionalProbeReceiptContext,
): Promise<FunctionalProbeReceipt | null> {
  const object = await store.open(key);
  if (object === null) return null;
  const metadata = object.customMetadata ?? {};
  if (object.size > AI_SEARCH_FUNCTIONAL_PROBE_RECEIPT_MAX_BYTES || object.httpMetadata?.contentType !== CONTENT_TYPE ||
      metadata.eliotr_immutable !== "true" || metadata.eliotr_size_bytes !== String(object.size)) {
    throw new Error("AI_SEARCH_FUNCTIONAL_PROBE_RECEIPT_METADATA_INVALID");
  }
  const bytes = await readBounded(object.body, object.size), digest = await probeSha256(bytes);
  if (metadata.eliotr_sha256 !== digest) throw new Error("AI_SEARCH_FUNCTIONAL_PROBE_RECEIPT_DIGEST_MISMATCH");
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  let raw: unknown;
  try { raw = JSON.parse(text); } catch { throw new Error("AI_SEARCH_FUNCTIONAL_PROBE_RECEIPT_JSON_INVALID"); }
  const parsed = FunctionalProbeReceiptSchema.safeParse(raw);
  if (!parsed.success || canonicalProbeJson(parsed.data) !== text) throw new Error("AI_SEARCH_FUNCTIONAL_PROBE_RECEIPT_INVALID");
  const receipt = parsed.data;
  if (receipt.request_sha256 !== requestSha || receipt.query_sha256 !== context.query_sha256 ||
      receipt.principal_ref !== context.access.principal_ref || receipt.credential_generation !== context.access.credential_generation ||
      receipt.project_id !== context.project_id || receipt.source_id !== context.source_id ||
      receipt.source_revision_ref !== context.source_revision_ref || receipt.scope_snapshot_id !== context.scope_snapshot.snapshot_id ||
      receipt.scope_snapshot_revision !== context.scope_snapshot.revision || receipt.scope_snapshot_digest !== context.scope_snapshot.digest ||
      receipt.registry_revision !== context.registry_revision || receipt.registry_artifact_sha256 !== context.registry_artifact_sha256) {
    throw new Error("AI_SEARCH_FUNCTIONAL_PROBE_RECEIPT_IDENTITY_MISMATCH");
  }
  return receipt;
}
