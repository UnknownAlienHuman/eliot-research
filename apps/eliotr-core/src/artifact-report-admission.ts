import { IdentifierSchema } from "@eliotr/contracts";
import type { AuthenticatedRequestContext } from "@eliotr/interfaces";
import { canonicalJson, prepareIntentWithOutboxMutation } from "@eliotr/platform-cloudflare";
import {
  readReauthorizedArtifactDraft,
  readArtifactCowHistoricalFreeze,
} from "@eliotr/cloudflare-research";
import {
  ArtifactSectionReportAdmissionApplicationError,
  prepareArtifactSectionReportAdmissionApplication,
  type ArtifactSectionReportAdmissionPolicyVars,
} from "@eliotr/cloudflare-research-runtime/artifact-report-admission.js";
import { prepareArtifactReadReauthorization } from "./research-artifact-reauthorization-http.js";
import { parseReviseArtifactSectionRequest, type ReviseArtifactSectionRequest } from "./artifact-product-http.js";
import type { Env } from "./env.js";
import { HttpRequestError } from "./http-errors.js";
import { readResearchRunConfiguration } from "./research-run-configuration.js";

function snapshot<T>(value: T): T {
  const detached: T = JSON.parse(canonicalJson(value)) as T;
  const freeze = (item: unknown): void => {
    if (item !== null && typeof item === "object" && !Object.isFrozen(item)) {
      for (const child of Object.values(item)) freeze(child);
      Object.freeze(item);
    }
  };
  freeze(detached);
  return detached;
}

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

function deny(message: string): never {
  throw new HttpRequestError("ARTIFACT_REPORT_ADMISSION_STALE", 409, message);
}

function configured(value: string | undefined): string {
  const parsed = IdentifierSchema.safeParse(value);
  if (!parsed.success) throw new HttpRequestError("ARTIFACT_REPORT_NOT_CONFIGURED", 503, "Installed artifact REPORT policy is missing");
  return parsed.data;
}

async function originalRunConfiguration(input: {
  readonly env: Env;
  readonly artifact_ref: ReviseArtifactSectionRequest["artifact_ref"];
  readonly evidence_freeze_ref: { readonly id: string; readonly revision: number };
  readonly original_scope_snapshot_ref: { readonly id: string; readonly revision: number };
  readonly principal_ref: string;
}) {
  let historical: Awaited<ReturnType<typeof readArtifactCowHistoricalFreeze>>;
  try {
    historical = await readArtifactCowHistoricalFreeze({ database: input.env.CORE_DB,
      work_bucket: input.env.WORK_BUCKET, artifact_ref: input.artifact_ref,
      expected_freeze_ref: input.evidence_freeze_ref,
      expected_scope_snapshot_ref: input.original_scope_snapshot_ref });
  } catch {
    throw new HttpRequestError("RESEARCH_RUN_CONFIGURATION_REQUIRED", 409,
      "The artifact's original REPORT or committed COW lineage cannot be resolved to one exact run snapshot");
  }
  const row = await input.env.CORE_DB.prepare(
    "SELECT operation_id,investigation_id,principal_ref,deployment_generation FROM research_workflow_run WHERE operation_id=?1 LIMIT 1",
  ).bind(historical.operation_id).first<{
    readonly operation_id: unknown;
    readonly investigation_id: unknown;
    readonly principal_ref: unknown;
    readonly deployment_generation: unknown;
  }>();
  if (row === null || row.operation_id !== historical.operation_id ||
      row.investigation_id !== historical.investigation_ref.id || row.principal_ref !== input.principal_ref ||
      typeof row.deployment_generation !== "string") {
    throw new HttpRequestError("RESEARCH_RUN_CONFIGURATION_REQUIRED", 409,
      "The artifact's original research run configuration cannot be resolved");
  }
  let configuration: Awaited<ReturnType<typeof readResearchRunConfiguration>>;
  try {
    configuration = await readResearchRunConfiguration(input.env, {
      operation_id: historical.operation_id, investigation_id: historical.investigation_ref.id,
      principal_ref: input.principal_ref, deployment_generation: row.deployment_generation,
    });
  } catch (cause) {
    throw new HttpRequestError("RESEARCH_RUN_CONFIGURATION_REQUIRED", 409,
      cause instanceof Error ? `The artifact's original research run snapshot is unavailable: ${cause.message}`
        : "The artifact's original research run snapshot is missing or inconsistent");
  }
  if (configuration.mode === "legacy-installed") {
    return Object.freeze({ env: configuration.env, pin: null as null });
  }
  if (configuration.configuration_ref === null || configuration.configuration_sha256 === null ||
      configuration.model_selections.length === 0) {
    throw new HttpRequestError("RESEARCH_RUN_CONFIGURATION_REQUIRED", 409,
      "The artifact's original pinned model selection is incomplete");
  }
  return Object.freeze({ env: configuration.env,
    pin: Object.freeze({ mode: configuration.mode, operation_id: historical.operation_id,
      investigation_id: historical.investigation_ref.id, principal_ref: input.principal_ref,
      deployment_generation: row.deployment_generation, configuration_ref: configuration.configuration_ref,
      configuration_sha256: configuration.configuration_sha256, model_selections: configuration.model_selections }) });
}

export type { ArtifactSectionReportAdmissionWitness } from "@eliotr/cloudflare-research-runtime/artifact-report-admission.js";

/** Core adapter: owner reauthorization, exact historical run pin, and D1/outbox ports. */
export async function prepareOwnerArtifactReportAdmission(
  env: Env, context: AuthenticatedRequestContext, request: ReviseArtifactSectionRequest,
) {
  context = Object.freeze({ ...context, ...(context.access === undefined ? {} : { access: Object.freeze({ ...context.access }) }) });
  request = snapshot(parseReviseArtifactSectionRequest({ protocol: request.protocol,
    expected_artifact_revision: request.expected_artifact_revision }, request.artifact_ref, request.section_id, request.idempotency_key));
  if (context.client_class !== "owner_pwa") {
    throw new HttpRequestError("ARTIFACT_REPORT_ADMISSION_DENIED", 403, "Artifact revision requires an authenticated owner");
  }
  if (request.artifact_ref.revision !== request.expected_artifact_revision) deny("Artifact revision changed");
  const current = await prepareArtifactReadReauthorization(env, context, request.artifact_ref, "report");
  await current.requireCurrent();
  const draftRead = await readReauthorizedArtifactDraft({
    database: env.CORE_DB, work_bucket: env.WORK_BUCKET, artifact_ref: request.artifact_ref,
    access: context, current_navigation: current.navigation, current_authorization: current.authorization,
    deployment_generation: env.DEPLOYMENT_GENERATION,
  });
  if (draftRead === null || !("sections" in draftRead.artifact) || draftRead.artifact.status !== "DRAFT" ||
      draftRead.artifact.sections.filter((section) => section.contract_id === request.section_id).length !== 1) {
    deny("Exact parent draft and stable section contract are unavailable");
  }
  const draft = draftRead.artifact;
  const original = await originalRunConfiguration({ env, artifact_ref: request.artifact_ref,
    evidence_freeze_ref: draft.evidence_freeze_ref, original_scope_snapshot_ref: draftRead.original_scope_snapshot_ref,
    principal_ref: context.principal_ref });
  const grant = current.authorization;
  const policies = await env.CORE_DB.prepare(
    "SELECT policy_generation FROM investigation_current_policy WHERE policy_authority_ref=?1 AND state='ACTIVE' LIMIT 2",
  ).bind(grant.policy_authority_ref).all<{ policy_generation: unknown }>();
  if (policies.success !== true || !Array.isArray(policies.results) || policies.results.length !== 1) {
    deny("Current REPORT policy authority is ambiguous or unavailable");
  }
  const policyGeneration = configured(typeof policies.results[0]?.policy_generation === "string"
    ? policies.results[0].policy_generation : undefined);

  try {
    return await prepareArtifactSectionReportAdmissionApplication({
      request,
      context,
      deployment_generation: env.DEPLOYMENT_GENERATION,
      policy_generation: policyGeneration,
      draft: { spec_digest: draft.spec_digest, evidence_freeze_ref: draft.evidence_freeze_ref },
      policy_vars: policyVars(original.env),
      run_configuration: original.pin,
      navigation: current.navigation,
      authorization: grant,
      sources: await current.navigation.sources(current.navigation.scope.member_source_revision_refs, grant),
      assert_current: async () => {
        await current.requireCurrent();
        const row = await env.CORE_DB.prepare(
          "SELECT 1 AS current FROM artifact_draft_head h JOIN artifact_revision a ON (a.artifact_id,a.revision)=(h.artifact_id,h.head_revision) " +
          "JOIN owner_artifact_read_origin o ON (o.artifact_id,o.artifact_revision,o.reader_principal_ref)=(a.artifact_id,a.revision,?3) " +
          "WHERE h.artifact_id=?1 AND h.head_revision=?2 AND a.spec_digest=?4 " +
          "AND EXISTS (SELECT 1 FROM investigation_current_policy WHERE policy_generation=?5 AND policy_authority_ref=?6 AND state='ACTIVE') " +
          "AND EXISTS (SELECT 1 FROM research_deployment_compatible WHERE origin_deployment_generation=?7) LIMIT 1",
        ).bind(request.artifact_ref.id, request.expected_artifact_revision, context.principal_ref, draft.spec_digest,
          policyGeneration, grant.policy_authority_ref, env.DEPLOYMENT_GENERATION).first<{ current: unknown }>();
        if (row?.current !== 1) deny("Artifact head, owner, policy or deployment changed before REPORT admission");
      },
      outbox: {
        async read_intent_created_at(intent_id) {
          const prior = await env.CORE_DB.prepare("SELECT created_at FROM operation_intent WHERE intent_id=?1 AND revision=1 LIMIT 1")
            .bind(intent_id).first<{ created_at: unknown }>();
          return prior?.created_at ?? null;
        },
        async prepare(input) {
          const plan = await prepareIntentWithOutboxMutation(env.CORE_DB, input);
          return Object.freeze({ outbox_id: plan.outbox_id, readback: plan.readback,
            async commit_batch() { plan.assertBatchResults(await env.CORE_DB.batch([...plan.statements])); } });
        },
      },
    });
  } catch (cause) {
    if (cause instanceof ArtifactSectionReportAdmissionApplicationError) {
      throw new HttpRequestError(cause.code, cause.status, cause.message);
    }
    throw cause;
  }
}
