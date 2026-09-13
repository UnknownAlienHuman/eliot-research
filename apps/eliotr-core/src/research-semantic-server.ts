import { z } from "zod";
import { IdentifierSchema, IsoDateTimeSchema, VersionedRefSchema } from "@eliotr/contracts";
import { canonicalJson, decodeModelRouteDeployment } from "@eliotr/platform-cloudflare";
import type { NavigationReadAuthority } from "@eliotr/cloudflare-evidence";
import type { InvestigationLedgerStore } from "@eliotr/research";
import { createD1ScopeProfilePort } from "@eliotr/retrieval";
import { fail, type WorkflowObject, type WorkflowPrincipal } from "@eliotr/cloudflare-workflows";
import {
  createD1ModelGatewayDeploymentRegistry,
  createResearchReportConfigSource,
  createResearchSynthesisPreparation,
  createResearchModelSpendPolicyService,
  readResearchModelSpendPolicy,
  type ResearchModelGatewayBinding,
  type TrustedModelPromptParameters,
} from "@eliotr/cloudflare-research";
import {
  createResearchClaimAuditPreparation,
  parseResearchClaimAuditPolicy,
  type ResearchClaimAuditVerifierAuthority,
} from "@eliotr/cloudflare-research-stages";
import type { Env } from "./env.js";
import { loadHeldResearchScope } from "./research-retrieval-composition.js";
import { bindResearchOwnerReportPolicy } from "./research-owner-report-policy.js";
import { createResearchSemanticWorkflowHandlerFactory } from "./research-semantic-composition.js";
import type { ResearchStageHandlerFactory } from "./research-stage-handlers.js";

const PromptSchema = z.object({
  prompt: z.string().min(1), max_tokens: z.number().int().positive().safe(),
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
  normalization: NormalizationSchema,
}).strict();

function configurationMissing(): never { return fail("WORKFLOW_AUTHORITY_STALE"); }
function installed(value: string | undefined): string {
  if (value === undefined || value.trim() === "") configurationMissing();
  return value;
}

export function researchSemanticConfigurationInstalled(env: Env): boolean {
  return [env.ELIOTR_RESEARCH_SEMANTIC_CONFIG_JSON, env.ELIOTR_MODEL_PROFILE_DEFINITION_JSON,
    env.ELIOTR_MODEL_PROFILE_PROVENANCE_REF, env.ELIOTR_MODEL_SPEND_POLICY_JSON,
    env.ELIOTR_MODEL_SPEND_POLICY_PROVENANCE_REF, env.ELIOTR_RESEARCH_REPORT_CONFIG_JSON,
    env.ELIOTR_RESEARCH_REPORT_POLICY_PROVENANCE_REF].every((value) => typeof value === "string" && value.trim() !== "") &&
    typeof (env.AI as Partial<ResearchModelGatewayBinding> | undefined)?.gateway === "function";
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
  const { env, navigation, principal } = input;
  if (!researchSemanticConfigurationInstalled(env)) configurationMissing();
  const raw = installed(env.ELIOTR_RESEARCH_SEMANTIC_CONFIG_JSON);
  if (new TextEncoder().encode(raw).byteLength > 65536) configurationMissing();
  let decoded: unknown;
  try { decoded = JSON.parse(raw); } catch { configurationMissing(); }
  const parsed = ConfigurationSchema.safeParse(decoded);
  if (!parsed.success) configurationMissing();
  const config = parsed.data;
  const policy = readResearchModelSpendPolicy(env.ELIOTR_MODEL_SPEND_POLICY_JSON, installed(env.ELIOTR_MODEL_SPEND_POLICY_PROVENANCE_REF));
  if (policy.principal_ref !== principal.principal_ref || policy.credential_generation !== principal.credential_generation ||
      policy.deployment_generation !== principal.deployment_generation || principal.deployment_generation !== env.DEPLOYMENT_GENERATION ||
      navigation.access.client_class !== "owner_pwa") configurationMissing();
  const synthesisRule = policy.rules.find((rule) => rule.stage === "SYNTHESIZE");
  const auditRule = policy.rules.find((rule) => rule.stage === "AUDIT_CLAIMS");
  if (!synthesisRule || !auditRule) configurationMissing();
  const auditDeployment = auditRule.deployment;
  const deploymentEnvironment = env.ENVIRONMENT === "development" ? "TEST" : "PRODUCTION";
  const deploymentRegistry = createD1ModelGatewayDeploymentRegistry(env.CORE_DB, { environment: deploymentEnvironment });
  const spend = createResearchModelSpendPolicyService({ database: env.CORE_DB, navigation,
    operation_id: input.operation_id, policy, deployment_registry: deploymentRegistry });
  const prepareSynthesis = createResearchSynthesisPreparation({ spend_admission: spend.admissions });
  const prepareAudit = createResearchClaimAuditPreparation({ spend_admission: spend.admissions });
  const reportSource = createResearchReportConfigSource({ raw: env.ELIOTR_RESEARCH_REPORT_CONFIG_JSON,
    provenance_ref: installed(env.ELIOTR_RESEARCH_REPORT_POLICY_PROVENANCE_REF) });
  const reportPolicy = await reportSource.readArtifactPolicy();
  if (!reportPolicy) configurationMissing();
  try { await navigation.current(); }
  catch { configurationMissing(); }
  const boundReportPolicy = (() => {
    try {
      return bindResearchOwnerReportPolicy(reportPolicy, {
        current_scope_snapshot_id: navigation.scope.snapshot_id,
        current_owner_principal_ref: principal.principal_ref,
        frozen_manifest_residency: input.initial_manifest.residency,
      });
    } catch {
      configurationMissing();
    }
  })();
  const retrievalProfile = await createD1ScopeProfilePort(env.CORE_DB).loadBinding(navigation.scope);
  const { content_digest: _contentDigest, ...residency } = input.initial_manifest.residency;
  void _contentDigest;

  const recheckAuthority = async () => {
    const held = await loadHeldResearchScope(env, navigation.access, input.operation_id, principal.deployment_generation);
    if (held.investigation_id !== input.investigation_id || held.scope_snapshot_ref.id !== navigation.scope.snapshot_id ||
        held.scope_snapshot_ref.revision !== navigation.scope.revision) configurationMissing();
    return { investigation_id: held.investigation_id, scope_snapshot_id: held.scope_snapshot_ref.id,
      scope_snapshot_revision: held.scope_snapshot_ref.revision };
  };

  async function readVerifier(): Promise<ResearchClaimAuditVerifierAuthority> {
    await navigation.current();
    const readCandidate = () => env.CORE_DB.prepare(
      "SELECT c.candidate_json FROM dynamic_route_active_generation a JOIN dynamic_route_candidate c " +
      "ON c.candidate_ref=a.candidate_ref AND c.candidate_sha256=a.candidate_sha256 " +
      "AND c.route_ref=a.route_ref AND c.route_version=a.route_version WHERE a.route_ref=?1 LIMIT 1",
    ).bind(auditDeployment.route_ref).first<{ candidate_json: string }>();
    const before = await readCandidate();
    const deployment = decodeModelRouteDeployment(await deploymentRegistry.resolve(auditDeployment.route_ref));
    if (!before || canonicalJson(deployment) !== canonicalJson(auditDeployment)) configurationMissing();
    let candidate: { execution_probe_ref?: unknown; qualification_expires_at?: unknown };
    try { candidate = JSON.parse(before.candidate_json) as typeof candidate; } catch { configurationMissing(); }
    const receipt = IdentifierSchema.safeParse(candidate.execution_probe_ref);
    const expires = IsoDateTimeSchema.safeParse(candidate.qualification_expires_at);
    if (!receipt.success || !expires.success || Date.parse(expires.data) <= Date.now() ||
        !config.audit.allowed_verifier_refs.includes(config.audit.verifier_ref)) configurationMissing();
    const after = await readCandidate();
    if (after?.candidate_json !== before.candidate_json) configurationMissing();
    await navigation.current();
    return Object.freeze({ allowed_verifier_refs: Object.freeze([...config.audit.allowed_verifier_refs]),
      verifier_ref: config.audit.verifier_ref, verifier_schema_generation: config.audit.verifier_schema_generation,
      deployment, deployment_generation: principal.deployment_generation,
      qualification_receipt_ref: receipt.data, qualification_expires_at: expires.data, qualified: true, current: true });
  }
  const verifier = await readVerifier();
  const gateway = { reasoning_gateway_base_url: env.AI_GATEWAY_REASONING_URL,
    ai_gateway_binding: env.AI as unknown as ResearchModelGatewayBinding };
  return createResearchSemanticWorkflowHandlerFactory({
    database: env.CORE_DB, search_database: env.SEARCH_DB, work_bucket: env.WORK_BUCKET, evidence_bucket: env.EVIDENCE_BUCKET,
    navigation, ledger: input.ledger, operation_id: input.operation_id, investigation_id: input.investigation_id,
    principal, retrieval_profile: retrievalProfile,
    model_profile: { raw: env.ELIOTR_MODEL_PROFILE_DEFINITION_JSON, provenance_ref: installed(env.ELIOTR_MODEL_PROFILE_PROVENANCE_REF) },
    deployment_environment: deploymentEnvironment, recheck_authority: recheckAuthority,
    manifest: { residency_template: residency, max_context_bytes: synthesisRule.max_input_bytes },
    model: {
      synthesis: { gateway, prompt: { trusted_parameters: promptParameters(config.synthesis.trusted_parameters),
        request_timeout_ms: config.synthesis.request_timeout_ms }, spend_authorization: spend.admissions,
        prepare: async (context, frozen) => {
          await spend.admit(context, frozen.stage_ten_input.model_profile_definition.deployment);
          return prepareSynthesis(context, frozen);
        } },
      audit: { gateway, prompt: { trusted_parameters: promptParameters(config.audit.trusted_parameters), request_timeout_ms: config.audit.request_timeout_ms },
        spend_authorization: spend.admissions, prepare: async (context, audit) => {
          await spend.admit(context, audit.verifier.deployment);
          return prepareAudit(context, audit);
        } },
    },
    verification: { config: config.normalization },
    audit: { normalization: config.normalization, policy: parseResearchClaimAuditPolicy(config.audit.policy),
      verifier: { authority: verifier, read_current: async (request) => {
        if (request.operation_id !== input.operation_id || request.investigation_ref.id !== input.investigation_id ||
            request.principal_ref !== principal.principal_ref || request.credential_generation !== principal.credential_generation ||
            request.deployment_generation !== principal.deployment_generation || request.scope_snapshot_ref.id !== navigation.scope.snapshot_id ||
            request.scope_snapshot_ref.revision !== navigation.scope.revision) configurationMissing();
        await recheckAuthority();
        return readVerifier();
      } } },
    report: { policy_source: reportSource, report_policy: boundReportPolicy, expected_draft_head_revision: null },
  });
}
