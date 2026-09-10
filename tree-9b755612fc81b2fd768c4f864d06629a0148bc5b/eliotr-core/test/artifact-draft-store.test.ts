import type {
  ArtifactDraftError,
  PrepareArtifactDraftResult,
} from "@eliotr/cloudflare-research";
import { beforeAll, describe, expect, it } from "vitest";
import {
  createArtifactDraftRuntime,
  countResidencyPuts,
  draftInput,
  failResidencyPut,
  finalBatchFailure,
  initializeArtifactDraftRuntime,
  runtime,
} from "./artifact-draft-fixture.js";

async function count(table: string, where = "", values: readonly unknown[] = []): Promise<number> {
  const row = await runtime.CORE_DB.prepare(`SELECT COUNT(*) AS count FROM ${table}${where}`)
    .bind(...values).first<{ readonly count: number }>();
  return row?.count ?? 0;
}

async function digest(bytes: Uint8Array): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", new Uint8Array(bytes));
  return [...new Uint8Array(hash)].map((value) => value.toString(16).padStart(2, "0")).join("");
}

async function snapshot(artifactId: string, intentId: string): Promise<Record<string, number>> {
  return {
    revisions: await count("artifact_revision", " WHERE artifact_id=?1", [artifactId]),
    heads: await count("artifact_draft_head", " WHERE artifact_id=?1", [artifactId]),
    bindings: await count("artifact_draft_binding", " WHERE artifact_id=?1", [artifactId]),
    objects: await count("artifact_draft_object", " WHERE artifact_id=?1", [artifactId]),
    intents: await count("operation_intent", " WHERE intent_id=?1", [intentId]),
    outbox: await count("outbox", " WHERE intent_id=?1", [intentId]),
  };
}

async function storedObjectBytes(key: string): Promise<Uint8Array> {
  const object = await runtime.WORK_BUCKET.get(key);
  expect(object).not.toBeNull();
  return object === null ? new Uint8Array() : new Uint8Array(await object.arrayBuffer());
}

function expectDraftCode(value: Promise<unknown>, code: ArtifactDraftError["code"]): Promise<void> {
  return expect(value).rejects.toMatchObject({ code });
}

function unique(label: string): string {
  return `${label}-${crypto.randomUUID()}`;
}

describe("actual D1/R2 artifact draft storage", () => {
  beforeAll(initializeArtifactDraftRuntime);

  it("writes exact manifest/section/reference bytes and replays without extra effects", async () => {
    const input = await draftInput(unique("complete"));
    const store = createArtifactDraftRuntime();
    const first = await store.prepare(input);
    expect(first).toMatchObject({ disposition: "CREATED", artifact_ref: input.revision.artifact_ref,
      intent_ref: input.intent.intent_ref, draft_head_revision: 1 });
    expect(first.objects).toHaveLength(5);
    const section = input.sections[0];
    if (section === undefined) throw new Error("fixture section is missing");
    const sectionObject = first.objects.find((object) => object.object_kind === "SECTION_BODY");
    expect(sectionObject).toBeDefined();
    expect(sectionObject?.section_ordinal).toBe(0);
    expect(await storedObjectBytes(sectionObject?.receipt.key ?? "")).toEqual(section.bytes);
    for (const object of [first.manifest, ...first.objects]) {
      const actual = await storedObjectBytes(object.receipt.key);
      expect(actual.byteLength).toBe(object.receipt.size_bytes);
      expect(await digest(actual)).toBe(object.receipt.expected_sha256);
      expect(object.receipt.readback_sha256).toBe(object.receipt.expected_sha256);
    }
    expect(await count("artifact_revision", " WHERE artifact_id=?1", [input.revision.artifact_ref.id])).toBe(1);
    expect(await count("artifact_draft_object", " WHERE artifact_id=?1", [input.revision.artifact_ref.id])).toBe(6);
    expect(await count("operation_intent", " WHERE intent_id=?1", [input.intent.intent_ref.id])).toBe(1);
    expect(await count("outbox", " WHERE intent_id=?1", [input.intent.intent_ref.id])).toBe(1);
    const before = await snapshot(input.revision.artifact_ref.id, input.intent.intent_ref.id);
    const replay = await store.prepare(input);
    expect(replay).toMatchObject({ disposition: "EXISTING", artifact_ref: first.artifact_ref,
      intent_ref: first.intent_ref, outbox_id: first.outbox_id });
    expect(await snapshot(input.revision.artifact_ref.id, input.intent.intent_ref.id)).toEqual(before);

    const changed = { ...input, intent: { ...input.intent, payload_ref: "payload-changed" } };
    await expectDraftCode(store.prepare(changed), "ARTIFACT_DRAFT_IDEMPOTENCY_CONFLICT");
  });

  it("leaves only the pre-R2 reservation when a real R2 write fails", async () => {
    const input = await draftInput(unique("r2-failure"));
    const store = createArtifactDraftRuntime(runtime.CORE_DB, failResidencyPut(runtime.WORK_BUCKET, 2));
    await expectDraftCode(store.prepare(input), "ARTIFACT_DRAFT_R2_INTEGRITY");
    expect(await count("artifact_draft_reservation", " WHERE intent_id=?1", [input.intent.intent_ref.id])).toBe(1);
    expect(await count("operation_intent", " WHERE intent_id=?1", [input.intent.intent_ref.id])).toBe(0);
    expect(await count("outbox", " WHERE intent_id=?1", [input.intent.intent_ref.id])).toBe(0);
    expect(await count("artifact_revision", " WHERE artifact_id=?1", [input.revision.artifact_ref.id])).toBe(0);
    expect(await count("artifact_draft_head", " WHERE artifact_id=?1", [input.revision.artifact_ref.id])).toBe(0);
    expect(await count("artifact_draft_binding", " WHERE artifact_id=?1", [input.revision.artifact_ref.id])).toBe(0);
    expect(await count("artifact_draft_object", " WHERE artifact_id=?1", [input.revision.artifact_ref.id])).toBe(0);
    const reservation = await runtime.CORE_DB.prepare(
      "SELECT state FROM artifact_draft_reservation WHERE intent_id=?1",
    ).bind(input.intent.intent_ref.id).first<{ readonly state: string }>();
    expect(reservation?.state).toBe("RESERVED");
  });

  it("rolls back the canonical D1 batch when its final SQL guard fails", async () => {
    const input = await draftInput(unique("guard-failure"));
    const store = createArtifactDraftRuntime(finalBatchFailure(runtime.CORE_DB), runtime.WORK_BUCKET);
    const failure = await store.prepare(input).catch((value: unknown) => value as ArtifactDraftError);
    expect(failure).toMatchObject({ code: "ARTIFACT_DRAFT_EFFECT_UNCERTAIN" });
    expect(String((failure as ArtifactDraftError & { readonly cause?: unknown }).cause)).toContain("ARTIFACT_DRAFT_OBJECT_GUARD");
    expect((await runtime.WORK_BUCKET.list({ prefix: "objects/" })).objects.length).toBeGreaterThan(0);
    expect(await count("artifact_draft_reservation", " WHERE intent_id=?1", [input.intent.intent_ref.id])).toBe(1);
    expect(await count("operation_intent", " WHERE intent_id=?1", [input.intent.intent_ref.id])).toBe(0);
    expect(await count("outbox", " WHERE intent_id=?1", [input.intent.intent_ref.id])).toBe(0);
    expect(await count("artifact_revision", " WHERE artifact_id=?1", [input.revision.artifact_ref.id])).toBe(0);
    expect(await count("artifact_draft_head", " WHERE artifact_id=?1", [input.revision.artifact_ref.id])).toBe(0);
    expect(await count("artifact_draft_binding", " WHERE artifact_id=?1", [input.revision.artifact_ref.id])).toBe(0);
    expect(await count("artifact_draft_object", " WHERE artifact_id=?1", [input.revision.artifact_ref.id])).toBe(0);
  });

  it("reconciles one lost final-batch acknowledgement from durable readback", async () => {
    const input = await draftInput(unique("lost-ack"));
    const store = createArtifactDraftRuntime(finalBatchFailure(runtime.CORE_DB, true), runtime.WORK_BUCKET);
    const result = await store.prepare(input);
    expect(result.disposition).toBe("EXISTING");
    expect(await count("artifact_revision", " WHERE artifact_id=?1", [input.revision.artifact_ref.id])).toBe(1);
    expect(await count("artifact_draft_object", " WHERE artifact_id=?1", [input.revision.artifact_ref.id])).toBe(6);
    expect(await count("operation_intent", " WHERE intent_id=?1", [input.intent.intent_ref.id])).toBe(1);
    expect(await count("outbox", " WHERE intent_id=?1", [input.intent.intent_ref.id])).toBe(1);
  });

  it("does not replay a finalized draft when an evidence object is missing, or PUT again", async () => {
    const input = await draftInput(unique("missing-replay"));
    const first = await createArtifactDraftRuntime().prepare(input);
    const missing = first.objects.find((object) => object.object_kind === "SECTION_BODY");
    if (missing === undefined) throw new Error("fixture section receipt is missing");
    await runtime.WORK_BUCKET.delete(missing.receipt.key);
    const observed = countResidencyPuts(runtime.WORK_BUCKET);
    await expectDraftCode(createArtifactDraftRuntime(runtime.CORE_DB, observed.bucket).prepare(input), "ARTIFACT_DRAFT_R2_INTEGRITY");
    expect(observed.puts()).toBe(0);
  });

  it("lets exactly one concurrent writer advance the same expected draft head", async () => {
    const raceArtifact = unique("race-artifact");
    const seed = await draftInput(unique("race-seed"), { artifact_id: raceArtifact, artifact_revision: 1 });
    await createArtifactDraftRuntime().prepare(seed);
    const left = await draftInput(unique("race-left"), { artifact_id: raceArtifact, artifact_revision: 2, expected_head_revision: 1 });
    const right = await draftInput(unique("race-right"), { artifact_id: raceArtifact, artifact_revision: 3, expected_head_revision: 1 });
    const results = await Promise.allSettled([
      createArtifactDraftRuntime().prepare(left),
      createArtifactDraftRuntime().prepare(right),
    ]);
    expect(results.filter((result): result is PromiseFulfilledResult<PrepareArtifactDraftResult> => result.status === "fulfilled"))
      .toHaveLength(1);
    const rejected = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
    expect(rejected?.reason).toMatchObject({ code: "ARTIFACT_DRAFT_HEAD_CONFLICT" });
    expect(await count("artifact_draft_head", " WHERE artifact_id=?1", [raceArtifact])).toBe(1);
    expect(await count("artifact_revision", " WHERE artifact_id=?1", [raceArtifact])).toBe(2);
  });

  it("does not reuse physical keys across full residency domains and preserves published head", async () => {
    const leftInput = await draftInput(unique("res-left"), { content_tag: "same-bytes", residency_domain: unique("left") });
    const rightInput = await draftInput(unique("res-right"), { content_tag: "same-bytes", residency_domain: unique("right") });
    const left = await createArtifactDraftRuntime().prepare(leftInput);
    const right = await createArtifactDraftRuntime().prepare(rightInput);
    const leftSection = left.objects.find((object) => object.object_kind === "SECTION_BODY");
    const rightSection = right.objects.find((object) => object.object_kind === "SECTION_BODY");
    expect(leftSection?.receipt.key).not.toBe(rightSection?.receipt.key);
    expect(await storedObjectBytes(leftSection?.receipt.key ?? "")).toEqual(await storedObjectBytes(rightSection?.receipt.key ?? ""));

    const publishedArtifact = unique("published-artifact");
    const published = await draftInput(unique("published"), { artifact_id: publishedArtifact, artifact_revision: 2 });
    const publishedManifestKey = `${publishedArtifact}/immutable-manifest`;
    await runtime.CORE_DB.batch([
      runtime.CORE_DB.prepare("INSERT INTO artifact_revision(artifact_id,revision,kind,spec_digest,evidence_freeze_id,evidence_freeze_revision,manifest_r2_key,dependency_manifest_ref,status,created_at) VALUES (?1,1,?2,?3,?4,1,?5,?6,'PUBLISHED',?7)").bind(publishedArtifact, published.spec.kind, published.revision.spec_digest, published.revision.evidence_freeze_ref.id, publishedManifestKey, published.revision.dependency_manifest_ref, published.revision.created_at),
      runtime.CORE_DB.prepare("INSERT INTO artifact_head(artifact_id,head_revision,manifest_r2_key,updated_at) VALUES (?1,1,?2,?3)").bind(publishedArtifact, publishedManifestKey, published.revision.created_at),
    ]);
    await createArtifactDraftRuntime().prepare(published);
    const head = await runtime.CORE_DB.prepare("SELECT head_revision,manifest_r2_key FROM artifact_head WHERE artifact_id=?1")
      .bind(publishedArtifact).first<{ readonly head_revision: number; readonly manifest_r2_key: string }>();
    expect(head).toEqual({ head_revision: 1, manifest_r2_key: publishedManifestKey });
    const status = await runtime.CORE_DB.prepare("SELECT status FROM artifact_revision WHERE artifact_id=?1 AND revision=1")
      .bind(publishedArtifact).first<{ readonly status: string }>();
    expect(status?.status).toBe("PUBLISHED");
  });

  it("replays an old immutable draft receipt after a later draft revision", async () => {
    const replayArtifact = unique("replay-artifact");
    const oldInput = await draftInput(unique("old-n"), { artifact_id: replayArtifact, artifact_revision: 1 });
    const old = await createArtifactDraftRuntime().prepare(oldInput);
    const nextInput = await draftInput(unique("next-n"), { artifact_id: replayArtifact, artifact_revision: 2, expected_head_revision: 1 });
    await createArtifactDraftRuntime().prepare(nextInput);
    const replay = await createArtifactDraftRuntime().prepare(oldInput);
    expect(replay.disposition).toBe("EXISTING");
    expect(replay.artifact_ref).toEqual(old.artifact_ref);
    expect(replay.manifest.receipt).toEqual(old.manifest.receipt);
    expect(replay.objects.map((object) => object.receipt.key)).toEqual(old.objects.map((object) => object.receipt.key));
    expect(replay.draft_head_revision).toBe(2);
  });
});
