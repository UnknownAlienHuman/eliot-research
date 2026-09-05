import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createD1NavigationStore, evidenceSha256Bytes, evidenceUtf8Bytes } from "@eliotr/cloudflare-evidence";
import { canonicalNavigationJson, projectAtlasIdentity, requireResolvedEvidenceForPublication } from "@eliotr/retrieval";
import { createD1NavigationService } from "../src/navigation-persistence.js";
import { createNavigationService } from "../src/navigation-service.js";
import { access, artifacts, clearDatabase, countArtifacts, db, fixture, grant, project,
  seedHandle, setupDatabase, TIME, wrappedDatabase } from "./navigation-fixture.js";

beforeAll(setupDatabase);
beforeEach(clearDatabase);
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

});
