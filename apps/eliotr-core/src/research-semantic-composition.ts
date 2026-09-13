import {
  createCloudflareEvidenceResolver,
  createD1EvidenceAuthorityPort,
  createR2EvidenceContentPort,
  type CloudflareEvidenceResolver,
  type EvidenceAuthorityPort,
  type EvidenceContentPort,
  type NavigationReadAuthority,
} from "@eliotr/cloudflare-evidence";
import type { ModelGatewayPricingPort } from "@eliotr/cloudflare-ai";
import type { ReferenceManifestStore } from "@eliotr/policy";
import type { InvestigationLedgerStore } from "@eliotr/research";
import type { RetrievalQueryAccess, ScopeProfileBinding } from "@eliotr/retrieval";
import {
  fail as failWorkflow,
  type WorkflowPrincipal,
} from "@eliotr/cloudflare-workflows";
import {
  createD1ModelGatewayDeploymentRegistry,
  createEvidenceFreezePostSynthesisContextReader,
  createEvidenceFreezeSynthesisContextReader,
  createEvidenceFreezeVerificationContextReader,
  createPersistedModelProfileBindingProducer,
  type D1DynamicRouteRegistryOptions,
  type EvidenceFreezeCommittedReaders,
  type EvidenceFreezeCompositionDependencies,
  type EvidenceFreezeManifestStoreFactory,
  type EvidenceFreezeResidencyTemplate,
  type EvidenceFreezeSynthesisContextReader,
  type EvidenceFreezeSynthesisModelDependencies,
  type ModelProfileDefinitionConfigSourceOptions,
  type ResearchModelGatewayRuntimeConfig,
  type ResearchModelPromptCompilerDependencies,
  type SpendAuthorizationReader,
} from "@eliotr/cloudflare-research";
import {
  createResearchClaimAuditInputReaderFromFreeze,
  type ResearchClaimAuditInputReader,
  type ResearchClaimAuditNormalizationConfig,
  type ResearchClaimAuditPolicy,
  type ResearchClaimAuditPromptDependencies,
  type ResearchClaimAuditStageDependencies,
  type ResearchClaimAuditVerifierSelection,
  type ResearchCitationsStageDependencies,
  type ResearchVerificationStageDependencies,
  type ResearchVerificationV2Config,
} from "@eliotr/cloudflare-research-stages";
import {
  createEvidenceFreezePredecessorReader,
  createEvidenceFreezeWorkflowReaders,
} from "./research-evidence-freeze-composition.js";
import type { RetrieveBranchesStageDependencies } from "./research-retrieve-branches.js";

type SemanticPrincipal = Pick<
  WorkflowPrincipal,
  "principal_ref" | "credential_generation" | "deployment_generation"
>;

/**
 * Model call inputs are supplied by the server-owned preparation layer. The
 * composition deliberately does not choose prompts, prices, routes, or
 * spend decisions; those values must come from the current D1/qualification
 * readback and the installed Worker policy.
 */
export interface ResearchSemanticSynthesisModelDependencies {
  readonly gateway: ResearchModelGatewayRuntimeConfig;
  readonly prompt: ResearchModelPromptCompilerDependencies;
  readonly pricing: ModelGatewayPricingPort;
  readonly spend_authorization: SpendAuthorizationReader;
  readonly prepare: EvidenceFreezeSynthesisModelDependencies["prepare"];
}

export interface ResearchSemanticAuditModelDependencies {
  readonly gateway: ResearchModelGatewayRuntimeConfig;
  readonly prompt: ResearchClaimAuditPromptDependencies;
  readonly pricing: ModelGatewayPricingPort;
  readonly spend_authorization: SpendAuthorizationReader;
  readonly prepare: ResearchClaimAuditStageDependencies["prepare"];
}

export interface ResearchSemanticCompositionDependencies {
  /** CORE_DB owns workflow, freeze, model profile and active route rows. */
  readonly database: D1Database;
  readonly search_database: D1Database;
  readonly work_bucket: R2Bucket;
  readonly evidence_bucket: R2Bucket;
  /** Server-created owner navigation; request DTOs must never supply this. */
  readonly navigation: NavigationReadAuthority;
  readonly ledger: Pick<InvestigationLedgerStore, "read">;
  readonly operation_id: string;
  readonly investigation_id: string;
  readonly principal: SemanticPrincipal;
  /** Scope profile is read from the server-owned retrieval policy. */
  readonly retrieval_profile: ScopeProfileBinding;
  /** Explicit installed model definition; no production default is allowed. */
  readonly model_profile: ModelProfileDefinitionConfigSourceOptions;
  /** Explicitly selects the D1 route qualification gate (PRODUCTION or TEST). */
  readonly deployment_environment: NonNullable<D1DynamicRouteRegistryOptions["environment"]>;
  /** The same validated clock is used by route, evidence, and profile readers. */
  readonly now?: () => number;
  /** Current run/status authority used around committed synthesis reads. */
  readonly recheck_authority: ResearchVerificationStageDependencies["recheck_authority"];
  readonly manifest: {
    readonly store: ReferenceManifestStore;
    readonly store_factory: EvidenceFreezeManifestStoreFactory;
    readonly residency_template: EvidenceFreezeResidencyTemplate;
    /** Must equal the installed model profile's explicit context bound. */
    readonly max_context_bytes: number;
  };
  readonly model: {
    readonly synthesis: ResearchSemanticSynthesisModelDependencies;
    readonly audit: ResearchSemanticAuditModelDependencies;
  };
  readonly verification: {
    /** The v2 normalization contract is server-selected and required here. */
    readonly config: ResearchVerificationV2Config;
  };
  readonly audit: {
    readonly normalization: ResearchClaimAuditNormalizationConfig;
    readonly verifier: ResearchClaimAuditVerifierSelection;
    readonly policy: ResearchClaimAuditPolicy;
  };
  /** Optional server override for citation recovery storage; the run's durable stores are used by default. */
  readonly citations?: Pick<ResearchCitationsStageDependencies, "recovery">;
}

export interface ResearchSemanticSynthesisDependencies {
  readonly context: EvidenceFreezeSynthesisContextReader;
  readonly model: EvidenceFreezeSynthesisModelDependencies;
}

/**
 * All dependencies returned here are directly consumable by the existing
 * server-owned stage factory. Construction performs validation only; model
 * gateway, D1 and R2 effects occur when the selected stage handler runs.
 */
export interface ResearchSemanticComposition {
  readonly navigation: NavigationReadAuthority;
  readonly ledger: Pick<InvestigationLedgerStore, "read">;
  readonly evidence_authority: EvidenceAuthorityPort;
  readonly evidence_content: EvidenceContentPort;
  readonly evidence_resolver: CloudflareEvidenceResolver;
  readonly readers: EvidenceFreezeCommittedReaders;
  readonly deployment_registry: ReturnType<typeof createD1ModelGatewayDeploymentRegistry>;
  readonly model_profile: ReturnType<typeof createPersistedModelProfileBindingProducer>;
  readonly freeze: EvidenceFreezeCompositionDependencies;
  readonly synthesis: ResearchSemanticSynthesisDependencies;
  readonly verification: ResearchVerificationStageDependencies;
  readonly audit_claims: ResearchClaimAuditStageDependencies;
  readonly resolve_citations: ResearchCitationsStageDependencies;
}

function inputInvalid(message: string): never {
  void message;
  failWorkflow("WORKFLOW_INPUT_INVALID");
}

function configurationMissing(message: string): never {
  void message;
  failWorkflow("WORKFLOW_AUTHORITY_STALE");
}

function requireObject(value: unknown, label: string): void {
  if (typeof value !== "object" || value === null || Array.isArray(value)) inputInvalid(label);
}

function requireFunction(value: unknown, label: string): void {
  if (typeof value !== "function") configurationMissing(label);
}

function requireGateway(value: ResearchModelGatewayRuntimeConfig, label: string): void {
  if (value === null || typeof value !== "object" || Array.isArray(value) ||
      typeof value.reasoning_gateway_base_url !== "string" || value.reasoning_gateway_base_url.length === 0) {
    configurationMissing(`${label}.reasoning_gateway_base_url`);
  }
  const hasToken = Object.prototype.hasOwnProperty.call(value, "gateway_token");
  const hasBinding = Object.prototype.hasOwnProperty.call(value, "ai_gateway_binding");
  if (hasToken === hasBinding) configurationMissing(`${label} must select one server-owned gateway transport`);
  if (hasToken && value.gateway_token === undefined) configurationMissing(`${label}.gateway_token`);
  if (hasBinding && (value.ai_gateway_binding === null || typeof value.ai_gateway_binding !== "object" || Array.isArray(value.ai_gateway_binding))) {
    configurationMissing(`${label}.ai_gateway_binding`);
  }
}

function validateDependencies(input: ResearchSemanticCompositionDependencies): void {
  if (input === null || typeof input !== "object") inputInvalid("dependencies");
  requireObject(input.navigation, "navigation");
  requireObject(input.navigation.scope, "navigation.scope");
  requireObject(input.navigation.access, "navigation.access");
  requireObject(input.principal, "principal");
  requireObject(input.retrieval_profile, "retrieval_profile");
  requireObject(input.model_profile, "model_profile");
  requireObject(input.manifest, "manifest");
  requireObject(input.manifest.residency_template, "manifest.residency_template");
  requireObject(input.model, "model");
  requireObject(input.model.synthesis, "model.synthesis");
  requireObject(input.model.synthesis.prompt, "model.synthesis.prompt");
  requireObject(input.model.synthesis.prompt.manifest_service, "model.synthesis.prompt.manifest_service");
  requireObject(input.model.audit, "model.audit");
  requireObject(input.model.audit.prompt, "model.audit.prompt");
  requireObject(input.model.audit.prompt.manifest_service, "model.audit.prompt.manifest_service");
  requireObject(input.verification, "verification");
  requireObject(input.verification.config, "verification.config");
  requireObject(input.audit, "audit");
  requireObject(input.audit.normalization, "audit.normalization");
  requireObject(input.audit.verifier, "audit.verifier");
  requireObject(input.audit.verifier.authority, "audit.verifier.authority");
  requireFunction(input.navigation?.current, "navigation.current");
  requireFunction(input.navigation?.sources, "navigation.sources");
  requireFunction(input.ledger?.read, "ledger.read");
  requireFunction(input.recheck_authority, "recheck_authority");
  requireFunction(input.manifest?.store?.get, "manifest.store.get");
  requireFunction(input.manifest?.store?.put, "manifest.store.put");
  requireFunction(input.manifest?.store_factory?.create, "manifest.store_factory.create");
  if (input.manifest.residency_template.scope_domain_id !== input.navigation.scope.snapshot_id ||
      input.manifest.residency_template.access_domain_id !== input.principal.principal_ref) {
    inputInvalid("manifest residency is outside the pinned scope or principal");
  }
  if (!Number.isSafeInteger(input.manifest.max_context_bytes) ||
      input.manifest.max_context_bytes < 1 || input.manifest.max_context_bytes > 64 * 1024) {
    inputInvalid("manifest.max_context_bytes is outside the freeze bound");
  }
  if (input.navigation.access.principal_ref !== input.principal.principal_ref ||
      input.navigation.access.credential_generation !== input.principal.credential_generation) {
    inputInvalid("navigation access does not match the server principal");
  }
  if (typeof input.model_profile.raw !== "string" || input.model_profile.raw.trim() === "") {
    configurationMissing("model_profile.raw");
  }
  if (typeof input.model_profile.provenance_ref !== "string" || input.model_profile.provenance_ref.length === 0) {
    inputInvalid("model_profile.provenance_ref");
  }
  if (input.deployment_environment !== "TEST" && input.deployment_environment !== "PRODUCTION") {
    configurationMissing("deployment_environment");
  }
  if (input.now !== undefined) requireFunction(input.now, "now");

  requireGateway(input.model.synthesis.gateway, "model.synthesis.gateway");
  requireGateway(input.model.audit.gateway, "model.audit.gateway");
  requireFunction(input.model.synthesis.prompt.manifest_service?.buildAndPersist, "model.synthesis.prompt.manifest_service.buildAndPersist");
  requireFunction(input.model.synthesis.prompt.build_manifest_input, "model.synthesis.prompt.build_manifest_input");
  requireFunction(input.model.synthesis.prompt.resolve_trusted_parameters, "model.synthesis.prompt.resolve_trusted_parameters");
  requireFunction(input.model.synthesis.pricing?.quote, "model.synthesis.pricing.quote");
  requireFunction(input.model.synthesis.spend_authorization?.read, "model.synthesis.spend_authorization.read");
  requireFunction(input.model.synthesis.prepare, "model.synthesis.prepare");
  requireFunction(input.model.audit.prompt.manifest_service?.buildAndPersist, "model.audit.prompt.manifest_service.buildAndPersist");
  requireFunction(input.model.audit.prompt.build_manifest_input, "model.audit.prompt.build_manifest_input");
  requireFunction(input.model.audit.prompt.resolve_trusted_parameters, "model.audit.prompt.resolve_trusted_parameters");
  requireFunction(input.model.audit.pricing?.quote, "model.audit.pricing.quote");
  requireFunction(input.model.audit.spend_authorization?.read, "model.audit.spend_authorization.read");
  requireFunction(input.model.audit.prepare, "model.audit.prepare");
  requireFunction(input.audit.verifier?.read_current, "audit.verifier.read_current");
  if (input.audit.verifier.authority.qualified !== true || input.audit.verifier.authority.current !== true) {
    configurationMissing("audit.verifier must be currently qualified");
  }
}

function snapshotAccess(navigation: NavigationReadAuthority): RetrievalQueryAccess {
  return Object.freeze({
    principal_ref: navigation.access.principal_ref,
    client_class: navigation.access.client_class,
    credential_generation: navigation.access.credential_generation,
  });
}

/**
 * Builds one server-owned semantic graph for a single workflow run. The run
 * identity is captured before any asynchronous stage read; profile and route
 * resolution still revalidate it against the current D1 authority.
 */
export function createResearchSemanticComposition(
  input: ResearchSemanticCompositionDependencies,
): ResearchSemanticComposition {
  validateDependencies(input);
  const now = input.now ?? (() => Date.now());
  const navigationAccess = snapshotAccess(input.navigation);
  const routeNow = (): string => new Date(now()).toISOString();
  const deploymentRegistry = createD1ModelGatewayDeploymentRegistry(input.database, {
    environment: input.deployment_environment,
    now: routeNow,
  });
  const modelProfile = createPersistedModelProfileBindingProducer({
    config: input.model_profile,
    authority: {
      database: input.database,
      navigation: input.navigation,
      operation_id: input.operation_id,
      investigation_id: input.investigation_id,
      principal: input.principal,
    },
    routeAuthority: deploymentRegistry,
    now,
  });
  const evidenceAuthority = createD1EvidenceAuthorityPort({
    core_database: input.database,
    search_database: input.search_database,
    now,
  });
  const evidenceContent = createR2EvidenceContentPort({ evidence_bucket: input.evidence_bucket });
  const evidenceResolver = createCloudflareEvidenceResolver({
    authority: evidenceAuthority,
    content: evidenceContent,
    now,
  });
  const retrieve: Omit<RetrieveBranchesStageDependencies, "navigation" | "ledger"> = {
    database: input.database,
    search_database: input.search_database,
    work_bucket: input.work_bucket,
    evidence_bucket: input.evidence_bucket,
    access: navigationAccess,
    profile: input.retrieval_profile,
  };
  const readers = createEvidenceFreezeWorkflowReaders({
    database: input.database,
    work_bucket: input.work_bucket,
    retrieve,
  }, input.navigation, input.ledger);
  const predecessorReader = createEvidenceFreezePredecessorReader(input.navigation, readers);
  const freeze: EvidenceFreezeCompositionDependencies = {
    navigation: input.navigation,
    resolver: evidenceResolver,
    read_predecessors: predecessorReader,
    resolve_model_binding: async ({ protocol_scope, w1_head }) => (await modelProfile.resolve({
      model_profile_ref: protocol_scope.protocol_profile.model_profile_ref,
      policy_generation: w1_head.policy_generation,
      policy_authority_ref: w1_head.policy_authority_ref,
      deployment_generation: w1_head.deployment_generation,
      scope_snapshot_ref: protocol_scope.scope_snapshot_ref,
      scope_snapshot_digest: input.navigation.scope.digest,
    })).binding,
    manifest_store_factory: input.manifest.store_factory,
    manifest_residency_template: input.manifest.residency_template,
    max_context_bytes: input.manifest.max_context_bytes,
    manifest_store: input.manifest.store,
  };
  const readerEnvironment = {
    database: input.database,
    work_bucket: input.work_bucket,
    manifest_store: input.manifest.store,
    read_stage_five: readers.read_stage_five,
  };
  const synthesis: ResearchSemanticSynthesisDependencies = {
    context: createEvidenceFreezeSynthesisContextReader(readerEnvironment, input.navigation, readers),
    model: {
      database: input.database,
      work_bucket: input.work_bucket,
      operation_kind: "REPORT",
      deployment_environment: input.deployment_environment,
      gateway: input.model.synthesis.gateway,
      prompt: input.model.synthesis.prompt,
      pricing: input.model.synthesis.pricing,
      spend_authorization: input.model.synthesis.spend_authorization,
      prepare: input.model.synthesis.prepare,
    },
  };
  const verificationContext = createEvidenceFreezeVerificationContextReader(
    readerEnvironment,
    input.navigation,
    readers,
  );
  const verification: ResearchVerificationStageDependencies = {
    database: input.database,
    work_bucket: input.work_bucket,
    navigation: input.navigation,
    evidence_resolver: evidenceResolver,
    recheck_authority: input.recheck_authority,
    context: verificationContext,
    v2_config: input.verification.config,
  };
  const auditInput: ResearchClaimAuditInputReader = createResearchClaimAuditInputReaderFromFreeze(
    readerEnvironment,
    input.navigation,
    readers,
    {
      database: input.database,
      work_bucket: input.work_bucket,
      evidence_resolver: evidenceResolver,
      recheck_authority: input.recheck_authority,
      normalization: input.audit.normalization,
      verifier: input.audit.verifier,
      audit_policy: input.audit.policy,
    },
  );
  const audit_claims: ResearchClaimAuditStageDependencies = {
    database: input.database,
    work_bucket: input.work_bucket,
    deployment_environment: input.deployment_environment,
    gateway: input.model.audit.gateway,
    prompt: input.model.audit.prompt,
    pricing: input.model.audit.pricing,
    spend_authorization: input.model.audit.spend_authorization,
    input: auditInput,
    prepare: input.model.audit.prepare,
  };
  const citationContext = createEvidenceFreezePostSynthesisContextReader(
    readerEnvironment,
    input.navigation,
    readers,
    "RESOLVE_CITATIONS",
  );
  const resolve_citations: ResearchCitationsStageDependencies = {
    database: input.database,
    navigation: input.navigation,
    evidence_resolver: evidenceResolver,
    context: citationContext,
    recovery: input.citations?.recovery ?? {
      work_bucket: input.work_bucket,
      evidence_content: evidenceContent,
    },
  };
  return Object.freeze({
    navigation: input.navigation,
    ledger: input.ledger,
    evidence_authority: evidenceAuthority,
    evidence_content: evidenceContent,
    evidence_resolver: evidenceResolver,
    readers,
    deployment_registry: deploymentRegistry,
    model_profile: modelProfile,
    freeze,
    synthesis,
    verification,
    audit_claims,
    resolve_citations,
  });
}
