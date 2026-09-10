import { describe, expect, it } from "vitest";
import { type ModelRouteDeployment } from "@eliotr/platform-cloudflare";
import { canonicalModelGatewayJson, modelGatewaySha256 } from "@eliotr/cloudflare-ai";
import {
  createModelProfileBindingProducer,
  ModelProfileBindingError,
  type ModelProfileCurrentAuthority,
  type ModelProfileStageAuthority,
} from "./research-model-profile-binding.js";
import type { ScopeSnapshot } from "@eliotr/contracts";

const NOW = Date.parse("2026-09-10T15:00:00.000Z");
const deployment: ModelRouteDeployment = Object.freeze({
  route_ref: "dynamic/eliotr-balanced",
  route_version: "route-v1",
  prompt_generation: "prompt-v1",
  schema_generation: "schema-v1",
  parameters_digest: "a".repeat(64),
  pricing_snapshot_ref: "pricing-v1",
});
const scope: ScopeSnapshot = Object.freeze({
  snapshot_id: "scope-1",
  revision: 1,
  resolved_scope_expression: { kind: "SELECTED_SOURCES" as const, source_ids: ["source-1"] },
  participant_generations: { owner: "owner-gen-1" },
  member_source_revision_refs: ["source-1:1"],
  source_owner_generations: { "source-1": "owner-gen-1" },
  policy_authority_ref: "policy-authority-1",
  disclosure_closure_digest: "b".repeat(64),
  purge_ledger_revision: 0,
  digest: "c".repeat(64),
  created_at: "2026-09-10T14:00:00.000Z",
  expires_at: "2026-09-10T16:00:00.000Z",
});
const policy = Object.freeze({
  allowed_tool_definition_refs: [],
  allowed_verifier_refs: [],
  permitted_anchor_and_precision_ceilings: ["normalized-text-coordinates-v1"],
  provider_and_policy_generations: { policy: "policy-v1" },
  permitted_acquisition_or_expansion_routes: [],
  disclosure_ceiling: "owner-authorized",
  allowed_use: ["research"],
  expires_at: "2026-09-10T16:00:00.000Z",
});
const provenanceRef = "operator-model-profile-config-v1";
const stage: ModelProfileStageAuthority = {
  model_profile_ref: "research-model-v1",
  policy_generation: "policy-v1",
  policy_authority_ref: "policy-authority-1",
  deployment_generation: "deployment-v1",
  scope_snapshot_ref: { id: scope.snapshot_id, revision: scope.revision },
  scope_snapshot_digest: scope.digest,
};

function makeBinding(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const material = {
    schema: "eliotr.research.model-profile-definition.v1",
    config_provenance_ref: provenanceRef,
    definition_ref: { id: "placeholder", revision: 1 },
    definition_sha256: "placeholder",
    model_profile_ref: stage.model_profile_ref,
    max_context_bytes: 64 * 1024,
    expires_at: "2026-09-10T16:00:00.000Z",
    deployment,
    policy,
    ...overrides,
  };
  return material;
}

async function signedBinding(overrides: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  const material = makeBinding(overrides);
  delete material.definition_ref;
  delete material.definition_sha256;
  const sha = await modelGatewaySha256(canonicalModelGatewayJson(material));
  return {
    ...material,
    definition_sha256: sha,
    definition_ref: { id: `eliotr.research.model-profile-definition-${sha}`, revision: 1 },
  };
}

function current(overrides: Partial<ModelProfileCurrentAuthority> = {}): ModelProfileCurrentAuthority {
  return Object.freeze({
    ...stage,
    scope_snapshot: scope,
    policy_state: "ACTIVE",
    deployment_state: "ACTIVE",
    state: "ACTIVE",
    ...overrides,
  });
}

function producer(raw: unknown, currentValue: ModelProfileCurrentAuthority = current()) {
  return createModelProfileBindingProducer({
    source: { provenance_ref: provenanceRef, read: async () => raw },
    readCurrentAuthority: async () => currentValue,
    routeAuthority: { resolve: async () => deployment },
    now: () => NOW,
  });
}

describe("model profile binding producer", () => {
  it("resolves a server-owned binding only when stage, authority, scope, and route all agree", async () => {
    const result = await producer(await signedBinding()).resolve(stage);
    expect(result.binding.model_profile_ref).toBe(stage.model_profile_ref);
    expect(result.binding.max_context_bytes).toBe(64 * 1024);
    expect(result.deployment).toEqual(deployment);
    expect(result.policy.allowed_use).toEqual(["research"]);
    expect(result.scope_snapshot.digest).toBe(scope.digest);
  });

  it("refuses absent configuration before any model route can be used", async () => {
    const route = { resolve: async () => { throw new Error("route must not be read"); } };
    const instance = createModelProfileBindingProducer({
      source: { provenance_ref: provenanceRef, read: async () => null },
      readCurrentAuthority: async () => current(),
      routeAuthority: route,
      now: () => NOW,
    });
    await expect(instance.resolve(stage)).rejects.toMatchObject({ code: "MODEL_PROFILE_BINDING_CONFIG_MISSING" });
  });

  it("refuses route rotation and authority rotation as typed stale or mismatch", async () => {
    const rotated: ModelRouteDeployment = { ...deployment, route_version: "route-v2" };
    const routeInstance = createModelProfileBindingProducer({
      source: { provenance_ref: provenanceRef, read: async () => signedBinding() },
      readCurrentAuthority: async () => current(),
      routeAuthority: { resolve: async () => rotated },
      now: () => NOW,
    });
    await expect(routeInstance.resolve(stage)).rejects.toMatchObject({ code: "MODEL_PROFILE_BINDING_DEPLOYMENT_MISMATCH" });

    const authorityInstance = producer(await signedBinding(), current({ policy_generation: "policy-v2" }));
    await expect(authorityInstance.resolve(stage)).rejects.toMatchObject({ code: "MODEL_PROFILE_BINDING_AUTHORITY_STALE" });
  });

  it("rejects tampered, expired, and non-canonical configuration", async () => {
    const signed = await signedBinding();
    const tampered = { ...signed, policy: { ...policy, allowed_use: ["owner"] } };
    await expect(producer(tampered).resolve(stage)).rejects.toBeInstanceOf(ModelProfileBindingError);
    await expect(producer(await signedBinding({ expires_at: "2026-09-10T14:00:00.000Z", policy: { ...policy, expires_at: "2026-09-10T14:00:00.000Z" } })).resolve(stage)).rejects.toMatchObject({ code: "MODEL_PROFILE_BINDING_EXPIRED" });
    await expect(producer({ ...signed, unexpected: true }).resolve(stage)).rejects.toMatchObject({ code: "MODEL_PROFILE_BINDING_CONFIG_INVALID" });
    await expect(producer(await signedBinding({ max_context_bytes: 0 })).resolve(stage)).rejects.toMatchObject({ code: "MODEL_PROFILE_BINDING_CONFIG_INVALID" });
    await expect(producer(await signedBinding({ max_context_bytes: Number.MAX_SAFE_INTEGER + 1 })).resolve(stage)).rejects.toMatchObject({ code: "MODEL_PROFILE_BINDING_CONFIG_INVALID" });
  });
});
