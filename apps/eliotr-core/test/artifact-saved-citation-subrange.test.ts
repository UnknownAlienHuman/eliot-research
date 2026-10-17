import { beforeEach, describe, expect, it } from "vitest";
import { createD1ScopeService, createOwnerScopeAuthority } from "@eliotr/cloudflare-navigation";
import { createNavigationReadAuthority } from "@eliotr/cloudflare-evidence";
import { resolveReauthorizedArtifactEvidence } from "@eliotr/cloudflare-research";
import type { LocatorCandidate } from "@eliotr/contracts";
import { freezeFixture, type FreezeFixture } from "./research-evidence-freeze-fixture.js";
import { env } from "cloudflare:workers";
import type { Env } from "../src/env.js";

const runtime = env as unknown as Env;
let data: FreezeFixture;
// Full canonical migrations and source admission are fixture work; the read itself keeps the 5s case deadline.
beforeEach(async () => { data = await freezeFixture({ include_counterevidence: true }); }, 30_000);

describe("saved SEM citation range through real D1/R2 reauthorization", () => {
  it("reopens the exact narrowed bytes under a fresh scope, without treating the full projection as the quote", async () => {
    const row = await runtime.SEARCH_DB.prepare("SELECT item_key,source_revision_ref,canonical_section_id,content_sha256,projection_generation FROM projection_item WHERE active=1 ORDER BY item_key LIMIT 1")
      .first<{ item_key: string; source_revision_ref: string; canonical_section_id: string; content_sha256: string; projection_generation: string }>();
    if (row === null) throw new Error("Fixture lacks its admitted parent projection");
    const candidate: LocatorCandidate = { candidate_id: row.item_key, source_revision_ref: row.source_revision_ref,
      canonical_section_id: row.canonical_section_id, index_generation: row.projection_generation, lane: "SEM", rank: 1, raw_score: 1,
      preview: "Pinned", metadata: { provider: "cloudflare_ai_search", provider_chunk_type: "text", item_key: row.item_key, content_sha256: row.content_sha256 } };
    const original = await data.resolver.resolveCandidate({ candidate, access: data.navigation.access,
      scope_snapshot_ref: { id: data.scope.snapshot_id, revision: data.scope.revision } });
    expect(original.exact_excerpt).toBe("Pinned");
    const owner = createOwnerScopeAuthority(data.db, data.navigation.access);
    const scopes = createD1ScopeService(data.db, owner);
    const fresh = await scopes.freeze(data.scope.resolved_scope_expression, data.navigation.access.credential_generation);
    await owner.grant(fresh);
    const navigation = createNavigationReadAuthority({ database: data.db, scope_snapshot: fresh, access: data.navigation.access,
      require_current: requested => scopes.requireCurrent(requested) });
    const input = { database: data.db, search_database: runtime.SEARCH_DB, evidence_bucket: runtime.EVIDENCE_BUCKET,
      access: data.navigation.access, current_navigation: navigation, current_authorization: await navigation.current(),
      original_handle_ref: original.handle.handle_ref, original_scope_snapshot_ref: original.handle.scope_snapshot_ref,
      expected_excerpt_sha256: original.handle.excerpt_sha256 };
    const read = await resolveReauthorizedArtifactEvidence(input);
    expect(read.resolved.exact_excerpt).toBe(original.exact_excerpt);
    expect(read.resolved.handle.anchor).toEqual(original.handle.anchor);
    expect(read.resolved.handle.excerpt_sha256).toBe(original.handle.excerpt_sha256);
    expect(read.resolved.handle.coordinate_map_ref).toBe(original.handle.coordinate_map_ref);
    expect(read.resolved.handle.scope_snapshot_ref).toEqual({ id: fresh.snapshot_id, revision: fresh.revision });
    await expect(resolveReauthorizedArtifactEvidence({ ...input, expected_excerpt_sha256: "0".repeat(64) }))
      .rejects.toMatchObject({ code: "ARTIFACT_DRAFT_READ_STALE" });
    await data.db.prepare("UPDATE scope_access_grant SET state='REVOKED' WHERE snapshot_id=?1 AND principal_ref=?2")
      .bind(fresh.snapshot_id, data.navigation.access.principal_ref).run();
    await expect(resolveReauthorizedArtifactEvidence(input)).rejects.toBeDefined();
  });
});
