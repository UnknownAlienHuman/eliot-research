import {
  isSemanticResearchHandlerGeneration,
  SERVER_OWNED_BRANCH_HANDLER_GENERATION,
  SERVER_OWNED_EXTERNAL_AGENT_HANDLER_GENERATION,
} from "./research-stage-handlers.js";
import { z } from "zod";
import { DynamicRouteProvisioningError, validateModelGatewayToken } from "@eliotr/cloudflare-ai";
import { IdentifierSchema, IsoDateTimeSchema, VersionedRefSchema, type ResearchBranchRole } from "@eliotr/contracts";
import { canonicalJson, decodeModelRouteDeployment } from "@eliotr/platform-cloudflare";
import {
  createCloudflareEvidenceResolver,
  createD1EvidenceAuthorityPort,
  createR2EvidenceContentPort,
  type NavigationReadAuthority,
} from "@eliotr/cloudflare-evidence";
import type { InvestigationLedgerStore } from "@eliotr/research";
import { createD1ScopeProfilePort, type RetrievalQueryAccess } from "@eliotr/retrieval";
import { fail, readCommittedStageLineage, readWorkflowObject, WorkflowCheckpointError, workflowFailure, retainWorkflowFailure,
  WorkflowCheckpointStore, type WorkflowObject, type WorkflowPrincipal } from "@eliotr/cloudflare-workflows";
import { ResearchOwnerSpendPolicyError } from "./research-owner-spend-policy.js";
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
  type ReferenceManifestPolicyProfile,
  type ResearchModelGatewayBinding,
  type ResearchModelGatewayRuntimeConfig,
  type ResearchModelSpendPolicy,
  type TrustedModelPromptParameters,
} from "@eliotr/cloudflare-research";
import {
  createResearchClaimAuditPreparation,
  parseResearchClaimAuditPolicy,
  type ResearchClaimAuditVerifierAuthority,
} from "@eliotr/cloudflare-research-stages";
import { readResearchSemanticConfiguration, type Env } from "./env.js";
import { readResearchRunConfiguration } from "./research-run-configuration.js";
import {
  bindHandlersToRunConfiguration,
  bindResearchSemanticStageModelTransports,
  type ResearchSemanticBranchStage,
} from "./research-semantic-run-configuration-bindings.js";
import {
  resolveResearchSemanticConfig,
  semanticConfigCheckpointError,
} from "./research-semantic-config-revision.js";
import { loadHeldResearchScope } from "./research-retrieval-composition.js";
import {
  bindResearchOwnerReportPolicy,
  ResearchOwnerReportPolicyError,
  createBoundResearchOwnerReportConfigSource,
} from "./research-owner-report-policy.js";
import { requireClientResearchExecution, resolveResearchExecutionSpend } from "./research-client-execution.js";
import { createResearchSemanticWorkflowHandlerFactory, type ResearchSemanticRolesModelDependencies } from "./research-semantic-composition.js";
import { readRetrieveBranchesCheckpoint } from "./research-retrieve-branches.js";
import { createResearchBranchRoleServerPromptInput } from "./research-branch-role-server-prompt.js";
import type { ResearchStageHandlerFactory } from "./research-stage-handlers.js";
import { requireResearchDeploymentCompatibility } from "./research-deployment-compatibility.js";
import { routeResearchComputerAgentStages } from "./research-external-agent-routing.js";
import { createResearchSemanticNativeModelRuntime } from "./research-semantic-native-model-runtime.js";

const PromptSchema = z.object({
  prompt: z.string().min(1), max_tokens: z.number().int().positive().safe(),
  reasoning_effort: z.enum(["low", "medium", "high", "max"]).optional(),
  response_format: z.unknown().optional(), seed: z.number().int().optional(),
  stop: z.union([z.string(), z.array(z.string())]).optional(),
  temperature: z.number().finite().optional(), top_p: z.number().finite().optional(),
}).strict();
const PromptConfigSchema = z.object({
  trusted_parameters: PromptSchema,
  request_timeout_ms: z.number().int().min(1).max(300000),
}).strict();
const NormalizationSchema = z.object({
  section_ref: VersionedRefSchema,
  required_precision: IdentifierSchema,
  required_source_class: IdentifierSchema,
}).strict();
function promptParameters(value: z.infer<typeof PromptSchema>): TrustedModelPromptParameters {
  return { prompt: value.prompt, max_tokens: value.max_tokens,
    ...(value.reasoning_effort === undefined ? {} : { reasoning_effort: value.reasoning_effort }),
    ...(value.response_format === undefined ? {} : { response_format: value.response_format }),
    ...(value.seed === undefined ? {} : { seed: value.seed }),
    ...(value.stop === undefined ? {} : { stop: value.stop }),
    ...(value.temperature === undefined ? {} : { temperature: value.temperature }),
    ...(value.top_p === undefined ? {} : { top_p: value.top_p }) };
}
const ConfigurationSchema = z.object({
  protocol: z.literal("eliotr.research-semantic-config.v1"),
  synthesis: PromptConfigSchema,
  audit: PromptConfigSchema.extend({
    verifier_ref: IdentifierSchema,
    verifier_schema_generation: IdentifierSchema,
    allowed_verifier_refs: z.array(IdentifierSchema).min(1).max(512),
    policy: z.unknown(),
  }).strict(),
  roles: PromptConfigSchema.optional(),
  normalization: NormalizationSchema,
}).strict();

export type ResearchSemanticConfiguration = z.infer<typeof ConfigurationSchema>;

export function parseResearchSemanticConfiguration(raw: string): ResearchSemanticConfiguration {
  if (typeof raw !== "string" || raw.trim() === "") configurationMissing();
  if (new TextEncoder().encode(raw).byteLength > 65536) configurationInvalid();
  let decoded: unknown;
  try { decoded = JSON.parse(raw); }
  catch { configurationInvalid(); }
  const parsed = ConfigurationSchema.safeParse(decoded);
  if (!parsed.success) configurationInvalid();
  return parsed.data;
}

export function researchSemanticPromptParameters(
  value: ResearchSemanticConfiguration["synthesis"]["trusted_parameters"],
): TrustedModelPromptParameters {
  return promptParameters(value);
}

function configurationMissing(): never { return fail("WORKFLOW_CONFIGURATION_MISSING"); }
function configurationInvalid(): never { return fail("WORKFLOW_CONFIGURATION_INVALID"); }
function preparationError(error: unknown): WorkflowCheckpointError {
  if (error instanceof WorkflowCheckpointError) return error;
  if (error instanceof ResearchOwnerSpendPolicyError) return new WorkflowCheckpointError(
    error.code === "INVALID" ? "WORKFLOW_CONFIGURATION_INVALID" : "WORKFLOW_AUTHORITY_STALE");
  if (error instanceof ResearchOwnerReportPolicyError) return new WorkflowCheckpointError(
    error.code === "RESEARCH_OWNER_REPORT_POLICY_INVALID" ? "WORKFLOW_CONFIGURATION_INVALID" : "WORKFLOW_AUTHORITY_STALE");
  return new WorkflowCheckpointError("WORKFLOW_PREPARATION_FAILED", workflowFailure(error, "PREPARATION"));
}
function installed(value: string | undefined): string {
  if (value === undefined || value.trim() === "") configurationMissing();
  return value;
}

interface CurrentInvestigationPolicyRow {
  readonly policy_generation: unknown;
  readonly policy_authority_ref: unknown;
  readonly state: unknown;
}

export function modelGatewayConfiguration(env: Env): ResearchModelGatewayRuntimeConfig {
  const token = env.ELIOTR_MODEL_GATEWAY_TOKEN;
  if (typeof token === "string" && token.trim() !== "") {
    try { validateModelGatewayToken(token); }
    catch { fail("WORKFLOW_CREDENTIALS_INVALID"); }
    return { reasoning_gateway_base_url: env.AI_GATEWAY_REASONING_URL, gateway_token: token };
  }
  const binding = env.AI as Partial<ResearchModelGatewayBinding> | undefined;
  if (typeof binding?.gateway !== "function") fail("WORKFLOW_CREDENTIALS_MISSING");
  return { reasoning_gateway_base_url: env.AI_GATEWAY_REASONING_URL,
    ai_gateway_binding: binding as ResearchModelGatewayBinding };
}

export function researchSemanticConfigurationInstalled(env: Env): boolean {
  const hasGatewayToken = typeof env.ELIOTR_MODEL_GATEWAY_TOKEN === "string" && env.ELIOTR_MODEL_GATEWAY_TOKEN.trim() !== "";
  const hasNativeGateway = typeof (env.AI as Partial<ResearchModelGatewayBinding> | undefined)?.gateway === "function";
  const legacySemantic = readResearchSemanticConfiguration(env);
  const hasRevision = typeof env.ELIOTR_RESEARCH_SEMANTIC_CONFIG_REF === "string" &&
    env.ELIOTR_RESEARCH_SEMANTIC_CONFIG_REF.trim() !== "" &&
    typeof env.ELIOTR_RESEARCH_SEMANTIC_CONFIG_SHA256 === "string" &&
    env.ELIOTR_RESEARCH_SEMANTIC_CONFIG_SHA256.trim() !== "";
  const semantic = hasRevision || (typeof legacySemantic === "string" && legacySemantic.trim() !== "");
  return semantic &&
    [env.ELIOTR_MODEL_PROFILE_DEFINITION_JSON,
      env.ELIOTR_MODEL_PROFILE_PROVENANCE_REF, env.ELIOTR_MODEL_SPEND_POLICY_JSON,
      env.ELIOTR_MODEL_SPEND_POLICY_PROVENANCE_REF, env.ELIOTR_RESEARCH_REPORT_CONFIG_JSON,
      env.ELIOTR_RESEARCH_REPORT_POLICY_PROVENANCE_REF].every((value) => typeof value === "string" && value.trim() !== "") &&
    (hasGatewayToken || hasNativeGateway);
}

export interface ResearchSemanticServerInput {
  readonly env: Env;
  readonly operation_id: string;
  readonly investigation_id: string;
  readonly principal: WorkflowPrincipal;
  readonly navigation: NavigationReadAuthority;
  readonly ledger: Pick<InvestigationLedgerStore, "read">;
  readonly initial_manifest: WorkflowObject;
}

/** The actual Worker binding/configuration assembly used by HTTP, DO and Workflow execution. */
export async function createResearchSemanticServerHandlers(input: ResearchSemanticServerInput): Promise<ResearchStageHandlerFactory> {
  try { return await assembleResearchSemanticServerHandlers(input); }
  catch (error) {
    const safe = preparationError(error);
    const failure = workflowFailure(safe, "PREPARATION", undefined, safe.code === "WORKFLOW_STORAGE_UNAVAILABLE");
    await retainWorkflowFailure(input.env.CORE_DB, input.operation_id, input.principal, failure);
    throw new WorkflowCheckpointError(safe.code, failure);
  }
}

async function assembleResearchSemanticServerHandlers(input: ResearchSemanticServerInput): Promise<ResearchStageHandlerFactory> {
  const { navigation, principal } = input;
  const actor = Object.freeze({ operation_id: input.operation_id, investigation_id: input.investigation_id,
    principal_ref: principal.principal_ref, deployment_generation: principal.deployment_generation });
  const runConfiguration = await readResearchRunConfiguration(input.env, actor);
  const env = runConfiguration.env;
  const snapshotRunConfiguration = runConfiguration.mode === "legacy-installed" ||
      runConfiguration.configuration_ref === null || runConfiguration.configuration_sha256 === null
    ? undefined
    : Object.freeze({ mode: runConfiguration.mode, configuration_ref: runConfiguration.configuration_ref,
      configuration_sha256: runConfiguration.configuration_sha256, project_owner_ref: runConfiguration.project_owner_ref,
      project_id: runConfiguration.project_id, model_selections: runConfiguration.model_selections });
  const nativeModelRuntime = createResearchSemanticNativeModelRuntime({ env, run_configuration: snapshotRunConfiguration,
    owner_ref: principal.principal_ref });
  const gateway = modelGatewayConfiguration(env);
  if (!researchSemanticConfigurationInstalled(env)) configurationMissing();
  await requireResearchDeploymentCompatibility(env.CORE_DB, principal.deployment_generation, env.DEPLOYMENT_GENERATION);
  const runBinding = await env.CORE_DB.prepare(
    "SELECT handler_generation FROM research_workflow_run WHERE operation_id=?1 AND investigation_id=?2 " +
    "AND principal_ref=?3 AND credential_generation=?4 AND deployment_generation=?5",
  ).bind(input.operation_id, input.investigation_id, principal.principal_ref,
    principal.credential_generation, principal.deployment_generation).first<{ handler_generation: unknown }>().catch(() => fail("WORKFLOW_STORAGE_UNAVAILABLE"));
  if (!isSemanticResearchHandlerGeneration(runBinding?.handler_generation)) fail("WORKFLOW_AUTHORITY_STALE");
  const handlerGeneration = runBinding.handler_generation;
  const resolvedSemanticConfig = await resolveResearchSemanticConfig({ env, database: env.CORE_DB }).catch((error) => {
    throw semanticConfigCheckpointError(error);
  });
  const config = (() => {
    try {
      return parseResearchSemanticConfiguration(resolvedSemanticConfig.config_json);
    } catch {
      throw new WorkflowCheckpointError("WORKFLOW_CONFIGURATION_INVALID");
    }
  })();
  let policy: ResearchModelSpendPolicy;
  try {
    if (navigation.access.principal_ref !== principal.principal_ref ||
        navigation.access.credential_generation !== principal.credential_generation) {
      fail("WORKFLOW_AUTHORITY_STALE");
    }
    const beforeGrant = await navigation.current();
    const authorityRef = IdentifierSchema.parse(navigation.scope.policy_authority_ref);
    const currentPolicy = await env.CORE_DB.prepare(
      "SELECT p.policy_generation,p.policy_authority_ref,p.state FROM research_workflow_current r " +
      "JOIN investigation_current_policy p ON p.policy_generation=r.policy_generation " +
      "AND p.policy_authority_ref=r.policy_authority_ref AND p.state='ACTIVE' " +
      "WHERE r.operation_id=?1 AND r.principal_ref=?2 AND r.credential_generation=?3 " +
      "AND r.deployment_generation=?4 AND r.scope_snapshot_id=?5 AND r.scope_snapshot_revision=?6 " +
      "AND r.policy_authority_ref=?7 AND r.state='ACTIVE' LIMIT 1",
    ).bind(input.operation_id, principal.principal_ref, principal.credential_generation,
      principal.deployment_generation, navigation.scope.snapshot_id, navigation.scope.revision, authorityRef)
      .first<CurrentInvestigationPolicyRow>().catch(() => fail("WORKFLOW_STORAGE_UNAVAILABLE"));
    const generation = IdentifierSchema.safeParse(currentPolicy?.policy_generation);
    const rowAuthority = IdentifierSchema.safeParse(currentPolicy?.policy_authority_ref);
    if (currentPolicy === null || currentPolicy.state !== "ACTIVE" || !generation.success || !rowAuthority.success ||
        rowAuthority.data !== authorityRef) fail("WORKFLOW_AUTHORITY_STALE");
    const afterPolicy = await navigation.current();
    if (canonicalJson(afterPolicy) !== canonicalJson(beforeGrant)) fail("WORKFLOW_AUTHORITY_STALE");
    policy = await resolveResearchExecutionSpend(env, navigation, input.operation_id,
      principal.deployment_generation, generation.data);
    const terminalGrant = await navigation.current();
    if (canonicalJson(terminalGrant) !== canonicalJson(afterPolicy)) fail("WORKFLOW_AUTHORITY_STALE");
  } catch (error) {
    throw preparationError(error);
  }
  if (policy.principal_ref !== principal.principal_ref || policy.credential_generation !== principal.credential_generation ||
      policy.deployment_generation !== principal.deployment_generation ||
      navigation.access.client_class !== policy.client_class) fail("WORKFLOW_AUTHORITY_STALE");
  const synthesisRule = policy.rules.find((rule) => rule.stage === "SYNTHESIZE");
  const auditRule = policy.rules.find((rule) => rule.stage === "AUDIT_CLAIMS");
  if (!synthesisRule || !auditRule) configurationInvalid();
  const auditDeployment = auditRule.deployment;
  const deploymentEnvironment = env.ENVIRONMENT === "development" ? "TEST" : "PRODUCTION";
  const deploymentRegistry = createD1ModelGatewayDeploymentRegistry(env.CORE_DB, { environment: deploymentEnvironment });
  const spend = createResearchModelSpendPolicyService({ database: env.CORE_DB, navigation,
    operation_id: input.operation_id, policy, deployment_registry: deploymentRegistry,
    ...(nativeModelRuntime.authority === undefined ? {} : { native_model_authority: nativeModelRuntime.authority }),
    ...(snapshotRunConfiguration === undefined ? {} : { run_configuration: snapshotRunConfiguration }) });
  const stageModelBindings = bindResearchSemanticStageModelTransports({
    gateway, policy_rules: policy.rules,
    include_branch_stages: config.roles !== undefined,
    ...(snapshotRunConfiguration === undefined ? {} : { run_configuration: snapshotRunConfiguration }),
  });
  const { synthesis_transport: synthesisTransport, audit_transport: auditTransport,
    synthesis_gateway: synthesisGateway, audit_gateway: auditGateway } = stageModelBindings;
  const prepareSynthesis = createResearchSynthesisPreparation({ spend_admission: spend.admissions });
  const prepareAudit = createResearchClaimAuditPreparation({ spend_admission: spend.admissions });
  const reportSource = createBoundResearchOwnerReportConfigSource({
    raw: env.ELIOTR_RESEARCH_REPORT_CONFIG_JSON,
    provenance_ref: installed(env.ELIOTR_RESEARCH_REPORT_POLICY_PROVENANCE_REF),
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
  const boundReportPolicy = (() => {
    try {
      return bindResearchOwnerReportPolicy(reportPolicy, {
        current_scope_snapshot_id: navigation.scope.snapshot_id,
        current_owner_principal_ref: principal.principal_ref,
        frozen_manifest_residency: input.initial_manifest.residency,
        ...("sponsor_principal_ref" in policy ? { sponsor_principal_ref: policy.sponsor_principal_ref } : {}),
      });
    } catch (error) {
      throw preparationError(error);
    }
  })();
  const retrievalProfile = await createD1ScopeProfilePort(env.CORE_DB).loadBinding(navigation.scope);
  const { content_digest: _contentDigest, ...residency } = input.initial_manifest.residency;
  void _contentDigest;

  const recheckAuthority = async () => {
    const held = await loadHeldResearchScope(env, navigation.access, input.operation_id, principal.deployment_generation);
    if (held.investigation_id !== input.investigation_id || held.scope_snapshot_ref.id !== navigation.scope.snapshot_id ||
        held.scope_snapshot_ref.revision !== navigation.scope.revision) fail("WORKFLOW_AUTHORITY_STALE");
    return { investigation_id: held.investigation_id, scope_snapshot_id: held.scope_snapshot_ref.id,
      scope_snapshot_revision: held.scope_snapshot_ref.revision };
  };

  async function readVerifier(): Promise<ResearchClaimAuditVerifierAuthority> {
    await navigation.current();
    const selected = auditTransport?.selection;
    if (snapshotRunConfiguration !== undefined && selected === undefined) fail("WORKFLOW_QUALIFICATION_STALE");
    if (selected?.candidate_kind === "provider-native-v1") {
      if (snapshotRunConfiguration?.mode !== "snapshot-v2") fail("WORKFLOW_QUALIFICATION_STALE");
      const resolved = await nativeModelRuntime.resolvePinned("AUDIT_CLAIMS");
      if (resolved === undefined) fail("WORKFLOW_QUALIFICATION_STALE");
      const deployment = (() => {
        try { return decodeModelRouteDeployment(resolved.candidate.candidate.preparation.deployment); }
        catch { fail("WORKFLOW_OUTPUT_CORRUPT"); }
      })();
      const qualification = resolved.proof.qualification.qualification;
      const receipt = IdentifierSchema.safeParse(qualification.observation_ref);
      const expires = IsoDateTimeSchema.safeParse(qualification.expires_at);
      if (qualification.tier !== "LIVE" || canonicalJson(deployment) !== canonicalJson(auditDeployment) ||
          !receipt.success || !expires.success ||
          !config.audit.allowed_verifier_refs.includes(config.audit.verifier_ref)) {
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
          ? env.CORE_DB.prepare(
        "SELECT c.candidate_json,c.candidate_ref,c.candidate_sha256 FROM dynamic_route_active_generation a JOIN dynamic_route_candidate c " +
        "ON c.candidate_ref=a.candidate_ref AND c.candidate_sha256=a.candidate_sha256 " +
        "AND c.route_ref=a.route_ref AND c.route_version=a.route_version WHERE a.route_ref=?1 LIMIT 1",
      ).bind(auditDeployment.route_ref).first<{ candidate_json: string; candidate_ref: string; candidate_sha256: string }>()
          : env.CORE_DB.prepare(
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
        : await (deploymentRegistry.resolvePinned(auditDeployment, selected, {
          allow_expired_qualification: snapshotRunConfiguration?.mode === "snapshot-v2",
        }));
    }
    catch (error) {
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
    try { candidate = JSON.parse(before.candidate_json) as typeof candidate; } catch { fail("WORKFLOW_OUTPUT_CORRUPT"); }
    if (candidate === null || typeof candidate !== "object" || Array.isArray(candidate)) fail("WORKFLOW_OUTPUT_CORRUPT");
    const proofStore = createD1DynamicRouteQualificationProofStore(env.CORE_DB);
    const proof = selected === undefined
      ? await proofStore.readLatest({ route_ref: auditDeployment.route_ref, route_version: auditDeployment.route_version,
        candidate_ref: before.candidate_ref, candidate_sha256: before.candidate_sha256 })
      : await proofStore.readPinned({ route_ref: selected.route_ref, route_version: selected.route_version,
        candidate_ref: selected.candidate_ref, candidate_sha256: selected.candidate_sha256,
        qualification_ref: selected.qualification_ref, qualification_sha256: selected.qualification_sha256 });
    const receipt = IdentifierSchema.safeParse(proof?.qualification.execution_probe_ref ?? candidate.execution_probe_ref);
    const expires = IsoDateTimeSchema.safeParse(proof?.qualification.expires_at ?? candidate.qualification_expires_at);
    if (!receipt.success || !expires.success ||
        (snapshotRunConfiguration?.mode !== "snapshot-v2" && Date.parse(expires.data) <= Date.now()) ||
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
      const stagePricing = await nativeModelRuntime.pricingForStage(stage);
      if (stagePricing !== undefined) nativeBranchPricing.set(stage, stagePricing);
    }
  }
  if (roleConfig !== undefined) {
    let modelPolicy: ReferenceManifestPolicyProfile;
    try {
      modelPolicy = (await parseResearchModelProfileDefinition(
        JSON.parse(installed(env.ELIOTR_MODEL_PROFILE_DEFINITION_JSON)))).policy;
    } catch { configurationInvalid(); }
    const roleEvidenceAuthority = createD1EvidenceAuthorityPort({
      core_database: env.CORE_DB, search_database: env.SEARCH_DB, now: () => Date.now(),
    });
    const roleEvidenceContent = createR2EvidenceContentPort({ evidence_bucket: env.EVIDENCE_BUCKET });
    const roleEvidenceResolver = createCloudflareEvidenceResolver({
      authority: roleEvidenceAuthority, content: roleEvidenceContent, now: () => Date.now(),
    });
    const rolePricing = createD1ResearchModelPricingQuotePort(env.CORE_DB, { now: () => Date.now() });
    const roleNavigationAccess: RetrievalQueryAccess = Object.freeze({
      principal_ref: navigation.access.principal_ref,
      client_class: navigation.access.client_class,
      credential_generation: navigation.access.credential_generation,
    });
    const readBranchRoleStageFive = async (
      readerInput: { operation_id: string; investigation_id: string; principal: WorkflowPrincipal },
    ) => {
      const stored = await new WorkflowCheckpointStore(env.CORE_DB)
        .readCommittedStageRequest(readerInput.operation_id, "RETRIEVE_BRANCHES");
      if (stored === null || stored.request.investigation_ref.id !== readerInput.investigation_id) {
        fail("WORKFLOW_AUTHORITY_STALE");
      }
      const result = await readRetrieveBranchesCheckpoint({
        database: env.CORE_DB, search_database: env.SEARCH_DB, work_bucket: env.WORK_BUCKET,
        evidence_bucket: env.EVIDENCE_BUCKET, access: roleNavigationAccess, profile: retrievalProfile,
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
        new WorkflowCheckpointStore(env.CORE_DB), operation_id, "READ_AND_EXTRACT");
      const bytes = await readWorkflowObject(env.WORK_BUCKET, stored.receipt.output_manifest, true);
      const read = decodeResearchReadExtractCheckpoint(bytes);
      if (read.investigation_ref.id !== investigation_id) fail("WORKFLOW_AUTHORITY_STALE");
      return read;
    };
    roles = {
      gateway,
      prompt: (role: ResearchBranchRole) => createResearchBranchRoleServerPromptInput({
        role,
        work_bucket: env.WORK_BUCKET,
        navigation,
        evidence_resolver: roleEvidenceResolver,
        residency_template: residency,
        model_policy: modelPolicy,
        trusted_parameters: promptParameters(roleConfig.trusted_parameters),
        request_timeout_ms: roleConfig.request_timeout_ms,
      }),
      ...(stageModelBindings.branch_gateway_for_stage === undefined ? {} : {
        gateway_for_stage: stageModelBindings.branch_gateway_for_stage,
        prompt_for_stage: (role: ResearchBranchRole, stage: ResearchSemanticBranchStage) => {
          const prompt = createResearchBranchRoleServerPromptInput({
            role,
            work_bucket: env.WORK_BUCKET,
            navigation,
            evidence_resolver: roleEvidenceResolver,
            residency_template: residency,
            model_policy: modelPolicy,
            trusted_parameters: promptParameters(roleConfig.trusted_parameters),
            request_timeout_ms: roleConfig.request_timeout_ms,
          });
          const selected = stageModelBindings.branch_transport_for_stage?.(stage);
          if (selected === undefined) configurationInvalid();
          return { ...prompt, request_capabilities: selected.request_capabilities };
        },
      }),
      pricing: rolePricing,
      pricing_for_stage: (stage) => nativeBranchPricing.get(stage) ?? rolePricing,
      ...(nativeModelRuntime.authority === undefined ? {} : { native_model_authority: nativeModelRuntime.authority }),
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
    database: env.CORE_DB, search_database: env.SEARCH_DB, work_bucket: env.WORK_BUCKET, evidence_bucket: env.EVIDENCE_BUCKET,
    ai_search: env.AI_SEARCH, handler_generation: handlerGeneration,
    navigation, ledger: input.ledger, operation_id: input.operation_id, investigation_id: input.investigation_id,
    principal, retrieval_profile: retrievalProfile,
    ...(snapshotRunConfiguration === undefined ? {} : { run_configuration: snapshotRunConfiguration }),
    model_profile: { raw: env.ELIOTR_MODEL_PROFILE_DEFINITION_JSON, provenance_ref: installed(env.ELIOTR_MODEL_PROFILE_PROVENANCE_REF) },
    ...(nativeModelRuntime.authority === undefined ? {} : { native_model_authority: nativeModelRuntime.authority }),
    model_profile_route_authority: nativeModelRuntime.profileRouteAuthority(deploymentRegistry),
    semantic_config: { revision_ref: resolvedSemanticConfig.revision_ref, config_sha256: resolvedSemanticConfig.config_sha256 },
    deployment_environment: deploymentEnvironment, recheck_authority: recheckAuthority,
    manifest: { residency_template: residency, max_context_bytes: synthesisRule.max_input_bytes },
    model: {
      synthesis: { gateway: synthesisGateway, prompt: { trusted_parameters: promptParameters(config.synthesis.trusted_parameters),
        request_timeout_ms: config.synthesis.request_timeout_ms,
        ...(synthesisTransport === undefined ? {} : { request_capabilities: synthesisTransport.request_capabilities }) }, spend_authorization: spend.admissions,
        prepare: async (context, frozen) => {
          await spend.admit(context, frozen.stage_ten_input.model_profile_definition.deployment);
          return prepareSynthesis(context, frozen);
        } },
      audit: { gateway: auditGateway, prompt: { trusted_parameters: promptParameters(config.audit.trusted_parameters),
        request_timeout_ms: config.audit.request_timeout_ms,
        ...(auditTransport === undefined ? {} : { request_capabilities: auditTransport.request_capabilities }) },
        spend_authorization: spend.admissions, prepare: async (context, audit) => {
          await spend.admit(context, audit.verifier.deployment);
          return prepareAudit(context, audit);
        } },
      ...(roles === undefined ? {} : { roles }),
    },
    verification: { config: config.normalization },
    audit: { normalization: config.normalization, policy: parseResearchClaimAuditPolicy(config.audit.policy),
      verifier: { authority: verifier, read_current: async (request) => {
        if (request.operation_id !== input.operation_id || request.investigation_ref.id !== input.investigation_id ||
            request.principal_ref !== principal.principal_ref || request.credential_generation !== principal.credential_generation ||
            request.deployment_generation !== principal.deployment_generation || request.scope_snapshot_ref.id !== navigation.scope.snapshot_id ||
            request.scope_snapshot_ref.revision !== navigation.scope.revision) fail("WORKFLOW_AUTHORITY_STALE");
        await recheckAuthority();
        return readVerifier();
      } } },
    report: { policy_source: reportSource, report_policy: boundReportPolicy, expected_draft_head_revision: null },
  });
  if (handlerGeneration !== SERVER_OWNED_BRANCH_HANDLER_GENERATION &&
      handlerGeneration !== SERVER_OWNED_EXTERNAL_AGENT_HANDLER_GENERATION) {
    return bindHandlersToRunConfiguration(env, actor, runConfiguration, base);
  }
  const sponsored = handlerGeneration === SERVER_OWNED_EXTERNAL_AGENT_HANDLER_GENERATION
    ? await requireClientResearchExecution(env, navigation.access, navigation.scope,
      input.operation_id, principal.deployment_generation)
    : undefined;
  return bindHandlersToRunConfiguration(env, actor, runConfiguration, routeResearchComputerAgentStages({
    base,
    generation: handlerGeneration,
    env,
    navigation,
    ledger: input.ledger,
    retrieval_profile: retrievalProfile,
    ...(sponsored === undefined ? {} : { grant: sponsored.grant }),
  }));
}
