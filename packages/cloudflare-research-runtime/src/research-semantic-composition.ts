import {
  createCloudflareEvidenceResolver,
  createD1EvidenceAuthorityPort,
  createR2EvidenceContentPort,
  type CloudflareEvidenceResolver,
  type NavigationReadAuthority,
} from "@eliotr/cloudflare-evidence";
import {
  createResearchReferenceManifestReader,
  createResearchReferenceManifestStore,
  createFrozenResearchReferenceManifestService,
} from "@eliotr/cloudflare-evidence";
import type { ReferenceManifestStore } from "@eliotr/policy";
import type { RetrievalQueryAccess } from "@eliotr/retrieval";
import type { ResearchBranchRole } from "@eliotr/contracts";
import {
  createD1ModelGatewayDeploymentRegistry,
  createD1ResearchModelPricingQuotePort,
  createPersistedModelProfileBindingProducer,
  type ResearchModelPromptCompilerDependencies,
} from "@eliotr/cloudflare-model-control";
import {
  createEvidenceFreezePostSynthesisContextReader,
  createEvidenceFreezeSynthesisContextReader,
  createEvidenceFreezeVerificationContextReader,
  createResearchBranchRoleModelExecutor,
  type EvidenceFreezeCompositionDependencies,
  type EvidenceFreezeManifestStoreFactory,
  type EvidenceFreezeSynthesisContextReader,
  type ResearchBranchRoleModelExecutor,
} from "@eliotr/cloudflare-research-branches";
import {
  createResearchClaimAuditInputReaderFromFreeze,
  createResearchCoverageStageHandlerFromFreeze,
  createResearchCoverageMaterializeStageHandlerFromFreeze,
  type ResearchClaimAuditInputReader,
  type ResearchClaimAuditPromptDependencies,
  type ResearchClaimAuditStageDependencies,
  type ResearchCitationsStageDependencies,
  type ResearchVerificationStageDependencies,
} from "@eliotr/cloudflare-research-stages";
import {
  createEvidenceFreezePredecessorReader,
  createEvidenceFreezeWorkflowReaders,
} from "./research-evidence-freeze-composition.js";
import { createResearchClaimAuditPromptDependencies } from "./research-claim-audit-prompt.js";
import { createResearchSynthesisPromptDependencies } from "./research-synthesis-prompt.js";
import { createResearchBranchRolePromptDependencies } from "./research-branch-role-prompt.js";
import type { RetrieveBranchesStageDependencies } from "./research-retrieve-branches.js";
import { createResearchNativeAcquisitionStageRoute } from "./research-native-acquisition.js";
import {
  createResearchStageHandlerFactory,
  SERVER_OWNED_BRANCH_HANDLER_GENERATION,
  SERVER_OWNED_EXTERNAL_AGENT_HANDLER_GENERATION,
  SERVER_OWNED_NATIVE_EXTERNAL_AGENT_HANDLER_GENERATION,
  SERVER_OWNED_FREEZE_HANDLER_GENERATION,
  type ResearchStageHandlerFactory,
} from "./research-stage-handlers.js";
import type {
  ResearchSemanticComposition,
  ResearchSemanticCompositionDependencies,
  ResearchSemanticSynthesisDependencies,
  ResearchSemanticWorkflowDependencies,
} from "./research-semantic-composition-contract.js";
import { validateResearchSemanticCompositionDependencies } from "./research-semantic-composition-validation.js";
export type {
  ResearchSemanticInstalledSynthesisPrompt,
  ResearchSemanticSynthesisPrompt,
  ResearchSemanticInstalledAuditPrompt,
  ResearchSemanticAuditPrompt,
  ResearchSemanticSynthesisModelDependencies,
  ResearchSemanticAuditModelDependencies,
  ResearchSemanticRolesModelDependencies,
  ResearchSemanticCompositionDependencies,
  ResearchSemanticSynthesisDependencies,
  ResearchSemanticComposition,
  ResearchSemanticWorkflowDependencies,
} from "./research-semantic-composition-contract.js";

function snapshotAccess(navigation: NavigationReadAuthority): RetrievalQueryAccess {
  return Object.freeze({
    principal_ref: navigation.access.principal_ref,
    client_class: navigation.access.client_class,
    credential_generation: navigation.access.credential_generation,
  });
}

function composeSynthesisPrompt(
  input: ResearchSemanticCompositionDependencies,
  context: EvidenceFreezeSynthesisContextReader,
  evidenceResolver: CloudflareEvidenceResolver,
  manifestService: ResearchModelPromptCompilerDependencies["manifest_service"],
): ResearchModelPromptCompilerDependencies {
  const prompt = input.model.synthesis.prompt;
  if (prompt.trusted_parameters !== undefined) {
    return Object.freeze({
      ...createResearchSynthesisPromptDependencies({
      database: input.database,
      work_bucket: input.work_bucket,
      operation_id: input.operation_id,
      principal: input.principal,
      context,
      navigation: input.navigation,
      evidence_resolver: evidenceResolver,
      trusted_parameters: prompt.trusted_parameters,
      request_timeout_ms: prompt.request_timeout_ms,
      }),
      ...(prompt.request_capabilities === undefined ? {} : { request_capabilities: prompt.request_capabilities }),
    });
  }
  return Object.freeze({
    manifest_service: prompt.manifest_service ?? manifestService,
    build_manifest_input: prompt.build_manifest_input,
    resolve_trusted_parameters: prompt.resolve_trusted_parameters,
    ...(prompt.request_capabilities === undefined ? {} : { request_capabilities: prompt.request_capabilities }),
    request_timeout_ms: prompt.request_timeout_ms,
  });
}

function composeAuditPrompt(
  input: ResearchSemanticCompositionDependencies,
  auditInput: ResearchClaimAuditInputReader,
  evidenceResolver: CloudflareEvidenceResolver,
  manifestStore: Pick<ReferenceManifestStore, "get">,
  manifestService: ResearchModelPromptCompilerDependencies["manifest_service"],
): ResearchClaimAuditPromptDependencies {
  const prompt = input.model.audit.prompt;
  if (prompt.trusted_parameters !== undefined) {
    return Object.freeze({
      ...createResearchClaimAuditPromptDependencies({
      database: input.database,
      work_bucket: input.work_bucket,
      operation_id: input.operation_id,
      principal: input.principal,
      audit_input: auditInput,
      navigation: input.navigation,
      evidence_resolver: evidenceResolver,
      manifest_store: manifestStore,
      trusted_parameters: prompt.trusted_parameters,
      request_timeout_ms: prompt.request_timeout_ms,
      }),
      ...(prompt.request_capabilities === undefined ? {} : { request_capabilities: prompt.request_capabilities }),
    });
  }
  return Object.freeze({
    manifest_service: prompt.manifest_service ?? manifestService,
    build_manifest_input: prompt.build_manifest_input,
    resolve_trusted_parameters: prompt.resolve_trusted_parameters,
    ...(prompt.request_capabilities === undefined ? {} : { request_capabilities: prompt.request_capabilities }),
    request_timeout_ms: prompt.request_timeout_ms,
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
  validateResearchSemanticCompositionDependencies(input);
  const now = input.now ?? (() => Date.now());
  const pricing = createD1ResearchModelPricingQuotePort(input.database, { now });
  const manifestStore = input.manifest.store ?? createResearchReferenceManifestReader({
    database: input.database, work_bucket: input.work_bucket, navigation: input.navigation,
  });
  const manifestService = createFrozenResearchReferenceManifestService(manifestStore);
  const manifestFactory: EvidenceFreezeManifestStoreFactory = input.manifest.store_factory ?? {
    create: (context) => createResearchReferenceManifestStore({
      database: input.database, work_bucket: input.work_bucket, navigation: input.navigation, context,
    }),
  };
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
    routeAuthority: input.model_profile_route_authority ?? deploymentRegistry,
    ...(input.run_configuration === undefined ? {} : { run_configuration: input.run_configuration }),
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
  const predecessorReader = createEvidenceFreezePredecessorReader(input.navigation, readers, {
    requires_branch_reconciliation: (generation) =>
      generation === SERVER_OWNED_BRANCH_HANDLER_GENERATION ||
      generation === SERVER_OWNED_NATIVE_EXTERNAL_AGENT_HANDLER_GENERATION ||
      generation === SERVER_OWNED_EXTERNAL_AGENT_HANDLER_GENERATION,
  });
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
    manifest_store_factory: manifestFactory,
    manifest_residency_template: input.manifest.residency_template,
    max_context_bytes: input.manifest.max_context_bytes,
    manifest_store: manifestStore,
  };
  const readerEnvironment = {
    database: input.database,
    work_bucket: input.work_bucket,
    manifest_store: manifestStore,
    read_stage_five: readers.read_stage_five,
  };
  const synthesisContext = createEvidenceFreezeSynthesisContextReader(
    readerEnvironment,
    input.navigation,
    readers,
  );
  const synthesis: ResearchSemanticSynthesisDependencies = {
    context: synthesisContext,
    model: {
      database: input.database,
      work_bucket: input.work_bucket,
      operation_kind: "REPORT",
      deployment_environment: input.deployment_environment,
      gateway: input.model.synthesis.gateway,
      prompt: composeSynthesisPrompt(input, synthesisContext, evidenceResolver, manifestService),
      pricing: input.model.synthesis.pricing ?? pricing,
      spend_authorization: input.model.synthesis.spend_authorization,
      ...(input.native_model_authority === undefined ? {} : { native_model_authority: input.native_model_authority }),
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
    prompt: composeAuditPrompt(input, auditInput, evidenceResolver, manifestStore, manifestService),
    pricing: input.model.audit.pricing ?? pricing,
    spend_authorization: input.model.audit.spend_authorization,
    ...(input.native_model_authority === undefined ? {} : { native_model_authority: input.native_model_authority }),
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
    manifest_store: manifestStore,
    deployment_registry: deploymentRegistry,
    model_profile: modelProfile,
    semantic_config: Object.freeze({ ...input.semantic_config }),
    freeze,
    synthesis,
    verification,
    audit_claims,
    resolve_citations,
  });
}

/** Connect the complete exploratory semantic path, including saved coverage and report output. */
export function createResearchSemanticWorkflowHandlerFactory(
  input: ResearchSemanticWorkflowDependencies,
): ResearchStageHandlerFactory {
  const semantic = createResearchSemanticComposition(input);
  const roles = input.model.roles;
  if (roles !== undefined && input.run_configuration !== undefined && input.run_configuration.mode !== "legacy-installed" &&
      (roles.gateway_for_stage === undefined || roles.prompt_for_stage === undefined)) {
    throw new Error("snapshot branch roles require stage-pinned gateway and prompt configuration");
  }
  const roleModel: ResearchBranchRoleModelExecutor | undefined = roles === undefined
    ? undefined
    : createResearchBranchRoleModelExecutor({
      database: input.database,
      work_bucket: input.work_bucket,
      gateway: roles.gateway,
      prompt: (role: ResearchBranchRole) => createResearchBranchRolePromptDependencies(
        roles.prompt(role),
      ),
      ...(roles.gateway_for_stage === undefined ? {} : {
        gateway_for_stage: roles.gateway_for_stage,
      }),
      ...(roles.prompt_for_stage === undefined ? {} : {
        prompt_for_stage: (role, stage) => createResearchBranchRolePromptDependencies(
          roles.prompt_for_stage?.(role, stage) ?? roles.prompt(role),
        ),
      }),
      prepare: roles.prepare,
      spend_authorization: roles.spend_authorization,
      pricing: roles.pricing,
      ...(roles.pricing_for_stage === undefined ? {} : { pricing_for_stage: roles.pricing_for_stage }),
      ...(input.native_model_authority === undefined ? {} : { native_model_authority: input.native_model_authority }),
      deployment_environment: input.deployment_environment,
      ...(input.now === undefined ? {} : { now: input.now }),
    });
  const environment = {
    database: input.database,
    work_bucket: input.work_bucket,
    manifest_store: semantic.manifest_store,
    read_stage_five: semantic.readers.read_stage_five,
  };
  const acquisitionSelection = input.native_acquisition_selection;
  const acquisitionRoute = acquisitionSelection === undefined ||
    acquisitionSelection.source_mode === "corpus_only" || input.native_acquisition_runtime === undefined
    ? acquisitionSelection
    : createResearchNativeAcquisitionStageRoute({
      ...input.native_acquisition_runtime,
      selection: { ...acquisitionSelection.profile, source_mode: acquisitionSelection.source_mode },
    });
  return createResearchStageHandlerFactory({
    kind: "server-owned-exploratory",
    generation: input.handler_generation ?? SERVER_OWNED_FREEZE_HANDLER_GENERATION,
    navigation: semantic.navigation,
    ledger: semantic.ledger,
    branch_execution: {
      database: input.database,
      work_bucket: input.work_bucket,
      read_stage_five: semantic.readers.read_stage_five,
      ...(roleModel === undefined ? {} : { role_model: roleModel }),
    },
    ...(acquisitionRoute === undefined ? {} : {
      acquisition_route: acquisitionRoute,
    }),
    environment: {
      CORE_DB: input.database,
      SEARCH_DB: input.search_database,
      WORK_BUCKET: input.work_bucket,
      EVIDENCE_BUCKET: input.evidence_bucket,
      ...(input.ai_search === undefined ? {} : { AI_SEARCH: input.ai_search }),
    },
    freeze: semantic.freeze,
    synthesis: semantic.synthesis,
    verification: semantic.verification,
    audit_claims: semantic.audit_claims,
    resolve_citations: semantic.resolve_citations,
    calculate_coverage: createResearchCoverageStageHandlerFromFreeze(
      environment, semantic.navigation, semantic.readers, { ledger: semantic.ledger },
    ),
    materialize_handler: createResearchCoverageMaterializeStageHandlerFromFreeze(
      environment, semantic.navigation, semantic.readers, {
        ...input.report,
        database: input.database,
        work_bucket: input.work_bucket,
        evidence_resolver: semantic.evidence_resolver,
        recheck_authority: input.recheck_authority,
        ...(input.now === undefined ? {} : { now: input.now }),
      },
    ),
  });
}
