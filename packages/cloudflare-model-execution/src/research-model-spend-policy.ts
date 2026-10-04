// IMPLEMENTED_NOT_LIVE: S37 branch-aware W3 spend admission for ANALYZE_BRANCHES/COUNTER_SEARCH admits per-role model spend against the durable stage-level W2 authority with role-scoped identities; D1-backed admission readback qualification remains open.
import { z } from "zod";
import { IdentifierSchema, IsoDateTimeSchema, OperationIntentSchema, ResearchBranchRoleSchema, type ResearchBranchRole } from "@eliotr/contracts";
import { modelGatewaySha256 } from "@eliotr/cloudflare-ai";
import { canonicalJson, decodeModelRouteDeployment, type ModelRouteDeployment } from "@eliotr/platform-cloudflare";
import type { NavigationReadAuthority } from "@eliotr/cloudflare-evidence";
import { StageRequestSchema, fail as workflowFail, textDigest, type StageRequest } from "@eliotr/cloudflare-workflows";
import { ModelAttemptError, type ModelAttemptAuthority, type ModelCostQuote } from "./model-attempt-types.js";
import { deriveModelAttemptIdentity, type ModelAttemptPreparationContext } from "./model-attempt-handler.js";
import type {
  ResearchNativeModelAuthorityBinding,
  ResearchModelPinnedSelection,
  SpendAuthorizationReadRequest,
} from "./research-model-attempt-revalidator.js";
import type { PinnedModelSelection } from "@eliotr/cloudflare-model-control";
import {
  decodeProviderNativeModelSelection,
  type ProviderNativeModelAuthorityPort,
  type ProviderNativeModelSelectionV1,
} from "@eliotr/cloudflare-native-models";
import {
  createD1ResearchModelSpendAdmissionPort,
  RESEARCH_MODEL_SPEND_APPROVAL_PROTOCOL,
  type ResearchModelSpendAdmissionPort,
  type ResearchModelSpendAdmissionRecord,
  type ResearchModelSpendCurrentAuthority,
} from "./research-model-spend-admission.js";

const count = z.number().int().nonnegative().safe();
const cost = z.number().finite().nonnegative();
const QuoteEstimateSchema = z.object({
  estimated_model_calls: count.min(1), estimated_input_tokens: count, estimated_output_tokens: count,
  estimated_embedding_tokens: count, quoted_neurons: cost, platform_usd: cost, workers_ai_usd: cost,
  byok_usd: cost, max_total_usd: cost, workflow_steps: count.min(1), expected_sources: count,
  expected_sections: count, confidence: z.number().min(0).max(1),
}).strict();
const RuleSchema = z.object({
  stage: z.enum(["ANALYZE_BRANCHES", "COUNTER_SEARCH", "SYNTHESIZE", "AUDIT_CLAIMS"]),
  deployment: z.unknown(),
  max_input_bytes: count.min(1).max(256 * 1024),
  max_output_bytes: count.min(1).max(256 * 1024),
  quote: QuoteEstimateSchema,
}).strict();
function validRuleStages(rules: readonly { readonly stage: string }[]): boolean {
  const stages = rules.map((rule) => rule.stage);
  return new Set(stages).size === stages.length && stages.includes("SYNTHESIZE") && stages.includes("AUDIT_CLAIMS");
}
const PolicySchema = z.object({
  protocol: z.literal("eliotr.research-model-spend-policy.v1"),
  approved: z.literal(true),
  policy_ref: IdentifierSchema,
  config_provenance_ref: IdentifierSchema,
  principal_ref: IdentifierSchema,
  client_class: z.literal("owner_pwa"),
  credential_generation: IdentifierSchema,
  deployment_generation: IdentifierSchema,
  policy_generation: IdentifierSchema,
  policy_authority_ref: IdentifierSchema,
  expires_at: IsoDateTimeSchema,
  rules: z.array(RuleSchema).min(2).max(4).refine(validRuleStages,
    { message: "model spend policy rules must list unique stages including SYNTHESIZE and AUDIT_CLAIMS" }),
}).strict();

type SpendRule = Omit<z.infer<typeof RuleSchema>, "deployment"> & { readonly deployment: ModelRouteDeployment };
const DelegatedPolicySchema = PolicySchema.extend({
  protocol: z.literal("eliotr.research-delegated-model-spend-policy.v1"),
  client_class: z.enum(["trusted_agent", "named_api_client"]),
  sponsor_principal_ref: IdentifierSchema,
  sponsor_policy_sha256: z.string().regex(/^[0-9a-f]{64}$/u),
});
export type ResearchModelSpendPolicy = Omit<z.infer<typeof PolicySchema>, "rules"> & { readonly rules: readonly SpendRule[] }
  | Omit<z.infer<typeof DelegatedPolicySchema>, "rules"> & { readonly rules: readonly SpendRule[] };
const OwnerSpendPolicyTemplateV1Schema = PolicySchema.omit({
  credential_generation: true,
  policy_generation: true,
  policy_authority_ref: true,
}).extend({ protocol: z.literal("eliotr.research-owner-spend-template.v1") });
const OwnerSpendPolicyTemplateV2Schema = PolicySchema.omit({
  credential_generation: true,
  policy_generation: true,
  policy_authority_ref: true,
  deployment_generation: true,
  expires_at: true,
}).extend({
  protocol: z.literal("eliotr.research-owner-spend-template.v2"),
  /** Optional owner-chosen sunset; operational grants still bound every run. */
  expires_at: IsoDateTimeSchema.optional(),
});
type SpendTemplateV1 = Omit<z.infer<typeof OwnerSpendPolicyTemplateV1Schema>, "rules"> & {
  readonly rules: readonly SpendRule[];
};
type SpendTemplateV2 = Omit<z.infer<typeof OwnerSpendPolicyTemplateV2Schema>, "rules"> & {
  readonly rules: readonly SpendRule[];
};
export type ResearchOwnerSpendPolicyTemplate = SpendTemplateV1 | SpendTemplateV2;

/** This is installed operator approval, never a public request or an inferred scope permission. */
export function readResearchModelSpendPolicy(raw: string | undefined, provenance: string): ResearchModelSpendPolicy {
  if (!raw || new TextEncoder().encode(raw).byteLength > 65536) stale("installed model spend policy is missing or oversized");
  try {
    const parsed = z.union([PolicySchema, DelegatedPolicySchema]).parse(JSON.parse(raw));
    if (parsed.config_provenance_ref !== provenance || !validRuleStages(parsed.rules)) {
      stale("installed model spend policy provenance or stage selection is invalid");
    }
    return Object.freeze({ ...parsed, rules: Object.freeze(parsed.rules.map((rule) => Object.freeze({
      ...rule, quote: Object.freeze(rule.quote), deployment: decodeModelRouteDeployment(rule.deployment),
    }))) });
  } catch (cause) {
    stale("installed model spend policy is invalid", cause);
  }
}

/** Read the static owner approval whose session-varying authority is bound by the Worker. */
export function readResearchOwnerSpendPolicyTemplate(raw: string | undefined, provenance: string): ResearchOwnerSpendPolicyTemplate {
  if (!raw || new TextEncoder().encode(raw).byteLength > 65536) stale("installed owner spend template is missing or oversized");
  try {
    const decoded: unknown = JSON.parse(raw);
    const protocol = typeof decoded === "object" && decoded !== null && !Array.isArray(decoded)
      ? (decoded as { protocol?: unknown }).protocol : undefined;
    const parsed = protocol === "eliotr.research-owner-spend-template.v2"
      ? OwnerSpendPolicyTemplateV2Schema.parse(decoded)
      : OwnerSpendPolicyTemplateV1Schema.parse(decoded);
    if (parsed.config_provenance_ref !== provenance || !validRuleStages(parsed.rules)) {
      stale("installed owner spend template provenance or stage selection is invalid");
    }
    return Object.freeze({ ...parsed, rules: Object.freeze(parsed.rules.map((rule) => Object.freeze({
      ...rule, quote: Object.freeze(rule.quote), deployment: decodeModelRouteDeployment(rule.deployment),
    }))) });
  } catch (cause) {
    stale("installed owner spend template is invalid", cause);
  }
}

function stale(message: string, cause?: unknown): never {
  throw new ModelAttemptError("MODEL_ATTEMPT_AUTHORITY_STALE", message, true, cause);
}

interface CurrentStage {
  readonly operation_id: string;
  readonly principal_ref: string;
  readonly credential_generation: string;
  readonly deployment_generation: string;
  readonly policy_generation: string;
  readonly policy_authority_ref: string;
  readonly authorization_receipt_ref: string;
  readonly scope_snapshot_id: string;
  readonly scope_snapshot_revision: number;
  readonly purge_revision: number;
  readonly stage_index: number;
  readonly attempt_ref: string;
  readonly request_sha256: string;
  readonly request_json: string;
  readonly budget_receipt_ref: string;
  readonly budget_expires_at_ms: number;
  readonly grant_expires_at: string;
  readonly scope_expires_at: string;
  readonly started_at: string;
}

export interface ResearchModelSpendPolicyServiceInput {
  readonly database: D1Database;
  readonly navigation: NavigationReadAuthority;
  readonly operation_id: string;
  readonly policy: ResearchModelSpendPolicy;
  readonly deployment_registry: {
    resolve(route: string): Promise<unknown | null>;
    resolvePinned?(deployment: ModelRouteDeployment, selection: PinnedModelSelection,
      options?: Readonly<{ allow_expired_qualification?: boolean }>): Promise<unknown | null>;
  };
  readonly native_model_authority?: Pick<ProviderNativeModelAuthorityPort, "resolvePinned">;
  /** Validated immutable run-configuration association supplied by the Worker snapshot reader. */
  readonly run_configuration?: Readonly<{
    readonly mode: "legacy-installed" | "snapshot-v1" | "snapshot-v2";
    readonly configuration_ref: string;
    readonly configuration_sha256: string;
    readonly project_owner_ref?: string | null;
    readonly project_id?: string | null;
    readonly model_selections?: readonly ((PinnedModelSelection & { readonly stage: string }) | ProviderNativeModelSelectionV1)[];
  }>;
  readonly now?: () => number;
}

export interface ResearchModelSpendPolicyService {
  readonly admissions: ResearchModelSpendAdmissionPort;
  /** Record the installed explicit decision before the existing W3 reservation. */
  admit(input: ModelAttemptPreparationContext, deployment: ModelRouteDeployment): Promise<void>;
  /** Record the installed explicit branch-role decision before the existing W3 reservation. */
  admitBranchRole(input: ResearchBranchRoleSpendAdmissionInput): Promise<ResearchModelSpendAdmissionRecord>;
}

/**
 * Input for admitting one branch role's model spend. The stage request is the
 * recovered stage-level request (role suffix stripped); the role context
 * carries the role-scoped request sha and W3 identity derived from it.
 */
export interface ResearchBranchRoleSpendAdmissionInput {
  /** Stage-level request (recovered by stripping the `:branch-role:${ROLE}` suffix). */
  readonly stage_request: StageRequest;
  /** Stage-level W2 request sha. */
  readonly stage_request_sha256: string;
  /** Role-scoped preparation context: role-scoped request sha and W3 identity. */
  readonly role_context: ModelAttemptPreparationContext;
  readonly role: ResearchBranchRole;
  readonly deployment: ModelRouteDeployment;
}

/** Connect the explicit installed policy to current D1 authority and the durable spend adapter. */
export function createResearchModelSpendPolicyService(input: ResearchModelSpendPolicyServiceInput): ResearchModelSpendPolicyService {
  const policy = readResearchModelSpendPolicy(canonicalJson(input.policy), input.policy.config_provenance_ref);
  const now = input.now ?? Date.now;
  const policySha = modelGatewaySha256(canonicalJson(policy));
  const navigation = input.navigation;
  const runConfiguration = input.run_configuration;

  function pinnedSelection(stage: string, deployment: ModelRouteDeployment): ResearchModelPinnedSelection {
    if ((runConfiguration?.mode !== "snapshot-v1" && runConfiguration?.mode !== "snapshot-v2") ||
        !/^rrc-[a-f0-9]{24}$/u.test(runConfiguration.configuration_ref) ||
        !/^[a-f0-9]{64}$/u.test(runConfiguration.configuration_sha256) ||
        !runConfiguration.model_selections) {
      stale("snapshot model authority requires an immutable run configuration selection");
    }
    const matches = runConfiguration.model_selections.filter((selection) => selection.stage === stage);
    if (matches.length !== 1) stale("run configuration does not select one exact model qualification for this stage");
    const selection = matches[0];
    if (selection === undefined) stale("run configuration does not select one exact model qualification for this stage");
    if (selection.route_ref !== deployment.route_ref || selection.route_version !== deployment.route_version) {
      stale("selected model candidate differs from the pinned stage deployment");
    }
    if ("candidate_kind" in selection && selection.candidate_kind === "provider-native-v1") {
      let nativeSelection: ProviderNativeModelSelectionV1;
      try { nativeSelection = decodeProviderNativeModelSelection(selection); }
      catch (cause) { stale("snapshot Native model selection is malformed", cause); }
      if (runConfiguration.mode !== "snapshot-v2" || typeof runConfiguration.project_owner_ref !== "string" ||
          runConfiguration.project_owner_ref !== policy.principal_ref || typeof runConfiguration.project_id !== "string" ||
          runConfiguration.project_id.length === 0 || input.native_model_authority === undefined) {
        stale("Native model selection lacks its current snapshot-v2 owner/project authority");
      }
      return nativeSelection;
    }
    return Object.freeze({
      route_ref: selection.route_ref,
      route_version: selection.route_version,
      candidate_ref: selection.candidate_ref,
      candidate_sha256: selection.candidate_sha256,
      qualification_ref: selection.qualification_ref,
      qualification_sha256: selection.qualification_sha256,
    });
  }

  async function current(attempt: string, requestSha: string) {
    const grant = await navigation.current();
    const row = await input.database.prepare(
      "SELECT r.operation_id,r.principal_ref,r.credential_generation,r.deployment_generation,r.policy_generation," +
      "r.policy_authority_ref,r.authorization_receipt_ref,r.scope_snapshot_id,r.scope_snapshot_revision,r.purge_revision," +
      "a.stage_index,a.attempt_ref,a.request_sha256,a.request_json,a.budget_receipt_ref,a.budget_expires_at_ms,a.created_at AS started_at," +
      "g.expires_at AS grant_expires_at,s.expires_at AS scope_expires_at " +
      "FROM research_workflow_current r JOIN research_workflow_attempt a ON a.operation_id=r.operation_id " +
      "JOIN scope_snapshot s ON s.snapshot_id=r.scope_snapshot_id AND s.revision=r.scope_snapshot_revision " +
      "JOIN scope_access_grant g ON g.snapshot_id=s.snapshot_id AND g.snapshot_revision=s.revision AND g.principal_ref=r.principal_ref " +
      "WHERE r.operation_id=?1 AND a.attempt_ref=?2 AND a.request_sha256=?3 AND r.state='ACTIVE' " +
      "AND a.state='STARTED' AND a.output_json IS NULL AND a.stage_index IN (8,9,12,14) AND r.next_stage_index=a.stage_index " +
      "AND r.current_revision=a.expected_revision AND r.ledger_revision=a.expected_revision AND s.invalidated_at IS NULL " +
      "AND g.state='ACTIVE' AND g.client_class=?4 AND g.credential_generation=r.credential_generation " +
      "AND g.authorization_receipt_ref=r.authorization_receipt_ref AND g.policy_authority_ref=r.policy_authority_ref " +
      "AND EXISTS(SELECT 1 FROM investigation_current_policy p WHERE p.policy_generation=r.policy_generation AND p.policy_authority_ref=r.policy_authority_ref AND p.state='ACTIVE') " +
      "AND EXISTS(SELECT 1 FROM research_deployment_compatible c WHERE c.origin_deployment_generation=r.deployment_generation) LIMIT 1",
    ).bind(input.operation_id, attempt, requestSha, policy.client_class).first<CurrentStage>();
    if (row === null || row.principal_ref !== policy.principal_ref || row.credential_generation !== policy.credential_generation ||
        row.deployment_generation !== policy.deployment_generation || row.policy_generation !== policy.policy_generation ||
        row.policy_authority_ref !== policy.policy_authority_ref || navigation.access.principal_ref !== row.principal_ref ||
        navigation.access.credential_generation !== row.credential_generation || navigation.access.client_class !== policy.client_class || navigation.scope.snapshot_id !== row.scope_snapshot_id ||
        navigation.scope.revision !== row.scope_snapshot_revision || grant.policy_authority_ref !== row.policy_authority_ref ||
        !grant.allowed_use.includes("research")) stale("model spend policy does not permit this current owner workflow");
    const stage = row.stage_index === 12 ? "SYNTHESIZE" : row.stage_index === 14 ? "AUDIT_CLAIMS" : row.stage_index === 8 ? "ANALYZE_BRANCHES" : "COUNTER_SEARCH";
    const rule = policy.rules.find((value) => value.stage === stage);
    if (rule === undefined || !Number.isSafeInteger(row.budget_expires_at_ms)) stale("model stage policy or execution grant is unavailable");
    const expires = Math.min(Date.parse(policy.expires_at), Date.parse(row.grant_expires_at),
      Date.parse(row.scope_expires_at), row.budget_expires_at_ms);
    if (!Number.isFinite(expires) || expires <= now()) stale("model stage approval or current authority has expired");
    const request = StageRequestSchema.parse(JSON.parse(row.request_json));
    if (JSON.stringify(request) !== row.request_json || await textDigest(row.request_json) !== row.request_sha256 ||
        request.stage !== stage || request.operation_id !== input.operation_id) stale("current model stage request is invalid");
    const runMode = runConfiguration?.mode;
    const pinned = runMode === "snapshot-v1" || runMode === "snapshot-v2";
    const selected = pinned ? pinnedSelection(stage, rule.deployment) : undefined;
    const nativeSelection = selected !== undefined && "candidate_kind" in selected &&
      selected.candidate_kind === "provider-native-v1" ? selected : undefined;
    const nativeBinding: ResearchNativeModelAuthorityBinding | undefined = nativeSelection === undefined ? undefined : {
      owner_ref: runConfiguration?.project_owner_ref as string,
      project_id: runConfiguration?.project_id as string,
    };
    let rawDeployment: unknown;
    if (nativeSelection !== undefined) {
      const nativeAuthority = input.native_model_authority;
      if (nativeAuthority === undefined || nativeBinding === undefined || runMode !== "snapshot-v2") {
        stale("pinned Native model authority is unavailable");
      }
      let resolved: Awaited<ReturnType<typeof nativeAuthority.resolvePinned>>;
      try {
        resolved = await nativeAuthority.resolvePinned({ selection: nativeSelection, ...nativeBinding,
          allow_expired_snapshot_v2: true });
      } catch (cause) { stale("pinned Native model selection is no longer current", cause); }
      if (canonicalJson(resolved.selection) !== canonicalJson(nativeSelection)) {
        stale("resolved Native model differs from the immutable run selection");
      }
      rawDeployment = resolved.candidate.candidate.preparation.deployment;
    } else if (selected !== undefined) {
      rawDeployment = await (input.deployment_registry.resolvePinned?.(rule.deployment, selected as PinnedModelSelection, {
        allow_expired_qualification: runMode === "snapshot-v2",
      }) ?? Promise.reject(new Error("pinned model resolver is unavailable")));
    } else {
      rawDeployment = await input.deployment_registry.resolve(rule.deployment.route_ref);
    }
    const deployment = decodeModelRouteDeployment(rawDeployment);
    if (canonicalJson(deployment) !== canonicalJson(rule.deployment)) stale("installed model route is no longer the approved deployment");
    const identity = await deriveModelAttemptIdentity({ stage_request_sha256: row.request_sha256,
      principal_ref: row.principal_ref, credential_generation: row.credential_generation, deployment_generation: row.deployment_generation });
    const configurationIdentity = runConfiguration === undefined ? null : {
      configuration_ref: runConfiguration.configuration_ref,
      configuration_sha256: runConfiguration.configuration_sha256,
      mode: runConfiguration.mode,
      project_owner_ref: runConfiguration.project_owner_ref ?? null,
      project_id: runConfiguration.project_id ?? null,
    };
    const decisionRef = `model-policy-${await modelGatewaySha256(canonicalJson({ policy_sha256: await policySha,
      configuration: configurationIdentity }))}-${row.request_sha256.slice(0,32)}`;
    const authority: ModelAttemptAuthority = {
      principal_ref: row.principal_ref, client_class: policy.client_class, policy_decision_ref: decisionRef,
      scope_snapshot_ref: { id: row.scope_snapshot_id, revision: row.scope_snapshot_revision },
      credential_generation: row.credential_generation, deployment_generation: row.deployment_generation,
      policy_generation: row.policy_generation,
      currentness_digest: await modelGatewaySha256(canonicalJson({ policy_sha256: await policySha,
        authorization_receipt_ref: row.authorization_receipt_ref, scope_digest: navigation.scope.digest,
        purge_revision: row.purge_revision, stage_request_sha256: row.request_sha256,
        configuration: configurationIdentity,
        ...(selected === undefined ? {} : { model_selection: selected }),
        ...(nativeBinding === undefined ? {} : { native_authority_binding: nativeBinding }) })),
      expires_at: new Date(expires).toISOString(),
    };
    if (canonicalJson(await navigation.current()) !== canonicalJson(grant)) stale("model authorization changed while reading policy");
    return { row, rule, request, deployment, identity, authority,
      ...(selected === undefined ? {} : { model_selection: selected,
        run_configuration_mode: runMode as "snapshot-v1" | "snapshot-v2" }),
      ...(nativeBinding === undefined ? {} : { native_authority_binding: nativeBinding }) };
  }

  async function readCurrent(request: SpendAuthorizationReadRequest): Promise<ResearchModelSpendCurrentAuthority> {
    if (request.workflow_stage_request_sha256 !== undefined) {
      // Branch role stage: the W2 authority is read by the stage-level request
      // sha. The role-level W3 identity intentionally differs; the role binding
      // is validated by admitBranchRole and by the port's assertRequest.
      const value = await current(request.stage_attempt_ref, request.workflow_stage_request_sha256);
      return { authority: value.authority, expected_deployment: value.deployment,
        ...(value.model_selection === undefined ? {} : { model_selection: value.model_selection,
          run_configuration_mode: value.run_configuration_mode }),
        ...(value.native_authority_binding === undefined ? {} : { native_authority_binding: value.native_authority_binding }) };
    }
    const value = await current(request.stage_attempt_ref, request.stage_request_sha256);
    if (request.operation_id !== value.identity.operation_id || request.principal_ref !== value.authority.principal_ref ||
        request.route_ref !== value.deployment.route_ref || request.workflow_authorization_receipt_ref !== value.row.authorization_receipt_ref ||
        canonicalJson(request.scope_snapshot_ref) !== canonicalJson(value.authority.scope_snapshot_ref) ||
        request.reservation_id !== `model-reservation-${value.row.request_sha256}` ||
        request.quote_ref !== `model-quote-${value.row.request_sha256}`) stale("spend readback is outside the exact approved call");
    return { authority: value.authority, expected_deployment: value.deployment,
      ...(value.model_selection === undefined ? {} : { model_selection: value.model_selection,
        run_configuration_mode: value.run_configuration_mode }),
      ...(value.native_authority_binding === undefined ? {} : { native_authority_binding: value.native_authority_binding }) };
  }

  const admissions = createD1ResearchModelSpendAdmissionPort(input.database, { read_current_authority: readCurrent, now });
  return Object.freeze({ admissions, async admit(context: ModelAttemptPreparationContext, expected: ModelRouteDeployment) {
    const value = await current(context.attempt_ref, context.stage_request_sha256);
    if (context.model_operation_id !== value.identity.operation_id || context.model_idempotency_key !== value.identity.idempotency_key ||
        context.budget_receipt_ref !== value.row.budget_receipt_ref || canonicalJson(expected) !== canonicalJson(value.deployment) ||
        canonicalJson(context.request) !== canonicalJson(value.request)) stale("model preparation is outside its approved durable stage");
    const operationKind = value.rule.stage === "SYNTHESIZE" ? "REPORT" : "AUDIT";
    const prefix = value.rule.stage === "SYNTHESIZE" ? "synthesis" : "audit";
    const quote: ModelCostQuote = { ...value.rule.quote, quote_ref: `model-quote-${value.row.request_sha256}`,
      reservation_id: `model-reservation-${value.row.request_sha256}`, operation_kind: operationKind,
      selected_routes: [value.deployment.route_ref], expires_at: value.authority.expires_at };
    const intent = OperationIntentSchema.parse({ intent_ref: { id: value.identity.operation_id, revision: 1 },
      operation_kind: operationKind, principal_ref: value.authority.principal_ref, idempotency_key: value.identity.idempotency_key,
      payload_ref: `${prefix}-payload-${value.row.request_sha256}`, cancellation_ref: `${prefix}-cancel-${value.row.request_sha256}`,
      policy_decision_ref: value.authority.policy_decision_ref, budget_reservation_ref: quote.reservation_id, created_at: value.row.started_at });
    const decision = { protocol: RESEARCH_MODEL_SPEND_APPROVAL_PROTOCOL, approved: true as const,
      authorization_ref: `model-authorization-${value.row.request_sha256}`, policy_decision_ref: value.authority.policy_decision_ref,
      policy_generation: value.authority.policy_generation, currentness_digest: value.authority.currentness_digest,
      expires_at: value.authority.expires_at, expected_deployment: value.deployment };
    await admissions.admit({
      request: { operation_id: value.identity.operation_id, principal_ref: value.authority.principal_ref,
        stage_attempt_ref: value.row.attempt_ref, stage_request_sha256: value.row.request_sha256,
        reservation_id: quote.reservation_id, quote_ref: quote.quote_ref, route_ref: value.deployment.route_ref,
        scope_snapshot_ref: value.authority.scope_snapshot_ref, workflow_authorization_receipt_ref: value.row.authorization_receipt_ref },
      workflow_operation_id: input.operation_id, stage_index: value.row.stage_index as 8 | 9 | 12 | 14,
      workflow_budget_receipt_ref: value.row.budget_receipt_ref,
      stage_request_json: value.row.request_json, intent, quote, authority: value.authority, expected_deployment: value.deployment,
      approval: { ...decision, decision_digest: await modelGatewaySha256(canonicalJson(decision)) },
      max_input_bytes: value.rule.max_input_bytes, max_output_bytes: value.rule.max_output_bytes,
    });
  },
  async admitBranchRole(admission: ResearchBranchRoleSpendAdmissionInput): Promise<ResearchModelSpendAdmissionRecord> {
    const stageIndex = admission.stage_request.stage === "ANALYZE_BRANCHES" ? 8 : admission.stage_request.stage === "COUNTER_SEARCH" ? 9 : undefined;
    if (stageIndex === undefined) workflowFail("WORKFLOW_CONFIGURATION_MISSING");
    const rule = policy.rules.find((value) => value.stage === admission.stage_request.stage);
    if (rule === undefined) workflowFail("WORKFLOW_CONFIGURATION_MISSING");
    ResearchBranchRoleSchema.parse(admission.role);
    // F1: the admitted role must be compatible with the stage it is admitted
    // for: COUNTER only on COUNTER_SEARCH, every other role only on
    // ANALYZE_BRANCHES. The port re-checks this at write time; fail closed
    // here too so a mis-wired caller never reaches the ledger.
    if (admission.role === "COUNTER" ? admission.stage_request.stage !== "COUNTER_SEARCH" : admission.stage_request.stage !== "ANALYZE_BRANCHES") {
      workflowFail("WORKFLOW_CONFIGURATION_MISSING");
    }
    const context = admission.role_context;
    const roleSha = context.stage_request_sha256;
    const value = await current(context.attempt_ref, admission.stage_request_sha256);
    const identity = await deriveModelAttemptIdentity({ stage_request_sha256: roleSha,
      principal_ref: context.principal.principal_ref, credential_generation: context.principal.credential_generation,
      deployment_generation: context.principal.deployment_generation });
    if (context.model_operation_id !== identity.operation_id || context.model_idempotency_key !== identity.idempotency_key ||
        context.budget_receipt_ref !== value.row.budget_receipt_ref || canonicalJson(admission.deployment) !== canonicalJson(value.deployment) ||
        canonicalJson(admission.stage_request) !== canonicalJson(value.request)) stale("branch role preparation is outside its approved durable stage");
    const quote: ModelCostQuote = { ...rule.quote, quote_ref: `model-quote-${roleSha}`,
      reservation_id: `model-reservation-${roleSha}`, operation_kind: "RESEARCH",
      selected_routes: [admission.deployment.route_ref], expires_at: value.authority.expires_at };
    const intent = OperationIntentSchema.parse({ intent_ref: { id: identity.operation_id, revision: 1 },
      operation_kind: "RESEARCH", principal_ref: value.authority.principal_ref, idempotency_key: identity.idempotency_key,
      payload_ref: `branch-role-payload-${roleSha}`, cancellation_ref: `branch-role-cancel-${roleSha}`,
      policy_decision_ref: value.authority.policy_decision_ref, budget_reservation_ref: quote.reservation_id, created_at: value.row.started_at });
    const decision = { protocol: RESEARCH_MODEL_SPEND_APPROVAL_PROTOCOL, approved: true as const,
      authorization_ref: `model-authorization-${roleSha}`, policy_decision_ref: value.authority.policy_decision_ref,
      policy_generation: value.authority.policy_generation, currentness_digest: value.authority.currentness_digest,
      expires_at: value.authority.expires_at, expected_deployment: admission.deployment };
    return admissions.admit({
      request: { operation_id: identity.operation_id, principal_ref: value.authority.principal_ref,
        stage_attempt_ref: value.row.attempt_ref, stage_request_sha256: roleSha,
        reservation_id: quote.reservation_id, quote_ref: quote.quote_ref, route_ref: admission.deployment.route_ref,
        scope_snapshot_ref: value.authority.scope_snapshot_ref, workflow_authorization_receipt_ref: value.row.authorization_receipt_ref,
        workflow_stage_request_sha256: admission.stage_request_sha256 },
      workflow_operation_id: input.operation_id, stage_index: stageIndex,
      role: admission.role, workflow_budget_receipt_ref: value.row.budget_receipt_ref,
      workflow_stage_request_sha256: admission.stage_request_sha256,
      stage_request_json: value.row.request_json, intent, quote, authority: value.authority, expected_deployment: admission.deployment,
      approval: { ...decision, decision_digest: await modelGatewaySha256(canonicalJson(decision)) },
      max_input_bytes: rule.max_input_bytes, max_output_bytes: rule.max_output_bytes,
    });
  } });
}
