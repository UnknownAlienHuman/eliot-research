import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { createD1NavigationStore, canonicalEvidenceJson, evidenceSha256, evidenceSha256Bytes, evidenceUtf8Bytes } from "@eliotr/cloudflare-evidence";
import { materializeStructuralNavigationBatch, type OrientationSource } from "@eliotr/cloudflare-navigation";
import { canonicalNormalizedBundleKey, objectResidencyKeyDigest } from "@eliotr/platform-cloudflare";
import { canonicalNavigationJson, materializeStructuralNavigation, projectAtlasIdentity, requireResolvedEvidenceForPublication } from "@eliotr/retrieval";
import { createD1NavigationService } from "../src/navigation-persistence.js";
import { createNavigationService } from "../src/navigation-service.js";
import { access, artifacts, clearDatabase, countArtifacts, db, fixture, grant, project,
  seedHandle, setupDatabase, source, TIME, wrappedDatabase } from "./navigation-fixture.js";

beforeAll(setupDatabase);
beforeEach(clearDatabase);

const bucket = (env as unknown as { EVIDENCE_BUCKET: R2Bucket }).EVIDENCE_BUCKET;

interface StagedBundle {
  readonly revision: ReturnType<typeof source>;
  readonly authority: Record<string, unknown>;
  readonly key: string;
  readonly manifestKey: string;
  readonly hashesKey: string;
  readonly bytes: Uint8Array;
  readonly digest: string;
  readonly contentResidencyDigest: string;
  readonly manifestDigest: string;
  readonly receiptJson: string;
  readonly receiptSha256: string;
}

function versionOf(object: R2Object | null): Record<string, string> {
  const version = (object as unknown as { version?: unknown } | null)?.version;
  return typeof version === "string" && version.length > 0 ? { version } : {};
}

async function shaHex(value: string | Uint8Array): Promise<string> {
  const bytes = typeof value === "string" ? new TextEncoder().encode(value) : value;
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes as BufferSource))]
    .map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

const RESIDENCY_BASE = { scope_domain_id: "scope-1", access_domain_id: "access-1",
  confidentiality_domain_id: "conf-1", encryption_key_domain_id: "enc-1",
  retention_domain_id: "ret-1", erasure_domain_id: "era-1" };

async function stageBundle(ref: string, markdown: string, metadata: Record<string, string> = {}): Promise<StagedBundle> {
  const bytes = new TextEncoder().encode(markdown);
  const digest = await shaHex(bytes);
  const contentResidencyDigest = await objectResidencyKeyDigest({ ...RESIDENCY_BASE,
    content_digest: { algorithm: "sha256", digest } });
  const revisionBase = source(ref);
  const revision = { ...revisionBase, content_sha256: digest };
  const identity = { owner_system_id: "owner-system-1",
    source_namespace_id: revision.source_namespace_id, source_owner_generation: revision.source_owner_generation,
    source_logical_id: revision.source_id, source_revision_ref: ref };
  const key = await canonicalNormalizedBundleKey(contentResidencyDigest, identity, "content.md");
  // Stage the admitted manifest first so the D1 normalized_artifact_ref is the canonical
  // promotion receipt binding (per-file residency digests, three distinct keys).
  const manifest = {
    protocol: "eliotr.normalized.v1",
    origin: { owner_system_id: "owner-system-1", source_namespace_id: revision.source_namespace_id,
      source_owner_generation: revision.source_owner_generation, source_revision_ref: ref,
      source_view_ref: `view-${ref}`, ownership_mode: "immutable_import" },
    source: { logical_id: revision.source_id, original_name: "doc.md", original_sha256: digest,
      origin_location_class: "cloud", mime_type: "text/markdown" },
    residency_and_disclosure: { ...RESIDENCY_BASE, disclosure_ceiling: "private", allowed_use: ["research"] },
    normalization: { analyzer: "test", analyzer_version: "1", profile: "p",
      config_hash: digest, created_at: TIME },
    content: { markdown: "content.md", markdown_sha256: digest },
    capabilities: { text_ranges: true, pages: false, bounding_boxes: false, tables: false, figures: false },
    quality: { state: "standard", assurance_ceiling: "ceiling-1", warnings: [] as string[] },
    export: { purpose: "test", receipt_ref: "receipt-1" },
  };
  const manifestBytes = new TextEncoder().encode(JSON.stringify(manifest));
  const manifestDigest = await shaHex(manifestBytes);
  const manifestResidencyDigest = await objectResidencyKeyDigest({ ...RESIDENCY_BASE,
    content_digest: { algorithm: "sha256", digest: manifestDigest } });
  if (manifestResidencyDigest === contentResidencyDigest) throw new Error("per-file digests must differ");
  const manifestKey = await canonicalNormalizedBundleKey(manifestResidencyDigest, identity, "manifest.json");
  await db.prepare("UPDATE source_revision SET content_sha256=?1, object_residency_key_digest=?2, normalized_artifact_ref=?3 WHERE source_revision_ref=?4")
    .bind(digest, contentResidencyDigest, manifestKey, ref).run();
  const decisionRow = await db.prepare("SELECT decision_json FROM source_admission_decision WHERE source_revision_ref=?1")
    .bind(ref).first<{ decision_json: string }>();
  if (decisionRow) {
    const decision = JSON.parse(decisionRow.decision_json) as Record<string, unknown>;
    decision.object_residency_key_digest = contentResidencyDigest;
    const newJson = canonicalEvidenceJson(decision);
    const newSha = await evidenceSha256(decision);
    await db.prepare("UPDATE source_admission_decision SET object_residency_key_digest=?1, decision_json=?2, decision_sha256=?3 WHERE source_revision_ref=?4")
      .bind(contentResidencyDigest, newJson, newSha, ref).run();
  }
  const updatedRevision = { ...revision, object_residency_key_digest: contentResidencyDigest, normalized_artifact_ref: manifestKey };
  const contentPut = await bucket.put(key, bytes, { httpMetadata: { contentType: "text/markdown; charset=utf-8" },
    customMetadata: { eliotr_sha256: digest, eliotr_size_bytes: String(bytes.byteLength),
      eliotr_immutable: "true", source_namespace_id: revision.source_namespace_id,
      source_owner_generation: revision.source_owner_generation,
      admission_receipt_ref: `decision-${ref}`, ...metadata } });
  const manifestPut = await bucket.put(manifestKey, manifestBytes, { httpMetadata: { contentType: "application/json; charset=utf-8" },
    customMetadata: { eliotr_sha256: manifestDigest, eliotr_size_bytes: String(manifestBytes.byteLength),
      eliotr_immutable: "true", source_namespace_id: revision.source_namespace_id,
      source_owner_generation: revision.source_owner_generation,
      admission_receipt_ref: `decision-${ref}` } });
  // Subsidiary staging keeps the production three-file bundle shape and the
  // durable per-file promotion readbacks (key, residency digest, digest, size,
  // media type, ETag + version) inside the canonical admission receipt JSON.
  // The FIX3 acceptance E2E below produces these rows through the real ingest
  // validation, promotion and guarded commit path instead of this helper.
  const hashesText = `${digest}  content.md\n${manifestDigest}  manifest.json\n`;
  const hashesBytes = new TextEncoder().encode(hashesText);
  const hashesSha = await shaHex(hashesBytes);
  const hashesResidencyDigest = await objectResidencyKeyDigest({ ...RESIDENCY_BASE,
    content_digest: { algorithm: "sha256", digest: hashesSha } });
  const hashesKey = await canonicalNormalizedBundleKey(hashesResidencyDigest, identity, "hashes.sha256");
  const hashesPut = await bucket.put(hashesKey, hashesBytes, { httpMetadata: { contentType: "text/plain; charset=utf-8" },
    customMetadata: { eliotr_sha256: hashesSha, eliotr_size_bytes: String(hashesBytes.byteLength),
      eliotr_immutable: "true", source_namespace_id: revision.source_namespace_id,
      source_owner_generation: revision.source_owner_generation,
      admission_receipt_ref: `decision-${ref}` } });
  if (!contentPut?.etag || !manifestPut?.etag || !hashesPut?.etag) throw new Error("staged R2 readback lost its ETag");
  const receipt = {
    operation_id: `op-${ref}`, manifest_sha256: manifestDigest, source_revision_ref: ref,
    normalized_artifact_ref: manifestKey, object_residency_key_digest: contentResidencyDigest,
    decision: "ADMITTED", reason_codes: [] as string[], readback_sha256: await shaHex(`readback-${ref}`),
    promoted_objects: [
      { logical_path: "content.md", canonical_key: key, residency_key_digest: contentResidencyDigest,
        sha256: digest, size_bytes: bytes.byteLength, etag: contentPut.etag,
        ...versionOf(contentPut), content_type: "text/markdown; charset=utf-8" },
      { logical_path: "hashes.sha256", canonical_key: hashesKey, residency_key_digest: hashesResidencyDigest,
        sha256: hashesSha, size_bytes: hashesBytes.byteLength, etag: hashesPut.etag,
        ...versionOf(hashesPut), content_type: "text/plain; charset=utf-8" },
      { logical_path: "manifest.json", canonical_key: manifestKey, residency_key_digest: manifestResidencyDigest,
        sha256: manifestDigest, size_bytes: manifestBytes.byteLength, etag: manifestPut.etag,
        ...versionOf(manifestPut), content_type: "application/json; charset=utf-8" },
    ],
    committed_at: TIME,
  };
  const receiptJson = canonicalEvidenceJson(receipt);
  const receiptSha256 = await shaHex(receiptJson);
  await db.prepare("UPDATE bundle_ingest_operation SET bundle_receipt_json=?1, bundle_receipt_sha256=?2, " +
    "promotion_receipt_ref=?3 WHERE operation_id=?4")
    .bind(receiptJson, receiptSha256, `promotion:fixture-${ref}`, `op-${ref}`).run();
  await db.prepare("INSERT INTO scope_read_policy (source_namespace_id, principal_ref, client_class, policy_ref, " +
    "generation, allowed_use_json, disclosure_ceiling, state, expires_at, created_at) VALUES " +
    "(?1,'owner-1','owner_pwa',?2,1,'[\"research\"]','private','ACTIVE','2027-09-05T00:00:00.000Z',?3) " +
    "ON CONFLICT(source_namespace_id,principal_ref,client_class) DO NOTHING")
    .bind(revision.source_namespace_id, `read-${ref}`, TIME).run();
  const authority = { source_id: revision.source_id, owner_system_id: "owner-system-1",
    source_namespace_id: revision.source_namespace_id, source_owner_generation: revision.source_owner_generation,
    source_revision_ref: ref, source_title: "Rust memory", source_class: "document", content_sha256: digest,
    object_residency_key_digest: contentResidencyDigest, normalized_artifact_ref: manifestKey,
    purge_state: "LIVE", admission_receipt_ref: `decision-${ref}`,
    disclosure_ceiling: "private", allowed_use: ["research"] };
  return { revision: updatedRevision, authority, key, manifestKey, hashesKey, bytes, digest,
    contentResidencyDigest, manifestDigest, receiptJson, receiptSha256 };
}

function contourSource(staged: StagedBundle): OrientationSource {
  return { revision: staged.revision, authority: staged.authority,
    policy: { source_namespace_id: (staged.revision as { source_namespace_id: string }).source_namespace_id,
      policy_ref: "read-1", generation: 1, allowed_use_json: '["research"]',
      disclosure_ceiling: "private", expires_at: "2027-09-05T00:00:00.000Z" },
    policy_uses: ["research"],
    policy_closure_ref: "policy-closure-1", title: "Rust memory", kind: "document",
    bundle_admission: null } as unknown as OrientationSource;
}

async function stageManifest(ref: string, markdownDigest: string, mappings: string | undefined,
  mapDigest: string | undefined, stageMap: boolean, originRef = ref, mapJson = "{}"): Promise<string> {
  const manifest = {
    protocol: "eliotr.normalized.v1",
    origin: { owner_system_id: "owner-system-1", source_namespace_id: `namespace-${ref}`,
      source_owner_generation: "owner-generation-1", source_revision_ref: originRef,
      source_view_ref: `view-${ref}`, ownership_mode: "immutable_import" },
    source: { logical_id: `source-${ref}`, original_name: "doc.md", original_sha256: markdownDigest,
      origin_location_class: "cloud", mime_type: "text/markdown" },
    residency_and_disclosure: { ...RESIDENCY_BASE, disclosure_ceiling: "private", allowed_use: ["research"] },
    normalization: { analyzer: "test", analyzer_version: "1", profile: "p",
      config_hash: markdownDigest, created_at: TIME },
    content: { markdown: "content.md", markdown_sha256: markdownDigest,
      ...(mappings === undefined ? {} : { mappings }),
      ...(mapDigest === undefined ? {} : { coordinate_map_digest: mapDigest }) },
    capabilities: { text_ranges: true, pages: false, bounding_boxes: false, tables: false, figures: false },
    quality: { state: "standard", assurance_ceiling: "ceiling-1", warnings: [] as string[] },
    export: { purpose: "test", receipt_ref: "receipt-1" },
  };
  const manifestBytes = new TextEncoder().encode(JSON.stringify(manifest));
  const manifestDigest = await shaHex(manifestBytes);
  const identity = { owner_system_id: "owner-system-1", source_namespace_id: `namespace-${ref}`,
    source_owner_generation: "owner-generation-1", source_logical_id: `source-${ref}`,
    source_revision_ref: ref };
  const manifestResidencyDigest = await objectResidencyKeyDigest({ ...RESIDENCY_BASE,
    content_digest: { algorithm: "sha256", digest: manifestDigest } });
  const manifestKey = await canonicalNormalizedBundleKey(manifestResidencyDigest, identity, "manifest.json");
  const jsonMetadataFor = (digest: string, size: number) => ({ httpMetadata: { contentType: "application/json; charset=utf-8" },
    customMetadata: { eliotr_sha256: digest, eliotr_size_bytes: String(size), eliotr_immutable: "true",
      source_namespace_id: `namespace-${ref}`, source_owner_generation: "owner-generation-1",
      admission_receipt_ref: `decision-${ref}` } });
  const manifestPut = await bucket.put(manifestKey, manifestBytes, jsonMetadataFor(manifestDigest, manifestBytes.byteLength));
  await db.prepare("UPDATE source_revision SET normalized_artifact_ref=?1 WHERE source_revision_ref=?2")
    .bind(manifestKey, ref).run();
  if (stageMap && mappings !== undefined) {
    const mapBytes = new TextEncoder().encode(mapJson);
    const mapSha = await shaHex(mapBytes);
    const mapResidencyDigest = await objectResidencyKeyDigest({ ...RESIDENCY_BASE,
      content_digest: { algorithm: "sha256", digest: mapSha } });
    const mapKey = await canonicalNormalizedBundleKey(mapResidencyDigest, identity, mappings);
    const mapPut = await bucket.put(mapKey, mapBytes, jsonMetadataFor(mapSha, mapBytes.byteLength));
    if (!manifestPut?.etag || !mapPut?.etag) throw new Error("staged manifest/map readback lost its ETag");
    // An honestly re-staged manifest extends the durable receipt (replaced
    // manifest entry plus the new map entry); a forged manifest that skips
    // this step keeps a stale receipt and fails the ref/receipt reconciliation.
    const receiptRow = await db.prepare("SELECT bundle_receipt_json FROM bundle_ingest_operation WHERE operation_id=?1")
      .bind(`op-${ref}`).first<{ bundle_receipt_json: string }>();
    if (!receiptRow) throw new Error("staged bundle has no durable receipt");
    const receipt = JSON.parse(receiptRow.bundle_receipt_json) as {
      promoted_objects: Record<string, unknown>[]; normalized_artifact_ref: string; manifest_sha256: string };
    receipt.normalized_artifact_ref = manifestKey;
    receipt.manifest_sha256 = manifestDigest;
    receipt.promoted_objects = [
      ...receipt.promoted_objects.filter((entry) => entry.logical_path !== "manifest.json" && entry.logical_path !== mappings),
      { logical_path: "manifest.json", canonical_key: manifestKey, residency_key_digest: manifestResidencyDigest,
        sha256: manifestDigest, size_bytes: manifestBytes.byteLength, etag: manifestPut.etag,
        ...versionOf(manifestPut), content_type: "application/json; charset=utf-8" },
      { logical_path: mappings, canonical_key: mapKey, residency_key_digest: mapResidencyDigest,
        sha256: mapSha, size_bytes: mapBytes.byteLength, etag: mapPut.etag,
        ...versionOf(mapPut), content_type: "application/json; charset=utf-8" },
    ].sort((left, right) => String(left.logical_path).localeCompare(String(right.logical_path)));
    const receiptJson = canonicalEvidenceJson(receipt);
    await db.prepare("UPDATE bundle_ingest_operation SET bundle_receipt_json=?1, bundle_receipt_sha256=?2 WHERE operation_id=?3")
      .bind(receiptJson, await shaHex(receiptJson), `op-${ref}`).run();
  }
  return manifestKey;
}
describe("persisted Corpus Lens in local Workers/D1", () => {
  it("persists and reopens card, map and atlas across store instances", async () => {
    const f = await fixture(); await grant(f.snapshot);
    const { card, map, atlas } = await artifacts(f.snapshot);
    expect(await f.store.putArtifact("SOURCE_CARD", card)).toBe("CREATED");
    expect(await f.store.putArtifact("DOCUMENT_MAP", map)).toBe("CREATED");
    expect(await f.store.putArtifact("PROJECT_ATLAS", atlas)).toBe("CREATED");
    const reader = createD1NavigationStore(f.input);
    expect(await reader.getSourceCards(["revision-1"])).toEqual([card]);
    expect(await reader.getSourceCardsByRefs([card.card_ref])).toEqual([card]);
    expect(await reader.getDocumentMaps(["revision-1"])).toEqual([map]);
    expect(await reader.getProjectAtlas(project)).toEqual(atlas);
    const service = createD1NavigationService({ ...f.input, scopes: f.scopes });
    const orientation = await service.orient({ scope_snapshot: f.snapshot, project_ref: project, focus_terms: ["rust"], maximum_sources: 10 });
    expect(orientation).toMatchObject({ navigation_authority: "NAVIGATION_ONLY", represented_source_revision_refs: ["revision-1"], omitted_source_revision_count: 0 });
    for (const kind of ["SOURCE_CARD", "DOCUMENT_MAP", "SECTION"] as const) {
      const result = await service.expand({ kind, scope_snapshot: f.snapshot, source_revision_ref: "revision-1", section_ref: "intro" });
      expect(result.support.publication_eligible).toBe(false);
    }
    const root = atlas.nodes.find((node) => node.kind === "PROJECT");
    if (!root) throw new Error("missing root");
    const expansion = await service.expand({ kind: "ATLAS_NODE", scope_snapshot: f.snapshot, project_ref: project, node_id: root.node_id });
    expect(expansion.support.publication_eligible).toBe(false);
    await expect(requireResolvedEvidenceForPublication(expansion, { source_revision_ref: "revision-1", scope_snapshot_ref: atlas.scope_snapshot_ref }))
      .rejects.toMatchObject({ code: "NAVIGATION_PUBLICATION_SUPPORT_REQUIRED" });
  });
  it("requires an exact research grant and never creates one", async () => {
    const f = await fixture(); const { card } = await artifacts(f.snapshot);
    await expect(f.store.putArtifact("SOURCE_CARD", card)).rejects.toBeInstanceOf(Error);
    await expect(f.store.getSourceCards(["revision-1"])).rejects.toBeInstanceOf(Error);
    expect(await countArtifacts()).toBe(0);
    expect(await db.prepare("SELECT COUNT(*) AS n FROM scope_access_grant").first("n")).toBe(0);
    await grant(f.snapshot);
    for (const change of [{ principal_ref: "other" }, { client_class: "trusted_agent" as const }, { credential_generation: "rotated" }]) {
      await expect(createD1NavigationStore({ ...f.input, access: { ...access, ...change } }).putArtifact("SOURCE_CARD", card)).rejects.toBeInstanceOf(Error);
    }
    await db.prepare("UPDATE scope_access_grant SET allowed_use_json='[\"archive\"]'").run();
    await expect(f.store.putArtifact("SOURCE_CARD", card)).rejects.toBeInstanceOf(Error);
  });
  it("replays duplicate and concurrent inserts without overwriting a slot", async () => {
    const f = await fixture(); await grant(f.snapshot);
    const { card } = await artifacts(f.snapshot);
    const outcomes = await Promise.all([f.store.putArtifact("SOURCE_CARD", card), createD1NavigationStore(f.input).putArtifact("SOURCE_CARD", card)]);
    expect(outcomes.sort()).toEqual(["CREATED", "REPLAY"]);
    expect(await f.store.putArtifact("SOURCE_CARD", card)).toBe("REPLAY");
    const other = await artifacts(f.snapshot, "revision-1", "Different valid card");
    await expect(f.store.putArtifact("SOURCE_CARD", other.card)).rejects.toMatchObject({ code: "NAVIGATION_ARTIFACT_INVALID" });
    expect(await countArtifacts()).toBe(1);
    await expect(db.prepare("UPDATE navigation_artifact SET artifact_revision=2").run()).rejects.toThrow();
    expect(await f.store.getSourceCards(["revision-1"])).toEqual([card]);
  });
  it("settles a lost insert ACK through exact readback, without a second write", async () => {
    const f = await fixture(); await grant(f.snapshot); const { card } = await artifacts(f.snapshot);
    let writes = 0;
    const flaky = wrappedDatabase(async (sql, phase) => {
      if (sql.startsWith("INSERT INTO navigation_artifact") && phase === "after") { writes += 1; throw new Error("lost ACK"); }
    });
    expect(await createD1NavigationStore({ ...f.input, database: flaky }).putArtifact("SOURCE_CARD", card)).toBe("REPLAY");
    expect(writes).toBe(1); expect(await countArtifacts()).toBe(1);
  });
  it("does not accept missing readback or repeat an uncertain write", async () => {
    const f = await fixture(); await grant(f.snapshot); const { card } = await artifacts(f.snapshot);
    let writes = 0;
    const flaky = wrappedDatabase(async (sql, phase) => {
      if (sql.startsWith("INSERT INTO navigation_artifact") && phase === "after") {
        writes += 1; await db.prepare("DELETE FROM navigation_artifact").run(); throw new Error("uncertain effect");
      }
    });
    await expect(createD1NavigationStore({ ...f.input, database: flaky }).putArtifact("SOURCE_CARD", card)).rejects.toMatchObject({ code: "NAVIGATION_STORE_FAILED" });
    expect(writes).toBe(1); expect(await countArtifacts()).toBe(0);
  });
  it("rejects forged content IDs, stale source bytes and foreign scopes before persistence", async () => {
    const f = await fixture(); await grant(f.snapshot); const { card, map, atlas } = await artifacts(f.snapshot);
    for (const value of [{ ...card, title: "forged" }, { ...card, card_ref: { id: "forged", revision: 1 } }, { ...card, publication_eligible: true }]) {
      await expect(f.store.putArtifact("SOURCE_CARD", value)).rejects.toBeInstanceOf(Error);
    }
    await expect(f.store.putArtifact("DOCUMENT_MAP", { ...map, generator_generation: "forged" })).rejects.toBeInstanceOf(Error);
    await expect(f.store.putArtifact("PROJECT_ATLAS", { ...atlas, scope_snapshot_ref: { id: "foreign", revision: 1 } })).rejects.toBeInstanceOf(Error);
    await db.prepare("UPDATE source_revision SET content_sha256=?1").bind("c".repeat(64)).run();
    await expect(f.store.putArtifact("SOURCE_CARD", card)).rejects.toBeInstanceOf(Error);
    expect(await countArtifacts()).toBe(0);
  });
  it("requires every Atlas card and rejects out-of-scope source annotations", async () => {
    const f = await fixture(); await grant(f.snapshot); const { card, atlas } = await artifacts(f.snapshot);
    await expect(f.store.putArtifact("PROJECT_ATLAS", atlas)).rejects.toBeInstanceOf(Error);
    await f.store.putArtifact("SOURCE_CARD", card);
    const { atlas_ref: _ref, digest: _digest, ...body } = atlas;
    const forged = { ...body, degraded_source_refs: ["outside"] };
    await expect(f.store.putArtifact("PROJECT_ATLAS", { ...forged, ...await projectAtlasIdentity(forged) })).rejects.toBeInstanceOf(Error);
    expect(await f.store.putArtifact("PROJECT_ATLAS", atlas)).toBe("CREATED");
  });
  it("removes all derived bodies when scope is invalidated and prevents resurrection", async () => {
    const f = await fixture(); await grant(f.snapshot); const { card, map, atlas } = await artifacts(f.snapshot);
    await f.store.putArtifact("SOURCE_CARD", card); await f.store.putArtifact("DOCUMENT_MAP", map); await f.store.putArtifact("PROJECT_ATLAS", atlas);
    await db.prepare("UPDATE scope_snapshot SET invalidated_at=?1, invalidation_reason='PURGED'").bind(TIME).run();
    expect(await countArtifacts()).toBe(0);
    await expect(f.store.getProjectAtlas(project)).rejects.toBeInstanceOf(Error);
    await expect(f.store.putArtifact("SOURCE_CARD", card)).rejects.toBeInstanceOf(Error);
  });
  it("purging even an omitted source removes dependent Atlas metadata", async () => {
    const f = await fixture(["revision-1", "revision-2"]); await grant(f.snapshot); const { card, atlas } = await artifacts(f.snapshot);
    await f.store.putArtifact("SOURCE_CARD", card); await f.store.putArtifact("PROJECT_ATLAS", atlas);
    await db.prepare("UPDATE source_revision SET purge_state='PURGE_REQUESTED' WHERE source_revision_ref='revision-2'").run();
    expect(await countArtifacts()).toBe(0);
    await expect(f.store.putArtifact("PROJECT_ATLAS", atlas)).rejects.toBeInstanceOf(Error);
  });
  it("rejects revoked, expired and changed current authority", async () => {
    const f = await fixture(); await grant(f.snapshot); const { card } = await artifacts(f.snapshot);
    await f.store.putArtifact("SOURCE_CARD", card);
    await expect(createD1NavigationStore({ ...f.input, now: () => Date.parse(f.snapshot.expires_at) }).getSourceCards(["revision-1"]))
      .rejects.toBeInstanceOf(Error);
    const badCurrent = createD1NavigationStore({ ...f.input, require_current: async (scope) => ({ ...scope, digest: "f".repeat(64) }) });
    await expect(badCurrent.getSourceCards(["revision-1"])).rejects.toBeInstanceOf(Error);
    await db.prepare("UPDATE scope_access_grant SET state='REVOKED'").run();
    await expect(f.store.getSourceCards(["revision-1"])).rejects.toBeInstanceOf(Error);
  });
  it("discards data when access is revoked after the payload read", async () => {
    const f = await fixture(); await grant(f.snapshot); const { card } = await artifacts(f.snapshot);
    await f.store.putArtifact("SOURCE_CARD", card);
    let revoked = false;
    const raced = wrappedDatabase(async (sql, phase) => {
      if (!revoked && phase === "after" && sql.startsWith("SELECT artifact_kind") && sql.includes(", body_json,")) {
        revoked = true; await db.prepare("UPDATE scope_access_grant SET state='REVOKED'").run();
      }
    });
    await expect(createD1NavigationStore({ ...f.input, database: raced }).getSourceCards(["revision-1"])).rejects.toBeInstanceOf(Error);
    expect(revoked).toBe(true);
  });
  it("rechecks scope at the end of navigation even with an in-memory store", async () => {
    const f = await fixture(); await grant(f.snapshot); const { card } = await artifacts(f.snapshot); await f.store.putArtifact("SOURCE_CARD", card);
    const raced = { ...f.store, async getDocumentMaps(refs: readonly string[]) {
      const result = await f.store.getDocumentMaps(refs); await db.prepare("UPDATE scope_access_grant SET state='REVOKED'").run(); return result;
    } };
    await expect(createNavigationService(raced).orient({ scope_snapshot: f.snapshot, focus_terms: [], maximum_sources: 1 }))
      .rejects.toMatchObject({ code: "NAVIGATION_SCOPE_NOT_CURRENT" });
  });
  it("exposes only an exact existing section handle, still ineligible for publication", async () => {
    const f = await fixture(); await grant(f.snapshot); const { map } = await artifacts(f.snapshot);
    await f.store.putArtifact("DOCUMENT_MAP", map); await seedHandle(f.snapshot);
    const service = createD1NavigationService({ ...f.input, scopes: f.scopes });
    const request = { kind: "SECTION" as const, scope_snapshot: f.snapshot, source_revision_ref: "revision-1", section_ref: "intro" };
    expect((await service.expand(request)).support).toMatchObject({ kind: "EVIDENCE_HANDLE_CANDIDATE", publication_eligible: false });
    await db.prepare("UPDATE evidence_handle SET anchor_json=?1").bind(canonicalNavigationJson({ kind: "normalized_byte_range", start: 1, end: 10 })).run();
    expect((await service.expand(request)).support.kind).toBe("NAVIGATION_ONLY");
  });
  it("keeps concurrent principal/snapshot stores isolated and pins supplied objects", async () => {
    const f = await fixture(); await grant(f.snapshot); const { card } = await artifacts(f.snapshot);
    await f.store.putArtifact("SOURCE_CARD", card);
    const changed = structuredClone(f.snapshot);
    const reader = createD1NavigationStore({ ...f.input, scope_snapshot: changed });
    changed.snapshot_id = "tampered";
    expect(await reader.getSourceCards(["revision-1"])).toEqual([card]);
    const other = createD1NavigationStore({ ...f.input, access: { ...access, principal_ref: "other" } });
    const outcomes = await Promise.allSettled([reader.getSourceCards(["revision-1"]), other.getSourceCards(["revision-1"])]);
    expect(outcomes.map((outcome) => outcome.status)).toEqual(["fulfilled", "rejected"]);
    await expect(reader.requireCurrentScopeSnapshot(changed)).rejects.toBeInstanceOf(Error);
    await expect(reader.getSourceCards(["outside"])).rejects.toBeInstanceOf(Error);
  });
  it("detects corrupted rows even when the stored whole-body digest is recomputed", async () => {
    const f = await fixture(); await grant(f.snapshot); const { card } = await artifacts(f.snapshot); await f.store.putArtifact("SOURCE_CARD", card);
    const row = await db.prepare("SELECT * FROM navigation_artifact").first<Record<string, string | number>>();
    if (!row) throw new Error("missing row");
    const body = canonicalNavigationJson({ ...card, title: "forged stored title" });
    await db.prepare("DELETE FROM navigation_artifact").run();
    await db.prepare(`INSERT INTO navigation_artifact (${Object.keys(row).join(",")}) VALUES (${Object.keys(row).map((_, i) => `?${i + 1}`).join(",")})`)
      .bind(...Object.values({ ...row, body_json: body, body_digest: await evidenceSha256Bytes(evidenceUtf8Bytes(body)) })).run();
    await expect(f.store.getSourceCards(["revision-1"])).rejects.toBeInstanceOf(Error);
  });
  it("blocks source-owner and grant changes between preflight and INSERT", async () => {
    const f = await fixture(); await grant(f.snapshot); const { card } = await artifacts(f.snapshot);
    let attempts = 0;
    const raced = wrappedDatabase(async (sql, phase) => {
      if (sql.startsWith("INSERT INTO navigation_artifact") && phase === "before") {
        attempts += 1; await db.prepare("UPDATE source_namespace_ownership SET status='FENCED'").run();
      }
    });
    await expect(createD1NavigationStore({ ...f.input, database: raced }).putArtifact("SOURCE_CARD", card)).rejects.toBeInstanceOf(Error);
    expect(attempts).toBe(1); expect(await countArtifacts()).toBe(0);
    await db.prepare("UPDATE source_namespace_ownership SET status='ACTIVE'").run();
    const revoked = wrappedDatabase(async (sql, phase) => {
      if (sql.startsWith("INSERT INTO navigation_artifact") && phase === "before") {
        await db.prepare("UPDATE scope_access_grant SET state='REVOKED'").run();
      }
    });
    await expect(createD1NavigationStore({ ...f.input, database: revoked }).putArtifact("SOURCE_CARD", card)).rejects.toBeInstanceOf(Error);
    expect(await countArtifacts()).toBe(0);
  });
  it("bounds raw stored admission data before hydration", async () => {
    const f = await fixture(); await grant(f.snapshot); const { card } = await artifacts(f.snapshot);
    await db.prepare("UPDATE source_admission_decision SET decision_json=?1").bind(JSON.stringify({ padding: "x".repeat(65_537) })).run();
    await expect(f.store.putArtifact("SOURCE_CARD", card)).rejects.toBeInstanceOf(Error);
    expect(await countArtifacts()).toBe(0);
  });
  it("refuses a multi-artifact load beyond its aggregate budget before fetching bodies", async () => {
    const f = await fixture(); await grant(f.snapshot); const { card } = await artifacts(f.snapshot);
    let payloadFetched = false;
    const tooLarge = { prepare(sql: string) {
      if (!sql.includes("FROM navigation_artifact")) return db.prepare(sql);
      return { bind() { return { async all() {
        if (sql.includes(", body_json,")) { payloadFetched = true; throw new Error("must not fetch bodies"); }
        return { success: true, results: Array.from({ length: 5 }, (_, i) => ({ artifact_kind: "SOURCE_CARD", subject_id: `revision-${i}`,
          subject_revision: 1, artifact_id: `card-${i}`, artifact_revision: 1, body_digest: "a".repeat(64), stored_bytes: 1_000_000 })) };
      } }; } };
    } } as unknown as D1Database;
    await expect(createD1NavigationStore({ ...f.input, database: tooLarge }).getSourceCardsByRefs(
      Array.from({ length: 5 }, (_, i) => ({ ...card.card_ref, id: `card-${i}` }))))
      .rejects.toMatchObject({ code: "NAVIGATION_LIMIT_EXCEEDED" });
    expect(payloadFetched).toBe(false);
  });
  it("materializes honest structural navigation from admitted bytes with replay, conflict and race fences", async () => {
    const f = await fixture(); await grant(f.snapshot);
    const markdown = "# Введение\n\nПривет мир.\n\n## Details\n\nBody with `code` and table:\n\n| a | b |\n";
    const markdownSha = [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(markdown)))]
      .map((byte) => byte.toString(16).padStart(2, "0")).join("");
    await db.prepare("UPDATE source_revision SET content_sha256=?1 WHERE source_revision_ref='revision-1'").bind(markdownSha).run();
    const revision = { ...source("revision-1"), content_sha256: markdownSha };
    const derived = await materializeStructuralNavigation({
      source_revision: revision,
      scope_snapshot: f.snapshot,
      normalized_markdown: markdown,
      generator_generation: "navigation-1",
      created_at: TIME,
    });
    // Every claimed coordinate reopens the exact admitted bytes.
    const bytes = new TextEncoder().encode(markdown);
    for (const section of derived.documentMap.section_hierarchy) {
      const record = section as Record<string, unknown>;
      const start = record.normalized_start_byte as number;
      const end = record.normalized_end_byte as number;
      expect(end).toBeGreaterThan(start);
      expect(new TextDecoder("utf-8", { fatal: true }).decode(bytes.slice(start, end)).length).toBeGreaterThan(0);
    }
    expect(derived.documentMap.page_ranges).toEqual([]);
    expect(derived.documentMap.tables).toEqual([]);
    expect(derived.documentMap.unresolved_structure.length).toBeGreaterThan(0);
    expect(await f.store.putArtifact("SOURCE_CARD", derived.sourceCard)).toBe("CREATED");
    expect(await f.store.putArtifact("DOCUMENT_MAP", derived.documentMap)).toBe("CREATED");
    expect(await f.store.putArtifact("SOURCE_CARD", derived.sourceCard)).toBe("REPLAY");
    expect(await countArtifacts()).toBe(2);
    const readBack = await f.store.getDocumentMaps(["revision-1"]);
    expect(readBack).toEqual([derived.documentMap]);
    // Same identity with different canonical bytes fails closed without a second artifact.
    const otherMarkdown = "# Введение\n\nOther bytes.\n";
    await expect(materializeStructuralNavigation({
      source_revision: revision,
      scope_snapshot: f.snapshot,
      normalized_markdown: otherMarkdown,
      generator_generation: "navigation-1",
      created_at: TIME,
    })).rejects.toMatchObject({ code: "NAVIGATION_SOURCE_MISMATCH" });
    expect(await countArtifacts()).toBe(2);
    // Purge change between load and save yields zero new usable artifact.
    await db.prepare("UPDATE source_revision SET purge_state='PURGE_REQUESTED' WHERE source_revision_ref='revision-1'").run();
    await expect(f.store.putArtifact("SOURCE_CARD", derived.sourceCard)).rejects.toBeInstanceOf(Error);
    await expect(f.store.getSourceCards(["revision-1"])).rejects.toBeInstanceOf(Error);
  });
  it("reads the admitted R2 bundle through the supported contour into real D1 artifacts", async () => {
    const f = await fixture(["revision-r2a"]); await grant(f.snapshot);
    const markdown = ["# Введение", "", "Привет мир.", "", "## Details", "", "English body with `code`:",
      "", "| a | b |", "|---|---|", "| 1 | 2 |", "", "```ts", "const x = 1;", "# not a heading", "```", "",
      "## Заключение", "", "Финальный текст.", ""].join("\n");
    const staged = await stageBundle("revision-r2a", markdown);
    const outcome = await materializeStructuralNavigationBatch({ store: f.store, database: db, snapshot: f.snapshot,
      sources: [contourSource(staged)], evidence_bucket: bucket });
    expect(outcome.structural).toHaveLength(1);
    expect(outcome.metadata_only).toHaveLength(0);
    expect(await countArtifacts()).toBe(2);
    // Deterministic replay through the same contour reuses the persisted identities.
    const replay = await materializeStructuralNavigationBatch({ store: f.store, database: db, snapshot: f.snapshot,
      sources: [contourSource(staged)], evidence_bucket: bucket });
    expect(replay.structural).toHaveLength(1);
    expect(await countArtifacts()).toBe(2);
    // Restart readback across store instances reopens the same bytes; fence text never became a section.
    const reader = createD1NavigationStore(f.input);
    const cards = await reader.getSourceCards(["revision-r2a"]);
    const maps = await reader.getDocumentMaps(["revision-r2a"]);
    expect(cards).toHaveLength(1);
    expect(maps).toHaveLength(1);
    expect(JSON.stringify(maps[0])).not.toMatch(/not a heading/u);
    const original = await bucket.get(staged.key);
    if (!original) throw new Error("staged bundle vanished");
    const originalBytes = new Uint8Array(await original.arrayBuffer());
    expect(await evidenceSha256Bytes(originalBytes)).toBe(staged.digest);
    for (const section of (maps[0] as unknown as { section_hierarchy: Record<string, unknown>[] }).section_hierarchy) {
      const start = section.normalized_start_byte as number;
      const end = section.normalized_end_byte as number;
      const reopened = await bucket.get(staged.key, { range: { offset: start, length: end - start } });
      if (!reopened) throw new Error("range reopen vanished");
      expect(new Uint8Array(await reopened.arrayBuffer())).toEqual(originalBytes.slice(start, end));
      expect(end).toBeGreaterThan(start);
    }
    expect((maps[0] as unknown as { page_ranges: unknown[] }).page_ranges).toEqual([]);
    expect((maps[0] as unknown as { tables: unknown[] }).tables).toEqual([]);
    // The orientation read path reopens structural artifacts, never metadata-only placeholders.
    const service = createD1NavigationService({ ...f.input, scopes: f.scopes });
    const expanded = await service.expand({ kind: "DOCUMENT_MAP", scope_snapshot: f.snapshot, source_revision_ref: "revision-r2a" });
    expect(expanded.support).toMatchObject({ kind: "NAVIGATION_ONLY", publication_eligible: false });
    if (expanded.kind !== "DOCUMENT_MAP") throw new Error("wrong expansion kind");
    expect(expanded.sections.length).toBeGreaterThanOrEqual(3);
    // Overwriting the immutable key with divergent bytes fails closed; the admitted artifacts survive.
    await bucket.put(staged.key, new TextEncoder().encode("# Введение\n\nTampered.\n"));
    await expect(materializeStructuralNavigationBatch({ store: f.store, database: db, snapshot: f.snapshot,
      sources: [contourSource(staged)], evidence_bucket: bucket }))
      .rejects.toMatchObject({ code: "NAVIGATION_SOURCE_MISMATCH" });
    expect(await countArtifacts()).toBe(2);
    expect(await reader.getDocumentMaps(["revision-r2a"])).toEqual(maps);
  });
  it("fails closed on altered, foreign and missing R2 and manifest bindings", async () => {
    const f = await fixture(["revision-r2b", "revision-r2c", "revision-r2d", "revision-r2e"]); await grant(f.snapshot);
    const run = (staged: StagedBundle) => materializeStructuralNavigationBatch({ store: f.store, database: db,
      snapshot: f.snapshot, sources: [contourSource(staged)], evidence_bucket: bucket });
    // Altered body under the admitted key: stale digest metadata, correct size envelope.
    const altered = await stageBundle("revision-r2b", "# Title B\n\nBody B.\n");
    const tamperedBytes = new TextEncoder().encode("# Title B\n\nBody B altered.\n");
    await bucket.put(altered.key, tamperedBytes, {
      httpMetadata: { contentType: "text/markdown; charset=utf-8" },
      customMetadata: { eliotr_sha256: altered.digest, eliotr_size_bytes: String(tamperedBytes.byteLength),
        eliotr_immutable: "true", source_namespace_id: "namespace-revision-r2b",
        source_owner_generation: "owner-generation-1", admission_receipt_ref: "decision-revision-r2b" },
    });
    await expect(run(altered)).rejects.toMatchObject({ code: "NAVIGATION_SOURCE_MISMATCH" });
    // Foreign owner generation in the immutable metadata.
    const foreign = await stageBundle("revision-r2c", "# Title C\n\nBody C.\n",
      { source_owner_generation: "owner-generation-foreign" });
    await expect(run(foreign)).rejects.toMatchObject({ code: "NAVIGATION_SOURCE_MISMATCH" });
    // Manifest-referenced coordinate map that was never staged.
    const missingMap = await stageBundle("revision-r2d", "# Title D\n\nBody D.\n");
    const missingMapKey = await stageManifest("revision-r2d", missingMap.digest, "coordinate-map.json", await shaHex("map"), false);
    const missingMapUpdated: StagedBundle = { ...missingMap,
      authority: { ...missingMap.authority, normalized_artifact_ref: missingMapKey } };
    await expect(materializeStructuralNavigationBatch({ store: f.store, database: db,
      snapshot: f.snapshot, sources: [contourSource(missingMapUpdated)], evidence_bucket: bucket }))
      .rejects.toMatchObject({ code: "NAVIGATION_SOURCE_MISMATCH" });
    // Foreign manifest origin plus altered coordinate digest.
    const foreignManifest = await stageBundle("revision-r2e", "# T\n\nBody.\n");
    const foreignKey = await stageManifest("revision-r2e", foreignManifest.digest, undefined, undefined, false, "foreign-revision");
    const foreignManifestUpdated: StagedBundle = { ...foreignManifest,
      authority: { ...foreignManifest.authority, normalized_artifact_ref: foreignKey } };
    await expect(materializeStructuralNavigationBatch({ store: f.store, database: db,
      snapshot: f.snapshot, sources: [contourSource(foreignManifestUpdated)], evidence_bucket: bucket }))
      .rejects.toMatchObject({ code: "NAVIGATION_SOURCE_MISMATCH" });
    expect(await countArtifacts()).toBe(0);
    // An honestly staged manifest with an exact coordinate map persists native anchors and nothing inferred.
    const exact = await stageBundle("revision-r2b", "# Title B\n\nBody B.\n");
    const exactBytes = new TextEncoder().encode("# Title B\n\nBody B.\n");
    const mapJson = JSON.stringify([{ normalized_start_byte: 0, normalized_end_byte: exactBytes.byteLength,
      precision: "EXACT", native_anchor: { page: 1 } }]);
    const exactKey = await stageManifest("revision-r2b", exact.digest, "coordinate-map.json", await shaHex(mapJson), true,
      "revision-r2b", mapJson);
    const exactUpdated: StagedBundle = { ...exact,
      revision: { ...exact.revision, normalized_artifact_ref: exactKey },
      authority: { ...exact.authority, normalized_artifact_ref: exactKey } };
    const ok = await materializeStructuralNavigationBatch({ store: f.store, database: db,
      snapshot: f.snapshot, sources: [contourSource(exactUpdated)], evidence_bucket: bucket });
    expect(ok.structural).toHaveLength(1);
    const maps = await f.store.getDocumentMaps(["revision-r2b"]);
    expect(JSON.stringify(maps[0])).toMatch(/"page":1/u);
    expect(JSON.stringify(maps[0])).not.toMatch(/bbox|table_cell/u);
  });
  it("fails closed on LUNA per-file key, MIME, metadata, residency and missing-manifest bindings", async () => {
    const f = await fixture(["revision-luna"]); await grant(f.snapshot);
    const run = (staged: StagedBundle) => materializeStructuralNavigationBatch({ store: f.store, database: db,
      snapshot: f.snapshot, sources: [contourSource(staged)], evidence_bucket: bucket });
    const base = await stageBundle("revision-luna", "# Luna\n\nBody.\n");
    // Distinct per-file promoted keys/digests: manifest key must differ from content key.
    expect(base.manifestKey).not.toBe(base.key);
    expect(base.manifestDigest).not.toBe(base.digest);
    expect(base.contentResidencyDigest).toBe(base.authority.object_residency_key_digest);
    // Missing manifest for an admitted bundle fails closed (no content-only structural success).
    await bucket.delete(base.manifestKey);
    await expect(run(base)).rejects.toMatchObject({ code: "NAVIGATION_ARTIFACT_NOT_FOUND" });
    expect(await countArtifacts()).toBe(0);
    // Restore the admitted manifest for the remaining negatives.
    const restored = await stageBundle("revision-luna", "# Luna\n\nBody.\n");
    // Wrong per-file key: manifest bytes under the content residency digest are unfindable.
    const wrongKey = await canonicalNormalizedBundleKey(restored.contentResidencyDigest,
      { owner_system_id: "owner-system-1", source_namespace_id: "namespace-revision-luna",
        source_owner_generation: "owner-generation-1", source_logical_id: "source-revision-luna",
        source_revision_ref: "revision-luna" }, "manifest.json");
    expect(wrongKey).not.toBe(restored.manifestKey);
    expect(await bucket.get(wrongKey)).toBeNull();
    // Wrong MIME on the admitted manifest fails closed: first the rewrite is
    // rejected as a substituted object at the readback identity, then — after
    // rebinding the durable receipt to the rewritten bytes — the media-type
    // gate itself rejects the wrong type. Neither downgrades to metadata.
    const manifestObject = await bucket.get(restored.manifestKey);
    if (!manifestObject) throw new Error("manifest vanished");
    const manifestBytes = new Uint8Array(await manifestObject.arrayBuffer());
    const wrongMimePut = await bucket.put(restored.manifestKey, manifestBytes, {
      httpMetadata: { contentType: "text/markdown; charset=utf-8" },
      customMetadata: { eliotr_sha256: restored.manifestDigest,
        eliotr_size_bytes: String(manifestBytes.byteLength), eliotr_immutable: "true",
        source_namespace_id: "namespace-revision-luna", source_owner_generation: "owner-generation-1",
        admission_receipt_ref: "decision-revision-luna" } });
    if (!wrongMimePut?.etag) throw new Error("wrong-MIME readback lost its ETag");
    await expect(run(restored)).rejects.toMatchObject({ code: "NAVIGATION_SOURCE_MISMATCH" });
    expect(await countArtifacts()).toBe(0);
    const rebindRow = await db.prepare("SELECT bundle_receipt_json FROM bundle_ingest_operation WHERE operation_id='op-revision-luna'")
      .first<{ bundle_receipt_json: string }>();
    if (!rebindRow) throw new Error("durable receipt vanished");
    const rebindReceipt = JSON.parse(rebindRow.bundle_receipt_json) as { promoted_objects: Record<string, unknown>[] };
    for (const entry of rebindReceipt.promoted_objects) {
      if (entry.logical_path === "manifest.json") {
        entry.etag = wrongMimePut.etag;
        const rewritten = versionOf(wrongMimePut);
        if (rewritten.version === undefined) delete entry.version;
        else entry.version = rewritten.version;
      }
    }
    const rebindJson = canonicalEvidenceJson(rebindReceipt);
    await db.prepare("UPDATE bundle_ingest_operation SET bundle_receipt_json=?1, bundle_receipt_sha256=?2 WHERE operation_id='op-revision-luna'")
      .bind(rebindJson, await shaHex(rebindJson)).run();
    await expect(run(restored)).rejects.toMatchObject({ code: "NAVIGATION_ARTIFACT_INVALID" });
    expect(await countArtifacts()).toBe(0);
    // Missing mandatory namespace metadata fails closed. The rewrite mints a
    // fresh R2 version, so the durable readback-identity reconciliation rejects
    // the substituted object before metadata inspection is even reached.
    const clean = await stageBundle("revision-luna", "# Luna\n\nBody.\n");
    const cleanManifest = await bucket.get(clean.manifestKey);
    if (!cleanManifest) throw new Error("clean manifest vanished");
    const cleanBytes = new Uint8Array(await cleanManifest.arrayBuffer());
    await bucket.put(clean.manifestKey, cleanBytes, {
      httpMetadata: { contentType: "application/json; charset=utf-8" },
      customMetadata: { eliotr_sha256: clean.manifestDigest,
        eliotr_size_bytes: String(cleanBytes.byteLength), eliotr_immutable: "true",
        source_owner_generation: "owner-generation-1",
        admission_receipt_ref: "decision-revision-luna" } });
    await expect(run(clean)).rejects.toMatchObject({ code: "NAVIGATION_SOURCE_MISMATCH" });
    expect(await countArtifacts()).toBe(0);
    // Residency/disclosure mismatch fails closed.
    const resident = await stageBundle("revision-luna", "# Luna\n\nBody.\n");
    await db.prepare("UPDATE source_revision SET object_residency_key_digest=?1 WHERE source_revision_ref='revision-luna'")
      .bind("c".repeat(64)).run();
    const residentTampered: StagedBundle = { ...resident,
      authority: { ...resident.authority, object_residency_key_digest: "c".repeat(64) } };
    await expect(run(residentTampered)).rejects.toMatchObject({ code: "NAVIGATION_SOURCE_MISMATCH" });
    expect(await countArtifacts()).toBe(0);
  });
  it("denies barrier changes with zero usable artifacts and parses fences honestly", async () => {
    const f = await fixture(["revision-r2f"]); await grant(f.snapshot);
    const staged = await stageBundle("revision-r2f", "# Fences\n\nBody.\n");
    const run = () => materializeStructuralNavigationBatch({ store: f.store, database: db, snapshot: f.snapshot,
      sources: [contourSource(staged)], evidence_bucket: bucket });
    await db.prepare("UPDATE scope_access_grant SET state='REVOKED'").run();
    await expect(run()).rejects.toBeInstanceOf(Error);
    await db.prepare("UPDATE scope_access_grant SET state='ACTIVE'").run();
    await db.prepare("UPDATE scope_snapshot SET invalidated_at=?1, invalidation_reason='PURGED'").bind(TIME).run();
    await expect(run()).rejects.toBeInstanceOf(Error);
    expect(await countArtifacts()).toBe(0);
    // Pure CommonMark fence matrix plus code-point-safe truncation.
    const fenceCases: { readonly markdown: string; readonly labels: readonly string[] }[] = [
      { markdown: "```\n# hidden\n~~~\n# still hidden\n```\n\n# Shown\n", labels: ["Shown"] },
      { markdown: "````\n# hidden\n```\n# still hidden\n````\n", labels: ["Source revision-r2f"] },
      { markdown: "```\n# hidden\n`````\n\n# Shown\n", labels: ["Shown"] },
      { markdown: "```\n# hidden\n   ```\n\n# Shown\n", labels: ["Shown"] },
      { markdown: "```ts\nconst x = 1;\n```js\n# hidden\n```\n\n# Shown\n", labels: ["Shown"] },
      { markdown: "```a`b\n# Shown\n", labels: ["Shown"] },
      { markdown: "```\n# hidden to EOF\n", labels: ["Source revision-r2f"] },
    ];
    for (const fenceCase of fenceCases) {
      const digest = await shaHex(fenceCase.markdown);
      const revision = { ...source("revision-r2f"), content_sha256: digest };
      const derived = await materializeStructuralNavigation({ source_revision: revision,
        scope_snapshot: f.snapshot, normalized_markdown: fenceCase.markdown,
        generator_generation: "navigation-1", created_at: TIME });
      const labels = derived.documentMap.section_hierarchy.map((section) =>
        (section as Record<string, unknown>).label as string).filter((label) => label !== "Preamble");
      expect(labels).toEqual(fenceCase.labels);
    }
    const emojiTitle = `# ${"A".repeat(250)}${"😀".repeat(10)}\n\nBody.\n`;
    const emojiDigest = await shaHex(emojiTitle);
    const emojiDerived = await materializeStructuralNavigation({
      source_revision: { ...source("revision-r2f"), content_sha256: emojiDigest },
      scope_snapshot: f.snapshot, normalized_markdown: emojiTitle,
      generator_generation: "navigation-1", created_at: TIME });
    const cardTitle = emojiDerived.sourceCard.title;
    expect(Array.from(cardTitle).length).toBeLessThanOrEqual(256);
    expect(cardTitle).toBe(Array.from(`# ${"A".repeat(250)}${"😀".repeat(10)}`.slice(2)).slice(0, 256).join(""));
    expect(cardTitle).not.toMatch(/�/u);
  });
});
