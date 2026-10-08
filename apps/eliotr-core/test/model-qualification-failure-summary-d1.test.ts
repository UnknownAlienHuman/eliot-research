// Native Workerd D1 regression fixture for model qualification failure-summary identity,
// retry/replay, and lost-ack readback behavior.
//
// The test uses the native Core/Search D1 and R2 bindings, the Q1 import/query
// fixture, and production qualification stores/dispatcher/summary functions.
// A test-only injected fetch throws locally; it never contacts a provider.

import { describe, expect, it } from "vitest";
import { ORIENTATION_PROFILE } from "@eliotr/cloudflare-navigation";
import {
  dynamicRouteQualificationProbeInputSha256,
  modelGatewayRequestParametersSha256,
  modelGatewaySha256,
  canonicalModelGatewayJson,
  ModelGatewayExecutionError,
  type DynamicRouteQualificationProbeInput,
} from "@eliotr/cloudflare-ai";
import type { QueryResult } from "@eliotr/interfaces";
import {
  ResearchModelQualificationFailureSummaryError,
  readResearchModelQualificationFailureSummary,
  recordResearchModelQualificationFailureSummary,
} from "../../../packages/cloudflare-model-control/src/research-model-qualification-failure-summary.js";
import { createResearchModelQualificationDispatch } from "../../../packages/cloudflare-model-control/src/research-model-qualification-dispatch.js";
import { createD1ResearchModelQualificationObservationStore } from "../../../packages/cloudflare-model-control/src/research-model-qualification-store.js";
import { createD1ResearchModelPricingSnapshotStore } from "../../../packages/cloudflare-model-control/src/research-model-pricing-store.js";
import { observeDatabase } from "./orientation-fixture.js";
import { access, fixture as prepareEvidenceFixture, runtime } from "./research-retrieve-fixture.js";
import { q1Transport } from "./retrieval-q1-fixture.js";

const OWNER_CREDENTIAL = "credential-1"; // q1Transport's local verifier identity.
const PROVIDER = "compat";
const MODEL = "model-1"; // local fixture identity; no provider request is made.
const ROUTE = "dynamic/eliotr-balanced" as const;
const ROUTE_VERSION = "failure-summary-native-v1";
const PROMPT_GENERATION = "failure-summary-prompt-v1";
const SCHEMA_GENERATION = "failure-summary-schema-v1";
const TEST_TOKEN = "local-admission-not-a-credential";
const GATEWAY_URL = `https://gateway.ai.cloudflare.com/v1/${"a".repeat(32)}/eliotr-reasoning`;

async function currentEvidencePack(): Promise<QueryResult["evidence_pack"]> {
  const q1 = await prepareEvidenceFixture();
  const response = await q1Transport(runtime, access.principal_ref)("/api/v1/research/query", {
    method: "POST",
    headers: { "content-type": "application/json", "idempotency-key": "failure-summary-native-query" },
    body: JSON.stringify({
      query: "Pinned",
      product: "ORIENT",
      scope_expression: { kind: "SELECTED_SOURCES", source_ids: [`source-${q1.world.namespace}`] },
      literals: [],
      evidence_grade: "E0",
      budget_ref: ORIENTATION_PROFILE,
      max_results: 8,
    }),
  }) as { readonly data: QueryResult };
  expect(response.data.evidence_pack.resolved_evidence.length).toBeGreaterThan(0);
  return response.data.evidence_pack;
}

async function preparedProbe(evidencePack: QueryResult["evidence_pack"], id: string) {
  const now = new Date().toISOString();
  const expiresAt = new Date(Date.now() + 10 * 60_000).toISOString();
  const parametersDigest = await modelGatewayRequestParametersSha256({ max_tokens: 32, stream: false });
  const pricingRef = `failure-summary-pricing-${id}`;
  const deployment = Object.freeze({
    route_ref: ROUTE,
    route_version: ROUTE_VERSION,
    prompt_generation: PROMPT_GENERATION,
    schema_generation: SCHEMA_GENERATION,
    parameters_digest: parametersDigest,
    pricing_snapshot_ref: pricingRef,
  });
  const routeDefinition = Object.freeze({ protocol: "local-native-failure-summary-fixture.v1" });
  const routeDefinitionSha256 = await modelGatewaySha256(canonicalModelGatewayJson(routeDefinition));
  const probe: DynamicRouteQualificationProbeInput = Object.freeze({
    provisioning: Object.freeze({
      disposition: "EXISTING_MATCH",
      deployment,
      provider_route_id: "failure-summary-provider-route",
      provider_route_name: "failure-summary-route",
      route_definition_sha256: routeDefinitionSha256,
      provider_snapshot_sha256: "b".repeat(64),
      control_plane_receipt_ref: "failure-summary-control-plane",
    }),
    route_definition: routeDefinition,
    route_definition_sha256: routeDefinitionSha256,
    model_call: Object.freeze({
      route_ref: ROUTE,
      prompt_generation: PROMPT_GENERATION,
      schema_generation: SCHEMA_GENERATION,
      budget_reservation_ref: `failure-summary-budget-${id}`,
      output_object_ref: `model-qualification-output-${"c".repeat(64)}`,
      max_input_bytes: 65_536,
      max_output_bytes: 1_024,
      evidence_pack: evidencePack,
    }),
    expected_provider: PROVIDER,
    expected_model: MODEL,
    probe_idempotency_key: `failure-summary-probe-${id}`,
    verified_at: now,
    expires_at: expiresAt,
  });
  const prompt = Object.freeze({
    access: Object.freeze({
      principal_ref: access.principal_ref,
      client_class: "owner_pwa" as const,
      credential_generation: OWNER_CREDENTIAL,
    }),
    policy: Object.freeze({
      allowed_tool_definition_refs: [],
      allowed_verifier_refs: [],
      permitted_anchor_and_precision_ceilings: [],
      provider_and_policy_generations: Object.freeze({ fixture: "failure-summary-v1" }),
      permitted_acquisition_or_expansion_routes: [],
      disclosure_ceiling: "owner-only",
      allowed_use: ["research"],
      expires_at: expiresAt,
    }),
    manifest_ref: Object.freeze({ id: `failure-summary-manifest-${id}`, revision: 1 }),
    manifest_residency_template: Object.freeze({
      scope_domain_id: evidencePack.scope_snapshot_ref.id,
      access_domain_id: access.principal_ref,
      confidentiality_domain_id: "private",
      encryption_key_domain_id: "failure-summary-key",
      retention_domain_id: "failure-summary-retention",
      erasure_domain_id: "failure-summary-erasure",
    }),
    trusted_parameters: Object.freeze({ prompt: "Use only the held local evidence.", max_tokens: 32 }),
    request_timeout_ms: 1_000,
  });
  return Object.freeze({
    probe,
    prompt,
    probe_input_sha256: await dynamicRouteQualificationProbeInputSha256(probe),
    claim_ref: `failure-summary-claim-${id}`,
    deployment,
    pricingRef,
    now,
    expiresAt,
  });
}

async function admitAndPrice(input: Awaited<ReturnType<typeof preparedProbe>>): Promise<void> {
  await createD1ResearchModelQualificationObservationStore(runtime.CORE_DB).claim({
    probe_idempotency_key: input.probe.probe_idempotency_key,
    probe_input_sha256: input.probe_input_sha256,
    claim_ref: input.claim_ref,
  });
  const identity = {
    pricing_snapshot_ref: input.pricingRef,
    route_ref: ROUTE,
    route_version: ROUTE_VERSION,
    provider: PROVIDER,
    exact_model_id: MODEL,
  };
  await createD1ResearchModelPricingSnapshotStore(runtime.CORE_DB, { now: () => input.now }).putImmutable({
    identity,
    snapshot: {
      protocol: "eliotr.research-model-pricing.v1",
      ...identity,
      pricing_basis: "EXACT_TOKEN_RATES_V1",
      input_rate_usd_per_1k_tokens: "0",
      output_rate_usd_per_1k_tokens: "0",
      effective_at: new Date(Date.parse(input.now) - 60_000).toISOString(),
      expires_at: new Date(Date.parse(input.now) + 60 * 60_000).toISOString(),
      provenance_ref: "failure-summary-test-pricing-provenance",
      approval_receipt_ref: "failure-summary-test-pricing-approval",
    },
  });
}

function dispatch(searchDb: D1Database, fetch: typeof globalThis.fetch, coreDb: D1Database = runtime.CORE_DB) {
  return createResearchModelQualificationDispatch({
    core_database: coreDb,
    search_database: searchDb,
    work_bucket: runtime.WORK_BUCKET,
    evidence_bucket: runtime.EVIDENCE_BUCKET,
    gateway: { reasoning_gateway_base_url: GATEWAY_URL, gateway_token: TEST_TOKEN, fetch },
    now: () => new Date().toISOString(),
  });
}

describe("qualification failure-summary production D1 queries on Workerd", () => {
  it("records and reconciles a STARTED-only failure, binds identity, and rejects a non-Core summary store", async () => {
    const evidencePack = await currentEvidencePack();
    const primary = await preparedProbe(evidencePack, "positive");
    await admitAndPrice(primary);

    let localFetchCalls = 0;
    let lostSummaryAck = false;
    const observedCore = observeDatabase(async (sql, phase) => {
      if (!lostSummaryAck && phase === "after" &&
          sql.startsWith("INSERT INTO model_route_qualification_failure_summary(")) {
        lostSummaryAck = true;
        throw new Error("intentional local after-commit acknowledgement loss");
      }
    });
    const unavailableLocalFetch: typeof globalThis.fetch = async () => {
      localFetchCalls += 1;
      throw new TypeError("intentional local transport fault; no network request");
    };
    const service = dispatch(runtime.SEARCH_DB, unavailableLocalFetch, observedCore);
    const serviceInput = {
      probe: primary.probe,
      prompt: primary.prompt,
      probe_input_sha256: primary.probe_input_sha256,
      claim_ref: primary.claim_ref,
    };
    let originalFailure: unknown;
    try {
      await service.execute(serviceInput, {
        principal_ref: access.principal_ref,
        client_class: "owner_pwa",
        credential_generation: OWNER_CREDENTIAL,
      });
    } catch (error) {
      originalFailure = error;
    }
    expect(originalFailure).toMatchObject({ code: "MODEL_GATEWAY_TRANSPORT_FAILED", retryable: false });
    expect(lostSummaryAck).toBe(true);
    expect(localFetchCalls).toBe(1); // Only the injected local function ran.

    const identity = {
      probe_idempotency_key: primary.probe.probe_idempotency_key,
      probe_input_sha256: primary.probe_input_sha256,
      claim_ref: primary.claim_ref,
    };
    const saved = await readResearchModelQualificationFailureSummary(runtime.CORE_DB, identity);
    expect(saved).toMatchObject({
      ...identity,
      phase: "MODEL_GATEWAY_EXECUTION",
      failure_code: "MODEL_GATEWAY_TRANSPORT_FAILED",
      safe_response_reason: null,
    });
    expect(saved?.transport_failure_reason).not.toBeNull();
    expect(JSON.stringify(saved)).not.toContain(TEST_TOKEN);

    // Same immutable failure survives concurrent idempotent recorder calls.
    if (!(originalFailure instanceof ModelGatewayExecutionError)) throw new Error("missing typed local dispatch failure");
    const [firstReplay, secondReplay] = await Promise.all([
      recordResearchModelQualificationFailureSummary(runtime.CORE_DB, { ...identity, error: originalFailure }),
      recordResearchModelQualificationFailureSummary(runtime.CORE_DB, { ...identity, error: originalFailure }),
    ]);
    expect(firstReplay.summary_sha256).toBe(saved?.summary_sha256);
    expect(secondReplay.summary_sha256).toBe(saved?.summary_sha256);
    await expect(readResearchModelQualificationFailureSummary(runtime.CORE_DB, {
      ...identity, claim_ref: "foreign-claim",
    })).rejects.toThrow();
    await expect(readResearchModelQualificationFailureSummary(runtime.CORE_DB, {
      ...identity, probe_input_sha256: "0".repeat(64),
    })).rejects.toThrow();

    // A repeated dispatcher call sees the immutable summary and never invokes
    // even the injected local fetch a second time.
    await expect(service.execute(serviceInput, {
      principal_ref: access.principal_ref,
      client_class: "owner_pwa",
      credential_generation: OWNER_CREDENTIAL,
    })).rejects.toMatchObject({ code: "MODEL_GATEWAY_TRANSPORT_FAILED", retryable: false });
    expect(localFetchCalls).toBe(1);

    // Failure summaries are Core-owned. The same valid identity must fail
    // closed against Search D1 for both read and record operations.
    await expect(readResearchModelQualificationFailureSummary(runtime.SEARCH_DB, identity))
      .rejects.toBeInstanceOf(ResearchModelQualificationFailureSummaryError);
    await expect(recordResearchModelQualificationFailureSummary(runtime.SEARCH_DB, {
      ...identity,
      error: originalFailure,
    })).rejects.toBeInstanceOf(ResearchModelQualificationFailureSummaryError);
    await expect(readResearchModelQualificationFailureSummary(runtime.CORE_DB, identity))
      .resolves.toMatchObject({ summary_sha256: saved?.summary_sha256 });
  }, 30_000);
});
