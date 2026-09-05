import { beforeAll, describe, expect, it } from "vitest";
import { handleHttp } from "../src/http.js";
import { body, db, observeDatabase, request, run, runtime, seedSource, setupOrientationDatabase, successful, verifier } from "./orientation-fixture.js";

beforeAll(setupOrientationDatabase);
describe("bounded orientation on migrated local D1", () => {
  it("rolls back the whole navigation batch, then recovers the same operation", async () => {
    await seedSource("atomic");
    await db.prepare("CREATE TRIGGER injected_batch_failure BEFORE INSERT ON navigation_artifact WHEN NEW.artifact_kind='DOCUMENT_MAP' " +
      "BEGIN SELECT RAISE(ABORT, 'injected batch failure'); END").run();
    try {
      expect((await run(request("atomic"))).status).not.toBe(200);
      expect(await db.prepare("SELECT COUNT(*) FROM navigation_artifact").first<number>("COUNT(*)")).toBe(0);
    } finally { await db.prepare("DROP TRIGGER injected_batch_failure").run(); }
    const value = await successful(request("atomic")); expect(value.navigation?.source_cards).toHaveLength(1);
  });
  it("accounts for 64 sources without returning a false complete or evidence result", async () => {
    for (let i = 1; i < 64; i += 1) await seedSource(`bounded-${i}`);
    let queries = 0;
    const database = observeDatabase(async (_sql, phase) => { if (phase === "before") queries += 1; });
    const req = request("bounded", { scope_expression: { kind: "GLOBAL_LIBRARY" }, query: "" });
    const response = await handleHttp(req, { ...runtime, CORE_DB: database }, {} as ExecutionContext, { accessVerifier: verifier() });
    const value = await body(response);
    expect(response.status, JSON.stringify(value)).toBe(200);
    expect(value.data.navigation?.represented_source_revision_refs).toHaveLength(8);
    expect(value.data.navigation?.omitted_source_revision_count).toBe(56);
    expect(value.data.evidence_pack.resolved_evidence).toEqual([]);
    expect(queries).toBeLessThan(900);
    console.warn(`Local orientation 64-source SQL method count: ${queries}; remote latency/cost not measured`);
  }, 30000);
  it("rejects a source set above the declared ceiling rather than silently truncating it", async () => {
    await seedSource("overflow");
    const response = await run(request("overflow-all", { scope_expression: { kind: "GLOBAL_LIBRARY" } }));
    expect(response.status).not.toBe(200);
    const selected = Array.from({ length: 65 }, (_, i) => `source-${i}`);
    expect((await run(request("overflow-selected", { scope_expression: { kind: "SELECTED_SOURCES", source_ids: selected } }))).status).toBe(413);
  });
});
