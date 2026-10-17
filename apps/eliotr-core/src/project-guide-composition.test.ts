import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthenticatedRequestContext } from "@eliotr/interfaces";
import { RESEARCH_DEFAULT_INQUIRY_PROTOCOL_REF } from "@eliotr/contracts";
import { canonicalEvidenceJson } from "@eliotr/cloudflare-evidence";
import type { ProjectGuidePorts, ProjectGuideRecord } from "@eliotr/cloudflare-research-runtime/project-guide-service.js";
import { SERVER_OWNED_BRANCH_QUERY_HANDLER_GENERATION } from "@eliotr/cloudflare-research-runtime/research-stage-handlers.js";
import type { Env } from "./env.js";
import { createOwnerProjectGuideService } from "./project-guide-composition.js";
import type * as ResearchRunAdmission from "./research-run-service.js";

const f = vi.hoisted(() => ({ members: [{ source_revision_ref: "revision", source_owner_generation: "owner-generation", policy_closure_ref: "policy" }],
  selection: { owner_id: "owner", project_id: "project", selection_revision: 2, configuration_ref: `rpmc-${"b".repeat(64)}`,
    configuration_sha256: "b".repeat(64), configuration: { vars: {} } },
  readSelected: vi.fn(), requireRead: vi.fn(), grant: vi.fn(), run: vi.fn(), parse: vi.fn(), identity: vi.fn(),
}));
vi.mock("@eliotr/cloudflare-navigation", async original => ({ ...await original<Record<string, unknown>>(),
  createOwnerScopeAuthority: () => ({ exhaustiveRequireReadPolicy: f.requireRead,
    exhaustiveResolveAtom: async () => ({ atom_generation_ref: "atom", members: f.members }),
    exhaustiveSources: async (refs: string[]) => refs.map(ref => ({ revision: { source_revision_ref: ref }, title: `Source ${ref}` })),
    exhaustiveResolveAuthorityClosure: async () => ({ client_fence_valid: true, denied_source_revision_refs: [],
      disclosure_closure_digest: "c".repeat(64), purge_ledger_revision: 0 }), grant: f.grant, exhaustiveGrant: f.grant }),
}));
vi.mock("@eliotr/cloudflare-research-runtime/project-guide-service.js", async original => ({
  ...await original<Record<string, unknown>>(), createProjectGuideStore: () => ({}), createProjectGuideService: (ports: unknown) => ports,
}));
vi.mock("./research-project-configuration-composition.js", () => ({
  createOwnerResearchProjectConfigurationService: () => ({ readSelected: f.readSelected }),
}));
vi.mock("./research-run-service.js", async original => ({ ...await original<Record<string, unknown>>(),
  createResearchRunService: () => ({ run: f.run }), parseResearchRunTransportRequest: f.parse, researchRunIdentityDigest: f.identity }));
vi.mock("./research-run-read-authorization.js", () => ({ createResearchRunReadEnvironment: vi.fn() }));
vi.mock("./research-artifact-reauthorization-http.js", () => ({ prepareArtifactReadReauthorization: vi.fn(),
  reopenOwnerArtifactDraft: vi.fn(), reopenOwnerArtifactSectionCitations: vi.fn() }));
vi.mock("./research-project-configuration.js", () => ({ ResearchProjectModelConfigurationAuthorityError: class extends Error {} }));
vi.mock("./http-errors.js", () => ({ HttpRequestError: class extends Error {
  constructor(readonly code: string, readonly status: number, message: string) { super(message); }
} }));

const context = { principal_ref: "owner", client_class: "owner_pwa", credential_generation: "credential",
  request: new Request("https://owner.invalid/guide", { headers: { "x-eliotr-csrf": "1" } }) } as AuthenticatedRequestContext;
beforeEach(() => {
  f.members = [{ source_revision_ref: "revision", source_owner_generation: "owner-generation", policy_closure_ref: "policy" }];
  for (const mock of [f.readSelected, f.requireRead, f.grant, f.run, f.parse, f.identity]) mock.mockReset();
});
async function legacyPreflightFixture() {
  const admission = await vi.importActual<typeof ResearchRunAdmission>("./research-run-service.js");
  f.parse.mockImplementation(admission.parseResearchRunTransportRequest);
  f.identity.mockImplementation(admission.researchRunIdentityDigest);
  f.readSelected.mockResolvedValue({ ...f.selection, configuration: { vars: {
    ELIOTR_RESEARCH_BRANCH_QUERY_BUDGET_PROFILE_JSON: canonicalEvidenceJson({ protocol: "eliotr.research.branch-query-budget-profile.v1",
      profile_id: "owner-research-existing-bounds-v1", profile_generation: 1,
      budgets: { candidate_limit: 200, evidence_limit: 16, max_evidence_bytes: 65536, max_query_legs: 1, scan_limit: 100 } }),
  } } });
  const presence = vi.fn(async (): Promise<{ present: number } | null> => ({ present: 0 }));
  const native = vi.fn<Env["RESEARCH_WORKFLOW"]["get"]>(async () => { throw new Error("instance.not_found"); });
  const prepare = vi.fn((_query: string) => ({ bind: vi.fn(() => ({ first: presence })) }));
  const env = { CORE_DB: { prepare }, RESEARCH_WORKFLOW: { get: native } } as unknown as Env;
  const ports = createOwnerProjectGuideService(env) as unknown as ProjectGuidePorts;
  const observed = await ports.observe(context, "project"), identity = "a".repeat(64);
  const current = await ports.prepare(context, "project", "en", identity, observed);
  const legacy = { ...JSON.parse(current.body), request_version: "eliotr.research-run-request.v4" }; delete legacy.method;
  const retained = await ports.prepare(context, "project", "en", identity, observed, canonicalEvidenceJson(legacy));
  const record: ProjectGuideRecord = { identity_digest: identity, owner_principal_ref: "owner", project_id: "project", language: "en",
    prompt_revision: "project-guide-evidence-v1", corpus_digest: observed.corpus.digest,
    corpus_json: canonicalEvidenceJson(observed.corpus), selection_json: canonicalEvidenceJson(observed.selection),
    idempotency_key: retained.key, request_body: retained.body, workflow_instance_id: retained.workflow_instance_id,
    state: "UNKNOWN", artifact_id: null, artifact_revision: null, created_at: "2026-10-17T00:00:00.000Z", updated_at: "2026-10-17T00:00:00.000Z" };
  if (ports.legacyContractBlocked === undefined) throw new Error("missing legacy preflight gate");
  return { ports, observed, record, presence, native, prepare, blocked: ports.legacyContractBlocked };
}

describe("guide composition keeps canonical Research admission", () => {
  it("logs bounded phases and only the trusted native error message while rethrowing the same failure", async () => {
    const log = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const g = await legacyPreflightFixture();
      expect(await g.blocked(context, g.record, g.observed)).toBe(true);
      expect(log.mock.calls.map(call => JSON.parse(String(call[0])).phase)).toEqual([
        "selected-pin:START", "selected-pin:OK", "deterministic-rejection:START", "deterministic-rejection:OK",
        "D1-absence:START", "D1-absence:OK", "native-absence:START", "native-absence:OK",
        "post-currentness:START", "post-currentness:OK",
      ]);
      log.mockClear();
      const nativeError = Object.assign(new Error("trusted native binding diagnostic"),
        { code: "NATIVE_UNAVAILABLE", request_body: "private request", provider_body: "private provider" });
      g.native.mockRejectedValueOnce(nativeError);
      await expect(g.blocked(context, g.record, g.observed)).rejects.toBe(nativeError);
      const logged = log.mock.calls.map(call => JSON.parse(String(call[0])));
      expect(logged.at(-1)).toEqual({ event: "project_guide_legacy_recovery_phase", phase: "native-absence:ERROR",
        error_class: "Error", error_code: "NATIVE_UNAVAILABLE", native_error_message: "trusted native binding diagnostic" });
      expect(JSON.stringify(logged)).not.toContain("private request"); expect(JSON.stringify(logged)).not.toContain("private provider");
      log.mockClear();
      const selectedError = Object.assign(new Error("private source and key body"), { code: "AUTHORITY_READ_FAILED" });
      f.readSelected.mockRejectedValueOnce(selectedError);
      await expect(g.blocked(context, g.record, g.observed)).rejects.toBe(selectedError);
      expect(log.mock.calls.map(call => JSON.parse(String(call[0]))).at(-1)).toEqual({
        event: "project_guide_legacy_recovery_phase", phase: "selected-pin:ERROR", error_class: "Error", error_code: "AUTHORITY_READ_FAILED",
      });
      expect(JSON.stringify(log.mock.calls)).not.toContain("private source and key body");
      expect(f.run).not.toHaveBeenCalled(); expect(f.grant).not.toHaveBeenCalled();
    } finally { log.mockRestore(); }
  });
  it("allows a contract successor only after pure V4/profile rejection and native plus investigation absence", async () => {
    const g = await legacyPreflightFixture();
    expect(await g.blocked(context, g.record, g.observed)).toBe(true);
    expect(g.native).toHaveBeenCalledWith(g.record.workflow_instance_id);
    expect(g.prepare.mock.calls[0]?.[0]).toContain("investigation_ledger_head");
    expect(f.run).not.toHaveBeenCalled(); expect(f.grant).not.toHaveBeenCalled();
  });
  it.each([1, null, 7])("does not infer absence from D1 admission readback %s", async present => {
    const g = await legacyPreflightFixture();
    g.presence.mockResolvedValue(present === null ? null : { present });
    if (present === 1) expect(await g.blocked(context, g.record, g.observed)).toBe(false);
    else await expect(g.blocked(context, g.record, g.observed)).rejects.toMatchObject({ code: "PROJECT_GUIDE_ADMISSION_UNAVAILABLE" });
    expect(g.native).not.toHaveBeenCalled(); expect(f.run).not.toHaveBeenCalled();
  });
  it("does not treat an existing native instance or unavailable native status as absence", async () => {
    const g = await legacyPreflightFixture();
    g.native.mockResolvedValueOnce({ id: g.record.workflow_instance_id } as WorkflowInstance);
    expect(await g.blocked(context, g.record, g.observed)).toBe(false);
    g.native.mockRejectedValueOnce(new Error("native status unavailable"));
    await expect(g.blocked(context, g.record, g.observed)).rejects.toThrow("native status unavailable");
    expect(f.run).not.toHaveBeenCalled();
  });
  it("keeps a valid V4 request without a captured branch budget held as unknown", async () => {
    const g = await legacyPreflightFixture(); f.readSelected.mockResolvedValue(f.selection);
    expect(await g.blocked(context, g.record, g.observed)).toBe(false);
    expect(g.native).not.toHaveBeenCalled(); expect(g.presence).not.toHaveBeenCalled(); expect(f.run).not.toHaveBeenCalled();
  });
  it("rechecks source authority after the native absence observation", async () => {
    const g = await legacyPreflightFixture();
    g.native.mockImplementation(async () => {
      f.members = [...f.members, { source_revision_ref: "added", source_owner_generation: "owner-generation", policy_closure_ref: "policy" }];
      throw new Error("instance.not_found");
    });
    await expect(g.blocked(context, g.record, g.observed)).rejects.toMatchObject({ code: "PROJECT_GUIDE_AUTHORITY_CHANGED" });
    expect(f.run).not.toHaveBeenCalled(); expect(f.grant).not.toHaveBeenCalled();
  });
  it("prepares an explicit E0 lookup consumable by the selected branch budget without dispatching", async () => {
    const admission = await vi.importActual<typeof ResearchRunAdmission>("./research-run-service.js");
    f.readSelected.mockResolvedValue(f.selection);
    f.parse.mockImplementation(admission.parseResearchRunTransportRequest);
    f.identity.mockImplementation(admission.researchRunIdentityDigest);
    const ports = createOwnerProjectGuideService({ CORE_DB: {} } as Env) as unknown as ProjectGuidePorts;
    const observed = await ports.observe(context, "project");
    const prepared = await ports.prepare(context, "project", "en", "a".repeat(64), observed);
    const parsed = admission.parseResearchRunTransportRequest(JSON.parse(prepared.body));
    const profile = {
      protocol: "eliotr.research.branch-query-budget-selection.v1" as const,
      profile_id: "owner-research-existing-bounds-v1", profile_generation: 1,
      budgets: { candidate_limit: 200, evidence_limit: 16, max_evidence_bytes: 65536, max_query_legs: 1, scan_limit: 100 },
      selected_configuration: { owner_ref: "owner", project_id: "project", configuration_ref: f.selection.configuration_ref,
        configuration_sha256: f.selection.configuration_sha256, selection_revision: 2 },
    };
    const selected = admission.selectResearchRunHandlerGeneration({ lane: "exploratory", prior_handler_generation: null,
      explicit_protocol: parsed.request.inquiry_protocol_ref !== undefined, delegated: false,
      request_max_results: parsed.request.max_results, managed_primary_available: true,
      branch_query_budget_selection: profile });
    expect(selected).toBe(SERVER_OWNED_BRANCH_QUERY_HANDLER_GENERATION);
    expect(parsed.request).toMatchObject({ evidence_grade: "E0", budget_ref: "research-budget-v1", max_results: 16,
      inquiry_protocol_ref: RESEARCH_DEFAULT_INQUIRY_PROTOCOL_REF });
    const legacy = { ...JSON.parse(prepared.body), request_version: "eliotr.research-run-request.v4" };
    delete legacy.method;
    const original = admission.parseResearchRunTransportRequest(legacy);
    expect(() => admission.selectResearchRunHandlerGeneration({ lane: "exploratory", prior_handler_generation: null,
      explicit_protocol: original.request.inquiry_protocol_ref !== undefined, delegated: false,
      request_max_results: original.request.max_results, managed_primary_available: true,
      branch_query_budget_selection: profile })).toThrow(expect.objectContaining({ code: "RESEARCH_CONFLICT" }));
    expect(f.run).not.toHaveBeenCalled(); expect(f.grant).not.toHaveBeenCalled();
  });
  it("retains only exact legacy reservation bytes and run identity without replay or relaxed decoding", async () => {
    const admission = await vi.importActual<typeof ResearchRunAdmission>("./research-run-service.js");
    f.readSelected.mockResolvedValue(f.selection);
    f.parse.mockImplementation(admission.parseResearchRunTransportRequest);
    f.identity.mockImplementation(admission.researchRunIdentityDigest);
    const ports = createOwnerProjectGuideService({ CORE_DB: {} } as Env) as unknown as ProjectGuidePorts;
    const observed = await ports.observe(context, "project"), identity = "a".repeat(64);
    const current = await ports.prepare(context, "project", "en", identity, observed);
    const legacy = { ...JSON.parse(current.body), request_version: "eliotr.research-run-request.v4" };
    delete legacy.method;
    const originalBody = canonicalEvidenceJson(legacy);
    const retained = await ports.prepare(context, "project", "en", identity, observed, originalBody);
    const original = admission.parseResearchRunTransportRequest(legacy);
    const digest = await admission.researchRunIdentityDigest(original.request, original.selection);
    const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`owner|project-guide:${identity}|${digest}`));
    const hex = [...new Uint8Array(bytes)].map(value => value.toString(16).padStart(2, "0")).join("");
    expect(retained).toEqual({ body: originalBody, key: `project-guide:${identity}`, workflow_instance_id: `run-${hex.slice(0, 48)}` });
    expect(retained.workflow_instance_id).not.toBe(current.workflow_instance_id);
    for (const corrupted of [canonicalEvidenceJson({ ...legacy, unexpected_authority: "forged" }),
      canonicalEvidenceJson({ ...legacy, max_results: 1 }), canonicalEvidenceJson({ ...legacy, query: "changed" }),
      ` ${originalBody}`]) {
      const expected = await ports.prepare(context, "project", "en", identity, observed, corrupted);
      expect(expected.body).not.toBe(corrupted);
    }
    expect(f.run).not.toHaveBeenCalled(); expect(f.grant).not.toHaveBeenCalled();
  });
  it("pins the selected qualified configuration and inherits the existing scope/results/budget path without grants", async () => {
    f.readSelected.mockResolvedValue(f.selection); f.identity.mockResolvedValue("d".repeat(64));
    f.parse.mockImplementation(body => ({ request: body, selection: { request_version: body.request_version, selection: body.selection } }));
    const ports = createOwnerProjectGuideService({ CORE_DB: {} } as Env) as unknown as ProjectGuidePorts;
    const observed = await ports.observe(context, "project");
    const prepared = await ports.prepare(context, "project", "en", "a".repeat(64), observed);
    const body = JSON.parse(prepared.body);
    expect(body.selection).toEqual({ configuration_project_id: "project", configuration_ref: f.selection.configuration_ref,
      configuration_sha256: f.selection.configuration_sha256, selection_revision: 2 });
    expect(body.scope_expression).toEqual({ kind: "PROJECT", project_id: "project" });
    expect(Object.keys(body).sort()).toEqual(["budget_ref", "evidence_grade", "literals", "max_results", "output_language",
      "method", "product", "query", "request_version", "scope_expression", "selection"].sort());
    expect(body.request_version).toBe("eliotr.research-run-request.v5"); expect(body.method).toBe("lookup");
    f.run.mockResolvedValue({ workflow_instance_id: prepared.workflow_instance_id });
    await ports.launch(context, { identity_digest: "a".repeat(64), owner_principal_ref: "owner", project_id: "project",
      language: "en", prompt_revision: "project-guide-evidence-v1", corpus_digest: observed.corpus.digest,
      corpus_json: JSON.stringify(observed.corpus), selection_json: JSON.stringify(observed.selection),
      idempotency_key: prepared.key, request_body: prepared.body, workflow_instance_id: prepared.workflow_instance_id,
      state: "HELD", artifact_id: null, artifact_revision: null, created_at: new Date().toISOString(), updated_at: new Date().toISOString() });
    const [actor, request] = f.run.mock.calls[0] ?? [];
    expect(request).toEqual(body);
    expect(actor.request.headers.get("idempotency-key")).toBe(prepared.key);
    expect(await actor.request.text()).toBe(prepared.body);
    await observed.requireCurrent(); expect(f.grant).not.toHaveBeenCalled();
    f.members = [...f.members, { source_revision_ref: "added", source_owner_generation: "owner-generation", policy_closure_ref: "policy" }];
    await expect(observed.requireCurrent()).rejects.toMatchObject({ code: "PROJECT_GUIDE_AUTHORITY_CHANGED" });
  });
  it("resolves an empty project without model/configuration reads, grants or Research dispatch", async () => {
    f.members = [];
    const ports = createOwnerProjectGuideService({ CORE_DB: {} } as Env) as unknown as ProjectGuidePorts;
    const observed = await ports.observe(context, "project");
    expect(observed.corpus.source_revision_refs).toEqual([]); expect(observed.selection).toBeNull();
    await observed.requireCurrent();
    expect(f.readSelected).not.toHaveBeenCalled(); expect(f.grant).not.toHaveBeenCalled(); expect(f.run).not.toHaveBeenCalled();
  });
});
