/// <reference types="node" />
/// <reference types="vite/client" />
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { canonicalEvidenceJson, evidenceSha256, evidenceSha256Bytes } from "@eliotr/cloudflare-evidence";
import type { CoverageReceipt } from "@eliotr/contracts";
import type { AuthenticatedRequestContext, ResearchRunStatus } from "@eliotr/interfaces";
import migration from "../../../infra/d1/core/migrations/0166_project_guide_binding.sql?raw";
import { createProjectGuideService, PROJECT_GUIDE_REQUEST_CONTRACT, type ProjectGuideObservation, type ProjectGuidePorts } from "./project-guide-service.js";
import { createProjectGuideStore, type ProjectGuideRecord } from "./project-guide-store.js";
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
  const launch = vi.fn<ProjectGuidePorts["launch"]>(async () => { launched = true; return { workflow_instance_id: "run-guide" }; });
  const legacyContractBlocked = vi.fn(async () => false);
  const ports: ProjectGuidePorts = {
    store: createProjectGuideStore(database), observe,
    prepare: async (_actor, _project, language, identity, observation, persistedBody) => {
      const legacyBody = canonicalEvidenceJson({ language, selection: observation.selection, request_version: "eliotr.research-run-request.v4" });
      return { body: persistedBody === legacyBody ? legacyBody : canonicalEvidenceJson({ language, selection: observation.selection,
        ...PROJECT_GUIDE_REQUEST_CONTRACT }), key: `project-guide:${identity}`,
      workflow_instance_id: persistedBody === legacyBody ? "run-legacy-guide" : "run-guide" };
    }, launch, legacyContractBlocked,
    readRun: vi.fn(async (_actor, record) => launched && record.workflow_instance_id === "run-guide" ? { status: { protocol: "eliotr.research-run-status.v1", workflow_instance_id: "run-guide",
      investigation_ref: { id: "investigation", revision: completed ? 19 : 1 }, next_stage_index: completed ? 18 : 0,
      execution_state: completed ? "ENGINE_COMPLETED" : "ACTIVE", answer: { availability: "unavailable" } } as ResearchRunStatus,
    scope_matches: true, requireCurrent: runCurrent } : null),
    readReport: vi.fn(async () => ({ artifact_ref: { id: "report", revision: 1 }, sections: [await reportFixture()], coverage, requireCurrent: reportCurrent })),
  };
  return { db, ports, service: createProjectGuideService(ports), launch, legacyContractBlocked, current, reportCurrent,
    complete: () => { completed = true; }, disappear: () => { launched = false; },
    scope: (value: string, refs = ["revision-1"]) => { digest = value; sourceRefs = refs; },
    model: (value: string) => { config = value; }, unavailable: () => { selectionAvailable = false; } };
}

async function seedLegacy(f: ReturnType<typeof fixture>) {
  const observed = await f.ports.observe(context, "project");
  const identity = await evidenceSha256({ owner: context.principal_ref, project: "project", corpus: observed.corpus.digest,
    model: observed.selection, language: "en", prompt: "project-guide-evidence-v1" });
  const body = canonicalEvidenceJson({ language: "en", selection: observed.selection, request_version: "eliotr.research-run-request.v4" });
  const prepared = await f.ports.prepare(context, "project", "en", identity, observed, body);
  const record: ProjectGuideRecord = { identity_digest: identity, owner_principal_ref: context.principal_ref, project_id: "project",
    language: "en", prompt_revision: "project-guide-evidence-v1", corpus_digest: observed.corpus.digest,
    corpus_json: canonicalEvidenceJson(observed.corpus), selection_json: canonicalEvidenceJson(observed.selection),
    idempotency_key: prepared.key, request_body: prepared.body, workflow_instance_id: prepared.workflow_instance_id,
    state: "UNKNOWN", artifact_id: null, artifact_revision: null, created_at: "2026-10-17T00:00:00.000Z", updated_at: "2026-10-17T00:00:00.000Z" };
  await f.ports.store.reserve(record); await f.ports.store.update(record, "UNKNOWN");
  const retained = await f.ports.store.read(identity, context.principal_ref);
  if (retained === null) throw new Error("missing legacy fixture");
  return retained;
}

describe("persisted project guide admission", () => {
  it("binds the corrected wire/method into one new intent while retaining the exact legacy UNKNOWN", async () => {
    const f = fixture(), legacy = await seedLegacy(f); f.legacyContractBlocked.mockResolvedValue(true);
    const missing = await f.service.read(context, "project", "en");
    expect(missing.state).toBe("MISSING"); expect(missing.identity_digest).not.toBe(legacy.identity_digest);
    const observed = await f.ports.observe(context, "project");
    const basis = { owner: context.principal_ref, project: "project", corpus: observed.corpus.digest,
      model: observed.selection, language: "en", prompt: "project-guide-evidence-v1" };
    expect(missing.identity_digest).toBe(await evidenceSha256({ ...basis, request_contract: PROJECT_GUIDE_REQUEST_CONTRACT }));
    for (const contract of [{ ...PROJECT_GUIDE_REQUEST_CONTRACT, method: "evidence_review" },
      { ...PROJECT_GUIDE_REQUEST_CONTRACT, request_version: "eliotr.research-run-request.v6" }]) {
      expect(missing.identity_digest).not.toBe(await evidenceSha256({ ...basis, request_contract: contract }));
    }
    expect(f.launch).not.toHaveBeenCalled();
    const results = await Promise.all([f.service.ensure(context, "project", "en"), f.service.ensure(context, "project", "en")]);
    expect(results.every(view => view.identity_digest === missing.identity_digest)).toBe(true);
    const reload = createProjectGuideService(f.ports);
    await reload.read(context, "project", "en"); await reload.ensure(context, "project", "en");
    expect(f.launch).toHaveBeenCalledTimes(1);
    expect(f.launch.mock.calls[0]?.[1]?.identity_digest).toBe(missing.identity_digest);
    expect(await f.ports.store.read(legacy.identity_digest, context.principal_ref)).toEqual(legacy);
    expect(f.db.prepare("SELECT COUNT(*) AS n FROM project_guide_binding").get()).toEqual({ n: 2 });
  });
  it("keeps the corrected V5 UNKNOWN latched across fresh service instances and repeated reloads", async () => {
    const f = fixture(), legacy = await seedLegacy(f); f.legacyContractBlocked.mockResolvedValue(true);
    f.launch.mockRejectedValue(new Error("lost V5 launch response"));
    const current = await f.service.ensure(context, "project", "en");
    expect(current.state).toBe("UNKNOWN"); expect(current.identity_digest).not.toBe(legacy.identity_digest);
    for (let i = 0; i < 3; i++) {
      const reload = createProjectGuideService(f.ports);
      expect((await reload.read(context, "project", "en")).identity_digest).toBe(current.identity_digest);
      expect((await reload.ensure(context, "project", "en")).state).toBe("UNKNOWN");
    }
    expect(f.launch).toHaveBeenCalledTimes(1);
    expect(await f.ports.store.read(legacy.identity_digest, context.principal_ref)).toEqual(legacy);
  });
  it("does not bypass a legacy HELD record, an unproven failure, or a changed scope/model identity", async () => {
    const f = fixture(), legacy = await seedLegacy(f);
    expect((await f.service.ensure(context, "project", "en")).identity_digest).toBe(legacy.identity_digest);
    f.legacyContractBlocked.mockResolvedValue(true);
    await f.ports.store.update(legacy, "HELD"); f.legacyContractBlocked.mockClear();
    expect((await f.service.ensure(context, "project", "en")).state).toBe("UNKNOWN");
    expect(f.legacyContractBlocked).not.toHaveBeenCalled();
    await f.ports.store.update(legacy, "UNKNOWN");
    f.scope("c".repeat(64)); f.model("d".repeat(64));
    expect((await f.service.ensure(context, "project", "en")).identity_digest).toBe(legacy.identity_digest);
    expect(f.legacyContractBlocked).not.toHaveBeenCalled(); expect(f.launch).not.toHaveBeenCalled();
  });
  it("inspects the next held intent after excluding exactly the proven legacy identity", async () => {
    const f = fixture(), legacy = await seedLegacy(f); f.legacyContractBlocked.mockResolvedValue(true);
    const observed = await f.ports.observe(context, "project");
    const otherIdentity = await evidenceSha256({ owner: context.principal_ref, project: "project", corpus: observed.corpus.digest,
      model: observed.selection, language: "ru", prompt: "project-guide-evidence-v1", request_contract: PROJECT_GUIDE_REQUEST_CONTRACT });
    const other = await f.ports.prepare(context, "project", "ru", otherIdentity, observed);
    const held: ProjectGuideRecord = { ...legacy, identity_digest: otherIdentity, language: "ru", idempotency_key: other.key,
      request_body: other.body, workflow_instance_id: other.workflow_instance_id, created_at: "2026-10-17T00:01:00.000Z" };
    await f.ports.store.reserve(held); await f.ports.store.update(held, "UNKNOWN");
    const result = await f.service.ensure(context, "project", "en");
    expect(result.state).toBe("UNKNOWN"); expect(result.identity_digest).toBe(otherIdentity);
    expect(f.launch).not.toHaveBeenCalled();
    expect(await f.ports.store.read(legacy.identity_digest, context.principal_ref)).toEqual(legacy);
    expect(f.db.prepare("SELECT COUNT(*) AS n FROM project_guide_binding").get()).toEqual({ n: 2 });
  });
  it("preserves a blocking legacy UNKNOWN verbatim even when a run is observed", async () => {
    const f = fixture(), legacy = await seedLegacy(f);
    vi.mocked(f.ports.readRun).mockResolvedValue({ status: { protocol: "eliotr.research-run-status.v1",
      workflow_instance_id: legacy.workflow_instance_id, investigation_ref: { id: "prior-investigation", revision: 1 },
      execution_state: "ACTIVE", next_stage_index: 0, answer: { availability: "unavailable" } } as ResearchRunStatus,
    scope_matches: true, requireCurrent: async () => undefined });
    expect((await f.service.ensure(context, "project", "en")).state).toBe("PENDING");
    expect(await f.ports.store.read(legacy.identity_digest, context.principal_ref)).toEqual(legacy);
    expect(f.launch).not.toHaveBeenCalled();
    expect(f.db.prepare("SELECT COUNT(*) AS n FROM project_guide_binding").get()).toEqual({ n: 1 });
  });
  it("rejects corrupted legacy bytes before consulting the recovery gate", async () => {
    const f = fixture(), legacy = await seedLegacy(f); f.legacyContractBlocked.mockResolvedValue(true);
    vi.spyOn(f.ports.store, "held").mockResolvedValue({ ...legacy,
      request_body: canonicalEvidenceJson({ ...JSON.parse(legacy.request_body), unexpected_authority: "forged" }) });
    await expect(f.service.ensure(context, "project", "en")).rejects.toMatchObject({ code: "PROJECT_GUIDE_STORAGE_CORRUPT" });
    expect(f.legacyContractBlocked).not.toHaveBeenCalled(); expect(f.launch).not.toHaveBeenCalled();
    expect(await f.ports.store.read(legacy.identity_digest, context.principal_ref)).toEqual(legacy);
  });
  it("denies recovery when authority changes after preflight proof", async () => {
    const f = fixture(), legacy = await seedLegacy(f);
    f.legacyContractBlocked.mockImplementation(async () => { f.current.mockRejectedValue(new Error("authority revoked")); return true; });
    await expect(f.service.ensure(context, "project", "en")).rejects.toThrow("authority revoked");
    expect(f.launch).not.toHaveBeenCalled();
    expect(await f.ports.store.read(legacy.identity_digest, context.principal_ref)).toEqual(legacy);
    expect(f.db.prepare("SELECT COUNT(*) AS n FROM project_guide_binding").get()).toEqual({ n: 1 });
  });
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
  it("fails closed if current-contract request bytes change under an unchanged intent", async () => {
    const f = fixture(); f.launch.mockRejectedValue(new Error("pre-dispatch conflict"));
    const held = await f.service.ensure(context, "project", "en");
    if (held.identity_digest === null) throw new Error("missing guide identity");
    const original = await f.ports.store.read(held.identity_digest, context.principal_ref);
    if (original === null) throw new Error("missing held guide");
    const prepare = vi.fn<ProjectGuidePorts["prepare"]>(async (_actor, _project, _language, identity) => ({
      body: "changed-current-envelope",
      key: `project-guide:${identity}`, workflow_instance_id: "run-guide",
    }));
    const service = createProjectGuideService({ ...f.ports, prepare });
    await expect(service.read(context, "project", "en")).rejects.toMatchObject({ code: "PROJECT_GUIDE_STORAGE_CORRUPT" });
    await expect(service.ensure(context, "project", "en")).rejects.toMatchObject({ code: "PROJECT_GUIDE_STORAGE_CORRUPT" });
    expect(prepare.mock.calls.every(call => call[5] === undefined)).toBe(true);
    expect(f.launch).toHaveBeenCalledTimes(1);
    const after = await f.ports.store.read(original.identity_digest, context.principal_ref);
    expect(after).toEqual(original);
    expect(f.db.prepare("SELECT COUNT(*) AS n FROM project_guide_binding").get()).toEqual({ n: 1 });
    vi.spyOn(f.ports.store, "read").mockResolvedValue({ ...original, request_body: "corrupted-envelope" });
    await expect(service.read(context, "project", "en")).rejects.toMatchObject({ code: "PROJECT_GUIDE_STORAGE_CORRUPT" });
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
