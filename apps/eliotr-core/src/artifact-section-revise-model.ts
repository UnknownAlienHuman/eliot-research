import { canonicalDigest, canonicalJson } from "@eliotr/platform-cloudflare";
import { createCloudflareEvidenceResolver, createD1EvidenceAuthorityPort, createR2EvidenceContentPort,
  evidenceSha256Bytes, type NavigationReadAuthority } from "@eliotr/cloudflare-evidence";
import { createArtifactCowModelRuntime, createD1ResearchModelPricingQuotePort, createResearchReferenceManifestService,
  createResearchReferenceManifestStore, parseResearchModelProfileDefinition, decodeEvidenceFreezeStageInput,
  type ArtifactCowSectionProducerDependencies, type ReferenceManifestStorageContext, type ResearchModelSpendPolicy } from "@eliotr/cloudflare-research";
import { WorkflowCheckpointStore, readCommittedStageLineage, readWorkflowObject, type ArtifactSectionReviseAttempt } from "@eliotr/cloudflare-workflows";
import { parseResearchClaimAuditPolicy } from "@eliotr/cloudflare-research-stages";
import type { ModelCallInput, TrustedSemanticClaimAuditInput } from "@eliotr/research";
import type { AuthenticatedRequestContext } from "@eliotr/interfaces";
import { createOwnerArtifactCowModelAdmission } from "./artifact-cow-model-admission.js";
import type { createOwnerArtifactCowPorts } from "./artifact-section-revise-ports.js";
import { modelGatewayConfiguration, parseResearchSemanticConfiguration, researchSemanticPromptParameters } from "./research-semantic-server.js";
import { resolveResearchSemanticConfig } from "./research-semantic-config-revision.js";
import type { Env } from "./env.js";
import { HttpRequestError } from "./http-errors.js";

const key = (ref: { readonly id: string; readonly revision: number }) => ref.id + ":" + ref.revision;
function deny(message: string): never { throw new HttpRequestError("ARTIFACT_SECTION_REVISE_STALE", 409, message); }

/** Uses installed semantic policy and the existing governed W3/model runtime. */
export async function createOwnerArtifactCowModel(input: {
  readonly env: Env; readonly context: AuthenticatedRequestContext; readonly attempt: ArtifactSectionReviseAttempt;
  readonly navigation: NavigationReadAuthority; readonly cow: Awaited<ReturnType<typeof createOwnerArtifactCowPorts>>;
}) {
  const { env, context, attempt, navigation, cow } = input;
  const config = parseResearchSemanticConfiguration((await resolveResearchSemanticConfig({ env, database: env.CORE_DB })).config_json);
  const modelProfile = await parseResearchModelProfileDefinition(JSON.parse(env.ELIOTR_MODEL_PROFILE_DEFINITION_JSON ?? "null"));
  if (modelProfile.config_provenance_ref !== env.ELIOTR_MODEL_PROFILE_PROVENANCE_REF || Date.parse(modelProfile.expires_at) <= Date.now() ||
      !config.audit.allowed_verifier_refs.includes(config.audit.verifier_ref) || !modelProfile.policy.allowed_verifier_refs.includes(config.audit.verifier_ref)) deny("Current model/verifier policy is unavailable");
  const spend = attempt.request.report_admission_witness.spend_policy as ResearchModelSpendPolicy;
  const auditRule = spend.rules.find((rule) => rule.stage === "AUDIT_CLAIMS");
  if (auditRule === undefined) deny("Independent verification has no admitted REPORT slot");
  const environment = env.ENVIRONMENT === "development" ? "TEST" : "PRODUCTION";
  const admission = await createOwnerArtifactCowModelAdmission({ env, attempt, navigation,
    evidence_pack: cow.fresh_pack, deployment_environment: environment });
  const resolver = createCloudflareEvidenceResolver({ authority: createD1EvidenceAuthorityPort({
    core_database: env.CORE_DB, search_database: env.SEARCH_DB }),
    content: createR2EvidenceContentPort({ evidence_bucket: env.EVIDENCE_BUCKET }) });
  const { content_digest: _content, ...historicalDomains } = cow.parent.manifest_residency;
  const domains = { ...historicalDomains, scope_domain_id: navigation.scope.snapshot_id, access_domain_id: context.principal_ref };
  const stores = new Map<string, ReturnType<typeof createResearchReferenceManifestStore>>();
  const manifests = createResearchReferenceManifestService({ navigation, resolver, store: {
    async put(manifest) {
      const bytes = new TextEncoder().encode(canonicalJson(manifest));
      const authorization = await navigation.current();
      const storageContext: ReferenceManifestStorageContext = { principal_ref: context.principal_ref,
        credential_generation: context.credential_generation, scope_snapshot_ref: attempt.request.scope_snapshot_ref,
        manifest_residency_key: { ...domains, content_digest: { algorithm: "sha256", digest: await evidenceSha256Bytes(bytes) } },
        policy_authority_ref: authorization.policy_authority_ref, authorization_receipt_ref: authorization.authorization_receipt_ref,
        scope_snapshot_digest: navigation.scope.digest, pack_ref: cow.fresh_pack.pack_ref, trace_ref: cow.fresh_pack.trace_ref,
        stage_attempt_ref: attempt.attempt_ref, stage_request_sha256: attempt.request_sha256, created_at: new Date().toISOString() };
      const store = createResearchReferenceManifestStore({ database: env.CORE_DB, work_bucket: env.WORK_BUCKET,
        context: storageContext, navigation });
      stores.set(key(manifest.manifest_ref), store);
      return (await store.persist(manifest)).manifest_ref;
    },
    get: async (ref) => stores.get(key(ref))?.get(ref) ?? null,
  } });
  const runtime = createArtifactCowModelRuntime({ database: env.CORE_DB, work_bucket: env.WORK_BUCKET,
    gateway: modelGatewayConfiguration(env), signal: context.request.signal, deployment_environment: environment,
    pricing: createD1ResearchModelPricingQuotePort(env.CORE_DB), prepare: admission.prepare, revalidateExisting: admission.revalidateExisting,
    prompt: { manifest_service: manifests, request_timeout_ms: Math.min(config.synthesis.request_timeout_ms, config.audit.request_timeout_ms),
      build_manifest_input: async (call, deployment) => ({ evidence_pack: call.evidence_pack, navigation, resolver,
        policy: modelProfile.policy, manifest_ref: { id: "artifact-cow-manifest-" + await canonicalDigest({ output: call.output_object_ref,
          attempt: attempt.attempt_ref }), revision: 1 }, model_route_ref: deployment.route_ref,
        max_context_bytes: Math.min(modelProfile.max_context_bytes, call.max_input_bytes) }),
      resolve_trusted_parameters: async (call: ModelCallInput) => {
        const exactContext = await admission.promptContext(call);
        const body = JSON.parse(exactContext) as { protocol?: string };
        const selected = body.protocol === "eliotr.artifact-section-synthesis-input.v1" ? config.synthesis
          : body.protocol === "eliotr.artifact-section-independent-verification-input.v1" ? config.audit : deny("Unrecognized COW model input");
        return { ...researchSemanticPromptParameters(selected.trusted_parameters),
          prompt: selected.trusted_parameters.prompt + "\n\n" + exactContext };
      } },
  });
  const activeVerifier = await runtime.deployments.resolve(auditRule.deployment.route_ref);
  if (canonicalJson(activeVerifier) !== canonicalJson(auditRule.deployment)) deny("Independent verifier deployment changed");
  const stageTen = await readCommittedStageLineage(new WorkflowCheckpointStore(env.CORE_DB), cow.historical.operation_id, "FREEZE_EVIDENCE");
  const historicalInput = await decodeEvidenceFreezeStageInput(await readWorkflowObject(env.WORK_BUCKET, stageTen.request.input_manifest, true));
  const policy = parseResearchClaimAuditPolicy(config.audit.policy);
  const sourceClasses = async (evidence: ArtifactCowSectionProducerDependencies["attempt"]["request"]) => {
    if (evidence.operation_id !== attempt.request.operation_id) deny("COW execution identity changed");
    return navigation.sources(navigation.scope.member_source_revision_refs, await navigation.current());
  };
  const producer: Omit<ArtifactCowSectionProducerDependencies,
    "attempt" | "principal" | "model_authority" | "output_residency_domains" | "execute"> = {
    historical_freeze: cow.historical,
    verifier: { verifier_ref: config.audit.verifier_ref, schema_generation: config.audit.verifier_schema_generation, deployment: auditRule.deployment },
    normalization_constraints: () => config.normalization,
    trusted_audit_inputs: ({ claims, evidence_pack }) => {
      const byRef = new Map(evidence_pack.resolved_evidence.map((item) => [key(item.handle.handle_ref), item.handle]));
      const handles = (refs: readonly { id: string; revision: number }[]) => refs.map((ref) => {
        const handle = byRef.get(key(ref));
        if (handle === undefined) deny("Independent audit cites evidence outside historical pack");
        return handle;
      });
      return claims.map((claim): TrustedSemanticClaimAuditInput => ({ claim,
        exact_support_handles: handles(claim.support_handle_refs), counterevidence_handles: handles(claim.counterevidence_handle_refs),
        reference_resolution_verified: true, semantic_verifier_qualified: true,
        required_dimensions: policy.required_dimensions, source_requirement_applicable: policy.source_requirement_applicable,
        excerpt_requirement_applicable: policy.excerpt_requirement_applicable,
        evidence_grade: historicalInput.protocol_profile.evidence_grade, lane: historicalInput.protocol_profile.lane,
        coverage_limitations: policy.coverage_limitations, unsupported_precision: policy.unsupported_precision.map((item) => ({
          ...item, source_and_coverage_basis: [...item.source_and_coverage_basis] })) }));
    },
    validate_required_evidence_pack: async ({ contract, evidence_pack }) => {
      const sources = await sourceClasses(attempt.request);
      const classes = new Set(evidence_pack.resolved_evidence.map((item) => sources.find((source) =>
        source.source_revision_ref === item.handle.source_revision_ref)?.source_class));
      if (contract.required_evidence_classes.some((required) => required === "source" ? evidence_pack.resolved_evidence.length === 0 : !classes.has(required))) deny("Section EvidencePack omits a required source class");
    },
    validate_evidence_classes: async ({ claims, evidence_pack }) => {
      const sources = await sourceClasses(attempt.request);
      const byRef = new Map(evidence_pack.resolved_evidence.map((item) => [key(item.handle.handle_ref), item]));
      for (const claim of claims) for (const ref of [...claim.support_handle_refs, ...claim.counterevidence_handle_refs]) {
        const evidence = byRef.get(key(ref));
        const source = sources.find((item) => item.source_revision_ref === evidence?.handle.source_revision_ref);
        if (source === undefined || (claim.required_source_class !== "source" && claim.required_source_class !== source.source_class) ||
            evidence?.handle.anchor.kind !== claim.required_precision) deny("Normalized claim exceeds current source class or precision");
      }
    },
    resolve_current_evidence: cow.resolve_current_evidence,
  };
  return { model: runtime.executor, model_authority: admission.authority, producer, output_residency_domains: domains };
}
