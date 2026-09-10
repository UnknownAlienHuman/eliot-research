import { beforeAll, describe, expect, it, vi } from "vitest";
import { handleHttp } from "../src/http.js";
import { orientSources, orientationBody, readOrientationTrace } from "../../eliotr-pwa/src/orientation-api.js";
import { renderOrientation } from "../../eliotr-pwa/src/orientation-panel.js";
import { body, count, credential, db, insert, observeDatabase, request, run, runtime,
  seedSource, setupOrientationDatabase, successful, verifier } from "./orientation-fixture.js";

beforeAll(setupOrientationDatabase);
const traceRequest = (id: string) => new Request(`https://research.example/api/v1/research/trace/${id}`);

describe("orientation restart, input and authority races through real HTTP", () => {
  it("runs the PWA client/decoder/rendering against the real Worker application", async () => {
    await seedSource("pwa");
    vi.stubGlobal("fetch", (url: string, init: RequestInit) => run(new Request(new URL(url, "https://research.example"), init)));
    try {
      const view = await orientSources(orientationBody(["pwa"], "source"), "pwa-request");
      expect(view.cards[0]?.title).toBe("Source pwa");
      expect(renderOrientation(view)).toContain("Navigation only");
      expect(renderOrientation(view)).toContain("Source pwa");
      const trace = await readOrientationTrace(view.trace);
      expect(trace.query_product).toBe("ORIENT");
      expect(trace.scope_snapshot.purge_ledger_revision).toBe(0);
      expect(await count("purge_ledger")).toBe(0);
      const hostile = { ...view, cards: view.cards.map((card) => ({ ...card, title: '<img src=x onerror="attack()">' })) };
      expect(renderOrientation(hostile)).not.toContain("<img");
      expect(renderOrientation(hostile)).toContain("&lt;img");
    } finally { vi.unstubAllGlobals(); }
  });
  it("reconciles parallel identical requests under one durable operation and snapshot", async () => {
    await seedSource("parallel");
    const [first, second] = await Promise.all([run(request("parallel")), run(request("parallel"))]);
    const a = await body(first); const b = await body(second);
    expect(first.status, JSON.stringify(a)).toBe(200); expect(second.status, JSON.stringify(b)).toBe(200);
    expect(a.data).toEqual(b.data);
    expect(await db.prepare("SELECT COUNT(*) FROM orientation_request WHERE idempotency_key='request-parallel'").first<number>("COUNT(*)")).toBe(1);
  });
  it.each(["INSERT INTO orientation_request", "UPDATE orientation_request SET state='COMPLETE'", "BATCH"])( "reconciles one lost acknowledgement for %s without replaying the mutation", async (prefix) => {
    const id = prefix === "BATCH" ? "lost-batch" : prefix.startsWith("INSERT") ? "lost-reserve" : "lost-complete";
    await seedSource(id); let fired = false; let mutations = 0;
    const database = observeDatabase(async (sql, phase) => {
      if (sql.startsWith(prefix) && phase === "before") mutations += 1;
      if (!fired && phase === "after" && sql.startsWith(prefix)) { fired = true; throw new Error("simulated lost ACK"); }
    });
    const response = await handleHttp(request(id), { ...runtime, CORE_DB: database }, {} as ExecutionContext, { accessVerifier: verifier() });
    const result = await body(response); expect(response.status, JSON.stringify(result)).toBe(200);
    expect(fired).toBe(true); expect(mutations).toBe(1);
    const replay = await successful(request(id)); expect(replay).toEqual(result.data);
  });
  it("does not finish after cancellation before the navigation batch", async () => {
    await seedSource("cancel"); const controller = new AbortController(); let fired = false;
    const database = observeDatabase(async (sql, phase) => { if (!fired && sql === "BATCH" && phase === "before") {
      fired = true; controller.abort(); throw new Error("cancelled before batch");
    } });
    const req = new Request(request("cancel"), { signal: controller.signal });
    const response = await handleHttp(req, { ...runtime, CORE_DB: database }, {} as ExecutionContext, { accessVerifier: verifier() });
    expect(response.status).not.toBe(200); expect(fired).toBe(true);
    const recovered = await successful(request("cancel")); expect(recovered.navigation?.source_cards).toHaveLength(1);
  });
  it("rejects a read-policy revocation during materialization and clears dependent payloads", async () => {
    await seedSource("race"); let fired = false;
    const database = observeDatabase(async (sql, phase) => { if (!fired && sql === "BATCH" && phase === "before") {
      fired = true; await db.prepare("UPDATE scope_read_policy SET state='REVOKED',generation=2 WHERE source_namespace_id='ns-race'").run();
    } });
    const response = await handleHttp(request("race"), { ...runtime, CORE_DB: database }, {} as ExecutionContext, { accessVerifier: verifier() });
    expect(response.status).not.toBe(200); expect(fired).toBe(true);
    expect(await db.prepare("SELECT state,result_json FROM orientation_request WHERE idempotency_key='request-race'").first())
      .toEqual({ state: "INVALIDATED", result_json: null });
  });
  it("caps the derived grant at the underlying read-policy expiry", async () => {
    await seedSource("expiry"); const expiry = new Date(Date.now() + 120000).toISOString();
    await db.prepare("UPDATE scope_read_policy SET expires_at=?1 WHERE source_namespace_id='ns-expiry'").bind(expiry).run();
    const data = await successful(request("expiry"));
    expect(await db.prepare("SELECT expires_at FROM scope_access_grant WHERE snapshot_id=?1").bind(data.evidence_pack.scope_snapshot_ref.id)
      .first<string>("expires_at")).toBe(expiry);
  });
  it("invalidates a trace and payload on grant deletion, with no implicit regrant", async () => {
    await seedSource("grant-delete"); const data = await successful(request("grant-delete"));
    await db.prepare("DELETE FROM scope_access_grant WHERE snapshot_id=?1").bind(data.evidence_pack.scope_snapshot_ref.id).run();
    expect((await run(request("grant-delete"))).status).not.toBe(200);
    expect((await run(traceRequest(data.trace_ref.id))).status).not.toBe(200);
    expect(await db.prepare("SELECT result_json FROM orientation_request WHERE operation_id=?1").bind(data.trace_ref.id).first())
      .toEqual({ result_json: null });
  });
  it("does not use a revoked credential generation to recover another generation's trace", async () => {
    await seedSource("credentials"); const data = await successful(request("credentials"));
    const auth = verifier(); const rotated = { async verify(req: Request) {
      return { ...await auth.verify(req), credential_generation: `${credential}-rotated` };
    } };
    expect((await run(traceRequest(data.trace_ref.id), rotated)).status).toBe(404);
  });
  it("uses current membership and never turns metadata-only focus into semantic filtering", async () => {
    await seedSource("member");
    await insert("project", { project_id: "project-test", title: "Project", generation: 1, default_disclosure: "private",
      default_model_profile_ref: "model-1", default_depth_profile_ref: "depth-1", default_source_policy_ref: "policy-1", retention_policy_ref: "retention-1", created_at: new Date().toISOString() });
    await insert("project_source_membership", { project_id: "project-test", source_id: "member", membership_generation: 1, role: "reference",
      valid_from: new Date(Date.now() - 10000).toISOString(), valid_to: null });
    const data = await successful(request("member", { scope_expression: { kind: "PROJECT", project_id: "project-test" }, query: "unmatched focus" }));
    expect(data.navigation?.represented_source_revision_refs).toEqual(["rev-member"]);
    await db.prepare("UPDATE project_source_membership SET valid_to=?1 WHERE project_id='project-test'").bind(new Date().toISOString()).run();
    expect((await run(traceRequest(data.trace_ref.id))).status).not.toBe(200);
  });
  it("requires current schema and rejects unsupported media, extra query parameters and oversized bodies", async () => {
    const generation = await db.prepare("SELECT value FROM schema_state WHERE key='schema_generation'").first<string>("value");
    await db.prepare("UPDATE schema_state SET value='old' WHERE key='schema_generation'").run();
    try { expect((await run(request("member"))).status).toBe(503); }
    finally { await db.prepare("UPDATE schema_state SET value=?1 WHERE key='schema_generation'").bind(generation).run(); }
    const req = request("member"); req.headers.set("content-type", "text/plain"); expect((await run(req)).status).toBe(415);
    expect((await run(new Request("https://research.example/api/v1/research/orient?extra=1", request("member")))).status).toBe(400);
    expect((await run(new Request("https://research.example/api/v1/research/orient", { method: "POST",
      headers: { "content-type": "application/json" }, body: "x".repeat(16385) }))).status).toBe(413);
  });
});
