import {
  canonicalEvidenceJson,
  evidenceSha256Bytes,
  evidenceUtf8Bytes,
  type CloudflareEvidenceResolver,
  type NavigationReadAuthority,
  type EvidenceSourceAuthority,
  type ScopeAuthorization,
} from "@eliotr/cloudflare-evidence";
import {
  decodeModelGatewayBody,
} from "@eliotr/cloudflare-ai";
import {
  IdentifierSchema,
  IsoDateTimeSchema,
  ResolvedEvidenceSchema,
  Sha256Schema,
  VersionedRefSchema,
  type ResolvedEvidence,
  type VersionedRef,
} from "@eliotr/contracts";
import {
  decodeSynthesisClaimsCandidateV2,
  normalizeSynthesisClaimsCandidateV2,
  type NormalizedSynthesisClaims,
} from "@eliotr/research";
import {
  createEvidenceFreezePostSynthesisContextReader,
  readCommittedResearchSynthesisOutput,
  sameEvidence,
  type EvidenceFreezeSynthesisContext,
  type EvidenceFreezeVerificationContextReader,
  type EvidenceFreezeSynthesisReaderEnvironment,
  type EvidenceFreezeCommittedReaders,
} from "@eliotr/cloudflare-research";
import {
  digest,
  fail,
  parseRequest,
  snapshotPrincipal,
  type StageRequest,
  type WorkflowPrincipal,
} from "@eliotr/cloudflare-workflows";
import {
  readCommittedStageLineage,
  WorkflowCheckpointStore,
} from "@eliotr/cloudflare-workflows";
import type { EvidenceFreezeModelDefinition } from "@eliotr/cloudflare-research";
import {
  decodeResearchVerificationResultV2,
  type ResearchVerificationResultV2,
  type ResearchVerificationSourceReadbackV2,
} from "./research-verification-result-v2.js";
import {
  auditInputMaterial,
  normalizedClaimMaterial,
  refKey,
  sameRef,
  sortedRefKeys,
  stableSourceAuthorities,
  stableW1Head,
  verifyClaimMaterial,
} from "./research-claim-audit-input-material.js";
import {
  parseResearchClaimAuditPolicy,
  type ResearchClaimAuditPolicy,
} from "./research-claim-audit-policy.js";
import { z } from "zod";

const PROTOCOL = "eliotr.research.audit-claims-input.v1" as const;
const MAX_REFS = 512;

const ModelDeploymentSchema = z.object({
  route_ref: IdentifierSchema,
  route_version: IdentifierSchema,
  prompt_generation: IdentifierSchema,
  schema_generation: IdentifierSchema,
  parameters_digest: Sha256Schema,
  pricing_snapshot_ref: IdentifierSchema,
}).strict();

const ResearchClaimAuditNormalizationConfigSchema = z.object({
  section_ref: VersionedRefSchema,
  required_precision: IdentifierSchema,
  required_source_class: IdentifierSchema,
}).strict();

const ResearchClaimAuditVerifierAuthoritySchema = z.object({
  allowed_verifier_refs: z.array(IdentifierSchema).min(1).max(MAX_REFS),
  verifier_ref: IdentifierSchema,
  verifier_schema_generation: IdentifierSchema,
  deployment: ModelDeploymentSchema,
  deployment_generation: IdentifierSchema,
  qualification_receipt_ref: IdentifierSchema,
  qualification_expires_at: IsoDateTimeSchema,
  qualified: z.boolean(),
  current: z.boolean(),
}).strict();

export type ResearchClaimAuditNormalizationConfig = z.infer<typeof ResearchClaimAuditNormalizationConfigSchema>;
export type ResearchClaimAuditModelDeployment = EvidenceFreezeModelDefinition["deployment"];

export interface ResearchClaimAuditVerifierAuthority {
  readonly allowed_verifier_refs: readonly string[];
  readonly verifier_ref: string;
  readonly verifier_schema_generation: string;
  readonly deployment: ResearchClaimAuditModelDeployment;
  readonly deployment_generation: string;
  readonly qualification_receipt_ref: string;
  readonly qualification_expires_at: string;
  readonly qualified: boolean;
  readonly current: boolean;
}

export interface ResearchClaimAuditVerifierCurrentInput {
  readonly operation_id: string;
  readonly investigation_ref: VersionedRef;
  readonly scope_snapshot_ref: VersionedRef;
  readonly principal_ref: string;
  readonly credential_generation: string;
  readonly deployment_generation: string;
}

/** Server-owned semantic verifier selection. No field has a production default. */
export interface ResearchClaimAuditVerifierSelection {
  readonly authority: ResearchClaimAuditVerifierAuthority;
  readonly read_current: (input: ResearchClaimAuditVerifierCurrentInput) => Promise<unknown>;
}

export type ResearchClaimAuditEvidenceSnapshot = Pick<
  ResolvedEvidence,
  "handle" | "exact_excerpt" | "source_revision_content_sha256" | "scope_snapshot_digest" | "instruction_taint" | "allowed_effects"
> & { readonly source_class: string; readonly source_title?: string };

export interface ResearchClaimAuditSynthesisBinding {
  readonly stage_attempt_ref: string;
  readonly stage_request_sha256: string;
  readonly output_sha256: string;
}

export interface ResearchClaimAuditInputSnapshot {
  readonly protocol: typeof PROTOCOL;
  readonly request: StageRequest;
  readonly principal: Readonly<Pick<WorkflowPrincipal, "principal_ref" | "credential_generation" | "deployment_generation">>;
  readonly context: EvidenceFreezeSynthesisContext;
  readonly verify: ResearchVerificationResultV2;
  readonly synthesis: ResearchClaimAuditSynthesisBinding;
  readonly normalization: ResearchClaimAuditNormalizationConfig;
  readonly claims: NormalizedSynthesisClaims;
  readonly evidence: readonly ResearchClaimAuditEvidenceSnapshot[];
  readonly verifier: ResearchClaimAuditVerifierAuthority;
  readonly audit_policy: ResearchClaimAuditPolicy;
  readonly evidence_input_sha256: string;
  readonly max_context_bytes: number;
}

export interface ResearchClaimAuditInputReaderDependencies {
  readonly database: D1Database;
  readonly work_bucket: R2Bucket;
  readonly navigation: NavigationReadAuthority;
  readonly evidence_resolver: CloudflareEvidenceResolver;
  readonly recheck_authority: Parameters<typeof readCommittedResearchSynthesisOutput>[0]["recheck_authority"];
  readonly context: EvidenceFreezeVerificationContextReader;
  readonly normalization: ResearchClaimAuditNormalizationConfig;
  readonly verifier: ResearchClaimAuditVerifierSelection;
  /** Explicit server-owned policy; no Stage14 audit dimension has a default. */
  readonly audit_policy: ResearchClaimAuditPolicy;
}

export interface ResearchClaimAuditInputReader {
  read(input: {
    readonly request: StageRequest;
    readonly principal: WorkflowPrincipal;
    readonly input_bytes: Uint8Array;
  }): Promise<ResearchClaimAuditInputSnapshot>;
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}

/** Canonical clone prevents caller-owned nested objects from changing after an await. */
function detached<T>(value: T, code: "WORKFLOW_INPUT_INVALID" | "WORKFLOW_OUTPUT_CORRUPT" | "WORKFLOW_AUTHORITY_STALE" = "WORKFLOW_INPUT_INVALID"): T {
  let text: string;
  try { text = canonicalEvidenceJson(value); }
  catch { fail(code); }
  try {
    const parsed = JSON.parse(text) as T;
    if (canonicalEvidenceJson(parsed) !== text) fail(code);
    return deepFreeze(parsed);
  } catch {
    fail(code);
  }
}

function snapshotNavigationGrant(value: ScopeAuthorization): ScopeAuthorization {
  return detached(value, "WORKFLOW_AUTHORITY_STALE");
}

function snapshotSourceAuthorities(value: readonly EvidenceSourceAuthority[]): readonly EvidenceSourceAuthority[] {
  return detached(value, "WORKFLOW_AUTHORITY_STALE");
}

function snapshotResolvedEvidence(value: readonly ResolvedEvidence[]): readonly ResolvedEvidence[] {
  const parsed = z.array(ResolvedEvidenceSchema).safeParse(value);
  if (!parsed.success) fail("WORKFLOW_AUTHORITY_STALE");
  return detached(parsed.data, "WORKFLOW_AUTHORITY_STALE");
}

function snapshotNormalization(value: ResearchClaimAuditNormalizationConfig): ResearchClaimAuditNormalizationConfig {
  const parsed = ResearchClaimAuditNormalizationConfigSchema.safeParse(value);
  if (!parsed.success) fail("WORKFLOW_INPUT_INVALID");
  return detached(parsed.data);
}

function parseVerifierAuthority(
  value: unknown,
  code: "WORKFLOW_INPUT_INVALID" | "WORKFLOW_AUTHORITY_STALE",
): ResearchClaimAuditVerifierAuthority {
  const parsed = ResearchClaimAuditVerifierAuthoritySchema.safeParse(value);
  if (!parsed.success || new Set(parsed.data.allowed_verifier_refs).size !== parsed.data.allowed_verifier_refs.length ||
      !parsed.data.allowed_verifier_refs.includes(parsed.data.verifier_ref)) fail(code);
  return detached(parsed.data) as ResearchClaimAuditVerifierAuthority;
}

function snapshotVerifierSelection(value: ResearchClaimAuditVerifierSelection): ResearchClaimAuditVerifierSelection {
  if (value === null || typeof value !== "object" || typeof value.read_current !== "function") fail("WORKFLOW_INPUT_INVALID");
  const authority = parseVerifierAuthority(value.authority, "WORKFLOW_INPUT_INVALID");
  if (!authority.qualified || !authority.current) fail("WORKFLOW_INPUT_INVALID");
  return Object.freeze({ authority, read_current: value.read_current });
}

function requireVerifierUsable(
  authority: ResearchClaimAuditVerifierAuthority,
  principal: Readonly<Pick<WorkflowPrincipal, "deployment_generation">>,
  now: number,
  code: "WORKFLOW_INPUT_INVALID" | "WORKFLOW_AUTHORITY_STALE",
): void {
  if (!authority.qualified || !authority.current || authority.deployment_generation !== principal.deployment_generation ||
      !Number.isFinite(Date.parse(authority.qualification_expires_at)) ||
      Date.parse(authority.qualification_expires_at) <= now) fail(code);
}

function authorityNow(navigation: NavigationReadAuthority): number {
  const value = Date.parse(navigation.timestamp());
  if (!Number.isFinite(value)) fail("WORKFLOW_AUTHORITY_STALE");
  return value;
}

function assertVerifyClaimBinding(
  value: ResearchVerificationResultV2,
  normalized: NormalizedSynthesisClaims,
  config: ResearchClaimAuditNormalizationConfig,
): void {
  const expected = {
    section_ref: normalized.section_ref,
    required_precision: config.required_precision,
    required_source_class: config.required_source_class,
    claims: normalizedClaimMaterial(normalized).map((claim) => ({
      claim_ref: claim.claim_ref,
      claim_text_digest: claim.text_digest,
      claim_kind: claim.kind,
      support_handle_refs: claim.support_handle_refs,
      counterevidence_handle_refs: claim.counterevidence_handle_refs,
    })),
    cited_handle_refs: sortedRefKeys(normalized.cited_handle_refs),
  };
  if (canonicalEvidenceJson(expected) !== canonicalEvidenceJson(verifyClaimMaterial(value))) fail("WORKFLOW_OUTPUT_CORRUPT");
}

function assertContextBinding(
  request: StageRequest,
  principal: Readonly<Pick<WorkflowPrincipal, "principal_ref" | "credential_generation" | "deployment_generation">>,
  context: EvidenceFreezeSynthesisContext,
  verify: ResearchVerificationResultV2,
): void {
  if (context.operation_id !== request.operation_id || context.investigation_id !== request.investigation_ref.id ||
      context.current_revision !== request.investigation_ref.revision || context.principal_ref !== principal.principal_ref ||
      context.credential_generation !== principal.credential_generation || context.deployment_generation !== principal.deployment_generation ||
      !sameRef(context.freeze.freeze_ref, verify.freeze_ref) || !sameRef(context.freeze.scope_snapshot_ref, verify.scope_snapshot_ref) ||
      !sameRef(context.manifest.manifest_ref, verify.manifest_ref) ||
      !sameRef(context.manifest.scope_snapshot_ref, verify.scope_snapshot_ref) ||
      !sameRef(context.stage_five.scope_snapshot_ref, verify.scope_snapshot_ref) ||
      context.stage_five.operation_id !== request.operation_id || context.stage_five.investigation_ref.id !== request.investigation_ref.id ||
      context.stage_five.principal_ref !== principal.principal_ref ||
      context.stage_five.evidence_pack.scope_snapshot_ref.id !== verify.scope_snapshot_ref.id ||
      context.stage_five.evidence_pack.scope_snapshot_ref.revision !== verify.scope_snapshot_ref.revision ||
      context.w1_head.investigation_id !== request.investigation_ref.id || context.w1_head.revision !== request.investigation_ref.revision ||
      context.w1_head.principal_ref !== principal.principal_ref || context.w1_head.deployment_generation !== principal.deployment_generation) {
    fail("WORKFLOW_AUTHORITY_STALE");
  }
}

function assertCommittedVerifyLineage(
  request: StageRequest,
  verify: ResearchVerificationResultV2,
  lineage: Awaited<ReturnType<typeof readCommittedStageLineage>>,
): void {
  if (lineage.request.stage !== "VERIFY" || lineage.request.operation_id !== request.operation_id ||
      lineage.request.investigation_ref.id !== request.investigation_ref.id ||
      lineage.request.handler_generation !== request.handler_generation || lineage.receipt.engine_state !== "CHECKPOINTED" ||
      lineage.receipt.investigation_ref.id !== request.investigation_ref.id ||
      lineage.receipt.output_manifest.object_ref !== request.input_manifest.object_ref ||
      lineage.receipt.output_manifest.sha256 !== request.input_manifest.sha256 ||
      verify.operation_id !== request.operation_id || verify.stage_attempt_ref !== lineage.attempt_ref ||
      verify.stage_request_sha256 !== lineage.request_sha256) fail("WORKFLOW_OUTPUT_CORRUPT");
}

function assertCurrentSource(
  source: EvidenceSourceAuthority,
  evidence: ResolvedEvidence,
  expected: ResearchVerificationSourceReadbackV2,
): void {
  if (source.source_revision_ref !== evidence.handle.source_revision_ref ||
      source.source_owner_generation !== evidence.handle.source_owner_generation ||
      source.content_sha256 !== evidence.source_revision_content_sha256 ||
      source.object_residency_key_digest !== evidence.handle.object_residency_key_digest || source.purge_state !== "LIVE" ||
      !source.allowed_use.includes("research") || !sameRef(expected.handle_ref, evidence.handle.handle_ref) ||
      expected.source_revision_ref !== evidence.handle.source_revision_ref ||
      expected.source_owner_generation !== evidence.handle.source_owner_generation ||
      expected.excerpt_sha256 !== evidence.handle.excerpt_sha256 ||
      expected.source_revision_content_sha256 !== evidence.source_revision_content_sha256 ||
      expected.scope_snapshot_digest !== evidence.scope_snapshot_digest ||
      expected.authorization_receipt_ref !== evidence.authorization_receipt_ref ||
      expected.credential_generation !== evidence.credential_generation ||
      expected.verification_receipt_ref !== evidence.verification_receipt_ref) fail("WORKFLOW_AUTHORITY_STALE");
}

async function assertExactExcerpt(evidence: ResolvedEvidence): Promise<void> {
  const bytes = evidenceUtf8Bytes(evidence.exact_excerpt);
  if (bytes.byteLength !== evidence.handle.excerpt_byte_length ||
      await evidenceSha256Bytes(bytes) !== evidence.handle.excerpt_sha256) fail("WORKFLOW_AUTHORITY_STALE");
}

function currentEvidenceSnapshot(value: ResolvedEvidence, sourceClass: string): ResearchClaimAuditEvidenceSnapshot {
  const parsed = ResolvedEvidenceSchema.safeParse(value);
  if (!parsed.success) fail("WORKFLOW_AUTHORITY_STALE");
  return detached({
    handle: parsed.data.handle,
    exact_excerpt: parsed.data.exact_excerpt,
    source_revision_content_sha256: parsed.data.source_revision_content_sha256,
    scope_snapshot_digest: parsed.data.scope_snapshot_digest,
    source_class: sourceClass,
    instruction_taint: parsed.data.instruction_taint,
    allowed_effects: parsed.data.allowed_effects,
    ...(parsed.data.source_title === undefined ? {} : { source_title: parsed.data.source_title }),
  }, "WORKFLOW_AUTHORITY_STALE");
}

export function createResearchClaimAuditInputReader(
  dependencies: ResearchClaimAuditInputReaderDependencies,
): ResearchClaimAuditInputReader {
  if (dependencies === null || typeof dependencies !== "object" ||
      typeof dependencies.database?.prepare !== "function" || typeof dependencies.work_bucket?.get !== "function" ||
      typeof dependencies.navigation?.current !== "function" || typeof dependencies.navigation?.sources !== "function" ||
      typeof dependencies.evidence_resolver?.resolveCitationSet !== "function" ||
      typeof dependencies.recheck_authority !== "function" || typeof dependencies.context?.read !== "function") {
    fail("WORKFLOW_INPUT_INVALID");
  }
  const normalization = snapshotNormalization(dependencies.normalization);
  const verifierSelection = snapshotVerifierSelection(dependencies.verifier);
  let auditPolicy: ResearchClaimAuditPolicy;
  try { auditPolicy = parseResearchClaimAuditPolicy(dependencies.audit_policy); }
  catch { fail("WORKFLOW_INPUT_INVALID"); }
  const checkpoints = new WorkflowCheckpointStore(dependencies.database);
  const navigationAccess = detached(dependencies.navigation.access, "WORKFLOW_INPUT_INVALID");
  const navigationScopeRef = detached({ id: dependencies.navigation.scope.snapshot_id, revision: dependencies.navigation.scope.revision });

  return Object.freeze({
    async read(input: {
      readonly request: StageRequest;
      readonly principal: WorkflowPrincipal;
      readonly input_bytes: Uint8Array;
    }): Promise<ResearchClaimAuditInputSnapshot> {
      const request = parseRequest(input.request);
      const parsedPrincipal = snapshotPrincipal(input.principal);
      const principal = Object.freeze({
        principal_ref: parsedPrincipal.principal_ref,
        credential_generation: parsedPrincipal.credential_generation,
        deployment_generation: parsedPrincipal.deployment_generation,
      });
      if (request.stage !== "AUDIT_CLAIMS" || !(input.input_bytes instanceof Uint8Array)) fail("WORKFLOW_INPUT_INVALID");
      const inputBytes = new Uint8Array(input.input_bytes);
      const initialNavigation = snapshotNavigationGrant(await dependencies.navigation.current());
      if (navigationAccess.principal_ref !== principal.principal_ref ||
          navigationAccess.credential_generation !== principal.credential_generation ||
          !initialNavigation.allowed_use.includes("research")) fail("WORKFLOW_AUTHORITY_STALE");
      const verifierInput: ResearchClaimAuditVerifierCurrentInput = {
        operation_id: request.operation_id,
        investigation_ref: detached(request.investigation_ref),
        scope_snapshot_ref: navigationScopeRef,
        principal_ref: principal.principal_ref,
        credential_generation: principal.credential_generation,
        deployment_generation: principal.deployment_generation,
      };
      let verifierBefore: ResearchClaimAuditVerifierAuthority;
      try { verifierBefore = parseVerifierAuthority(await verifierSelection.read_current(verifierInput), "WORKFLOW_AUTHORITY_STALE"); }
      catch (error) { if (error instanceof Error && "code" in error) throw error; fail("WORKFLOW_AUTHORITY_STALE"); }
      requireVerifierUsable(verifierBefore, principal, authorityNow(dependencies.navigation), "WORKFLOW_AUTHORITY_STALE");
      if (canonicalEvidenceJson(verifierBefore) !== canonicalEvidenceJson(verifierSelection.authority)) fail("WORKFLOW_AUTHORITY_STALE");

      if (inputBytes.byteLength !== request.input_manifest.byte_length ||
          await digest(inputBytes) !== request.input_manifest.sha256) fail("WORKFLOW_OUTPUT_CORRUPT");
      const verify = detached(await decodeResearchVerificationResultV2(inputBytes), "WORKFLOW_OUTPUT_CORRUPT");
      const verifyLineage = await readCommittedStageLineage(checkpoints, request.operation_id, "VERIFY");
      assertCommittedVerifyLineage(request, verify, verifyLineage);
      const w1Before = detached(await checkpoints.head(request.investigation_ref.id), "WORKFLOW_AUTHORITY_STALE");
      let context: EvidenceFreezeSynthesisContext;
      try { context = await dependencies.context.read({ request, principal: parsedPrincipal, input_bytes: inputBytes }); }
      catch (error) { if (error instanceof Error && "code" in error) throw error; fail("WORKFLOW_AUTHORITY_STALE"); }
      context = detached(context, "WORKFLOW_OUTPUT_CORRUPT");
      assertContextBinding(request, principal, context, verify);
      if (!context.manifest.allowed_verifier_refs.includes(verifierBefore.verifier_ref) ||
          context.stage_ten_input.model_profile_definition.max_context_bytes < 1 ||
          !Number.isSafeInteger(context.stage_ten_input.model_profile_definition.max_context_bytes)) fail("WORKFLOW_AUTHORITY_STALE");

      const synthesisReadback = await readCommittedResearchSynthesisOutput({
        database: dependencies.database,
        work_bucket: dependencies.work_bucket,
        operation_id: request.operation_id,
        principal: parsedPrincipal,
        recheck_authority: dependencies.recheck_authority,
      });
      if (synthesisReadback === null || synthesisReadback.stage !== "SYNTHESIZE" ||
          synthesisReadback.stage_attempt_ref !== verify.synthesis.stage_attempt_ref ||
          synthesisReadback.stage_request_sha256 !== verify.synthesis.stage_request_sha256 ||
          synthesisReadback.output.output_sha256 !== verify.synthesis.output_sha256) fail("WORKFLOW_OUTPUT_CORRUPT");
      const synthesis = Object.freeze({
        stage: synthesisReadback.stage,
        stage_attempt_ref: synthesisReadback.stage_attempt_ref,
        stage_request_sha256: synthesisReadback.stage_request_sha256,
        output: detached(synthesisReadback.output, "WORKFLOW_OUTPUT_CORRUPT"),
        bytes: new Uint8Array(synthesisReadback.bytes),
      });
      let normalized: NormalizedSynthesisClaims;
      try {
        const assistant = (await decodeModelGatewayBody(synthesis.bytes)).assistant_content;
        normalized = await normalizeSynthesisClaimsCandidateV2({
          candidate: decodeSynthesisClaimsCandidateV2(assistant),
          operation_id: request.operation_id,
          section_ref: normalization.section_ref,
          allowed_handle_refs: context.freeze.included_evidence.map((item) => item.handle_ref),
          required_precision: normalization.required_precision,
          required_source_class: normalization.required_source_class,
        });
      } catch { fail("WORKFLOW_OUTPUT_CORRUPT"); }
      normalized = detached(normalized, "WORKFLOW_OUTPUT_CORRUPT");
      assertVerifyClaimBinding(verify, normalized, normalization);

      const cited = [...normalized.cited_handle_refs];
      const expectedRows = new Map(verify.source_verification.resolved.map((row) => [refKey(row.handle_ref), row]));
      if (expectedRows.size !== cited.length || cited.some((ref) => !expectedRows.has(refKey(ref)))) fail("WORKFLOW_OUTPUT_CORRUPT");
      const sourceRevisionRefs = [...new Set(verify.source_verification.resolved.map((row) => row.source_revision_ref))].sort();
      const resolutionNavigation = snapshotNavigationGrant(await dependencies.navigation.current());
      if (canonicalEvidenceJson(initialNavigation) !== canonicalEvidenceJson(resolutionNavigation) ||
          !resolutionNavigation.allowed_use.includes("research")) fail("WORKFLOW_AUTHORITY_STALE");
      let sources: readonly EvidenceSourceAuthority[];
      try { sources = snapshotSourceAuthorities(await dependencies.navigation.sources(sourceRevisionRefs, resolutionNavigation)); }
      catch { fail("WORKFLOW_AUTHORITY_STALE"); }
      const sourceByRef = new Map(sources.map((source) => [source.source_revision_ref, source]));
      if (sources.length !== sourceRevisionRefs.length || sourceByRef.size !== sourceRevisionRefs.length) fail("WORKFLOW_AUTHORITY_STALE");

      let resolved: readonly ResolvedEvidence[];
      try {
        const result = await dependencies.evidence_resolver.resolveCitationSet({
          handle_refs: cited,
          scope_snapshot_ref: context.freeze.scope_snapshot_ref,
          access: navigationAccess,
        });
        if (!sameRef(result.receipt.scope_snapshot_ref, context.freeze.scope_snapshot_ref) ||
            result.receipt.rejected.length !== 0 || !result.receipt.all_material_citations_resolved ||
            result.receipt.requested_count !== cited.length || result.receipt.resolved_count !== cited.length ||
            canonicalEvidenceJson(sortedRefKeys(result.receipt.requested_handle_refs)) !== canonicalEvidenceJson(sortedRefKeys(cited)) ||
            canonicalEvidenceJson(sortedRefKeys(result.receipt.resolved.map((item) => item.handle_ref))) !== canonicalEvidenceJson(sortedRefKeys(cited)) ||
            result.resolved_evidence.length !== cited.length ||
            canonicalEvidenceJson(sortedRefKeys(result.resolved_evidence.map((item) => item.handle.handle_ref))) !==
              canonicalEvidenceJson(sortedRefKeys(cited))) fail("WORKFLOW_AUTHORITY_STALE");
        resolved = snapshotResolvedEvidence(result.resolved_evidence);
      } catch (error) { if (error instanceof Error && "code" in error) throw error; fail("WORKFLOW_AUTHORITY_STALE"); }

      const packedByRef = new Map(context.stage_five.evidence_pack.resolved_evidence.map((item) => [refKey(item.handle.handle_ref), item]));
      const frozenByRef = new Map(context.freeze.included_evidence.map((item) => [refKey(item.handle_ref), item]));
      await Promise.all(resolved.map(async (item) => {
        const expected = expectedRows.get(refKey(item.handle.handle_ref));
        const source = sourceByRef.get(item.handle.source_revision_ref);
        const packed = packedByRef.get(refKey(item.handle.handle_ref));
        const frozen = frozenByRef.get(refKey(item.handle.handle_ref));
        if (expected === undefined || source === undefined || packed === undefined || frozen === undefined ||
            !sameEvidence(packed, item) || frozen.digest !== item.handle.excerpt_sha256 ||
            item.handle.terminal_state !== "LIVE" || !sameRef(item.handle.scope_snapshot_ref, context.freeze.scope_snapshot_ref) ||
            item.authorization_receipt_ref !== resolutionNavigation.authorization_receipt_ref ||
            item.credential_generation !== navigationAccess.credential_generation) fail("WORKFLOW_AUTHORITY_STALE");
        assertCurrentSource(source, item, expected);
        await assertExactExcerpt(item);
      }));
      const finalNavigation = snapshotNavigationGrant(await dependencies.navigation.current());
      let finalSources: readonly EvidenceSourceAuthority[];
      try { finalSources = snapshotSourceAuthorities(await dependencies.navigation.sources(sourceRevisionRefs, finalNavigation)); }
      catch { fail("WORKFLOW_AUTHORITY_STALE"); }
      if (finalSources.length !== sourceRevisionRefs.length) fail("WORKFLOW_AUTHORITY_STALE");
      let verifierAfter: ResearchClaimAuditVerifierAuthority;
      try { verifierAfter = parseVerifierAuthority(await verifierSelection.read_current(verifierInput), "WORKFLOW_AUTHORITY_STALE"); }
      catch (error) { if (error instanceof Error && "code" in error) throw error; fail("WORKFLOW_AUTHORITY_STALE"); }
      requireVerifierUsable(verifierAfter, principal, authorityNow(dependencies.navigation), "WORKFLOW_AUTHORITY_STALE");
      const w1After = detached(await checkpoints.head(request.investigation_ref.id), "WORKFLOW_AUTHORITY_STALE");
      if (canonicalEvidenceJson(initialNavigation) !== canonicalEvidenceJson(finalNavigation) ||
          canonicalEvidenceJson(stableSourceAuthorities(sources)) !== canonicalEvidenceJson(stableSourceAuthorities(finalSources)) ||
          canonicalEvidenceJson(verifierBefore) !== canonicalEvidenceJson(verifierAfter) ||
          canonicalEvidenceJson(stableW1Head(w1Before)) !== canonicalEvidenceJson(stableW1Head(w1After)) ||
          canonicalEvidenceJson(stableW1Head(w1After)) !== canonicalEvidenceJson(stableW1Head(context.w1_head))) fail("WORKFLOW_AUTHORITY_STALE");

      const evidence = detached(resolved.map((item) => {
        const source = sourceByRef.get(item.handle.source_revision_ref);
        if (source === undefined) return fail("WORKFLOW_AUTHORITY_STALE");
        return currentEvidenceSnapshot(item, source.source_class);
      }), "WORKFLOW_AUTHORITY_STALE");
      const synthesisBinding = detached({
        stage_attempt_ref: synthesis.stage_attempt_ref,
        stage_request_sha256: synthesis.stage_request_sha256,
        output_sha256: synthesis.output.output_sha256,
      });
      const material = auditInputMaterial({ request, principal, context, verify, synthesis: synthesisBinding,
        normalization, claims: normalized, evidence, verifier: verifierAfter, audit_policy: auditPolicy });
      const materialText = canonicalEvidenceJson(material);
      const materialBytes = evidenceUtf8Bytes(materialText);
      if (new TextDecoder("utf-8", { fatal: true }).decode(materialBytes) !== materialText ||
          materialBytes.byteLength > context.stage_ten_input.model_profile_definition.max_context_bytes) fail("WORKFLOW_OUTPUT_CORRUPT");
      const evidenceInputSha256 = await evidenceSha256Bytes(materialBytes);
      const terminalNavigation = snapshotNavigationGrant(await dependencies.navigation.current());
      if (!terminalNavigation.allowed_use.includes("research") ||
          canonicalEvidenceJson(initialNavigation) !== canonicalEvidenceJson(terminalNavigation) ||
          canonicalEvidenceJson(finalNavigation) !== canonicalEvidenceJson(terminalNavigation)) fail("WORKFLOW_AUTHORITY_STALE");
      return detached({
        protocol: PROTOCOL,
        request,
        principal,
        context,
        verify,
        synthesis: synthesisBinding,
        normalization,
        claims: normalized,
        evidence,
        verifier: verifierAfter,
        audit_policy: auditPolicy,
        evidence_input_sha256: evidenceInputSha256,
        max_context_bytes: context.stage_ten_input.model_profile_definition.max_context_bytes,
      }, "WORKFLOW_AUTHORITY_STALE");
    },
  });
}

/** Convenience composition for the canonical freeze readers used by the Worker. */
export function createResearchClaimAuditInputReaderFromFreeze(
  environment: EvidenceFreezeSynthesisReaderEnvironment,
  navigation: NavigationReadAuthority,
  readers: EvidenceFreezeCommittedReaders,
  dependencies: Omit<ResearchClaimAuditInputReaderDependencies, "context" | "database" | "work_bucket" | "navigation"> & {
    readonly database: D1Database;
    readonly work_bucket: R2Bucket;
  },
): ResearchClaimAuditInputReader {
  return createResearchClaimAuditInputReader({
    ...dependencies,
    database: dependencies.database,
    work_bucket: dependencies.work_bucket,
    navigation,
    context: createEvidenceFreezePostSynthesisContextReader(environment, navigation, readers, "AUDIT_CLAIMS"),
  });
}
