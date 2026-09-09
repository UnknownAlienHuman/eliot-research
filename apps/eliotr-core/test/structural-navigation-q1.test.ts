import { applyD1Migrations } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { createD1NavigationStore } from "@eliotr/cloudflare-evidence";
import {
  createD1ScopeService,
  createOwnerScopeAuthority,
  materializeStructuralNavigation,
} from "@eliotr/cloudflare-navigation";
import { canonicalNormalizedBundleKey } from "@eliotr/platform-cloudflare";
import { extractNavigationSections } from "@eliotr/retrieval";
import {
  importAndProject,
  prepareQ1Namespace,
  type Q1Runtime,
} from "./retrieval-q1-fixture.js";
import { env } from "cloudflare:workers";
import type { Env } from "../src/env.js";

interface Migration { readonly name: string; readonly queries: string[]; }

const runtime = env as unknown as Env & {
  readonly CORE_MIGRATIONS: Migration[];
  readonly SEARCH_MIGRATIONS: Migration[];
};
const owner = "n1-q1-owner";
const access = { principal_ref: owner, client_class: "owner_pwa" as const, credential_generation: "credential-1" };

beforeEach(async () => {
  await applyD1Migrations(runtime.CORE_DB, runtime.CORE_MIGRATIONS);
  await applyD1Migrations(runtime.SEARCH_DB, runtime.SEARCH_MIGRATIONS);
});

describe("N1 structural navigation over the real Q1 import path", () => {
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
    const contentKey = await canonicalNormalizedBundleKey(source.authority.object_residency_key_digest, {
      owner_system_id: source.authority.owner_system_id,
      source_namespace_id: source.authority.source_namespace_id,
      source_owner_generation: source.authority.source_owner_generation,
      source_logical_id: source.authority.source_id,
      source_revision_ref: source.authority.source_revision_ref,
    }, "content.md");
    const contentObject = await runtime.EVIDENCE_BUCKET.get(contentKey);
    if (contentObject === null) throw new Error("missing admitted normalized content");
    const contentBytes = new Uint8Array(await contentObject.arrayBuffer());
    for (const section of sections) {
      const start = section.normalized_start_byte;
      const end = section.normalized_end_byte;
      if (start === undefined || end === undefined) throw new Error("structural section has no exact byte range");
      expect(new TextDecoder().decode(contentBytes.slice(start, end))).not.toHaveLength(0);
    }
    const second = await materializeStructuralNavigation(store, snapshot, sources, { evidence_bucket: runtime.EVIDENCE_BUCKET });
    expect(second).toEqual(first);
    const secondCount = await runtime.CORE_DB.prepare("SELECT COUNT(*) AS n FROM navigation_artifact WHERE scope_snapshot_id=?1")
      .bind(snapshot.snapshot_id).first<number>("n");
    expect(secondCount).toBe(2);

    await runtime.CORE_DB.prepare("UPDATE source_revision SET purge_state='PURGE_REQUESTED' WHERE source_revision_ref=?1").bind(revision).run();
    await expect(store.getDocumentMaps([revision])).rejects.toMatchObject({ code: "NAVIGATION_STORE_FAILED" });
  });
});
