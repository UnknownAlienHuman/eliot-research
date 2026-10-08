import { beforeAll, describe, expect, it } from "vitest";
import type { AuthenticatedRequestContext } from "@eliotr/interfaces";
import { readProjectSourceContent } from "../src/source-content.js";
import { db, insert, principal, runtime, seedSource, setupOrientationDatabase } from "./orientation-fixture.js";

beforeAll(async () => {
  await setupOrientationDatabase();
  await seedSource("mcp-source-member");
  await insert("project", { project_id: "mcp-source-project", title: "MCP Source Project",
    default_disclosure: "private", retention_policy_ref: "retention-1", default_source_policy_ref: "policy-1",
    default_model_profile_ref: "model-1", default_depth_profile_ref: "depth-1", created_at: "2020-01-01T00:00:00.000Z" });
  await insert("project_source_membership", { project_id: "mcp-source-project", source_id: "mcp-source-member",
    role: "reference", valid_from: "2020-01-01T00:00:00.000Z", valid_to: null, membership_generation: 1 });
});

function context(owner = principal): AuthenticatedRequestContext {
  return { request: new Request("https://mcp.example/mcp"), principal_ref: owner,
    credential_generation: "credential-v1", client_class: "owner_pwa", trace_id: "mcp-source-test" };
}

describe("Managed OAuth exact source authority", () => {
  it("denies a foreign project membership before opening R2", async () => {
    let bucketRead = false;
    const bucket = { async head() { bucketRead = true; throw new Error("R2 must not be read"); } } as unknown as R2Bucket;
    await expect(readProjectSourceContent({ ...runtime, CORE_DB: db, EVIDENCE_BUCKET: bucket }, context(),
      "another-project", "rev-mcp-source-member"))
      .rejects.toMatchObject({ code: "LIBRARY_SOURCE_NOT_FOUND", status: 404 });
    expect(bucketRead).toBe(false);
  });

  it("denies a different verified owner subject even when the project and revision are known", async () => {
    const bucket = { async head() { throw new Error("R2 must not be read without the owner read policy"); } } as unknown as R2Bucket;
    let caught: unknown;
    try {
      await readProjectSourceContent({ ...runtime, EVIDENCE_BUCKET: bucket }, context("foreign-user"),
        "mcp-source-project", "rev-mcp-source-member");
    } catch (error) { caught = error; }
    expect(caught).toMatchObject({ status: 403 });
  });
});
