import type {
  FederationJobStatus,
  FederationRequest,
} from "@eliotr/contracts";
import { describe, expect, it } from "vitest";
import {
  federationCanonicalJson,
  federationDigest,
  readFederationJob,
  stableFederationJobId,
  type FederationAuthorityBinding,
} from "../src/index.js";

const CREATED = "2026-09-04T16:30:00.000Z";
const FUTURE = "2026-09-05T16:30:00.000Z";

function binding(): FederationAuthorityBinding {
  return {
    requester_principal_ref: "memory-os-client",
    requester_credential_generation: "memory-os-credential-1",
    server_principal_ref: "eliot-research",
    server_credential_generation: "research-credential-1",
    bridge_generation: "bridge-generation-1",
    client_fence_ref: "client-fence-1",
    allowed_reference_manifest_ref: {
      id: "federation-manifest-1",
      revision: 1,
    },
    trace_id: "trace-1",
  };
}

function request(): FederationRequest {
  return {
    protocol: "eliotr.federation.v1",
    exchange_id: "exchange-terminal-1",
    bridge_generation: "bridge-generation-1",
    idempotency_key: "idempotency-terminal-1",
    requester_principal_ref: "memory-os-client",
    client_fence_ref: "client-fence-1",
    question: "What exact evidence is available?",
    scope_expression: { kind: "PROJECT", project_id: "project-1" },
    expected_decision_or_artifact: "evidence bundle",
    source_classes: ["primary"],
    coverage_goal: "high_recall",
    allowed_input_handle_refs: [],
    privacy_policy_ref: "privacy-policy-1",
    disclosure_policy_ref: "disclosure-policy-1",
    retention_policy_ref: "retention-policy-1",
    license_policy_ref: "license-policy-1",
    residency_profile_ref: "residency-profile-1",
    budget_ref: "budget-1",
    deadline: FUTURE,
    stop_rule_ref: "stop-rule-1",
    progress_contract_ref: "progress-contract-1",
    required_result_schema_ref: "result-schema-1",
    evidence_grade: "E2",
  };
}

async function row(
  state: "COMPLETED" | "FAILED",
  withReceipt: boolean,
): Promise<Record<string, unknown>> {
  const authority = binding();
  const value = request();
  const requestDigest = await federationDigest(value);
  const jobId = await stableFederationJobId(
    authority,
    value,
    requestDigest,
  );
  const status: FederationJobStatus = {
    exchange_id: value.exchange_id,
    idempotency_key: value.idempotency_key,
    job_id: jobId,
    attempt: 1,
    transport_state: state,
    completion_disposition: state === "COMPLETED" ? "INCONCLUSIVE" : null,
    completed_obligation_refs: [],
    partial_bundle_refs: [],
    open_research_debt_refs: [],
    ...(withReceipt
      ? { terminal_receipt_ref: `terminal-${state.toLowerCase()}-1` }
      : {}),
  };
  return {
    job_id: jobId,
    exchange_id: value.exchange_id,
    idempotency_key: value.idempotency_key,
    request_digest: requestDigest,
    request_json: federationCanonicalJson(value),
    requester_principal_ref: authority.requester_principal_ref,
    requester_credential_generation:
      authority.requester_credential_generation,
    server_principal_ref: authority.server_principal_ref,
    server_credential_generation: authority.server_credential_generation,
    bridge_generation: authority.bridge_generation,
    client_fence_ref: authority.client_fence_ref,
    allowed_manifest_id: authority.allowed_reference_manifest_ref.id,
    allowed_manifest_revision:
      authority.allowed_reference_manifest_ref.revision,
    origin_trace_id: authority.trace_id,
    attempt: 1,
    transport_state: state,
    status_json: federationCanonicalJson(status),
    observed_completion_disposition:
      state === "COMPLETED" ? "INCONCLUSIVE" : null,
    result_json: null,
    cancellation_reason: null,
    cancelled_at: null,
    created_at: CREATED,
    updated_at: CREATED,
  };
}

function database(value: Record<string, unknown>): D1Database {
  return {
    prepare() {
      return {
        bind() {
          return {
            async first<T>() {
              return value as T;
            },
          };
        },
      };
    },
  } as unknown as D1Database;
}

async function decode(value: Record<string, unknown>) {
  return readFederationJob(
    database(value),
    "exchange-terminal-1",
    "idempotency-terminal-1",
  );
}

describe("federation terminal receipt boundary", () => {
  it.each(["COMPLETED", "FAILED"] as const)(
    "rejects %s without a durable terminal receipt",
    async (state) => {
      await expect(decode(await row(state, false))).rejects.toMatchObject({
        code: "FEDERATION_D1_INPUT_INVALID",
      });
    },
  );

  it.each(["COMPLETED", "FAILED"] as const)(
    "admits %s only with its terminal receipt reference",
    async (state) => {
      await expect(decode(await row(state, true))).resolves.toMatchObject({
        record: {
          status: {
            transport_state: state,
            terminal_receipt_ref: `terminal-${state.toLowerCase()}-1`,
          },
        },
      });
    },
  );
});
