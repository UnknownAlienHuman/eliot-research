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

function candidate(
  version: string,
  routeRef:
    | "dynamic/eliotr-balanced"
    | "dynamic/eliotr-strong"
    | "dynamic/eliotr-audit-writer" = "dynamic/eliotr-balanced",
  expiresAt = "2026-09-10T13:00:00.000Z",
  promptGeneration = "prompt-v1",
) {
  return {
    schema: "eliotr.dynamic-route-candidate.v1" as const,
    deployment: {
      route_ref: routeRef,
      route_version: version,
      prompt_generation: promptGeneration,
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
    qualification_expires_at: expiresAt,
  };
}

describe("D1 model gateway deployment registry", () => {
  it("stages, replays, promotes, and resolves one exact active candidate", async () => {
    await prepareDatabase();
    const database = runtime.CORE_DB;
    const registry = createD1DynamicRouteRegistry(database, { now: () => NOW, environment: "TEST" });
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

    await expect(createD1ModelGatewayDeploymentRegistry(database).resolve(first.deployment.route_ref)).rejects.toMatchObject({ code: "DYNAMIC_ROUTE_LIVE_GATE_REQUIRED" });
    const resolver = createD1ModelGatewayDeploymentRegistry(database, { environment: "TEST", now: () => NOW });
    await expect(resolver.resolve(first.deployment.route_ref)).resolves.toEqual(first.deployment);
  });

  it("fails the active compare-and-swap for a stale expected version", async () => {
    await prepareDatabase();
    const database = runtime.CORE_DB;
    const registry = createD1DynamicRouteRegistry(database, { now: () => NOW, environment: "TEST" });
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
    await expect(registry.getActive(first.deployment.route_ref)).resolves.toMatchObject({ route_version: first.deployment.route_version });

    const updated = candidate("route-registry-v4", "dynamic/eliotr-strong");
    const updatedDigest = (await dynamicRouteJsonArtifact(updated)).sha256;
    const updatedStage = await registry.stageCandidate(updated, updatedDigest);
    await expect(registry.promote({
      route_ref: updated.deployment.route_ref,
      expected_active_route_version: first.deployment.route_version,
      target_route_version: updated.deployment.route_version,
      candidate_ref: updatedStage.candidate_ref,
      candidate_sha256: updatedDigest,
    })).resolves.toMatchObject({ active: { route_version: updated.deployment.route_version } });

    const conflict = candidate("route-registry-v2", "dynamic/eliotr-strong", "2026-09-10T13:00:00.000Z", "prompt-v2");
    const conflictDigest = (await dynamicRouteJsonArtifact(conflict)).sha256;
    await expect(registry.stageCandidate(conflict, conflictDigest)).rejects.toMatchObject({ code: "DYNAMIC_ROUTE_REGISTRY_STAGE_FAILED" });
  });

  it("rejects expired qualifications and corrupted stored candidate bindings", async () => {
    await prepareDatabase();
    const database = runtime.CORE_DB;
    const registry = createD1DynamicRouteRegistry(database, { now: () => NOW, environment: "TEST" });
    const expired = candidate("route-registry-expired", "dynamic/eliotr-audit-writer", "2026-09-10T11:59:00.000Z");
    const expiredDigest = (await dynamicRouteJsonArtifact(expired)).sha256;
    const expiredStage = await registry.stageCandidate(expired, expiredDigest);
    await expect(registry.promote({
      route_ref: expired.deployment.route_ref,
      expected_active_route_version: null,
      target_route_version: expired.deployment.route_version,
      candidate_ref: expiredStage.candidate_ref,
      candidate_sha256: expiredDigest,
    })).rejects.toMatchObject({ code: "DYNAMIC_ROUTE_QUALIFICATION_INVALID" });
    await expect(registry.getActive(expired.deployment.route_ref)).resolves.toBeNull();

    const corrupt = candidate("route-registry-corrupt", "dynamic/eliotr-extract");
    const corruptArtifact = await dynamicRouteJsonArtifact(corrupt);
    const wrongRef = "wrong-candidate-reference";
    await database.prepare("INSERT INTO dynamic_route_candidate(candidate_ref, route_ref, route_version, candidate_sha256, candidate_json, staged_at) VALUES (?1,?2,?3,?4,?5,?6)").bind(wrongRef, corrupt.deployment.route_ref, corrupt.deployment.route_version, corruptArtifact.sha256, corruptArtifact.json, NOW).run();
    await database.prepare("INSERT INTO dynamic_route_active_generation(route_ref, route_version, candidate_ref, candidate_sha256, promotion_ref, promoted_at) VALUES (?1,?2,?3,?4,?5,?6)").bind(corrupt.deployment.route_ref, corrupt.deployment.route_version, wrongRef, corruptArtifact.sha256, "promotion-corrupt", NOW).run();
    await expect(registry.getActive(corrupt.deployment.route_ref)).rejects.toMatchObject({ code: "DYNAMIC_ROUTE_PROMOTION_FAILED" });
  });
});
