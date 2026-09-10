import { z } from "zod";
import { IdentifierSchema, IsoDateTimeSchema, Sha256Schema, VersionedRefSchema } from "@eliotr/contracts";
import { canonicalEvidenceJson } from "@eliotr/cloudflare-evidence";
import { fail, MAX_WORKFLOW_OUTPUT_BYTES } from "@eliotr/cloudflare-workflows";

const ResearchVerificationResultSchema = z.object({
  protocol: z.literal("eliotr.research.verification.v1"),
  operation_id: IdentifierSchema,
  stage: z.literal("VERIFY"),
  stage_attempt_ref: IdentifierSchema,
  stage_request_sha256: Sha256Schema,
  synthesis: z.object({
    stage_attempt_ref: IdentifierSchema,
    stage_request_sha256: Sha256Schema,
    output_sha256: Sha256Schema,
  }).strict(),
  freeze_ref: VersionedRefSchema,
  scope_snapshot_ref: VersionedRefSchema,
  manifest_ref: VersionedRefSchema,
  semantic_verification: z.literal("NOT_EXECUTED"),
  source_verification: z.object({
    requested_handle_refs: z.array(VersionedRefSchema).min(1).max(512),
    resolved: z.array(z.object({
      handle_ref: VersionedRefSchema,
      source_revision_ref: IdentifierSchema,
      source_owner_generation: IdentifierSchema,
      excerpt_sha256: Sha256Schema,
      source_revision_content_sha256: Sha256Schema,
      scope_snapshot_digest: Sha256Schema,
      authorization_receipt_ref: IdentifierSchema,
      credential_generation: IdentifierSchema,
      verification_receipt_ref: IdentifierSchema,
    }).strict()).min(1).max(512),
  }).strict(),
  verified_at: IsoDateTimeSchema,
}).strict();

export type ResearchVerificationResult = z.infer<typeof ResearchVerificationResultSchema>;

function parseCanonical(bytes: Uint8Array): ResearchVerificationResult {
  if (bytes.byteLength > MAX_WORKFLOW_OUTPUT_BYTES) fail("WORKFLOW_OUTPUT_CORRUPT");
  let text: string;
  try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
  catch { fail("WORKFLOW_OUTPUT_CORRUPT"); }
  try {
    const value = ResearchVerificationResultSchema.parse(JSON.parse(text));
    if (canonicalEvidenceJson(value) !== text) fail("WORKFLOW_OUTPUT_CORRUPT");
    return value;
  } catch { fail("WORKFLOW_OUTPUT_CORRUPT"); }
}

export function encodeResearchVerificationResult(value: ResearchVerificationResult): Uint8Array {
  let parsed: ResearchVerificationResult;
  try { parsed = ResearchVerificationResultSchema.parse(value); }
  catch { fail("WORKFLOW_INPUT_INVALID"); }
  const bytes = new TextEncoder().encode(canonicalEvidenceJson(parsed));
  if (bytes.byteLength > MAX_WORKFLOW_OUTPUT_BYTES) fail("WORKFLOW_INPUT_INVALID");
  return bytes;
}

export function decodeResearchVerificationResult(bytes: Uint8Array): ResearchVerificationResult {
  return parseCanonical(bytes);
}
