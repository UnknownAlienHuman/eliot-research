import { applyD1Migrations, type D1Migration } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import type { ArtifactRevision, ObjectResidencyKey, VersionedRef } from "@eliotr/contracts";
import { canonicalJson } from "@eliotr/platform-cloudflare";
import { createArtifactDraftStore, type ArtifactDraftReferencedObjectInput, type PrepareArtifactDraftInput, type PrepareArtifactDraftResult } from "../src/artifact-draft.js";
import { CloudflareArtifactCowAdapter, type ArtifactCowParent, type ArtifactCowPorts } from "../src/artifact-cow.js";
import { artifactCowFixture } from "../src/artifact-cow-fixture.js";

interface TestEnv {
  readonly CORE_DB: D1Database;
  readonly WORK_BUCKET: R2Bucket;
  readonly CORE_MIGRATIONS: D1Migration[];
}

interface DraftObjectRow {
  readonly object_kind: string;
  readonly object_ref: string;
  readonly section_ordinal: number | null;
  readonly receipt_json: string;
  readonly residency_key_json: string;
}

const runtime = env as unknown as TestEnv;

async function sha256(bytes: Uint8Array): Promise<string> {
  const owned = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(owned).set(bytes);
  const digest = await crypto.subtle.digest("SHA-256", owned);
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, "0")).join("");
}

function intent(id: string, createdAt: string) {
  return {
    intent_ref: { id, revision: 1 }, operation_kind: "REPORT" as const, principal_ref: "owner-one",
    idempotency_key: id, payload_ref: "artifact-one", policy_decision_ref: "allowed-one", created_at: createdAt,
  };
}

async function readExactParent(ref: VersionedRef, freeze: ArtifactCowParent["freeze"]): Promise<ArtifactCowParent | null> {
  const row = await runtime.CORE_DB.prepare(
    "SELECT manifest_r2_key FROM artifact_revision WHERE artifact_id=?1 AND revision=?2 LIMIT 1",
  ).bind(ref.id, ref.revision).first<{ readonly manifest_r2_key: string }>();
  if (row === null) return null;
  const manifestObject = await runtime.WORK_BUCKET.get(row.manifest_r2_key);
  if (manifestObject === null) return null;
  const manifestBytes = new Uint8Array(await manifestObject.arrayBuffer());
  const manifestText = new TextDecoder("utf-8", { fatal: true }).decode(manifestBytes);
  const manifest = JSON.parse(manifestText) as { readonly spec: ArtifactCowParent["spec"]; readonly revision: ArtifactRevision };
  if (canonicalJson(manifest) !== manifestText || manifest.revision.artifact_ref.id !== ref.id || manifest.revision.artifact_ref.revision !== ref.revision) return null;
  const rows = await runtime.CORE_DB.prepare(
    "SELECT object_kind, object_ref, section_ordinal, receipt_json, residency_key_json FROM artifact_draft_object WHERE artifact_id=?1 AND revision=?2 ORDER BY object_kind, object_ref",
  ).bind(ref.id, ref.revision).all<DraftObjectRow>();
  if (!rows.success) return null;
  const sectionsByOrdinal = new Map<number, { section: ArtifactRevision["sections"][number]; bytes: Uint8Array; residency: ObjectResidencyKey }>();
  const references: ArtifactDraftReferencedObjectInput[] = [];
  let manifestResidency: ObjectResidencyKey | undefined;
  for (const objectRow of rows.results) {
    const receipt = JSON.parse(objectRow.receipt_json) as { readonly key: string; readonly expected_sha256: string; readonly size_bytes: number };
    const residency = JSON.parse(objectRow.residency_key_json) as ObjectResidencyKey;
    const object = await runtime.WORK_BUCKET.get(receipt.key);
    if (object === null) return null;
    const bytes = new Uint8Array(await object.arrayBuffer());
    if (bytes.byteLength !== receipt.size_bytes || await sha256(bytes) !== receipt.expected_sha256 || residency.content_digest.digest !== receipt.expected_sha256) return null;
    if (objectRow.object_kind === "MANIFEST") {
      manifestResidency = residency;
      continue;
    }
    if (objectRow.object_kind === "SECTION_BODY") {
      const ordinal = objectRow.section_ordinal;
      const section = manifest.revision.sections[ordinal ?? -1];
      if (ordinal === null || section === undefined || section.body_object_ref !== objectRow.object_ref || section.body_sha256 !== receipt.expected_sha256) return null;
      sectionsByOrdinal.set(ordinal, { section, bytes, residency });
      continue;
    }
    references.push({
      object_ref: objectRow.object_ref,
      object_kind: objectRow.object_kind as ArtifactDraftReferencedObjectInput["object_kind"],
      bytes,
      residency,
    });
  }
  if (manifestResidency === undefined || sectionsByOrdinal.size !== manifest.revision.sections.length) return null;
  const sections = manifest.revision.sections.map((_section, ordinal) => sectionsByOrdinal.get(ordinal)).filter((item) => item !== undefined);
  return { spec: manifest.spec, freeze, revision: manifest.revision, sections, referenced_objects: references, manifest_residency: manifestResidency };
}

async function seedInput(parent: ArtifactCowParent, artifactRef: VersionedRef): Promise<PrepareArtifactDraftInput> {
  const revision: ArtifactRevision = { ...parent.revision, artifact_ref: artifactRef };
  const manifestBytes = new TextEncoder().encode(canonicalJson({ spec: parent.spec, revision }));
  const manifestResidency: ObjectResidencyKey = {
    ...parent.manifest_residency,
    content_digest: { algorithm: "sha256", digest: await sha256(manifestBytes) },
  };
  return {
    intent: intent(`seed-${crypto.randomUUID()}`, revision.created_at), expected_draft_head_revision: null,
    spec: parent.spec, revision,
    sections: parent.sections.map((section) => ({ section: section.section, bytes: section.bytes, residency: section.residency })),
    referenced_objects: parent.referenced_objects, manifest_residency: manifestResidency,
  };
}

async function ensureScopeSnapshot(snapshotId: string): Promise<void> {
  await runtime.CORE_DB.prepare(
    "INSERT OR IGNORE INTO scope_snapshot(snapshot_id,revision,resolved_scope_expression_json,participant_generations_json,member_source_revision_refs_json,source_owner_generations_json,policy_authority_ref,disclosure_closure_digest,purge_ledger_revision,snapshot_digest,created_at,expires_at) VALUES (?1,1,'{}','{}','[]','{}','policy-one',?2,0,?3,'2026-10-01T00:00:00.000Z','2027-10-01T00:00:00.000Z')",
  ).bind(snapshotId, "c".repeat(64), await sha256(new TextEncoder().encode(canonicalJson(snapshotId)))).run();
}

async function storedBytes(key: string): Promise<Uint8Array> {
  const object = await runtime.WORK_BUCKET.get(key);
  if (object === null) throw new Error(`Expected immutable object at ${key}`);
  return new Uint8Array(await object.arrayBuffer());
}

describe("artifact COW with actual D1 and R2", () => {
  beforeAll(async () => applyD1Migrations(runtime.CORE_DB, runtime.CORE_MIGRATIONS));

  it("reads the exact parent, keeps unchanged physical objects, replaces target bytes, and wins one CAS", async () => {
    const { parent: fixtureParent, ports: fixturePorts } = await artifactCowFixture();
    const artifact = { id: `cow-${crypto.randomUUID()}`, revision: 1 } satisfies VersionedRef;
    const parent: ArtifactCowParent = { ...fixtureParent, revision: { ...fixtureParent.revision, artifact_ref: artifact } };
    await ensureScopeSnapshot(parent.spec.scope_snapshot_ref.id);
    const draftStore = createArtifactDraftStore(runtime.CORE_DB, runtime.WORK_BUCKET);
    const initial = await draftStore.prepare(await seedInput(parent, artifact));
    const oldSectionReceipt = initial.objects.find((item) => item.object_ref === "body-findings-v1");
    const oldManifestBytes = await storedBytes(initial.manifest.receipt.key);
    const oldUntouchedBytes = await storedBytes(oldSectionReceipt?.receipt.key ?? "");
    let nextReceipt: PrepareArtifactDraftResult | undefined;
    const ports: ArtifactCowPorts = {
      ...fixturePorts,
      readExactParent: (ref) => readExactParent(ref, parent.freeze),
      createIntent: async () => {
        const id = `cow-intent-${crypto.randomUUID()}`;
        return { intent: intent(id, "2026-10-01T00:00:00.000Z"), created_at: "2026-10-01T00:00:00.000Z" };
      },
      prepare: async (input) => {
        const result = await draftStore.prepare(input);
        nextReceipt = result;
        return result;
      },
    };
    const adapter = new CloudflareArtifactCowAdapter(ports);
    const revised = await adapter.reviseSection(artifact, "introduction", 1);
    expect(revised.sections[1]?.body_object_ref).toBe("body-findings-v1");
    expect(revised.sections[1]?.reused_from_revision_ref).toEqual(artifact);
    expect(revised.sections[0]?.body_object_ref).toBe("body-intro-v2");
    expect(nextReceipt).toBeDefined();
    const unchangedReceipt = nextReceipt?.objects.find((item) => item.object_ref === "body-findings-v1");
    const changedReceipt = nextReceipt?.objects.find((item) => item.object_ref === "body-intro-v2");
    expect(unchangedReceipt?.receipt.key).toBe(oldSectionReceipt?.receipt.key);
    expect(await storedBytes(unchangedReceipt?.receipt.key ?? "")).toEqual(oldUntouchedBytes);
    expect(changedReceipt?.receipt.key).not.toBe(initial.objects.find((item) => item.object_ref === "body-intro-v1")?.receipt.key);
    expect(await sha256(await storedBytes(changedReceipt?.receipt.key ?? ""))).toBe(revised.sections[0]?.body_sha256);
    expect(await storedBytes(initial.manifest.receipt.key)).toEqual(oldManifestBytes);
    const head = await runtime.CORE_DB.prepare("SELECT head_revision FROM artifact_draft_head WHERE artifact_id=?1 LIMIT 1")
      .bind(artifact.id).first<{ readonly head_revision: number }>();
    expect(head?.head_revision).toBe(2);

    const raceArtifact = { id: `cow-race-${crypto.randomUUID()}`, revision: 1 } satisfies VersionedRef;
    const raceParent: ArtifactCowParent = { ...fixtureParent, revision: { ...fixtureParent.revision, artifact_ref: raceArtifact } };
    await ensureScopeSnapshot(raceParent.spec.scope_snapshot_ref.id);
    await draftStore.prepare(await seedInput(raceParent, raceArtifact));
    const racePorts: ArtifactCowPorts = {
      ...fixturePorts,
      readExactParent: (ref) => readExactParent(ref, raceParent.freeze),
      createIntent: async () => {
        const id = `cow-race-intent-${crypto.randomUUID()}`;
        return { intent: intent(id, "2026-10-01T00:00:00.000Z"), created_at: "2026-10-01T00:00:00.000Z" };
      },
      prepare: (input) => draftStore.prepare(input),
    };
    const raceAdapter = new CloudflareArtifactCowAdapter(racePorts);
    const races = await Promise.allSettled([
      raceAdapter.reviseSection(raceArtifact, "introduction", 1),
      raceAdapter.reviseSection(raceArtifact, "introduction", 1),
    ]);
    expect(races.filter((item) => item.status === "fulfilled")).toHaveLength(1);
    expect(races.filter((item) => item.status === "rejected")).toHaveLength(1);
    const count = await runtime.CORE_DB.prepare("SELECT COUNT(*) AS count FROM artifact_revision WHERE artifact_id=?1")
      .bind(raceArtifact.id).first<{ readonly count: number }>();
    expect(count?.count).toBe(2);
  });
});
