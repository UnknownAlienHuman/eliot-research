import { applyD1Migrations, type D1Migration } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import type { ErasureDependencyClosure, ErasureFence, ErasureRequest } from "@eliotr/contracts";
import { invalidateEvidenceHandle } from "@eliotr/cloudflare-evidence";
import { createArtifactPublicationProducer } from "../src/index.js";
import { createD1ErasureInvalidationPort } from "../../cloudflare-erasure/src/invalidation.js";
import { erasureDigest } from "../../cloudflare-erasure/src/canonical.js";
import {
  createArtifactPublicationFixture,
  createArtifactPublicationFreshNavigation,
  prepareArtifactPublicationDraft,
  prepareNextArtifactPublicationDraftRevision,
} from "./artifact-publication-fixture.js";

interface TestEnv {
  readonly CORE_DB: D1Database;
  readonly WORK_BUCKET: R2Bucket;
  readonly CORE_MIGRATIONS: D1Migration[];
}

const runtime = env as unknown as TestEnv;
function errorCauseText(value: unknown): string {
  if (value === null || typeof value !== "object") return String(value);
  const root = value as { readonly message?: unknown; readonly cause?: unknown };
  const cause = root.cause !== null && typeof root.cause === "object" ? root.cause as { readonly message?: unknown; readonly cause?: unknown } : null;
  const nested = cause?.cause !== null && typeof cause?.cause === "object" ? cause.cause as { readonly message?: unknown } : null;
  return [root.message, cause?.message, nested?.message].map(String).join(" ");
}

describe("artifact publication with actual D1 and R2", () => {
  beforeAll(async () => applyD1Migrations(runtime.CORE_DB, runtime.CORE_MIGRATIONS));

  it("persists owner ACCEPTED, replays across fresh evidence reads, and rejects stale authority", async () => {
    const { fixture, prepared } = await createArtifactPublicationFixture();
    const refreshed = await createArtifactPublicationFreshNavigation(fixture, prepared.access, prepared.evidence.handle.source_namespace_id);
    let decisionCalls = 0;
    const producer = createArtifactPublicationProducer({
      database: fixture.db,
      work_bucket: fixture.bucket,
      require_current: refreshed.require_current,
      now: Date.now,
      resolve_acceptance_decision: async (input) => {
        decisionCalls += 1;
        return {
          protocol: "eliotr.artifact-owner-acceptance.v1",
          mode: "OWNER_EXPLICIT",
          artifact_ref: input.artifact_ref,
          expected_draft_head_revision: input.expected_draft_head_revision,
          expected_publication_revision: input.expected_publication_revision,
          principal_ref: input.access.principal_ref,
          credential_generation: input.access.credential_generation,
          idempotency_key: "owner-acceptance-once",
          decision_ref: `owner-commit-${prepared.artifactRef.id}`,
          provenance_ref: `owner-route-${prepared.artifactRef.id}`,
          expires_at: input.authorization.expires_at,
        };
      },
    });
    const currentNavigation = refreshed.navigation;
    const currentAuthorization = await currentNavigation.current();
    const input = {
      artifact_ref: prepared.artifactRef,
      expected_draft_head_revision: 1,
      expected_publication_revision: null,
      access: prepared.access,
      current_navigation: currentNavigation,
      current_authorization: currentAuthorization,
      search_database: prepared.fixture.retrieve.search_database,
      evidence_bucket: prepared.fixture.retrieve.evidence_bucket,
      deployment_generation: prepared.access.deployment_generation,
      idempotency_key: "owner-acceptance-once",
    };
    const accepted = await producer.accept(input);
    expect(accepted.disposition).toBe("CREATED");
    expect(accepted.revision.status).toBe("ACCEPTED");
    expect(accepted.receipt.artifact_ref).toEqual(prepared.artifactRef);
    const persistedEvidence = await fixture.db.prepare(
      "SELECT p.evidence_currentness_json,sr.source_owner_generation,sr.content_sha256 " +
      "FROM artifact_publication_receipt p JOIN source_revision sr ON sr.source_revision_ref=?2 " +
      "WHERE p.artifact_id=?1 AND p.draft_revision=1 LIMIT 1",
    ).bind(prepared.artifactRef.id, prepared.evidence.handle.source_revision_ref)
      .first<{ readonly evidence_currentness_json: string; readonly source_owner_generation: string; readonly content_sha256: string }>();
    if (persistedEvidence === null) throw new Error("persisted publication evidence is missing");
    const currentnessRows = JSON.parse(persistedEvidence.evidence_currentness_json) as readonly Record<string, unknown>[];
    expect(currentnessRows).toHaveLength(1);
    expect(currentnessRows[0]).toMatchObject({
      source_revision_ref: prepared.evidence.handle.source_revision_ref,
      source_owner_generation: persistedEvidence.source_owner_generation,
      source_content_sha256: persistedEvidence.content_sha256,
    });
    const readback = await producer.read({
      artifact_ref: prepared.artifactRef,
      access: prepared.access,
      current_navigation: currentNavigation,
      current_authorization: await currentNavigation.current(),
      search_database: prepared.fixture.retrieve.search_database,
      evidence_bucket: prepared.fixture.retrieve.evidence_bucket,
      deployment_generation: prepared.access.deployment_generation,
    });
    expect(readback?.receipt.publication_ref).toBe(accepted.receipt.publication_ref);
    expect(readback?.revision.status).toBe("ACCEPTED");
    const replay = await producer.accept({ ...input, current_authorization: await currentNavigation.current() });
    expect(replay.disposition).toBe("EXISTING");
    expect(replay.receipt.publication_ref).toBe(accepted.receipt.publication_ref);
    expect(decisionCalls).toBe(1);

    const raceKeys = ["publication-race-alpha", "publication-race-beta"] as const;
    const raceDraft = await prepareNextArtifactPublicationDraftRevision(prepared);
    const raceProducer = (idempotencyKey: string) => createArtifactPublicationProducer({
      database: fixture.db,
      work_bucket: fixture.bucket,
      require_current: refreshed.require_current,
      resolve_acceptance_decision: async (request) => ({
        protocol: "eliotr.artifact-owner-acceptance.v1",
        mode: "OWNER_EXPLICIT",
        artifact_ref: request.artifact_ref,
        expected_draft_head_revision: request.expected_draft_head_revision,
        expected_publication_revision: request.expected_publication_revision,
        principal_ref: request.access.principal_ref,
        credential_generation: request.access.credential_generation,
        idempotency_key: idempotencyKey,
        decision_ref: `owner-commit-${idempotencyKey}`,
        provenance_ref: `owner-route-${idempotencyKey}`,
        expires_at: request.authorization.expires_at,
      }),
    });
    const raceResults = await Promise.allSettled(raceKeys.map(async (idempotencyKey) => raceProducer(idempotencyKey).accept({
      ...input,
      artifact_ref: raceDraft.artifactRef,
      expected_draft_head_revision: 2,
      expected_publication_revision: 1,
      idempotency_key: idempotencyKey,
      current_authorization: await currentNavigation.current(),
    })));
    const raceWinners = raceResults.filter((result): result is PromiseFulfilledResult<Awaited<ReturnType<typeof producer.accept>>> => result.status === "fulfilled");
    const raceLosers = raceResults.filter((result) => result.status === "rejected");
    const raceSummary = raceResults.map((result) => result.status === "fulfilled"
      ? { status: result.status, publication_revision: result.value.receipt.publication_revision }
      : { status: result.status, code: (result.reason as { readonly code?: unknown })?.code, cause: errorCauseText(result.reason) });
    if (raceWinners.length !== 1 || raceLosers.length !== 1) throw new Error(`publication CAS race outcomes: ${JSON.stringify(raceSummary)}`);
    expect(raceWinners).toHaveLength(1);
    expect(raceLosers).toHaveLength(1);
    expect(errorCauseText(raceLosers[0]?.reason)).toContain(
      "UNIQUE constraint failed: artifact_publication_receipt.artifact_id, artifact_publication_receipt.publication_revision",
    );
    expect(raceWinners[0]?.value.receipt.publication_revision).toBe(2);
    const loserIndex = raceResults.findIndex((result) => result.status === "rejected");
    const loserKey = raceKeys[loserIndex];
    if (loserKey === undefined) throw new Error("publication race loser key is missing");
    const loserRows = await fixture.db.prepare(
      "SELECT " +
      "(SELECT COUNT(*) FROM operation_intent WHERE principal_ref=?1 AND idempotency_key=?2) AS intents," +
      "(SELECT COUNT(*) FROM outbox o JOIN operation_intent i ON i.intent_id=o.intent_id AND i.revision=o.intent_revision WHERE i.principal_ref=?1 AND i.idempotency_key=?2) AS outboxes," +
      "(SELECT COUNT(*) FROM operation_receipt r JOIN operation_intent i ON i.intent_id=r.intent_id AND i.revision=r.intent_revision WHERE i.principal_ref=?1 AND i.idempotency_key=?2) AS operation_receipts," +
      "(SELECT COUNT(*) FROM artifact_publication_receipt WHERE principal_ref=?1 AND idempotency_key=?2) AS publication_receipts",
    ).bind(prepared.access.principal_ref, loserKey).first<{
      readonly intents: number;
      readonly outboxes: number;
      readonly operation_receipts: number;
      readonly publication_receipts: number;
    }>();
    expect(loserRows).toEqual({ intents: 0, outboxes: 0, operation_receipts: 0, publication_receipts: 0 });

    const fencedDraft = await prepareArtifactPublicationDraft(fixture);
    let currentnessFenceRevoked = false;
    const fencedProducer = createArtifactPublicationProducer({
      database: fixture.db,
      work_bucket: fixture.bucket,
      require_current: async (scope) => {
        const current = await refreshed.require_current(scope);
        if (currentnessFenceRevoked) throw new Error("owner project membership was revoked");
        return current;
      },
      resolve_acceptance_decision: async (request) => {
        currentnessFenceRevoked = true;
        return {
          protocol: "eliotr.artifact-owner-acceptance.v1",
          mode: "OWNER_EXPLICIT",
          artifact_ref: request.artifact_ref,
          expected_draft_head_revision: request.expected_draft_head_revision,
          expected_publication_revision: request.expected_publication_revision,
          principal_ref: request.access.principal_ref,
          credential_generation: request.access.credential_generation,
          idempotency_key: "owner-acceptance-revoked",
          decision_ref: `owner-commit-${fencedDraft.artifactRef.id}`,
          provenance_ref: `owner-route-${fencedDraft.artifactRef.id}`,
          expires_at: request.authorization.expires_at,
        };
      },
    });
    await expect(fencedProducer.accept({
      artifact_ref: fencedDraft.artifactRef,
      expected_draft_head_revision: 1,
      expected_publication_revision: null,
      access: prepared.access,
      current_navigation: currentNavigation,
      current_authorization: await currentNavigation.current(),
      search_database: fixture.retrieve.search_database,
      evidence_bucket: fixture.retrieve.evidence_bucket,
      deployment_generation: prepared.access.deployment_generation,
      idempotency_key: "owner-acceptance-revoked",
    })).rejects.toMatchObject({ code: "ARTIFACT_PUBLICATION_STALE" });
    const fencedPublication = await fixture.db.prepare("SELECT COUNT(*) AS count FROM artifact_publication_receipt WHERE artifact_id=?1")
      .bind(fencedDraft.artifactRef.id).first<{ readonly count: number }>();
    const fencedHead = await fixture.db.prepare("SELECT COUNT(*) AS count FROM artifact_publication_head WHERE artifact_id=?1")
      .bind(fencedDraft.artifactRef.id).first<{ readonly count: number }>();
    const fencedIntent = await fixture.db.prepare("SELECT COUNT(*) AS count FROM operation_intent WHERE principal_ref=?1 AND idempotency_key=?2")
      .bind(prepared.access.principal_ref, "owner-acceptance-revoked").first<{ readonly count: number }>();
    expect(fencedPublication?.count).toBe(0);
    expect(fencedHead?.count).toBe(0);
    expect(fencedIntent?.count).toBe(0);

    await expect(producer.accept({ ...input, expected_draft_head_revision: 2 })).rejects.toMatchObject({ code: "ARTIFACT_PUBLICATION_STALE" });
    await expect(producer.accept({ ...input, access: { ...input.access, principal_ref: "other-owner" } })).rejects.toMatchObject({ code: "ARTIFACT_DRAFT_READ_DENIED" });

    const sqlFresh = await createArtifactPublicationFreshNavigation(fixture, prepared.access, prepared.evidence.handle.source_namespace_id);
    const sqlAuthorization = await sqlFresh.navigation.current();
    let currentAuthorityChecks = 0;
    let revokeOnPublicationBatch = false;
    let grantRevokedImmediatelyBeforeBatch = false;
    const revokeOwnerGrantAtBatch = new Proxy(fixture.db, {
      get(target, property) {
        if (property === "batch") {
          return async (statements: D1PreparedStatement[]) => {
            if (!revokeOnPublicationBatch) return target.batch(statements);
            if (grantRevokedImmediatelyBeforeBatch) throw new Error("publication unexpectedly batched twice");
            const revoked = await target.prepare(
              "UPDATE scope_access_grant SET state='REVOKED' WHERE authorization_receipt_ref=?1 AND state='ACTIVE' RETURNING snapshot_id",
            ).bind(sqlAuthorization.authorization_receipt_ref).all<{ readonly snapshot_id: string }>();
            if (!revoked.success || revoked.results.length < 1) {
              throw new Error(`test could not revoke a live D1 scope grant at the transaction fence: ${JSON.stringify(revoked.results)}`);
            }
            grantRevokedImmediatelyBeforeBatch = true;
            return target.batch(statements);
          };
        }
        const value = Reflect.get(target, property, target) as unknown;
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as D1Database;
    const sqlRevocationProducer = createArtifactPublicationProducer({
      database: revokeOwnerGrantAtBatch,
      work_bucket: fixture.bucket,
      require_current: async (scope) => {
        const current = await sqlFresh.require_current(scope);
        currentAuthorityChecks += 1;
        if (currentAuthorityChecks === 1) revokeOnPublicationBatch = true;
        return current;
      },
      resolve_acceptance_decision: async (request) => ({
        protocol: "eliotr.artifact-owner-acceptance.v1",
        mode: "OWNER_EXPLICIT",
        artifact_ref: request.artifact_ref,
        expected_draft_head_revision: request.expected_draft_head_revision,
        expected_publication_revision: request.expected_publication_revision,
        principal_ref: request.access.principal_ref,
        credential_generation: request.access.credential_generation,
        idempotency_key: "owner-acceptance-sql-revoked",
        decision_ref: `owner-commit-${fencedDraft.artifactRef.id}`,
        provenance_ref: `owner-route-${fencedDraft.artifactRef.id}`,
        expires_at: request.authorization.expires_at,
      }),
    });
    const sqlRevocationFailure = await sqlRevocationProducer.accept({
      artifact_ref: fencedDraft.artifactRef,
      expected_draft_head_revision: 1,
      expected_publication_revision: null,
      access: prepared.access,
      current_navigation: sqlFresh.navigation,
      current_authorization: sqlAuthorization,
      search_database: fixture.retrieve.search_database,
      evidence_bucket: fixture.retrieve.evidence_bucket,
      deployment_generation: prepared.access.deployment_generation,
      idempotency_key: "owner-acceptance-sql-revoked",
    }).then(() => null, (error: unknown) => error);
    expect(sqlRevocationFailure).toMatchObject({ code: "ARTIFACT_PUBLICATION_EFFECT_UNCERTAIN" });
    expect(errorCauseText(sqlRevocationFailure)).toContain("ARTIFACT_PUBLICATION_OWNER_GRANT_GUARD");
    expect(grantRevokedImmediatelyBeforeBatch).toBe(true);
    const sqlLoserRows = await fixture.db.prepare(
      "SELECT " +
      "(SELECT COUNT(*) FROM operation_intent WHERE principal_ref=?1 AND idempotency_key=?2) AS intents," +
      "(SELECT COUNT(*) FROM outbox o JOIN operation_intent i ON i.intent_id=o.intent_id AND i.revision=o.intent_revision WHERE i.principal_ref=?1 AND i.idempotency_key=?2) AS outboxes," +
      "(SELECT COUNT(*) FROM operation_receipt r JOIN operation_intent i ON i.intent_id=r.intent_id AND i.revision=r.intent_revision WHERE i.principal_ref=?1 AND i.idempotency_key=?2) AS operation_receipts," +
      "(SELECT COUNT(*) FROM artifact_publication_receipt WHERE principal_ref=?1 AND idempotency_key=?2) AS publication_receipts",
    ).bind(prepared.access.principal_ref, "owner-acceptance-sql-revoked").first<{
      readonly intents: number;
      readonly outboxes: number;
      readonly operation_receipts: number;
      readonly publication_receipts: number;
    }>();
    expect(sqlLoserRows).toEqual({ intents: 0, outboxes: 0, operation_receipts: 0, publication_receipts: 0 });

    await invalidateEvidenceHandle(prepared.fixture.db, prepared.evidence.handle, "REDACTED", "fixture-purge", new Date().toISOString());
    await expect(producer.read({
      artifact_ref: prepared.artifactRef,
      access: prepared.access,
      current_navigation: currentNavigation,
      current_authorization: await currentNavigation.current(),
      search_database: prepared.fixture.retrieve.search_database,
      evidence_bucket: prepared.fixture.retrieve.evidence_bucket,
      deployment_generation: prepared.access.deployment_generation,
    })).rejects.toMatchObject({ code: "ARTIFACT_DRAFT_READ_STALE" });

    const invalidationPort = createD1ErasureInvalidationPort({ database: fixture.db });
    const exactSourceRef = prepared.evidence.handle.source_revision_ref;
    const erasureInput = (erasureId: string): {
      readonly request: ErasureRequest;
      readonly fence: ErasureFence;
      readonly closure: ErasureDependencyClosure;
      readonly ledger_ref: string;
    } => {
      const erasureRef = { id: erasureId, revision: 1 };
      const subjectRef = `source-revision:${exactSourceRef}`;
      return {
        request: {
          protocol: "erc.privacy.erasure.v1",
          erasure_ref: erasureRef,
          requested_by_principal_ref: "fixture-privacy-officer",
          exact_subject_refs: [subjectRef],
          required_locations: ["CanonicalPayload"],
          legal_basis_ref: `fixture-legal-basis-${erasureId}`,
          admitted_at: new Date().toISOString(),
          deadline: new Date(Date.now() + 60_000).toISOString(),
        },
        fence: { erasure_id: erasureId, revision: 1, lease_owner: "fixture-erasure-worker", lease_generation: 1,
          lease_until_ms: Date.now() + 60_000 },
        closure: {
          erasure_ref: erasureRef,
          request_digest: "1".repeat(64),
          closure_digest: "2".repeat(64),
          targets: [{ target_id: `source-target-${erasureId}`, target_kind: "OBJECT", exact_subject_ref: subjectRef,
            location: "CanonicalPayload", canonical_ref: `d1-core:source-revision:${exactSourceRef}`,
            identity_digest: "3".repeat(64), shared_live_reference_count: 0 }],
        },
        ledger_ref: `fixture-purge-ledger-${erasureId}`,
      };
    };
    for (const [erasureId, disposition] of [["fixture-erasure-blocked", "BLOCKED"], ["fixture-erasure-complete", "COMPLETE"]] as const) {
      const erasure = erasureInput(erasureId);
      await fixture.db.prepare(
        "INSERT INTO purge_ledger(erasure_id,non_revealing_subject_digest,disposition,receipt_ref,created_at) " +
        "VALUES(?1,?2,?3,?4,?5)",
      ).bind(erasureId, await erasureDigest([...erasure.request.exact_subject_refs].sort()), disposition,
        erasure.ledger_ref, new Date().toISOString()).run();
      const invalidations = await invalidationPort.invalidate(erasure.request, erasure.fence, erasure.closure, erasure.ledger_ref);
      expect(invalidations).toContainEqual(expect.objectContaining({
        dependent_kind: "ArtifactRevision",
        dependent_ref: `artifact:${prepared.artifactRef.id}:${raceDraft.artifactRef.revision}`,
        disposition: disposition === "COMPLETE" ? "REDACTED" : "PENDING_REVALIDATION",
      }));
      const head = await fixture.db.prepare(
        "SELECT disposition FROM artifact_publication_head WHERE artifact_id=?1",
      ).bind(prepared.artifactRef.id).first<{ readonly disposition: string }>();
      expect(head?.disposition).toBe(disposition === "COMPLETE" ? "REDACTED_DEPENDENCY" : "PENDING_REVALIDATION");
    }
  }, 90_000);
});
