import { OperationIntentSchema } from "@eliotr/contracts";
import type { NavigationReadAuthority } from "@eliotr/cloudflare-evidence";
import { canonicalDigest, canonicalJson, decodeModelRouteDeployment } from "@eliotr/platform-cloudflare";
import { createArtifactSectionReviseWorkflowStore, digest, type ArtifactSectionReviseAttempt } from "@eliotr/cloudflare-workflows";
import {
  admitArtifactCowModelSpend, createD1ModelGatewayDeploymentRegistry, ModelAttemptError,
  type ArtifactCowModelCallContext, type ArtifactCowModelExecutorDependencies,
  type ModelAttemptAuthority, type ModelAttemptReadback, type ModelAttemptReservationInput,
} from "@eliotr/cloudflare-research";
import type { ModelCallInput } from "@eliotr/research";
import { resolveResearchOwnerSpendPolicy } from "./research-owner-spend-policy.js";
import { createBoundResearchOwnerReportConfigSource } from "./research-owner-report-policy.js";
import { readResearchRunConfiguration } from "./research-run-configuration.js";
import type { Env } from "./env.js";

function stale(message: string): never {
  throw new ModelAttemptError("MODEL_ATTEMPT_AUTHORITY_STALE", message, false);
}

export interface OwnerArtifactCowModelAdmissionInput {
  readonly env: Env;
  readonly attempt: ArtifactSectionReviseAttempt;
  /** Current, server-built authority for the immutable W2 admitted scope. */
  readonly navigation: NavigationReadAuthority;
  /** Re-resolved evidence for that current scope, never a browser payload. */
  readonly evidence_pack: ModelCallInput["evidence_pack"];
  readonly deployment_environment?: "PRODUCTION" | "TEST";
  readonly now?: () => number;
}

/** Dedicated COW spending authority. It does not manufacture a research StageRequest. */
export async function createOwnerArtifactCowModelAdmission(input: OwnerArtifactCowModelAdmissionInput) {
  const { env, navigation } = input;
  const attempt = input.attempt;
  const witness = attempt.request.report_admission_witness;
  const pack = JSON.parse(canonicalJson(input.evidence_pack)) as ModelCallInput["evidence_pack"];
  const now = input.now ?? Date.now;
  const scopes = attempt.request.scope_snapshot_ref;
  const expires = typeof witness.material.expires_at === "string"
    ? witness.material.expires_at : stale("COW REPORT expiry is missing");
  if (!Number.isSafeInteger(Date.parse(expires)) ||
      Date.parse(expires) > attempt.budget.expires_at_ms ||
      canonicalJson(scopes) !== canonicalJson(pack.scope_snapshot_ref) ||
      scopes.id !== navigation.scope.snapshot_id || scopes.revision !== navigation.scope.revision ||
      navigation.access.client_class !== "owner_pwa" ||
      navigation.access.principal_ref !== attempt.authority.principal_ref ||
      navigation.access.credential_generation !== attempt.authority.credential_generation ||
      pack.resolved_evidence.length > 512 || pack.resolved_evidence.some((e) =>
        canonicalJson(e.handle.scope_snapshot_ref) !== canonicalJson(scopes) || e.handle.terminal_state !== "LIVE")) {
    stale("COW model admission requires exact current owner scope and re-resolved evidence");
  }
  const authority: ModelAttemptAuthority = Object.freeze({
    principal_ref: attempt.authority.principal_ref, client_class: "owner_pwa",
    credential_generation: attempt.authority.credential_generation,
    deployment_generation: attempt.authority.deployment_generation,
    policy_generation: attempt.authority.policy_generation,
    policy_decision_ref: witness.decision_sha256, scope_snapshot_ref: Object.freeze({ ...scopes }),
    currentness_digest: witness.input_sha256, expires_at: expires,
  });
  const workflow = createArtifactSectionReviseWorkflowStore(env.CORE_DB);
  const routes = createD1ModelGatewayDeploymentRegistry(env.CORE_DB, { environment: input.deployment_environment ?? "PRODUCTION" });
  const promptInputs = new Map<string, { readonly call: string; readonly context: string }>();

  async function originalConfiguration() {
    const raw = witness.material.run_configuration;
    if (raw === null) return Object.freeze({ env, mode: "legacy-installed" as const, model_selections: Object.freeze([]) });
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      stale("COW report witness has no exact original run configuration identity");
    }
    const pin = raw as Record<string, unknown>;
    if ((pin.mode !== "snapshot-v1" && pin.mode !== "snapshot-v2") ||
        typeof pin.operation_id !== "string" || typeof pin.investigation_id !== "string" ||
        typeof pin.principal_ref !== "string" || pin.principal_ref !== authority.principal_ref ||
        typeof pin.deployment_generation !== "string" || typeof pin.configuration_ref !== "string" ||
        typeof pin.configuration_sha256 !== "string" || !Array.isArray(pin.model_selections)) {
      stale("COW original run configuration identity is malformed");
    }
    const selected = await readResearchRunConfiguration(env, {
      operation_id: pin.operation_id as string, investigation_id: pin.investigation_id as string,
      principal_ref: pin.principal_ref as string, deployment_generation: pin.deployment_generation as string,
    });
    if (selected.mode !== pin.mode || selected.configuration_ref !== pin.configuration_ref ||
        selected.configuration_sha256 !== pin.configuration_sha256 ||
        canonicalJson(selected.model_selections) !== canonicalJson(pin.model_selections)) {
      stale("COW original run snapshot differs from the REPORT witness");
    }
    return Object.freeze({ env: selected.env, mode: selected.mode, model_selections: selected.model_selections });
  }

  async function requireCurrent(context?: ArtifactCowModelCallContext) {
    const time = now();
    if (!Number.isSafeInteger(time) || time >= Date.parse(expires) || context?.principal.signal?.aborted) stale("COW model authority expired or cancelled");
    const persisted = await workflow.read(attempt.request.operation_id);
    if (persisted === null || persisted.request_json !== attempt.request_json || persisted.attempt_ref !== attempt.attempt_ref ||
        persisted.request_sha256 !== attempt.request_sha256 ||
        !["STARTED", "OUTPUT_RECORDED"].includes(persisted.state) ||
        canonicalJson(persisted.authority) !== canonicalJson(attempt.authority) ||
        canonicalJson(persisted.budget) !== canonicalJson(attempt.budget)) stale("persisted COW W2 authority changed");
    if (context !== undefined && (canonicalJson(context.request) !== canonicalJson(attempt.request) ||
        context.workflow_attempt.request_json !== attempt.request_json || context.workflow_attempt.attempt_ref !== attempt.attempt_ref ||
        context.workflow_attempt.request_sha256 !== attempt.request_sha256 ||
        canonicalJson(context.authority) !== canonicalJson(authority) ||
        context.principal.principal_ref !== authority.principal_ref ||
        context.principal.credential_generation !== authority.credential_generation ||
        context.principal.deployment_generation !== authority.deployment_generation ||
        context.input_bytes.byteLength < 1 || context.input_bytes.byteLength > 256 * 1024)) stale("model context differs from admitted W2 authority");
    const current = await env.CORE_DB.prepare("SELECT operation_id FROM artifact_section_revise_current WHERE operation_id=?1 LIMIT 1")
      .bind(attempt.request.operation_id).first<{ operation_id: unknown }>();
    if (current?.operation_id !== attempt.request.operation_id) stale("COW owner, head, purge, policy or deployment is no longer current");
    const grant = await navigation.current();
    if (canonicalJson(grant) !== canonicalJson(witness.authorization) || navigation.scope.digest !== witness.material.scope_snapshot_digest) {
      stale("COW scope authorization differs from the original REPORT admission");
    }
    const sources = await navigation.sources(navigation.scope.member_source_revision_refs, grant);
    const bindings = sources.map((s) => ({ source_revision_ref: s.source_revision_ref,
      source_owner_generation: s.source_owner_generation, content_sha256: s.content_sha256,
      object_residency_key_digest: s.object_residency_key_digest, admission_receipt_ref: s.admission_receipt_ref,
      allowed_use: [...s.allowed_use], disclosure_ceiling: s.disclosure_ceiling, admission_expires_at: s.admission_expires_at ?? null,
    })).sort((a, b) => a.source_revision_ref.localeCompare(b.source_revision_ref));
    if (canonicalJson(bindings) !== canonicalJson(witness.source_bindings)) stale("COW source authority changed after REPORT admission");
    const pinnedConfiguration = await originalConfiguration();
    const policyEnv = pinnedConfiguration.env;
    const spend = resolveResearchOwnerSpendPolicy({ raw: policyEnv.ELIOTR_MODEL_SPEND_POLICY_JSON,
      provenance: policyEnv.ELIOTR_MODEL_SPEND_POLICY_PROVENANCE_REF ?? "", access: navigation.access,
      deployment_generation: env.DEPLOYMENT_GENERATION, policy_generation: authority.policy_generation,
      policy_authority_ref: attempt.authority.policy_authority_ref, scope_expires_at: navigation.scope.expires_at,
      authorization: grant, now_ms: time }).policy;
    const report = await createBoundResearchOwnerReportConfigSource({ raw: policyEnv.ELIOTR_RESEARCH_REPORT_CONFIG_JSON,
      provenance_ref: policyEnv.ELIOTR_RESEARCH_REPORT_POLICY_PROVENANCE_REF ?? "", current_spend_authority: spend, now_ms: time }).read();
    if (canonicalJson(spend) !== canonicalJson(witness.spend_policy) || canonicalJson(report) !== canonicalJson(witness.policy) ||
        await canonicalDigest(witness.material) !== witness.input_sha256 ||
        await canonicalDigest(witness.decision) !== witness.decision_sha256 ||
        canonicalJson(await navigation.current()) !== canonicalJson(grant)) stale("installed COW REPORT or spending approval changed");
    return { spend, persisted, pinned_configuration: pinnedConfiguration };
  }

  async function slot(context: ArtifactCowModelCallContext) {
    const value = await requireCurrent(context);
    const rule = value.spend.rules.find((r) => r.stage === (context.call_slot === "SYNTHESIZE" ? "SYNTHESIZE" : "AUDIT_CLAIMS"));
    if (rule === undefined) stale("installed COW model slot is missing");
    const stage = context.call_slot === "SYNTHESIZE" ? "SYNTHESIZE" : "AUDIT_CLAIMS";
    const matches = value.pinned_configuration.model_selections.filter((selection) => selection.stage === stage);
    let resolved: unknown | null;
    if (value.pinned_configuration.mode === "legacy-installed") {
      resolved = await routes.resolve(rule.deployment.route_ref);
    } else {
      const selection = matches[0];
      if (matches.length !== 1 || selection === undefined || selection.route_ref !== rule.deployment.route_ref ||
          selection.route_version !== rule.deployment.route_version || typeof routes.resolvePinned !== "function") {
        stale("COW model selection is missing or differs from the original run snapshot");
      }
      resolved = await routes.resolvePinned(rule.deployment, selection, {
        allow_expired_qualification: value.pinned_configuration.mode === "snapshot-v2",
      });
    }
    if (resolved === null || canonicalJson(decodeModelRouteDeployment(resolved)) !== canonicalJson(rule.deployment)) {
      stale("COW model deployment differs from the original run snapshot");
    }
    const identity = await digest(new TextEncoder().encode(JSON.stringify({
      protocol: context.request.protocol, operation_id: context.request.operation_id,
      attempt_ref: context.workflow_attempt.attempt_ref, request_sha256: context.workflow_attempt.request_sha256,
      call_slot: context.call_slot, principal_ref: context.principal.principal_ref,
      credential_generation: context.principal.credential_generation, deployment_generation: context.principal.deployment_generation,
    })));
    return { ...value, rule, identity, input_sha256: await digest(context.input_bytes) };
  }

  const prepare: ArtifactCowModelExecutorDependencies["prepare"] = async (context) => {
    const { rule, identity, input_sha256, persisted } = await slot(context);
    if (persisted.state !== "STARTED" || context.model_operation_id !== `artifact-cow-operation-${identity}` ||
        context.model_idempotency_key !== `artifact-cow-model-${identity}` ||
        context.model_output_object_ref !== `artifact-cow/model-output/${identity}/${attempt.attempt_ref}`) stale("model slot identity differs from the exact admitted operation");
    const quote = { ...rule.quote, operation_kind: "REPORT" as const, selected_routes: [rule.deployment.route_ref],
      quote_ref: `artifact-cow-quote-${identity}`, reservation_id: `artifact-cow-reservation-${identity}`, expires_at: expires };
    const row = await env.CORE_DB.prepare("SELECT created_at FROM artifact_section_revise_attempt WHERE operation_id=?1 AND attempt_ref=?2 LIMIT 1")
      .bind(attempt.request.operation_id, attempt.attempt_ref).first<{ created_at: unknown }>();
    const intent = OperationIntentSchema.parse({ intent_ref: { id: context.model_operation_id, revision: 1 },
      operation_kind: "REPORT", principal_ref: authority.principal_ref, idempotency_key: context.model_idempotency_key,
      payload_ref: `artifact-cow-model-input-${input_sha256}`, policy_decision_ref: authority.policy_decision_ref,
      budget_reservation_ref: quote.reservation_id, created_at: row?.created_at });
    const call: ModelCallInput = { route_ref: rule.deployment.route_ref, prompt_generation: rule.deployment.prompt_generation,
      schema_generation: rule.deployment.schema_generation, evidence_pack: pack, output_object_ref: context.model_output_object_ref,
      max_input_bytes: rule.max_input_bytes, max_output_bytes: rule.max_output_bytes, budget_reservation_ref: quote.reservation_id };
    const prepared: ModelAttemptReservationInput = { intent, idempotency_key: context.model_idempotency_key, call, quote, authority,
      stage_attempt_ref: attempt.attempt_ref, stage_request_sha256: attempt.request_sha256,
      workflow_budget_receipt_ref: attempt.budget.receipt_ref, artifact_cow_binding: {
        protocol: attempt.request.protocol, operation_id: attempt.request.operation_id, call_slot: context.call_slot,
        attempt_ref: attempt.attempt_ref, scope_snapshot_ref: scopes, policy_authority_ref: attempt.authority.policy_authority_ref,
        authorization_receipt_ref: attempt.authority.authorization_receipt_ref, purge_revision: attempt.authority.purge_revision,
      } };
    const authorizationRef = `artifact-cow-authorization-${identity}`;
    const decision = { protocol: "eliotr.research-model-spend-approval.v1" as const, approved: true as const,
      authorization_ref: authorizationRef, policy_decision_ref: authority.policy_decision_ref,
      policy_generation: authority.policy_generation, currentness_digest: authority.currentness_digest,
      expected_deployment: rule.deployment, expires_at: expires };
    const prior = await env.CORE_DB.prepare("SELECT intent_json,quote_json,authority_json,expected_deployment_json FROM artifact_section_revise_spend_admission WHERE authorization_ref=?1 LIMIT 1")
      .bind(authorizationRef).first<Record<string, unknown>>();
    if (prior !== null) {
      if (prior.intent_json !== canonicalJson(intent) || prior.quote_json !== canonicalJson(quote) ||
          prior.authority_json !== canonicalJson(authority) || prior.expected_deployment_json !== canonicalJson(rule.deployment)) stale("existing COW admission binds different inputs");
    } else {
      await admitArtifactCowModelSpend(env.CORE_DB, { context, prepared, expected_deployment: rule.deployment,
        approval: { ...decision, decision_digest: await canonicalDigest(decision) }, authorization_ref: authorizationRef,
        expires_at: expires, created_at: new Date(now()).toISOString() });
    }
    await requireCurrent(context);
    const contextText = new TextDecoder("utf-8", { fatal: true }).decode(context.input_bytes);
    promptInputs.set(call.output_object_ref, { call: canonicalJson(call), context: contextText });
    return prepared;
  };

  const revalidateExisting: ArtifactCowModelExecutorDependencies["revalidateExisting"] = async (context, existing: ModelAttemptReadback) => {
    const { rule, identity, input_sha256 } = await slot(context);
    if (existing.state !== "SUCCEEDED" || existing.intent.intent_ref.id !== `artifact-cow-operation-${identity}` ||
        existing.intent.payload_ref !== `artifact-cow-model-input-${input_sha256}` ||
        canonicalJson(existing.authority) !== canonicalJson(authority) ||
        existing.stage_attempt_ref !== attempt.attempt_ref || existing.stage_request_sha256 !== attempt.request_sha256 ||
        existing.workflow_budget_receipt_ref !== attempt.budget.receipt_ref ||
        existing.artifact_cow_binding?.operation_id !== attempt.request.operation_id ||
        existing.artifact_cow_binding.call_slot !== context.call_slot) stale("durable COW output differs from the admitted model input");
    const receipt = await env.CORE_DB.prepare("SELECT intent_json,authority_json,expected_deployment_json,quote_json,expires_at FROM artifact_section_revise_spend_admission WHERE operation_id=?1 AND call_slot=?2 LIMIT 1")
      .bind(existing.intent.intent_ref.id, context.call_slot).first<Record<string, unknown>>();
    if (receipt === null || receipt.intent_json !== canonicalJson(existing.intent) || receipt.authority_json !== canonicalJson(authority) ||
        receipt.expected_deployment_json !== canonicalJson(rule.deployment) || receipt.expires_at !== expires) stale("durable COW spending authority changed");
    const expectedQuote = { ...rule.quote, operation_kind: "REPORT", selected_routes: [rule.deployment.route_ref],
      quote_ref: `artifact-cow-quote-${identity}`, reservation_id: `artifact-cow-reservation-${identity}`, expires_at: expires };
    if (receipt.quote_json !== canonicalJson(expectedQuote)) stale("durable COW quote differs from installed approval");
    await requireCurrent(context);
  };

  await requireCurrent();
  return Object.freeze({ authority, prepare, revalidateExisting, async promptContext(call: ModelCallInput): Promise<string> {
    await requireCurrent();
    const saved = promptInputs.get(call.output_object_ref);
    if (saved === undefined || saved.call !== canonicalJson(call)) stale("trusted COW model prompt context is not bound to this exact call");
    return saved.context;
  } });
}
