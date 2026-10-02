import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { INSTALLED_INQUIRY_PROTOCOL_REFS, RESEARCH_RUN_REQUEST_V2 } from "@eliotr/cloudflare-research";
import { body, count, db, principal, runtime, seedSource, setupOrientationDatabase, verifier } from "./orientation-fixture.js";
import { admissionTestEnvironment, terminateAdmissionWorkflows } from "./research-admission-fixture.js";
import { parseResearchRunRequest } from "../src/research-session.js";
import { SERVER_OWNED_BRANCH_HANDLER_GENERATION } from "../src/research-stage-handlers.js";
import { handleHttp } from "../src/http.js";
import type { Env } from "../src/env.js";

let configured: Env;
const admitted: string[] = [];
afterAll(async () => {
  for (const id of admitted) {
    const instance = await runtime.RESEARCH_WORKFLOW.get(id);
    const terminal = new Set(["errored", "complete", "terminated"]);
    if (terminal.has((await instance.status()).status)) continue;
    try { await instance.terminate(); }
    catch (error) { if (!terminal.has((await instance.status()).status)) throw error; }
  }
});
beforeAll(async () => {
  await setupOrientationDatabase();
  configured = await admissionTestEnvironment(runtime, principal, "s24");
});
const run = (request: Request) => handleHttp(request, configured, {} as ExecutionContext, { accessVerifier: verifier() });
function runBody(id: string, fields: Record<string, unknown> = {}) {
  return { query: "Source", product: "RESEARCH", scope_expression: { kind: "SELECTED_SOURCES", source_ids: [id] },
    literals: [], evidence_grade: "E1", budget_ref: "research-budget-v1", max_results: 8, ...fields };
}
function runRequest(id: string, fields: Record<string, unknown>, key: string) {
  return new Request("https://research.example/api/v1/research/run", { method: "POST",
    headers: { "content-type": "application/json", "idempotency-key": key }, body: JSON.stringify(runBody(id, fields)) });
}


describe("S24 Research question parser", () => {
  it.each(["line 1\n\n\t> quote", "строка 😀\r\n\t- пункт", "x".repeat(9000), "я😀".repeat(2000)])(
    "preserves formatted/long text exactly", (query) => {
      expect(parseResearchRunRequest(runBody("rs-protocol", { query })).query).toBe(query);
    },
  );
  it.each(["a\ud800b", "a\udc00b", "a\rb", "a\u0000b", "a\u0001b", "a\u007fb"])(
    "rejects malformed text before any reservation", (query) => {
      expect(() => parseResearchRunRequest(runBody("rs-protocol", { query }))).toThrow();
    },
  );
});


describe("S24 Research end-to-end input identity", () => {
  beforeAll(async () => { await seedSource("s24-input"); });
  it("persists a multiline question through HTTP, ledger and immutable planning input without normalization", async () => {
    const query = "  English question\r\n\t- Русский пункт 😀\n> cited text\n".repeat(180);
    const fields = { query, request_version: RESEARCH_RUN_REQUEST_V2, inquiry_protocol_ref: INSTALLED_INQUIRY_PROTOCOL_REFS.lookup, evidence_grade: "E0" };
    const response = await run(runRequest("s24-input", fields, "s24-formatted"));
    const started = await body<{ investigation_ref: { id: string; revision: number }; workflow_instance_id: string }>(response);
    expect(response.status, JSON.stringify(started)).toBe(200);
    admitted.push(started.data.workflow_instance_id);
    await terminateAdmissionWorkflows(runtime, admitted);
    const workflow = await db.prepare("SELECT handler_generation FROM research_workflow_run WHERE operation_id=?1")
      .bind(started.data.workflow_instance_id).first<{ handler_generation: string }>();
    expect(workflow?.handler_generation).toBe(SERVER_OWNED_BRANCH_HANDLER_GENERATION);
    const stored = await db.prepare("SELECT goal, portfolio_ref, input_digest FROM investigation_ledger_head WHERE investigation_id=?1")
      .bind(started.data.investigation_ref.id).first<{ goal: string; portfolio_ref: string; input_digest: string }>();
    expect(stored?.goal).toBe(query);
    if (stored === null) throw new Error("missing persisted S24 ledger");
    const payload = await runtime.WORK_BUCKET.get(stored.portfolio_ref);
    if (payload === null) throw new Error("missing immutable S24 input");
    const rawText = await payload.text();
    const decoded = JSON.parse(rawText) as { query: string; planning_manifest: { questions: { text: string }[] } };
    expect(decoded.query).toBe(query);
    expect(decoded.planning_manifest.questions[0]?.text).toBe(query);
    const hash = [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(rawText)))].map((n) => n.toString(16).padStart(2, "0")).join("");
    expect(hash).toBe(stored.input_digest);
    const counts = [await count("investigation_ledger_head"), await count("research_workflow_run")];
    expect((await body(await run(runRequest("s24-input", fields, "s24-formatted")))).data).toEqual(started.data);
    expect([await count("investigation_ledger_head"), await count("research_workflow_run")]).toEqual(counts);
    expect((await run(runRequest("s24-input", { ...fields, query: query.replaceAll("\r\n", "\n") }, "s24-formatted"))).status).toBe(409);
  }, 30000);
  it("enforces the complete immutable workflow input at 65536/65537 bytes", async () => {
    const start = await body<{ investigation_ref: { id: string }; workflow_instance_id: string }>(
      await run(runRequest("s24-input", { query: "x" }, "s24-size-probe")),
    );
    admitted.push(start.data.workflow_instance_id);
    const row = await db.prepare("SELECT portfolio_ref FROM investigation_ledger_head WHERE investigation_id=?1")
      .bind(start.data.investigation_ref.id).first<{ portfolio_ref: string }>();
    if (row === null) throw new Error("missing size-probe ledger");
    const payload = await runtime.WORK_BUCKET.get(row.portfolio_ref);
    if (payload === null) throw new Error("missing size-probe payload");
    const overhead = (await payload.arrayBuffer()).byteLength - 1;
    const query = "x".repeat(65536 - overhead);
    const exact = await run(runRequest("s24-input", { query }, "s24-size-exact"));
    const accepted = await body<{ investigation_ref: { id: string }; workflow_instance_id: string }>(exact);
    expect(exact.status, JSON.stringify(accepted)).toBe(200);
    admitted.push(accepted.data.workflow_instance_id);
    const persisted = await db.prepare("SELECT portfolio_ref, goal FROM investigation_ledger_head WHERE investigation_id=?1")
      .bind(accepted.data.investigation_ref.id).first<{ portfolio_ref: string; goal: string }>();
    if (persisted === null) throw new Error("missing boundary ledger");
    expect(persisted.goal).toBe(query);
    expect((await runtime.WORK_BUCKET.head(persisted.portfolio_ref))?.size).toBe(65536);
    const counts = [await count("investigation_ledger_head"), await count("research_workflow_run"), await count("research_model_attempt")];
    const overflow = await run(runRequest("s24-input", { query: `${query}x` }, "s24-size-overflow"));
    expect(overflow.status).toBe(413);
    expect((await overflow.json() as { title: string }).title).toContain("workflow input exceeds 65536");
    expect([await count("investigation_ledger_head"), await count("research_workflow_run"), await count("research_model_attempt")]).toEqual(counts);
  }, 30000);
  it("rejects an unmigrated deployment before scope, ledger or model effects", async () => {
    const counts = [await count("scope_snapshot"), await count("investigation_ledger_head"), await count("research_model_attempt")];
    await db.prepare("UPDATE schema_state SET value='old' WHERE key='research_question_generation'").run();
    try {
      const response = await run(runRequest("s24-input", { query: "x" }, "s24-old-schema"));
      expect(response.status).toBe(503);
      expect(await response.json()).toMatchObject({ code: "RESEARCH_INPUT_SCHEMA_MISMATCH" });
      expect([await count("scope_snapshot"), await count("investigation_ledger_head"), await count("research_model_attempt")]).toEqual(counts);
    } finally {
      await db.prepare("UPDATE schema_state SET value='research-question-v2-utf8-envelopes' WHERE key='research_question_generation'").run();
    }
  });
  it("rejects workflow-envelope overflow before creating ledger/run/model effects", async () => {
    const counts = [await count("investigation_ledger_head"), await count("research_workflow_run"), await count("research_workflow_attempt")];
    const response = await run(runRequest("s24-input", { query: "я".repeat(40000) }, "s24-overflow"));
    const failure = await response.json() as { code: string; title: string };
    expect(response.status, JSON.stringify(failure)).toBe(413);
    expect(failure.code).toBe("RESEARCH_INPUT_LIMIT");
    expect(failure.title).toMatch(/workflow input.*65536/u);
    expect([await count("investigation_ledger_head"), await count("research_workflow_run"), await count("research_workflow_attempt")]).toEqual(counts);
  }, 30000);
});
