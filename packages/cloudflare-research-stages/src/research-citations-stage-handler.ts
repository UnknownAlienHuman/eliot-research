import {
  canonicalEvidenceJson,
  evidenceSha256Bytes,
  evidenceUtf8Bytes,
  type CloudflareEvidenceResolver,
  type EvidenceSourceAuthority,
  type NavigationReadAuthority,
} from "@eliotr/cloudflare-evidence";
import {
  CitationResolutionReceiptSchema,
  IdentifierSchema,
  ResolvedEvidenceSchema,
  type CitationResolutionReceipt,
  type ResolvedEvidence,
  type VersionedRef,
} from "@eliotr/contracts";
import {
  createEvidenceFreezePostSynthesisContextReader,
  sameEvidence,
  type EvidenceFreezeCommittedReaders,
  type EvidenceFreezeSynthesisContext,
  type EvidenceFreezeSynthesisReaderEnvironment,
  type EvidenceFreezeVerificationContextReader,
} from "@eliotr/cloudflare-research";
import {
  digest,
  fail,
  parseRequest,
  readCommittedStageLineage,
  snapshotPrincipal,
  WorkflowCheckpointError,
  WorkflowCheckpointStore,
  type StageRequest,
  type WorkflowPrincipal,
  type WorkflowStageHandler,
} from "@eliotr/cloudflare-workflows";
import {
  decodeResearchClaimAuditResult,
  type ResearchClaimAuditResult,
} from "./research-claim-audit-result.js";
import { encodeResearchCitationsResult } from "./research-citations-result.js";

const AUDIT_STAGE = "AUDIT_CLAIMS" as const;
const CITATIONS_STAGE = "RESOLVE_CITATIONS" as const;
const MAX_REFS = 512;

export interface ResearchCitationsStageDependencies {
  readonly database: D1Database;
  readonly navigation: NavigationReadAuthority;
  readonly evidence_resolver: CloudflareEvidenceResolver;
  /** Reader created with createEvidenceFreezePostSynthesisContextReader(..., "RESOLVE_CITATIONS"). */
  readonly context: EvidenceFreezeVerificationContextReader;
}

export type ResearchCitationsStageHandler = WorkflowStageHandler;

function failCorrupt(): never {
  return fail("WORKFLOW_OUTPUT_CORRUPT");
}

function failAuthority(): never {
  return fail("WORKFLOW_AUTHORITY_STALE");
}

function snapshotNavigationAccess(
  value: NavigationReadAuthority["access"],
): NavigationReadAuthority["access"] {
  const snapshot = {
    principal_ref: value.principal_ref,
    client_class: value.client_class,
    credential_generation: value.credential_generation,
  };
  if (!IdentifierSchema.safeParse(snapshot.principal_ref).success ||
      !IdentifierSchema.safeParse(snapshot.credential_generation).success) return failAuthority();
  return Object.freeze(snapshot);
}

function detached<T>(value: T): T {
  try {
    return JSON.parse(canonicalEvidenceJson(value)) as T;
  } catch {
    return failAuthority();
  }
}

function sameRef(left: VersionedRef, right: VersionedRef): boolean {
  return left.id === right.id && left.revision === right.revision;
}

function refKey(ref: VersionedRef): string {
  return `${ref.id}:${ref.revision}`;
}

function sameRefSet(left: readonly VersionedRef[], right: readonly VersionedRef[]): boolean {
  if (left.length !== right.length) return false;
  const leftKeys = left.map(refKey).sort();
  const rightKeys = right.map(refKey).sort();
  return new Set(leftKeys).size === leftKeys.length && new Set(rightKeys).size === rightKeys.length &&
    leftKeys.every((key, index) => key === rightKeys[index]);
}

function sameStringSet(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  const leftValues = [...left].sort();
  const rightValues = [...right].sort();
  return new Set(leftValues).size === leftValues.length && new Set(rightValues).size === rightValues.length &&
    leftValues.every((value, index) => value === rightValues[index]);
}

function stableSources(value: readonly EvidenceSourceAuthority[]): string {
  return canonicalEvidenceJson([...value].sort((left, right) => (
    left.source_revision_ref < right.source_revision_ref ? -1 : left.source_revision_ref > right.source_revision_ref ? 1 : 0
  )));
}

function stableContext(value: EvidenceFreezeSynthesisContext): string {
  return canonicalEvidenceJson({
    operation_id: value.operation_id,
    investigation_id: value.investigation_id,
    current_revision: value.current_revision,
    principal_ref: value.principal_ref,
    credential_generation: value.credential_generation,
    deployment_generation: value.deployment_generation,
    authorization_receipt_ref: value.authorization_receipt_ref,
    freeze: value.freeze,
    manifest: value.manifest,
    stage_five: value.stage_five,
    w1_head: value.w1_head,
  });
}

function stableLineage(value: Awaited<ReturnType<typeof readCommittedStageLineage>>): string {
  return canonicalEvidenceJson({
    request: value.request,
    request_sha256: value.request_sha256,
    attempt_ref: value.attempt_ref,
    receipt: value.receipt,
  });
}

function auditedHandleRefs(audit: ResearchClaimAuditResult): readonly VersionedRef[] {
  const refs = new Map<string, VersionedRef>();
  for (const claim of audit.claims) {
    for (const ref of [...claim.support_handle_refs, ...claim.counterevidence_handle_refs]) {
      refs.set(refKey(ref), ref);
    }
  }
  const result = [...refs.values()].sort((left, right) => refKey(left).localeCompare(refKey(right)));
  if (result.length > MAX_REFS) return failCorrupt();
  return result;
}

function requireCommittedAuditLineage(
  request: StageRequest,
  audit: ResearchClaimAuditResult,
  lineage: Awaited<ReturnType<typeof readCommittedStageLineage>>,
): void {
  if (lineage.request.stage !== AUDIT_STAGE ||
      lineage.request.operation_id !== request.operation_id ||
      lineage.request.investigation_ref.id !== request.investigation_ref.id ||
      lineage.request.handler_generation !== request.handler_generation ||
      lineage.receipt.engine_state !== "CHECKPOINTED" ||
      lineage.receipt.input_manifest_ref !== lineage.request.input_manifest.object_ref ||
      lineage.receipt.investigation_ref.id !== request.investigation_ref.id ||
      lineage.receipt.investigation_ref.revision !== request.investigation_ref.revision ||
      canonicalEvidenceJson(lineage.receipt.output_manifest) !== canonicalEvidenceJson(request.input_manifest) ||
      audit.protocol !== "eliotr.research.audit-claims-result.v1" ||
      audit.stage !== AUDIT_STAGE ||
      audit.operation_id !== request.operation_id ||
      audit.investigation_ref.id !== request.investigation_ref.id ||
      audit.investigation_ref.revision !== lineage.request.investigation_ref.revision ||
      audit.stage_attempt_ref !== lineage.attempt_ref ||
      audit.stage_request_sha256 !== lineage.request_sha256) {
    return failCorrupt();
  }
}

function requireContextBinding(
  request: StageRequest,
  principal: WorkflowPrincipal,
  audit: ResearchClaimAuditResult,
  context: EvidenceFreezeSynthesisContext,
): void {
  if (context.operation_id !== request.operation_id ||
      context.investigation_id !== request.investigation_ref.id ||
      context.current_revision !== request.investigation_ref.revision ||
      context.principal_ref !== principal.principal_ref ||
      context.credential_generation !== principal.credential_generation ||
      context.deployment_generation !== principal.deployment_generation ||
      !sameRef(context.freeze.freeze_ref, audit.freeze_ref) ||
      !sameRef(context.freeze.scope_snapshot_ref, audit.scope_snapshot_ref) ||
      !sameRef(context.manifest.manifest_ref, audit.manifest_ref) ||
      !sameRef(context.manifest.scope_snapshot_ref, context.freeze.scope_snapshot_ref) ||
      !sameRef(context.stage_five.scope_snapshot_ref, context.freeze.scope_snapshot_ref) ||
      context.stage_five.operation_id !== request.operation_id ||
      context.stage_five.investigation_ref.id !== request.investigation_ref.id ||
      context.stage_five.principal_ref !== principal.principal_ref ||
      context.w1_head.investigation_id !== request.investigation_ref.id ||
      context.w1_head.revision !== request.investigation_ref.revision ||
      context.w1_head.principal_ref !== principal.principal_ref ||
      context.w1_head.deployment_generation !== principal.deployment_generation) {
    return failAuthority();
  }
}

function requireAdmittedRefs(
  refs: readonly VersionedRef[],
  context: EvidenceFreezeSynthesisContext,
): Map<string, ResearchEvidencePackEntry> {
  const manifestRefs = new Set(context.manifest.allowed_evidence_handle_refs.map(refKey));
  const frozenByRef = new Map(context.freeze.included_evidence.map((item) => [refKey(item.handle_ref), item]));
  const packedByRef = new Map(context.stage_five.evidence_pack.resolved_evidence.map((item) => [refKey(item.handle.handle_ref), item]));
  const result = new Map<string, ResearchEvidencePackEntry>();
  for (const ref of refs) {
    const key = refKey(ref);
    const frozen = frozenByRef.get(key);
    const packed = packedByRef.get(key);
    if (!manifestRefs.has(key) || frozen === undefined || packed === undefined || frozen.digest !== packed.handle.excerpt_sha256) {
      failCorrupt();
    }
    result.set(key, { frozen, packed });
  }
  return result;
}

type ResearchEvidencePackEntry = {
  readonly frozen: EvidenceFreezeSynthesisContext["freeze"]["included_evidence"][number];
  readonly packed: EvidenceFreezeSynthesisContext["stage_five"]["evidence_pack"]["resolved_evidence"][number];
};

function sourceRevisionRefs(entries: ReadonlyMap<string, ResearchEvidencePackEntry>): readonly string[] {
  return [...new Set([...entries.values()].map((entry) => entry.packed.handle.source_revision_ref))].sort();
}

function requireCurrentSource(
  entry: ResearchEvidencePackEntry,
  evidence: ResolvedEvidence,
  source: EvidenceSourceAuthority,
  expectedScope: VersionedRef,
  authorizationReceiptRef: string,
  access: NavigationReadAuthority["access"],
): void {
  if (!sameRef(entry.packed.handle.handle_ref, evidence.handle.handle_ref) ||
      entry.frozen.digest !== evidence.handle.excerpt_sha256 ||
      !sameRef(evidence.handle.scope_snapshot_ref, expectedScope) ||
      evidence.handle.terminal_state !== "LIVE" ||
      evidence.authorization_receipt_ref !== authorizationReceiptRef ||
      evidence.credential_generation !== access.credential_generation ||
      source.source_revision_ref !== evidence.handle.source_revision_ref ||
      source.source_owner_generation !== evidence.handle.source_owner_generation ||
      source.content_sha256 !== evidence.source_revision_content_sha256 ||
      source.object_residency_key_digest !== evidence.handle.object_residency_key_digest ||
      source.purge_state !== "LIVE" ||
      !source.allowed_use.includes("research") ||
      evidence.handle.excerpt_sha256 !== entry.packed.handle.excerpt_sha256 ||
      !sameEvidence(entry.packed, evidence)) {
    return failAuthority();
  }
}

async function requireExactExcerpt(evidence: ResolvedEvidence): Promise<void> {
  let bytes: Uint8Array;
  try { bytes = evidenceUtf8Bytes(evidence.exact_excerpt); }
  catch { return failAuthority(); }
  if (bytes.byteLength !== evidence.handle.excerpt_byte_length ||
      await evidenceSha256Bytes(bytes) !== evidence.handle.excerpt_sha256) return failAuthority();
}

function requireResolverReceipt(
  receipt: CitationResolutionReceipt,
  expectedRefs: readonly VersionedRef[],
  evidence: readonly ResolvedEvidence[],
  scope: VersionedRef,
): void {
  if (!sameRef(receipt.scope_snapshot_ref, scope) ||
      !sameRefSet(receipt.requested_handle_refs, expectedRefs)) return failCorrupt();
  const resolvedRefs = receipt.resolved.map((item) => item.handle_ref);
  const rejectedRefs = receipt.rejected.map((item) => item.handle_ref);
  if (!sameRefSet([...resolvedRefs, ...rejectedRefs], expectedRefs) ||
      new Set([...resolvedRefs, ...rejectedRefs].map(refKey)).size !== resolvedRefs.length + rejectedRefs.length ||
      evidence.length !== resolvedRefs.length ||
      !sameRefSet(evidence.map((item) => item.handle.handle_ref), resolvedRefs)) return failCorrupt();
  const receiptByRef = new Map(receipt.resolved.map((item) => [refKey(item.handle_ref), item]));
  for (const item of evidence) {
    const row = receiptByRef.get(refKey(item.handle.handle_ref));
    if (row === undefined || row.excerpt_sha256 !== item.handle.excerpt_sha256 ||
        row.verification_receipt_ref !== item.verification_receipt_ref) return failCorrupt();
  }
}

async function resolveAndValidate(
  dependencies: ResearchCitationsStageDependencies,
  navigationAccess: NavigationReadAuthority["access"],
  refs: readonly VersionedRef[],
  entries: ReadonlyMap<string, ResearchEvidencePackEntry>,
  context: EvidenceFreezeSynthesisContext,
): Promise<{
  readonly receipt: CitationResolutionReceipt;
  readonly evidence: readonly ResolvedEvidence[];
  readonly grant_fingerprint: string;
}> {
  let beforeGrant: Awaited<ReturnType<NavigationReadAuthority["current"]>>;
  try { beforeGrant = detached(await dependencies.navigation.current()); }
  catch { return failAuthority(); }
  const beforeGrantFingerprint = canonicalEvidenceJson(beforeGrant);
  const beforeAuthorizationReceiptRef = beforeGrant.authorization_receipt_ref;
  if (!beforeGrant.allowed_use.includes("research")) return failAuthority();
  const revisions = sourceRevisionRefs(entries);
  let beforeSources: readonly EvidenceSourceAuthority[];
  try { beforeSources = detached(await dependencies.navigation.sources(revisions, detached(beforeGrant))); }
  catch { return failAuthority(); }
  if (beforeSources.length !== revisions.length || new Set(beforeSources.map((item) => item.source_revision_ref)).size !== revisions.length) {
    return failAuthority();
  }
  if (!sameStringSet(beforeSources.map((item) => item.source_revision_ref), revisions)) return failAuthority();
  const beforeSourcesFingerprint = stableSources(beforeSources);
  const sourceByRevision = new Map(beforeSources.map((source) => [source.source_revision_ref, source]));
  let result: Awaited<ReturnType<CloudflareEvidenceResolver["resolveCitationSet"]>>;
  try {
    result = await dependencies.evidence_resolver.resolveCitationSet({
      handle_refs: refs,
      scope_snapshot_ref: context.freeze.scope_snapshot_ref,
      access: navigationAccess,
    });
  } catch { return failAuthority(); }
  const receiptParsed = CitationResolutionReceiptSchema.safeParse(result.receipt);
  const evidenceParsed = zResolvedEvidence(result.resolved_evidence);
  if (!receiptParsed.success || !evidenceParsed.success) return failCorrupt();
  const receipt = receiptParsed.data;
  const evidence = evidenceParsed.data;
  requireResolverReceipt(receipt, refs, evidence, context.freeze.scope_snapshot_ref);
  const evidenceByRef = new Map(evidence.map((item) => [refKey(item.handle.handle_ref), item]));
  await Promise.all(evidence.map(async (item) => {
    const entry = entries.get(refKey(item.handle.handle_ref));
    const source = sourceByRevision.get(item.handle.source_revision_ref);
    if (entry === undefined || source === undefined) return failAuthority();
    requireCurrentSource(entry, item, source, context.freeze.scope_snapshot_ref, beforeAuthorizationReceiptRef, navigationAccess);
    await requireExactExcerpt(item);
  }));
  if (evidenceByRef.size !== evidence.length) return failCorrupt();
  let afterGrant: Awaited<ReturnType<NavigationReadAuthority["current"]>>;
  let afterSources: readonly EvidenceSourceAuthority[];
  try {
    afterGrant = detached(await dependencies.navigation.current());
    afterSources = detached(await dependencies.navigation.sources(revisions, detached(afterGrant)));
  } catch { return failAuthority(); }
  if (afterSources.length !== revisions.length || new Set(afterSources.map((item) => item.source_revision_ref)).size !== revisions.length ||
      !sameStringSet(afterSources.map((item) => item.source_revision_ref), revisions)) return failAuthority();
  if (beforeGrantFingerprint !== canonicalEvidenceJson(afterGrant) ||
      beforeSourcesFingerprint !== stableSources(afterSources)) return failAuthority();
  return { receipt, evidence, grant_fingerprint: beforeGrantFingerprint };
}

function zResolvedEvidence(value: readonly ResolvedEvidence[]) {
  return ResolvedEvidenceSchema.array().safeParse(value);
}

/** Resolve the exact Stage14 audited handle union under the current frozen authority. */
export function createResearchCitationsStageHandler(
  dependencies: ResearchCitationsStageDependencies,
): ResearchCitationsStageHandler {
  if (dependencies === null || typeof dependencies !== "object" ||
      typeof dependencies.database?.prepare !== "function" ||
      typeof dependencies.navigation?.current !== "function" ||
      typeof dependencies.navigation?.sources !== "function" ||
      typeof dependencies.evidence_resolver?.resolveCitationSet !== "function" ||
      typeof dependencies.context?.read !== "function") return fail("WORKFLOW_INPUT_INVALID");
  const checkpoints = new WorkflowCheckpointStore(dependencies.database);
  return async (rawInput) => {
    const request = parseRequest(rawInput.request);
    const principal = snapshotPrincipal(rawInput.principal);
    const attemptParsed = IdentifierSchema.safeParse(rawInput.attempt_ref);
    if (request.stage !== CITATIONS_STAGE || !(rawInput.input_bytes instanceof Uint8Array) || !attemptParsed.success) {
      return fail("WORKFLOW_INPUT_INVALID");
    }
    const attemptRef = attemptParsed.data;
    const navigationAccess = snapshotNavigationAccess(dependencies.navigation.access);
    if (navigationAccess.principal_ref !== principal.principal_ref ||
        navigationAccess.credential_generation !== principal.credential_generation) return failAuthority();
    const inputBytes = new Uint8Array(rawInput.input_bytes);
    const requestSha256 = await digest(new TextEncoder().encode(JSON.stringify(request)));
    if (request.input_manifest.byte_length !== inputBytes.byteLength ||
        request.input_manifest.sha256 !== await digest(inputBytes)) return failCorrupt();
    const predecessor = await readCommittedStageLineage(checkpoints, request.operation_id, AUDIT_STAGE);
    const audit = decodeResearchClaimAuditResult(inputBytes);
    requireCommittedAuditLineage(request, audit, predecessor);
    let context: EvidenceFreezeSynthesisContext;
    try { context = await dependencies.context.read({ request, principal, input_bytes: inputBytes }); }
    catch (error) {
      if (error instanceof WorkflowCheckpointError) throw error;
      return failAuthority();
    }
    requireContextBinding(request, principal, audit, context);
    const refs = auditedHandleRefs(audit);
    const entries = requireAdmittedRefs(refs, context);
    const contextBeforeText = stableContext(context);
    const predecessorBeforeText = stableLineage(predecessor);
    const w1Before = await checkpoints.head(request.investigation_ref.id);
    if (w1Before === null || stableContext({ ...context, w1_head: w1Before }) !== contextBeforeText) return failAuthority();
    const resolution = await resolveAndValidate(dependencies, navigationAccess, refs, entries, context);
    let contextAfter: EvidenceFreezeSynthesisContext;
    try { contextAfter = await dependencies.context.read({ request, principal, input_bytes: inputBytes }); }
    catch (error) {
      if (error instanceof WorkflowCheckpointError) throw error;
      return failAuthority();
    }
    requireContextBinding(request, principal, audit, contextAfter);
    const predecessorAfter = await readCommittedStageLineage(checkpoints, request.operation_id, AUDIT_STAGE);
    const w1After = await checkpoints.head(request.investigation_ref.id);
    if (w1After === null ||
        stableContext(contextAfter) !== contextBeforeText ||
        stableLineage(predecessorAfter) !== predecessorBeforeText ||
        stableContext({ ...contextAfter, w1_head: w1After }) !== contextBeforeText) return failAuthority();
    let terminalGrantFingerprint: string;
    try { terminalGrantFingerprint = canonicalEvidenceJson(detached(await dependencies.navigation.current())); }
    catch { return failAuthority(); }
    if (terminalGrantFingerprint !== resolution.grant_fingerprint) return failAuthority();
    try {
      return await encodeResearchCitationsResult({
        audit,
        investigation_ref: request.investigation_ref,
        audit_output_sha256: request.input_manifest.sha256,
        evidence_pack_ref: contextAfter.stage_five.evidence_pack.pack_ref,
        stage_attempt_ref: attemptRef,
        stage_request_sha256: requestSha256,
        citation_resolution_receipt: resolution.receipt,
      });
    } catch (error) {
      if (error instanceof WorkflowCheckpointError) return failCorrupt();
      return failCorrupt();
    }
  };
}

/** Compose the handler with the canonical post-synthesis freeze reader. */
export function createResearchCitationsStageHandlerFromFreeze(
  environment: EvidenceFreezeSynthesisReaderEnvironment,
  navigation: NavigationReadAuthority,
  readers: EvidenceFreezeCommittedReaders,
  dependencies: Omit<ResearchCitationsStageDependencies, "context" | "navigation">,
): ResearchCitationsStageHandler {
  return createResearchCitationsStageHandler({
    ...dependencies,
    navigation,
    context: createEvidenceFreezePostSynthesisContextReader(environment, navigation, readers, CITATIONS_STAGE),
  });
}
