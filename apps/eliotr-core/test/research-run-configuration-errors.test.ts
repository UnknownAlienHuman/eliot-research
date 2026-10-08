import { describe, expect, it } from "vitest";
import { WorkflowCheckpointError } from "@eliotr/cloudflare-workflows";
import { runtime, setupOrientationDatabase } from "./orientation-fixture.js";
import { captureResearchRunConfiguration } from "../src/research-run-configuration.js";

function capture(tag: string, select: () => Promise<null>): Promise<unknown> {
  return captureResearchRunConfiguration(runtime, {
    operation_id: `configuration-error-${tag}-${crypto.randomUUID()}`,
    investigation_id: `investigation-${tag}`,
    principal_ref: "owner-admission-error-test",
    deployment_generation: runtime.DEPLOYMENT_GENERATION,
    select_project_configuration: select,
  });
}

describe("run configuration project-selection error classification", () => {
  it("preserves allowlisted typed owner/config-selection failures but classifies unknown callback failures as storage-unavailable", async () => {
    await setupOrientationDatabase();
    const typedOwnerFailure = Object.assign(new Error("owner context is required"), {
      name: "ResearchProjectModelConfigurationAuthorityError",
      code: "RESEARCH_PROJECT_MODEL_CONFIGURATION_OWNER_REQUIRED",
      status: 403,
    });
    await expect(capture("owner", async () => { throw typedOwnerFailure; }))
      .rejects.toMatchObject({ code: "RESEARCH_PROJECT_MODEL_CONFIGURATION_OWNER_REQUIRED", status: 403 });

    let unknownFailure: unknown;
    try { await capture("unknown", async () => { throw new Error("unclassified project callback failure"); }); }
    catch (error) { unknownFailure = error; }
    expect(unknownFailure).toBeInstanceOf(WorkflowCheckpointError);
    expect(unknownFailure).toMatchObject({ code: "WORKFLOW_STORAGE_UNAVAILABLE" });
  });
});
