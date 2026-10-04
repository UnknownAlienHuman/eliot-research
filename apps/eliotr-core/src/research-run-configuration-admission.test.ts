import { describe, expect, it, vi } from "vitest";
import type { AuthenticatedRequestContext, QueryRequest } from "@eliotr/interfaces";
import type { CaptureResearchRunConfigurationInput, ResolvedResearchRunConfiguration } from "./research-run-configuration.js";
import type { Env } from "./env.js";
import { resolveResearchRunAdmissionConfiguration } from "./research-run-configuration-admission.js";

const env = {} as Env;
const actor = Object.freeze({ operation_id: "run-admission-test", investigation_id: "investigation-test",
  principal_ref: "owner-test", deployment_generation: "deployment-test" });
const context = { principal_ref: actor.principal_ref, credential_generation: "credential-test",
  client_class: "owner_pwa", request: new Request("https://owner.example/api/v1/research/run") } as unknown as AuthenticatedRequestContext;
const snapshot = { env, mode: "snapshot-v1", configuration_ref: "rrc-test", configuration_sha256: "a".repeat(64),
  model_selections: [], project_configuration_ref: "rpmc-test", project_configuration_sha256: "b".repeat(64) } as ResolvedResearchRunConfiguration;
const legacy = { ...snapshot, mode: "legacy-installed", configuration_ref: null, configuration_sha256: null,
  project_configuration_ref: null, project_configuration_sha256: null } as ResolvedResearchRunConfiguration;
const scope = (scope_expression: QueryRequest["scope_expression"], new_run: boolean,
  configuration_required?: number): Parameters<typeof resolveResearchRunAdmissionConfiguration>[1] => ({
  actor, context, scope_expression, new_run,
  ...(configuration_required === undefined ? {} : { configuration_required }),
  require_current_scope: async () => {},
});

describe("research run configuration admission", () => {
  it("selects project configuration only for a new operation and replays retries from the immutable run row", async () => {
    const capture = vi.fn(async (_env: Env, _input: CaptureResearchRunConfigurationInput) => snapshot);
    const read = vi.fn(async () => legacy);
    const dependencies = { capture, read };

    await resolveResearchRunAdmissionConfiguration(env, scope({ kind: "PROJECT", project_id: "project-test" }, true), dependencies);
    const freshCapture = capture.mock.calls[0]?.[1];
    expect(freshCapture?.select_project_configuration).toBeTypeOf("function");

    await resolveResearchRunAdmissionConfiguration(env, scope({ kind: "PROJECT", project_id: "project-test" }, false, 1), dependencies);
    const retryCapture = capture.mock.calls[1]?.[1];
    expect(retryCapture?.select_project_configuration).toBeUndefined();
    expect(read).not.toHaveBeenCalled();
  });

  it("keeps pre-snapshot legacy retries on their installed configuration path", async () => {
    const capture = vi.fn(async (_env: Env, _input: CaptureResearchRunConfigurationInput) => snapshot);
    const read = vi.fn(async () => legacy);
    await resolveResearchRunAdmissionConfiguration(env, scope({ kind: "PROJECT", project_id: "project-test" }, false, 0), { capture, read });
    expect(read).toHaveBeenCalledOnce();
    expect(capture).not.toHaveBeenCalled();
  });

  it("maps a missing single-project scope to the nonretryable configuration admission error", async () => {
    const capture = vi.fn(async (_env: Env, input: CaptureResearchRunConfigurationInput) => {
      await input.select_project_configuration?.();
      return snapshot;
    });
    const read = vi.fn(async () => legacy);
    await expect(resolveResearchRunAdmissionConfiguration(env,
      scope({ kind: "GLOBAL_LIBRARY" }, true), { capture, read }))
      .rejects.toMatchObject({ code: "RESEARCH_AGENT_NOT_CONFIGURED", status: 503, retryable: false });
    expect(read).not.toHaveBeenCalled();
  });
});
