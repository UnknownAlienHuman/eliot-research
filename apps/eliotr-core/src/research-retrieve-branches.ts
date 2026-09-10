import {
  canonicalEvidenceJson,
  type NavigationReadAuthority,
} from "@eliotr/cloudflare-evidence";
import {
  type ScopeSnapshot,
} from "@eliotr/contracts";
import type { InvestigationLedgerStore } from "@eliotr/research";
import {
  canonicalRetrievalJson,
  decodeRetrieveBranchesCheckpoint,
  createD1RetrievalResultStore,
  createD1ScopeProfilePort,
  retrievalRequestDigest,
  type RetrievalQueryAccess,
  type ScopeProfileBinding,
  type StoredRetrievalResult,
} from "@eliotr/retrieval";
import {
  MAX_WORKFLOW_OUTPUT_BYTES,
  readFreezeProtocolAndScopeCheckpoint,
  readWorkflowObject,
  textDigest,
  WorkflowCheckpointError,
  type ProtocolScopeCheckpoint,
  type StageRequest,
  type StageReceipt,
  type WorkflowPrincipal,
  type WorkflowStageHandler,
} from "@eliotr/cloudflare-research";
import { WorkflowCheckpointStore } from "@eliotr/cloudflare-workflows";
import {
  loadHeldResearchScope,
  retrieveWithHeldScope,
  type ResearchRetrievalEnvironment,
} from "./research-retrieval-composition.js";

const RETRIEVE_BRANCHES_PROTOCOL = "eliotr.research.retrieve-branches.v1" as const;

export interface RetrieveBranchesStageDependencies {
  readonly database: D1Database;
  readonly search_database: D1Database;
  readonly work_bucket: R2Bucket;
  readonly evidence_bucket: R2Bucket;
  /** Server-verified access identity; never copied from stage input bytes. */
  readonly access: RetrievalQueryAccess;
  /** Pinned to the same persisted scope as the workflow run. */
  readonly navigation: NavigationReadAuthority;
  readonly ledger: Pick<InvestigationLedgerStore, "read">;
  /** Server-selected retrieval profile, not a public request field. */
  readonly profile: ScopeProfileBinding;
}

export type { RetrieveBranchesCheckpoint } from "@eliotr/retrieval";
import type { RetrieveBranchesCheckpoint } from "@eliotr/retrieval";

interface RetrieveBranchesInput {
  readonly request: StageRequest;
  readonly principal: WorkflowPrincipal;
  readonly input_bytes: Uint8Array;
}

export interface RetrieveBranchesCheckpointReadback {
  readonly stage_request: StageRequest;
  readonly receipt: StageReceipt;
  readonly checkpoint: RetrieveBranchesCheckpoint;
  readonly protocol_scope: ProtocolScopeCheckpoint;
}

function fail(code: "WORKFLOW_INPUT_INVALID" | "WORKFLOW_AUTHORITY_STALE" | "WORKFLOW_OUTPUT_CORRUPT"): never {
  throw new WorkflowCheckpointError(code);
}

function sameRef(left: { readonly id: string; readonly revision: number }, right: { readonly id: string; readonly revision: number }): boolean {
  return left.id === right.id && left.revision === right.revision;
}

function sameScope(left: ScopeSnapshot, right: ScopeSnapshot): boolean {
  return canonicalEvidenceJson(left) === canonicalEvidenceJson(right);
}

async function persistedStageZero(
  dependencies: RetrieveBranchesStageDependencies,
  request: StageRequest,
  principal: WorkflowPrincipal,
): Promise<ProtocolScopeCheckpoint> {
  const stored = await new WorkflowCheckpointStore(dependencies.database).readCommittedStageRequest(
    request.operation_id,
    "FREEZE_PROTOCOL_AND_SCOPE",
  );
  if (stored === null || stored.request.investigation_ref.id !== request.investigation_ref.id ||
      stored.request.investigation_ref.revision !== 1) {
    fail("WORKFLOW_AUTHORITY_STALE");
  }
  return readFreezeProtocolAndScopeCheckpoint({
    request: stored.request,
    principal,
    database: dependencies.database,
    bucket: dependencies.work_bucket,
    navigation: dependencies.navigation,
    ledger: dependencies.ledger,
    expected_attempt_ref: stored.attempt_ref,
  });
}


async function persistedStageFive(
  dependencies: RetrieveBranchesStageDependencies,
  request: StageRequest,
): Promise<{ readonly stage_request: StageRequest; readonly receipt: StageReceipt; readonly checkpoint: RetrieveBranchesCheckpoint }> {
  const stored = await new WorkflowCheckpointStore(dependencies.database).readCommittedStageRequest(
    request.operation_id,
    "RETRIEVE_BRANCHES",
  );
  if (stored === null || stored.request.investigation_ref.id !== request.investigation_ref.id) {
    fail("WORKFLOW_AUTHORITY_STALE");
  }
  const stageRequest = stored.request;
  let receipt: StageReceipt | null;
  try { receipt = await new WorkflowCheckpointStore(dependencies.database).receipt(stageRequest, stored.request_sha256); }
  catch (error) {
    if (error instanceof WorkflowCheckpointError && error.code === "WORKFLOW_OUTPUT_CORRUPT") fail("WORKFLOW_OUTPUT_CORRUPT");
    fail("WORKFLOW_AUTHORITY_STALE");
  }
  if (receipt === null) {
    fail("WORKFLOW_AUTHORITY_STALE");
  }
  let bytes: Uint8Array;
  try { bytes = await readWorkflowObject(dependencies.work_bucket, receipt.output_manifest, true); }
  catch { fail("WORKFLOW_OUTPUT_CORRUPT"); }
  const checkpoint = decodeRetrieveBranchesCheckpoint(bytes);
  if (checkpoint === null) fail("WORKFLOW_OUTPUT_CORRUPT");
  return { stage_request: stageRequest, receipt, checkpoint };
}

/** Read the committed RETRIEVE_BRANCHES result; caller-supplied EvidencePack bytes are never authoritative. */
export async function readRetrieveBranchesCheckpoint(
  dependencies: RetrieveBranchesStageDependencies,
  request: StageRequest,
  principal: WorkflowPrincipal,
): Promise<RetrieveBranchesCheckpointReadback> {
  if (dependencies.access.principal_ref !== principal.principal_ref ||
      dependencies.access.credential_generation !== principal.credential_generation ||
      dependencies.navigation.access.principal_ref !== principal.principal_ref ||
      dependencies.navigation.access.credential_generation !== principal.credential_generation) {
    fail("WORKFLOW_AUTHORITY_STALE");
  }
  const before = await dependencies.navigation.current();
  const protocolScope = await persistedStageZero(dependencies, request, principal);
  const persisted = await persistedStageFive(dependencies, request);
  const checkpoint = persisted.checkpoint;
  const held = await loadHeldResearchScope(
    { CORE_DB: dependencies.database, SEARCH_DB: dependencies.search_database },
    dependencies.access,
    request.operation_id,
    principal.deployment_generation,
  );
  if (checkpoint.operation_id !== request.operation_id || checkpoint.investigation_ref.id !== request.investigation_ref.id ||
      checkpoint.investigation_ref.revision !== persisted.stage_request.investigation_ref.revision ||
      checkpoint.principal_ref !== principal.principal_ref ||
      !sameRef(checkpoint.scope_snapshot_ref, protocolScope.scope_snapshot_ref) ||
      !sameRef(checkpoint.scope_snapshot_ref, held.scope_snapshot_ref) ||
      !sameScope(checkpoint.trace.scope_snapshot, held.scope_snapshot) ||
      !sameRef(checkpoint.evidence_pack.scope_snapshot_ref, checkpoint.scope_snapshot_ref) ||
      checkpoint.protocol_digest !== protocolScope.protocol_digest ||
      checkpoint.denominator_digest !== protocolScope.denominator_digest ||
      checkpoint.coverage_claim === "COMPLETE_SCOPE" ||
      checkpoint.trace.query_product !== "FAST_SEARCH" ||
      checkpoint.trace.raw_query !== protocolScope.protocol_profile.question ||
      (checkpoint.trace.evidence_pack_ref !== undefined && checkpoint.trace.evidence_pack_ref !== checkpoint.evidence_pack.pack_ref.id)) {
    fail("WORKFLOW_AUTHORITY_STALE");
  }
  try {
    await createD1ScopeProfilePort(dependencies.database).requireBinding(held.scope_snapshot, dependencies.profile);
  } catch {
    fail("WORKFLOW_AUTHORITY_STALE");
  }
  const expectedRequestDigest = await retrievalRequestDigest({
    raw_query: checkpoint.trace.raw_query,
    product: checkpoint.trace.query_product,
    literals: [],
    requested_limit: dependencies.profile.max_results,
    scope_digest: held.scope_snapshot.digest,
  });
  const retrievalIdempotencyKey = `retrieve-branches:${await textDigest(JSON.stringify(persisted.stage_request))}`;
  let storedResult: StoredRetrievalResult | null;
  try {
    storedResult = await createD1RetrievalResultStore(dependencies.database, dependencies.access)
      .load(retrievalIdempotencyKey);
  } catch {
    fail("WORKFLOW_OUTPUT_CORRUPT");
  }
  if (storedResult === null || storedResult.idempotency_key !== retrievalIdempotencyKey ||
      storedResult.request_digest !== expectedRequestDigest ||
      storedResult.request_digest !== checkpoint.retrieval_request_digest ||
      canonicalRetrievalJson(storedResult.result) !== canonicalRetrievalJson({
        evidence_pack: checkpoint.evidence_pack, trace: checkpoint.trace, coverage_claim: checkpoint.coverage_claim,
      })) {
    fail("WORKFLOW_OUTPUT_CORRUPT");
  }
  const after = await dependencies.navigation.current();
  const heldAfter = await loadHeldResearchScope(
    { CORE_DB: dependencies.database, SEARCH_DB: dependencies.search_database },
    dependencies.access,
    request.operation_id,
    principal.deployment_generation,
  );
  if (canonicalEvidenceJson(before) !== canonicalEvidenceJson(after) ||
      canonicalEvidenceJson(held) !== canonicalEvidenceJson(heldAfter)) fail("WORKFLOW_AUTHORITY_STALE");
  return { stage_request: persisted.stage_request, receipt: persisted.receipt, checkpoint, protocol_scope: protocolScope };
}

function canonicalOutput(value: RetrieveBranchesCheckpoint): Uint8Array {
  const text = canonicalRetrievalJson(value);
  const bytes = new TextEncoder().encode(text);
  if (bytes.byteLength > MAX_WORKFLOW_OUTPUT_BYTES) fail("WORKFLOW_INPUT_INVALID");
  return bytes;
}

export function createRetrieveBranchesStageHandler(
  dependencies: RetrieveBranchesStageDependencies,
): WorkflowStageHandler {
  return async ({ request, principal, signal }: RetrieveBranchesInput & { readonly budget_receipt_ref: string; readonly signal?: AbortSignal }) => {
    if (request.stage !== "RETRIEVE_BRANCHES" || dependencies.access.principal_ref !== principal.principal_ref ||
        dependencies.access.credential_generation !== principal.credential_generation ||
        dependencies.navigation.access.principal_ref !== principal.principal_ref ||
        dependencies.navigation.access.credential_generation !== principal.credential_generation) {
      fail("WORKFLOW_AUTHORITY_STALE");
    }
    if (!Number.isSafeInteger(dependencies.profile.max_sources) || dependencies.profile.max_sources < 1 ||
        !Number.isSafeInteger(dependencies.profile.max_results) || dependencies.profile.max_results < 1) {
      fail("WORKFLOW_INPUT_INVALID");
    }
    const checkpoint = await persistedStageZero(dependencies, request, principal);
    const held = await loadHeldResearchScope(
      { CORE_DB: dependencies.database, SEARCH_DB: dependencies.search_database },
      dependencies.access,
      request.operation_id,
      principal.deployment_generation,
    );
    if (!sameRef(held.scope_snapshot_ref, checkpoint.scope_snapshot_ref) ||
        !sameScope(held.scope_snapshot, dependencies.navigation.scope) ||
        checkpoint.coverage_denominator.expires_at !== held.scope_snapshot.expires_at ||
        checkpoint.coverage_denominator.eligible_source_revision_refs.length > dependencies.profile.max_sources) {
      fail("WORKFLOW_AUTHORITY_STALE");
    }
    const retrievalInput = {
      access: dependencies.access,
      scope_snapshot: held.scope_snapshot,
      raw_query: checkpoint.protocol_profile.question,
      product: "FAST_SEARCH" as const,
      literals: [],
      requested_limit: dependencies.profile.max_results,
      deadline_ms: Date.now() + 30_000,
      idempotency_key: `retrieve-branches:${await textDigest(JSON.stringify(request))}`,
      signal: signal ?? principal.signal ?? new AbortController().signal,
      profile: dependencies.profile,
    } as const;
    const result = await retrieveWithHeldScope(
      { CORE_DB: dependencies.database, SEARCH_DB: dependencies.search_database, EVIDENCE_BUCKET: dependencies.evidence_bucket } satisfies ResearchRetrievalEnvironment,
      retrievalInput,
    );
    const requestDigest = await retrievalRequestDigest({
      raw_query: retrievalInput.raw_query,
      product: retrievalInput.product,
      literals: retrievalInput.literals,
      requested_limit: retrievalInput.requested_limit,
      scope_digest: held.scope_snapshot.digest,
    });
    return canonicalOutput({
      protocol: RETRIEVE_BRANCHES_PROTOCOL,
      workflow_stage: request.stage,
      operation_id: request.operation_id,
      investigation_ref: request.investigation_ref,
      principal_ref: principal.principal_ref,
      scope_snapshot_ref: held.scope_snapshot_ref,
      protocol_digest: checkpoint.protocol_digest,
      denominator_digest: checkpoint.denominator_digest,
      retrieval_request_digest: requestDigest,
      evidence_pack: result.evidence_pack,
      trace: result.trace,
      coverage_claim: result.coverage_claim,
    });
  };
}
