import type { ArtifactDraftReadError } from "@eliotr/cloudflare-research";
import { readArtifactDraft } from "@eliotr/cloudflare-research";
import { beforeAll, describe, expect, it } from "vitest";
import {
  createArtifactDraftRuntime,
  draftInput,
  initializeArtifactDraftRuntime,
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

function expectReadCode(value: Promise<unknown>, code: ArtifactDraftReadError["code"]): Promise<void> {
  return expect(value).rejects.toMatchObject({ code });
}

async function seed(fixture: ArtifactDraftReadFixture): Promise<void> {
  const result = await createArtifactDraftRuntime().prepare(fixture.input);
  expect(result.disposition).toBe("CREATED");
}

async function read(fixture: ArtifactDraftReadFixture, overrides: Partial<ArtifactDraftReadFixture> = {}) {
  const current = { ...fixture, ...overrides };
  return readArtifactDraft({
    database: runtime.CORE_DB,
    work_bucket: runtime.WORK_BUCKET,
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
    await expect(read(fixture)).resolves.toEqual(fixture.input.revision);
  });

  it("denies foreign principals, service clients, and missing exact grants without changing heads", async () => {
    const fixture = await readableArtifactDraft(`reader-deny-${crypto.randomUUID()}`);
    await seed(fixture);
    const before = await authorityCounts(fixture.input.revision.artifact_ref.id);
    await expectReadCode(read(fixture, { access: { ...fixture.access, principal_ref: "foreign-reader" } }), "ARTIFACT_ACCESS_DENIED");
    await expectReadCode(read(fixture, { access: { ...fixture.access, client_class: "named_api_client" } }), "ARTIFACT_ACCESS_DENIED");
    await expectReadCode(read(fixture, { access: { ...fixture.access, credential_generation: "revoked-credential" } }), "ARTIFACT_ACCESS_DENIED");
    expect(await authorityCounts(fixture.input.revision.artifact_ref.id)).toEqual(before);
  });

  it("rejects expired, revoked, and invalidated scope authority", async () => {
    const expired = await readableArtifactDraft(`reader-expired-${crypto.randomUUID()}`);
    await seed(expired);
    await expectReadCode(read(expired, { now: () => Date.parse(expired.scope.expires_at) + 1 }), "ARTIFACT_SCOPE_STALE");

    const revoked = await readableArtifactDraft(`reader-revoked-${crypto.randomUUID()}`);
    await seed(revoked);
    await runtime.CORE_DB.prepare("UPDATE scope_access_grant SET state='REVOKED' WHERE snapshot_id=?1 AND snapshot_revision=?2")
      .bind(revoked.scope.snapshot_id, revoked.scope.revision).run();
    await expectReadCode(read(revoked), "ARTIFACT_ACCESS_DENIED");

    const invalidated = await readableArtifactDraft(`reader-invalidated-${crypto.randomUUID()}`);
    await seed(invalidated);
    await runtime.CORE_DB.prepare("UPDATE scope_snapshot SET invalidated_at=?1, invalidation_reason=?2 WHERE snapshot_id=?3 AND revision=?4")
      .bind("2026-09-10T12:01:00.000Z", "reader-revoked", invalidated.scope.snapshot_id, invalidated.scope.revision).run();
    await expectReadCode(read(invalidated), "ARTIFACT_SCOPE_STALE");
  });

  it("detects missing or corrupt R2/manifest evidence without mutating durable heads", async () => {
    const missing = await readableArtifactDraft(`reader-missing-${crypto.randomUUID()}`);
    const missingResult = await createArtifactDraftRuntime().prepare(missing.input);
    const beforeMissing = await authorityCounts(missing.input.revision.artifact_ref.id);
    await runtime.CORE_DB.prepare("DELETE FROM artifact_draft_object WHERE artifact_id=?1 AND revision=?2 AND object_kind='MANIFEST'")
      .bind(missing.input.revision.artifact_ref.id, missing.input.revision.artifact_ref.revision).run();
    await expectReadCode(read(missing), "ARTIFACT_INTEGRITY_INVALID");
    expect(await authorityCounts(missing.input.revision.artifact_ref.id)).toEqual([
      beforeMissing[0], beforeMissing[1], beforeMissing[2], (beforeMissing[3] ?? 0) - 1,
    ]);
    expect(await runtime.WORK_BUCKET.head(missingResult.manifest.receipt.key)).not.toBeNull();

    const corrupt = await readableArtifactDraft(`reader-corrupt-${crypto.randomUUID()}`);
    const corruptResult = await createArtifactDraftRuntime().prepare(corrupt.input);
    const beforeCorrupt = await authorityCounts(corrupt.input.revision.artifact_ref.id);
    await runtime.WORK_BUCKET.put(corruptResult.manifest.receipt.key, new TextEncoder().encode("{\"corrupt\":true}"));
    await expectReadCode(read(corrupt), "ARTIFACT_INTEGRITY_INVALID");
    expect(await authorityCounts(corrupt.input.revision.artifact_ref.id)).toEqual(beforeCorrupt);
  });

  it("rejects malformed refs and returns null for an absent valid revision", async () => {
    const fixture = await readableArtifactDraft(`reader-ref-${crypto.randomUUID()}`);
    await seed(fixture);
    await expectReadCode(readArtifactDraft({
      database: runtime.CORE_DB, work_bucket: runtime.WORK_BUCKET,
      artifact_ref: { id: "valid-ref", revision: 0 }, access: fixture.access,
      require_current: fixture.requireCurrent, now: fixture.now,
    }), "ARTIFACT_REF_INVALID");
    await expect(readArtifactDraft({
      database: runtime.CORE_DB, work_bucket: runtime.WORK_BUCKET,
      artifact_ref: { id: `absent-${crypto.randomUUID()}`, revision: 1 }, access: fixture.access,
      require_current: fixture.requireCurrent, now: fixture.now,
    })).resolves.toBeNull();
  });
});
