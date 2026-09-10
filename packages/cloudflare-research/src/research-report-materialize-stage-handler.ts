import type { WorkflowStageHandler } from "@eliotr/cloudflare-workflows";
import {
  createResearchArtifactMetadataProducer,
  type ResearchArtifactReportPolicy,
} from "./research-artifact-metadata.js";
import {
  prepareResearchReportAdmission,
  type ResearchReportAdmissionPolicySource,
} from "./research-report-admission.js";
import {
  createResearchMaterializeStageHandler,
  type ResearchMaterializeStageDependencies,
  type ResearchMaterializeTrustedMetadata,
} from "./research-materialize-stage-handler.js";

export interface ResearchReportMaterializeStageDependencies extends Omit<ResearchMaterializeStageDependencies, "admission" | "metadata"> {
  readonly policy_source: ResearchReportAdmissionPolicySource;
  readonly report_policy: ResearchArtifactReportPolicy;
  readonly expected_draft_head_revision?: number | null;
  readonly now?: () => number;
}

/**
 * Composes REPORT admission per MATERIALIZE request. The admission port is
 * created from fresh server authority and passed directly to the native
 * materializer; metadata remains limited to the configured report shape.
 */
export function createResearchReportMaterializeStageHandler(
  dependencies: ResearchReportMaterializeStageDependencies,
): WorkflowStageHandler {
  const {
    policy_source,
    report_policy,
    expected_draft_head_revision,
    now,
    ...stageDependencies
  } = dependencies;
  return async (input) => {
    const admissionInput = {
      database: stageDependencies.database,
      navigation: stageDependencies.navigation,
      request: input.request,
      principal: input.principal,
      policy_source,
      ...(now === undefined ? {} : { now }),
    };
    const admission = await prepareResearchReportAdmission(admissionInput);
    const metadata = createResearchArtifactMetadataProducer({
      intent: admission.intent,
      expected_draft_head_revision: expected_draft_head_revision ?? null,
      policy: report_policy,
    });
    const native = createResearchMaterializeStageHandler({
      ...stageDependencies,
      admission: admission.admission,
      metadata: async (metadataInput): Promise<ResearchMaterializeTrustedMetadata> => metadata(metadataInput),
    });
    return native(input);
  };
}
