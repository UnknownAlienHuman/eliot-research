import {
  canonicalEvidenceJson,
  type CloudflareEvidenceResolver,
  type NavigationReadAuthority,
} from "@eliotr/cloudflare-evidence";
import {
  ClaimAuditItemSchema,
  type ClaimAuditItem,
  type VersionedRef,
} from "@eliotr/contracts";
import {
  digest,
  readCommittedStageLineage,
  type StageRequest,
  type WorkflowPrincipal,
  type WorkflowStageHandler,
  WorkflowCheckpointError,
  WorkflowCheckpointStore,
} from "@eliotr/cloudflare-workflows";
import type { EvidenceFreezeSynthesisContext, EvidenceFreezeVerificationContextReader } from "./research-evidence-freeze-composition.js";
import { citationRefsFromClaimAudit, encodeResearchCitationsResult } from "./research-citations-result.js";

export interface ResearchClaimAuditProjection {
  /** Server-owned semantic decoder output; these are not caller-supplied refs. */
  readonly claim_audit_items: readonly ClaimAuditItem[];
}

export interface ResearchClaimAuditReader {
  read(input: {
    readonly bytes: Uint8Array;
    readonly stage_attempt_ref: string;
    readonly stage_request_sha256: string;
  }): Promise<ResearchClaimAuditProjection>;
}

export interface ResearchCitationsStageDependencies {
  readonly database: D1Database;
  readonly navigation: NavigationReadAuthority;
  readonly evidence_resolver: CloudflareEvidenceResolver;
  /** Reader validates the current stage15 frozen lineage before and after external evidence reads. */
  readonly context: EvidenceFreezeVerificationContextReader;
  /** Astro semantic decoder for the committed AUDIT_CLAIMS model output. */
  readonly audit: ResearchClaimAuditReader;
}

function sameRef(left: VersionedRef, right: VersionedRef): boolean {
  return left.id === right.id && left.revision === right.revision;
}

function refKey(ref: VersionedRef): string {
  return `${ref.id}:${ref.revision}`;
}

function sameJson(left: unknown, right: unknown): boolean {
  return canonicalEvidenceJson(left) === canonicalEvidenceJson(right);
}

function failCode(code: "WORKFLOW_INPUT_INVALID" | "WORKFLOW_AUTHORITY_STALE" | "WORKFLOW_OUTPUT_CORRUPT"): never {
  throw new WorkflowCheckpointError(code);
}

function requireContext(request: StageRequest, principal: WorkflowPrincipal, context: EvidenceFreezeSynthesisContext): void {
  if (context.operation_id !== request.operation_id || context.investigation_id !== request.investigation_ref.id ||
      context.principal_ref !== principal.principal_ref || context.credential_generation !== principal.credential_generation ||
      context.deployment_generation !== principal.deployment_generation || context.current_revision !== request.investigation_ref.revision) {
    failCode("WORKFLOW_AUTHORITY_STALE");
  }
}

function requireResearchAccess(navigation: NavigationReadAuthority, current: Awaited<ReturnType<NavigationReadAuthority["current"]>>): void {
  if (!current.allowed_use.includes("research") || Date.parse(current.expires_at) <= Date.parse(navigation.timestamp())) {
    failCode("WORKFLOW_AUTHORITY_STALE");
  }
}

function requireAuditedHandles(
  items: readonly ClaimAuditItem[],
  context: EvidenceFreezeSynthesisContext,
): readonly VersionedRef[] {
  for (const item of items) {
    try { ClaimAuditItemSchema.parse(item); }
    catch { failCode("WORKFLOW_OUTPUT_CORRUPT"); }
  }
  const refs = citationRefsFromClaimAudit(items);
  const manifest = new Set(context.manifest.allowed_evidence_handle_refs.map(refKey));
  const frozen = new Map(context.freeze.included_evidence.map((item) => [refKey(item.handle_ref), item.digest]));
  const packed = new Map(context.stage_five.evidence_pack.resolved_evidence.map((item) => [refKey(item.handle.handle_ref), item.handle.excerpt_sha256]));
  for (const ref of refs) {
    const key = refKey(ref);
    if (!manifest.has(key) || !frozen.has(key) || !packed.has(key) || frozen.get(key) !== packed.get(key)) {
      failCode("WORKFLOW_OUTPUT_CORRUPT");
    }
  }
  return refs;
}

function requireResolvedEvidence(
  result: Awaited<ReturnType<CloudflareEvidenceResolver["resolveCitationSet"]>>,
  requested: readonly VersionedRef[],
  context: EvidenceFreezeSynthesisContext,
  current: Awaited<ReturnType<NavigationReadAuthority["current"]>>,
): void {
  const requestedKeys = new Set(requested.map(refKey));
  const receiptKeys = result.receipt.requested_handle_refs.map(refKey);
  if (!sameRef(result.receipt.scope_snapshot_ref, context.freeze.scope_snapshot_ref) ||
      !sameJson(receiptKeys, [...requestedKeys].sort()) || result.receipt.resolved_count !== result.resolved_evidence.length ||
      result.resolved_evidence.some((item) => !requestedKeys.has(refKey(item.handle.handle_ref)))) {
    failCode("WORKFLOW_OUTPUT_CORRUPT");
  }
  const receiptByKey = new Map(result.receipt.resolved.map((item) => [refKey(item.handle_ref), item]));
  if (receiptByKey.size !== result.receipt.resolved.length || result.resolved_evidence.some((item) => {
    const receipt = receiptByKey.get(refKey(item.handle.handle_ref));
    return receipt === undefined || receipt.excerpt_sha256 !== item.handle.excerpt_sha256 ||
      receipt.verification_receipt_ref !== item.verification_receipt_ref;
  })) failCode("WORKFLOW_OUTPUT_CORRUPT");
  for (const item of result.resolved_evidence) {
    const frozen = context.freeze.included_evidence.find((entry) => sameRef(entry.handle_ref, item.handle.handle_ref));
    const packed = context.stage_five.evidence_pack.resolved_evidence.find((entry) => sameRef(entry.handle.handle_ref, item.handle.handle_ref));
    if (frozen === undefined || packed === undefined || frozen.digest !== item.handle.excerpt_sha256 ||
        packed.handle.excerpt_sha256 !== item.handle.excerpt_sha256 || item.handle.terminal_state !== "LIVE" ||
        !sameRef(item.handle.scope_snapshot_ref, context.freeze.scope_snapshot_ref) ||
        item.authorization_receipt_ref !== current.authorization_receipt_ref ||
        item.credential_generation !== context.stage_five.evidence_pack.resolved_evidence.find((packedItem) => sameRef(packedItem.handle.handle_ref, item.handle.handle_ref))?.credential_generation) {
      failCode("WORKFLOW_OUTPUT_CORRUPT");
    }
  }
}

/** Resolves exactly the support plus counterevidence handles from committed AUDIT_CLAIMS output. */
export function createResearchCitationsStageHandler(
  dependencies: ResearchCitationsStageDependencies,
): WorkflowStageHandler {
  return async ({ request, principal, input_bytes, attempt_ref }) => {
    if (request.stage !== "RESOLVE_CITATIONS") failCode("WORKFLOW_INPUT_INVALID");
    const request_sha256 = await digest(new TextEncoder().encode(JSON.stringify(request)));
    if (request.input_manifest.sha256 !== await digest(input_bytes)) failCode("WORKFLOW_OUTPUT_CORRUPT");
    const checkpoints = new WorkflowCheckpointStore(dependencies.database);
    const auditStage = await readCommittedStageLineage(checkpoints, request.operation_id, "AUDIT_CLAIMS");
    if (auditStage.request.investigation_ref.id !== request.investigation_ref.id ||
        !sameJson(auditStage.receipt.output_manifest, request.input_manifest) ||
        auditStage.receipt.stage !== "AUDIT_CLAIMS") failCode("WORKFLOW_OUTPUT_CORRUPT");
    let context: EvidenceFreezeSynthesisContext;
    try { context = await dependencies.context.read({ request, principal, input_bytes }); }
    catch { failCode("WORKFLOW_AUTHORITY_STALE"); }
    requireContext(request, principal, context);
    const before = await dependencies.navigation.current();
    requireResearchAccess(dependencies.navigation, before);
    let audit: ResearchClaimAuditProjection;
    try {
      audit = await dependencies.audit.read({ bytes: input_bytes, stage_attempt_ref: auditStage.attempt_ref, stage_request_sha256: auditStage.request_sha256 });
    } catch { failCode("WORKFLOW_OUTPUT_CORRUPT"); }
    const items = audit.claim_audit_items;
    if (!Array.isArray(items)) failCode("WORKFLOW_OUTPUT_CORRUPT");
    const requested = requireAuditedHandles(items, context);
    let citation: Awaited<ReturnType<CloudflareEvidenceResolver["resolveCitationSet"]>>;
    try {
      citation = await dependencies.evidence_resolver.resolveCitationSet({
        handle_refs: requested, scope_snapshot_ref: context.freeze.scope_snapshot_ref, access: dependencies.navigation.access,
      });
    } catch { failCode("WORKFLOW_AUTHORITY_STALE"); }
    requireResolvedEvidence(citation, requested, context, before);
    const after = await dependencies.navigation.current();
    requireResearchAccess(dependencies.navigation, after);
    const finalContext = await dependencies.context.read({ request, principal, input_bytes });
    requireContext(request, principal, finalContext);
    if (!sameJson(context.freeze, finalContext.freeze) || !sameJson(context.manifest, finalContext.manifest) ||
        !sameJson(context.stage_five.evidence_pack, finalContext.stage_five.evidence_pack) ||
        !sameJson(before, after)) failCode("WORKFLOW_AUTHORITY_STALE");
    return encodeResearchCitationsResult({
      operation_id: request.operation_id, stage_attempt_ref: attempt_ref, stage_request_sha256: request_sha256,
      audit: { stage_attempt_ref: auditStage.attempt_ref, stage_request_sha256: auditStage.request_sha256,
        input_sha256: request.input_manifest.sha256, claim_audit_items: items },
      freeze_ref: finalContext.freeze.freeze_ref, manifest_ref: finalContext.manifest.manifest_ref,
      scope_snapshot_ref: finalContext.freeze.scope_snapshot_ref, evidence_pack_ref: finalContext.stage_five.evidence_pack.pack_ref,
      citation_resolution_receipt: citation.receipt,
    });
  };
}
