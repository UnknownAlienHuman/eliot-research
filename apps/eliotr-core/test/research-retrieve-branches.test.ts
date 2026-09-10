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
  type WorkflowExecutionPorts,
  type WorkflowPrincipal,
} from "@eliotr/cloudflare-research";
import {
  createRetrieveBranchesStageHandler,
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
  const first = await createWorkflowCheckpointExecutor(db, bucket, ports).execute(stage0, principal, createFreezeProtocolAndScopeStageHandler({ navigation, ledger: ledgerStore }));
  return { db, bucket, scope, navigation, ledger: ledgerStore, stage0: { ...stage0, stage: "RETRIEVE_BRANCHES", investigation_ref: first.investigation_ref, input_manifest: first.output_manifest } };
}

describe("RETRIEVE_BRANCHES over the persisted protocol scope", () => {
  it("reads stage-0 authority, searches the same scope, and replays exact evidence refs", async () => {
    const f = await fixture();
    const deps: RetrieveBranchesStageDependencies = { database: f.db, search_database: runtime.SEARCH_DB, evidence_bucket: f.bucket, access, navigation: f.navigation, ledger: f.ledger, profile };
    const handler = createRetrieveBranchesStageHandler(deps);
    const firstBytes = await handler({ request: f.stage0, principal, input_bytes: await readWorkflowObject(f.bucket, f.stage0.input_manifest, true), attempt_ref: "retrieve-attempt-1", budget_receipt_ref: "retrieve-budget" });
    const first = JSON.parse(new TextDecoder().decode(firstBytes)) as { evidence_pack: { resolved_evidence: readonly { exact_excerpt: string; handle: { source_revision_ref: string; scope_snapshot_ref: { id: string; revision: number } } }[]; pack_ref: { id: string; revision: number } }; trace: { evidence_pack_ref: { id: string; revision: number } }; coverage_claim: string };
    expect(first.coverage_claim).toBe("SAMPLED");
    expect(first.evidence_pack.resolved_evidence).toHaveLength(1);
    expect(first.evidence_pack.resolved_evidence[0]?.exact_excerpt).toBe("# Evidence\n\nPinned content.\n");
    expect(first.evidence_pack.resolved_evidence[0]?.handle.scope_snapshot_ref).toEqual({ id: f.scope.snapshot_id, revision: f.scope.revision });
    expect(first.evidence_pack.pack_ref).toEqual(first.trace.evidence_pack_ref);
    const counts = await f.db.prepare("SELECT COUNT(*) AS n FROM retrieval_query_result WHERE principal_ref = ?1").bind(access.principal_ref).first<{ readonly n: number }>();
    const replayBytes = await handler({ request: f.stage0, principal, input_bytes: await readWorkflowObject(f.bucket, f.stage0.input_manifest, true), attempt_ref: "retrieve-attempt-2", budget_receipt_ref: "retrieve-budget" });
    expect(new TextDecoder().decode(replayBytes)).toBe(new TextDecoder().decode(firstBytes));
    expect((await f.db.prepare("SELECT COUNT(*) AS n FROM retrieval_query_result WHERE principal_ref = ?1").bind(access.principal_ref).first<{ readonly n: number }>())?.n).toBe(counts?.n);
  });
});
