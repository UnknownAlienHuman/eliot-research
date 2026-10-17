/// <reference types="node" />
/// <reference types="vite/client" />
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { canonicalEvidenceJson, evidenceSha256Bytes } from "@eliotr/cloudflare-evidence";
import type { CoverageReceipt } from "@eliotr/contracts";
import type { AuthenticatedRequestContext, ResearchRunStatus } from "@eliotr/interfaces";
import migration from "../../../infra/d1/core/migrations/0166_project_guide_binding.sql?raw";
import { createProjectGuideService, type ProjectGuideObservation, type ProjectGuidePorts } from "./project-guide-service.js";
import { createProjectGuideStore } from "./project-guide-store.js";
import { projectGuideFromReport, type ProjectGuideVerifiedSection } from "./project-guide-projection.js";

const databases: DatabaseSync[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });
const context = { principal_ref: "owner", credential_generation: "credential", client_class: "owner_pwa",
  request: new Request("https://owner.invalid/guide") } as AuthenticatedRequestContext;
const coverage: CoverageReceipt = {
  receipt_ref: { id: "coverage", revision: 1 }, requested_scope_expression: { kind: "PROJECT", project_id: "project" },
  frozen_scope_snapshot_ref: { id: "scope", revision: 1 }, coverage_denominator_ref: { id: "denominator", revision: 1 },
  denominator_kind: "sampled_with_method", eligible_source_refs: ["revision-1", "revision-2"],
  represented_source_refs: ["revision-1"], cited_source_refs: ["revision-1"],
  omitted_sources: [{ source_ref: "revision-2", reason: "BUDGET_LIMIT" }],
  source_families_and_independence_profile_ref: "family", lanes_used: ["semantic"], stale_or_skipped_lanes: [],
  failed_acquisition_refs: [], provider_degradation_refs: [], parser_degradation_refs: [], redacted_dependency_refs: [],
  counter_search_status: "NOT_REQUIRED", budget_limitations: ["Existing Research budget"], terminal_disposition: "INCOMPLETE_COVERAGE",
};
async function reportFixture(questionCount = 3): Promise<ProjectGuideVerifiedSection> {
  const texts = ["The admitted study reports a measured result.", ...Array.from({ length: questionCount }, (_, i) => `How does measured factor ${i} affect that result?`)];
  const body = new TextEncoder().encode(texts.join("\n\n"));
  const claims = await Promise.all(texts.map(async (text, index) => ({
    claim_ref: { id: `claim-${index}`, revision: 1 }, claim_text: text, claim_text_digest: await evidenceSha256Bytes(new TextEncoder().encode(text)),
    disposition: "SUPPORTED" as const, support_handle_refs: [{ id: "original-evidence", revision: 1 }], counterevidence_handle_refs: [],
  })));
  return { section_ref: { id: "section", revision: 1 }, body, body_sha256: await evidenceSha256Bytes(body),
    statement_labels: Object.fromEntries(claims.map((claim, i) => [claim.claim_ref.id, i === 0 ? "SOURCE_SUPPORTED" : "EDITORIAL_RECOMMENDATION"])),
    semantic_verification: "EXECUTED", claims,
    citations: [{ original_handle_ref: { id: "original-evidence", revision: 1 }, handle_ref: { id: "current-evidence", revision: 3 } }] };
}
function fixture() {
  const db = new DatabaseSync(":memory:"); databases.push(db);
  db.exec("PRAGMA foreign_keys=ON; CREATE TABLE project(project_id TEXT PRIMARY KEY); INSERT INTO project VALUES('project');");
  db.exec(migration);
  const database = { prepare(sql: string) {
    const statement = db.prepare(sql);
    const bind = (...values: unknown[]) => {
      const params = Object.fromEntries(values.map((v, i) => [`?${i + 1}`, v as SQLInputValue]));
      return { first: async <T>() => (statement.get(params) as T | undefined) ?? null,
        run: async () => { const result = statement.run(params); return { success: true, meta: { changes: Number(result.changes) } }; } };
    }; return { ...bind(), bind };
  } } as unknown as D1Database;
  let digest = "a".repeat(64), sourceRefs = ["revision-1"], config = "b".repeat(64), selectionAvailable = true;
  const current = vi.fn(async () => undefined), runCurrent = vi.fn(async () => undefined), reportCurrent = vi.fn(async () => undefined);
  const observe = vi.fn(async (): Promise<ProjectGuideObservation> => ({
    corpus: { digest, atom_generation_ref: "atom", source_revision_refs: sourceRefs,
      source_owner_generations: Object.fromEntries(sourceRefs.map(ref => [ref, "owner-generation"])),
      disclosure_closure_digest: "d".repeat(64), purge_ledger_revision: 0 },
    selection: selectionAvailable ? { configuration_project_id: "project", configuration_ref: `rpmc-${config}`,
      configuration_sha256: config, selection_revision: 1 } : null,
    source_titles: { "revision-1": "Measured study", "revision-2": "Second study" }, requireCurrent: current,
  }));
  let launched = false, completed = false;
  const launch = vi.fn(async () => { launched = true; return { workflow_instance_id: "run-guide" }; });
  const ports: ProjectGuidePorts = {
    store: createProjectGuideStore(database), observe,
    prepare: async (_actor, _project, language, identity, observation) => ({ body: canonicalEvidenceJson({ language, selection: observation.selection }),
      key: `project-guide:${identity}`, workflow_instance_id: "run-guide" }), launch,
    readRun: vi.fn(async () => launched ? { status: { protocol: "eliotr.research-run-status.v1", workflow_instance_id: "run-guide",
      investigation_ref: { id: "investigation", revision: completed ? 19 : 1 }, next_stage_index: completed ? 18 : 0,
      execution_state: completed ? "ENGINE_COMPLETED" : "ACTIVE", answer: { availability: "unavailable" } } as ResearchRunStatus,
    scope_matches: true, requireCurrent: runCurrent } : null),
    readReport: vi.fn(async () => ({ artifact_ref: { id: "report", revision: 1 }, sections: [await reportFixture()], coverage, requireCurrent: reportCurrent })),
  };
  return { db, ports, service: createProjectGuideService(ports), launch, current, reportCurrent,
    complete: () => { completed = true; }, disappear: () => { launched = false; },
    scope: (value: string, refs = ["revision-1"]) => { digest = value; sourceRefs = refs; },
    model: (value: string) => { config = value; }, unavailable: () => { selectionAvailable = false; } };
}

describe("persisted project guide admission", () => {
  it("coalesces concurrent openings and reopen reads into one ordinary Research attempt", async () => {
    const f = fixture();
    const results = await Promise.all([f.service.ensure(context, "project", "en"), f.service.ensure(context, "project", "en")]);
    expect(results.every(result => ["PENDING", "UNKNOWN"].includes(result.state))).toBe(true);
    await f.service.ensure(context, "project", "en");
    expect(f.launch).toHaveBeenCalledTimes(1);
    expect(f.db.prepare("SELECT COUNT(*) AS n FROM project_guide_binding").get()).toEqual({ n: 1 });
    f.complete(); const ready = await f.service.read(context, "project", "en");
    expect(ready.state).toBe("PARTIAL"); expect(ready.guide?.questions).toHaveLength(3);
    expect(ready.guide?.source_basis).toEqual([{ source_revision_ref: "revision-1", title: "Measured study" }]);
    expect(ready.guide?.coverage).toEqual(coverage);
    await f.service.ensure({ ...context, credential_generation: "fresh-session" }, "project", "en");
    expect(f.launch).toHaveBeenCalledTimes(1);
  });
  it("holds an unacknowledged launch across repeated ensure and source/model changes", async () => {
    const f = fixture(); f.launch.mockRejectedValue(new Error("lost response"));
    expect((await f.service.ensure(context, "project", "en")).state).toBe("UNKNOWN");
    await f.service.ensure(context, "project", "en");
    f.scope("c".repeat(64), ["revision-new"]); f.model("e".repeat(64));
    expect((await f.service.ensure(context, "project", "ru")).state).toBe("UNKNOWN");
    expect(f.launch).toHaveBeenCalledTimes(1);
  });
  it("never prepares or launches an empty project or an unqualified model", async () => {
    const f = fixture(); f.scope("e".repeat(64), []);
    expect((await f.service.ensure(context, "project", "en")).state).toBe("EMPTY");
    f.scope("f".repeat(64)); f.unavailable();
    expect((await f.service.ensure(context, "project", "en")).state).toBe("BLOCKED");
    expect(f.launch).not.toHaveBeenCalled();
    expect(f.db.prepare("SELECT COUNT(*) AS n FROM project_guide_binding").get()).toEqual({ n: 0 });
  });
  it("does not reuse a guide after a corpus, qualified model or language identity change", async () => {
    const f = fixture(); const first = await f.service.ensure(context, "project", "en");
    f.scope("c".repeat(64), ["revision-1", "revision-added"]);
    const added = await f.service.read(context, "project", "en");
    expect(added.state).toBe("MISSING"); expect(added.identity_digest).not.toBe(first.identity_digest);
    f.model("e".repeat(64)); const model = await f.service.read(context, "project", "en");
    expect(model.identity_digest).not.toBe(added.identity_digest);
    expect((await f.service.read(context, "project", "ru")).identity_digest).not.toBe(model.identity_digest);
    expect(f.launch).toHaveBeenCalledTimes(1);
  });
  it("fails closed on post-read report revocation and exposes no guide text", async () => {
    const f = fixture(); await f.service.ensure(context, "project", "en"); f.complete();
    f.reportCurrent.mockRejectedValue(new Error("report revoked"));
    await expect(f.service.read(context, "project", "en")).rejects.toThrow("report revoked");
    expect(f.launch).toHaveBeenCalledTimes(1);
  });
  it("retains actual 3-of-10 coverage and source basis instead of presenting a complete project summary", async () => {
    const f = fixture(), refs = Array.from({ length: 10 }, (_, index) => `revision-${index + 1}`);
    f.scope("a".repeat(64), refs);
    const originalObserve = f.ports.observe;
    const ports = { ...f.ports, observe: async (...args: Parameters<ProjectGuidePorts["observe"]>) => ({
      ...await originalObserve(...args), source_titles: Object.fromEntries(refs.map(ref => [ref, `Study ${ref}`])),
    }) };
    const actualCoverage: CoverageReceipt = { ...coverage, eligible_source_refs: refs,
      represented_source_refs: refs.slice(0, 3), cited_source_refs: refs.slice(0, 1),
      omitted_sources: refs.slice(3).map(ref => ({ source_ref: ref, reason: "BUDGET_LIMIT" })) };
    vi.mocked(f.ports.readReport).mockImplementation(async () => ({ artifact_ref: { id: "report", revision: 1 },
      sections: [await reportFixture()], coverage: actualCoverage, requireCurrent: f.reportCurrent }));
    const service = createProjectGuideService(ports);
    await service.ensure(context, "project", "en"); f.complete();
    const guide = await service.read(context, "project", "en");
    expect(guide.state).toBe("PARTIAL"); expect(guide.source_count).toBe(10);
    expect(f.db.prepare("SELECT state FROM project_guide_binding").get()).toEqual({ state: "PARTIAL" });
    expect(guide.guide?.coverage).toEqual(actualCoverage);
    expect(guide.guide?.source_basis.map(source => source.source_revision_ref)).toEqual(refs.slice(0, 3));
    expect(guide.artifact_ref).toEqual({ id: "report", revision: 1 });
  });
  it("keeps a report link without fabricating missing question recommendations", async () => {
    const f = fixture(); await f.service.ensure(context, "project", "en"); f.complete();
    vi.mocked(f.ports.readReport).mockImplementation(async () => ({ artifact_ref: { id: "report", revision: 1 },
      sections: [await reportFixture(2)], coverage, requireCurrent: f.reportCurrent }));
    const guide = await f.service.read(context, "project", "en");
    expect(guide.state).toBe("INVALID"); expect(guide.guide).toBeNull(); expect(guide.artifact_ref?.id).toBe("report");
    await f.service.ensure(context, "project", "en"); expect(f.launch).toHaveBeenCalledTimes(1);
  });
  it("checks authority again after persisting verified guide metadata", async () => {
    const f = fixture(); await f.service.ensure(context, "project", "en"); f.complete();
    const update = f.ports.store.update;
    vi.spyOn(f.ports.store, "update").mockImplementation(async (...args) => {
      await update(...args);
      if (args[1] === "READY" || args[1] === "PARTIAL") f.current.mockRejectedValue(new Error("revoked during locator update"));
    });
    await expect(f.service.read(context, "project", "en")).rejects.toThrow("revoked during locator update");
  });
  it("rejects persistent identity mutation instead of launching modified request bytes", async () => {
    const f = fixture(); await f.service.ensure(context, "project", "en");
    expect(() => f.db.exec("UPDATE project_guide_binding SET request_body='{}'")).toThrow("PROJECT_GUIDE_IDENTITY_CHANGED");
  });
});
describe("guide projection from exact report evidence", () => {
  it("preserves coverage and maps audited references to current authorized handles", async () => {
    const guide = await projectGuideFromReport([await reportFixture()], coverage, { "revision-1": "Measured study" });
    expect(guide.summary[0]?.support_handle_refs).toEqual([{ id: "current-evidence", revision: 3 }]);
    expect(guide.questions).toHaveLength(3); expect(guide.coverage).toEqual(coverage);
  });
  it.each([2, 6])("rejects %i questions rather than truncating or adding static prompts", async count => {
    await expect(projectGuideFromReport([await reportFixture(count)], coverage, { "revision-1": "Measured study" })).rejects.toThrow("verified combined project guide");
  });
  it("rejects unexecuted audits and unsupported questions", async () => {
    const section = await reportFixture();
    for (const broken of [
      { ...section, semantic_verification: "NOT_EXECUTED" as const },
      { ...section, claims: section.claims.map((claim, i) => i === 1 ? { ...claim, disposition: "UNSUPPORTED" as const } : claim) },
    ]) await expect(projectGuideFromReport([broken], coverage, { "revision-1": "Measured study" })).rejects.toThrow("verified combined project guide");
  });
  it("does not hide corrupted report bytes or foreign evidence as a model-shape failure", async () => {
    const section = await reportFixture();
    for (const broken of [{ ...section, citations: [] }, { ...section, body: new TextEncoder().encode("forged") }]) {
      await expect(projectGuideFromReport([broken], coverage, { "revision-1": "Measured study" }))
        .rejects.toMatchObject({ code: "PROJECT_GUIDE_REPORT_CORRUPT" });
    }
  });
});
