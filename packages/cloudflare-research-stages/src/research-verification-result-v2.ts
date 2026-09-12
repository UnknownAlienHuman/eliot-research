import { canonicalEvidenceJson } from "@eliotr/cloudflare-evidence";
import { digest, fail, MAX_WORKFLOW_RECEIPT_BYTES } from "@eliotr/cloudflare-workflows";
import { IdentifierSchema, IsoDateTimeSchema, Sha256Schema, VersionedRefSchema } from "@eliotr/contracts";
import { z } from "zod";

const PROTOCOL = "eliotr.research.verification.v2" as const;
const BINDING_PROTOCOL = "eliotr.research.verification.v2.normalization" as const;
const MAX_REFS = 512;

const ClaimKindSchema = z.enum(["observation", "interpretation", "assumption", "recommendation"]);
const ResolvedSourceReadbackSchema = z.object({
  handle_ref: VersionedRefSchema,
  source_revision_ref: IdentifierSchema,
  source_owner_generation: IdentifierSchema,
  excerpt_sha256: Sha256Schema,
  source_revision_content_sha256: Sha256Schema,
  scope_snapshot_digest: Sha256Schema,
  authorization_receipt_ref: IdentifierSchema,
  credential_generation: IdentifierSchema,
  verification_receipt_ref: IdentifierSchema,
}).strict();

const NormalizedClaimIdentitySchema = z.object({
  claim_ref: VersionedRefSchema,
  claim_text_digest: Sha256Schema,
  claim_kind: ClaimKindSchema,
  support_handle_refs: z.array(VersionedRefSchema).max(MAX_REFS),
  counterevidence_handle_refs: z.array(VersionedRefSchema).max(MAX_REFS),
}).strict();

const NormalizationSchema = z.object({
  section_ref: VersionedRefSchema,
  required_precision: IdentifierSchema,
  required_source_class: IdentifierSchema,
  claims: z.array(NormalizedClaimIdentitySchema).min(1).max(MAX_REFS),
  cited_handle_refs: z.array(VersionedRefSchema).min(1).max(MAX_REFS),
  binding_sha256: Sha256Schema,
}).strict();

const ResearchVerificationResultV2Schema = z.object({
  protocol: z.literal(PROTOCOL),
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
  normalization: NormalizationSchema,
  source_verification: z.object({
    requested_handle_refs: z.array(VersionedRefSchema).min(1).max(MAX_REFS),
    resolved: z.array(ResolvedSourceReadbackSchema).min(1).max(MAX_REFS),
  }).strict(),
  verified_at: IsoDateTimeSchema,
}).strict();

export type ResearchVerificationResultV2 = z.infer<typeof ResearchVerificationResultV2Schema>;
export type ResearchVerificationNormalizationV2 = ResearchVerificationResultV2["normalization"];
export type ResearchVerificationClaimIdentityV2 = ResearchVerificationNormalizationV2["claims"][number];
export type ResearchVerificationSourceReadbackV2 = ResearchVerificationResultV2["source_verification"]["resolved"][number];

type VersionedReference = ResearchVerificationResultV2["normalization"]["section_ref"];
type BindingInput = Pick<ResearchVerificationResultV2, "operation_id" | "synthesis" | "normalization">;

function refKey(ref: VersionedReference): string {
  return `${ref.id}:${ref.revision}`;
}

function compareRefs(left: VersionedReference, right: VersionedReference): number {
  const leftKey = refKey(left);
  const rightKey = refKey(right);
  if (leftKey < rightKey) return -1;
  if (leftKey > rightKey) return 1;
  return 0;
}

function uniqueRefs(refs: readonly VersionedReference[]): boolean {
  return new Set(refs.map(refKey)).size === refs.length;
}

function sameRefSet(left: readonly VersionedReference[], right: readonly VersionedReference[]): boolean {
  if (!uniqueRefs(left) || !uniqueRefs(right) || left.length !== right.length) return false;
  const leftKeys = left.map(refKey).sort();
  const rightKeys = right.map(refKey).sort();
  return leftKeys.every((key, index) => key === rightKeys[index]);
}

function sortedRefs(refs: readonly VersionedReference[]): VersionedReference[] {
  return [...refs].sort(compareRefs);
}

function bindingMaterial(input: BindingInput): Record<string, unknown> {
  const claims = [...input.normalization.claims]
    .map((claim) => ({
      claim_ref: claim.claim_ref,
      claim_text_digest: claim.claim_text_digest,
      claim_kind: claim.claim_kind,
      support_handle_refs: sortedRefs(claim.support_handle_refs),
      counterevidence_handle_refs: sortedRefs(claim.counterevidence_handle_refs),
    }))
    .sort((left, right) => compareRefs(left.claim_ref, right.claim_ref));

  return {
    protocol: BINDING_PROTOCOL,
    operation_id: input.operation_id,
    synthesis_output_sha256: input.synthesis.output_sha256,
    section_ref: input.normalization.section_ref,
    required_precision: input.normalization.required_precision,
    required_source_class: input.normalization.required_source_class,
    claims,
    cited_handle_refs: sortedRefs(input.normalization.cited_handle_refs),
  };
}

/** Derives the server-owned binding for normalized claim identities and source refs. */
export async function researchVerificationNormalizationBindingSha256(input: BindingInput): Promise<string> {
  const bytes = new TextEncoder().encode(canonicalEvidenceJson(bindingMaterial(input)));
  return digest(bytes);
}

function validateIdentityConsistency(
  value: ResearchVerificationResultV2,
  code: "WORKFLOW_INPUT_INVALID" | "WORKFLOW_OUTPUT_CORRUPT",
): void {
  const claims = value.normalization.claims;
  if (!uniqueRefs(claims.map((claim) => claim.claim_ref))) fail(code);

  const cited = new Map<string, VersionedReference>();
  for (const claim of claims) {
    const claimRefs = [...claim.support_handle_refs, ...claim.counterevidence_handle_refs];
    if (!uniqueRefs(claimRefs)) fail(code);
    for (const ref of claimRefs) cited.set(refKey(ref), ref);
  }

  const citedRefs = [...cited.values()];
  if (!sameRefSet(value.normalization.cited_handle_refs, citedRefs) ||
      !sameRefSet(value.source_verification.requested_handle_refs, citedRefs)) {
    fail(code);
  }

  const resolvedRefs = value.source_verification.resolved.map((readback) => readback.handle_ref);
  if (!sameRefSet(resolvedRefs, citedRefs)) fail(code);
}

function parseResult(value: unknown): ResearchVerificationResultV2 {
  const parsed = ResearchVerificationResultV2Schema.safeParse(value);
  if (!parsed.success) fail("WORKFLOW_OUTPUT_CORRUPT");
  return parsed.data;
}

export async function encodeResearchVerificationResultV2(value: ResearchVerificationResultV2): Promise<Uint8Array> {
  const parsed = ResearchVerificationResultV2Schema.safeParse(value);
  if (!parsed.success) fail("WORKFLOW_INPUT_INVALID");
  validateIdentityConsistency(parsed.data, "WORKFLOW_INPUT_INVALID");

  const binding = await researchVerificationNormalizationBindingSha256(parsed.data);
  if (binding !== parsed.data.normalization.binding_sha256) fail("WORKFLOW_INPUT_INVALID");

  const bytes = new TextEncoder().encode(canonicalEvidenceJson(parsed.data));
  if (bytes.byteLength > MAX_WORKFLOW_RECEIPT_BYTES) fail("WORKFLOW_INPUT_INVALID");
  return bytes;
}

export async function decodeResearchVerificationResultV2(bytes: Uint8Array): Promise<ResearchVerificationResultV2> {
  if (bytes.byteLength > MAX_WORKFLOW_RECEIPT_BYTES) fail("WORKFLOW_OUTPUT_CORRUPT");

  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    fail("WORKFLOW_OUTPUT_CORRUPT");
  }

  let parsed: ResearchVerificationResultV2;
  try {
    parsed = parseResult(JSON.parse(text) as unknown);
  } catch {
    fail("WORKFLOW_OUTPUT_CORRUPT");
  }
  if (canonicalEvidenceJson(parsed) !== text) fail("WORKFLOW_OUTPUT_CORRUPT");
  validateIdentityConsistency(parsed, "WORKFLOW_OUTPUT_CORRUPT");

  const binding = await researchVerificationNormalizationBindingSha256(parsed);
  if (binding !== parsed.normalization.binding_sha256) fail("WORKFLOW_OUTPUT_CORRUPT");
  return parsed;
}
