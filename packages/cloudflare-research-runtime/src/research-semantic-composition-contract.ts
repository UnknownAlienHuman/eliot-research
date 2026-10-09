import type { CloudflareEvidenceResolver, EvidenceAuthorityPort, EvidenceContentPort, NavigationReadAuthority } from "@eliotr/cloudflare-evidence";
import type { ModelGatewayPricingPort, ModelGatewayRequestCapabilitiesV1 } from "@eliotr/cloudflare-ai";
import type { ReferenceManifestStore } from "@eliotr/policy";
import type { InvestigationLedgerStore } from "@eliotr/research";
import type { ResearchNativeAcquisitionSelection } from "@eliotr/cloudflare-research";
import type { ScopeProfileBinding } from "@eliotr/retrieval";
import type { ResearchBranchRole } from "@eliotr/contracts";
import type { WorkflowPrincipal } from "@eliotr/cloudflare-workflows";
import type {
  createD1ModelGatewayDeploymentRegistry,
  createPersistedModelProfileBindingProducer,
  D1DynamicRouteRegistryOptions,
  ModelProfileDefinitionConfigSourceOptions,
  ResearchModelGatewayRuntimeConfig,
  ResearchModelPromptCompilerDependencies,
  TrustedModelPromptParameters,
} from "@eliotr/cloudflare-model-control";
import type {
  ResearchNativeModelAuthority,
  SpendAuthorizationReader,
} from "@eliotr/cloudflare-model-execution";
import type {
  EvidenceFreezeCommittedReaders,
  EvidenceFreezeCompositionDependencies,
  EvidenceFreezeManifestStoreFactory,
  EvidenceFreezeResidencyTemplate,
  EvidenceFreezeSynthesisContextReader,
  EvidenceFreezeSynthesisModelDependencies,
  ResearchBranchRoleModelDependencies,
} from "@eliotr/cloudflare-research-branches";
import type {
  ResearchCoverageMaterializeStageDependencies,
  ResearchClaimAuditNormalizationConfig,
  ResearchClaimAuditPolicy,
  ResearchClaimAuditVerifierSelection,
  ResearchCitationsStageDependencies,
  ResearchVerificationStageDependencies,
  ResearchVerificationV2Config,
  ResearchClaimAuditStageDependencies,
  ResearchClaimAuditPromptDependencies,
} from "@eliotr/cloudflare-research-stages";
import type { ResearchBranchRolePromptDependenciesInput } from "./research-branch-role-prompt.js";
import type { SemanticResearchHandlerGeneration } from "./research-stage-handlers.js";
import type { AiSearchNamespaceLike } from "@eliotr/platform-cloudflare";
import type { createResearchNativeAcquisitionStageRoute } from "./research-native-acquisition.js";

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
type ResearchSemanticSynthesisPromptOverrides = Omit<ResearchModelPromptCompilerDependencies, "manifest_service"> & {
  readonly manifest_service?: ResearchModelPromptCompilerDependencies["manifest_service"];
  readonly trusted_parameters?: never;
};

export interface ResearchSemanticInstalledSynthesisPrompt {
  readonly trusted_parameters: TrustedModelPromptParameters;
  /** Selected-model request limits are part of the immutable run configuration. */
  readonly request_capabilities?: ModelGatewayRequestCapabilitiesV1;
  readonly request_timeout_ms: number;
  readonly manifest_service?: never;
  readonly build_manifest_input?: never;
  readonly resolve_trusted_parameters?: never;
}

export type ResearchSemanticSynthesisPrompt =
  | ResearchSemanticInstalledSynthesisPrompt
  | ResearchSemanticSynthesisPromptOverrides;

type ResearchSemanticAuditPromptOverrides = Omit<ResearchClaimAuditPromptDependencies, "manifest_service"> & {
  readonly manifest_service?: ResearchClaimAuditPromptDependencies["manifest_service"];
  readonly trusted_parameters?: never;
};

export interface ResearchSemanticInstalledAuditPrompt {
  readonly trusted_parameters: TrustedModelPromptParameters;
  /** Selected-model request limits are part of the immutable run configuration. */
  readonly request_capabilities?: ModelGatewayRequestCapabilitiesV1;
  readonly request_timeout_ms: number;
  readonly manifest_service?: never;
  readonly build_manifest_input?: never;
  readonly resolve_trusted_parameters?: never;
}

export type ResearchSemanticAuditPrompt =
  | ResearchSemanticInstalledAuditPrompt
  | ResearchSemanticAuditPromptOverrides;

export interface ResearchSemanticSynthesisModelDependencies {
  readonly gateway: ResearchModelGatewayRuntimeConfig;
  /**
   * Server-owned prompt mode. Installed parameters use the composition's
   * frozen context/navigation/resolver; legacy callers may provide all
   * explicit compiler callbacks, but the two modes cannot be mixed.
   */
  readonly prompt: ResearchSemanticSynthesisPrompt;
  readonly pricing?: ModelGatewayPricingPort;
  readonly spend_authorization: SpendAuthorizationReader;
  readonly prepare: EvidenceFreezeSynthesisModelDependencies["prepare"];
}

export interface ResearchSemanticAuditModelDependencies {
  readonly gateway: ResearchModelGatewayRuntimeConfig;
  /** Installed parameters use the native Stage14 audit reader; legacy callers may provide explicit callbacks. */
  readonly prompt: ResearchSemanticAuditPrompt;
  readonly pricing?: ModelGatewayPricingPort;
  readonly spend_authorization: SpendAuthorizationReader;
  readonly prepare: ResearchClaimAuditStageDependencies["prepare"];
}

export interface ResearchSemanticRolesModelDependencies {
  readonly gateway: ResearchModelGatewayRuntimeConfig;
  /**
   * Installed per-role prompt inputs. The composition builds the per-role
   * prompt compiler dependencies from these via createResearchBranchRolePromptDependencies.
   */
  readonly prompt: (role: ResearchBranchRole) => ResearchBranchRolePromptDependenciesInput;
  /** Snapshot runs must resolve the actual branch W2 stage's selected route. */
  readonly gateway_for_stage?: (stage: "ANALYZE_BRANCHES" | "COUNTER_SEARCH") => ResearchModelGatewayRuntimeConfig;
  /** Snapshot runs compile role prompts with capabilities from the same selected route tuple. */
  readonly prompt_for_stage?: (
    role: ResearchBranchRole,
    stage: "ANALYZE_BRANCHES" | "COUNTER_SEARCH",
  ) => ResearchBranchRolePromptDependenciesInput;
  readonly pricing: ModelGatewayPricingPort;
  readonly pricing_for_stage?: (
    stage: "ANALYZE_BRANCHES" | "COUNTER_SEARCH",
  ) => ModelGatewayPricingPort;
  readonly spend_authorization: SpendAuthorizationReader;
  /**
   * Server-owned W3 preparation seam for branch role attempts. The spend
   * admission for branch stages is owned by the duration/budget checkpoint;
   * until it lands the server must not provide a roles config.
   */
  readonly prepare: ResearchBranchRoleModelDependencies["prepare"];
}

export interface ResearchSemanticCompositionDependencies {
  /** CORE_DB owns workflow, freeze, model profile and active route rows. */
  readonly database: D1Database;
  readonly search_database: D1Database;
  readonly work_bucket: R2Bucket;
  readonly evidence_bucket: R2Bucket;
  /** The managed search binding must survive the semantic factory as well as direct retrieval. */
  readonly ai_search?: AiSearchNamespaceLike | undefined;
  /** Server-created owner navigation; request DTOs must never supply this. */
  readonly navigation: NavigationReadAuthority;
  readonly ledger: Pick<InvestigationLedgerStore, "read">;
  readonly operation_id: string;
  readonly investigation_id: string;
  readonly principal: SemanticPrincipal;
  /** Shared current Native authority; present only for captured Native model selections. */
  readonly native_model_authority?: ResearchNativeModelAuthority;
  /** Existing profile resolver with the captured Native synthesis pin adapter, when selected. */
  readonly model_profile_route_authority?: Parameters<typeof createPersistedModelProfileBindingProducer>[0]["routeAuthority"];
  /** Immutable selection captured before Workflow.create; absent only for legacy-installed runs. */
  readonly run_configuration?: Readonly<{
    readonly mode: "legacy-installed" | "snapshot-v1" | "snapshot-v2";
    readonly configuration_ref: string;
    readonly configuration_sha256: string;
    readonly project_owner_ref?: string | null;
    readonly project_id?: string | null;
    readonly model_selections?: readonly ({
      readonly candidate_kind?: "provider-native-v1";
      readonly stage: string;
      readonly route_ref: string;
      readonly route_version: string;
      readonly candidate_ref: string;
      readonly candidate_sha256: string;
      readonly qualification_ref: string;
      readonly qualification_sha256: string;
      readonly transport_policy: unknown;
    })[];
  }>;
  /** Scope profile is read from the server-owned retrieval policy. */
  readonly retrieval_profile: ScopeProfileBinding;
  /** Explicit installed model definition; no production default is allowed. */
  readonly model_profile: ModelProfileDefinitionConfigSourceOptions;
  /**
   * S29: immutable semantic configuration revision identity bound to this
   * composition. The prompts compiled below come from exactly these bytes;
   * revision_ref is null only for the legacy env source during migration.
   */
  readonly semantic_config: {
    readonly revision_ref: string | null;
    readonly config_sha256: string;
  };
  /** Explicitly selects the D1 route qualification gate (PRODUCTION or TEST). */
  readonly deployment_environment: NonNullable<D1DynamicRouteRegistryOptions["environment"]>;
  /** The same validated clock is used by route, evidence, and profile readers. */
  readonly now?: () => number;
  /** Current run/status authority used around committed synthesis reads. */
  readonly recheck_authority: ResearchVerificationStageDependencies["recheck_authority"];
  readonly manifest: {
    readonly store?: Pick<ReferenceManifestStore, "get">;
    readonly store_factory?: EvidenceFreezeManifestStoreFactory;
    readonly residency_template: EvidenceFreezeResidencyTemplate;
    /** Must equal the installed model profile's explicit context bound. */
    readonly max_context_bytes: number;
  };
  readonly model: {
    readonly synthesis: ResearchSemanticSynthesisModelDependencies;
    readonly audit: ResearchSemanticAuditModelDependencies;
    /** Optional branch-role model execution. Absent until the duration/budget checkpoint lands role spend admission. */
    readonly roles?: ResearchSemanticRolesModelDependencies;
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
  readonly manifest_store: Pick<ReferenceManifestStore, "get">;
  readonly deployment_registry: ReturnType<typeof createD1ModelGatewayDeploymentRegistry>;
  readonly model_profile: ReturnType<typeof createPersistedModelProfileBindingProducer>;
  readonly freeze: EvidenceFreezeCompositionDependencies;
  readonly synthesis: ResearchSemanticSynthesisDependencies;
  readonly verification: ResearchVerificationStageDependencies;
  readonly audit_claims: ResearchClaimAuditStageDependencies;
  readonly resolve_citations: ResearchCitationsStageDependencies;
}

export interface ResearchSemanticWorkflowDependencies extends ResearchSemanticCompositionDependencies {
  /** Explicitly pinned by the stored run; omitted only by legacy v3 fixtures. */
  readonly handler_generation?: SemanticResearchHandlerGeneration;
  /** Exact immutable run selection; omitted only when that run has no acquisition selection. */
  readonly native_acquisition_selection?: ResearchNativeAcquisitionSelection;
  /** Native transports and owner capability; never selected by a request or model. */
  readonly native_acquisition_runtime?: Omit<Parameters<typeof createResearchNativeAcquisitionStageRoute>[0], "selection">;
  readonly report: Pick<ResearchCoverageMaterializeStageDependencies,
    "policy_source" | "report_policy" | "expected_draft_head_revision">;
}
