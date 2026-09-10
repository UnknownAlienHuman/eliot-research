import { beforeAll, describe, expect, it, vi } from "vitest";
import type { AuthenticatedRequestContext, CatalogResult } from "@eliotr/interfaces";
import { handleHttp } from "../src/http.js";
import { readCatalog } from "../src/catalog-service.js";
import { catalogTimeFrontier } from "../src/catalog-queries.js";
import { db, insert, observeDatabase, runtime, seedSource, setupOrientationDatabase, verifier } from "./orientation-fixture.js";
import { readLibraryPage } from "../../eliotr-pwa/src/library-api.js";
import { orientationBody, orientSources } from "../../eliotr-pwa/src/orientation-api.js";
beforeAll(setupOrientationDatabase);
const request = (query = "") => new Request(`https://research.example/api/v1/research/catalog${query}`);
const context = (owner: string): AuthenticatedRequestContext => ({ request: request(), principal_ref: owner,
  credential_generation: "credential-v1", client_class: "owner_pwa", trace_id: "catalog-test" });
async function seed(id: string, owner: string) {
  await seedSource(id);
  await db.prepare("UPDATE scope_read_policy SET principal_ref=?1 WHERE source_namespace_id=?2").bind(owner, `ns-${id}`).run();
}
async function project(id: string, source: string, from = "2020-01-01T00:00:00Z", until: string | null = null) {
  await insert("project", { project_id: id, title: `Project ${id}`, default_disclosure: "private", retention_policy_ref: "retention-1",
    default_source_policy_ref: "policy-1", default_model_profile_ref: "model-1", default_depth_profile_ref: "depth-1", created_at: from });
  await insert("project_source_membership", { project_id: id, source_id: source, role: "reference", valid_from: from,
    valid_to: until, membership_generation: 1 });
}
async function get(owner: string, query = "", database = db) {
  const response = await handleHttp(request(query), { ...runtime, CORE_DB: database }, {} as ExecutionContext,
    { accessVerifier: verifier(owner) });
  const document = await response.json() as { data?: CatalogResult; code?: string };
  return { response, document };
}
function page(document: { data?: CatalogResult }): CatalogResult {
  expect(document.data).toBeDefined(); if (!document.data) throw new Error("Catalog page missing"); return document.data;
}

describe("authorized Library catalog through real Worker and D1", () => {
  it("exposes only readable admitted heads and projects with an authorized source witness", async () => {
    await seed("catalog-a", "catalog-owner"); await seed("catalog-secret", "different-owner");
    await project("catalog-public-project", "catalog-a"); await project("catalog-secret-project", "catalog-secret");
    const { response, document } = await get("catalog-owner");
    expect(response.status, JSON.stringify(document)).toBe(200);
    expect(page(document).sources).toEqual([{ id: "catalog-a", title: "Source catalog-a", readiness_ref: "readiness:catalog-a:rev-catalog-a" }]);
    expect(page(document).projects.map((p) => p.id)).toEqual(["catalog-public-project"]);
    expect(JSON.stringify(document)).not.toContain("secret");
    expect(response.headers.get("cache-control")).toBe("no-store");
    const secret = await get("catalog-owner", "?project_id=catalog-secret-project");
    const absent = await get("catalog-owner", "?project_id=unknown-project");
    expect(secret.response.status).toBe(200);
    expect(secret.document.data).toEqual(absent.document.data);
    expect(secret.document.data).toEqual({ projects: [], sources: [] });
  });
  it("denies an authenticated principal with no read policy instead of using upload authority", async () => {
    await seedSource("catalog-admission-only", false);
    const result = await get("ungranted-owner");
    expect(result.response.status).toBe(403);
    expect(result.document.code).toBe("ORIENTATION_READ_POLICY_REQUIRED");
    expect(JSON.stringify(result.document)).not.toContain("admission-only");
  });
  it("paginates without duplicates and binds cursors to principal, credential, deployment and project", async () => {
    await seed("paging-a", "paging-owner"); await seed("paging-b", "paging-owner");
    await project("paging-project", "paging-a");
    await insert("project_source_membership", { project_id: "paging-project", source_id: "paging-b", role: "reference",
      valid_from: "2020-01-01T00:00:00Z", membership_generation: 1 });
    const first = page((await get("paging-owner", "?limit=1&project_id=paging-project")).document);
    expect(first.sources[0]?.id).toBe("paging-a"); expect(first.next_cursor).toBeDefined();
    const query = `?limit=1&project_id=paging-project&cursor=${first.next_cursor}`;
    const second = page((await get("paging-owner", query)).document);
    expect(second.sources.map((s) => s.id)).toEqual(["paging-b"]); expect(second.next_cursor).toBeUndefined();
    expect(second.projects).toEqual([]);
    expect((await get("other-owner", query)).document.code).toBe("CATALOG_CURSOR_CONTEXT_MISMATCH");
    expect((await get("paging-owner", query.replace("paging-project", "different-project"))).document.code).toBe("CATALOG_CURSOR_SCOPE_MISMATCH");
    const params = { limit: 1, project_id: "paging-project", cursor: String(first.next_cursor) };
    await expect(readCatalog(db, { ...context("paging-owner"), credential_generation: "credential-2" }, params, runtime.DEPLOYMENT_GENERATION))
      .rejects.toMatchObject({ code: "CATALOG_CURSOR_CONTEXT_MISMATCH" });
    await expect(readCatalog(db, context("paging-owner"), params, "other-deployment"))
      .rejects.toMatchObject({ code: "CATALOG_CURSOR_CONTEXT_MISMATCH" });
    await db.prepare("UPDATE scope_read_policy SET state='REVOKED' WHERE source_namespace_id='ns-paging-b'").run();
    expect((await get("paging-owner", query)).document.code).toBe("CATALOG_CURSOR_STALE");
  });
  it("includes finite active memberships, but excludes future and expired memberships", async () => {
    await seed("membership-a", "membership-owner");
    await project("membership-active", "membership-a", "2020-01-01T00:00:00Z", "2099-01-01T00:00:00Z");
    await project("membership-future", "membership-a", "2099-01-01T00:00:00Z");
    await project("membership-old", "membership-a", "2020-01-01T00:00:00Z", "2021-01-01T00:00:00Z");
    expect(page((await get("membership-owner")).document).projects.map((p) => p.id)).toEqual(["membership-active"]);
    expect(page((await get("membership-owner", "?project_id=membership-future")).document).sources).toEqual([]);
  });
  it("omits revoked, expired, purged and owner-generation-mismatched sources", async () => {
    for (const id of ["allowed", "revoked", "expired", "purged", "old-owner"]) await seed(`visibility-${id}`, "visibility-owner");
    await db.prepare("UPDATE scope_read_policy SET state='REVOKED' WHERE source_namespace_id='ns-visibility-revoked'").run();
    await db.prepare("UPDATE scope_read_policy SET expires_at='2020-01-01T00:00:00Z' WHERE source_namespace_id='ns-visibility-expired'").run();
    await db.prepare("UPDATE source_revision SET purge_state='PURGE_REQUESTED' WHERE source_id='visibility-purged'").run();
    await db.prepare("UPDATE source_namespace_ownership SET source_owner_generation='owner-gen-2' WHERE source_namespace_id='ns-visibility-old-owner'").run();
    expect(page((await get("visibility-owner")).document).sources.map((s) => s.id)).toEqual(["visibility-allowed"]);
  });
  it("rejects corrupted admission evidence instead of trusting copied SQL policy fields", async () => {
    await seed("catalog-corrupt", "corrupt-owner");
    await db.prepare("UPDATE source_admission_decision SET decision_sha256=?1 WHERE source_revision_ref='rev-catalog-corrupt'").bind("0".repeat(64)).run();
    const result = await get("corrupt-owner");
    expect(result.response.status).not.toBe(200); expect(result.document).not.toHaveProperty("data");
    expect(JSON.stringify(result.document)).not.toContain("Source catalog-corrupt");
  });
  it("never returns a successful empty page when D1 fails", async () => {
    await seed("catalog-failure", "failure-owner");
    const failed = new Proxy(db, { get(target, key) {
      if (key === "batch") return async () => [{ success: false, results: [] }, { success: true, results: [] }];
      const value = Reflect.get(target, key, target); return typeof value === "function" ? value.bind(target) : value;
    } });
    expect((await get("failure-owner", "", failed)).document.code).toBe("CATALOG_AUTHORITY_UNAVAILABLE");
  });
  it("blocks policy withdrawal between SQL selection and output", async () => {
    await seed("catalog-race", "race-owner"); let changed = false;
    const observed = observeDatabase(async (sql, phase) => {
      if (!changed && sql === "BATCH" && phase === "after") {
        changed = true;
        await db.prepare("UPDATE scope_read_policy SET state='REVOKED' WHERE source_namespace_id='ns-catalog-race'").run();
      }
    });
    const result = await get("race-owner", "", observed);
    expect(changed).toBe(true); expect(result.response.status).not.toBe(200);
    expect(result.document).not.toHaveProperty("data");
  });
  it("blocks a project title mutation during admitted-source verification", async () => {
    await seed("catalog-title-race", "title-owner"); await project("title-project", "catalog-title-race"); let changed = false;
    const observed = observeDatabase(async (sql, phase) => {
      if (!changed && sql.includes("SELECT s.source_id, s.source_owner_system_id") && phase === "after") {
        changed = true; await db.prepare("UPDATE project SET title='Changed title' WHERE project_id='title-project'").run();
      }
    });
    const result = await get("title-owner", "", observed);
    expect(changed).toBe(true); expect(result.document.code).toBe("CATALOG_AUTHORITY_CHANGED");
  });
  it("rejects oversized database titles and malformed cursors", async () => {
    await seed("catalog-big", "big-owner");
    await db.prepare("UPDATE source SET title=?1 WHERE source_id='catalog-big'").bind("x".repeat(4097)).run();
    expect((await get("big-owner")).response.status).not.toBe(200);
    for (const cursor of ["a", "%7Bbad%7D", "x".repeat(2049)]) {
      expect((await get("big-owner", `?cursor=${cursor}`)).response.status).toBe(400);
    }
  });
  it("rejects a time-only policy expiry during read and expired cursor reuse", async () => {
    await seed("catalog-time-a", "time-owner"); await seed("catalog-time-b", "time-owner");
    const start = Date.now(); const end = start + 60_000;
    await db.prepare("UPDATE scope_read_policy SET expires_at=?1 WHERE principal_ref='time-owner'").bind(new Date(end).toISOString()).run();
    expect(await catalogTimeFrontier(db, "time-owner", start)).toBe(end);
    const first = await readCatalog(db, context("time-owner"), { limit: 1 }, runtime.DEPLOYMENT_GENERATION, () => start);
    await expect(readCatalog(db, context("time-owner"), { limit: 1, cursor: String(first.next_cursor) }, runtime.DEPLOYMENT_GENERATION, () => end))
      .rejects.toMatchObject({ code: "CATALOG_CURSOR_STALE" });
    let clock = start;
    const observed = observeDatabase(async (sql, phase) => { if (sql === "BATCH" && phase === "after") clock = end; });
    await expect(readCatalog(observed, context("time-owner"), { limit: 1 }, runtime.DEPLOYMENT_GENERATION, () => clock)).rejects.toBeDefined();
  });
  it("honors cancellation before touching D1", async () => {
    const controller = new AbortController(); controller.abort();
    const ctx = { ...context("cancelled-owner"), request: new Request("https://research.example/", { signal: controller.signal }) };
    await expect(readCatalog(db, ctx, { limit: 1 }, runtime.DEPLOYMENT_GENERATION)).rejects.toMatchObject({ code: "CATALOG_REQUEST_ABORTED" });
  });
  it("feeds the real PWA catalog selection into the existing orientation API on actual D1", async () => {
    await seed("library-to-lens", "library-lens-owner");
    vi.stubGlobal("fetch", (url: string, init: RequestInit) => handleHttp(new Request(new URL(url, "https://research.example"), init),
      runtime, {} as ExecutionContext, { accessVerifier: verifier("library-lens-owner") }));
    try {
      const result = await readLibraryPage();
      expect(result.sources).toHaveLength(1);
      const selected = result.sources[0]; if (!selected) throw new Error("Source missing");
      const view = await orientSources(orientationBody([selected.id], ""), "library-lens-request");
      expect(view.cards.map((card) => card.title)).toEqual(["Source library-to-lens"]);
      expect(view.generation).toBe(result.generation);
      expect(view.omitted).toBe(0);
    } finally { vi.unstubAllGlobals(); }
  });

});
