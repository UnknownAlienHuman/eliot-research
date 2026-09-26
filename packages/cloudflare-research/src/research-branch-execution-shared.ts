import {
  ResearchBranchAnalysisCheckpointSchema,
  ResearchBranchReconciliationCheckpointSchema,
  ResearchBranchResultSchema,
  ResearchReadExtractCheckpointSchema,
  type ResearchBranchAnalysisCheckpoint,
  type ResearchBranchReconciliationCheckpoint,
  type ResearchBranchResult,
  type ResearchReadExtractCheckpoint,
  type VersionedRef,
} from "@eliotr/contracts";
import { canonicalEvidenceJson, evidenceSha256 } from "@eliotr/cloudflare-evidence";
import { fail } from "@eliotr/cloudflare-workflows";
import type { ZodType } from "zod";

const MAX_CHECKPOINT_BYTES = 512 * 1024;

export function refKey(value: VersionedRef): string {
  return `${value.id}:${value.revision}`;
}

export function sameRef(left: VersionedRef, right: VersionedRef): boolean {
  return left.id === right.id && left.revision === right.revision;
}

export function uniqueSorted<T extends string>(values: readonly T[]): T[] {
  return [...new Set(values)].sort() as T[];
}

export function canonicalBytes(value: unknown): Uint8Array {
  const bytes = new TextEncoder().encode(canonicalEvidenceJson(value));
  if (bytes.byteLength > MAX_CHECKPOINT_BYTES) fail("WORKFLOW_INPUT_INVALID");
  return bytes;
}

export function parseCanonical<T>(bytes: Uint8Array, schema: ZodType<T>): T {
  if (bytes.byteLength < 1 || bytes.byteLength > MAX_CHECKPOINT_BYTES) fail("WORKFLOW_OUTPUT_CORRUPT");
  let value: unknown;
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    value = JSON.parse(text);
  } catch {
    return fail("WORKFLOW_OUTPUT_CORRUPT");
  }
  const parsed = schema.safeParse(value);
  if (!parsed.success || canonicalEvidenceJson(parsed.data) !== text) fail("WORKFLOW_OUTPUT_CORRUPT");
  return parsed.data;
}

export async function withIdentity<T extends Record<string, unknown>>(
  domain: string,
  idPrefix: string,
  value: T,
): Promise<T & { readonly checkpoint_ref: VersionedRef; readonly identity_digest: string }> {
  const digest = await evidenceSha256({ domain, value });
  return { ...value, checkpoint_ref: { id: `${idPrefix}${digest}`, revision: 1 }, identity_digest: digest };
}

export async function branchResult(input: Omit<ResearchBranchResult, "branch_ref" | "identity_digest">): Promise<ResearchBranchResult> {
  const identity = await evidenceSha256({ domain: "eliotr.research.branch-result.v1", value: input });
  return ResearchBranchResultSchema.parse({
    ...input,
    branch_ref: { id: `eliotr.research.branch-${identity}`, revision: 1 },
    identity_digest: identity,
  });
}

export function decodeResearchReadExtractCheckpoint(bytes: Uint8Array): ResearchReadExtractCheckpoint {
  return parseCanonical(bytes, ResearchReadExtractCheckpointSchema);
}

export function decodeResearchBranchAnalysisCheckpoint(bytes: Uint8Array): ResearchBranchAnalysisCheckpoint {
  return parseCanonical(bytes, ResearchBranchAnalysisCheckpointSchema);
}

export function decodeResearchBranchReconciliationCheckpoint(bytes: Uint8Array): ResearchBranchReconciliationCheckpoint {
  return parseCanonical(bytes, ResearchBranchReconciliationCheckpointSchema);
}
