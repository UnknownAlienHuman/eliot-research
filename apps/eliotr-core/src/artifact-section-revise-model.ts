import { canonicalJson } from "@eliotr/platform-cloudflare";
import { createProviderNativeModelZeroPricePort } from "@eliotr/cloudflare-native-models";
import {
  createD1EvidenceAuthorityPort,
  createR2EvidenceContentPort,
  type NavigationReadAuthority,
} from "@eliotr/cloudflare-evidence";
import {
  createArtifactCowModelRuntime,
  createD1ResearchModelPricingQuotePort,
  createResearchReferenceManifestStore,
  decodeEvidenceFreezeStageInput,
  type ArtifactCowNativeModelSelectionResolver,
  type ReferenceManifestStorageContext,
  type ResearchModelSpendPolicy,
} from "@eliotr/cloudflare-research";
import {
  createArtifactSectionReviseModelApplication,
  ArtifactSectionReviseModelApplicationError,
  type ArtifactSectionReviseModelAdmissionPort,
} from "@eliotr/cloudflare-research-runtime/artifact-section-revise-model.js";
import type { ArtifactSectionReportAdmissionPolicyVars } from "@eliotr/cloudflare-research-runtime/artifact-report-admission.js";
import { WorkflowCheckpointStore, readCommittedStageLineage, readWorkflowObject, type ArtifactSectionReviseAttempt } from "@eliotr/cloudflare-workflows";
import type { AuthenticatedRequestContext } from "@eliotr/interfaces";
import { createOwnerArtifactCowModelAdmission } from "./artifact-cow-model-admission.js";
import type { createOwnerArtifactCowPorts } from "./artifact-section-revise-ports.js";
import { modelGatewayConfiguration } from "./research-semantic-server.js";
import { resolveResearchSemanticConfig } from "./research-semantic-config-revision.js";
import { readResearchRunConfiguration } from "./research-run-configuration.js";
import { createResearchProviderNativeModelAuthority } from "./research-provider-native-model-authority.js";
import { createResearchProviderNativeModelCurrentScopeReader } from "./research-provider-native-model-current-scope.js";
import { resolveResearchSelectedModelTransport } from "./research-selected-model-transport.js";
import type { Env } from "./env.js";
import { HttpRequestError } from "./http-errors.js";

function deny(message: string): never {
  throw new HttpRequestError("ARTIFACT_SECTION_REVISE_STALE", 409, message);
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

/** Core adapter for exact run pin resolution, authenticated storage, and deployment ports. */
export async function createOwnerArtifactCowModel(input: {
  readonly env: Env;
  readonly context: AuthenticatedRequestContext;
  readonly attempt: ArtifactSectionReviseAttempt;
  readonly navigation: NavigationReadAuthority;
  readonly cow: Awaited<ReturnType<typeof createOwnerArtifactCowPorts>>;
}) {
  const { env, context, attempt, navigation, cow } = input;
  const rawPin = attempt.request.report_admission_witness.material.run_configuration;
  let runtimeEnv = env;
  let runConfiguration: Awaited<ReturnType<typeof readResearchRunConfiguration>> | undefined;
  if (rawPin !== null && rawPin !== undefined) {
    if (typeof rawPin !== "object" || Array.isArray(rawPin)) deny("Original COW run configuration pin is malformed");
    const pin = rawPin as Record<string, unknown>;
    if ((pin.mode !== "snapshot-v1" && pin.mode !== "snapshot-v2") ||
        typeof pin.operation_id !== "string" || typeof pin.investigation_id !== "string" ||
        typeof pin.principal_ref !== "string" || pin.principal_ref !== attempt.authority.principal_ref ||
        typeof pin.deployment_generation !== "string" || typeof pin.configuration_ref !== "string" ||
        typeof pin.configuration_sha256 !== "string" || !Array.isArray(pin.model_selections)) {
      deny("Original COW run configuration identity is incomplete");
    }
    runConfiguration = await readResearchRunConfiguration(env, {
      operation_id: pin.operation_id,
      investigation_id: pin.investigation_id,
      principal_ref: pin.principal_ref,
      deployment_generation: pin.deployment_generation,
    });
    if (runConfiguration.mode !== pin.mode || runConfiguration.configuration_ref !== pin.configuration_ref ||
        runConfiguration.configuration_sha256 !== pin.configuration_sha256 ||
        canonicalJson(runConfiguration.model_selections) !== canonicalJson(pin.model_selections)) {
      deny("Original COW run configuration changed after REPORT admission");
    }
    runtimeEnv = runConfiguration.env;
  }

  let resolveNativeModelSelection: ArtifactCowNativeModelSelectionResolver | undefined;
  if (runConfiguration?.model_selections.some((selection) => selection.candidate_kind === "provider-native-v1")) {
    const ownerRef = runConfiguration.project_owner_ref;
    const projectId = runConfiguration.project_id;
    if ((runConfiguration.mode !== "snapshot-v1" && runConfiguration.mode !== "snapshot-v2") ||
        typeof ownerRef !== "string" || typeof projectId !== "string") {
      deny("Original COW Native selection has no captured project authority");
    }
    const currentScope = createResearchProviderNativeModelCurrentScopeReader({ database: env.CORE_DB,
      owner_ref: ownerRef, project_id: projectId, model_selections: runConfiguration.model_selections });
    const nativeAuthority = createResearchProviderNativeModelAuthority({ env, current_scope: currentScope });
    resolveNativeModelSelection = async (selectionInput) => {
      const resolved = await nativeAuthority.resolvePinned({ selection: selectionInput.selection,
        owner_ref: ownerRef, project_id: projectId,
        allow_expired_snapshot_v2: selectionInput.allow_expired_snapshot_v2 });
      const preparation = resolved.candidate.candidate.preparation;
      return Object.freeze({ deployment: preparation.deployment, transport_policy: preparation.transport_policy,
        pricing_port: createProviderNativeModelZeroPricePort(preparation, resolved.pricing_snapshot) });
    };
  }

  const semantic = await resolveResearchSemanticConfig({ env: runtimeEnv, database: env.CORE_DB });
  const spendPolicy = attempt.request.report_admission_witness.spend_policy as ResearchModelSpendPolicy;
  const admission = await createOwnerArtifactCowModelAdmission({ env, attempt, navigation,
    evidence_pack: cow.fresh_pack,
    ...(resolveNativeModelSelection === undefined ? {} : { resolve_native_model_selection: resolveNativeModelSelection }),
  });
  const selectedAudit = runConfiguration === undefined ? null : resolveResearchSelectedModelTransport({
    run_configuration: runConfiguration,
    stage: "AUDIT_CLAIMS",
  });
  const runtimeAdmission: ArtifactSectionReviseModelAdmissionPort = admission;
  const resolver = createD1EvidenceAuthorityPort({ core_database: env.CORE_DB, search_database: env.SEARCH_DB });

  try {
    return await createArtifactSectionReviseModelApplication({
      attempt,
      navigation,
      actor: { principal_ref: context.principal_ref, credential_generation: context.credential_generation,
        signal: context.request.signal },
      cow: {
        historical: cow.historical,
        fresh_pack: cow.fresh_pack,
        manifest_residency: cow.parent.manifest_residency,
        resolve_current_evidence: cow.resolve_current_evidence,
      },
      run_configuration: runConfiguration === undefined ? null : Object.freeze({
        mode: runConfiguration.mode,
        model_selections: runConfiguration.model_selections,
        project_owner_ref: runConfiguration.project_owner_ref,
        project_id: runConfiguration.project_id,
        policy_vars: policyVars(runtimeEnv),
      }),
      audit_selection: selectedAudit ?? null,
      semantic_config_json: semantic.config_json,
      ...(runtimeEnv.ELIOTR_MODEL_PROFILE_DEFINITION_JSON === undefined ? {} : {
        model_profile_json: runtimeEnv.ELIOTR_MODEL_PROFILE_DEFINITION_JSON,
      }),
      ...(runtimeEnv.ELIOTR_MODEL_PROFILE_PROVENANCE_REF === undefined ? {} : {
        model_profile_provenance_ref: runtimeEnv.ELIOTR_MODEL_PROFILE_PROVENANCE_REF,
      }),
      spend_policy: spendPolicy,
      gateway: modelGatewayConfiguration(runtimeEnv),
      deployment_environment: env.ENVIRONMENT === "development" ? "TEST" : "PRODUCTION",
      evidence_authority: resolver,
      evidence_content: createR2EvidenceContentPort({ evidence_bucket: env.EVIDENCE_BUCKET }),
      pricing: createD1ResearchModelPricingQuotePort(env.CORE_DB),
      admission: runtimeAdmission,
      ...(resolveNativeModelSelection === undefined ? {} : { resolve_native_model_selection: resolveNativeModelSelection }),
      create_manifest_store(storageContext: ReferenceManifestStorageContext, currentNavigation) {
        return createResearchReferenceManifestStore({ database: env.CORE_DB, work_bucket: env.WORK_BUCKET,
          context: storageContext, navigation: currentNavigation });
      },
      create_model_runtime(dependencies) {
        return createArtifactCowModelRuntime({ database: env.CORE_DB, work_bucket: env.WORK_BUCKET, ...dependencies });
      },
      async read_historical_input() {
        const stage = await readCommittedStageLineage(new WorkflowCheckpointStore(env.CORE_DB), cow.historical.operation_id,
          "FREEZE_EVIDENCE");
        return decodeEvidenceFreezeStageInput(await readWorkflowObject(env.WORK_BUCKET, stage.request.input_manifest, true));
      },
    });
  } catch (cause) {
    if (cause instanceof ArtifactSectionReviseModelApplicationError) {
      throw new HttpRequestError(cause.code, cause.status, cause.message);
    }
    throw cause;
  }
}
