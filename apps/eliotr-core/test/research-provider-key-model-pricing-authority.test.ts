import { describe, expect, it } from "vitest";
import {
  createResearchProviderKeyModelPricingObserver,
  type ResearchProviderKeyModelPricingObservationStore,
} from "@eliotr/cloudflare-research-configuration/research-provider-key-model-pricing.js";
import type { ResearchProviderKeyModelUseRow } from "@eliotr/cloudflare-research-configuration/research-provider-key-model-use-store.js";

const operationId = "00000000-0000-4000-8000-000000000001";
const operation = {
  owner_id: "owner-test",
  project_id: "project-test",
  provider_id: "openrouter",
  operation_id: operationId,
  key_operation_id: "00000000-0000-4000-8000-000000000002",
  account_id: "account-test",
  gateway_id: "gateway-test",
  alias: "alias-test",
  provider_config_id: "provider-config-test",
  configuration_metadata_sha256: "a".repeat(64),
  request_sha256: "b".repeat(64),
  configuration_basis_json: "{}",
  owner_credential_generation: "credential-generation-test",
  project_generation: 1,
  deployment_generation: "deployment-generation-test",
  deadline_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
  expected_selection_revision: null,
  source_configuration_ref: null,
  source_configuration_sha256: null,
  planned_stage_set_sha256: "c".repeat(64),
  plan_sha256: "d".repeat(64),
  state: "PREPARING",
  phase: "FREE_PRICE_CHECK",
  active_stage: "SYNTHESIZE",
  target_configuration_ref: null,
  target_configuration_sha256: null,
  target_configuration_json: null,
  selected_configuration_ref: null,
  selection_revision: null,
  failure_code: null,
  created_at: "2026-10-05T00:00:00.000Z",
  updated_at: "2026-10-05T00:00:00.000Z",
} satisfies ResearchProviderKeyModelUseRow;

function makeObserver(currentOperation: ResearchProviderKeyModelUseRow, reads: { count: number }) {
  const observationStore: ResearchProviderKeyModelPricingObservationStore = {
    read: async () => null,
    readByStage: async () => {
      reads.count += 1;
      throw new Error("stop before metadata or D1 snapshot access");
    },
    putImmutable: async () => { throw new Error("unexpected write"); },
  };
  const database = { prepare: () => { throw new Error("unexpected D1 access"); } };
  return createResearchProviderKeyModelPricingObserver({
    database: database as unknown as D1Database,
    observation_store: observationStore,
    readCurrentOperation: async () => ({
      operation: currentOperation,
      route: {
        stage: "SYNTHESIZE",
        route_ref: "route-test",
        route_version: "version-test",
        provider: "openrouter",
        exact_model_id: "stealth/space-bunny-alpha",
      },
    }),
  });
}

const request = { operation_id: operationId, route_ref: "route-test", route_version: "version-test" };

describe("pricing observer owner-use operation shape", () => {
  it("accepts the complete canonical store row while retaining strict unknown-key rejection", async () => {
    const canonicalReads = { count: 0 };
    const canonicalFailure = await makeObserver(operation, canonicalReads)
      .observeAndPersistFreePrice(request).catch((error: unknown) => error);
    expect(canonicalFailure).toMatchObject({ code: "STORAGE_UNAVAILABLE" });
    expect(canonicalReads.count).toBe(1);

    const withUnknownKey = Object.freeze({ ...operation, unexpected_extension: true });
    const unknownReads = { count: 0 };
    const unknownFailure = await makeObserver(withUnknownKey, unknownReads)
      .observeAndPersistFreePrice(request).catch((error: unknown) => error);
    expect(unknownFailure).toMatchObject({ code: "FREE_PRICE_NOT_PROVEN" });
    expect(unknownReads.count).toBe(0);
  });
});
