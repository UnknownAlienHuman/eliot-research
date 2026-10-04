import type { EvidenceContentPort, EvidenceAuthorityPort, NavigationReadAuthority } from "@eliotr/cloudflare-evidence";
import { createCloudflareEvidenceResolver, evidenceSha256Bytes } from "@eliotr/cloudflare-evidence";
import type { ObjectResidencyKey } from "@eliotr/contracts";
import type { ModelGatewayPricingPort } from "@eliotr/cloudflare-ai";
import { canonicalDigest, canonicalJson } from "@eliotr/platform-cloudflare";
import {
  createModelProfileDefinition,
  parseResearchModelProfileDefinition,
  readOwnerModelProfileTemplateV2,
  createResearchReferenceManifestService,
  type ArtifactCowSectionProducerDependencies,
  type ArtifactCowNativeModelSelectionResolver,
  type ArtifactCowModelRuntimeDependencies,
  type ResearchModelSpendPolicy,
  type ReferenceManifestStorageContext,
  type ResearchModelGatewayRuntimeConfig,
} from "@eliotr/cloudflare-research";
import type {
  createArtifactCowModelRuntime,
  createResearchReferenceManifestStore,
  decodeEvidenceFreezeStageInput,
} from "@eliotr/cloudflare-research";
import { parseResearchClaimAuditPolicy } from "@eliotr/cloudflare-research-stages";
import type { ModelCallInput, TrustedSemanticClaimAuditInput } from "@eliotr/research";
import type { ResearchSemanticConfiguration } from "@eliotr/cloudflare-research-configuration/research-semantic-configuration-schema.js";
import { parseResearchSemanticConfiguration, researchSemanticPromptParameters } from "@eliotr/cloudflare-research-configuration/research-semantic-configuration-schema.js";
import type { ArtifactSectionReviseAttempt } from "@eliotr/cloudflare-workflows";
import type { ResolvedEvidence, VersionedRef } from "@eliotr/contracts";
import type { ModelAttemptAuthority } from "@eliotr/cloudflare-research";
import type { ResearchSelectedModelTransportResolution } from "./research-selected-model-transport.js";
import type { ArtifactCowModelAdmissionRunConfiguration } from "./artifact-cow-model-admission.js";

type RuntimeFactoryDependencies = Omit<ArtifactCowModelRuntimeDependencies, "database" | "work_bucket">;
type ReferenceManifestStore = ReturnType<typeof createResearchReferenceManifestStore>;
type EvidenceFreezeStageInput = Awaited<ReturnType<typeof decodeEvidenceFreezeStageInput>>;

export interface ArtifactSectionReviseModelAdmissionPort {
  readonly authority: ModelAttemptAuthority;
  readonly prepare: ArtifactCowModelRuntimeDependencies["prepare"];
  readonly revalidateExisting: ArtifactCowModelRuntimeDependencies["revalidateExisting"];
  promptContext(call: ModelCallInput): Promise<string>;
}

export interface ArtifactSectionReviseModelCowInput {
  readonly historical: ArtifactCowSectionProducerDependencies["historical_freeze"];
  readonly fresh_pack: ModelCallInput["evidence_pack"];
  readonly manifest_residency: ObjectResidencyKey;
  resolve_current_evidence(handle_ref: VersionedRef): Promise<ResolvedEvidence>;
}

export interface ArtifactSectionReviseModelApplicationInput {
  readonly attempt: ArtifactSectionReviseAttempt;
  readonly navigation: NavigationReadAuthority;
  readonly actor: Readonly<{
    principal_ref: string;
    credential_generation: string;
    signal?: AbortSignal;
  }>;
  readonly cow: ArtifactSectionReviseModelCowInput;
  readonly run_configuration: ArtifactCowModelAdmissionRunConfiguration | null;
  readonly audit_selection: ResearchSelectedModelTransportResolution | null;
  readonly semantic_config_json: string;
  readonly model_profile_json?: string;
  readonly model_profile_provenance_ref?: string;
  readonly spend_policy: ResearchModelSpendPolicy;
  readonly gateway: ResearchModelGatewayRuntimeConfig;
  readonly deployment_environment: "PRODUCTION" | "TEST";
  readonly evidence_authority: EvidenceAuthorityPort;
  readonly evidence_content: EvidenceContentPort;
  readonly pricing: ModelGatewayPricingPort;
  readonly admission: ArtifactSectionReviseModelAdmissionPort;
  readonly resolve_native_model_selection?: ArtifactCowNativeModelSelectionResolver;
  readonly create_manifest_store: (
    context: ReferenceManifestStorageContext,
    navigation: NavigationReadAuthority,
  ) => ReferenceManifestStore;
  readonly create_model_runtime: (
    dependencies: RuntimeFactoryDependencies,
  ) => ReturnType<typeof createArtifactCowModelRuntime>;
  readonly read_historical_input: () => Promise<EvidenceFreezeStageInput>;
  readonly now?: () => number;
}

function stale(message: string): never {
  throw new ArtifactSectionReviseModelApplicationError(message);
}

export class ArtifactSectionReviseModelApplicationError extends Error {
  public readonly code = "ARTIFACT_SECTION_REVISE_STALE" as const;
  public readonly status = 409 as const;

  public constructor(message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "ArtifactSectionReviseModelApplicationError";
  }
}

function refKey(ref: VersionedRef): string { return ref.id + ":" + ref.revision; }

/** Composes the COW model runtime from Core-resolved run, owner and storage ports. */
export async function createArtifactSectionReviseModelApplication(input: ArtifactSectionReviseModelApplicationInput) {
  const { attempt, navigation, cow } = input;
  const now = input.now ?? Date.now;
  const config: ResearchSemanticConfiguration = parseResearchSemanticConfiguration(input.semantic_config_json);
  const profileRaw = JSON.parse(input.model_profile_json ?? "null") as unknown;
  let modelProfile: Awaited<ReturnType<typeof parseResearchModelProfileDefinition>>;
  if (typeof profileRaw === "object" && profileRaw !== null && !Array.isArray(profileRaw) &&
      (profileRaw as Record<string, unknown>).schema === "eliotr.research.model-profile-definition.v2") {
    const template = await readOwnerModelProfileTemplateV2(profileRaw, input.model_profile_provenance_ref ?? "");
    const authorization = await navigation.current();
    const expiryMs = Math.min(template.expires_at === undefined ? Number.POSITIVE_INFINITY : Date.parse(template.expires_at),
      Date.parse(navigation.scope.expires_at), Date.parse(authorization.expires_at), attempt.budget.expires_at_ms);
    if (!Number.isFinite(expiryMs) || expiryMs <= now()) stale("Current COW profile authority has expired");
    modelProfile = await createModelProfileDefinition({
      config_provenance_ref: template.config_provenance_ref,
      model_profile_ref: template.model_profile_ref,
      expires_at: new Date(expiryMs).toISOString(),
      max_context_bytes: template.max_context_bytes,
      deployment: template.deployment,
      policy: { ...template.policy, expires_at: new Date(expiryMs).toISOString() },
    });
  } else {
    modelProfile = await parseResearchModelProfileDefinition(profileRaw);
  }
  if (modelProfile.config_provenance_ref !== input.model_profile_provenance_ref ||
      Date.parse(modelProfile.expires_at) <= now() ||
      !config.audit.allowed_verifier_refs.includes(config.audit.verifier_ref) ||
      !modelProfile.policy.allowed_verifier_refs.includes(config.audit.verifier_ref)) {
    stale("Current model/verifier policy is unavailable");
  }
  const auditRule = input.spend_policy.rules.find((rule) => rule.stage === "AUDIT_CLAIMS");
  if (auditRule === undefined) stale("Independent verification has no admitted REPORT slot");

  const resolver = createCloudflareEvidenceResolver({ authority: input.evidence_authority, content: input.evidence_content });
  const { content_digest: _content, ...historicalDomains } = cow.manifest_residency;
  const domains = { ...historicalDomains, scope_domain_id: navigation.scope.snapshot_id, access_domain_id: input.actor.principal_ref };
  const stores = new Map<string, ReferenceManifestStore>();
  const manifests = createResearchReferenceManifestService({ navigation, resolver, store: {
    async put(manifest) {
      const bytes = new TextEncoder().encode(canonicalJson(manifest));
      const authorization = await navigation.current();
      const storageContext: ReferenceManifestStorageContext = {
        principal_ref: input.actor.principal_ref,
        credential_generation: input.actor.credential_generation,
        scope_snapshot_ref: attempt.request.scope_snapshot_ref,
        manifest_residency_key: { ...domains,
          content_digest: { algorithm: "sha256", digest: await evidenceSha256Bytes(bytes) } },
        policy_authority_ref: authorization.policy_authority_ref,
        authorization_receipt_ref: authorization.authorization_receipt_ref,
        scope_snapshot_digest: navigation.scope.digest,
        pack_ref: cow.fresh_pack.pack_ref,
        trace_ref: cow.fresh_pack.trace_ref,
        stage_attempt_ref: attempt.attempt_ref,
        stage_request_sha256: attempt.request_sha256,
        created_at: new Date(now()).toISOString(),
      };
      const store = input.create_manifest_store(storageContext, navigation);
      stores.set(refKey(manifest.manifest_ref), store);
      return (await store.persist(manifest)).manifest_ref;
    },
    get: async (ref) => stores.get(refKey(ref))?.get(ref) ?? null,
  } });

  const runtime = input.create_model_runtime({
    gateway: input.gateway,
    ...(input.actor.signal === undefined ? {} : { signal: input.actor.signal }),
    deployment_environment: input.deployment_environment,
    pricing: input.pricing,
    prepare: input.admission.prepare,
    revalidateExisting: input.admission.revalidateExisting,
    ...(input.resolve_native_model_selection === undefined ? {} : {
      resolve_native_model_selection: input.resolve_native_model_selection,
    }),
    prompt: {
      manifest_service: manifests,
      request_timeout_ms: Math.min(config.synthesis.request_timeout_ms, config.audit.request_timeout_ms),
      build_manifest_input: async (call, deployment) => ({
        evidence_pack: call.evidence_pack,
        navigation,
        resolver,
        policy: modelProfile.policy,
        manifest_ref: { id: "artifact-cow-manifest-" + await canonicalDigest({
          output: call.output_object_ref,
          attempt: attempt.attempt_ref,
        }), revision: 1 },
        model_route_ref: deployment.route_ref,
        max_context_bytes: Math.min(modelProfile.max_context_bytes, call.max_input_bytes),
      }),
      resolve_trusted_parameters: async (call: ModelCallInput) => {
        const exactContext = await input.admission.promptContext(call);
        const body = JSON.parse(exactContext) as { protocol?: string };
        const selected = body.protocol === "eliotr.artifact-section-synthesis-input.v1" ? config.synthesis
          : body.protocol === "eliotr.artifact-section-independent-verification-input.v1" ? config.audit
          : stale("Unrecognized COW model input");
        return { ...researchSemanticPromptParameters(selected.trusted_parameters),
          prompt: selected.trusted_parameters.prompt + "\n\n" + exactContext };
      },
    },
  });

  const selection = input.audit_selection?.selection;
  const activeVerifier = selection === undefined
    ? await runtime.deployments.resolve(auditRule.deployment.route_ref)
    : selection.candidate_kind === "provider-native-v1"
      ? input.resolve_native_model_selection === undefined ? stale("Native independent-verifier authority is unavailable")
        : (await input.resolve_native_model_selection({ selection,
            allow_expired_snapshot_v2: input.run_configuration?.mode === "snapshot-v2" })).deployment
      : await runtime.deployments.resolvePinned(auditRule.deployment, selection, {
          allow_expired_qualification: input.run_configuration?.mode === "snapshot-v2",
        });
  if (canonicalJson(activeVerifier) !== canonicalJson(auditRule.deployment)) {
    stale("Independent verifier deployment changed");
  }

  const historicalInput = await input.read_historical_input();
  const policy = parseResearchClaimAuditPolicy(config.audit.policy);
  const sourceClasses = async (evidence: ArtifactCowSectionProducerDependencies["attempt"]["request"]) => {
    if (evidence.operation_id !== attempt.request.operation_id) stale("COW execution identity changed");
    return navigation.sources(navigation.scope.member_source_revision_refs, await navigation.current());
  };
  const producer: Omit<ArtifactCowSectionProducerDependencies,
    "attempt" | "principal" | "model_authority" | "output_residency_domains" | "execute"> = {
    historical_freeze: cow.historical,
    verifier: { verifier_ref: config.audit.verifier_ref, schema_generation: config.audit.verifier_schema_generation,
      deployment: auditRule.deployment },
    normalization_constraints: () => config.normalization,
    trusted_audit_inputs: ({ claims, evidence_pack }) => {
      const byRef = new Map(evidence_pack.resolved_evidence.map((item) => [refKey(item.handle.handle_ref), item.handle]));
      const handles = (refs: readonly VersionedRef[]) => refs.map((ref) => {
        const handle = byRef.get(refKey(ref));
        if (handle === undefined) stale("Independent audit cites evidence outside historical pack");
        return handle;
      });
      return claims.map((claim): TrustedSemanticClaimAuditInput => ({
        claim,
        exact_support_handles: handles(claim.support_handle_refs),
        counterevidence_handles: handles(claim.counterevidence_handle_refs),
        reference_resolution_verified: true,
        semantic_verifier_qualified: true,
        required_dimensions: policy.required_dimensions,
        source_requirement_applicable: policy.source_requirement_applicable,
        excerpt_requirement_applicable: policy.excerpt_requirement_applicable,
        evidence_grade: historicalInput.protocol_profile.evidence_grade,
        lane: historicalInput.protocol_profile.lane,
        coverage_limitations: policy.coverage_limitations,
        unsupported_precision: policy.unsupported_precision.map((item) => ({
          ...item, source_and_coverage_basis: [...item.source_and_coverage_basis],
        })),
      }));
    },
    validate_required_evidence_pack: async ({ contract, evidence_pack }) => {
      const sources = await sourceClasses(attempt.request);
      const classes = new Set(evidence_pack.resolved_evidence.map((item) => sources.find((source) =>
        source.source_revision_ref === item.handle.source_revision_ref)?.source_class));
      if (contract.required_evidence_classes.some((required) =>
        required === "source" ? evidence_pack.resolved_evidence.length === 0 : !classes.has(required))) {
        stale("Section EvidencePack omits a required source class");
      }
    },
    validate_evidence_classes: async ({ claims, evidence_pack }) => {
      const sources = await sourceClasses(attempt.request);
      const byRef = new Map(evidence_pack.resolved_evidence.map((item) => [refKey(item.handle.handle_ref), item]));
      for (const claim of claims) for (const ref of [...claim.support_handle_refs, ...claim.counterevidence_handle_refs]) {
        const evidence = byRef.get(refKey(ref));
        const source = sources.find((item) => item.source_revision_ref === evidence?.handle.source_revision_ref);
        if (source === undefined || (claim.required_source_class !== "source" &&
            claim.required_source_class !== source.source_class) || evidence?.handle.anchor.kind !== claim.required_precision) {
          stale("Normalized claim exceeds current source class or precision");
        }
      }
    },
    resolve_current_evidence: cow.resolve_current_evidence,
  };
  return { model: runtime.executor, model_authority: input.admission.authority, producer, output_residency_domains: domains };
}
