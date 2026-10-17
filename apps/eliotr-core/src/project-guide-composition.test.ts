import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthenticatedRequestContext } from "@eliotr/interfaces";
import type { ProjectGuidePorts } from "@eliotr/cloudflare-research-runtime/project-guide-service.js";
import type { Env } from "./env.js";
import { createOwnerProjectGuideService } from "./project-guide-composition.js";

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
vi.mock("./research-run-service.js", () => ({ createResearchRunService: () => ({ run: f.run }),
  parseResearchRunTransportRequest: f.parse, researchRunIdentityDigest: f.identity }));
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
describe("guide composition keeps canonical Research admission", () => {
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
      "product", "query", "request_version", "scope_expression", "selection"].sort());
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
