import { decodeModelGatewayBody } from "@eliotr/cloudflare-ai";
import { canonicalEvidenceJson } from "@eliotr/cloudflare-evidence";
import {
  IdentifierSchema,
  IsoDateTimeSchema,
  Sha256Schema,
  VersionedRefSchema,
  type VersionedRef,
} from "@eliotr/contracts";
import {
  digest,
  fail,
  MAX_WORKFLOW_RECEIPT_BYTES,
  readCommittedStageLineage,
  readWorkflowObject,
  WorkflowCheckpointStore,
  type StageRequest,
  type WorkflowPrincipal,
} from "@eliotr/cloudflare-workflows";
import {
  decodeSynthesisClaimsCandidateV2,
  normalizeSynthesisClaimsCandidateV2,
  type NormalizedSynthesisClaims,
} from "@eliotr/research";
import { z } from "zod";
import type { ResearchMaterializeContext } from "./research-materialize-stage-handler.js";
import type { ResearchSynthesisOutputReadback } from "./research-synthesis-output-reader.js";

const VERIFY_PROTOCOL = "eliotr.research.verification.v2" as const;
const BINDING_PROTOCOL = "eliotr.research.verification.v2.normalization" as const;
const MAX_REFS = 512;

const VerificationSourceReadbackSchema = z.object({
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

const VerificationClaimIdentitySchema = z.object({
  claim_ref: VersionedRefSchema,
  claim_text_digest: Sha256Schema,
  claim_kind: z.enum(["observation", "interpretation", "assumption", "recommendation"]),
  support_handle_refs: z.array(VersionedRefSchema).max(MAX_REFS),
  counterevidence_handle_refs: z.array(VersionedRefSchema).max(MAX_REFS),
}).strict();

const VerificationResultSchema = z.object({
  protocol: z.literal(VERIFY_PROTOCOL),
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
  normalization: z.object({
    section_ref: VersionedRefSchema,
    required_precision: IdentifierSchema,
    required_source_class: IdentifierSchema,
    claims: z.array(VerificationClaimIdentitySchema).min(1).max(MAX_REFS),
    cited_handle_refs: z.array(VersionedRefSchema).min(1).max(MAX_REFS),
    binding_sha256: Sha256Schema,
  }).strict(),
  source_verification: z.object({
    requested_handle_refs: z.array(VersionedRefSchema).min(1).max(MAX_REFS),
    resolved: z.array(VerificationSourceReadbackSchema).min(1).max(MAX_REFS),
  }).strict(),
  verified_at: IsoDateTimeSchema,
}).strict();

type VerificationResult = z.infer<typeof VerificationResultSchema>;

export interface ResearchV2MaterializationCandidate {
  readonly section_text: string;
  readonly cited_handle_refs: readonly VersionedRef[];
  readonly claims: NormalizedSynthesisClaims["claims"];
  readonly normalization_binding_sha256: string;
}

function failCorrupt(): never {
  return fail("WORKFLOW_OUTPUT_CORRUPT");
}

function sameRef(left: VersionedRef, right: VersionedRef): boolean {
  return left.id === right.id && left.revision === right.revision;
}

function refKey(ref: VersionedRef): string {
  return `${ref.id}:${ref.revision}`;
}

function compareRefs(left: VersionedRef, right: VersionedRef): number {
  const leftKey = refKey(left);
  const rightKey = refKey(right);
  return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
}

function sortedRefs(refs: readonly VersionedRef[]): readonly VersionedRef[] {
  return [...refs].sort(compareRefs).map((ref) => ({ id: ref.id, revision: ref.revision }));
}

function uniqueRefs(refs: readonly VersionedRef[]): boolean {
  return new Set(refs.map(refKey)).size === refs.length;
}

function sameRefSet(left: readonly VersionedRef[], right: readonly VersionedRef[]): boolean {
  if (!uniqueRefs(left) || !uniqueRefs(right) || left.length !== right.length) return false;
  const leftKeys = left.map(refKey).sort();
  const rightKeys = right.map(refKey).sort();
  return leftKeys.every((key, index) => key === rightKeys[index]);
}

function bindingMaterial(value: VerificationResult): Record<string, unknown> {
  const claims = [...value.normalization.claims]
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
    operation_id: value.operation_id,
    synthesis_output_sha256: value.synthesis.output_sha256,
    section_ref: value.normalization.section_ref,
    required_precision: value.normalization.required_precision,
    required_source_class: value.normalization.required_source_class,
    claims,
    cited_handle_refs: sortedRefs(value.normalization.cited_handle_refs),
  };
}

function normalizedClaimIdentity(
  value: NormalizedSynthesisClaims["claims"][number],
): Record<string, unknown> {
  return {
    claim_ref: value.claim_ref,
    claim_text_digest: value.text_digest,
    claim_kind: value.kind,
    support_handle_refs: sortedRefs(value.support_handle_refs),
    counterevidence_handle_refs: sortedRefs(value.counterevidence_handle_refs),
  };
}

function storedClaimIdentity(
  value: VerificationResult["normalization"]["claims"][number],
): Record<string, unknown> {
  return {
    claim_ref: value.claim_ref,
    claim_text_digest: value.claim_text_digest,
    claim_kind: value.claim_kind,
    support_handle_refs: sortedRefs(value.support_handle_refs),
    counterevidence_handle_refs: sortedRefs(value.counterevidence_handle_refs),
  };
}

async function decodeVerification(bytes: Uint8Array): Promise<VerificationResult> {
  if (bytes.byteLength > MAX_WORKFLOW_RECEIPT_BYTES) failCorrupt();
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    failCorrupt();
  }
  let result: VerificationResult;
  try {
    const parsed = VerificationResultSchema.safeParse(JSON.parse(text) as unknown);
    if (!parsed.success) failCorrupt();
    result = parsed.data;
  } catch {
    failCorrupt();
  }
  if (canonicalEvidenceJson(result) !== text) failCorrupt();
  const claimRefs = result.normalization.claims.map((claim) => claim.claim_ref);
  const cited = new Map<string, VersionedRef>();
  for (const claim of result.normalization.claims) {
    const refs = [...claim.support_handle_refs, ...claim.counterevidence_handle_refs];
    if (!uniqueRefs(refs)) failCorrupt();
    for (const ref of refs) cited.set(refKey(ref), ref);
  }
  const citedRefs = [...cited.values()];
  if (!uniqueRefs(claimRefs) || !sameRefSet(result.normalization.cited_handle_refs, citedRefs) ||
      !sameRefSet(result.source_verification.requested_handle_refs, citedRefs) ||
      !sameRefSet(result.source_verification.resolved.map((item) => item.handle_ref), citedRefs)) failCorrupt();
  if (await digest(new TextEncoder().encode(canonicalEvidenceJson(bindingMaterial(result)))) !== result.normalization.binding_sha256) {
    failCorrupt();
  }
  return result;
}

function requireLineage(
  request: StageRequest,
  principal: WorkflowPrincipal,
  context: ResearchMaterializeContext,
  synthesis: ResearchSynthesisOutputReadback,
  verify: Awaited<ReturnType<typeof readCommittedStageLineage>>,
  result: VerificationResult,
): void {
  if (verify.request.stage !== "VERIFY" || verify.request.operation_id !== request.operation_id ||
      verify.request.handler_generation !== request.handler_generation ||
      verify.request.investigation_ref.id !== request.investigation_ref.id ||
      verify.receipt.engine_state !== "CHECKPOINTED" ||
      verify.receipt.input_manifest_ref !== verify.request.input_manifest.object_ref ||
      result.operation_id !== request.operation_id || result.stage_attempt_ref !== verify.attempt_ref ||
      result.stage_request_sha256 !== verify.request_sha256 ||
      result.synthesis.stage_attempt_ref !== synthesis.stage_attempt_ref ||
      result.synthesis.stage_request_sha256 !== synthesis.stage_request_sha256 ||
      result.synthesis.output_sha256 !== synthesis.output.output_sha256 ||
      !sameRef(result.freeze_ref, context.freeze.freeze_ref) ||
      !sameRef(result.scope_snapshot_ref, context.freeze.scope_snapshot_ref) ||
      !sameRef(result.manifest_ref, context.manifest.manifest_ref) ||
      context.principal_ref !== principal.principal_ref ||
      context.credential_generation !== principal.credential_generation ||
      context.deployment_generation !== principal.deployment_generation) failCorrupt();
}

function requireSourceReadback(
  result: VerificationResult,
  context: ResearchMaterializeContext,
  principal: WorkflowPrincipal,
): void {
  const frozen = new Map(context.freeze.included_evidence.map((item) => [refKey(item.handle_ref), item]));
  const packed = new Map(context.stage_five.evidence_pack.resolved_evidence.map((item) => [refKey(item.handle.handle_ref), item]));
  for (const item of result.source_verification.resolved) {
    const key = refKey(item.handle_ref);
    const expectedFreeze = frozen.get(key);
    const expectedPack = packed.get(key);
    if (expectedFreeze === undefined || expectedPack === undefined ||
        expectedFreeze.digest !== item.excerpt_sha256 ||
        expectedPack.handle.excerpt_sha256 !== item.excerpt_sha256 ||
        expectedPack.handle.source_revision_ref !== item.source_revision_ref ||
        expectedPack.handle.source_owner_generation !== item.source_owner_generation ||
        expectedPack.source_revision_content_sha256 !== item.source_revision_content_sha256 ||
        expectedPack.scope_snapshot_digest !== item.scope_snapshot_digest ||
        !sameRef(expectedPack.handle.scope_snapshot_ref, context.freeze.scope_snapshot_ref) ||
        item.authorization_receipt_ref !== context.authorization_receipt_ref ||
        item.credential_generation !== principal.credential_generation) failCorrupt();
  }
}

export async function readCommittedResearchV2MaterializationCandidate(input: {
  readonly database: D1Database;
  readonly work_bucket: R2Bucket;
  readonly request: StageRequest;
  readonly principal: WorkflowPrincipal;
  readonly context: ResearchMaterializeContext;
  readonly synthesis_readback: ResearchSynthesisOutputReadback;
}): Promise<ResearchV2MaterializationCandidate> {
  const verify = await readCommittedStageLineage(
    new WorkflowCheckpointStore(input.database), input.request.operation_id, "VERIFY",
  );
  const verifyBytes = await readWorkflowObject(input.work_bucket, verify.receipt.output_manifest, true);
  const result = await decodeVerification(verifyBytes);
  requireLineage(input.request, input.principal, input.context, input.synthesis_readback, verify, result);
  requireSourceReadback(result, input.context, input.principal);

  let assistantContent: string;
  try {
    assistantContent = (await decodeModelGatewayBody(input.synthesis_readback.bytes)).assistant_content;
  } catch {
    failCorrupt();
  }
  let normalized: NormalizedSynthesisClaims;
  try {
    normalized = await normalizeSynthesisClaimsCandidateV2({
      candidate: decodeSynthesisClaimsCandidateV2(assistantContent),
      operation_id: input.request.operation_id,
      section_ref: result.normalization.section_ref,
      allowed_handle_refs: input.context.freeze.included_evidence.map((item) => item.handle_ref),
      required_precision: result.normalization.required_precision,
      required_source_class: result.normalization.required_source_class,
    });
  } catch {
    failCorrupt();
  }
  const normalizedClaims = normalized.claims.map(normalizedClaimIdentity);
  const storedClaims = result.normalization.claims.map(storedClaimIdentity);
  if (!sameRef(normalized.section_ref, result.normalization.section_ref) ||
      canonicalEvidenceJson(normalizedClaims) !== canonicalEvidenceJson(storedClaims) ||
      !sameRefSet(normalized.cited_handle_refs, result.normalization.cited_handle_refs)) failCorrupt();
  return Object.freeze({
    section_text: normalized.section_text,
    cited_handle_refs: Object.freeze(normalized.cited_handle_refs.map((ref) => Object.freeze({ ...ref }))),
    claims: normalized.claims,
    normalization_binding_sha256: result.normalization.binding_sha256,
  });
}
