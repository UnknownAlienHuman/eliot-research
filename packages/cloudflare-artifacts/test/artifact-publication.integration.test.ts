import { applyD1Migrations, type D1Migration } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import type { ArtifactRevision, ArtifactSpec, ObjectResidencyKey, VersionedRef } from "@eliotr/contracts";
import { canonicalDigest, canonicalJson } from "@eliotr/platform-cloudflare";
import { invalidateEvidenceHandle } from "@eliotr/cloudflare-evidence";
import { createNavigationReadAuthority } from "@eliotr/cloudflare-evidence";
import { createD1ScopeService, createOwnerScopeAuthority } from "../../cloudflare-navigation/src/index.js";
import { createArtifactDraftStore, encodeArtifactDraftVerificationV2, createArtifactPublicationProducer, type PrepareArtifactDraftInput } from "../src/index.js";
import { committedEvidenceFreezeFixture, principal as freezePrincipal } from "../../../apps/eliotr-core/test/research-evidence-freeze-fixture.js";

interface TestEnv {
  readonly CORE_DB: D1Database;
  readonly WORK_BUCKET: R2Bucket;
  readonly CORE_MIGRATIONS: D1Migration[];
}

const runtime = env as unknown as TestEnv;
const sha = (value: string) => crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)).then((buffer) =>
  [...new Uint8Array(buffer)].map((byte) => byte.toString(16).padStart(2, "0")).join(""));

function errorCauseText(value: unknown): string {
  if (value === null || typeof value !== "object") return String(value);
  const root = value as { readonly message?: unknown; readonly cause?: unknown };
  const cause = root.cause !== null && typeof root.cause === "object" ? root.cause as { readonly message?: unknown; readonly cause?: unknown } : null;
  const nested = cause?.cause !== null && typeof cause?.cause === "object" ? cause.cause as { readonly message?: unknown } : null;
  return [root.message, cause?.message, nested?.message].map(String).join(" ");
}

async function residency(scopeId: string, principal: string, digest: string): Promise<ObjectResidencyKey> {
  return {
    scope_domain_id: scopeId,
    access_domain_id: principal,
    confidentiality_domain_id: "owner-private",
    encryption_key_domain_id: "publication-test-key",
    retention_domain_id: "publication-test-retention",
    erasure_domain_id: "publication-test-erasure",
    content_digest: { algorithm: "sha256", digest },
  };
}

async function prepareVerifiedDraft(fixture: Awaited<ReturnType<typeof committedEvidenceFreezeFixture>>) {
  const stageFive = await fixture.readers.read_stage_five({
    operation_id: fixture.operation_id,
    investigation_id: fixture.investigation_id,
    principal: freezePrincipal,
  });
  const evidence = stageFive.evidence_pack.resolved_evidence[0];
  if (evidence === undefined) throw new Error("freeze fixture has no resolved evidence");
  const access = { ...freezePrincipal, client_class: "owner_pwa" as const };
  const authorization = await fixture.navigation.current();
  const artifactRef = { id: `publication-${crypto.randomUUID()}`, revision: 1 } satisfies VersionedRef;
  const dependencyRef = { id: `dependency-${crypto.randomUUID()}`, revision: 1 } satisfies VersionedRef;
  const freezeRef = { id: `freeze-${crypto.randomUUID()}`, revision: 1 } satisfies VersionedRef;
  const sectionRef = { id: `section-${crypto.randomUUID()}`, revision: 1 } satisfies VersionedRef;
  const claimRef = { id: `claim-${crypto.randomUUID()}`, revision: 1 } satisfies VersionedRef;
  const body = evidence.exact_excerpt;
  const bodyBytes = new TextEncoder().encode(body);
  const bodySha = await sha(body);
  const outputSha = "d".repeat(64);
  const claimText = "The cited source supports the stated observation.";
  const claimTextSha = await sha(claimText);
  const manifestDigest = "c".repeat(64);
  const allowedManifest = {
    manifest_ref: dependencyRef,
    scope_snapshot_ref: { id: fixture.scope.snapshot_id, revision: fixture.scope.revision },
    allowed_source_revision_refs: [evidence.handle.source_revision_ref],
    allowed_evidence_handle_refs: [evidence.handle.handle_ref],
    allowed_tool_definition_refs: [],
    allowed_verifier_refs: ["fixture-verifier-v1"],
    permitted_anchor_and_precision_ceilings: ["normalized-text-coordinates-v1"],
    provider_and_policy_generations: { policy: "publication-test-policy-v1" },
    stale_or_revoked_entries: [],
    permitted_acquisition_or_expansion_routes: [],
    disclosure_ceiling: "owner-only",
    allowed_use: ["research"],
    expires_at: fixture.scope.expires_at,
    manifest_digest: manifestDigest,
  };
  const dependencyBytes = new TextEncoder().encode(canonicalJson(allowedManifest));
  const draftSection = {
    section_ref: sectionRef,
    contract_id: "findings",
    body_object_ref: `body-${sectionRef.id}`,
    body_sha256: bodySha,
    statement_labels: { [claimRef.id]: "SOURCE_SUPPORTED" as const },
    evidence_ledger_ref: `ledger-${sectionRef.id}`,
    verification_receipt_ref: `verification-pending-${sectionRef.id}`,
  };
  const spec: ArtifactSpec = {
    spec_ref: { id: `spec-${artifactRef.id}`, revision: 1 },
    kind: "research_report",
    title: "Publication integration report",
    scope_snapshot_ref: { id: fixture.scope.snapshot_id, revision: fixture.scope.revision },
    inquiry_protocol_ref: { id: "publication-test-protocol", revision: 1 },
    audience: "researchers",
    language: "en",
    citation_policy_ref: "publication-citation-policy-v1",
    verification_policy_ref: "publication-verification-policy-v1",
    include_counterevidence: false,
    include_methodology: false,
    length_policy_ref: "publication-length-policy-v1",
    export_formats: ["markdown"],
    budget_ref: "publication-test-budget",
    section_contracts: [{ section_id: "findings", title: "Findings", purpose: "State a supported observation",
      required_claim_kinds: ["observation"], required_evidence_classes: ["source"], maximum_utf8_bytes: 32768 }],
  };
  const verification = await encodeArtifactDraftVerificationV2({
    schema: "eliotr.research.draft-verification.v2",
    semantic_verification: "EXECUTED",
    source_readback: "AUTHORITATIVE_RESOLVED",
    operation_id: `publication-operation-${artifactRef.id}`,
    investigation_ref: { id: "publication-investigation", revision: 1 },
    output_sha256: outputSha,
    freeze_ref: freezeRef,
    freeze_sha256: "a".repeat(64),
    manifest_ref: dependencyRef,
    manifest_sha256: manifestDigest,
    evidence_pack_ref: { id: "publication-evidence-pack", revision: 1 },
    trace_ref: { id: "publication-trace", revision: 1 },
    cited_evidence: [{
      handle_ref: evidence.handle.handle_ref,
      excerpt_sha256: evidence.handle.excerpt_sha256,
      source_revision_content_sha256: "b".repeat(64),
      scope_snapshot_digest: fixture.scope.digest,
      authorization_receipt_ref: authorization.authorization_receipt_ref,
      credential_generation: access.credential_generation,
    }],
    section_sha256: bodySha,
    audit: {
      stage_attempt_ref: `audit-attempt-${artifactRef.id}`,
      stage_request_sha256: "e".repeat(64),
      output_sha256: "f".repeat(64),
      synthesis_output_sha256: outputSha,
      normalization_binding_sha256: "1".repeat(64),
      verifier_ref: "fixture-verifier-v1",
      verifier_schema_generation: "fixture-verifier-schema-v1",
      model_receipt_ref: "fixture-model-receipt-v1",
      claims: [{ claim_ref: claimRef, claim_text: claimText, claim_text_digest: claimTextSha,
        disposition: "SUPPORTED", support_handle_refs: [evidence.handle.handle_ref], counterevidence_handle_refs: [] }],
    },
  });
  const section = { ...draftSection, verification_receipt_ref: verification.verification_receipt_ref };
  const createdAt = new Date().toISOString();
  const revision: ArtifactRevision = {
    artifact_ref: artifactRef,
    spec_ref: spec.spec_ref,
    spec_digest: await canonicalDigest(spec),
    evidence_freeze_ref: freezeRef,
    sections: [section],
    dependency_manifest_ref: `${dependencyRef.id}:${dependencyRef.revision}`,
    deterministic_export_refs: { markdown: `export-${artifactRef.id}` },
    status: "DRAFT",
    created_at: createdAt,
  };
  const manifestBytes = new TextEncoder().encode(canonicalJson({ spec, revision }));
  const draftStore = createArtifactDraftStore(fixture.db, fixture.bucket);
  const markdownExportRef = revision.deterministic_export_refs.markdown;
  if (markdownExportRef === undefined) throw new Error("verified publication fixture is missing its markdown export");
  const draftInput: PrepareArtifactDraftInput = {
    intent: {
      intent_ref: { id: `draft-intent-${artifactRef.id}`, revision: 1 },
      operation_kind: "REPORT",
      principal_ref: access.principal_ref,
      idempotency_key: `draft-${artifactRef.id}`,
      payload_ref: artifactRef.id,
      policy_decision_ref: "publication-test-draft-authority",
      created_at: createdAt,
    },
    expected_draft_head_revision: null,
    spec,
    revision,
    sections: [{ section, bytes: bodyBytes, residency: await residency(fixture.scope.snapshot_id, access.principal_ref, bodySha) }],
    referenced_objects: [
      { object_ref: revision.dependency_manifest_ref, object_kind: "DEPENDENCY_MANIFEST", bytes: dependencyBytes,
        residency: await residency(fixture.scope.snapshot_id, access.principal_ref, await sha(new TextDecoder().decode(dependencyBytes))) },
      { object_ref: section.evidence_ledger_ref, object_kind: "EVIDENCE_LEDGER", bytes: new TextEncoder().encode("owner evidence ledger"),
        residency: await residency(fixture.scope.snapshot_id, access.principal_ref, await sha("owner evidence ledger")) },
      { object_ref: section.verification_receipt_ref, object_kind: "VERIFICATION_RECEIPT", bytes: verification.bytes,
        residency: await residency(fixture.scope.snapshot_id, access.principal_ref, verification.sha256) },
      { object_ref: markdownExportRef, object_kind: "EXPORT", bytes: bodyBytes,
        residency: await residency(fixture.scope.snapshot_id, access.principal_ref, bodySha) },
    ],
    manifest_residency: await residency(fixture.scope.snapshot_id, access.principal_ref, await sha(new TextDecoder().decode(manifestBytes))),
  };
  await draftStore.prepare(draftInput);
  return { fixture, access, authorization, artifactRef, revision, evidence, draftInput };
}

async function prepareNextDraftRevision(prepared: Awaited<ReturnType<typeof prepareVerifiedDraft>>) {
  const ref = { id: prepared.artifactRef.id, revision: prepared.artifactRef.revision + 1 } satisfies VersionedRef;
  const createdAt = new Date().toISOString();
  const revision: ArtifactRevision = {
    ...prepared.draftInput.revision,
    artifact_ref: ref,
    sections: prepared.draftInput.revision.sections.map((section) => ({
      ...section,
      section_ref: { id: section.section_ref.id, revision: section.section_ref.revision + 1 },
      reused_from_revision_ref: prepared.artifactRef,
    })),
    created_at: createdAt,
  };
  const manifestBytes = new TextEncoder().encode(canonicalJson({ spec: prepared.draftInput.spec, revision }));
  const draftInput: PrepareArtifactDraftInput = {
    ...prepared.draftInput,
    intent: {
      intent_ref: { id: `draft-intent-${ref.id}-r${ref.revision}`, revision: 1 },
      operation_kind: "REPORT",
      principal_ref: prepared.access.principal_ref,
      idempotency_key: `draft-${ref.id}-r${ref.revision}`,
      payload_ref: ref.id,
      policy_decision_ref: "publication-test-draft-authority",
      created_at: createdAt,
    },
    expected_draft_head_revision: prepared.artifactRef.revision,
    revision,
    sections: revision.sections.map((section, index) => {
      const original = prepared.draftInput.sections[index];
      if (original === undefined) throw new Error("COW predecessor section is missing");
      return { ...original, section };
    }),
    manifest_residency: await residency(prepared.fixture.scope.snapshot_id, prepared.access.principal_ref,
      await sha(new TextDecoder().decode(manifestBytes))),
  };
  await createArtifactDraftStore(prepared.fixture.db, prepared.fixture.bucket).prepare(draftInput);
  return { ...prepared, artifactRef: ref, revision, draftInput };
}

async function freshNavigation(
  fixture: Awaited<ReturnType<typeof committedEvidenceFreezeFixture>>,
  access: { readonly principal_ref: string; readonly client_class: "owner_pwa"; readonly credential_generation: string },
  sourceNamespaceId: string,
  nowMs = Date.now(),
) {
  const source = await fixture.db.prepare("SELECT source_id FROM source WHERE source_namespace_id=?1 LIMIT 1")
    .bind(sourceNamespaceId).first<{ readonly source_id: string }>();
  if (source === null) throw new Error("freeze source disappeared");
  const owner = createOwnerScopeAuthority(fixture.db, access, () => nowMs);
  const scopes = createD1ScopeService(fixture.db, owner, { now: () => nowMs, ttl_ms: 3_600_000 });
  const scope = await scopes.freeze({ kind: "SELECTED_SOURCES", source_ids: [source.source_id] }, access.credential_generation);
  await owner.grant(scope);
  const navigation = createNavigationReadAuthority({ database: fixture.db, scope_snapshot: scope, access,
    require_current: (requested) => scopes.requireCurrent(requested), now: () => nowMs });
  return { navigation, require_current: (requested: Parameters<typeof scopes.requireCurrent>[0]) => scopes.requireCurrent(requested) };
}

describe("artifact publication with actual D1 and R2", () => {
  beforeAll(async () => applyD1Migrations(runtime.CORE_DB, runtime.CORE_MIGRATIONS));

  it("persists owner ACCEPTED, replays across fresh evidence reads, and rejects stale authority", async () => {
    const fixture = await committedEvidenceFreezeFixture();
    const prepared = await prepareVerifiedDraft(fixture);
    const refreshed = await freshNavigation(fixture, prepared.access, prepared.evidence.handle.source_namespace_id);
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
      deployment_generation: freezePrincipal.deployment_generation,
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
      deployment_generation: freezePrincipal.deployment_generation,
    });
    expect(readback?.receipt.publication_ref).toBe(accepted.receipt.publication_ref);
    expect(readback?.revision.status).toBe("ACCEPTED");
    const replay = await producer.accept({ ...input, current_authorization: await currentNavigation.current() });
    expect(replay.disposition).toBe("EXISTING");
    expect(replay.receipt.publication_ref).toBe(accepted.receipt.publication_ref);
    expect(decisionCalls).toBe(1);

    const raceKeys = ["publication-race-alpha", "publication-race-beta"] as const;
    const raceDraft = await prepareNextDraftRevision(prepared);
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

    const fencedDraft = await prepareVerifiedDraft(fixture);
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
      deployment_generation: freezePrincipal.deployment_generation,
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

    const sqlFresh = await freshNavigation(fixture, prepared.access, prepared.evidence.handle.source_namespace_id);
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
      deployment_generation: freezePrincipal.deployment_generation,
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
      deployment_generation: freezePrincipal.deployment_generation,
    })).rejects.toMatchObject({ code: "ARTIFACT_DRAFT_READ_STALE" });
  }, 90_000);
});
