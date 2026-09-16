import { beforeEach, describe, expect, it } from "vitest";
import { reset } from "cloudflare:test";
import type { WorkflowCheckpointError } from "@eliotr/cloudflare-research";
import { requireResearchDeploymentCompatibility } from "../src/research-deployment-compatibility.js";
import { db, setupOrientationDatabase } from "./orientation-fixture.js";

const F = "a".repeat(64);
const G = "b".repeat(64);

beforeEach(async () => {
  await reset();
  await setupOrientationDatabase();
});

describe("research deployment compatibility", () => {
  it("accepts exact legacy deployments and equal reviewed backend fingerprints", async () => {
    const now = new Date().toISOString();
    await db.prepare(
      "INSERT INTO investigation_current_deployment(deployment_generation,state,created_at) VALUES ('legacy-a','ACTIVE',?1)",
    ).bind(now).run();
    expect(await requireResearchDeploymentCompatibility(db, "legacy-a", "legacy-a")).toEqual({
      origin_deployment_generation: "legacy-a",
      active_deployment_generation: "legacy-a",
      backend_fingerprint: null,
    });
    await db.prepare("UPDATE investigation_current_deployment SET state='RETIRED',backend_fingerprint=?2 WHERE deployment_generation=?1")
      .bind("legacy-a", F).run();
    await db.prepare(
      "INSERT INTO investigation_current_deployment(deployment_generation,state,created_at,backend_fingerprint) VALUES ('pwa-b','ACTIVE',?1,?2)",
    ).bind(now, F).run();
    expect(await requireResearchDeploymentCompatibility(db, "legacy-a", "pwa-b")).toEqual({
      origin_deployment_generation: "legacy-a",
      active_deployment_generation: "pwa-b",
      backend_fingerprint: F,
    });
  });

  it("fails closed for unknown or changed backend execution inputs", async () => {
    const now = new Date().toISOString();
    await db.prepare(
      "INSERT INTO investigation_current_deployment(deployment_generation,state,created_at,backend_fingerprint) VALUES ('origin','RETIRED',?1,?2)",
    ).bind(now, F).run();
    await db.prepare(
      "INSERT INTO investigation_current_deployment(deployment_generation,state,created_at,backend_fingerprint) VALUES ('changed','ACTIVE',?1,?2)",
    ).bind(now, G).run();
    await expect(requireResearchDeploymentCompatibility(db, "origin", "changed"))
      .rejects.toEqual(expect.objectContaining<Partial<WorkflowCheckpointError>>({ code: "WORKFLOW_AUTHORITY_STALE" }));
    await expect(requireResearchDeploymentCompatibility(db, "missing", "changed"))
      .rejects.toEqual(expect.objectContaining<Partial<WorkflowCheckpointError>>({ code: "WORKFLOW_AUTHORITY_STALE" }));
  });
});
