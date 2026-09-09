import { applyD1Migrations } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { createD1NavigationStore, readAdmittedCoordinateMap, readAdmittedNormalizedMarkdown } from "@eliotr/cloudflare-evidence";
import {
  createD1ScopeService,
  createOwnerScopeAuthority,
  materializeStructuralNavigation,
} from "@eliotr/cloudflare-navigation";
import { canonicalNormalizedBundleKey } from "@eliotr/platform-cloudflare";
import { extractNavigationSections, materializeStructuralNavigation as deriveStructuralNavigation, MAX_CANONICAL_BYTES } from "@eliotr/retrieval";
import {
  importAndProject,
  prepareQ1Namespace,
  type Q1Runtime,
} from "./retrieval-q1-fixture.js";
import { env } from "cloudflare:workers";
import type { Env } from "../src/env.js";
import { persistCoordinateMap } from "@eliotr/cloudflare-navigation";

interface Migration { readonly name: string; readonly queries: string[]; }

const runtime = env as unknown as Env & {
  readonly CORE_MIGRATIONS: Migration[];
  readonly SEARCH_MIGRATIONS: Migration[];
};
const owner = "n1-q1-owner";
const access = { principal_ref: owner, client_class: "owner_pwa" as const, credential_generation: "credential-1" };

async function normalizedContentKey(source: {
  readonly authority: {
    readonly object_residency_key_digest: string;
    readonly owner_system_id: string;
    readonly source_namespace_id: string;
    readonly source_owner_generation: string;
    readonly source_id: string;
    readonly source_revision_ref: string;
  };
}): Promise<string> {
  return canonicalNormalizedBundleKey(source.authority.object_residency_key_digest, {
    owner_system_id: source.authority.owner_system_id,
    source_namespace_id: source.authority.source_namespace_id,
    source_owner_generation: source.authority.source_owner_generation,
    source_logical_id: source.authority.source_id,
    source_revision_ref: source.authority.source_revision_ref,
  }, "content.md");
}

async function digestBytes(bytes: Uint8Array): Promise<string> {
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes.buffer as ArrayBuffer))]
    .map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

beforeEach(async () => {
  await applyD1Migrations(runtime.CORE_DB, runtime.CORE_MIGRATIONS);
  await applyD1Migrations(runtime.SEARCH_DB, runtime.SEARCH_MIGRATIONS);
});

async function preparedNavigation() {
  const world = {
    runtime: runtime as Q1Runtime,
    db: runtime.CORE_DB,
    searchDb: runtime.SEARCH_DB,
    owner,
    ...(await prepareQ1Namespace(runtime as Q1Runtime, runtime.CORE_DB, runtime.SEARCH_DB, owner)),
  };
  await importAndProject(world);
  await runtime.CORE_DB.prepare(
    "INSERT INTO scope_read_policy (source_namespace_id,principal_ref,client_class,policy_ref,generation," +
      "allowed_use_json,disclosure_ceiling,state,expires_at,created_at) VALUES (?1,?2,'owner_pwa',?3,1,'[\"research\"]','owner-only','ACTIVE',?4,?5)",
  ).bind(world.namespace, owner, `n1-policy-${world.namespace}`, "2099-01-01T00:00:00.000Z", "2026-09-09T00:00:00.000Z").run();
  const authority = createOwnerScopeAuthority(runtime.CORE_DB, access);
  const scopes = createD1ScopeService(runtime.CORE_DB, authority);
  const snapshot = await scopes.freeze({ kind: "SELECTED_SOURCES", source_ids: [`source-${world.namespace}`] }, access.credential_generation);
  const sources = await authority.exhaustiveSources([world.revision]);
  const source = sources[0];
  if (source === undefined) throw new Error("missing Q1 source authority");
  await authority.exhaustiveGrant(snapshot);
  const store = createD1NavigationStore({ database: runtime.CORE_DB, scope_snapshot: snapshot, access,
    require_current: (scope) => scopes.requireCurrent(scope) });
  return { world, authority, snapshot, sources, source, store };
}

describe("N1 structural navigation over the real Q1 import path", () => {
  it("reads the imported map from its canonical R2 key and persists the adapted map in D1", async () => {
    const { snapshot, sources, source, store } = await preparedNavigation();
    if (source === undefined) throw new Error("missing Q1 source authority");
    const content = await readAdmittedNormalizedMarkdown(runtime.EVIDENCE_BUCKET, source.authority);
    const derived = await deriveStructuralNavigation({
      source_revision: source.revision, scope_snapshot: snapshot, normalized_markdown: content.markdown,
      source_kind: "document", generator_generation: "structural-v1", created_at: snapshot.created_at,
    });
    const admitted = await readAdmittedCoordinateMap(runtime.EVIDENCE_BUCKET, source.authority);
    await store.putArtifact("SOURCE_CARD", derived.sourceCard);
    const merged = await persistCoordinateMap({ store, source_revision: source.revision,
      structural_map: derived.documentMap, admitted_map: admitted, generator_generation: "coordinate-v1", created_at: snapshot.created_at });
    expect(merged.tables).toEqual([expect.objectContaining({ coordinate_kind: "table_cell", table_id: "q1-table",
      normalized_start_byte: 0, normalized_end_byte: content.size_bytes, navigation_authority: "NAVIGATION_ONLY" })]);
    const reopened = await store.getDocumentMaps([sources[0]?.revision.source_revision_ref ?? ""]);
    expect(reopened[0]).toMatchObject({ mappings_to_original_ref: admitted.map_object_ref });
  });

  it("reads admitted R2 bytes, persists exact maps, replays immutably, and rejects purge", async () => {
    const world = {
      runtime: runtime as Q1Runtime,
      db: runtime.CORE_DB,
      searchDb: runtime.SEARCH_DB,
      owner,
      ...(await prepareQ1Namespace(runtime as Q1Runtime, runtime.CORE_DB, runtime.SEARCH_DB, owner)),
    };
    const { namespace, revision } = world;
    await importAndProject(world);
    await runtime.CORE_DB.prepare(
      "INSERT INTO scope_read_policy (source_namespace_id,principal_ref,client_class,policy_ref,generation," +
        "allowed_use_json,disclosure_ceiling,state,expires_at,created_at) VALUES (?1,?2,'owner_pwa',?3,1,'[\"research\"]','owner-only','ACTIVE',?4,?5)",
    ).bind(namespace, owner, `n1-policy-${namespace}`, "2099-01-01T00:00:00.000Z", "2026-09-09T00:00:00.000Z").run();

    const authority = createOwnerScopeAuthority(runtime.CORE_DB, access);
    const scopes = createD1ScopeService(runtime.CORE_DB, authority);
    const snapshot = await scopes.freeze({ kind: "SELECTED_SOURCES", source_ids: [`source-${namespace}`] }, access.credential_generation);
    const sources = await authority.exhaustiveSources([revision]);
    expect(sources).toHaveLength(1);
    await authority.exhaustiveGrant(snapshot);
    const store = createD1NavigationStore({ database: runtime.CORE_DB, scope_snapshot: snapshot, access,
      require_current: (scope) => scopes.requireCurrent(scope) });

    const first = await materializeStructuralNavigation(store, snapshot, sources, { evidence_bucket: runtime.EVIDENCE_BUCKET });
    expect(first).toEqual([{ source_revision_ref: revision, section_count: expect.any(Number), replay_safe: true }]);
    const firstCount = await runtime.CORE_DB.prepare("SELECT COUNT(*) AS n FROM navigation_artifact WHERE scope_snapshot_id=?1")
      .bind(snapshot.snapshot_id).first<number>("n");
    expect(firstCount).toBe(2);

    const rawMaps = await store.getDocumentMaps([revision]);
    const sections = extractNavigationSections(rawMaps[0]);
    expect(sections.length).toBeGreaterThan(0);
    const source = sources[0];
    if (!source) throw new Error("missing Q1 source authority");
    const contentKey = await normalizedContentKey(source);
    const contentObject = await runtime.EVIDENCE_BUCKET.get(contentKey);
    if (contentObject === null) throw new Error("missing admitted normalized content");
    const contentBytes = new Uint8Array(await contentObject.arrayBuffer());
    expect(sections.map((section) => ({
      label: section.label,
      start: section.normalized_start_byte,
      end: section.normalized_end_byte,
    }))).toEqual([{ label: "Evidence", start: 0, end: contentBytes.byteLength }]);
    for (const section of sections) {
      const start = section.normalized_start_byte;
      const end = section.normalized_end_byte;
      if (start === undefined || end === undefined) throw new Error("structural section has no exact byte range");
      expect(new TextDecoder().decode(contentBytes.slice(start, end))).toBe("# Evidence\n\nPinned content.\n");
    }
    const second = await materializeStructuralNavigation(store, snapshot, sources, { evidence_bucket: runtime.EVIDENCE_BUCKET });
    expect(second).toEqual(first);
    const secondCount = await runtime.CORE_DB.prepare("SELECT COUNT(*) AS n FROM navigation_artifact WHERE scope_snapshot_id=?1")
      .bind(snapshot.snapshot_id).first<number>("n");
    expect(secondCount).toBe(2);

    await runtime.CORE_DB.prepare("UPDATE source_revision SET purge_state='PURGE_REQUESTED' WHERE source_revision_ref=?1").bind(revision).run();
    await expect(store.getDocumentMaps([revision])).rejects.toMatchObject({ code: "NAVIGATION_STORE_FAILED" });
  });

  it("rejects an owner withdrawal that occurs during the admitted R2 read", async () => {
    const { world, snapshot, sources, source, store } = await preparedNavigation();
    const contentKey = await normalizedContentKey(source);
    let withdrawn = false;
    const bucket = {
      async head(key: string) {
        return runtime.EVIDENCE_BUCKET.head(key);
      },
      async get(key: string, options?: R2GetOptions) {
        const result = await runtime.EVIDENCE_BUCKET.get(key, options);
        if (!withdrawn && key === contentKey && options?.range !== undefined) {
          withdrawn = true;
          await runtime.CORE_DB.prepare(
            "UPDATE source_namespace_ownership SET status='RETIRED' WHERE source_namespace_id=?1",
          ).bind(world.namespace).run();
        }
        return result;
      },
    } as unknown as R2Bucket;

    await expect(materializeStructuralNavigation(store, snapshot, sources, { evidence_bucket: bucket }))
      .rejects.toBeDefined();
    const persisted = await runtime.CORE_DB.prepare(
      "SELECT COUNT(*) AS n FROM navigation_artifact WHERE scope_snapshot_id=?1",
    ).bind(snapshot.snapshot_id).first<{ readonly n: number }>("n");
    expect(withdrawn).toBe(true);
    expect(persisted).toBe(0);
  });

  it("rejects same-key changed bytes and enforces the reader max boundary", async () => {
    const { source } = await preparedNavigation();
    const contentKey = await normalizedContentKey(source);
    const original = await runtime.EVIDENCE_BUCKET.get(contentKey);
    if (original === null) throw new Error("missing admitted normalized content");
    const changed = new TextEncoder().encode("# Evidence\n\nChanged bytes.\n");
    const changedDigest = await digestBytes(changed);
    await runtime.EVIDENCE_BUCKET.put(contentKey, changed, {
      sha256: changedDigest,
      httpMetadata: { contentType: "text/markdown; charset=utf-8" },
      customMetadata: { ...original.customMetadata, eliotr_sha256: source.authority.content_sha256,
        eliotr_size_bytes: String(changed.byteLength) },
    });
    await expect(readAdmittedNormalizedMarkdown(runtime.EVIDENCE_BUCKET, source.authority))
      .rejects.toMatchObject({ code: "EVIDENCE_OBJECT_INTEGRITY" });

    const exact = new Uint8Array(MAX_CANONICAL_BYTES).fill(0x61);
    const exactDigest = await digestBytes(exact);
    const exactAuthority = { ...source.authority, content_sha256: exactDigest };
    await runtime.EVIDENCE_BUCKET.put(contentKey, exact, {
      sha256: exactDigest,
      httpMetadata: { contentType: "text/markdown; charset=utf-8" },
      customMetadata: { ...original.customMetadata, eliotr_sha256: exactDigest,
        eliotr_size_bytes: String(exact.byteLength) },
    });
    const readAtMaximum = await readAdmittedNormalizedMarkdown(runtime.EVIDENCE_BUCKET, exactAuthority);
    expect(readAtMaximum.size_bytes).toBe(MAX_CANONICAL_BYTES);

    const over = new Uint8Array(MAX_CANONICAL_BYTES + 1).fill(0x62);
    const overDigest = await digestBytes(over);
    await runtime.EVIDENCE_BUCKET.put(contentKey, over, {
      sha256: overDigest,
      httpMetadata: { contentType: "text/markdown; charset=utf-8" },
      customMetadata: { ...original.customMetadata, eliotr_sha256: overDigest,
        eliotr_size_bytes: String(over.byteLength) },
    });
    await expect(readAdmittedNormalizedMarkdown(runtime.EVIDENCE_BUCKET, { ...source.authority, content_sha256: overDigest }))
      .rejects.toMatchObject({ code: "EVIDENCE_RANGE_INVALID" });
  });
});
