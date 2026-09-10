import { canonicalEvidenceJson, type NavigationReadAuthority, type CloudflareEvidenceResolver } from "@eliotr/cloudflare-evidence";
import {
  createEvidenceFreezeStageHandler,
  deriveEvidenceFreezeAuthorityBinding,
  type EvidenceFreezeAuthorityPort,
  prepareEvidenceFreezeInput,
  type EvidenceFreezeManifestStoreFactory,
  type EvidenceFreezeModelBinding,
  type EvidenceFreezeResidencyTemplate,
  type EvidenceFreezeStageFiveLineage,
} from "@eliotr/cloudflare-research";
import type { StageRequest, WorkflowPrincipal, WorkflowStageHandler, ProtocolScopeCheckpoint } from "@eliotr/cloudflare-research";
import type { InvestigationLedgerStore, LedgerHead } from "@eliotr/research";
import type { ReferenceManifestStore } from "@eliotr/policy";
import type { RetrieveBranchesCheckpointReadback } from "./research-retrieve-branches.js";
import {
  readFreezeProtocolAndScopeCheckpoint,
  WorkflowCheckpointStore,
} from "@eliotr/cloudflare-research";
import {
  readRetrieveBranchesCheckpoint,
  type RetrieveBranchesStageDependencies,
} from "./research-retrieve-branches.js";

export interface EvidenceFreezePredecessorReadback {
  readonly stage_zero: ProtocolScopeCheckpoint;
  readonly stage_five: EvidenceFreezeStageFiveLineage;
  readonly w1_head: LedgerHead;
  readonly authorization_receipt_ref: string;
}

export interface EvidenceFreezeCommittedReaderInput {
  readonly operation_id: string;
  readonly investigation_id: string;
  readonly principal: WorkflowPrincipal;
}

/**
 * The callbacks here are the already-committed stage readers. They must load
 * the stage request, receipt, and immutable R2 checkpoint from D1/W2; callers
 * cannot supply checkpoint bytes or evidence data through this boundary.
 */
export interface EvidenceFreezeCommittedReaders {
  readonly read_stage_zero: (input: EvidenceFreezeCommittedReaderInput) => Promise<ProtocolScopeCheckpoint>;
  readonly read_stage_five: (input: EvidenceFreezeCommittedReaderInput) => Promise<RetrieveBranchesCheckpointReadback>;
  readonly read_w1_head: (investigation_id: string) => Promise<LedgerHead | null>;
  readonly read_authorization_receipt_ref: (operation_id: string, investigation_id: string, principal: WorkflowPrincipal) => Promise<string | null>;
}

export interface EvidenceFreezeWorkflowReaderEnvironment {
  readonly database: D1Database;
  readonly work_bucket: R2Bucket;
  readonly retrieve: Omit<RetrieveBranchesStageDependencies, "navigation" | "ledger">;
}

/** Build the predecessor readers from the committed W2 D1/R2 readers. */
export function createEvidenceFreezeWorkflowReaders(
  environment: EvidenceFreezeWorkflowReaderEnvironment,
  navigation: NavigationReadAuthority,
  ledger: Pick<InvestigationLedgerStore, "read">,
): EvidenceFreezeCommittedReaders {
  const checkpoints = new WorkflowCheckpointStore(environment.database);
  return {
    async read_stage_zero(input) {
      const stored = await checkpoints.readCommittedStageRequest(input.operation_id, "FREEZE_PROTOCOL_AND_SCOPE");
      if (stored === null || stored.request.investigation_ref.id !== input.investigation_id) {
        throw new Error("committed stage zero is unavailable");
      }
      return readFreezeProtocolAndScopeCheckpoint({
        request: stored.request,
        principal: input.principal,
        database: environment.database,
        bucket: environment.work_bucket,
        navigation,
        ledger,
        expected_attempt_ref: stored.attempt_ref,
      });
    },
    async read_stage_five(input) {
      const stored = await checkpoints.readCommittedStageRequest(input.operation_id, "RETRIEVE_BRANCHES");
      if (stored === null || stored.request.investigation_ref.id !== input.investigation_id) {
        throw new Error("committed stage five is unavailable");
      }
      const readback = await readRetrieveBranchesCheckpoint({
        ...environment.retrieve,
        navigation,
        ledger,
      }, stored.request, input.principal);
      if (readback.receipt.attempt_ref !== stored.attempt_ref) {
        throw new Error("committed stage five attempt binding differs");
      }
      return readback;
    },
    read_w1_head: (investigationId) => checkpoints.head(investigationId),
    read_authorization_receipt_ref: async (operationId, investigationId, principal) => {
      const row = await environment.database.prepare(
        "SELECT operation_id, investigation_id, principal_ref, credential_generation, deployment_generation, " +
          "policy_authority_ref, authorization_receipt_ref, scope_snapshot_id, scope_snapshot_revision " +
          "FROM research_workflow_run WHERE operation_id = ?1 LIMIT 1",
      ).bind(operationId).first<{
        readonly operation_id: string; readonly investigation_id: string; readonly principal_ref: string;
        readonly credential_generation: string; readonly deployment_generation: string;
        readonly policy_authority_ref: string; readonly authorization_receipt_ref: string | null;
        readonly scope_snapshot_id: string; readonly scope_snapshot_revision: number;
      }>();
      if (row === null || row.operation_id !== operationId || row.investigation_id !== investigationId ||
          row.principal_ref !== principal.principal_ref || row.credential_generation !== principal.credential_generation ||
          row.deployment_generation !== principal.deployment_generation || row.scope_snapshot_id !== navigation.scope.snapshot_id ||
          row.scope_snapshot_revision !== navigation.scope.revision || row.authorization_receipt_ref === null ||
          row.policy_authority_ref !== (await navigation.current()).policy_authority_ref) return null;
      return row.authorization_receipt_ref;
    },
  };
}

export function createEvidenceFreezePredecessorReader(
  navigation: NavigationReadAuthority,
  readers: EvidenceFreezeCommittedReaders,
): EvidenceFreezeCompositionDependencies["read_predecessors"] {
  return async (request, principal) => {
    if (request.stage !== "RECONCILE" && request.stage !== "FREEZE_EVIDENCE") {
      throw new Error("freeze predecessor read requires RECONCILE or FREEZE_EVIDENCE");
    }
    if (request.investigation_ref.id.length === 0 || principal.principal_ref.length === 0) {
      throw new Error("freeze predecessor identity is invalid");
    }
    const before = await navigation.current();
    const readerInput = {
      operation_id: request.operation_id,
      investigation_id: request.investigation_ref.id,
      principal,
    } satisfies EvidenceFreezeCommittedReaderInput;
    const stageZero = await readers.read_stage_zero(readerInput);
    const stageFive = await readers.read_stage_five(readerInput);
    const head = await readers.read_w1_head(request.investigation_ref.id);
    const authorizationReceiptRef = await readers.read_authorization_receipt_ref(request.operation_id, request.investigation_ref.id, principal);
    if (head === null || authorizationReceiptRef === null || authorizationReceiptRef.length === 0 ||
        stageZero.operation_id !== request.operation_id || stageZero.investigation_ref.id !== request.investigation_ref.id ||
        stageZero.principal_ref !== principal.principal_ref || stageFive.checkpoint.operation_id !== request.operation_id ||
        stageFive.checkpoint.investigation_ref.id !== request.investigation_ref.id ||
        stageFive.checkpoint.principal_ref !== principal.principal_ref ||
        stageFive.receipt.stage !== "RETRIEVE_BRANCHES" || stageFive.receipt.operation_id !== request.operation_id ||
        stageFive.receipt.investigation_ref.id !== request.investigation_ref.id ||
        head.investigation_id !== request.investigation_ref.id || head.revision !== request.investigation_ref.revision ||
        navigation.scope.snapshot_id !== stageZero.scope_snapshot_ref.id || navigation.scope.revision !== stageZero.scope_snapshot_ref.revision) {
      throw new Error("freeze predecessor authority is inconsistent");
    }
    const after = await navigation.current();
    const finalHead = await readers.read_w1_head(request.investigation_ref.id);
    if (canonicalEvidenceJson(before) !== canonicalEvidenceJson(after) || finalHead === null ||
        canonicalEvidenceJson(finalHead) !== canonicalEvidenceJson(head)) {
      throw new Error("freeze predecessor authority changed during readback");
    }
    const lineage: EvidenceFreezeStageFiveLineage = {
      operation_id: stageFive.checkpoint.operation_id,
      investigation_ref: stageFive.checkpoint.investigation_ref,
      principal_ref: stageFive.checkpoint.principal_ref,
      scope_snapshot_ref: stageFive.checkpoint.scope_snapshot_ref,
      protocol_digest: stageFive.checkpoint.protocol_digest,
      denominator_digest: stageFive.checkpoint.denominator_digest,
      retrieval_request_digest: stageFive.checkpoint.retrieval_request_digest,
      evidence_pack: stageFive.checkpoint.evidence_pack,
      stage_attempt_ref: stageFive.receipt.attempt_ref,
      stage_request_sha256: stageFive.receipt.request_sha256,
    };
    return { stage_zero: stageZero, stage_five: lineage, w1_head: head, authorization_receipt_ref: authorizationReceiptRef };
  };
}

export interface EvidenceFreezeCompositionDependencies {
  readonly navigation: NavigationReadAuthority;
  readonly resolver: CloudflareEvidenceResolver;
  readonly read_predecessors: (request: StageRequest, principal: WorkflowPrincipal) => Promise<EvidenceFreezePredecessorReadback>;
  readonly resolve_model_binding: (input: {
    readonly protocol_scope: ProtocolScopeCheckpoint;
    readonly w1_head: LedgerHead;
  }) => Promise<EvidenceFreezeModelBinding>;
  readonly manifest_store_factory: EvidenceFreezeManifestStoreFactory;
  readonly manifest_residency_template: EvidenceFreezeResidencyTemplate;
  readonly max_context_bytes: number;
  readonly manifest_store: ReferenceManifestStore;
}

export interface EvidenceFreezeComposition {
  readonly reconcile: WorkflowStageHandler;
  readonly freeze: WorkflowStageHandler;
}

/**
 * Compose stage 10 and stage 11 from trusted W2 readbacks. The caller owns the
 * D1/W2 readers; this module deliberately accepts typed readback values rather
 * than request-shaped profile or evidence data.
 */
export function createEvidenceFreezeComposition(
  dependencies: EvidenceFreezeCompositionDependencies,
): EvidenceFreezeComposition {
  const reconcile: WorkflowStageHandler = async ({ request, principal }) => {
    const predecessor = await dependencies.read_predecessors(request, principal);
    const binding = await dependencies.resolve_model_binding({
      protocol_scope: predecessor.stage_zero,
      w1_head: predecessor.w1_head,
    });
    return (await prepareEvidenceFreezeInput({
      navigation: dependencies.navigation,
      resolver: dependencies.resolver,
      stage_zero: predecessor.stage_zero,
      stage_five: predecessor.stage_five,
      w1_head: predecessor.w1_head,
      model_binding: binding,
      scope_snapshot_digest: dependencies.navigation.scope.digest,
      manifest_store: dependencies.manifest_store_factory,
      manifest_residency_template: dependencies.manifest_residency_template,
      authorization_receipt_ref: predecessor.authorization_receipt_ref,
      max_context_bytes: dependencies.max_context_bytes,
    }, request, principal)).input_bytes;
  };
  const authority = {
    async read(input: Parameters<EvidenceFreezeAuthorityPort["read"]>[0]) {
      const predecessor = await dependencies.read_predecessors(input.request, input.principal);
      const binding = await dependencies.resolve_model_binding({
        protocol_scope: predecessor.stage_zero,
        w1_head: predecessor.w1_head,
      });
      return deriveEvidenceFreezeAuthorityBinding({
        stage_zero: predecessor.stage_zero,
        stage_five: predecessor.stage_five,
        w1_head: predecessor.w1_head,
        model_binding: binding,
        scope_snapshot_digest: dependencies.navigation.scope.digest,
        current_investigation_ref: input.request.investigation_ref,
        stage_input: input.stage_input,
      });
    },
  };
  return Object.freeze({
    reconcile,
    freeze: createEvidenceFreezeStageHandler({
      navigation: dependencies.navigation,
      manifest_store: dependencies.manifest_store,
      resolver: dependencies.resolver,
      authority,
    }),
  });
}
