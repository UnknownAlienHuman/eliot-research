import { describe, expect, it } from "vitest";
import type { ScopeSnapshot } from "@eliotr/contracts";
import type { ModelRouteDeployment } from "@eliotr/platform-cloudflare";
import {
  createModelProfileBindingProducer,
  createModelProfileDefinition,
  createOwnerModelProfileTemplateV2,
  type ModelProfileBinding,
  type ModelProfileCurrentAuthority,
  type ModelProfileStageAuthority,
} from "./research-model-profile-binding.js";

const NOW = Date.parse("2026-10-12T04:50:30.000Z");
const firstDeadline = Date.parse("2026-10-12T04:55:29.559Z");
const nextDeadline = Date.parse("2026-10-12T04:55:37.908Z");
const deployment: ModelRouteDeployment = {
  route_ref: "dynamic/eliotr-balanced", route_version: "route-v1",
  prompt_generation: "prompt-v1", schema_generation: "schema-v1",
  parameters_digest: "a".repeat(64), pricing_snapshot_ref: "pricing-v1",
};
const scope: ScopeSnapshot = {
  snapshot_id: "scope-1", revision: 1,
  resolved_scope_expression: { kind: "SELECTED_SOURCES", source_ids: ["source-1"] },
  participant_generations: { owner: "owner-generation-1" },
  member_source_revision_refs: ["source-1:1"],
  source_owner_generations: { "source-1": "owner-generation-1" },
  policy_authority_ref: "policy-authority-1", disclosure_closure_digest: "b".repeat(64),
  purge_ledger_revision: 0, digest: "c".repeat(64),
  created_at: "2026-10-12T04:49:00.000Z", expires_at: "2026-10-13T04:49:00.000Z",
};
const stage: ModelProfileStageAuthority = {
  model_profile_ref: "research-model-v1", policy_generation: "policy-v1",
  policy_authority_ref: scope.policy_authority_ref, deployment_generation: "deployment-v1",
  scope_snapshot_ref: { id: scope.snapshot_id, revision: scope.revision },
  scope_snapshot_digest: scope.digest,
};
const templateInput = {
  config_provenance_ref: "owner-model-profile-v7", model_profile_ref: stage.model_profile_ref,
  max_context_bytes: 65536, deployment,
  policy: {
    allowed_tool_definition_refs: [], allowed_verifier_refs: ["verifier-v1"],
    permitted_anchor_and_precision_ceilings: [], permitted_acquisition_or_expansion_routes: [],
    provider_and_policy_generations: { policy: "policy-v1" },
    disclosure_ceiling: "PRIVATE", allowed_use: ["research"],
  },
};
function definition(binding: ModelProfileBinding) {
  return createModelProfileDefinition({
    config_provenance_ref: binding.config_provenance_ref, model_profile_ref: binding.model_profile_ref,
    expires_at: binding.expires_at, max_context_bytes: binding.max_context_bytes,
    deployment: binding.deployment, policy: binding.policy,
  });
}
async function fixture() {
  const state: {
    raw: unknown; authority: ModelProfileCurrentAuthority; clock: number;
    authorityReads: number; routeReads: number; routeHook?: () => void;
  } = {
    raw: await createOwnerModelProfileTemplateV2(templateInput), clock: NOW,
    authority: {
      ...stage, scope_snapshot: scope, grant_expires_at: scope.expires_at,
      run_budget_expires_at_ms: firstDeadline, policy_state: "ACTIVE",
      deployment_state: "ACTIVE", state: "ACTIVE",
    },
    authorityReads: 0, routeReads: 0,
  };
  const producer = createModelProfileBindingProducer({
    source: { provenance_ref: templateInput.config_provenance_ref, read: async () => state.raw },
    readCurrentAuthority: async () => { state.authorityReads += 1; return state.authority; },
    routeAuthority: {
      resolve: async () => { throw new Error("snapshot must not read mutable route"); },
      resolvePinned: async (_deployment, selection, options) => {
        expect(selection.qualification_ref).toBe("qualification-v1");
        expect(options?.allow_expired_qualification).toBe(true);
        state.routeReads += 1; state.routeHook?.(); return deployment;
      },
    },
    run_configuration: {
      mode: "snapshot-v2", configuration_ref: `rrc-${"d".repeat(24)}`,
      configuration_sha256: "e".repeat(64),
      model_selections: [{
        stage: "SYNTHESIZE", route_ref: deployment.route_ref, route_version: deployment.route_version,
        candidate_ref: "candidate-v1", candidate_sha256: "f".repeat(64),
        qualification_ref: "qualification-v1", qualification_sha256: "1".repeat(64),
      }],
    },
    now: () => state.clock,
  });
  return { state, producer };
}
describe("committed model profile binding across evidence freeze", () => {
  it("retains the committed definition and binding when the next W2 deadline advances", async () => {
    const { state, producer } = await fixture();
    const prepared = await producer.resolve(stage);
    const frozen = await definition(prepared.binding);
    expect(frozen.definition_ref).toEqual(prepared.binding.definition_ref);
    state.authority = { ...state.authority, run_budget_expires_at_ms: nextDeadline };
    const refreshed = await producer.resolve(stage);
    expect(refreshed.binding.binding_ref).not.toEqual(prepared.binding.binding_ref);
    const reads = state.authorityReads, routes = state.routeReads;
    const checked = await producer.resolve(stage, frozen);
    expect(checked.binding).toEqual(prepared.binding);
    expect(checked.policy.expires_at).toBe("2026-10-12T04:55:29.559Z");
    expect(state.authorityReads - reads).toBe(2);
    expect(state.routeReads - routes).toBe(1);
  });

  it("rejects forged digests and a valid definition that differs from captured configuration", async () => {
    const { state, producer } = await fixture();
    const prepared = await producer.resolve(stage), frozen = await definition(prepared.binding);
    const routes = state.routeReads;
    await expect(producer.resolve(stage, { ...frozen, max_context_bytes: 32768 }))
      .rejects.toMatchObject({ code: "MODEL_PROFILE_BINDING_CONFIG_INVALID" });
    state.raw = await createOwnerModelProfileTemplateV2({ ...templateInput, max_context_bytes: 32768 });
    await expect(producer.resolve(stage, frozen))
      .rejects.toMatchObject({ code: "MODEL_PROFILE_BINDING_AUTHORITY_STALE" });
    expect(state.routeReads).toBe(routes);
  });

  it("rejects shorter authority, mid-read rotation, and expiry without renewing the binding", async () => {
    const { state, producer } = await fixture();
    const prepared = await producer.resolve(stage), frozen = await definition(prepared.binding);
    state.authority = { ...state.authority, run_budget_expires_at_ms: firstDeadline - 1 };
    await expect(producer.resolve(stage, frozen))
      .rejects.toMatchObject({ code: "MODEL_PROFILE_BINDING_AUTHORITY_STALE" });
    state.authority = { ...state.authority, run_budget_expires_at_ms: nextDeadline };
    state.routeHook = () => { state.authority = { ...state.authority, policy_generation: "policy-v2" }; };
    await expect(producer.resolve(stage, frozen))
      .rejects.toMatchObject({ code: "MODEL_PROFILE_BINDING_AUTHORITY_STALE" });
    delete state.routeHook;
    state.authority = { ...state.authority, policy_generation: stage.policy_generation };
    state.clock = firstDeadline;
    await expect(producer.resolve(stage, frozen))
      .rejects.toMatchObject({ code: "MODEL_PROFILE_BINDING_EXPIRED" });
  });

  it("keeps the exact configured v1 definition and refuses a different valid expiry", async () => {
    const { state, producer } = await fixture();
    const prepared = await producer.resolve(stage), frozen = await definition(prepared.binding);
    const legacy = createModelProfileBindingProducer({
      source: { provenance_ref: templateInput.config_provenance_ref, read: async () => frozen },
      readCurrentAuthority: async () => state.authority,
      routeAuthority: { resolve: async () => deployment }, now: () => NOW,
    });
    const ordinary = await legacy.resolve(stage);
    expect((await legacy.resolve(stage, frozen)).binding).toEqual(ordinary.binding);
    const different = await createModelProfileDefinition({
      ...frozen, expires_at: new Date(firstDeadline - 1000).toISOString(),
      policy: { ...frozen.policy, expires_at: new Date(firstDeadline - 1000).toISOString() },
    });
    await expect(legacy.resolve(stage, different))
      .rejects.toMatchObject({ code: "MODEL_PROFILE_BINDING_AUTHORITY_STALE" });
  });
});

