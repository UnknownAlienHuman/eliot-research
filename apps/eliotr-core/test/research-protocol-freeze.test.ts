import { applyD1Migrations, reset } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { expect, describe, it } from "vitest";
import { canonicalEvidenceJson, createNavigationReadAuthority, evidenceSha256 } from "@eliotr/cloudflare-evidence";
import {
  createD1ScopeService,
  createOwnerScopeAuthority,
} from "@eliotr/cloudflare-navigation";
import {
  createD1InvestigationLedgerStore,
  createInvestigationLedgerService,
  type CreateLedgerInput,
  type InvestigationLedgerStore,
  type LedgerD1Database,
} from "@eliotr/research";
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
  createFreezeProtocolAndScopeStageHandler,
  decodeProtocolScopeCheckpoint,
  readFreezeProtocolAndScopeCheckpoint,
} from "../../../packages/cloudflare-research/src/research-protocol-freeze.js";
import type { ScopeSnapshot } from "@eliotr/contracts";
import {
  importAndProject,
  prepareQ1Namespace,
  type Q1Namespace,
  type Q1Runtime,
} from "./retrieval-q1-fixture.js";
import { faultBucket } from "./research-workflow-fixture.js";

const runtime = env as unknown as Q1Runtime;
const access = {
  principal_ref: "protocol-owner",
  client_class: "owner_pwa" as const,
  credential_generation: "protocol-credential-v1",
};
const principal: WorkflowPrincipal = {
  principal_ref: access.principal_ref,
  credential_generation: access.credential_generation,
  deployment_generation: "protocol-deployment-v1",
};

interface ProtocolFreezeFixture {
  readonly db: D1Database;
  readonly bucket: R2Bucket;
  readonly world: Q1Namespace;
  readonly scope: ScopeSnapshot;
  readonly navigation: ReturnType<typeof createNavigationReadAuthority>;
  readonly ledger: InvestigationLedgerStore;
  readonly source_revision_ref: string;
  readonly request: StageRequest;
  readonly executor: ReturnType<typeof createWorkflowCheckpointExecutor>;
}

async function addReadPolicy(world: Q1Namespace, now: string, expiresAt: string): Promise<void> {
  const decision = await world.db.prepare(
    "SELECT allowed_use_json, disclosure_ceiling FROM source_admission_decision WHERE source_revision_ref = ?1 LIMIT 1",
  ).bind(world.revision).first<{ readonly allowed_use_json: string; readonly disclosure_ceiling: string }>();
  if (decision === null) throw new Error("Missing Q1 admission decision for protocol freeze");
  await world.db.prepare(
    "INSERT INTO scope_read_policy (source_namespace_id, principal_ref, client_class, policy_ref, generation, allowed_use_json, disclosure_ceiling, state, expires_at, created_at) VALUES (?1,?2,'owner_pwa',?3,1,?4,?5,'ACTIVE',?6,?7)",
  ).bind(world.namespace, access.principal_ref, `protocol-read-${world.namespace}`, decision.allowed_use_json,
    decision.disclosure_ceiling, expiresAt, now).run();
}

async function createProtocolFreezeFixture(tag: string, question = "What evidence is present in the admitted source?"): Promise<ProtocolFreezeFixture> {
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
  await addReadPolicy(world, now, expiresAt);

  const authority = createOwnerScopeAuthority(db, access, () => nowMs);
  const scopes = createD1ScopeService(db, authority, { now: () => nowMs, ttl_ms: 3_600_000 });
  const sourceId = `source-${world.namespace}`;
  const scope = await scopes.freeze({ kind: "SELECTED_SOURCES", source_ids: [sourceId] }, access.credential_generation);
  await authority.grant(scope);
  await db.batch([
    db.prepare("INSERT INTO investigation_current_policy (policy_generation, policy_authority_ref, state, created_at) VALUES (?1,?2,'ACTIVE',?3)")
      .bind("protocol-policy-v1", scope.policy_authority_ref, now),
    db.prepare("INSERT INTO investigation_current_deployment (deployment_generation, state, created_at) VALUES (?1,'ACTIVE',?2)")
      .bind(principal.deployment_generation, now),
  ]);

  const payloadKey = `protocol-freeze-input-${tag}`;
  const payload = {
    investigation_id: `protocol-investigation-${tag}`,
    operation_id: `protocol-run-${tag}`,
    query: question,
    scope_snapshot_ref: { id: scope.snapshot_id, revision: scope.revision },
    evidence_grade: "E0",
    principal_ref: principal.principal_ref,
  } as const;
  const payloadBytes = new TextEncoder().encode(canonicalEvidenceJson(payload));
  const payloadDigest = await digest(payloadBytes);
  await bucket.put(payloadKey, payloadBytes, { sha256: payloadDigest });

  const ledgerInput: CreateLedgerInput = {
    investigation_id: `protocol-investigation-${tag}`,
    goal: payload.query,
    scope_snapshot_id: scope.snapshot_id,
    scope_snapshot_revision: scope.revision,
    evidence_grade: "E0",
    lane: "exploratory",
    lane_registrations: [],
    obligations: [],
    hypotheses: [],
    portfolio_ref: payloadKey,
    debt_refs: [],
    principal_ref: principal.principal_ref,
    input_digest: payloadDigest,
    policy_generation: "protocol-policy-v1",
    policy_authority_ref: scope.policy_authority_ref,
    deployment_generation: principal.deployment_generation,
    idempotency_key: `protocol-idempotency-${tag}`,
    model_profile_ref: "protocol-model-profile-v1",
    event_id: `protocol-event-${tag}`,
    payload_handle_ref: payloadKey,
    payload_digest: payloadDigest,
    created_at: now,
  };
  const ledgerStore = createD1InvestigationLedgerStore(db as unknown as LedgerD1Database);
  const ledger = createInvestigationLedgerService(
    ledgerStore,
    {
      current: async () => ({
        principal_ref: principal.principal_ref,
        scope_snapshot_id: scope.snapshot_id,
        scope_snapshot_revision: scope.revision,
        policy_generation: "protocol-policy-v1",
        policy_authority_ref: scope.policy_authority_ref,
        deployment_generation: principal.deployment_generation,
        purge_revision: 0,
        scope_purge_revision: scope.purge_ledger_revision,
      }),
    },
    {
      has: async (ref) => (await bucket.head(ref)) !== null,
      digestFor: async (ref) => ref === payloadKey ? payloadDigest : null,
    },
  );
  await ledger.create(ledgerInput);

  const navigation = createNavigationReadAuthority({
    database: db,
    scope_snapshot: scope,
    access,
    require_current: (requested) => scopes.requireCurrent(requested),
    now: () => nowMs,
  });

  const request: StageRequest = {
    protocol: "eliotr.workflow-stage.v1",
    operation_id: `protocol-run-${tag}`,
    investigation_ref: { id: ledgerInput.investigation_id, revision: 1 },
    stage: "FREEZE_PROTOCOL_AND_SCOPE",
    idempotency_key: `protocol-stage-${tag}`,
    handler_generation: "protocol-freeze-handlers-v1",
    input_manifest: {
      object_ref: payloadKey,
      sha256: payloadDigest,
      byte_length: payloadBytes.byteLength,
      residency: {
        scope_domain_id: scope.snapshot_id,
        access_domain_id: principal.principal_ref,
        confidentiality_domain_id: "private",
        encryption_key_domain_id: "protocol-key-v1",
        retention_domain_id: "protocol-retention-v1",
        erasure_domain_id: "protocol-erasure-v1",
        content_digest: { algorithm: "sha256", digest: payloadDigest },
      },
    },
  };
  const ports: WorkflowExecutionPorts = {
    authorizeResidency: async (value, actor) => {
      if (value.input_manifest.residency.scope_domain_id !== scope.snapshot_id ||
          value.input_manifest.residency.access_domain_id !== actor.principal_ref) {
        fail("WORKFLOW_AUTHORITY_STALE");
      }
    },
    checkBudget: async () => ({ receipt_ref: `protocol-budget-${tag}`, expires_at_ms: nowMs + 300_000 }),
  };
  return {
    db,
    bucket,
    world,
    scope,
    navigation,
    ledger: ledgerStore,
    source_revision_ref: world.revision,
    request,
    executor: createWorkflowCheckpointExecutor(db, bucket, ports),
  };
}

describe("research protocol freeze stage over actual admitted/indexed D1/R2", () => {
  it("persists the exact exploratory protocol, replays it, and remains readable after a later checkpoint", async () => {
    const fixture = await createProtocolFreezeFixture("seed");
    const handler = createFreezeProtocolAndScopeStageHandler({ navigation: fixture.navigation, ledger: fixture.ledger });
    const first = await fixture.executor.execute(fixture.request, principal, handler);
    const firstBytes = await readWorkflowObject(fixture.bucket, first.output_manifest, true);
    const checkpoint = decodeProtocolScopeCheckpoint(firstBytes);
    const readbackBeforeW1Advance = await readFreezeProtocolAndScopeCheckpoint({
      request: fixture.request,
      principal,
      database: fixture.db,
      bucket: fixture.bucket,
      navigation: fixture.navigation,
      ledger: fixture.ledger,
    });
    const replay = await fixture.executor.execute(fixture.request, principal, handler);
    const replayBytes = await readWorkflowObject(fixture.bucket, replay.output_manifest, true);
    const count = await fixture.db.prepare(
      "SELECT COUNT(*) AS n FROM research_workflow_checkpoint WHERE operation_id = ?1",
    ).bind(fixture.request.operation_id).first<{ readonly n: number }>();

    expect(checkpoint.workflow_stage).toBe("FREEZE_PROTOCOL_AND_SCOPE");
    expect(checkpoint.operation_id).toBe(fixture.request.operation_id);
    expect(checkpoint.investigation_ref).toEqual(fixture.request.investigation_ref);
    expect(checkpoint.principal_ref).toBe(principal.principal_ref);
    expect(checkpoint.scope_snapshot_ref).toEqual({ id: fixture.scope.snapshot_id, revision: fixture.scope.revision });
    expect(checkpoint.requested_evidence_grade).toBe("E0");
    expect(checkpoint.protocol_profile.lane).toBe("exploratory");
    expect(checkpoint.protocol_profile.source_mode).toBe("corpus_only");
    expect(checkpoint.external_acquisition).toBe("none");
    expect(checkpoint.profile_definition_ref).toEqual({ id: "eliotr.research.profile.corpus-exploratory-lookup", revision: 1 });
    const { profile_ref: _profileRef, ...profileIdentity } = checkpoint.protocol_profile;
    const { denominator_ref: _denominatorRef, ...denominatorIdentity } = checkpoint.coverage_denominator;
    expect(checkpoint.profile_identity_digest).toBe(await evidenceSha256(profileIdentity));
    expect(checkpoint.denominator_identity_digest).toBe(await evidenceSha256(denominatorIdentity));
    expect(checkpoint.protocol_profile.profile_ref.id).toBe(`eliotr.research.compiled-profile-${checkpoint.profile_identity_digest}`);
    expect(checkpoint.coverage_denominator.denominator_ref.id).toBe(`eliotr.coverage.compiled-membership-${checkpoint.denominator_identity_digest}`);
    expect(checkpoint.coverage_denominator.eligible_source_revision_refs).toEqual([fixture.source_revision_ref]);
    expect(checkpoint.coverage_denominator.frozen_scope_snapshot_ref).toEqual(checkpoint.scope_snapshot_ref);
    expect(checkpoint.coverage_denominator.expires_at).toBe(fixture.scope.expires_at);
    expect(checkpoint.protocol_digest).toBe(await evidenceSha256(checkpoint.protocol_profile));
    expect(checkpoint.denominator_digest).toBe(await evidenceSha256(checkpoint.coverage_denominator));
    expect(readbackBeforeW1Advance).toEqual(checkpoint);
    const continuationRequest: StageRequest = {
      ...fixture.request,
      investigation_ref: first.investigation_ref,
      stage: "ORIENT",
      input_manifest: first.output_manifest,
    };
    const continuation = await fixture.executor.execute(
      continuationRequest,
      principal,
      async () => new TextEncoder().encode("protocol orient continuation"),
    );
    expect(continuation.investigation_ref.revision).toBe(3);
    const readbackAfterW1Advance = await readFreezeProtocolAndScopeCheckpoint({
      request: fixture.request,
      principal,
      database: fixture.db,
      bucket: fixture.bucket,
      navigation: fixture.navigation,
      ledger: fixture.ledger,
    });
    expect(readbackAfterW1Advance).toEqual(checkpoint);
    expect(new TextDecoder().decode(replayBytes)).toBe(new TextDecoder().decode(firstBytes));
    expect(replay.receipt_ref).toBe(first.receipt_ref);
    expect(count?.n).toBe(1);
    expect(fixture.scope.member_source_revision_refs).toEqual([fixture.source_revision_ref]);
    expect(fixture.scope.expires_at).toBeDefined();
    expect(fixture.request.stage).toBe("FREEZE_PROTOCOL_AND_SCOPE");
    expect(await fixture.bucket.head(fixture.request.input_manifest.object_ref)).not.toBeNull();
    const source = await fixture.db.prepare(
      "SELECT source_revision_ref, purge_state FROM source_revision WHERE source_revision_ref = ?1 LIMIT 1",
    ).bind(fixture.source_revision_ref).first<{ readonly source_revision_ref: string; readonly purge_state: string }>();
    expect(source).toEqual({ source_revision_ref: fixture.source_revision_ref, purge_state: "LIVE" });
  }, 30_000);

  it("derives distinct server profile identities for distinct W1 questions while exact replay is stable", async () => {
    const firstFixture = await createProtocolFreezeFixture("profile-a", "Which evidence supports alpha?");
    const firstHandler = createFreezeProtocolAndScopeStageHandler({ navigation: firstFixture.navigation, ledger: firstFixture.ledger });
    const firstReceipt = await firstFixture.executor.execute(firstFixture.request, principal, firstHandler);
    const firstCheckpoint = decodeProtocolScopeCheckpoint(await readWorkflowObject(firstFixture.bucket, firstReceipt.output_manifest, true));

    const secondFixture = await createProtocolFreezeFixture("profile-b", "Which evidence supports beta?");
    const secondHandler = createFreezeProtocolAndScopeStageHandler({ navigation: secondFixture.navigation, ledger: secondFixture.ledger });
    const secondReceipt = await secondFixture.executor.execute(secondFixture.request, principal, secondHandler);
    const secondCheckpoint = decodeProtocolScopeCheckpoint(await readWorkflowObject(secondFixture.bucket, secondReceipt.output_manifest, true));
    const exactReplay = await secondFixture.executor.execute(secondFixture.request, principal, secondHandler);
    const replayCheckpoint = decodeProtocolScopeCheckpoint(await readWorkflowObject(secondFixture.bucket, exactReplay.output_manifest, true));

    expect(firstCheckpoint.protocol_profile.profile_ref).not.toEqual(secondCheckpoint.protocol_profile.profile_ref);
    expect(replayCheckpoint.protocol_profile.profile_ref).toEqual(secondCheckpoint.protocol_profile.profile_ref);
    expect(replayCheckpoint.protocol_digest).toBe(secondCheckpoint.protocol_digest);
    expect(replayCheckpoint.denominator_digest).toBe(secondCheckpoint.denominator_digest);
  }, 30_000);

  it("rejects deployment rotation during checkpoint R2 readback without changing the stored checkpoint", async () => {
    const fixture = await createProtocolFreezeFixture("readback-rotation");
    const handler = createFreezeProtocolAndScopeStageHandler({ navigation: fixture.navigation, ledger: fixture.ledger });
    await fixture.executor.execute(fixture.request, principal, handler);
    const faultingBucket = faultBucket(fixture.bucket, {
      beforeGet: async () => {
        await fixture.db.prepare("UPDATE investigation_current_deployment SET state='RETIRED' WHERE deployment_generation=?1")
          .bind(principal.deployment_generation).run();
      },
    });
    await expect(readFreezeProtocolAndScopeCheckpoint({
      request: fixture.request,
      principal,
      database: fixture.db,
      bucket: faultingBucket,
      navigation: fixture.navigation,
      ledger: fixture.ledger,
    })).rejects.toMatchObject({ code: "RESEARCH_PROTOCOL_FREEZE_AUTHORITY_STALE" });
    expect((await fixture.db.prepare("SELECT state FROM investigation_current_deployment WHERE deployment_generation=?1")
      .bind(principal.deployment_generation).first<{ state: string }>())?.state).toBe("RETIRED");
    expect((await fixture.db.prepare("SELECT COUNT(*) AS n FROM research_workflow_checkpoint WHERE operation_id=?1")
      .bind(fixture.request.operation_id).first<{ n: number }>())?.n).toBe(1);
  }, 30_000);

  it("rejects revoked scope, wrong principal and substituted payload without a checkpoint", async () => {
    const fixture = await createProtocolFreezeFixture("negative");
    const handler = createFreezeProtocolAndScopeStageHandler({ navigation: fixture.navigation, ledger: fixture.ledger });
    const revoked = await fixture.db.prepare(
      "UPDATE scope_access_grant SET state='REVOKED' WHERE snapshot_id=?1 AND snapshot_revision=?2 AND principal_ref=?3",
    ).bind(fixture.scope.snapshot_id, fixture.scope.revision, principal.principal_ref).run();
    expect(revoked.meta.changes).toBe(1);
    await expect(fixture.executor.execute(fixture.request, principal, handler)).rejects.toMatchObject({ code: "WORKFLOW_AUTHORITY_STALE" });
    expect((await fixture.db.prepare("SELECT COUNT(*) AS n FROM research_workflow_checkpoint WHERE operation_id=?1").bind(fixture.request.operation_id).first<{ n: number }>())?.n).toBe(0);

    const restored = await createProtocolFreezeFixture("negative-principal");
    const restoredHandler = createFreezeProtocolAndScopeStageHandler({ navigation: restored.navigation, ledger: restored.ledger });
    await expect(restored.executor.execute(restored.request, { ...principal, principal_ref: "foreign-principal" }, restoredHandler)).rejects.toMatchObject({ code: "WORKFLOW_AUTHORITY_STALE" });
    expect((await restored.db.prepare("SELECT COUNT(*) AS n FROM research_workflow_checkpoint WHERE operation_id=?1").bind(restored.request.operation_id).first<{ n: number }>())?.n).toBe(0);
    await restored.executor.execute(restored.request, principal, restoredHandler);
    const substitutedBytes = new TextEncoder().encode("{}");
    const substitutedDigest = await digest(substitutedBytes);
    await restored.bucket.put("protocol-substituted-negative", substitutedBytes, { sha256: substitutedDigest });
    const substituted = {
      ...restored.request,
      input_manifest: {
        ...restored.request.input_manifest,
        object_ref: "protocol-substituted-negative",
        sha256: substitutedDigest,
        byte_length: substitutedBytes.byteLength,
        residency: {
          ...restored.request.input_manifest.residency,
          content_digest: { algorithm: "sha256" as const, digest: substitutedDigest },
        },
      },
    };
    await expect(restored.executor.execute(substituted, principal, restoredHandler)).rejects.toMatchObject({ code: "WORKFLOW_CONFLICT" });
    expect((await restored.db.prepare("SELECT COUNT(*) AS n FROM research_workflow_checkpoint WHERE operation_id=?1").bind(restored.request.operation_id).first<{ n: number }>())?.n).toBe(1);

    const identity = await createProtocolFreezeFixture("negative-identity");
    const identityHandler = createFreezeProtocolAndScopeStageHandler({ navigation: identity.navigation, ledger: identity.ledger });
    await identity.executor.execute(identity.request, principal, identityHandler);
    const changedCredential = { ...principal, credential_generation: "protocol-credential-rotated" };
    await expect(readFreezeProtocolAndScopeCheckpoint({
      request: identity.request,
      principal: changedCredential,
      database: identity.db,
      bucket: identity.bucket,
      navigation: identity.navigation,
      ledger: identity.ledger,
    })).rejects.toMatchObject({ code: "RESEARCH_PROTOCOL_FREEZE_AUTHORITY_STALE" });
    expect((await identity.db.prepare("SELECT COUNT(*) AS n FROM research_workflow_checkpoint WHERE operation_id=?1").bind(identity.request.operation_id).first<{ n: number }>())?.n).toBe(1);
    const changedDeployment = { ...principal, deployment_generation: "protocol-deployment-rotated" };
    await expect(readFreezeProtocolAndScopeCheckpoint({
      request: identity.request,
      principal: changedDeployment,
      database: identity.db,
      bucket: identity.bucket,
      navigation: identity.navigation,
      ledger: identity.ledger,
    })).rejects.toMatchObject({ code: "RESEARCH_PROTOCOL_FREEZE_AUTHORITY_STALE" });
    expect((await identity.db.prepare("SELECT COUNT(*) AS n FROM research_workflow_checkpoint WHERE operation_id=?1").bind(identity.request.operation_id).first<{ n: number }>())?.n).toBe(1);
  }, 30_000);
});
