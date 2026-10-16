import { describe, expect, it } from "vitest";
import type { QueryRequest } from "@eliotr/interfaces";
import type { ResearchRunConfigurationAssociation } from "@eliotr/cloudflare-research";
import { WorkflowCheckpointError } from "@eliotr/cloudflare-workflows";
import type { CaptureResearchRunConfigurationInput } from "./research-run-configuration.js";
import type { ResearchProjectConfigurationGrantReadAuthority } from "./research-project-configuration.js";
import type { ProjectClientGrant } from "@eliotr/contracts";
import {
  resolveResearchRunConfigurationAdmission,
  type ResearchRunConfigurationAdmissionInputV1,
} from "./research-run-configuration-admission.js";

interface ResolvedFixture {
  readonly mode: "snapshot-v1" | "legacy-installed";
  readonly configuration_ref: string | null;
  readonly configuration_sha256: string | null;
}

const actor: ResearchRunConfigurationAssociation = Object.freeze({
  operation_id: "run-admission-v3-1",
  investigation_id: "investigation-admission-v3-1",
  principal_ref: "owner-admission-v3-1",
  deployment_generation: "deployment-admission-v3-1",
});

const project = (project_id: string): QueryRequest["scope_expression"] => ({ kind: "PROJECT", project_id });
const union = (left: string, right: string): QueryRequest["scope_expression"] => ({
  kind: "UNION", left: project(left), right: project(right),
});

function harness(options: {
  readonly scope: QueryRequest["scope_expression"];
  readonly new_run: boolean;
  readonly selected_project_id?: string;
  readonly principal_ref?: string;
  readonly project_configuration_read_authority?: ResearchProjectConfigurationGrantReadAuthority;
  /** Mirrors captureResearchRunConfiguration checkpointing a null selection. */
  readonly available_projects?: readonly string[];
}) {
  const requested: string[] = [];
  const captured: CaptureResearchRunConfigurationInput[] = [];
  const runActor = options.principal_ref === undefined ? actor : { ...actor, principal_ref: options.principal_ref };
  // captureResearchRunConfiguration raises WORKFLOW_CONFIGURATION_MISSING when the
  // authorized selection resolves to null; the replica below keeps that contract.
  const missing = new WorkflowCheckpointError("WORKFLOW_CONFIGURATION_MISSING");
  const dependencies = {
    capture: async (input: CaptureResearchRunConfigurationInput) => {
      captured.push(input);
      if (input.select_project_configuration !== undefined) {
        const selected = await input.select_project_configuration();
        if (selected === null || options.available_projects?.includes(selected.project_id ?? "") === false) throw missing;
      }
      return { mode: "snapshot-v1", configuration_ref: "rrc-v3", configuration_sha256: "a".repeat(64) } as ResolvedFixture;
    },
    read: async () => ({ mode: "legacy-installed", configuration_ref: null, configuration_sha256: null } as ResolvedFixture),
    select_current_project_configuration: async (project_id: string) => {
      requested.push(project_id);
      return { owner_ref: options.project_configuration_read_authority?.lease.grant.grantor_principal_ref ?? runActor.principal_ref,
        project_id, configuration_ref: "rpmc-v3",
        configuration_sha256: "b".repeat(64), selection_revision: 3, configuration_json: "{}" };
    },
    require_single_owned_project: (): never => { throw new Error("SINGLE_OWNED_PROJECT_REQUIRED"); },
    require_valid_configuration_marker: (): never => { throw new Error("INVALID_CONFIGURATION_MARKER"); },
  };
  const input: ResearchRunConfigurationAdmissionInputV1 = {
    actor: runActor, scope_expression: options.scope, new_run: options.new_run,
    ...(options.selected_project_id === undefined ? {} : { selected_project_id: options.selected_project_id }),
    ...(options.project_configuration_read_authority === undefined ? {} : {
      project_configuration_read_authority: options.project_configuration_read_authority,
    }),
  };
  return { requested, captured, input, dependencies };
}

function grantAuthority(project_id: string, requireGrantCurrent: () => Promise<void> = async () => {}) {
  const grant: ProjectClientGrant = {
    protocol: "eliotr.project-client-grant.v1",
    grant_id: "grant-admission-v3-1",
    project_id,
    grantor_principal_ref: "owner-grantor-v3-1",
    revision: 2,
    state: "ACTIVE",
    grantee: { issuer: "https://test-example.cloudflareaccess.com", authentication_method: "service_token",
      subject: "service-admission-v3-1.access" },
    allowed_operations: ["run"],
    ingest_namespace_ids: [],
    expires_at: "2026-12-01T00:00:00.000Z",
    created_at: "2026-10-15T00:00:00.000Z",
    updated_at: "2026-10-15T00:00:00.000Z",
  };
  return {
    lease: { grant, project_generation: 7, requireGrantCurrent },
    require_current_scope: async () => {},
  } satisfies ResearchProjectConfigurationGrantReadAuthority;
}

function resolve(input: ResearchRunConfigurationAdmissionInputV1,
  dependencies: Parameters<typeof resolveResearchRunConfigurationAdmission<ResolvedFixture>>[1]) {
  return resolveResearchRunConfigurationAdmission<ResolvedFixture>(input, dependencies);
}

describe("research run configuration admission selection project", () => {
  it("uses the explicit owner-selected project for a multi-project v3 scope and ignores the other projects' configurations", async () => {
    const h = harness({ scope: union("project-alpha", "project-beta"), new_run: true, selected_project_id: "project-beta" });
    const resolved = await resolve(h.input, h.dependencies);
    expect(h.requested).toEqual(["project-beta"]);
    expect(resolved.mode).toBe("snapshot-v1");
    expect(h.captured[0]?.select_project_configuration).toBeTypeOf("function");
  });

  it("passes the exact current pin and optional language into the run snapshot capture", async () => {
    const h = harness({ scope: union("project-alpha", "project-beta"), new_run: true,
      selected_project_id: "project-beta" });
    const pin = { configuration_project_id: "project-beta", configuration_ref: "rpmc-v3",
      configuration_sha256: "b".repeat(64), selection_revision: 3 };
    const input: ResearchRunConfigurationAdmissionInputV1 = { ...h.input,
      selected_project_configuration_pin: pin, output_language: "ru" };
    await resolve(input, h.dependencies);
    expect(h.requested).toEqual(["project-beta"]);
    expect(h.captured[0]).toMatchObject({ selected_project_configuration_pin: pin, output_language: "ru" });
  });

  it("routes builtin Cloudflare selection to the installed qualified snapshot without reading project defaults", async () => {
    const h = harness({ scope: union("project-alpha", "project-beta"), new_run: true });
    const installedPin = { expected_model_id: "@cf/meta/llama-3.1-8b-instruct" };
    const input: ResearchRunConfigurationAdmissionInputV1 = {
      ...h.input,
      installed_native_model_pin: installedPin,
      output_language: "en",
    };
    await resolve(input, h.dependencies);
    expect(h.requested).toEqual([]);
    expect(h.captured[0]).toMatchObject({ allow_installed_native_default: true,
      installed_native_model_pin: installedPin, output_language: "en" });
    expect(h.captured[0]?.configuration_project_id).toBeUndefined();
    expect(h.captured[0]?.select_project_configuration).toBeUndefined();
  });

  it("keeps rejecting a multi-project scope without an explicit selector", async () => {
    const h = harness({ scope: union("project-alpha", "project-beta"), new_run: true });
    await expect(resolve(h.input, h.dependencies))
      .rejects.toMatchObject({ message: "SINGLE_OWNED_PROJECT_REQUIRED" });
    expect(h.requested).toEqual([]);
  });

  it("keeps the single-project v1 path selecting the scope project when no selector is supplied", async () => {
    const h = harness({ scope: project("project-alpha"), new_run: true });
    await resolve(h.input, h.dependencies);
    expect(h.requested).toEqual(["project-alpha"]);
  });

  it("never resolves current selection for a retry, even when a selector is supplied", async () => {
    const h = harness({ scope: union("project-alpha", "project-beta"), new_run: false, selected_project_id: "project-beta" });
    await resolve(h.input, h.dependencies);
    expect(h.requested).toEqual([]);
    expect(h.captured[0]?.select_project_configuration).toBeUndefined();
  });

  it("fails closed when the selected project has no current configuration", async () => {
    // The selected project is not owned by this principal, so readSelected returns
    // null; the other two projects are owned but the selector never reads them.
    const h = harness({ scope: union("project-alpha", "project-beta"), new_run: true, selected_project_id: "project-foreign",
      available_projects: ["project-alpha", "project-beta"] });
    const dependencies = {
      ...h.dependencies,
      select_current_project_configuration: async (project_id: string) => {
        if (project_id === "project-foreign") return null;
        return { owner_ref: actor.principal_ref, project_id, configuration_ref: "rpmc-v3",
          configuration_sha256: "b".repeat(64), selection_revision: 2, configuration_json: "{}" };
      },
    };
    await expect(resolve(h.input, dependencies)).rejects.toMatchObject({
      code: "WORKFLOW_CONFIGURATION_MISSING",
    });
  });

  it("pins delegated selection to the verified grant project and keeps the service actor", async () => {
    const authority = grantAuthority("project-granted-v3");
    const h = harness({ scope: project("project-granted-v3"), new_run: true,
      principal_ref: "service-admission-v3-1", project_configuration_read_authority: authority });
    await resolve(h.input, h.dependencies);
    expect(h.requested).toEqual(["project-granted-v3"]);
    expect(h.captured[0]?.principal_ref).toBe("service-admission-v3-1");
    expect(h.captured[0]?.project_configuration_read_authority).toBe(authority);
  });

  it("rejects a foreign selected project or revoked grant before configuration read", async () => {
    const foreignAuthority = grantAuthority("project-granted-v3");
    const foreign = harness({ scope: project("project-granted-v3"), new_run: true,
      selected_project_id: "project-foreign-v3", principal_ref: "service-admission-v3-1",
      project_configuration_read_authority: foreignAuthority });
    await expect(resolve(foreign.input, foreign.dependencies))
      .rejects.toThrow("INVALID_CONFIGURATION_MARKER");
    expect(foreign.requested).toEqual([]);

    const revokedAuthority = grantAuthority("project-granted-v3", async () => {
      throw new Error("REVOKED_GRANT");
    });
    const revoked = harness({ scope: project("project-granted-v3"), new_run: true,
      principal_ref: "service-admission-v3-1", project_configuration_read_authority: revokedAuthority });
    await expect(resolve(revoked.input, revoked.dependencies)).rejects.toThrow("REVOKED_GRANT");
    expect(revoked.requested).toEqual([]);
  });
});

