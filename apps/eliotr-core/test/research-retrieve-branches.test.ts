import { applyD1Migrations, reset } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { canonicalEvidenceJson, createNavigationReadAuthority } from "@eliotr/cloudflare-evidence";
import { createD1ScopeService, createOwnerScopeAuthority } from "@eliotr/cloudflare-navigation";
import {
  createD1InvestigationLedgerStore,
  createInvestigationLedgerService,
  type CreateLedgerInput,
  type InvestigationLedgerStore,
  type LedgerD1Database,
} from "@eliotr/research";
import {
  createFreezeProtocolAndScopeStageHandler,
} from "../../../packages/cloudflare-research/src/research-protocol-freeze.js";
import {
  createWorkflowCheckpointExecutor,
  digest,
  fail,
  readWorkflowObject,
  type StageRequest,
  type StageReceipt,
  type WorkflowExecutionPorts,
  type WorkflowPrincipal,
} from "@eliotr/cloudflare-research";
import {
  createRetrieveBranchesStageHandler,
  readRetrieveBranchesCheckpoint,
  type RetrieveBranchesStageDependencies,
} from "../src/research-retrieve-branches.js";
import type { ScopeSnapshot } from "@eliotr/contracts";
import { importAndProject, prepareQ1Namespace, type Q1Namespace, type Q1Runtime } from "./retrieval-q1-fixture.js";

const runtime = env as unknown as Q1Runtime;
const access = { principal_ref: "retrieve-branches-owner", client_class: "owner_pwa" as const, credential_generation: "retrieve-branches-credential-v1" };
const principal: WorkflowPrincipal = { ...access, deployment_generation: "retrieve-branches-deployment-v1" };
const profile = { version: "retrieval-scope-v1", max_sources: 64, max_results: 16 } as const;

interface Fixture {
  readonly db: D1Database;
  readonly bucket: R2Bucket;
  readonly scope: ScopeSnapshot;
  readonly navigation: ReturnType<typeof createNavigationReadAuthority>;
  readonly ledger: InvestigationLedgerStore;
  readonly stage0: StageRequest;
  readonly stage0_receipt: StageReceipt;
  readonly executor: ReturnType<typeof createWorkflowCheckpointExecutor>;
}

async function fixture(): Promise<Fixture> {
  await reset();
  const db = runtime.CORE_DB;
  const bucket = runtime.WORK_BUCKET;
  await applyD1Migrations(db, runtime.CORE_MIGRATIONS);
  await applyD1Migrations(runtime.SEARCH_DB, runtime.SEARCH_MIGRATIONS);
  const world = {
    db,
    searchDb: runtime.SEARCH_DB,
    runtime,
    owner: access.principal_ref,
    ...(await prepareQ1Namespace(runtime, db, runtime.SEARCH_DB, access.principal_ref)),
  } satisfies Q1Namespace;
  await importAndProject(world);
  const nowMs = Date.now();
  const now = new Date(nowMs).toISOString();
  const expiresAt = new Date(nowMs + 3_600_000).toISOString();
  const decision = await db.prepare("SELECT allowed_use_json, disclosure_ceiling FROM source_admission_decision WHERE source_revision_ref = ?1 LIMIT 1")
    .bind(world.revision).first<{ readonly allowed_use_json: string; readonly disclosure_ceiling: string }>();
  if (decision === null) throw new Error("missing admitted source decision");
  await db.prepare("INSERT INTO scope_read_policy (source_namespace_id, principal_ref, client_class, policy_ref, generation, allowed_use_json, disclosure_ceiling, state, expires_at, created_at) VALUES (?1,?2,'owner_pwa',?3,1,?4,?5,'ACTIVE',?6,?7)")
    .bind(world.namespace, access.principal_ref, `retrieve-read-${world.namespace}`, decision.allowed_use_json, decision.disclosure_ceiling, expiresAt, now).run();
  const authority = createOwnerScopeAuthority(db, access, () => nowMs);
  const scopes = createD1ScopeService(db, authority, { now: () => nowMs, ttl_ms: 3_600_000 });
  const scope = await scopes.freeze({ kind: "SELECTED_SOURCES", source_ids: [`source-${world.namespace}`] }, access.credential_generation);
  await authority.grant(scope);
  await db.batch([
    db.prepare("INSERT INTO investigation_current_policy (policy_generation, policy_authority_ref, state, created_at) VALUES (?1,?2,'ACTIVE',?3)").bind("retrieve-policy-v1", scope.policy_authority_ref, now),
    db.prepare("INSERT INTO investigation_current_deployment (deployment_generation, state, created_at) VALUES (?1,'ACTIVE',?2)").bind(principal.deployment_generation, now),
  ]);
  const payload = {
    investigation_id: "retrieve-branches-investigation",
    operation_id: "retrieve-branches-operation",
    query: "Pinned",
    scope_snapshot_ref: { id: scope.snapshot_id, revision: scope.revision },
    evidence_grade: "E0" as const,
    principal_ref: principal.principal_ref,
  };
  const payloadBytes = new TextEncoder().encode(canonicalEvidenceJson(payload));
  const payloadKey = "retrieve-branches-input";
  const payloadDigest = await digest(payloadBytes);
  await bucket.put(payloadKey, payloadBytes, { sha256: payloadDigest });
  const ledgerInput: CreateLedgerInput = {
    investigation_id: payload.investigation_id,
    goal: payload.query,
    scope_snapshot_id: scope.snapshot_id,
    scope_snapshot_revision: scope.revision,
    evidence_grade: "E0",
    lane: "exploratory",
    lane_registrations: [], obligations: [], hypotheses: [], portfolio_ref: payloadKey, debt_refs: [],
    principal_ref: principal.principal_ref, input_digest: payloadDigest,
    policy_generation: "retrieve-policy-v1", policy_authority_ref: scope.policy_authority_ref,
    deployment_generation: principal.deployment_generation, idempotency_key: "retrieve-branches-ledger", model_profile_ref: "retrieve-model-v1",
    event_id: "retrieve-branches-created", payload_handle_ref: payloadKey, payload_digest: payloadDigest, created_at: now,
  };
  const ledgerStore = createD1InvestigationLedgerStore(db as unknown as LedgerD1Database);
  const ledger = createInvestigationLedgerService(ledgerStore, {
    current: async () => ({ principal_ref: principal.principal_ref, scope_snapshot_id: scope.snapshot_id, scope_snapshot_revision: scope.revision,
      policy_generation: "retrieve-policy-v1", policy_authority_ref: scope.policy_authority_ref, deployment_generation: principal.deployment_generation,
      purge_revision: 0, scope_purge_revision: scope.purge_ledger_revision }),
  }, { has: async (ref) => (await bucket.head(ref)) !== null, digestFor: async (ref) => ref === payloadKey ? payloadDigest : null });
  await ledger.create(ledgerInput);
  const navigation = createNavigationReadAuthority({ database: db, scope_snapshot: scope, access, require_current: (requested) => scopes.requireCurrent(requested), now: () => nowMs });
  const stage0: StageRequest = {
    protocol: "eliotr.workflow-stage.v1", operation_id: payload.operation_id, investigation_ref: { id: payload.investigation_id, revision: 1 },
    stage: "FREEZE_PROTOCOL_AND_SCOPE", idempotency_key: "retrieve-branches-stage", handler_generation: "retrieve-branches-v1",
    input_manifest: { object_ref: payloadKey, sha256: payloadDigest, byte_length: payloadBytes.byteLength,
      residency: { scope_domain_id: scope.snapshot_id, access_domain_id: principal.principal_ref, confidentiality_domain_id: "private",
        encryption_key_domain_id: "retrieve-key-v1", retention_domain_id: "retrieve-retention-v1", erasure_domain_id: "retrieve-erasure-v1",
        content_digest: { algorithm: "sha256", digest: payloadDigest } } },
  };
  const ports: WorkflowExecutionPorts = {
    authorizeResidency: async (request, actor) => {
      if (request.input_manifest.residency.scope_domain_id !== scope.snapshot_id || request.input_manifest.residency.access_domain_id !== actor.principal_ref) fail("WORKFLOW_AUTHORITY_STALE");
    },
    checkBudget: async () => ({ receipt_ref: "retrieve-branches-budget", expires_at_ms: nowMs + 300_000 }),
  };
  const executor = createWorkflowCheckpointExecutor(db, bucket, ports);
  const stage0Receipt = await executor.execute(stage0, principal, createFreezeProtocolAndScopeStageHandler({ navigation, ledger: ledgerStore }));
  return { db, bucket, scope, navigation, ledger: ledgerStore, stage0, stage0_receipt: stage0Receipt, executor };
}

async function prepareRetrieveStage(f: Fixture): Promise<{
  readonly request: StageRequest;
  readonly handler: ReturnType<typeof createRetrieveBranchesStageHandler>;
  readonly dependencies: RetrieveBranchesStageDependencies;
}> {
  const deps: RetrieveBranchesStageDependencies = {
    database: f.db,
    search_database: runtime.SEARCH_DB,
    work_bucket: runtime.WORK_BUCKET,
    evidence_bucket: runtime.EVIDENCE_BUCKET,
    access,
    navigation: f.navigation,
    ledger: f.ledger,
    profile,
  };
  let previous = f.stage0_receipt;
  for (const stage of ["ORIENT", "INTERPRET", "COMPILE_OBLIGATIONS", "PLAN"] as const) {
    const request: StageRequest = { ...f.stage0, stage, investigation_ref: previous.investigation_ref, input_manifest: previous.output_manifest };
    previous = await f.executor.execute(request, principal, async ({ request: current, input_bytes }) => {
      return new TextEncoder().encode(JSON.stringify({ stage: current.stage, input_sha: await digest(input_bytes) }));
    });
  }
  return {
    request: { ...f.stage0, stage: "RETRIEVE_BRANCHES", investigation_ref: previous.investigation_ref, input_manifest: previous.output_manifest },
    handler: createRetrieveBranchesStageHandler(deps),
    dependencies: deps,
  };
}

async function rowCounts(db: D1Database): Promise<{ readonly snapshots: number; readonly grants: number; readonly profiles: number; readonly results: number; readonly traces: number }> {
  const row = await db.prepare(
    "SELECT (SELECT COUNT(*) FROM scope_snapshot) AS snapshots, (SELECT COUNT(*) FROM scope_access_grant) AS grants, " +
      "(SELECT COUNT(*) FROM retrieval_scope_profile) AS profiles, (SELECT COUNT(*) FROM retrieval_query_result) AS results, " +
      "(SELECT COUNT(*) FROM retrieval_query_trace) AS traces",
  ).first<{ readonly snapshots: number; readonly grants: number; readonly profiles: number; readonly results: number; readonly traces: number }>();
  if (row === null) throw new Error("missing retrieval row counts");
  return row;
}

describe("RETRIEVE_BRANCHES over the persisted protocol scope", () => {
  it("reads stage-0 authority, searches the same scope, and replays exact evidence refs", async () => {
    const f = await fixture();
    const { request: retrieveRequest, handler, dependencies } = await prepareRetrieveStage(f);
    const beforeRetrieve = await rowCounts(f.db);
    const firstReceipt = await f.executor.execute(retrieveRequest, principal, handler);
    const authoritative = await readRetrieveBranchesCheckpoint(dependencies, retrieveRequest, principal);
    expect(authoritative.receipt.request_sha256).toBe(firstReceipt.request_sha256);
    expect(authoritative.checkpoint.operation_id).toBe(retrieveRequest.operation_id);
    const firstBytes = await readWorkflowObject(runtime.WORK_BUCKET, firstReceipt.output_manifest, true);
    const first = JSON.parse(new TextDecoder().decode(firstBytes)) as { evidence_pack: { resolved_evidence: readonly { exact_excerpt: string; handle: { source_revision_ref: string; scope_snapshot_ref: { id: string; revision: number } } }[]; pack_ref: { id: string; revision: number } }; trace: { evidence_pack_ref: string }; coverage_claim: string };
    expect(first.coverage_claim, JSON.stringify(first)).toBe("SAMPLED");
    expect(first.evidence_pack.resolved_evidence).toHaveLength(1);
    expect(first.evidence_pack.resolved_evidence[0]?.exact_excerpt).toBe("# Evidence\n\nPinned content.\n");
    expect(first.evidence_pack.resolved_evidence[0]?.handle.scope_snapshot_ref).toEqual({ id: f.scope.snapshot_id, revision: f.scope.revision });
    expect(first.evidence_pack.pack_ref.id).toBe(first.trace.evidence_pack_ref);
    const counts = await rowCounts(f.db);
    expect(counts.snapshots).toBe(beforeRetrieve.snapshots);
    expect(counts.grants).toBe(beforeRetrieve.grants);
    expect(counts.profiles).toBe(beforeRetrieve.profiles + 1);
    expect(counts.results).toBe(beforeRetrieve.results + 1);
    expect(counts.traces).toBe(beforeRetrieve.traces + 1);
    const replayReceipt = await f.executor.execute(retrieveRequest, principal, handler);
    const replayBytes = await readWorkflowObject(runtime.WORK_BUCKET, replayReceipt.output_manifest, true);
    expect(new TextDecoder().decode(replayBytes)).toBe(new TextDecoder().decode(firstBytes));
    expect(await rowCounts(f.db)).toEqual(counts);
    const replayReadback = await readRetrieveBranchesCheckpoint(dependencies, retrieveRequest, principal);
    expect(canonicalEvidenceJson(replayReadback.checkpoint)).toBe(canonicalEvidenceJson(authoritative.checkpoint));
  });

  it("rejects a mismatched operation reference and tampered persisted output", async () => {
    const f = await fixture();
    const { request, handler, dependencies } = await prepareRetrieveStage(f);
    const receipt = await f.executor.execute(request, principal, handler);
    await expect(readRetrieveBranchesCheckpoint(dependencies, { ...request, operation_id: "other-operation" }, principal))
      .rejects.toMatchObject({ code: "WORKFLOW_AUTHORITY_STALE" });
    const original = await f.bucket.head(receipt.output_manifest.object_ref);
    expect(original).not.toBeNull();
    const corrupted = new Uint8Array(await readWorkflowObject(f.bucket, receipt.output_manifest, true));
    corrupted[0] = (corrupted[0] ?? 0) ^ 1;
    await f.bucket.put(receipt.output_manifest.object_ref, corrupted, {
      sha256: await digest(corrupted),
      customMetadata: original?.customMetadata ?? {},
    });
    await expect(readRetrieveBranchesCheckpoint(dependencies, request, principal))
      .rejects.toMatchObject({ code: "WORKFLOW_OUTPUT_CORRUPT" });
  });

  it("binds stage-0 readback to the committed attempt reference", async () => {
    const f = await fixture();
    const { request, handler, dependencies } = await prepareRetrieveStage(f);
    await f.executor.execute(request, principal, handler);
    await f.db.prepare(
      "UPDATE research_workflow_attempt SET attempt_ref = ?1 WHERE operation_id = ?2 AND stage_index = 0",
    ).bind("tampered-stage-zero-attempt", request.operation_id).run();
    await expect(readRetrieveBranchesCheckpoint(dependencies, request, principal))
      .rejects.toMatchObject({ code: "RESEARCH_PROTOCOL_FREEZE_AUTHORITY_STALE" });
  });

  it("refuses a revoked held grant before retrieval rows or evidence reads", async () => {
    const f = await fixture();
    const { request, handler } = await prepareRetrieveStage(f);
    const before = await rowCounts(f.db);
    await f.db.prepare("UPDATE scope_access_grant SET state = 'REVOKED' WHERE snapshot_id = ?1 AND snapshot_revision = ?2 AND principal_ref = ?3")
      .bind(f.scope.snapshot_id, f.scope.revision, access.principal_ref).run();
    const inputBytes = await readWorkflowObject(runtime.WORK_BUCKET, request.input_manifest, true);
    await expect(handler({ request, principal, input_bytes: inputBytes, attempt_ref: "retrieve-revoked-attempt", budget_receipt_ref: "retrieve-budget" }))
      .rejects.toMatchObject({ code: "EVIDENCE_AUTHORIZATION_DENIED" });
    expect(await rowCounts(f.db)).toEqual(before);
  });
});
