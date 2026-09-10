import { describe, expect, it } from "vitest";
import { WorkspaceMcpPlanV2InputSchema, WorkspaceMcpReceiptV2Schema } from "./workspace-mcp.js";

const valid = {
  protocol: "eliotr.google-sync.plan.v2",
  idempotency_key: "key-1",
  google_product: "drive",
  action: "read",
  direction: "google_to_eliot_candidate",
  dry_run: true,
};

describe("Workspace MCP v2 contract", () => {
  it("keeps intent strict and Workspace-only", () => {
    expect(WorkspaceMcpPlanV2InputSchema.safeParse(valid).success).toBe(true);
    expect(WorkspaceMcpPlanV2InputSchema.safeParse({ ...valid, google_product: "cloud" }).success).toBe(false);
    expect(WorkspaceMcpPlanV2InputSchema.safeParse({ ...valid, action: "deploy" }).success).toBe(false);
    expect(WorkspaceMcpPlanV2InputSchema.safeParse({ ...valid, google_project_id: "gcp" }).success).toBe(false);
    expect(WorkspaceMcpPlanV2InputSchema.safeParse({ ...valid, principal_ref: "caller" }).success).toBe(false);
  });

  it("accepts only untrusted normalized Workspace readback fields", () => {
    expect(WorkspaceMcpReceiptV2Schema.safeParse({
      connector: "google-workspace", google_product: "drive", action: "read",
      resource_id: "file-1", observed_revision: "r1", observed_at: "2026-09-09T12:00:00.000Z",
      readback_performed: true,
    }).success).toBe(true);
    expect(WorkspaceMcpReceiptV2Schema.safeParse({
      connector: "gcloud", google_product: "cloud", action: "deploy", resource_id: "x",
      observed_revision: "r1", observed_at: "2026-09-09T12:00:00.000Z", readback_performed: true,
    }).success).toBe(false);
  });
});
