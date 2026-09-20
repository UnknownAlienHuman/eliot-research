import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { INSTALLED_INQUIRY_PROTOCOL_REFS, RESEARCH_RUN_REQUEST_V2 } from "@eliotr/cloudflare-research";
import { body, count, db, principal, runtime, seedSource, setupOrientationDatabase, verifier } from "./orientation-fixture.js";
import { createResearchOwnerRuntimeConfiguration } from "../src/research-owner-runtime-config.js";
import { parseResearchRunRequest } from "../src/research-session.js";
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
  const expires_at = new Date(Date.now() + 86_400_000).toISOString();
  const deployment = { route_ref: "dynamic/eliotr-balanced" as const, route_version: "s24-fixture-v1",
    prompt_generation: "s24-prompt-v1", schema_generation: "s24-schema-v1", pricing_snapshot_ref: "s24-pricing-v1" };
  const residency = { scope_domain_id: "s24-scope", access_domain_id: principal, confidentiality_domain_id: "private",
    encryption_key_domain_id: "s24-key", retention_domain_id: "s24-retention", erasure_domain_id: "s24-erasure" };
  // Compile a structurally valid, explicit local-only configuration through the production installer.
  // No route is qualified and no gateway is contacted. Workflow execution is outside this admission test.
  const compiled = await createResearchOwnerRuntimeConfiguration({
    protocol: "eliotr.research-owner-setup.v1",
    semantic: {
      synthesis: { max_tokens: 512, request_timeout_ms: 1000 },
      audit: { max_tokens: 512, request_timeout_ms: 1000, verifier_ref: "s24-verifier", verifier_schema_generation: "s24-audit-v1",
        allowed_verifier_refs: ["s24-verifier"], policy: { required_dimensions: [], source_requirement_applicable: true,
          excerpt_requirement_applicable: true, coverage_limitations: ["Local input test; no evidence judgment"], unsupported_precision: [] } },
      normalization: { section_ref: { id: "s24-section", revision: 1 }, required_precision: "normalized", required_source_class: "document" },
    },
    model_profile: { config_provenance_ref: "s24-profile-config", model_profile_ref: "research-model-v1",
      expires_at, max_context_bytes: 65536, deployment, policy: { allowed_tool_definition_refs: [], allowed_verifier_refs: ["s24-verifier"],
        permitted_anchor_and_precision_ceilings: ["normalized"], provider_and_policy_generations: { policy: "s24-policy" },
        permitted_acquisition_or_expansion_routes: [], disclosure_ceiling: "private", allowed_use: ["research"], expires_at } },
    spend_policy: { protocol: "eliotr.research-owner-spend-template.v1", approved: true, policy_ref: "s24-spend",
      config_provenance_ref: "s24-spend-config", principal_ref: principal, client_class: "owner_pwa",
      deployment_generation: runtime.DEPLOYMENT_GENERATION, expires_at, rules: (["SYNTHESIZE", "AUDIT_CLAIMS"] as const).map((stage) => ({
        stage, deployment, max_input_bytes: 65536, max_output_bytes: 8192,
        quote: { estimated_model_calls: 1, estimated_input_tokens: 1000, estimated_output_tokens: 512, estimated_embedding_tokens: 0,
          quoted_neurons: 0, platform_usd: 0, workers_ai_usd: 0, byok_usd: 0, max_total_usd: 0,
          workflow_steps: 1, expected_sources: 1, expected_sections: 1, confidence: 1 },
      })) },
    report: {
      admission_policy: { protocol: "eliotr.research-owner-report-admission-template.v1", policy_ref: "s24-report", policy_revision: 1,
        config_provenance_ref: "s24-report-config", principal_ref: principal, client_class: "owner_pwa",
        deployment_generation: runtime.DEPLOYMENT_GENERATION, allowed_use: ["research"], disclosure_ceiling: "private",
        requested_output_class: "private-draft", purpose: "research-report-materialization", expires_at },
      artifact_policy: { kind: "technical_audit", title: "Local input test", audience: "owner", language: "en",
        section_contract: { section_id: "summary", title: "Summary", purpose: "Summary", required_claim_kinds: ["claim"],
          required_evidence_classes: ["source"], maximum_utf8_bytes: 4096 }, statement_labels: { claim: "UNRESOLVED" },
        citation_policy_ref: "s24-citation", verification_policy_ref: "s24-verification", length_policy_ref: "s24-length",
        export_formats: ["markdown"], include_counterevidence: true, include_methodology: true, budget_ref: "s24-report-budget",
        section_residency: residency, manifest_residency: residency },
    },
  });
  configured = { ...runtime, ...compiled.vars, ELIOTR_MODEL_GATEWAY_TOKEN: "s24-local-not-a-credential" };
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
