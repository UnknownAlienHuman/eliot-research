import { describe, expect, it, vi } from "vitest";
import type { ScopeSnapshot } from "@eliotr/contracts";
import type { ModelRouteDeployment } from "@eliotr/platform-cloudflare";
import {
  createModelProfileBindingProducer,
  createOwnerModelProfileTemplateV2,
  type ModelProfileCurrentAuthority,
  type ModelProfileStageAuthority,
} from "@eliotr/cloudflare-research";
import type { ResolvedProviderNativeModelCatalogV2 } from "@eliotr/cloudflare-native-models";
import { resolveResearchSemanticServerRoleModelPolicy } from "./research-semantic-profile-policy.js";
import {
  createResearchSemanticNativeModelRuntime,
  prepareResearchSemanticNativeModelRunContext,
} from "./research-semantic-native-model-runtime.js";

const NOW = Date.parse("2026-10-17T08:00:00.000Z");
const PROVENANCE = "owner-profile-provenance-v2";
const DEPLOYMENT: ModelRouteDeployment = Object.freeze({
  route_ref: "dynamic/eliotr-balanced",
  route_version: "route-v5-synthesize",
  prompt_generation: `eliotr.research.owner-prompt-${"a".repeat(64)}`,
  schema_generation: `eliotr.research.owner-schema-${"b".repeat(64)}`,
  parameters_digest: "c".repeat(64),
  pricing_snapshot_ref: "pricing-v5-synthesize",
});
const SCOPE: ScopeSnapshot = Object.freeze({
  snapshot_id: "profile-scope-v2",
  revision: 1,
  resolved_scope_expression: { kind: "SELECTED_SOURCES" as const, source_ids: ["source-1"] },
  participant_generations: { owner: "owner-generation-1" },
  member_source_revision_refs: ["source-1:1"],
  source_owner_generations: { "source-1": "owner-generation-1" },
  policy_authority_ref: "profile-policy-authority-v2",
  disclosure_closure_digest: "d".repeat(64),
  purge_ledger_revision: 0,
  digest: "e".repeat(64),
  created_at: "2026-10-17T07:00:00.000Z",
  expires_at: "2026-10-18T08:00:00.000Z",
});
const STAGE: ModelProfileStageAuthority = Object.freeze({
  model_profile_ref: "research-model-v1",
  policy_generation: "profile-policy-v2",
  policy_authority_ref: SCOPE.policy_authority_ref,
  deployment_generation: "git-c7689c7bb8ac",
  scope_snapshot_ref: { id: SCOPE.snapshot_id, revision: SCOPE.revision },
  scope_snapshot_digest: SCOPE.digest,
});
const POLICY = Object.freeze({
  allowed_tool_definition_refs: [],
  allowed_verifier_refs: ["verifier-v2"],
  permitted_anchor_and_precision_ceilings: ["normalized"],
  permitted_acquisition_or_expansion_routes: [],
  provider_and_policy_generations: { policy: STAGE.policy_generation },
  disclosure_ceiling: "private",
  allowed_use: ["research"],
});

async function template(expiresAt?: string) {
  return createOwnerModelProfileTemplateV2({
    config_provenance_ref: PROVENANCE,
    model_profile_ref: STAGE.model_profile_ref,
    ...(expiresAt === undefined ? {} : { expires_at: expiresAt }),
    max_context_bytes: 65_536,
    deployment: DEPLOYMENT,
    policy: POLICY,
  });
}

function producer(raw: unknown, currentOverrides: Partial<ModelProfileCurrentAuthority> = {}) {
  const current: ModelProfileCurrentAuthority = Object.freeze({
    ...STAGE,
    scope_snapshot: SCOPE,
    grant_expires_at: SCOPE.expires_at,
    run_authorization_expires_at_ms: Date.parse(SCOPE.expires_at),
    policy_state: "ACTIVE",
    deployment_state: "ACTIVE",
    state: "ACTIVE",
    ...currentOverrides,
  });
  const instance = createModelProfileBindingProducer({
    source: { provenance_ref: PROVENANCE, read: async () => raw },
    readCurrentAuthority: async () => current,
    routeAuthority: {
      resolve: async () => { throw new Error("snapshot-v2 must use the pinned route"); },
      resolvePinned: async () => DEPLOYMENT,
    },
    run_configuration: {
      mode: "snapshot-v2",
      configuration_ref: `rrc-${"f".repeat(24)}`,
      configuration_sha256: "1".repeat(64),
      model_selections: [{
        stage: "SYNTHESIZE",
        route_ref: DEPLOYMENT.route_ref,
        route_version: DEPLOYMENT.route_version,
        candidate_ref: "candidate-synthesis-v2",
        candidate_sha256: "2".repeat(64),
        qualification_ref: "qualification-synthesis-v2",
        qualification_sha256: "3".repeat(64),
      }],
    },
    now: () => NOW,
  });
  return instance;
}

function resolvePolicy(raw: unknown, instance: ReturnType<typeof producer>, provenance = PROVENANCE) {
  return resolveResearchSemanticServerRoleModelPolicy({
    raw: JSON.stringify(raw),
    provenance_ref: provenance,
    materialize_owner_template: async (modelProfileRef) => instance.resolve({
      ...STAGE, model_profile_ref: modelProfileRef,
    }),
  });
}

describe("semantic server owner model profile policy", () => {
  it("materializes a strict v2 owner template through current run authority for branch roles", async () => {
    const ownerTemplate = await template();
    const resolved = await resolvePolicy(ownerTemplate, producer(ownerTemplate));
    expect(resolved).toMatchObject({
      allowed_use: ["research"],
      allowed_verifier_refs: ["verifier-v2"],
      disclosure_ceiling: "private",
    });
  });

  it("resolves a V2 role profile against the captured native-v2 synthesis pin", async () => {
    const nativeSelection = Object.freeze({
      candidate_kind: "provider-native-v2" as const,
      stage: "SYNTHESIZE" as const,
      route_ref: DEPLOYMENT.route_ref,
      route_version: DEPLOYMENT.route_version,
      candidate_ref: "candidate-synthesis-v2",
      candidate_sha256: "2".repeat(64),
      qualification_ref: "qualification-synthesis-v2",
      qualification_sha256: "3".repeat(64),
      transport_policy: {
        version: 1 as const,
        transport: "cloudflare-ai-gateway" as const,
        api: "custom-chat-completions" as const,
        provider: "custom-opencode-go",
        model: "model-v2",
        billing: { mode: "byok" as const, alias: `eliotr-${"a".repeat(48)}` },
        capabilities: { max_output_tokens_field: "max_tokens" as const, reasoning_efforts: ["low"] as const },
      },
    });
    const runConfiguration = Object.freeze({
      mode: "snapshot-v2" as const,
      configuration_ref: `rrc-${"f".repeat(24)}`,
      configuration_sha256: "1".repeat(64),
      project_owner_ref: "profile-owner-v2",
      project_id: "profile-project-v2",
      model_selections: [nativeSelection],
    });
    const resolvedNative = {
      selection: nativeSelection,
      candidate: { candidate_ref: nativeSelection.candidate_ref,
        candidate_sha256: nativeSelection.candidate_sha256,
        candidate: { candidate_kind: "provider-native-v2", preparation: { deployment: DEPLOYMENT } } },
      proof: { qualification_ref: nativeSelection.qualification_ref,
        qualification_sha256: nativeSelection.qualification_sha256,
        qualification: { qualification_tier: "LIVE" } },
      observation: {}, pricing_snapshot: {}, deployment: DEPLOYMENT,
      pricing_port: { quote: vi.fn() },
    } as unknown as ResolvedProviderNativeModelCatalogV2;
    const resolveNativePin = vi.fn(async () => resolvedNative);
    const nativeRuntime = createResearchSemanticNativeModelRuntime({
      context: prepareResearchSemanticNativeModelRunContext({
        run_configuration: runConfiguration,
        owner_ref: runConfiguration.project_owner_ref,
      }),
      authority: undefined,
      catalog_authority: { resolvePinned: resolveNativePin },
    });
    const fallbackRouteAuthority = {
      resolve: vi.fn(async () => null),
      resolvePinned: vi.fn(async () => null),
    };
    const ownerTemplate = await template();
    const instance = createModelProfileBindingProducer({
      source: { provenance_ref: PROVENANCE, read: async () => ownerTemplate },
      readCurrentAuthority: async () => ({ ...STAGE, scope_snapshot: SCOPE,
        grant_expires_at: SCOPE.expires_at,
        run_authorization_expires_at_ms: Date.parse(SCOPE.expires_at),
        policy_state: "ACTIVE", deployment_state: "ACTIVE", state: "ACTIVE" }),
      routeAuthority: nativeRuntime.profileRouteAuthority(fallbackRouteAuthority),
      run_configuration: runConfiguration,
      now: () => NOW,
    });

    const resolvedPolicy = await resolvePolicy(ownerTemplate, instance);

    expect(resolvedPolicy.allowed_use).toEqual(["research"]);
    expect(resolveNativePin).toHaveBeenCalledOnce();
    expect(fallbackRouteAuthority.resolvePinned).not.toHaveBeenCalled();
    expect(fallbackRouteAuthority.resolve).not.toHaveBeenCalled();
  });

  it("rejects a tampered v2 digest and mismatched provenance before materialization", async () => {
    const ownerTemplate = await template();
    const badDigest = { ...ownerTemplate, definition_sha256: "0".repeat(64) };
    const invalidProfile = producer(ownerTemplate);
    await expect(resolvePolicy(badDigest, invalidProfile)).rejects.toMatchObject({
      code: "WORKFLOW_CONFIGURATION_INVALID",
    });
    await expect(resolvePolicy(ownerTemplate, invalidProfile, "other-provenance"))
      .rejects.toMatchObject({ code: "WORKFLOW_CONFIGURATION_INVALID" });
  });

  it("rejects an expired v2 owner template under current authority", async () => {
    const expired = await template("2026-10-17T07:59:59.000Z");
    await expect(resolvePolicy(expired, producer(expired)))
      .rejects.toMatchObject({ code: "MODEL_PROFILE_BINDING_EXPIRED" });
  });
});
