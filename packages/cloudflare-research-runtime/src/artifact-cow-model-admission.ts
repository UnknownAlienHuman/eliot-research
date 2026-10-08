import { OperationIntentSchema } from "@eliotr/contracts";
import type { NavigationReadAuthority, EvidenceSourceAuthority } from "@eliotr/cloudflare-evidence";
import { canonicalDigest, canonicalJson, decodeModelRouteDeployment, type ModelRouteDeployment } from "@eliotr/platform-cloudflare";
import {
  digest,
  type ArtifactSectionReviseAttempt,
  type ArtifactSectionReviseWorkflowStore,
} from "@eliotr/cloudflare-workflows";
import {
  ModelAttemptError,
  type ArtifactCowModelCallContext,
  type ArtifactCowModelExecutorDependencies,
  type ArtifactCowNativeModelSelectionResolver,
  type ModelAttemptAuthority,
  type ModelAttemptReadback,
  type ModelAttemptReservationInput,
} from "@eliotr/cloudflare-research";
import type { PinnedModelSelection } from "@eliotr/cloudflare-research";
import type { ModelCallInput } from "@eliotr/research";
import type {
  ResearchModelSpendApproval,
  ResearchModelSpendPolicy,
  ResearchReportAdmissionPolicy,
} from "@eliotr/cloudflare-research";
import type { ResearchRunModelSelection } from "@eliotr/cloudflare-research-configuration/research-run-configuration.js";
import type { ArtifactSectionReportAdmissionPolicyVars } from "./artifact-report-admission.js";

export interface ArtifactCowModelAdmissionRunConfiguration {
  readonly mode: "legacy-installed" | "snapshot-v1" | "snapshot-v2";
  readonly model_selections: readonly ResearchRunModelSelection[];
  readonly project_owner_ref: string | null;
  readonly project_id: string | null;
  readonly policy_vars: ArtifactSectionReportAdmissionPolicyVars;
}

export interface ArtifactCowModelAdmissionReadback {
  readonly intent_json: unknown;
  readonly quote_json: unknown;
  readonly authority_json: unknown;
  readonly expected_deployment_json: unknown;
  readonly expires_at?: unknown;
}

export interface ArtifactCowModelAdmissionRouteAuthority {
  resolve(route_ref: string): Promise<unknown | null>;
  resolvePinned?(
    deployment: ModelRouteDeployment,
    selection: PinnedModelSelection,
    options?: Readonly<{ allow_expired_qualification?: boolean }>,
  ): Promise<unknown | null>;
}

export interface ArtifactCowModelAdmissionApplicationInput {
  readonly attempt: ArtifactSectionReviseAttempt;
  readonly navigation: NavigationReadAuthority;
  readonly evidence_pack: ModelCallInput["evidence_pack"];
  readonly workflow: Pick<ArtifactSectionReviseWorkflowStore, "read">;
  readonly route_authority: ArtifactCowModelAdmissionRouteAuthority;
  readonly legacy_policy_vars: ArtifactSectionReportAdmissionPolicyVars;
  readonly read_original_configuration: (
    pin: Readonly<Record<string, unknown>>,
  ) => Promise<ArtifactCowModelAdmissionRunConfiguration>;
  readonly is_current_cow_attempt: () => Promise<boolean>;
  readonly read_current_policies: (
    configuration: ArtifactCowModelAdmissionRunConfiguration,
    now_ms: number,
  ) => Promise<Readonly<{ spend: ResearchModelSpendPolicy; report: ResearchReportAdmissionPolicy | null }>>;
  readonly admission_store: {
    read_attempt_created_at(operation_id: string, attempt_ref: string): Promise<unknown>;
    read_authorization(authorization_ref: string): Promise<ArtifactCowModelAdmissionReadback | null>;
    admit(input: Readonly<{
      context: ArtifactCowModelCallContext;
      prepared: ModelAttemptReservationInput;
      expected_deployment: ModelRouteDeployment;
      approval: ResearchModelSpendApproval;
      authorization_ref: string;
      expires_at: string;
      created_at: string;
    }>): Promise<void>;
    read_operation(operation_id: string, call_slot: string): Promise<ArtifactCowModelAdmissionReadback | null>;
  };
  readonly resolve_native_model_selection?: ArtifactCowNativeModelSelectionResolver;
  readonly now?: () => number;
}

function stale(message: string): never {
  throw new ModelAttemptError("MODEL_ATTEMPT_AUTHORITY_STALE", message, false);
}

function sourceBinding(source: EvidenceSourceAuthority) {
  return {
    source_revision_ref: source.source_revision_ref,
    source_owner_generation: source.source_owner_generation,
    content_sha256: source.content_sha256,
    object_residency_key_digest: source.object_residency_key_digest,
    admission_receipt_ref: source.admission_receipt_ref,
    allowed_use: [...source.allowed_use],
    disclosure_ceiling: source.disclosure_ceiling,
    admission_expires_at: source.admission_expires_at ?? null,
  };
}

/** Builds the exact W3 admission and prompt context for a COW model slot. */
export async function createArtifactCowModelAdmissionApplication(input: ArtifactCowModelAdmissionApplicationInput) {
  const attempt = input.attempt;
  const witness = attempt.request.report_admission_witness;
  const pack = JSON.parse(canonicalJson(input.evidence_pack)) as ModelCallInput["evidence_pack"];
  const now = input.now ?? Date.now;
  const scopes = attempt.request.scope_snapshot_ref;
  const expires = typeof witness.material.expires_at === "string"
    ? witness.material.expires_at : stale("COW REPORT expiry is missing");
  if (!Number.isSafeInteger(Date.parse(expires)) || Date.parse(expires) > attempt.budget.expires_at_ms ||
      canonicalJson(scopes) !== canonicalJson(pack.scope_snapshot_ref) || scopes.id !== input.navigation.scope.snapshot_id ||
      scopes.revision !== input.navigation.scope.revision || input.navigation.access.client_class !== "owner_pwa" ||
      input.navigation.access.principal_ref !== attempt.authority.principal_ref ||
      input.navigation.access.credential_generation !== attempt.authority.credential_generation ||
      pack.resolved_evidence.length > 512 || pack.resolved_evidence.some((evidence) =>
        canonicalJson(evidence.handle.scope_snapshot_ref) !== canonicalJson(scopes) || evidence.handle.terminal_state !== "LIVE")) {
    stale("COW model admission requires exact current owner scope and re-resolved evidence");
  }
  const authority: ModelAttemptAuthority = Object.freeze({
    principal_ref: attempt.authority.principal_ref,
    client_class: "owner_pwa",
    credential_generation: attempt.authority.credential_generation,
    deployment_generation: attempt.authority.deployment_generation,
    policy_generation: attempt.authority.policy_generation,
    policy_decision_ref: witness.decision_sha256,
    scope_snapshot_ref: Object.freeze({ ...scopes }),
    currentness_digest: witness.input_sha256,
    expires_at: expires,
  });
  const promptInputs = new Map<string, { readonly call: string; readonly context: string }>();

  async function originalConfiguration(): Promise<ArtifactCowModelAdmissionRunConfiguration> {
    const raw = witness.material.run_configuration;
    if (raw === null) {
      return Object.freeze({ mode: "legacy-installed", policy_vars: input.legacy_policy_vars,
        model_selections: Object.freeze([]), project_owner_ref: null, project_id: null });
    }
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      stale("COW report witness has no exact original run configuration identity");
    }
    const pin = raw as Record<string, unknown>;
    if ((pin.mode !== "snapshot-v1" && pin.mode !== "snapshot-v2") || typeof pin.operation_id !== "string" ||
        typeof pin.investigation_id !== "string" || typeof pin.principal_ref !== "string" ||
        pin.principal_ref !== authority.principal_ref || typeof pin.deployment_generation !== "string" ||
        typeof pin.configuration_ref !== "string" || typeof pin.configuration_sha256 !== "string" ||
        !Array.isArray(pin.model_selections)) {
      stale("COW original run configuration identity is malformed");
    }
    const selected = await input.read_original_configuration(pin);
    if (selected.mode !== pin.mode || canonicalJson(selected.model_selections) !== canonicalJson(pin.model_selections)) {
      stale("COW original run snapshot differs from the REPORT witness");
    }
    return selected;
  }

  async function requireCurrent(context?: ArtifactCowModelCallContext) {
    const time = now();
    if (!Number.isSafeInteger(time) || time >= Date.parse(expires) || context?.principal.signal?.aborted) {
      stale("COW model authority expired or cancelled");
    }
    const persisted = await input.workflow.read(attempt.request.operation_id);
    if (persisted === null || persisted.request_json !== attempt.request_json || persisted.attempt_ref !== attempt.attempt_ref ||
        persisted.request_sha256 !== attempt.request_sha256 || !["STARTED", "OUTPUT_RECORDED"].includes(persisted.state) ||
        canonicalJson(persisted.authority) !== canonicalJson(attempt.authority) ||
        canonicalJson(persisted.budget) !== canonicalJson(attempt.budget)) {
      stale("persisted COW W2 authority changed");
    }
    if (context !== undefined && (canonicalJson(context.request) !== canonicalJson(attempt.request) ||
        context.workflow_attempt.request_json !== attempt.request_json || context.workflow_attempt.attempt_ref !== attempt.attempt_ref ||
        context.workflow_attempt.request_sha256 !== attempt.request_sha256 || canonicalJson(context.authority) !== canonicalJson(authority) ||
        context.principal.principal_ref !== authority.principal_ref ||
        context.principal.credential_generation !== authority.credential_generation ||
        context.principal.deployment_generation !== authority.deployment_generation ||
        context.input_bytes.byteLength < 1 || context.input_bytes.byteLength > 256 * 1024)) {
      stale("model context differs from admitted W2 authority");
    }
    if (!(await input.is_current_cow_attempt())) stale("COW owner, head, purge, policy or deployment is no longer current");
    const grant = await input.navigation.current();
    if (canonicalJson(grant) !== canonicalJson(witness.authorization) ||
        input.navigation.scope.digest !== witness.material.scope_snapshot_digest) {
      stale("COW scope authorization differs from the original REPORT admission");
    }
    const sources = await input.navigation.sources(input.navigation.scope.member_source_revision_refs, grant);
    const bindings = sources.map(sourceBinding).sort((left, right) =>
      left.source_revision_ref.localeCompare(right.source_revision_ref));
    if (canonicalJson(bindings) !== canonicalJson(witness.source_bindings)) {
      stale("COW source authority changed after REPORT admission");
    }
    const pinnedConfiguration = await originalConfiguration();
    const { spend, report } = await input.read_current_policies(pinnedConfiguration, time);
    if (canonicalJson(spend) !== canonicalJson(witness.spend_policy) || canonicalJson(report) !== canonicalJson(witness.policy) ||
        await canonicalDigest(witness.material) !== witness.input_sha256 ||
        await canonicalDigest(witness.decision) !== witness.decision_sha256 ||
        canonicalJson(await input.navigation.current()) !== canonicalJson(grant)) {
      stale("installed COW REPORT or spending approval changed");
    }
    return { spend, persisted, pinned_configuration: pinnedConfiguration };
  }

  async function slot(context: ArtifactCowModelCallContext) {
    const value = await requireCurrent(context);
    const stage = context.call_slot === "SYNTHESIZE" ? "SYNTHESIZE" : "AUDIT_CLAIMS";
    const rule = value.spend.rules.find((candidate) => candidate.stage === stage);
    if (rule === undefined) stale("installed COW model slot is missing");
    const matches = value.pinned_configuration.model_selections.filter((selection) => selection.stage === stage);
    let resolved: unknown | null;
    if (value.pinned_configuration.mode === "legacy-installed") {
      if (matches.length !== 0) stale("legacy COW route cannot contain a selected model configuration");
      resolved = await input.route_authority.resolve(rule.deployment.route_ref);
    } else {
      const selection = matches[0];
      if (matches.length !== 1 || selection === undefined || selection.route_ref !== rule.deployment.route_ref ||
          selection.route_version !== rule.deployment.route_version) {
        stale("COW model selection is missing or differs from the original run snapshot");
      }
      if (selection.candidate_kind === "provider-native-v1") {
        if (typeof value.pinned_configuration.project_owner_ref !== "string" ||
            typeof value.pinned_configuration.project_id !== "string" ||
            input.resolve_native_model_selection === undefined) {
          stale("COW Native run snapshot has no captured project authority");
        }
        const native = await input.resolve_native_model_selection({
          selection,
          allow_expired_snapshot_v2: value.pinned_configuration.mode === "snapshot-v2",
        });
        if (canonicalJson(native.transport_policy) !== canonicalJson(selection.transport_policy)) {
          stale("COW Native transport policy differs from the original run snapshot");
        }
        resolved = native.deployment;
      } else {
        if (selection.candidate_kind !== undefined || input.route_authority.resolvePinned === undefined) {
          stale("COW dynamic model pin resolver is unavailable");
        }
        resolved = await input.route_authority.resolvePinned(rule.deployment, selection, {
          allow_expired_qualification: value.pinned_configuration.mode === "snapshot-v2",
        });
      }
    }
    if (resolved === null || canonicalJson(decodeModelRouteDeployment(resolved)) !== canonicalJson(rule.deployment)) {
      stale("COW model deployment differs from the original run snapshot");
    }
    const identity = await digest(new TextEncoder().encode(JSON.stringify({
      protocol: context.request.protocol,
      operation_id: context.request.operation_id,
      attempt_ref: context.workflow_attempt.attempt_ref,
      request_sha256: context.workflow_attempt.request_sha256,
      call_slot: context.call_slot,
      principal_ref: context.principal.principal_ref,
      credential_generation: context.principal.credential_generation,
      deployment_generation: context.principal.deployment_generation,
    })));
    return { ...value, rule, identity, input_sha256: await digest(context.input_bytes) };
  }

  const prepare: ArtifactCowModelExecutorDependencies["prepare"] = async (context) => {
    const { rule, identity, input_sha256, persisted } = await slot(context);
    if (persisted.state !== "STARTED" || context.model_operation_id !== `artifact-cow-operation-${identity}` ||
        context.model_idempotency_key !== `artifact-cow-model-${identity}` ||
        context.model_output_object_ref !== `artifact-cow/model-output/${identity}/${attempt.attempt_ref}`) {
      stale("model slot identity differs from the exact admitted operation");
    }
    const quote = { ...rule.quote, operation_kind: "REPORT" as const, selected_routes: [rule.deployment.route_ref],
      quote_ref: `artifact-cow-quote-${identity}`, reservation_id: `artifact-cow-reservation-${identity}`, expires_at: expires };
    const createdAt = await input.admission_store.read_attempt_created_at(attempt.request.operation_id, attempt.attempt_ref);
    const intent = OperationIntentSchema.parse({ intent_ref: { id: context.model_operation_id, revision: 1 },
      operation_kind: "REPORT", principal_ref: authority.principal_ref, idempotency_key: context.model_idempotency_key,
      payload_ref: `artifact-cow-model-input-${input_sha256}`, policy_decision_ref: authority.policy_decision_ref,
      budget_reservation_ref: quote.reservation_id, created_at: createdAt });
    const call: ModelCallInput = { route_ref: rule.deployment.route_ref, prompt_generation: rule.deployment.prompt_generation,
      schema_generation: rule.deployment.schema_generation, evidence_pack: pack,
      output_object_ref: context.model_output_object_ref, max_input_bytes: rule.max_input_bytes,
      max_output_bytes: rule.max_output_bytes, budget_reservation_ref: quote.reservation_id };
    const prepared: ModelAttemptReservationInput = { intent, idempotency_key: context.model_idempotency_key,
      call, quote, authority, stage_attempt_ref: attempt.attempt_ref, stage_request_sha256: attempt.request_sha256,
      workflow_budget_receipt_ref: attempt.budget.receipt_ref, artifact_cow_binding: {
        protocol: attempt.request.protocol, operation_id: attempt.request.operation_id, call_slot: context.call_slot,
        attempt_ref: attempt.attempt_ref, scope_snapshot_ref: scopes,
        policy_authority_ref: attempt.authority.policy_authority_ref,
        authorization_receipt_ref: attempt.authority.authorization_receipt_ref,
        purge_revision: attempt.authority.purge_revision,
      } };
    const authorizationRef = `artifact-cow-authorization-${identity}`;
    const decision = { protocol: "eliotr.research-model-spend-approval.v1" as const, approved: true as const,
      authorization_ref: authorizationRef, policy_decision_ref: authority.policy_decision_ref,
      policy_generation: authority.policy_generation, currentness_digest: authority.currentness_digest,
      expected_deployment: rule.deployment, expires_at: expires };
    const prior = await input.admission_store.read_authorization(authorizationRef);
    if (prior !== null) {
      if (prior.intent_json !== canonicalJson(intent) || prior.quote_json !== canonicalJson(quote) ||
          prior.authority_json !== canonicalJson(authority) || prior.expected_deployment_json !== canonicalJson(rule.deployment)) {
        stale("existing COW admission binds different inputs");
      }
    } else {
      await input.admission_store.admit({ context, prepared, expected_deployment: rule.deployment,
        approval: { ...decision, decision_digest: await canonicalDigest(decision) },
        authorization_ref: authorizationRef, expires_at: expires, created_at: new Date(now()).toISOString() });
    }
    await requireCurrent(context);
    const contextText = new TextDecoder("utf-8", { fatal: true }).decode(context.input_bytes);
    promptInputs.set(call.output_object_ref, { call: canonicalJson(call), context: contextText });
    return prepared;
  };

  const revalidateExisting: ArtifactCowModelExecutorDependencies["revalidateExisting"] = async (
    context, existing: ModelAttemptReadback,
  ) => {
    const { rule, identity, input_sha256 } = await slot(context);
    if (existing.state !== "SUCCEEDED" || existing.intent.intent_ref.id !== `artifact-cow-operation-${identity}` ||
        existing.intent.payload_ref !== `artifact-cow-model-input-${input_sha256}` ||
        canonicalJson(existing.authority) !== canonicalJson(authority) ||
        existing.stage_attempt_ref !== attempt.attempt_ref || existing.stage_request_sha256 !== attempt.request_sha256 ||
        existing.workflow_budget_receipt_ref !== attempt.budget.receipt_ref ||
        existing.artifact_cow_binding?.operation_id !== attempt.request.operation_id ||
        existing.artifact_cow_binding.call_slot !== context.call_slot) {
      stale("durable COW output differs from the admitted model input");
    }
    const receipt = await input.admission_store.read_operation(existing.intent.intent_ref.id, context.call_slot);
    if (receipt === null || receipt.intent_json !== canonicalJson(existing.intent) ||
        receipt.authority_json !== canonicalJson(authority) ||
        receipt.expected_deployment_json !== canonicalJson(rule.deployment) || receipt.expires_at !== expires) {
      stale("durable COW spending authority changed");
    }
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
