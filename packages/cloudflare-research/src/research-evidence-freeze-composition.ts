import { canonicalEvidenceJson, type CloudflareEvidenceResolver, type NavigationReadAuthority } from "@eliotr/cloudflare-evidence";
import type { ReferenceManifestStore } from "@eliotr/policy";
import type { InvestigationLedgerStore, LedgerHead } from "@eliotr/research";
import type { ProtocolScopeCheckpoint } from "./research-protocol-freeze.js";
import { fail, type StageRequest, type WorkflowPrincipal, type WorkflowStageHandler } from "./types.js";
import {
  createEvidenceFreezeStageHandler,
  type EvidenceFreezeAuthorityPort,
} from "./research-evidence-freeze.js";
import {
  deriveEvidenceFreezeAuthorityBinding,
  prepareEvidenceFreezeInput,
  type EvidenceFreezeManifestStoreFactory,
  type EvidenceFreezeModelBinding,
  type EvidenceFreezeResidencyTemplate,
  type EvidenceFreezeStageFiveLineage,
} from "./research-evidence-freeze-preparation.js";
import { readFreezeProtocolAndScopeCheckpoint } from "./research-protocol-freeze.js";
import { WorkflowCheckpointStore } from "./store.js";

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

export interface EvidenceFreezeCommittedReaders {
  readonly read_stage_zero: (input: EvidenceFreezeCommittedReaderInput) => Promise<ProtocolScopeCheckpoint>;
  readonly read_stage_five: (input: EvidenceFreezeCommittedReaderInput) => Promise<EvidenceFreezeStageFiveLineage>;
  readonly read_w1_head: (investigation_id: string) => Promise<LedgerHead | null>;
  readonly read_authorization_receipt_ref: (operation_id: string, investigation_id: string, principal: WorkflowPrincipal) => Promise<string | null>;
}

export interface EvidenceFreezeWorkflowReaderEnvironment {
  readonly database: D1Database;
  readonly work_bucket: R2Bucket;
  readonly read_stage_five: (input: EvidenceFreezeCommittedReaderInput) => Promise<EvidenceFreezeStageFiveLineage>;
}

export async function readCommittedProtocolScopeCheckpoint(input: {
  readonly database: D1Database;
  readonly bucket: R2Bucket;
  readonly navigation: NavigationReadAuthority;
  readonly ledger: Pick<InvestigationLedgerStore, "read">;
  readonly request: StageRequest;
  readonly principal: WorkflowPrincipal;
}): Promise<ProtocolScopeCheckpoint> {
  const stored = await new WorkflowCheckpointStore(input.database).readCommittedStageRequest(input.request.operation_id, "FREEZE_PROTOCOL_AND_SCOPE");
  if (stored === null || stored.request.investigation_ref.id !== input.request.investigation_ref.id || stored.request.investigation_ref.revision !== 1) {
    fail("WORKFLOW_AUTHORITY_STALE");
  }
  return readFreezeProtocolAndScopeCheckpoint({
    request: stored.request, principal: input.principal, database: input.database, bucket: input.bucket,
    navigation: input.navigation, ledger: input.ledger, expected_attempt_ref: stored.attempt_ref,
  });
}

export function createEvidenceFreezeStageFiveLineage(input: {
  readonly checkpoint: Pick<EvidenceFreezeStageFiveLineage, "operation_id" | "investigation_ref" | "principal_ref" | "scope_snapshot_ref" | "protocol_digest" | "denominator_digest" | "retrieval_request_digest" | "evidence_pack">;
  readonly attempt_ref: string;
  readonly request_sha256: string;
}): EvidenceFreezeStageFiveLineage {
  return { ...input.checkpoint, stage_attempt_ref: input.attempt_ref, stage_request_sha256: input.request_sha256 };
}

export function createEvidenceFreezeWorkflowReaders(
  environment: EvidenceFreezeWorkflowReaderEnvironment,
  navigation: NavigationReadAuthority,
  ledger: Pick<InvestigationLedgerStore, "read">,
): EvidenceFreezeCommittedReaders {
  const checkpoints = new WorkflowCheckpointStore(environment.database);
  return {
    async read_stage_zero(input) {
      const stored = await checkpoints.readCommittedStageRequest(input.operation_id, "FREEZE_PROTOCOL_AND_SCOPE");
      if (stored === null || stored.request.investigation_ref.id !== input.investigation_id) fail("WORKFLOW_AUTHORITY_STALE");
      return readFreezeProtocolAndScopeCheckpoint({
        request: stored.request, principal: input.principal, database: environment.database, bucket: environment.work_bucket,
        navigation, ledger, expected_attempt_ref: stored.attempt_ref,
      });
    },
    read_stage_five: environment.read_stage_five,
    async read_w1_head(investigationId) { return checkpoints.head(investigationId); },
    async read_authorization_receipt_ref(operationId, investigationId, principal) {
      const row = await environment.database.prepare(
        "SELECT operation_id, investigation_id, principal_ref, credential_generation, deployment_generation, policy_authority_ref, " +
          "authorization_receipt_ref, scope_snapshot_id, scope_snapshot_revision FROM research_workflow_run WHERE operation_id=?1 LIMIT 1",
      ).bind(operationId).first<{
        operation_id: string; investigation_id: string; principal_ref: string; credential_generation: string; deployment_generation: string;
        policy_authority_ref: string; authorization_receipt_ref: string | null; scope_snapshot_id: string; scope_snapshot_revision: number;
      }>();
      if (row === null || row.operation_id !== operationId || row.investigation_id !== investigationId || row.principal_ref !== principal.principal_ref ||
          row.credential_generation !== principal.credential_generation || row.deployment_generation !== principal.deployment_generation ||
          row.scope_snapshot_id !== navigation.scope.snapshot_id || row.scope_snapshot_revision !== navigation.scope.revision ||
          row.authorization_receipt_ref === null || row.policy_authority_ref !== (await navigation.current()).policy_authority_ref) return null;
      return row.authorization_receipt_ref;
    },
  };
}

export function createEvidenceFreezePredecessorReader(
  navigation: NavigationReadAuthority,
  readers: EvidenceFreezeCommittedReaders,
): (request: StageRequest, principal: WorkflowPrincipal) => Promise<EvidenceFreezePredecessorReadback> {
  return async (request, principal) => {
    if (request.stage !== "RECONCILE" && request.stage !== "FREEZE_EVIDENCE") fail("WORKFLOW_INPUT_INVALID");
    if (request.investigation_ref.id.length === 0 || principal.principal_ref.length === 0) fail("WORKFLOW_INPUT_INVALID");
    const before = await navigation.current();
    const readerInput = { operation_id: request.operation_id, investigation_id: request.investigation_ref.id, principal };
    const stageZero = await readers.read_stage_zero(readerInput);
    const stageFive = await readers.read_stage_five(readerInput);
    const head = await readers.read_w1_head(request.investigation_ref.id);
    const authorizationReceiptRef = await readers.read_authorization_receipt_ref(request.operation_id, request.investigation_ref.id, principal);
    if (head === null || authorizationReceiptRef === null || authorizationReceiptRef.length === 0 ||
        stageZero.operation_id !== request.operation_id || stageZero.investigation_ref.id !== request.investigation_ref.id ||
        stageZero.principal_ref !== principal.principal_ref || stageFive.operation_id !== request.operation_id ||
        stageFive.investigation_ref.id !== request.investigation_ref.id || stageFive.principal_ref !== principal.principal_ref ||
        head.investigation_id !== request.investigation_ref.id || head.revision !== request.investigation_ref.revision ||
        navigation.scope.snapshot_id !== stageZero.scope_snapshot_ref.id || navigation.scope.revision !== stageZero.scope_snapshot_ref.revision) {
      fail("WORKFLOW_AUTHORITY_STALE");
    }
    const after = await navigation.current();
    const finalHead = await readers.read_w1_head(request.investigation_ref.id);
    if (canonicalEvidenceJson(before) !== canonicalEvidenceJson(after) || finalHead === null ||
        canonicalEvidenceJson(finalHead) !== canonicalEvidenceJson(head)) fail("WORKFLOW_AUTHORITY_STALE");
    return { stage_zero: stageZero, stage_five: stageFive, w1_head: head, authorization_receipt_ref: authorizationReceiptRef };
  };
}

export interface EvidenceFreezeCompositionDependencies {
  readonly navigation: NavigationReadAuthority;
  readonly resolver: CloudflareEvidenceResolver;
  readonly read_predecessors: (request: StageRequest, principal: WorkflowPrincipal) => Promise<EvidenceFreezePredecessorReadback>;
  readonly resolve_model_binding: (input: { readonly protocol_scope: ProtocolScopeCheckpoint; readonly w1_head: LedgerHead }) => Promise<EvidenceFreezeModelBinding>;
  readonly manifest_store_factory: EvidenceFreezeManifestStoreFactory;
  readonly manifest_residency_template: EvidenceFreezeResidencyTemplate;
  readonly max_context_bytes: number;
  readonly manifest_store: ReferenceManifestStore;
}

export interface EvidenceFreezeComposition { readonly reconcile: WorkflowStageHandler; readonly freeze: WorkflowStageHandler; }

export function createEvidenceFreezeComposition(dependencies: EvidenceFreezeCompositionDependencies): EvidenceFreezeComposition {
  const reconcile: WorkflowStageHandler = async ({ request, principal }) => {
    const predecessor = await dependencies.read_predecessors(request, principal);
    const binding = await dependencies.resolve_model_binding({ protocol_scope: predecessor.stage_zero, w1_head: predecessor.w1_head });
    return (await prepareEvidenceFreezeInput({
      navigation: dependencies.navigation, resolver: dependencies.resolver, stage_zero: predecessor.stage_zero,
      stage_five: predecessor.stage_five, w1_head: predecessor.w1_head, model_binding: binding,
      scope_snapshot_digest: dependencies.navigation.scope.digest, manifest_store: dependencies.manifest_store_factory,
      manifest_residency_template: dependencies.manifest_residency_template,
      authorization_receipt_ref: predecessor.authorization_receipt_ref, max_context_bytes: dependencies.max_context_bytes,
    }, request, principal)).input_bytes;
  };
  const authority: EvidenceFreezeAuthorityPort = {
    async read(input) {
      const predecessor = await dependencies.read_predecessors(input.request, input.principal);
      const binding = await dependencies.resolve_model_binding({ protocol_scope: predecessor.stage_zero, w1_head: predecessor.w1_head });
      return deriveEvidenceFreezeAuthorityBinding({
        stage_zero: predecessor.stage_zero, stage_five: predecessor.stage_five, w1_head: predecessor.w1_head,
        model_binding: binding, scope_snapshot_digest: dependencies.navigation.scope.digest,
        current_investigation_ref: input.request.investigation_ref, stage_input: input.stage_input,
      });
    },
  };
  return Object.freeze({ reconcile, freeze: createEvidenceFreezeStageHandler({
    navigation: dependencies.navigation, manifest_store: dependencies.manifest_store, resolver: dependencies.resolver, authority,
  }) });
}
