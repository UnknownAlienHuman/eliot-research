import { IdentifierSchema, type AllowedReferenceManifest, type VersionedRef } from "@eliotr/contracts";
import {
  canonicalEvidenceJson,
  type CloudflareEvidenceResolver,
  type NavigationReadAuthority,
} from "@eliotr/cloudflare-evidence";
import { ModelGatewayExecutionError } from "@eliotr/cloudflare-ai";
import {
  createFrozenResearchReferenceManifestService,
  createResearchReferenceManifestReader,
  type BuildReferenceManifestInput,
  type ReferenceManifestPolicyProfile,
  type TrustedModelPromptParameters,
} from "@eliotr/cloudflare-research";
import type {
  ResearchClaimAuditInputReader,
  ResearchClaimAuditInputSnapshot,
  ResearchClaimAuditPromptDependencies,
} from "@eliotr/cloudflare-research-stages";
import type { ReferenceManifestStore } from "@eliotr/policy";
import type { ModelCallInput } from "@eliotr/research";
import {
  parseRequest,
  readWorkflowObject,
  type WorkflowPrincipal,
} from "@eliotr/cloudflare-workflows";
import { decodeModelRouteDeployment, type ModelRouteDeployment } from "@eliotr/platform-cloudflare";
import { readStartedResearchStageAttempt } from "./research-synthesis-prompt.js";

const AUDIT_STAGE = "AUDIT_CLAIMS" as const;
const SHA256 = /^[a-f0-9]{64}$/u;

export interface ResearchClaimAuditPromptDependenciesInput {
  readonly database: D1Database;
  readonly work_bucket: R2Bucket;
  readonly operation_id: string;
  readonly principal: Pick<WorkflowPrincipal, "principal_ref" | "credential_generation" | "deployment_generation">;
  /** Reads and revalidates the native committed Stage14/freeze/source input. */
  readonly audit_input: ResearchClaimAuditInputReader;
  readonly navigation: NavigationReadAuthority;
  readonly evidence_resolver: CloudflareEvidenceResolver;
  /** Reuse the semantic composition's frozen manifest reader when available. */
  readonly manifest_store?: Pick<ReferenceManifestStore, "get">;
  /** Explicitly installed by the Worker; no audit prompt defaults are selected here. */
  readonly trusted_parameters: TrustedModelPromptParameters;
  readonly request_timeout_ms: number;
}

interface BoundAuditInput {
  readonly input: ModelCallInput;
  readonly deployment: ModelRouteDeployment;
  readonly audit: ResearchClaimAuditInputSnapshot;
}

function fail(message: string, retryable = false, cause?: unknown): never {
  throw new ModelGatewayExecutionError("MODEL_GATEWAY_PROMPT_COMPILE_FAILED", message, { retryable, cause });
}

function freezeDeep<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) freezeDeep(child);
    Object.freeze(value);
  }
  return value;
}

function snapshot<T>(value: T, label: string): T {
  try {
    return freezeDeep(JSON.parse(canonicalEvidenceJson(value)) as T);
  } catch (cause) {
    fail(`${label} is not canonical`, false, cause);
  }
}

function identifier(value: unknown, label: string): string {
  const parsed = IdentifierSchema.safeParse(value);
  if (!parsed.success) fail(`${label} is invalid`);
  return parsed.data;
}

function principalSnapshot(
  value: ResearchClaimAuditPromptDependenciesInput["principal"],
): WorkflowPrincipal {
  return Object.freeze({
    principal_ref: identifier(value?.principal_ref, "principal_ref"),
    credential_generation: identifier(value?.credential_generation, "credential_generation"),
    deployment_generation: identifier(value?.deployment_generation, "deployment_generation"),
  });
}

function deploymentSnapshot(value: ModelRouteDeployment, label: string): ModelRouteDeployment {
  try {
    const decoded = decodeModelRouteDeployment(value);
    return Object.freeze({
      route_ref: decoded.route_ref,
      route_version: decoded.route_version,
      prompt_generation: decoded.prompt_generation,
      schema_generation: decoded.schema_generation,
      parameters_digest: decoded.parameters_digest,
      pricing_snapshot_ref: decoded.pricing_snapshot_ref,
    });
  } catch (cause) {
    fail(`${label} is invalid`, false, cause);
  }
}

function sameRef(left: VersionedRef, right: VersionedRef): boolean {
  return left.id === right.id && left.revision === right.revision;
}

function refKey(ref: VersionedRef): string {
  return `${ref.id}:${ref.revision}`;
}

function sortedRefKeys(refs: readonly VersionedRef[]): readonly string[] {
  return Object.freeze(refs.map(refKey).sort());
}

function sameDeployment(left: ModelRouteDeployment, right: ModelRouteDeployment): boolean {
  return left.route_ref === right.route_ref && left.route_version === right.route_version &&
    left.prompt_generation === right.prompt_generation && left.schema_generation === right.schema_generation &&
    left.parameters_digest === right.parameters_digest && left.pricing_snapshot_ref === right.pricing_snapshot_ref;
}

function validateTrustedParameters(value: TrustedModelPromptParameters): TrustedModelPromptParameters {
  if (value === null || typeof value !== "object" || Array.isArray(value) ||
      typeof value.prompt !== "string" || value.prompt.length === 0 ||
      !Number.isSafeInteger(value.max_tokens) || value.max_tokens < 1) {
    fail("installed audit model parameters are invalid");
  }
  return snapshot(value, "installed audit model parameters");
}

function manifestPolicy(manifest: AllowedReferenceManifest): ReferenceManifestPolicyProfile {
  return Object.freeze({
    allowed_tool_definition_refs: Object.freeze([...manifest.allowed_tool_definition_refs]),
    allowed_verifier_refs: Object.freeze([...manifest.allowed_verifier_refs]),
    permitted_anchor_and_precision_ceilings: Object.freeze([...manifest.permitted_anchor_and_precision_ceilings]),
    provider_and_policy_generations: Object.freeze({ ...manifest.provider_and_policy_generations }),
    stale_or_revoked_entries: Object.freeze([...manifest.stale_or_revoked_entries]),
    permitted_acquisition_or_expansion_routes: Object.freeze([...manifest.permitted_acquisition_or_expansion_routes]),
    disclosure_ceiling: manifest.disclosure_ceiling,
    allowed_use: Object.freeze([...manifest.allowed_use]),
    expires_at: manifest.expires_at,
  });
}

function assertAuditBinding(
  input: ModelCallInput,
  deployment: ModelRouteDeployment,
  principal: WorkflowPrincipal,
  operationId: string,
  audit: ResearchClaimAuditInputSnapshot,
): ModelRouteDeployment {
  const manifestHandleKeys = sortedRefKeys(audit.context.manifest.allowed_evidence_handle_refs);
  const packHandleKeys = sortedRefKeys(audit.context.stage_five.evidence_pack.resolved_evidence.map((item) => item.handle.handle_ref));
  const auditHandleKeys = sortedRefKeys(audit.evidence.map((item) => item.handle.handle_ref));
  const verifiedHandleKeys = sortedRefKeys(audit.verify.source_verification.resolved.map((item) => item.handle_ref));
  if (audit.protocol !== "eliotr.research.audit-claims-input.v1" ||
      audit.request.stage !== AUDIT_STAGE || audit.request.operation_id !== operationId ||
      audit.principal.principal_ref !== principal.principal_ref ||
      audit.principal.credential_generation !== principal.credential_generation ||
      audit.principal.deployment_generation !== principal.deployment_generation ||
      audit.context.operation_id !== operationId || audit.context.principal_ref !== principal.principal_ref ||
      audit.context.credential_generation !== principal.credential_generation ||
      audit.context.deployment_generation !== principal.deployment_generation ||
      audit.verify.operation_id !== operationId || !SHA256.test(audit.evidence_input_sha256) ||
      audit.verify.synthesis.stage_attempt_ref !== audit.synthesis.stage_attempt_ref ||
      audit.verify.synthesis.stage_request_sha256 !== audit.synthesis.stage_request_sha256 ||
      audit.verify.synthesis.output_sha256 !== audit.synthesis.output_sha256 ||
      !sameRef(audit.verify.normalization.section_ref, audit.normalization.section_ref) ||
      audit.verify.normalization.required_precision !== audit.normalization.required_precision ||
      audit.verify.normalization.required_source_class !== audit.normalization.required_source_class ||
      !sameRef(audit.claims.section_ref, audit.normalization.section_ref) ||
      !audit.verifier.qualified || !audit.verifier.current ||
      audit.verifier.deployment_generation !== principal.deployment_generation ||
      !audit.context.manifest.allowed_verifier_refs.includes(audit.verifier.verifier_ref) ||
      !sameRef(audit.verify.freeze_ref, audit.context.freeze.freeze_ref) ||
      !sameRef(audit.verify.scope_snapshot_ref, audit.context.freeze.scope_snapshot_ref) ||
      !sameRef(audit.verify.manifest_ref, audit.context.manifest.manifest_ref) ||
      !sameRef(audit.context.manifest.scope_snapshot_ref, audit.context.freeze.scope_snapshot_ref) ||
      canonicalEvidenceJson(manifestHandleKeys) !== canonicalEvidenceJson(packHandleKeys) ||
      new Set(auditHandleKeys).size !== auditHandleKeys.length ||
      auditHandleKeys.some((key) => !manifestHandleKeys.includes(key)) ||
      canonicalEvidenceJson(verifiedHandleKeys) !== canonicalEvidenceJson(auditHandleKeys)) {
    fail("audit input is not bound to the current frozen authority");
  }
  const expectedDeployment = deploymentSnapshot(audit.verifier.deployment, "audit verifier deployment");
  if (!sameDeployment(deployment, expectedDeployment) ||
      input.route_ref !== expectedDeployment.route_ref ||
      input.prompt_generation !== expectedDeployment.prompt_generation ||
      input.schema_generation !== expectedDeployment.schema_generation ||
      canonicalEvidenceJson(input.evidence_pack) !== canonicalEvidenceJson(audit.context.stage_five.evidence_pack) ||
      input.max_input_bytes !== audit.max_context_bytes) {
    fail("audit model call is not bound to the verified frozen context");
  }
  if (!Number.isSafeInteger(input.max_input_bytes) || input.max_input_bytes < 1 ||
      !Number.isSafeInteger(audit.max_context_bytes) || audit.max_context_bytes < 1) {
    fail("audit model context bound is invalid");
  }
  return expectedDeployment;
}

function renderAuditPrompt(installedPrompt: string, audit: ResearchClaimAuditInputSnapshot): string {
  const verifiedAudit = {
    audit_input_sha256: audit.evidence_input_sha256,
    synthesis: audit.synthesis,
    verifier: {
      verifier_ref: audit.verifier.verifier_ref,
      verifier_schema_generation: audit.verifier.verifier_schema_generation,
      deployment: audit.verifier.deployment,
    },
    claims: audit.claims.claims.map((claim) => ({
      claim_ref: claim.claim_ref,
      text: claim.text,
      text_digest: claim.text_digest,
      kind: claim.kind,
      span: claim.span,
      required_precision: claim.required_precision,
      required_source_class: claim.required_source_class,
      support_handle_refs: claim.support_handle_refs,
      counterevidence_handle_refs: claim.counterevidence_handle_refs,
    })),
    evidence: audit.evidence.map((item) => ({
      handle: item.handle,
      exact_excerpt: item.exact_excerpt,
      source_revision_content_sha256: item.source_revision_content_sha256,
      scope_snapshot_digest: item.scope_snapshot_digest,
      source_class: item.source_class,
      ...(item.source_title === undefined ? {} : { source_title: item.source_title }),
      instruction_taint: item.instruction_taint,
      allowed_effects: item.allowed_effects,
    })),
    source_verification: audit.verify.source_verification.resolved,
    audit_policy: audit.audit_policy,
  };
  return `${installedPrompt}\n\nVerified claims and evidence for this audit:\n${canonicalEvidenceJson(verifiedAudit)}`;
}

export function createResearchClaimAuditPromptDependencies(
  rawInput: ResearchClaimAuditPromptDependenciesInput,
): ResearchClaimAuditPromptDependencies {
  if (rawInput === null || typeof rawInput !== "object" || typeof rawInput.database?.prepare !== "function" ||
      typeof rawInput.work_bucket?.get !== "function" || typeof rawInput.navigation?.current !== "function" ||
      typeof rawInput.navigation?.sources !== "function" || typeof rawInput.evidence_resolver?.resolveHandle !== "function" ||
      typeof rawInput.audit_input?.read !== "function") {
    fail("audit prompt dependencies are invalid");
  }
  const operationId = identifier(rawInput.operation_id, "operation_id");
  const principal = principalSnapshot(rawInput.principal);
  const trustedParameters = validateTrustedParameters(rawInput.trusted_parameters);
  if (!Number.isSafeInteger(rawInput.request_timeout_ms) || rawInput.request_timeout_ms < 1 ||
      rawInput.request_timeout_ms > 300_000) {
    fail("audit request timeout is invalid");
  }
  const input = Object.freeze({
    database: rawInput.database,
    work_bucket: rawInput.work_bucket,
    operation_id: operationId,
    principal,
    audit_input: rawInput.audit_input,
    navigation: rawInput.navigation,
    evidence_resolver: rawInput.evidence_resolver,
    trusted_parameters: trustedParameters,
    request_timeout_ms: rawInput.request_timeout_ms,
  });
  const manifestStore = rawInput.manifest_store ?? createResearchReferenceManifestReader({
    database: input.database,
    work_bucket: input.work_bucket,
    navigation: input.navigation,
  });
  const manifestService = createFrozenResearchReferenceManifestService(manifestStore);
  const pending = new WeakMap<object, BoundAuditInput>();

  async function readBound(rawModelInput: ModelCallInput, rawDeployment: ModelRouteDeployment): Promise<BoundAuditInput> {
    const modelInput = snapshot(rawModelInput, "audit model call input");
    const deployment = deploymentSnapshot(rawDeployment, "audit model deployment");
    await input.navigation.current();
    if (input.navigation.access.principal_ref !== input.principal.principal_ref ||
        input.navigation.access.credential_generation !== input.principal.credential_generation) {
      fail("owner navigation is not current", true);
    }
    const started = await readStartedResearchStageAttempt({
      database: input.database,
      operation_id: input.operation_id,
      stage: AUDIT_STAGE,
      scope_snapshot_id: input.navigation.scope.snapshot_id,
      scope_snapshot_revision: input.navigation.scope.revision,
    }, input.principal);
    const inputBytes = await readWorkflowObject(input.work_bucket, started.request.input_manifest, true);
    const audit = await input.audit_input.read({
      request: parseRequest(started.request),
      principal: input.principal,
      input_bytes: new Uint8Array(inputBytes),
    });
    assertAuditBinding(modelInput, deployment, input.principal, input.operation_id, audit);
    return Object.freeze({ input: modelInput, deployment, audit });
  }

  return Object.freeze({
    manifest_service: manifestService,
    build_manifest_input: async (
      rawModelInput: ModelCallInput,
      deployment: ModelRouteDeployment,
    ): Promise<BuildReferenceManifestInput> => {
      const bound = await readBound(rawModelInput, deployment);
      pending.set(rawModelInput as unknown as object, bound);
      return Object.freeze({
        evidence_pack: snapshot(bound.audit.context.stage_five.evidence_pack, "frozen audit evidence pack"),
        navigation: input.navigation,
        resolver: input.evidence_resolver,
        policy: manifestPolicy(bound.audit.context.manifest),
        manifest_ref: snapshot(bound.audit.context.manifest.manifest_ref, "frozen audit manifest reference"),
        model_route_ref: bound.deployment.route_ref,
        max_context_bytes: bound.audit.max_context_bytes,
      });
    },
    resolve_trusted_parameters: async (
      rawModelInput: ModelCallInput,
      deployment: ModelRouteDeployment,
      audit: ResearchClaimAuditInputSnapshot,
    ): Promise<TrustedModelPromptParameters> => {
      const key = rawModelInput as unknown as object;
      const bound = pending.get(key) ?? await readBound(rawModelInput, deployment);
      pending.delete(key);
      assertAuditBinding(bound.input, bound.deployment, input.principal, input.operation_id, audit);
      if (canonicalEvidenceJson(audit) !== canonicalEvidenceJson(bound.audit)) {
        fail("audit input changed during prompt compilation", true);
      }
      return Object.freeze({
        ...trustedParameters,
        prompt: renderAuditPrompt(trustedParameters.prompt, bound.audit),
      });
    },
    request_timeout_ms: input.request_timeout_ms,
  });
}
