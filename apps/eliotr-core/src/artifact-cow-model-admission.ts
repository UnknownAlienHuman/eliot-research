import type { NavigationReadAuthority } from "@eliotr/cloudflare-evidence";
import { canonicalJson } from "@eliotr/platform-cloudflare";
import { createArtifactSectionReviseWorkflowStore, type ArtifactSectionReviseAttempt } from "@eliotr/cloudflare-workflows";
import {
  admitArtifactCowModelSpend,
  createD1ModelGatewayDeploymentRegistry,
  ModelAttemptError,
  type ArtifactCowNativeModelSelectionResolver,
} from "@eliotr/cloudflare-research";
import type { ModelCallInput } from "@eliotr/research";
import {
  createArtifactCowModelAdmissionApplication,
  type ArtifactCowModelAdmissionRunConfiguration,
} from "@eliotr/cloudflare-research-runtime/artifact-cow-model-admission.js";
import type { ArtifactSectionReportAdmissionPolicyVars } from "@eliotr/cloudflare-research-runtime/artifact-report-admission.js";
import { resolveResearchOwnerSpendPolicy } from "@eliotr/cloudflare-research-configuration/research-owner-spend-policy.js";
import { createBoundResearchOwnerReportConfigSource } from "@eliotr/cloudflare-research-configuration/research-owner-report-policy.js";
import { readResearchRunConfiguration } from "./research-run-configuration.js";
import type { Env } from "./env.js";

function policyVars(env: Env): ArtifactSectionReportAdmissionPolicyVars {
  return Object.freeze({
    ...(env.ELIOTR_MODEL_SPEND_POLICY_JSON === undefined ? {} : {
      ELIOTR_MODEL_SPEND_POLICY_JSON: env.ELIOTR_MODEL_SPEND_POLICY_JSON,
    }),
    ...(env.ELIOTR_MODEL_SPEND_POLICY_PROVENANCE_REF === undefined ? {} : {
      ELIOTR_MODEL_SPEND_POLICY_PROVENANCE_REF: env.ELIOTR_MODEL_SPEND_POLICY_PROVENANCE_REF,
    }),
    ...(env.ELIOTR_RESEARCH_REPORT_CONFIG_JSON === undefined ? {} : {
      ELIOTR_RESEARCH_REPORT_CONFIG_JSON: env.ELIOTR_RESEARCH_REPORT_CONFIG_JSON,
    }),
    ...(env.ELIOTR_RESEARCH_REPORT_POLICY_PROVENANCE_REF === undefined ? {} : {
      ELIOTR_RESEARCH_REPORT_POLICY_PROVENANCE_REF: env.ELIOTR_RESEARCH_REPORT_POLICY_PROVENANCE_REF,
    }),
  });
}

export interface OwnerArtifactCowModelAdmissionInput {
  readonly env: Env;
  readonly attempt: ArtifactSectionReviseAttempt;
  /** Current, server-built authority for the immutable W2 admitted scope. */
  readonly navigation: NavigationReadAuthority;
  /** Re-resolved evidence for that current scope, never a browser payload. */
  readonly evidence_pack: ModelCallInput["evidence_pack"];
  /** Core-bound Native resolver for an exact selection captured by the run. */
  readonly resolve_native_model_selection?: ArtifactCowNativeModelSelectionResolver;
  readonly deployment_environment?: "PRODUCTION" | "TEST";
  readonly now?: () => number;
}

/** Dedicated Core adapter for current scope, pinned configuration, and D1 spend receipts. */
export async function createOwnerArtifactCowModelAdmission(input: OwnerArtifactCowModelAdmissionInput) {
  const { env, navigation, attempt } = input;
  const workflow = createArtifactSectionReviseWorkflowStore(env.CORE_DB);
  const routeAuthority = createD1ModelGatewayDeploymentRegistry(env.CORE_DB, {
    environment: input.deployment_environment ?? "PRODUCTION",
  });
  return createArtifactCowModelAdmissionApplication({
    attempt,
    navigation,
    evidence_pack: input.evidence_pack,
    workflow,
    route_authority: routeAuthority,
    legacy_policy_vars: policyVars(env),
    async read_original_configuration(pin): Promise<ArtifactCowModelAdmissionRunConfiguration> {
      const selected = await readResearchRunConfiguration(env, {
        operation_id: pin.operation_id as string,
        investigation_id: pin.investigation_id as string,
        principal_ref: pin.principal_ref as string,
        deployment_generation: pin.deployment_generation as string,
      });
      if (selected.mode !== pin.mode || selected.configuration_ref !== pin.configuration_ref ||
          selected.configuration_sha256 !== pin.configuration_sha256 ||
          canonicalJson(selected.model_selections) !== canonicalJson(pin.model_selections)) {
        throw new ModelAttemptError("MODEL_ATTEMPT_AUTHORITY_STALE", "COW original run snapshot differs from the REPORT witness", false);
      }
      return Object.freeze({ mode: selected.mode, model_selections: selected.model_selections,
        project_owner_ref: selected.project_owner_ref, project_id: selected.project_id,
        policy_vars: policyVars(selected.env) });
    },
    async is_current_cow_attempt() {
      const current = await env.CORE_DB.prepare(
        "SELECT operation_id FROM artifact_section_revise_current WHERE operation_id=?1 LIMIT 1",
      ).bind(attempt.request.operation_id).first<{ operation_id: unknown }>();
      return current?.operation_id === attempt.request.operation_id;
    },
    async read_current_policies(configuration, now_ms) {
      const grant = await navigation.current();
      const vars = configuration.policy_vars;
      const spend = resolveResearchOwnerSpendPolicy({
        raw: vars.ELIOTR_MODEL_SPEND_POLICY_JSON,
        provenance: vars.ELIOTR_MODEL_SPEND_POLICY_PROVENANCE_REF ?? "",
        access: navigation.access,
        deployment_generation: env.DEPLOYMENT_GENERATION,
        policy_generation: attempt.authority.policy_generation,
        policy_authority_ref: attempt.authority.policy_authority_ref,
        scope_expires_at: navigation.scope.expires_at,
        authorization: grant,
        now_ms,
      }).policy;
      const report = await createBoundResearchOwnerReportConfigSource({
        raw: vars.ELIOTR_RESEARCH_REPORT_CONFIG_JSON,
        provenance_ref: vars.ELIOTR_RESEARCH_REPORT_POLICY_PROVENANCE_REF ?? "",
        current_spend_authority: spend,
        now_ms,
      }).read();
      return Object.freeze({ spend, report });
    },
    admission_store: {
      async read_attempt_created_at(operation_id, attempt_ref) {
        const row = await env.CORE_DB.prepare(
          "SELECT created_at FROM artifact_section_revise_attempt WHERE operation_id=?1 AND attempt_ref=?2 LIMIT 1",
        ).bind(operation_id, attempt_ref).first<{ created_at: unknown }>();
        return row?.created_at ?? null;
      },
      async read_authorization(authorization_ref) {
        const row = await env.CORE_DB.prepare(
          "SELECT intent_json,quote_json,authority_json,expected_deployment_json FROM artifact_section_revise_spend_admission WHERE authorization_ref=?1 LIMIT 1",
        ).bind(authorization_ref).first<{
          intent_json: unknown; quote_json: unknown; authority_json: unknown; expected_deployment_json: unknown;
        }>();
        return row;
      },
      async admit(args) {
        await admitArtifactCowModelSpend(env.CORE_DB, args);
      },
      async read_operation(operation_id, call_slot) {
        const row = await env.CORE_DB.prepare(
          "SELECT intent_json,authority_json,expected_deployment_json,quote_json,expires_at FROM artifact_section_revise_spend_admission WHERE operation_id=?1 AND call_slot=?2 LIMIT 1",
        ).bind(operation_id, call_slot).first<{
          intent_json: unknown; authority_json: unknown; expected_deployment_json: unknown;
          quote_json: unknown; expires_at: unknown;
        }>();
        return row;
      },
    },
    ...(input.resolve_native_model_selection === undefined ? {} : {
      resolve_native_model_selection: input.resolve_native_model_selection,
    }),
    ...(input.now === undefined ? {} : { now: input.now }),
  });
}
