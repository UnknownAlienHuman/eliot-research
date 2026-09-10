import type { NavigationReadAuthority } from "@eliotr/cloudflare-evidence";
import {
  createEvidenceFreezePredecessorReader,
  createEvidenceFreezeComposition,
  type EvidenceFreezeCommittedReaderInput,
  type EvidenceFreezeCommittedReaders,
  type EvidenceFreezeComposition,
  type EvidenceFreezeCompositionDependencies,
  createEvidenceFreezeWorkflowReaders as createPackageEvidenceFreezeWorkflowReaders,
  createEvidenceFreezeStageFiveLineage,
  WorkflowCheckpointStore,
  fail,
} from "@eliotr/cloudflare-research";
import type { InvestigationLedgerStore } from "@eliotr/research";
import type { RetrieveBranchesStageDependencies } from "./research-retrieve-branches.js";
import { readRetrieveBranchesCheckpoint } from "./research-retrieve-branches.js";

export type {
  EvidenceFreezeCommittedReaderInput,
  EvidenceFreezeCommittedReaders,
  EvidenceFreezeComposition,
  EvidenceFreezeCompositionDependencies,
};
export { createEvidenceFreezeComposition, createEvidenceFreezePredecessorReader };

export interface EvidenceFreezeWorkflowReaderEnvironment {
  readonly database: D1Database;
  readonly work_bucket: R2Bucket;
  readonly retrieve: Omit<RetrieveBranchesStageDependencies, "navigation" | "ledger">;
}

/** App-owned adapter: the stage-5 reader remains in the core retrieval app. */
export function createEvidenceFreezeWorkflowReaders(
  environment: EvidenceFreezeWorkflowReaderEnvironment,
  navigation: NavigationReadAuthority,
  ledger: Pick<InvestigationLedgerStore, "read">,
): EvidenceFreezeCommittedReaders {
  return createPackageEvidenceFreezeWorkflowReaders({
    database: environment.database,
    work_bucket: environment.work_bucket,
    read_stage_five: async (input) => {
      const stored = await new WorkflowCheckpointStore(environment.database)
        .readCommittedStageRequest(input.operation_id, "RETRIEVE_BRANCHES");
      if (stored === null || stored.request.investigation_ref.id !== input.investigation_id) fail("WORKFLOW_AUTHORITY_STALE");
      const result = await readRetrieveBranchesCheckpoint({ ...environment.retrieve, navigation, ledger }, stored.request, input.principal);
      if (result.receipt.attempt_ref !== stored.attempt_ref) fail("WORKFLOW_OUTPUT_CORRUPT");
      return createEvidenceFreezeStageFiveLineage({ checkpoint: result.checkpoint, attempt_ref: result.receipt.attempt_ref, request_sha256: result.receipt.request_sha256 });
    },
  }, navigation, ledger);
}
