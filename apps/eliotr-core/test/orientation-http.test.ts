import { beforeAll, describe, expect, it } from "vitest";
import { body, count, db, principal, request, run, seedSource, setupOrientationDatabase, verifier } from "./orientation-fixture.js";
beforeAll(setupOrientationDatabase);

describe("launch path: real HTTP -> read policy -> scope -> persisted navigation -> trace", () => {
  it("migrates a clean database and executes orientation without model/provider bindings", async () => {
    await seedSource("happy");
    const response = await run(request("happy"));
    const result = await body(response);
    expect(result, JSON.stringify(result)).toHaveProperty("data.navigation");
    expect(response.status).toBe(200);
    expect(result.data.navigation?.navigation_authority).toBe("NAVIGATION_ONLY");
    expect(result.data.navigation?.source_cards[0]?.title).toBe("Source happy");
    expect(result.data.navigation?.document_maps[0]?.unresolved_structure).toContain("STRUCTURE_NOT_MATERIALIZED");
    expect(result.data.evidence_pack.resolved_evidence).toEqual([]);
    expect(result.data.evidence_pack.total_utf8_bytes).toBe(0);
    const traceResponse = await run(new Request(`https://research.example/api/v1/research/trace/${result.data.trace_ref.id}`));
    expect(traceResponse.status).toBe(200);
    const trace = await body(traceResponse);
    expect(trace.data.scope_snapshot.snapshot_id).toBe(result.data.evidence_pack.scope_snapshot_ref.id);
    expect(trace.data.query_product).toBe("ORIENT");
    expect(trace.data.stale_or_degraded_channels).toContain("METADATA_ONLY");
  });
  it("replays exactly without duplicating scope or navigation artifacts", async () => {
    await seedSource("replay");
    const firstResponse = await run(request("replay"));
    expect(firstResponse.status).toBe(200);
    const first = await body(firstResponse);
    const counts = [await count("scope_snapshot"), await count("navigation_artifact")];
    const again = await body(await run(request("replay")));
    expect(again.data).toEqual(first.data);
    expect([await count("scope_snapshot"), await count("navigation_artifact")]).toEqual(counts);
    expect((await run(request("replay", { query: "different" }))).status).toBe(409);
  });
  it("denies admission-only permission and an authenticated stranger before source materialization", async () => {
    await seedSource("denied", false);
    const prior = await count("navigation_artifact");
    const denied = await run(request("denied"));
    expect(denied.status).toBe(409); // Strict freezer returns no scope when atom authorization cannot be established.
    expect(await count("navigation_artifact")).toBe(prior);
    expect((await run(request("happy"), verifier("stranger"))).status).toBe(403);
  });
  it("keeps service-token clients outside the owner launch profile", async () => {
    expect((await run(request("happy"), verifier(principal, "service_token"))).status).toBe(403);
  });
  it("rejects unknown authority fields, unsupported products and an absent idempotency key", async () => {
    expect((await run(request("happy", { scope_snapshot: {} }))).status).toBe(400);
    expect((await run(request("happy", { product: "RESEARCH" }))).status).toBe(422);
    expect((await run(request("happy", { evidence_grade: "E3" }))).status).toBe(422);
    expect((await run(request("happy", { literals: ["literal"] }))).status).toBe(400);
    expect((await run(request("happy", { budget_ref: "unlimited" }))).status).toBe(422);
    const req = request("happy"); req.headers.delete("idempotency-key");
    expect((await run(req)).status).toBe(400);
  });
  it("never reveals another principal's stored trace", async () => {
    await seedSource("private-trace");
    const data = await body(await run(request("private-trace")));
    const response = await run(new Request(`https://research.example/api/v1/research/trace/${data.data.trace_ref.id}`), verifier("stranger"));
    expect(response.status).toBe(404);
  });
  it("revokes the cached result and removes payloads after policy withdrawal", async () => {
    await seedSource("revoke");
    const data = await body(await run(request("revoke")));
    expect(data).toHaveProperty("data.trace_ref.id");
    await db.prepare("UPDATE scope_read_policy SET state='REVOKED',generation=2 WHERE source_namespace_id='ns-revoke'").run();
    expect((await run(request("revoke"))).status).not.toBe(200);
    const row = await db.prepare("SELECT state,result_json FROM orientation_request WHERE operation_id=?1").bind(data.data.trace_ref.id).first();
    expect(row).toEqual({ state: "INVALIDATED", result_json: null });
    expect((await run(new Request(`https://research.example/api/v1/research/trace/${data.data.trace_ref.id}`))).status).toBe(409);
  });
  it("purging a source removes cached navigation and prevents trace replay", async () => {
    await seedSource("purge");
    const data = await body(await run(request("purge")));
    expect(data).toHaveProperty("data.trace_ref.id");
    await db.prepare("UPDATE source_revision SET purge_state='PURGE_REQUESTED' WHERE source_id='purge'").run();
    const row = await db.prepare("SELECT state,result_json FROM orientation_request WHERE operation_id=?1").bind(data.data.trace_ref.id).first();
    expect(row).toEqual({ state: "INVALIDATED", result_json: null });
  });
});
