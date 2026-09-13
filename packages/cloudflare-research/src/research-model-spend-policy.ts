import { z } from "zod";
import { IdentifierSchema, IsoDateTimeSchema, OperationIntentSchema } from "@eliotr/contracts";
import { modelGatewaySha256 } from "@eliotr/cloudflare-ai";
import { canonicalJson, decodeModelRouteDeployment, type ModelRouteDeployment } from "@eliotr/platform-cloudflare";
import type { NavigationReadAuthority } from "@eliotr/cloudflare-evidence";
import { StageRequestSchema, textDigest } from "@eliotr/cloudflare-workflows";
import { ModelAttemptError, type ModelAttemptAuthority, type ModelCostQuote } from "./model-attempt-types.js";
import { deriveModelAttemptIdentity, type ModelAttemptPreparationContext } from "./model-attempt-handler.js";
import type { SpendAuthorizationReadRequest } from "./research-model-attempt-revalidator.js";
import {
  createD1ResearchModelSpendAdmissionPort,
  RESEARCH_MODEL_SPEND_APPROVAL_PROTOCOL,
  type ResearchModelSpendAdmissionPort,
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
  stage: z.enum(["SYNTHESIZE", "AUDIT_CLAIMS"]),
  deployment: z.unknown(),
  max_input_bytes: count.min(1).max(256 * 1024),
  max_output_bytes: count.min(1).max(256 * 1024),
  quote: QuoteEstimateSchema,
}).strict();
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
  rules: z.array(RuleSchema).length(2),
}).strict();

type SpendRule = Omit<z.infer<typeof RuleSchema>, "deployment"> & { readonly deployment: ModelRouteDeployment };
export type ResearchModelSpendPolicy = Omit<z.infer<typeof PolicySchema>, "rules"> & { readonly rules: readonly SpendRule[] };

/** This is installed operator approval, never a public request or an inferred scope permission. */
export function readResearchModelSpendPolicy(raw: string | undefined, provenance: string): ResearchModelSpendPolicy {
  if (!raw || new TextEncoder().encode(raw).byteLength > 65536) stale("installed model spend policy is missing or oversized");
  try {
    const parsed = PolicySchema.parse(JSON.parse(raw));
    if (parsed.config_provenance_ref !== provenance || new Set(parsed.rules.map((rule) => rule.stage)).size !== 2) {
      stale("installed model spend policy provenance or stage selection is invalid");
    }
    return Object.freeze({ ...parsed, rules: Object.freeze(parsed.rules.map((rule) => Object.freeze({
      ...rule, quote: Object.freeze(rule.quote), deployment: decodeModelRouteDeployment(rule.deployment),
    }))) });
  } catch (cause) {
    stale("installed model spend policy is invalid", cause);
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
  readonly deployment_registry: { resolve(route: string): Promise<unknown | null> };
  readonly now?: () => number;
}

export interface ResearchModelSpendPolicyService {
  readonly admissions: ResearchModelSpendAdmissionPort;
  /** Record the installed explicit decision before the existing W3 reservation. */
  admit(input: ModelAttemptPreparationContext, deployment: ModelRouteDeployment): Promise<void>;
}

/** Connect the explicit installed policy to current D1 authority and the durable spend adapter. */
export function createResearchModelSpendPolicyService(input: ResearchModelSpendPolicyServiceInput): ResearchModelSpendPolicyService {
  const policy = readResearchModelSpendPolicy(canonicalJson(input.policy), input.policy.config_provenance_ref);
  const now = input.now ?? Date.now;
  const policySha = modelGatewaySha256(canonicalJson(policy));
  const navigation = input.navigation;

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
      "AND a.state='STARTED' AND a.output_json IS NULL AND a.stage_index IN (12,14) AND r.next_stage_index=a.stage_index " +
      "AND r.current_revision=a.expected_revision AND r.ledger_revision=a.expected_revision AND s.invalidated_at IS NULL " +
      "AND g.state='ACTIVE' AND g.client_class='owner_pwa' AND g.credential_generation=r.credential_generation " +
      "AND g.authorization_receipt_ref=r.authorization_receipt_ref AND g.policy_authority_ref=r.policy_authority_ref " +
      "AND EXISTS(SELECT 1 FROM investigation_current_policy p WHERE p.policy_generation=r.policy_generation AND p.policy_authority_ref=r.policy_authority_ref AND p.state='ACTIVE') " +
      "AND EXISTS(SELECT 1 FROM investigation_current_deployment d WHERE d.deployment_generation=r.deployment_generation AND d.state='ACTIVE') LIMIT 1",
    ).bind(input.operation_id, attempt, requestSha).first<CurrentStage>();
    if (row === null || row.principal_ref !== policy.principal_ref || row.credential_generation !== policy.credential_generation ||
        row.deployment_generation !== policy.deployment_generation || row.policy_generation !== policy.policy_generation ||
        row.policy_authority_ref !== policy.policy_authority_ref || navigation.access.principal_ref !== row.principal_ref ||
        navigation.access.credential_generation !== row.credential_generation || navigation.scope.snapshot_id !== row.scope_snapshot_id ||
        navigation.scope.revision !== row.scope_snapshot_revision || grant.policy_authority_ref !== row.policy_authority_ref ||
        !grant.allowed_use.includes("research")) stale("model spend policy does not permit this current owner workflow");
    const stage = row.stage_index === 12 ? "SYNTHESIZE" : "AUDIT_CLAIMS";
    const rule = policy.rules.find((value) => value.stage === stage);
    if (rule === undefined || !Number.isSafeInteger(row.budget_expires_at_ms)) stale("model stage policy or execution grant is unavailable");
    const expires = Math.min(Date.parse(policy.expires_at), Date.parse(row.grant_expires_at),
      Date.parse(row.scope_expires_at), row.budget_expires_at_ms);
    if (!Number.isFinite(expires) || expires <= now()) stale("model stage approval or current authority has expired");
    const request = StageRequestSchema.parse(JSON.parse(row.request_json));
    if (JSON.stringify(request) !== row.request_json || await textDigest(row.request_json) !== row.request_sha256 ||
        request.stage !== stage || request.operation_id !== input.operation_id) stale("current model stage request is invalid");
    const deployment = decodeModelRouteDeployment(await input.deployment_registry.resolve(rule.deployment.route_ref));
    if (canonicalJson(deployment) !== canonicalJson(rule.deployment)) stale("installed model route is no longer the approved deployment");
    const identity = await deriveModelAttemptIdentity({ stage_request_sha256: row.request_sha256,
      principal_ref: row.principal_ref, credential_generation: row.credential_generation, deployment_generation: row.deployment_generation });
    const decisionRef = `model-policy-${await policySha}-${row.request_sha256.slice(0,32)}`;
    const authority: ModelAttemptAuthority = {
      principal_ref: row.principal_ref, client_class: policy.client_class, policy_decision_ref: decisionRef,
      scope_snapshot_ref: { id: row.scope_snapshot_id, revision: row.scope_snapshot_revision },
      credential_generation: row.credential_generation, deployment_generation: row.deployment_generation,
      policy_generation: row.policy_generation,
      currentness_digest: await modelGatewaySha256(canonicalJson({ policy_sha256: await policySha,
        authorization_receipt_ref: row.authorization_receipt_ref, scope_digest: navigation.scope.digest,
        purge_revision: row.purge_revision, stage_request_sha256: row.request_sha256 })),
      expires_at: new Date(expires).toISOString(),
    };
    if (canonicalJson(await navigation.current()) !== canonicalJson(grant)) stale("model authorization changed while reading policy");
    return { row, rule, request, deployment, identity, authority };
  }

  async function readCurrent(request: SpendAuthorizationReadRequest): Promise<ResearchModelSpendCurrentAuthority> {
    const value = await current(request.stage_attempt_ref, request.stage_request_sha256);
    if (request.operation_id !== value.identity.operation_id || request.principal_ref !== value.authority.principal_ref ||
        request.route_ref !== value.deployment.route_ref || request.workflow_authorization_receipt_ref !== value.row.authorization_receipt_ref ||
        canonicalJson(request.scope_snapshot_ref) !== canonicalJson(value.authority.scope_snapshot_ref) ||
        request.reservation_id !== `model-reservation-${value.row.request_sha256}` ||
        request.quote_ref !== `model-quote-${value.row.request_sha256}`) stale("spend readback is outside the exact approved call");
    return { authority: value.authority, expected_deployment: value.deployment };
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
      workflow_operation_id: input.operation_id, stage_index: value.row.stage_index === 12 ? 12 : 14,
      workflow_budget_receipt_ref: value.row.budget_receipt_ref,
      stage_request_json: value.row.request_json, intent, quote, authority: value.authority, expected_deployment: value.deployment,
      approval: { ...decision, decision_digest: await modelGatewaySha256(canonicalJson(decision)) },
      max_input_bytes: value.rule.max_input_bytes, max_output_bytes: value.rule.max_output_bytes,
    });
  } });
}
