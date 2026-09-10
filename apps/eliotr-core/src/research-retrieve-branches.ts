import {
  canonicalEvidenceJson,
  type NavigationReadAuthority,
} from "@eliotr/cloudflare-evidence";
import type { InvestigationLedgerStore } from "@eliotr/research";
import {
  canonicalRetrievalJson,
  retrievalRequestDigest,
  type RetrievalQueryAccess,
  type ScopeProfileBinding,
} from "@eliotr/retrieval";
import type { ScopeSnapshot } from "@eliotr/contracts";
import {
  decodeProtocolScopeCheckpoint,
  readFreezeProtocolAndScopeCheckpoint,
  type ProtocolScopeCheckpoint,
} from "../../../packages/cloudflare-research/src/research-protocol-freeze.js";
import {
  digest,
  MAX_WORKFLOW_OUTPUT_BYTES,
  parseRequest,
  textDigest,
  WorkflowCheckpointError,
  type StageReceipt,
  type StageRequest,
  type WorkflowPrincipal,
  type WorkflowStageHandler,
} from "@eliotr/cloudflare-research";
import { WorkflowCheckpointStore } from "../../../packages/cloudflare-research/src/store.js";
import { readWorkflowObject } from "../../../packages/cloudflare-research/src/objects.js";
import {
  loadHeldResearchScope,
  retrieveWithHeldScope,
  type ResearchRetrievalEnvironment,
} from "./research-retrieval-composition.js";

const RETRIEVE_BRANCHES_PROTOCOL = "eliotr.research.retrieve-branches.v1" as const;

export interface RetrieveBranchesStageDependencies {
  readonly database: D1Database;
  readonly search_database: D1Database;
  readonly evidence_bucket: R2Bucket;
  /** Server-verified access identity; never copied from stage input bytes. */
  readonly access: RetrievalQueryAccess;
  /** Pinned to the same persisted scope as the workflow run. */
  readonly navigation: NavigationReadAuthority;
  readonly ledger: Pick<InvestigationLedgerStore, "read">;
  /** Server-selected retrieval profile, not a public request field. */
  readonly profile: ScopeProfileBinding;
}

export interface RetrieveBranchesCheckpoint {
  readonly protocol: typeof RETRIEVE_BRANCHES_PROTOCOL;
  readonly workflow_stage: "RETRIEVE_BRANCHES";
  readonly operation_id: string;
  readonly investigation_ref: { readonly id: string; readonly revision: number };
  readonly principal_ref: string;
  readonly scope_snapshot_ref: { readonly id: string; readonly revision: number };
  readonly protocol_digest: string;
  readonly denominator_digest: string;
  readonly retrieval_request_digest: string;
  readonly evidence_pack: Awaited<ReturnType<typeof retrieveWithHeldScope>>["evidence_pack"];
  readonly trace: Awaited<ReturnType<typeof retrieveWithHeldScope>>["trace"];
  readonly coverage_claim: Awaited<ReturnType<typeof retrieveWithHeldScope>>["coverage_claim"];
}

interface StoredStageZeroAttempt {
  readonly request_json: string;
  readonly request_sha256: string;
  readonly state: string;
}

interface RetrieveBranchesInput {
  readonly request: StageRequest;
  readonly principal: WorkflowPrincipal;
  readonly input_bytes: Uint8Array;
}

function fail(code: "WORKFLOW_INPUT_INVALID" | "WORKFLOW_AUTHORITY_STALE" | "WORKFLOW_OUTPUT_CORRUPT"): never {
  throw new WorkflowCheckpointError(code);
}

function sameRef(left: { readonly id: string; readonly revision: number }, right: { readonly id: string; readonly revision: number }): boolean {
  return left.id === right.id && left.revision === right.revision;
}

function sameManifest(left: StageReceipt["output_manifest"], right: StageRequest["input_manifest"]): boolean {
  return left.object_ref === right.object_ref && left.sha256 === right.sha256 &&
    left.byte_length === right.byte_length && canonicalEvidenceJson(left.residency) === canonicalEvidenceJson(right.residency);
}

function sameScope(left: ScopeSnapshot, right: ScopeSnapshot): boolean {
  return canonicalEvidenceJson(left) === canonicalEvidenceJson(right);
}

async function persistedStageZero(
  dependencies: RetrieveBranchesStageDependencies,
  request: StageRequest,
  inputBytes: Uint8Array,
  principal: WorkflowPrincipal,
): Promise<ProtocolScopeCheckpoint> {
  const row = await dependencies.database.prepare(
    "SELECT request_json, request_sha256, state FROM research_workflow_attempt WHERE operation_id = ?1 AND stage_index = 0 LIMIT 1",
  ).bind(request.operation_id).first<StoredStageZeroAttempt>();
  if (row === null || row.state !== "COMMITTED") fail("WORKFLOW_AUTHORITY_STALE");
  let stageZero: StageRequest;
  try {
    stageZero = parseRequest(JSON.parse(row.request_json));
  } catch {
    fail("WORKFLOW_OUTPUT_CORRUPT");
  }
  if (stageZero.stage !== "FREEZE_PROTOCOL_AND_SCOPE" || stageZero.operation_id !== request.operation_id ||
      stageZero.investigation_ref.id !== request.investigation_ref.id ||
      stageZero.investigation_ref.revision !== 1 || row.request_sha256 !== await textDigest(JSON.stringify(stageZero))) {
    fail("WORKFLOW_AUTHORITY_STALE");
  }
  const receipt = await new WorkflowCheckpointStore(dependencies.database).receipt(
    stageZero,
    row.request_sha256,
  );
  if (receipt === null || receipt.stage !== "FREEZE_PROTOCOL_AND_SCOPE" ||
      receipt.operation_id !== request.operation_id ||
      !sameManifest(receipt.output_manifest, request.input_manifest)) {
    fail("WORKFLOW_AUTHORITY_STALE");
  }
  const persistedBytes = await readWorkflowObject(dependencies.evidence_bucket, receipt.output_manifest, true);
  if (persistedBytes.byteLength !== inputBytes.byteLength || await digest(persistedBytes) !== await digest(inputBytes) ||
      request.input_manifest.sha256 !== await digest(inputBytes)) {
    fail("WORKFLOW_OUTPUT_CORRUPT");
  }
  const checkpoint = decodeProtocolScopeCheckpoint(persistedBytes);
  if (checkpoint.attempt_ref !== receipt.attempt_ref || checkpoint.attempt_ref === "" ||
      checkpoint.operation_id !== request.operation_id || checkpoint.principal_ref !== principal.principal_ref) {
    fail("WORKFLOW_AUTHORITY_STALE");
  }
  await readFreezeProtocolAndScopeCheckpoint({
    request: stageZero,
    principal,
    database: dependencies.database,
    bucket: dependencies.evidence_bucket,
    navigation: dependencies.navigation,
    ledger: dependencies.ledger,
  });
  return checkpoint;
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
  return async ({ request, principal, input_bytes, signal }: RetrieveBranchesInput & { readonly budget_receipt_ref: string; readonly signal?: AbortSignal }) => {
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
    const checkpoint = await persistedStageZero(dependencies, request, input_bytes, principal);
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
