import { DynamicRouteProvisioningError } from "@eliotr/cloudflare-ai";
import { IdentifierSchema, IsoDateTimeSchema, type ProjectClientGrant, type ResearchBranchRole } from "@eliotr/contracts";
import { canonicalJson, decodeModelRouteDeployment, type AiSearchNamespaceLike } from "@eliotr/platform-cloudflare";
import {
  createCloudflareEvidenceResolver,
  createD1EvidenceAuthorityPort,
  createR2EvidenceContentPort,
  type NavigationReadAuthority,
} from "@eliotr/cloudflare-evidence";
import type { InvestigationLedgerStore } from "@eliotr/research";
import { createD1ScopeProfilePort, type RetrievalQueryAccess, type ScopeProfileBinding } from "@eliotr/retrieval";
import {
  fail,
  readCommittedStageLineage,
  readWorkflowObject,
  WorkflowCheckpointStore,
  type WorkflowObject,
  type WorkflowPrincipal,
} from "@eliotr/cloudflare-workflows";
import {
  createD1ModelGatewayDeploymentRegistry,
  createD1DynamicRouteQualificationProofStore,
  createD1ResearchModelPricingQuotePort,
  createEvidenceFreezeStageFiveLineage,
  createResearchBranchRolePreparation,
  createResearchBranchRoleServerPreparation,
  createResearchSynthesisPreparation,
  createResearchModelSpendPolicyService,
  decodeResearchReadExtractCheckpoint,
  parseResearchModelProfileDefinition,
  type ResearchNativeAcquisitionSelection,
  type ReferenceManifestPolicyProfile,
  type ResearchModelGatewayRuntimeConfig,
  type ResearchModelSpendPolicy,
} from "@eliotr/cloudflare-research";
import {
  createResearchClaimAuditPreparation,
  parseResearchClaimAuditPolicy,
  type ResearchClaimAuditVerifierAuthority,
} from "@eliotr/cloudflare-research-stages";
import {
  bindResearchOwnerReportPolicy,
  createBoundResearchOwnerReportConfigSource,
} from "@eliotr/cloudflare-research-configuration/research-owner-report-policy.js";
import {
  researchSemanticPromptParameters,
  type ResearchSemanticConfiguration,
} from "@eliotr/cloudflare-research-configuration/research-semantic-configuration-schema.js";
import type { ResearchSemanticBranchStage } from "./research-semantic-run-configuration-bindings.js";
import {
  bindResearchSemanticStageModelTransports,
} from "./research-semantic-run-configuration-bindings.js";
import { readRetrieveBranchesCheckpoint } from "./research-retrieve-branches.js";
import { createResearchBranchRoleServerPromptInput } from "./research-branch-role-server-prompt.js";
import {
  SERVER_OWNED_BRANCH_HANDLER_GENERATION,
  SERVER_OWNED_EXTERNAL_AGENT_HANDLER_GENERATION,
  type ResearchStageHandlerFactory,
  type SemanticResearchHandlerGeneration,
} from "./research-stage-handlers.js";
import type { ResearchSemanticRolesModelDependencies } from "./research-semantic-composition-contract.js";
import type { createResearchSemanticNativeModelRuntime } from "./research-semantic-native-model-runtime.js";
import type { ResolvedResearchRunConfiguration } from "@eliotr/cloudflare-research-configuration/research-run-configuration.js";
import { createResearchSemanticWorkflowHandlerFactory } from "./research-semantic-composition.js";
import type { createResearchNativeAcquisitionStageRoute } from "./research-native-acquisition.js";

type NativeModelRuntime = ReturnType<typeof createResearchSemanticNativeModelRuntime>;
type CapturedResearchRunConfiguration = Pick<ResolvedResearchRunConfiguration,
  "mode" | "configuration_ref" | "configuration_sha256" | "project_owner_ref" | "project_id" | "model_selections">;
type ResearchSemanticRunModelConfiguration = Omit<CapturedResearchRunConfiguration,
  "mode" | "configuration_ref" | "configuration_sha256"> & Readonly<{
    mode: Exclude<CapturedResearchRunConfiguration["mode"], "legacy-installed">;
    configuration_ref: string;
    configuration_sha256: string;
  }>;

export interface ResearchSemanticServerRuntimeInput {
  readonly database: D1Database;
  readonly search_database: D1Database;
  readonly work_bucket: R2Bucket;
  readonly evidence_bucket: R2Bucket;
  readonly ai_search: AiSearchNamespaceLike;
  readonly operation_id: string;
  readonly investigation_id: string;
  readonly principal: WorkflowPrincipal;
  readonly navigation: NavigationReadAuthority;
  readonly ledger: Pick<InvestigationLedgerStore, "read">;
  readonly initial_manifest: WorkflowObject;
  readonly handler_generation: SemanticResearchHandlerGeneration;
  readonly run_configuration?: ResearchSemanticRunModelConfiguration;
  readonly native_acquisition_selection?: ResearchNativeAcquisitionSelection;
  readonly native_acquisition_runtime?: Omit<Parameters<typeof createResearchNativeAcquisitionStageRoute>[0], "selection">;
  readonly native_model_runtime: NativeModelRuntime;
  readonly gateway: ResearchModelGatewayRuntimeConfig;
  readonly config: ResearchSemanticConfiguration;
  readonly policy: ResearchModelSpendPolicy;
  readonly semantic_config: { readonly revision_ref: string | null; readonly config_sha256: string };
  readonly deployment_environment: "TEST" | "PRODUCTION";
  readonly model_profile: { readonly raw: string | undefined; readonly provenance_ref: string | undefined };
  readonly report_config: { readonly raw: string | undefined; readonly provenance_ref: string | undefined };
  readonly recheck_authority: () => Promise<{
    readonly investigation_id: string;
    readonly scope_snapshot_id: string;
    readonly scope_snapshot_revision: number;
  }>;
  readonly require_client_execution: () => Promise<{ readonly grant: ProjectClientGrant }>;
  readonly route_external_agent_stages: (input: {
    readonly base: ResearchStageHandlerFactory;
    readonly generation: SemanticResearchHandlerGeneration;
    readonly retrieval_profile: ScopeProfileBinding;
    readonly grant?: ProjectClientGrant;
  }) => ResearchStageHandlerFactory;
  readonly bind_handlers: (handlers: ResearchStageHandlerFactory) => ResearchStageHandlerFactory;
}

function configurationMissing(): never { return fail("WORKFLOW_CONFIGURATION_MISSING"); }
function configurationInvalid(): never { return fail("WORKFLOW_CONFIGURATION_INVALID"); }

function installed(value: string | undefined): string {
  if (value === undefined || value.trim() === "") configurationMissing();
  return value;
}

/** Application assembly for a server-owned semantic research run. Core supplies authenticated bindings and adapters. */
export async function assembleResearchSemanticServerHandlers(
  input: ResearchSemanticServerRuntimeInput,
): Promise<ResearchStageHandlerFactory> {
  const { navigation, principal } = input;
  const { policy, config } = input;
  if (policy.principal_ref !== principal.principal_ref || policy.credential_generation !== principal.credential_generation ||
      policy.deployment_generation !== principal.deployment_generation ||
      navigation.access.client_class !== policy.client_class) fail("WORKFLOW_AUTHORITY_STALE");
  const synthesisRule = policy.rules.find((rule) => rule.stage === "SYNTHESIZE");
  const auditRule = policy.rules.find((rule) => rule.stage === "AUDIT_CLAIMS");
  if (!synthesisRule || !auditRule) configurationInvalid();
  const auditDeployment = auditRule.deployment;
  const deploymentRegistry = createD1ModelGatewayDeploymentRegistry(input.database, {
    environment: input.deployment_environment,
  });
  const spend = createResearchModelSpendPolicyService({
    database: input.database,
    navigation,
    operation_id: input.operation_id,
    policy,
    deployment_registry: deploymentRegistry,
    ...(input.native_model_runtime.authority === undefined ? {} : {
      native_model_authority: input.native_model_runtime.authority,
    }),
    ...(input.run_configuration === undefined ? {} : { run_configuration: input.run_configuration }),
  });
  const stageModelBindings = bindResearchSemanticStageModelTransports({
    gateway: input.gateway,
    policy_rules: policy.rules,
    include_branch_stages: config.roles !== undefined,
    ...(input.run_configuration === undefined ? {} : { run_configuration: input.run_configuration }),
  });
  const { synthesis_transport: synthesisTransport, audit_transport: auditTransport,
    synthesis_gateway: synthesisGateway, audit_gateway: auditGateway } = stageModelBindings;
  const prepareSynthesis = createResearchSynthesisPreparation({ spend_admission: spend.admissions });
  const prepareAudit = createResearchClaimAuditPreparation({ spend_admission: spend.admissions });
  const reportSource = createBoundResearchOwnerReportConfigSource({
    raw: input.report_config.raw,
    provenance_ref: installed(input.report_config.provenance_ref),
    current_spend_authority: {
      principal_ref: policy.principal_ref,
      client_class: policy.client_class,
      deployment_generation: policy.deployment_generation,
      policy_generation: policy.policy_generation,
      policy_authority_ref: policy.policy_authority_ref,
      expires_at: policy.expires_at,
      ...("sponsor_principal_ref" in policy ? { sponsor_principal_ref: policy.sponsor_principal_ref } : {}),
    },
  });
  const reportPolicy = await reportSource.readArtifactPolicy();
  if (!reportPolicy) configurationInvalid();
  await navigation.current();
  const boundReportPolicy = bindResearchOwnerReportPolicy(reportPolicy, {
    current_scope_snapshot_id: navigation.scope.snapshot_id,
    current_owner_principal_ref: principal.principal_ref,
    frozen_manifest_residency: input.initial_manifest.residency,
    ...("sponsor_principal_ref" in policy ? { sponsor_principal_ref: policy.sponsor_principal_ref } : {}),
  });
  const retrievalProfile = await createD1ScopeProfilePort(input.database).loadBinding(navigation.scope);
  const { content_digest: _contentDigest, ...residency } = input.initial_manifest.residency;
  void _contentDigest;

  async function readVerifier(): Promise<ResearchClaimAuditVerifierAuthority> {
    await navigation.current();
    const selected = auditTransport?.selection;
    if (input.run_configuration !== undefined && selected === undefined) fail("WORKFLOW_QUALIFICATION_STALE");
    if (selected?.candidate_kind === "provider-native-v1") {
      if (input.run_configuration?.mode !== "snapshot-v2") fail("WORKFLOW_QUALIFICATION_STALE");
      const resolved = await input.native_model_runtime.resolvePinned("AUDIT_CLAIMS");
      if (resolved === undefined) fail("WORKFLOW_QUALIFICATION_STALE");
      const deployment = (() => {
        try { return decodeModelRouteDeployment(resolved.candidate.candidate.preparation.deployment); }
        catch { fail("WORKFLOW_OUTPUT_CORRUPT"); }
      })();
      const qualification = resolved.proof.qualification.qualification;
      const receipt = IdentifierSchema.safeParse(qualification.observation_ref);
      const expires = IsoDateTimeSchema.safeParse(qualification.expires_at);
      if (qualification.tier !== "LIVE" || canonicalJson(deployment) !== canonicalJson(auditDeployment) ||
          !receipt.success || !expires.success || !config.audit.allowed_verifier_refs.includes(config.audit.verifier_ref)) {
        fail("WORKFLOW_QUALIFICATION_STALE");
      }
      await navigation.current();
      return Object.freeze({ allowed_verifier_refs: Object.freeze([...config.audit.allowed_verifier_refs]),
        verifier_ref: config.audit.verifier_ref, verifier_schema_generation: config.audit.verifier_schema_generation,
        deployment, deployment_generation: principal.deployment_generation,
        qualification_receipt_ref: receipt.data, qualification_expires_at: expires.data, qualified: true, current: true });
    }
    const readCandidate = async () => {
      try {
        return await (selected === undefined
          ? input.database.prepare(
            "SELECT c.candidate_json,c.candidate_ref,c.candidate_sha256 FROM dynamic_route_active_generation a JOIN dynamic_route_candidate c " +
            "ON c.candidate_ref=a.candidate_ref AND c.candidate_sha256=a.candidate_sha256 " +
            "AND c.route_ref=a.route_ref AND c.route_version=a.route_version WHERE a.route_ref=?1 LIMIT 1",
          ).bind(auditDeployment.route_ref).first<{ candidate_json: string; candidate_ref: string; candidate_sha256: string }>()
          : input.database.prepare(
            "SELECT candidate_json,candidate_ref,candidate_sha256 FROM dynamic_route_candidate " +
            "WHERE candidate_ref=?1 AND candidate_sha256=?2 AND route_ref=?3 AND route_version=?4 LIMIT 1",
          ).bind(selected.candidate_ref, selected.candidate_sha256, selected.route_ref, selected.route_version)
            .first<{ candidate_json: string; candidate_ref: string; candidate_sha256: string }>());
      } catch { fail("WORKFLOW_STORAGE_UNAVAILABLE"); }
    };
    const before = await readCandidate();
    let rawDeployment: unknown;
    try {
      rawDeployment = selected === undefined
        ? await deploymentRegistry.resolve(auditDeployment.route_ref)
        : await deploymentRegistry.resolvePinned(auditDeployment, selected, {
          allow_expired_qualification: input.run_configuration?.mode === "snapshot-v2",
        });
    } catch (error) {
      if (error instanceof DynamicRouteProvisioningError) {
        if (error.code === "DYNAMIC_ROUTE_QUALIFICATION_INVALID" || error.code === "DYNAMIC_ROUTE_LIVE_GATE_REQUIRED") {
          fail("WORKFLOW_QUALIFICATION_STALE");
        }
        if (error.code === "DYNAMIC_ROUTE_PROMOTION_FAILED") fail("WORKFLOW_OUTPUT_CORRUPT");
      }
      throw error;
    }
    if (rawDeployment === null) fail("WORKFLOW_QUALIFICATION_STALE");
    const deployment = (() => {
      try { return decodeModelRouteDeployment(rawDeployment); }
      catch { fail("WORKFLOW_OUTPUT_CORRUPT"); }
    })();
    if (!before || canonicalJson(deployment) !== canonicalJson(auditDeployment)) fail("WORKFLOW_QUALIFICATION_STALE");
    let candidate: { execution_probe_ref?: unknown; qualification_expires_at?: unknown };
    try { candidate = JSON.parse(before.candidate_json) as typeof candidate; }
    catch { fail("WORKFLOW_OUTPUT_CORRUPT"); }
    if (candidate === null || typeof candidate !== "object" || Array.isArray(candidate)) fail("WORKFLOW_OUTPUT_CORRUPT");
    const proofStore = createD1DynamicRouteQualificationProofStore(input.database);
    const proof = selected === undefined
      ? await proofStore.readLatest({ route_ref: auditDeployment.route_ref, route_version: auditDeployment.route_version,
        candidate_ref: before.candidate_ref, candidate_sha256: before.candidate_sha256 })
      : await proofStore.readPinned({ route_ref: selected.route_ref, route_version: selected.route_version,
        candidate_ref: selected.candidate_ref, candidate_sha256: selected.candidate_sha256,
        qualification_ref: selected.qualification_ref, qualification_sha256: selected.qualification_sha256 });
    const receipt = IdentifierSchema.safeParse(proof?.qualification.execution_probe_ref ?? candidate.execution_probe_ref);
    const expires = IsoDateTimeSchema.safeParse(proof?.qualification.expires_at ?? candidate.qualification_expires_at);
    if (!receipt.success || !expires.success ||
        (input.run_configuration?.mode !== "snapshot-v2" && Date.parse(expires.data) <= Date.now()) ||
        !config.audit.allowed_verifier_refs.includes(config.audit.verifier_ref)) fail("WORKFLOW_QUALIFICATION_STALE");
    const after = await readCandidate();
    if (after?.candidate_json !== before.candidate_json) fail("WORKFLOW_QUALIFICATION_STALE");
    await navigation.current();
    return Object.freeze({ allowed_verifier_refs: Object.freeze([...config.audit.allowed_verifier_refs]),
      verifier_ref: config.audit.verifier_ref, verifier_schema_generation: config.audit.verifier_schema_generation,
      deployment, deployment_generation: principal.deployment_generation,
      qualification_receipt_ref: receipt.data, qualification_expires_at: expires.data, qualified: true, current: true });
  }

  const verifier = await readVerifier();
  let roles: ResearchSemanticRolesModelDependencies | undefined;
  const roleConfig = config.roles;
  const nativeBranchPricing = new Map<ResearchSemanticBranchStage, ResearchSemanticRolesModelDependencies["pricing"]>();
  if (roleConfig !== undefined) {
    for (const stage of ["ANALYZE_BRANCHES", "COUNTER_SEARCH"] as const) {
      const stagePricing = await input.native_model_runtime.pricingForStage(stage);
      if (stagePricing !== undefined) nativeBranchPricing.set(stage, stagePricing);
    }
  }
  if (roleConfig !== undefined) {
    let modelPolicy: ReferenceManifestPolicyProfile;
    try {
      modelPolicy = (await parseResearchModelProfileDefinition(
        JSON.parse(installed(input.model_profile.raw)))).policy;
    } catch { configurationInvalid(); }
    const roleEvidenceAuthority = createD1EvidenceAuthorityPort({
      core_database: input.database, search_database: input.search_database, now: () => Date.now(),
    });
    const roleEvidenceContent = createR2EvidenceContentPort({ evidence_bucket: input.evidence_bucket });
    const roleEvidenceResolver = createCloudflareEvidenceResolver({
      authority: roleEvidenceAuthority, content: roleEvidenceContent, now: () => Date.now(),
    });
    const rolePricing = createD1ResearchModelPricingQuotePort(input.database, { now: () => Date.now() });
    const roleNavigationAccess: RetrievalQueryAccess = Object.freeze({
      principal_ref: navigation.access.principal_ref,
      client_class: navigation.access.client_class,
      credential_generation: navigation.access.credential_generation,
    });
    const readBranchRoleStageFive = async (
      readerInput: { operation_id: string; investigation_id: string; principal: WorkflowPrincipal },
    ) => {
      const stored = await new WorkflowCheckpointStore(input.database)
        .readCommittedStageRequest(readerInput.operation_id, "RETRIEVE_BRANCHES");
      if (stored === null || stored.request.investigation_ref.id !== readerInput.investigation_id) {
        fail("WORKFLOW_AUTHORITY_STALE");
      }
      const result = await readRetrieveBranchesCheckpoint({
        database: input.database, search_database: input.search_database, work_bucket: input.work_bucket,
        evidence_bucket: input.evidence_bucket, access: roleNavigationAccess, profile: retrievalProfile,
        navigation, ledger: input.ledger,
      }, stored.request, readerInput.principal);
      if (result.receipt.attempt_ref !== stored.attempt_ref) fail("WORKFLOW_OUTPUT_CORRUPT");
      return createEvidenceFreezeStageFiveLineage({
        checkpoint: result.checkpoint,
        attempt_ref: result.receipt.attempt_ref,
        request_sha256: result.receipt.request_sha256,
      });
    };
    const readBranchRoleReadExtract = async (operation_id: string, investigation_id: string) => {
      const stored = await readCommittedStageLineage(
        new WorkflowCheckpointStore(input.database), operation_id, "READ_AND_EXTRACT");
      const bytes = await readWorkflowObject(input.work_bucket, stored.receipt.output_manifest, true);
      const read = decodeResearchReadExtractCheckpoint(bytes);
      if (read.investigation_ref.id !== investigation_id) fail("WORKFLOW_AUTHORITY_STALE");
      return read;
    };
    roles = {
      gateway: input.gateway,
      prompt: (role: ResearchBranchRole) => createResearchBranchRoleServerPromptInput({
        role,
        work_bucket: input.work_bucket,
        navigation,
        evidence_resolver: roleEvidenceResolver,
        residency_template: residency,
        model_policy: modelPolicy,
        trusted_parameters: researchSemanticPromptParameters(roleConfig.trusted_parameters),
        request_timeout_ms: roleConfig.request_timeout_ms,
      }),
      ...(stageModelBindings.branch_gateway_for_stage === undefined ? {} : {
        gateway_for_stage: stageModelBindings.branch_gateway_for_stage,
        prompt_for_stage: (role: ResearchBranchRole, stage: ResearchSemanticBranchStage) => {
          const prompt = createResearchBranchRoleServerPromptInput({
            role,
            work_bucket: input.work_bucket,
            navigation,
            evidence_resolver: roleEvidenceResolver,
            residency_template: residency,
            model_policy: modelPolicy,
            trusted_parameters: researchSemanticPromptParameters(roleConfig.trusted_parameters),
            request_timeout_ms: roleConfig.request_timeout_ms,
          });
          const selected = stageModelBindings.branch_transport_for_stage?.(stage);
          if (selected === undefined) configurationInvalid();
          return { ...prompt, request_capabilities: selected.request_capabilities };
        },
      }),
      pricing: rolePricing,
      pricing_for_stage: (stage) => nativeBranchPricing.get(stage) ?? rolePricing,
      ...(input.native_model_runtime.authority === undefined ? {} : {
        native_model_authority: input.native_model_runtime.authority,
      }),
      spend_authorization: spend.admissions,
      prepare: createResearchBranchRoleServerPreparation({
        read_stage_five: readBranchRoleStageFive,
        read_read_extract: readBranchRoleReadExtract,
        policy_rules: policy.rules,
        admit_branch_role: (admissionInput) => spend.admitBranchRole(admissionInput),
        prepare_attempt: createResearchBranchRolePreparation(),
      }),
    };
  }
  const base = createResearchSemanticWorkflowHandlerFactory({
    database: input.database, search_database: input.search_database, work_bucket: input.work_bucket,
    evidence_bucket: input.evidence_bucket, ai_search: input.ai_search, handler_generation: input.handler_generation,
    navigation, ledger: input.ledger, operation_id: input.operation_id, investigation_id: input.investigation_id,
    principal, retrieval_profile: retrievalProfile,
    ...(input.run_configuration === undefined ? {} : { run_configuration: input.run_configuration }),
    ...(input.native_acquisition_selection === undefined ? {} : {
      native_acquisition_selection: input.native_acquisition_selection,
    }),
    ...(input.native_acquisition_runtime === undefined ? {} : {
      native_acquisition_runtime: input.native_acquisition_runtime,
    }),
    model_profile: {
      raw: input.model_profile.raw,
      provenance_ref: installed(input.model_profile.provenance_ref),
    },
    ...(input.native_model_runtime.authority === undefined ? {} : {
      native_model_authority: input.native_model_runtime.authority,
    }),
    model_profile_route_authority: input.native_model_runtime.profileRouteAuthority(deploymentRegistry),
    semantic_config: input.semantic_config,
    deployment_environment: input.deployment_environment,
    recheck_authority: input.recheck_authority,
    manifest: { residency_template: residency, max_context_bytes: synthesisRule.max_input_bytes },
    model: {
      synthesis: {
        gateway: synthesisGateway,
        prompt: {
          trusted_parameters: researchSemanticPromptParameters(config.synthesis.trusted_parameters),
          request_timeout_ms: config.synthesis.request_timeout_ms,
          ...(synthesisTransport === undefined ? {} : { request_capabilities: synthesisTransport.request_capabilities }),
        },
        spend_authorization: spend.admissions,
        prepare: async (context, frozen) => {
          await spend.admit(context, frozen.stage_ten_input.model_profile_definition.deployment);
          return prepareSynthesis(context, frozen);
        },
      },
      audit: {
        gateway: auditGateway,
        prompt: {
          trusted_parameters: researchSemanticPromptParameters(config.audit.trusted_parameters),
          request_timeout_ms: config.audit.request_timeout_ms,
          ...(auditTransport === undefined ? {} : { request_capabilities: auditTransport.request_capabilities }),
        },
        spend_authorization: spend.admissions,
        prepare: async (context, audit) => {
          await spend.admit(context, audit.verifier.deployment);
          return prepareAudit(context, audit);
        },
      },
      ...(roles === undefined ? {} : { roles }),
    },
    verification: { config: config.normalization },
    audit: {
      normalization: config.normalization,
      policy: parseResearchClaimAuditPolicy(config.audit.policy),
      verifier: {
        authority: verifier,
        read_current: async (request) => {
          if (request.operation_id !== input.operation_id || request.investigation_ref.id !== input.investigation_id ||
              request.principal_ref !== principal.principal_ref ||
              request.credential_generation !== principal.credential_generation ||
              request.deployment_generation !== principal.deployment_generation ||
              request.scope_snapshot_ref.id !== navigation.scope.snapshot_id ||
              request.scope_snapshot_ref.revision !== navigation.scope.revision) fail("WORKFLOW_AUTHORITY_STALE");
          await input.recheck_authority();
          return readVerifier();
        },
      },
    },
    report: { policy_source: reportSource, report_policy: boundReportPolicy, expected_draft_head_revision: null },
  });
  if (input.handler_generation !== SERVER_OWNED_BRANCH_HANDLER_GENERATION &&
      input.handler_generation !== SERVER_OWNED_EXTERNAL_AGENT_HANDLER_GENERATION) {
    return input.bind_handlers(base);
  }
  const sponsored = input.handler_generation === SERVER_OWNED_EXTERNAL_AGENT_HANDLER_GENERATION
    ? await input.require_client_execution()
    : undefined;
  return input.bind_handlers(input.route_external_agent_stages({
    base,
    generation: input.handler_generation,
    retrieval_profile: retrievalProfile,
    ...(sponsored === undefined ? {} : { grant: sponsored.grant }),
  }));
}
