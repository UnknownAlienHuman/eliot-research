import {
  canonicalEvidenceJson,
  type NavigationReadAuthority,
} from "@eliotr/cloudflare-evidence";
import {
  IdentifierSchema,
  RetrievalTraceSchema,
  Sha256Schema,
  VersionedRefSchema,
} from "@eliotr/contracts";
import type { InvestigationLedgerStore } from "@eliotr/research";
import {
  canonicalRetrievalJson,
  decodeCanonicalRetrievalJson,
  decodeEvidencePack,
  createD1RetrievalResultStore,
  createD1ScopeProfilePort,
  retrievalRequestDigest,
  type RetrievalQueryAccess,
  type ScopeProfileBinding,
  type StoredRetrievalResult,
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
  type StageRequest,
  type StageReceipt,
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
      receipt.output_manifest.object_ref === "" || receipt.output_manifest.sha256 === "") {
    fail("WORKFLOW_AUTHORITY_STALE");
  }
  const persistedBytes = await readWorkflowObject(dependencies.work_bucket, receipt.output_manifest, true);
  if (persistedBytes.byteLength === 0 || await digest(persistedBytes) !== receipt.output_manifest.sha256) {
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
    bucket: dependencies.work_bucket,
    navigation: dependencies.navigation,
    ledger: dependencies.ledger,
  });
  return checkpoint;
}

interface StoredRetrieveAttempt {
  readonly request_json: string;
  readonly request_sha256: string;
  readonly state: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  return actual.length === keys.length && actual.every((key, index) => key === [...keys].sort()[index]);
}

function decodeRetrieveBranchesCheckpoint(bytes: Uint8Array): RetrieveBranchesCheckpoint {
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_WORKFLOW_OUTPUT_BYTES) fail("WORKFLOW_OUTPUT_CORRUPT");
  let text: string;
  try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
  catch { fail("WORKFLOW_OUTPUT_CORRUPT"); }
  const raw = decodeCanonicalRetrievalJson(text);
  if (raw === undefined) fail("WORKFLOW_OUTPUT_CORRUPT");
  if (!isRecord(raw) || !hasExactKeys(raw, ["protocol", "workflow_stage", "operation_id", "investigation_ref", "principal_ref", "scope_snapshot_ref", "protocol_digest", "denominator_digest", "retrieval_request_digest", "evidence_pack", "trace", "coverage_claim"]) ||
      raw.protocol !== RETRIEVE_BRANCHES_PROTOCOL || raw.workflow_stage !== "RETRIEVE_BRANCHES" ||
      typeof raw.operation_id !== "string" || raw.operation_id.length < 1 || raw.operation_id.length > 128 ||
      !VersionedRefSchema.safeParse(raw.investigation_ref).success || !IdentifierSchema.safeParse(raw.principal_ref).success ||
      !VersionedRefSchema.safeParse(raw.scope_snapshot_ref).success || !Sha256Schema.safeParse(raw.protocol_digest).success ||
      !Sha256Schema.safeParse(raw.denominator_digest).success || !Sha256Schema.safeParse(raw.retrieval_request_digest).success ||
      decodeEvidencePack(raw.evidence_pack) === null || !RetrievalTraceSchema.safeParse(raw.trace).success ||
      (raw.coverage_claim !== "NONE" && raw.coverage_claim !== "SAMPLED" && raw.coverage_claim !== "COMPLETE_SCOPE")) {
    fail("WORKFLOW_OUTPUT_CORRUPT");
  }
  return raw as unknown as RetrieveBranchesCheckpoint;
}

async function persistedStageFive(
  dependencies: RetrieveBranchesStageDependencies,
  request: StageRequest,
): Promise<{ readonly stage_request: StageRequest; readonly receipt: StageReceipt; readonly checkpoint: RetrieveBranchesCheckpoint }> {
  let row: StoredRetrieveAttempt | null;
  try {
    row = await dependencies.database.prepare(
      "SELECT request_json, request_sha256, state FROM research_workflow_attempt WHERE operation_id = ?1 AND stage_index = 5 LIMIT 1",
    ).bind(request.operation_id).first<StoredRetrieveAttempt>();
  } catch {
    fail("WORKFLOW_AUTHORITY_STALE");
  }
  if (row === null || row.state !== "COMMITTED") fail("WORKFLOW_AUTHORITY_STALE");
  let stageRequest: StageRequest;
  try { stageRequest = parseRequest(JSON.parse(row.request_json)); }
  catch { fail("WORKFLOW_OUTPUT_CORRUPT"); }
  if (JSON.stringify(stageRequest) !== row.request_json ||
      stageRequest.stage !== "RETRIEVE_BRANCHES" || stageRequest.operation_id !== request.operation_id ||
      stageRequest.investigation_ref.id !== request.investigation_ref.id ||
      row.request_sha256 !== await textDigest(JSON.stringify(stageRequest))) {
    fail("WORKFLOW_AUTHORITY_STALE");
  }
  let receipt: StageReceipt | null;
  try { receipt = await new WorkflowCheckpointStore(dependencies.database).receipt(stageRequest, row.request_sha256); }
  catch (error) {
    if (error instanceof WorkflowCheckpointError && error.code === "WORKFLOW_OUTPUT_CORRUPT") fail("WORKFLOW_OUTPUT_CORRUPT");
    fail("WORKFLOW_AUTHORITY_STALE");
  }
  if (receipt === null || receipt.stage !== "RETRIEVE_BRANCHES" || receipt.operation_id !== request.operation_id ||
      receipt.investigation_ref.id !== request.investigation_ref.id || receipt.request_sha256 !== row.request_sha256) {
    fail("WORKFLOW_AUTHORITY_STALE");
  }
  let bytes: Uint8Array;
  try { bytes = await readWorkflowObject(dependencies.work_bucket, receipt.output_manifest, true); }
  catch (error) {
    if (error instanceof WorkflowCheckpointError && error.code === "WORKFLOW_OUTPUT_CORRUPT") fail("WORKFLOW_OUTPUT_CORRUPT");
    fail("WORKFLOW_OUTPUT_CORRUPT");
  }
  return { stage_request: stageRequest, receipt, checkpoint: decodeRetrieveBranchesCheckpoint(bytes) };
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
