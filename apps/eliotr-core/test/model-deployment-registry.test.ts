import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import {
  createD1DynamicRouteRegistry,
  createD1ModelGatewayDeploymentRegistry,
} from "../../../packages/cloudflare-ai/src/model-gateway-deployment-registry-d1.js";
import { dynamicRouteJsonArtifact } from "../../../packages/cloudflare-ai/src/dynamic-route-provisioning-codec.js";

const runtime = env as unknown as {
  readonly CORE_DB: D1Database;
  readonly CORE_MIGRATIONS: Parameters<typeof applyD1Migrations>[1];
};
const NOW = "2026-09-10T12:00:00.000Z";
const DIGEST = "a".repeat(64);

async function prepareDatabase(): Promise<void> {
  await applyD1Migrations(runtime.CORE_DB, runtime.CORE_MIGRATIONS);
}

function candidate(version: string, routeRef: "dynamic/eliotr-balanced" | "dynamic/eliotr-strong" = "dynamic/eliotr-balanced") {
  return {
    schema: "eliotr.dynamic-route-candidate.v1" as const,
    deployment: {
      route_ref: routeRef,
      route_version: version,
      prompt_generation: "prompt-v1",
      schema_generation: "schema-v1",
      parameters_digest: DIGEST,
      pricing_snapshot_ref: "pricing-v1",
    },
    provider_route_id: `provider-route-${version}`,
    provider_route_name: `balanced-${version}`,
    route_definition_sha256: DIGEST,
    provider_snapshot_sha256: DIGEST,
    control_plane_receipt_ref: `control-plane-${version}`,
    qualification_tier: "FIXTURE" as const,
    control_plane_readback_ref: `control-readback-${version}`,
    execution_probe_ref: `execution-probe-${version}`,
    qualification_expires_at: "2026-09-10T13:00:00.000Z",
  };
}

describe("D1 model gateway deployment registry", () => {
  it("stages, replays, promotes, and resolves one exact active candidate", async () => {
    await prepareDatabase();
    const database = runtime.CORE_DB;
    const registry = createD1DynamicRouteRegistry(database, { now: () => NOW });
    const first = candidate("route-registry-v1");
    const artifact = await dynamicRouteJsonArtifact(first);

    const staged = await registry.stageCandidate(first, artifact.sha256);
    expect(staged.readback_sha256).toBe(artifact.sha256);
    expect(await registry.stageCandidate(first, artifact.sha256)).toEqual(staged);
    expect(await registry.getActive(first.deployment.route_ref)).toBeNull();

    const promoted = await registry.promote({
      route_ref: first.deployment.route_ref,
      expected_active_route_version: null,
      target_route_version: first.deployment.route_version,
      candidate_ref: staged.candidate_ref,
      candidate_sha256: staged.readback_sha256,
    });
    expect(promoted.active).toMatchObject({
      route_ref: first.deployment.route_ref,
      route_version: first.deployment.route_version,
      candidate_ref: staged.candidate_ref,
      candidate_sha256: artifact.sha256,
    });
    expect(await registry.promote({
      route_ref: first.deployment.route_ref,
      expected_active_route_version: null,
      target_route_version: first.deployment.route_version,
      candidate_ref: staged.candidate_ref,
      candidate_sha256: staged.readback_sha256,
    })).toEqual(promoted);

    const resolver = createD1ModelGatewayDeploymentRegistry(database);
    await expect(resolver.resolve(first.deployment.route_ref)).resolves.toEqual(first.deployment);
  });

  it("fails the active compare-and-swap for a stale expected version", async () => {
    await prepareDatabase();
    const database = runtime.CORE_DB;
    const registry = createD1DynamicRouteRegistry(database, { now: () => NOW });
    const first = candidate("route-registry-v2", "dynamic/eliotr-strong");
    const second = candidate("route-registry-v3", "dynamic/eliotr-strong");
    const firstDigest = (await dynamicRouteJsonArtifact(first)).sha256;
    const secondDigest = (await dynamicRouteJsonArtifact(second)).sha256;
    const firstStage = await registry.stageCandidate(first, firstDigest);
    const secondStage = await registry.stageCandidate(second, secondDigest);
    await registry.promote({
      route_ref: first.deployment.route_ref,
      expected_active_route_version: null,
      target_route_version: first.deployment.route_version,
      candidate_ref: firstStage.candidate_ref,
      candidate_sha256: firstDigest,
    });
    await expect(registry.promote({
      route_ref: second.deployment.route_ref,
      expected_active_route_version: "route-registry-v1",
      target_route_version: second.deployment.route_version,
      candidate_ref: secondStage.candidate_ref,
      candidate_sha256: secondDigest,
    })).rejects.toMatchObject({ code: "DYNAMIC_ROUTE_PROMOTION_FAILED" });
  });
});
