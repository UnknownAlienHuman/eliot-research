import type { ArtifactDraftReadError } from "@eliotr/cloudflare-research";
import { readArtifactDraft } from "@eliotr/cloudflare-research";
import { beforeAll, describe, expect, it } from "vitest";
import { handleHttp } from "../src/http.js";
import {
  createArtifactDraftRuntime,
  draftInput,
  initializeArtifactDraftRuntime,
  readableOwnerArtifactDraft,
  readableArtifactDraft,
  runtime,
  type ArtifactDraftReadFixture,
} from "./artifact-draft-fixture.js";

async function count(table: string, artifactId: string): Promise<number> {
  const row = await runtime.CORE_DB.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE artifact_id=?1`)
    .bind(artifactId).first<{ readonly count: number }>();
  return row?.count ?? 0;
}

async function authorityCounts(artifactId: string): Promise<readonly number[]> {
  return [
    await count("artifact_revision", artifactId),
    await count("artifact_draft_head", artifactId),
    await count("artifact_draft_binding", artifactId),
    await count("artifact_draft_object", artifactId),
  ];
}

async function draftHead(artifactId: string): Promise<Record<string, unknown> | null> {
  return runtime.CORE_DB.prepare(
    "SELECT artifact_id,head_revision,manifest_r2_key,intent_id,intent_revision,updated_at FROM artifact_draft_head WHERE artifact_id=?1 LIMIT 1",
  ).bind(artifactId).first<Record<string, unknown>>();
}

async function publishedHead(artifactId: string): Promise<Record<string, unknown> | null> {
  return runtime.CORE_DB.prepare(
    "SELECT artifact_id,head_revision,manifest_r2_key,updated_at FROM artifact_head WHERE artifact_id=?1 LIMIT 1",
  ).bind(artifactId).first<Record<string, unknown>>();
}

function expectReadCode(value: Promise<unknown>, code: ArtifactDraftReadError["code"]): Promise<void> {
  return expect(value).rejects.toMatchObject({ code });
}

async function seed(fixture: ArtifactDraftReadFixture): Promise<void> {
  const result = await createArtifactDraftRuntime().prepare(fixture.input);
  expect(result.disposition).toBe("CREATED");
}

async function read(
  fixture: ArtifactDraftReadFixture,
  overrides: Partial<ArtifactDraftReadFixture> = {},
  workBucket: R2Bucket = runtime.WORK_BUCKET,
) {
  const current = { ...fixture, ...overrides };
  return readArtifactDraft({
    database: runtime.CORE_DB,
    work_bucket: workBucket,
    artifact_ref: fixture.input.revision.artifact_ref,
    access: current.access,
    require_current: current.requireCurrent,
    now: current.now,
  });
}

describe("actual D1/R2 artifact draft reader", () => {
  beforeAll(initializeArtifactDraftRuntime);

  it("reads a historical DRAFT after a later immutable revision", async () => {
    const fixture = await readableArtifactDraft(`reader-history-${crypto.randomUUID()}`);
    await seed(fixture);
    const later = await draftInput(`reader-later-${crypto.randomUUID()}`, {
      artifact_id: fixture.input.revision.artifact_ref.id,
      artifact_revision: 2,
      expected_head_revision: 1,
    });
    await createArtifactDraftRuntime().prepare(later);
    const before = await draftHead(fixture.input.revision.artifact_ref.id);
    await expect(read(fixture)).resolves.toEqual(fixture.input.revision);
    expect(await draftHead(fixture.input.revision.artifact_ref.id)).toEqual(before);
  });

  it("denies foreign principals, service clients, and missing exact grants without changing heads", async () => {
    const fixture = await readableArtifactDraft(`reader-deny-${crypto.randomUUID()}`);
    await seed(fixture);
    const before = await authorityCounts(fixture.input.revision.artifact_ref.id);
    await expectReadCode(read(fixture, { access: { ...fixture.access, principal_ref: "foreign-reader" } }), "ARTIFACT_DRAFT_READ_DENIED");
    await expectReadCode(read(fixture, { access: { ...fixture.access, client_class: "named_api_client" } }), "ARTIFACT_DRAFT_READ_DENIED");
    await expectReadCode(read(fixture, { access: { ...fixture.access, credential_generation: "revoked-credential" } }), "ARTIFACT_DRAFT_READ_DENIED");
    expect(await authorityCounts(fixture.input.revision.artifact_ref.id)).toEqual(before);
  });

  it("rejects expired, revoked, and invalidated scope authority", async () => {
    const expired = await readableArtifactDraft(`reader-expired-${crypto.randomUUID()}`);
    await seed(expired);
    await expectReadCode(read(expired, { now: () => Date.parse(expired.scope.expires_at) + 1 }), "ARTIFACT_DRAFT_READ_STALE");

    const revoked = await readableArtifactDraft(`reader-revoked-${crypto.randomUUID()}`);
    await seed(revoked);
    await runtime.CORE_DB.prepare("UPDATE scope_access_grant SET state='REVOKED' WHERE snapshot_id=?1 AND snapshot_revision=?2")
      .bind(revoked.scope.snapshot_id, revoked.scope.revision).run();
    await expectReadCode(read(revoked), "ARTIFACT_DRAFT_READ_DENIED");

    const invalidated = await readableArtifactDraft(`reader-invalidated-${crypto.randomUUID()}`);
    await seed(invalidated);
    await runtime.CORE_DB.prepare("UPDATE scope_snapshot SET invalidated_at=?1, invalidation_reason=?2 WHERE snapshot_id=?3 AND revision=?4")
      .bind("2026-09-10T12:01:00.000Z", "reader-revoked", invalidated.scope.snapshot_id, invalidated.scope.revision).run();
    await expectReadCode(read(invalidated), "ARTIFACT_DRAFT_READ_STALE");
  });

  it("detects missing or corrupt R2/manifest evidence without mutating durable heads", async () => {
    const missing = await readableArtifactDraft(`reader-missing-${crypto.randomUUID()}`);
    const missingResult = await createArtifactDraftRuntime().prepare(missing.input);
    const beforeMissing = await authorityCounts(missing.input.revision.artifact_ref.id);
    await runtime.CORE_DB.prepare("DELETE FROM artifact_draft_object WHERE artifact_id=?1 AND revision=?2 AND object_kind='MANIFEST'")
      .bind(missing.input.revision.artifact_ref.id, missing.input.revision.artifact_ref.revision).run();
    await expectReadCode(read(missing), "ARTIFACT_DRAFT_READ_INTEGRITY");
    expect(await authorityCounts(missing.input.revision.artifact_ref.id)).toEqual([
      beforeMissing[0], beforeMissing[1], beforeMissing[2], (beforeMissing[3] ?? 0) - 1,
    ]);
    expect(await runtime.WORK_BUCKET.head(missingResult.manifest.receipt.key)).not.toBeNull();

    const corrupt = await readableArtifactDraft(`reader-corrupt-${crypto.randomUUID()}`);
    const corruptResult = await createArtifactDraftRuntime().prepare(corrupt.input);
    const beforeCorrupt = await authorityCounts(corrupt.input.revision.artifact_ref.id);
    await runtime.WORK_BUCKET.put(corruptResult.manifest.receipt.key, new TextEncoder().encode("{\"corrupt\":true}"));
    await expectReadCode(read(corrupt), "ARTIFACT_DRAFT_READ_INTEGRITY");
    expect(await authorityCounts(corrupt.input.revision.artifact_ref.id)).toEqual(beforeCorrupt);
  });

  it("rejects malformed refs and returns null for an absent valid revision", async () => {
    const fixture = await readableArtifactDraft(`reader-ref-${crypto.randomUUID()}`);
    await seed(fixture);
    await expectReadCode(readArtifactDraft({
      database: runtime.CORE_DB, work_bucket: runtime.WORK_BUCKET,
      artifact_ref: { id: "valid-ref", revision: 0 }, access: fixture.access,
      require_current: fixture.requireCurrent, now: fixture.now,
    }), "ARTIFACT_DRAFT_READ_INVALID");
    await expect(readArtifactDraft({
      database: runtime.CORE_DB, work_bucket: runtime.WORK_BUCKET,
      artifact_ref: { id: `absent-${crypto.randomUUID()}`, revision: 1 }, access: fixture.access,
      require_current: fixture.requireCurrent, now: fixture.now,
    })).resolves.toBeNull();
  });

  it("keeps exact draft and published heads unchanged while reading a draft", async () => {
    const tag = `reader-head-${crypto.randomUUID()}`;
    const fixture = await readableArtifactDraft(tag);
    const artifactId = `published-${tag}`;
    const published = await draftInput(`${tag}-published`, { artifact_id: artifactId, artifact_revision: 1 });
    const publishedManifestKey = `${artifactId}/published-manifest`;
    await runtime.CORE_DB.batch([
      runtime.CORE_DB.prepare("INSERT INTO artifact_revision(artifact_id,revision,kind,spec_digest,evidence_freeze_id,evidence_freeze_revision,manifest_r2_key,dependency_manifest_ref,status,created_at) VALUES (?1,1,?2,?3,?4,1,?5,?6,'PUBLISHED',?7)").bind(artifactId, published.spec.kind, published.revision.spec_digest, published.revision.evidence_freeze_ref.id, publishedManifestKey, published.revision.dependency_manifest_ref, published.revision.created_at),
      runtime.CORE_DB.prepare("INSERT INTO artifact_head(artifact_id,head_revision,manifest_r2_key,updated_at) VALUES (?1,1,?2,?3)").bind(artifactId, publishedManifestKey, published.revision.created_at),
    ]);
    const draftFixture: ArtifactDraftReadFixture = {
      ...fixture,
      input: await draftInput(tag, { artifact_id: artifactId, artifact_revision: 2, scope_snapshot_id: fixture.scope.snapshot_id }),
    };
    await seed(draftFixture);
    const beforeDraft = await draftHead(artifactId);
    const beforePublished = await publishedHead(artifactId);
    await expect(read(draftFixture)).resolves.toEqual(draftFixture.input.revision);
    expect(await draftHead(artifactId)).toEqual(beforeDraft);
    expect(await publishedHead(artifactId)).toEqual(beforePublished);
  });

  it("does not read R2 before rejecting a foreign principal, and rechecks revocation after the first R2 read", async () => {
    const denied = await readableArtifactDraft(`reader-no-r2-${crypto.randomUUID()}`);
    await seed(denied);
    let deniedGets = 0;
    const deniedBucket = Object.create(runtime.WORK_BUCKET) as R2Bucket;
    deniedBucket.get = async (...args: Parameters<R2Bucket["get"]>) => {
      deniedGets += 1;
      return runtime.WORK_BUCKET.get(...args);
    };
    deniedBucket.head = runtime.WORK_BUCKET.head.bind(runtime.WORK_BUCKET);
    await expectReadCode(read(denied, { access: { ...denied.access, principal_ref: "foreign-before-r2" } }, deniedBucket), "ARTIFACT_DRAFT_READ_DENIED");
    expect(deniedGets).toBe(0);

    const revoked = await readableArtifactDraft(`reader-race-${crypto.randomUUID()}`);
    await seed(revoked);
    let gets = 0;
    const revokingBucket = Object.create(runtime.WORK_BUCKET) as R2Bucket;
    revokingBucket.get = async (...args: Parameters<R2Bucket["get"]>) => {
      const result = await runtime.WORK_BUCKET.get(...args);
      gets += 1;
      if (gets === 1) {
        await runtime.CORE_DB.prepare("UPDATE scope_access_grant SET state='REVOKED' WHERE snapshot_id=?1 AND snapshot_revision=?2")
          .bind(revoked.scope.snapshot_id, revoked.scope.revision).run();
      }
      return result;
    };
    revokingBucket.head = runtime.WORK_BUCKET.head.bind(runtime.WORK_BUCKET);
    await expectReadCode(read(revoked, {}, revokingBucket), "ARTIFACT_DRAFT_READ_DENIED");
    expect(gets).toBeGreaterThan(0);
  });

  it("rejects a missing non-manifest object after durable readback", async () => {
    const fixture = await readableArtifactDraft(`reader-object-missing-${crypto.randomUUID()}`);
    const result = await createArtifactDraftRuntime().prepare(fixture.input);
    const object = result.objects.find((candidate) => candidate.object_kind === "SECTION_BODY");
    if (object === undefined) throw new Error("fixture section receipt is missing");
    const before = await draftHead(fixture.input.revision.artifact_ref.id);
    await runtime.WORK_BUCKET.delete(object.receipt.key);
    await expectReadCode(read(fixture), "ARTIFACT_DRAFT_READ_INTEGRITY");
    expect(await draftHead(fixture.input.revision.artifact_ref.id)).toEqual(before);
  });

  it("serves an owner draft through the real HTTP router with fixture-backed currentness", async () => {
    const fixture = await readableOwnerArtifactDraft(`reader-http-${crypto.randomUUID()}`);
    await seed(fixture);
    const response = await handleHttp(
      new Request(`https://research.example/api/v1/research/artifact/${fixture.input.revision.artifact_ref.id}:${fixture.input.revision.artifact_ref.revision}`),
      runtime,
      {} as ExecutionContext,
      {
        accessVerifier: { async verify() {
          return {
            principal_ref: fixture.access.principal_ref,
            credential_generation: fixture.access.credential_generation,
            authentication_method: "cloudflare_access" as const,
            expires_at: new Date(Date.now() + 3_600_000).toISOString(),
          };
        } },
      },
    );
    expect(response.status).toBe(200);
    const envelope = await response.json() as { readonly data: unknown };
    expect(envelope.data).toEqual(fixture.input.revision);

    const absent = await handleHttp(
      new Request("https://research.example/api/v1/research/artifact/reader-absent:1"),
      runtime,
      {} as ExecutionContext,
      { accessVerifier: { async verify() {
        return { ...fixture.access, authentication_method: "cloudflare_access" as const,
          expires_at: new Date(Date.now() + 3_600_000).toISOString() };
      } } },
    );
    expect(absent.status).toBe(404);
    expect((await absent.json() as { readonly code: string }).code).toBe("ARTIFACT_DRAFT_READ_NOT_FOUND");

    const invalid = await handleHttp(
      new Request(`https://research.example/api/v1/research/artifact/${fixture.input.revision.artifact_ref.id}:0`),
      runtime,
      {} as ExecutionContext,
      { accessVerifier: { async verify() {
        return { ...fixture.access, authentication_method: "cloudflare_access" as const,
          expires_at: new Date(Date.now() + 3_600_000).toISOString() };
      } } },
    );
    expect(invalid.status).toBe(400);
    expect((await invalid.json() as { readonly code: string }).code).toBe("ARTIFACT_REF_INVALID");

    const service = await handleHttp(
      new Request(`https://research.example/api/v1/research/artifact/${fixture.input.revision.artifact_ref.id}:${fixture.input.revision.artifact_ref.revision}`),
      runtime,
      {} as ExecutionContext,
      { accessVerifier: { async verify() {
        return { ...fixture.access, authentication_method: "service_token" as const,
          expires_at: new Date(Date.now() + 3_600_000).toISOString() };
      } } },
    );
    expect(service.status).toBe(403);
  });
});
