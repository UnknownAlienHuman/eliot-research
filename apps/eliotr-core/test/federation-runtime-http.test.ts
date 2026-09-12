import { beforeAll, describe, expect, it } from "vitest";
import type {
  AllowedReferenceManifest,
  FederationEvidenceBundle,
  FederationRequest,
  VersionedRef,
} from "@eliotr/contracts";
import {
  completeD1FederationJob,
  createD1FederationManifestStore,
  federationDigest,
  federationSha256Bytes,
  putFederationBundleBytes,
  readFederationJob,
  type FederationAuthorityBinding,
} from "@eliotr/cloudflare-federation";
import {
  body,
  count,
  db,
  insert,
  run,
  runtime,
  setupOrientationDatabase,
  verifier,
} from "./orientation-fixture.js";

const CLIENT = "memory-os-client";
const OTHER_CLIENT = "other-memory-os-client";
const FENCE = "client-fence-1";
const MANIFEST_REF = { id: "federation-manifest-http", revision: 1 } as const;
const SCOPE_REF = { id: "federation-scope-http", revision: 1 } as const;
const encoder = new TextEncoder();
const REQUEST_DEADLINE = new Date(Date.now() + 86_400_000).toISOString();

function federationHeaders(
  fence = FENCE,
): Record<string, string> {
  return {
    "content-type": "application/json",
    "x-eliotr-client-fence-ref": fence,
    "x-eliotr-reference-manifest-id": MANIFEST_REF.id,
    "x-eliotr-reference-manifest-revision": String(MANIFEST_REF.revision),
  };
}

function request(
  exchangeId: string,
  idempotencyKey: string,
): FederationRequest {
  return {
    protocol: "eliotr.federation.v1",
    exchange_id: exchangeId,
    bridge_generation: runtime.DEPLOYMENT_GENERATION,
    idempotency_key: idempotencyKey,
    requester_principal_ref: CLIENT,
    client_fence_ref: FENCE,
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
    deadline: REQUEST_DEADLINE,
    stop_rule_ref: "stop-rule-1",
    progress_contract_ref: "progress-contract-1",
    required_result_schema_ref: "result-schema-1",
    evidence_grade: "E2",
  };
}

function authorityBinding(traceId: string): FederationAuthorityBinding {
  return {
    requester_principal_ref: CLIENT,
    requester_credential_generation: "credential-v1",
    server_principal_ref: runtime.FEDERATION_SERVER_PRINCIPAL_REF as string,
    server_credential_generation: runtime.DEPLOYMENT_GENERATION,
    bridge_generation: runtime.DEPLOYMENT_GENERATION,
    client_fence_ref: FENCE,
    allowed_reference_manifest_ref: MANIFEST_REF,
    trace_id: traceId,
  };
}

async function manifest(): Promise<AllowedReferenceManifest> {
  const payload: Omit<AllowedReferenceManifest, "manifest_digest"> = {
    manifest_ref: MANIFEST_REF,
    scope_snapshot_ref: SCOPE_REF,
    allowed_source_revision_refs: [],
    allowed_evidence_handle_refs: [],
    allowed_tool_definition_refs: [],
    allowed_verifier_refs: [],
    permitted_anchor_and_precision_ceilings: [],
    provider_and_policy_generations: {
      [CLIENT]: "credential-v1",
      [OTHER_CLIENT]: "credential-v1",
      [runtime.FEDERATION_SERVER_PRINCIPAL_REF as string]:
        runtime.DEPLOYMENT_GENERATION,
      "privacy-policy-1": "generation-1",
      "disclosure-policy-1": "generation-1",
      "retention-policy-1": "generation-1",
      "license-policy-1": "generation-1",
      "residency-profile-1": "generation-1",
      "budget-1": "generation-1",
      "stop-rule-1": "generation-1",
      "progress-contract-1": "generation-1",
      "result-schema-1": "generation-1",
    },
    stale_or_revoked_entries: [],
    permitted_acquisition_or_expansion_routes: [],
    disclosure_ceiling: "private",
    allowed_use: [
      "federation.submit",
      "federation.status",
      "federation.result",
      "federation.cancel",
      "federation.bundle.read",
      "federation.bundle.manifest",
      "federation.changes",
    ],
    expires_at: new Date(Date.now() + 86_400_000).toISOString(),
    client_fence_ref: FENCE,
  };
  return { ...payload, manifest_digest: await federationDigest(payload) };
}

async function seedAuthority(): Promise<void> {
  await insert("scope_snapshot", {
    snapshot_id: SCOPE_REF.id,
    revision: SCOPE_REF.revision,
    resolved_scope_expression_json:
      '{"kind":"PROJECT","project_id":"project-1"}',
    participant_generations_json: "{}",
    member_source_revision_refs_json: "[]",
    source_owner_generations_json: "{}",
    policy_authority_ref: "policy-authority-1",
    disclosure_closure_digest: "b".repeat(64),
    purge_ledger_revision: 0,
    client_fence_ref: FENCE,
    snapshot_digest: "c".repeat(64),
    created_at: new Date(Date.now() - 1_000).toISOString(),
    expires_at: new Date(Date.now() + 86_400_000).toISOString(),
    invalidated_at: null,
    invalidation_reason: null,
  });
  await createD1FederationManifestStore(db).put(await manifest());
}

async function jsonRequest<T>(
  url: string,
  init: RequestInit,
  who = CLIENT,
): Promise<{ readonly response: Response; readonly value: { data?: T; code?: string } }> {
  const response = await run(new Request(url, init), verifier(who, "service_token"));
  const value = await body<T>(response);
  return { response, value };
}

async function submit(
  exchangeId: string,
  idempotencyKey: string,
  fence = FENCE,
): Promise<{ readonly status: Record<string, unknown>; readonly traceId: string }> {
  const { response, value } = await jsonRequest<Record<string, unknown>>(
    "https://research.example/federation/v1/jobs",
    {
      method: "POST",
      headers: federationHeaders(fence),
      body: JSON.stringify(request(exchangeId, idempotencyKey)),
    },
  );
  expect(response.status, JSON.stringify(value)).toBe(202);
  expect(value.data).toMatchObject({
    exchange_id: exchangeId,
    idempotency_key: idempotencyKey,
    transport_state: "ACCEPTED",
  });
  return {
    status: value.data as Record<string, unknown>,
    traceId: response.headers.get("x-eliotr-trace-id") ?? "trace-http",
  };
}

function bundle(
  exchangeId: string,
  jobId: string,
  requestDigest: string,
  immutableDigest: string,
): FederationEvidenceBundle {
  return {
    protocol: "eliotr.federation.v1",
    exchange_id: exchangeId,
    request_digest: requestDigest,
    job_id: jobId,
    system_generation: runtime.DEPLOYMENT_GENERATION,
    immutable_bundle_digest: immutableDigest,
    origin_authentication_ref: "origin-authentication-1",
    source_owner_generations: {},
    source_catalog_snapshot_refs: [],
    exact_citation_handle_refs: [],
    claim_counterclaim_matrix_ref: "claim-matrix-1",
    independence_matrix_ref: "independence-matrix-1",
    bounded_excerpt_refs: [],
    artifact_handle_refs: [],
    coverage_receipt: {
      receipt_ref: { id: `coverage-${jobId}`, revision: 1 },
      requested_scope_expression: {
        kind: "PROJECT",
        project_id: "project-1",
      },
      frozen_scope_snapshot_ref: SCOPE_REF,
      coverage_denominator_ref: { id: `denominator-${jobId}`, revision: 1 },
      denominator_kind: "unknown",
      eligible_source_refs: [],
      represented_source_refs: [],
      cited_source_refs: [],
      omitted_sources: [],
      unknown_coverage_reason: "the bounded corpus is inconclusive",
      source_families_and_independence_profile_ref: "independence-profile-1",
      lanes_used: [],
      stale_or_skipped_lanes: [],
      failed_acquisition_refs: [],
      provider_degradation_refs: [],
      parser_degradation_refs: [],
      redacted_dependency_refs: [],
      counter_search_status: "PARTIAL",
      budget_limitations: [],
      terminal_disposition: "INCONCLUSIVE",
    },
    unknowns: ["the bounded corpus is inconclusive"],
    failed_acquisition_refs: [],
    research_debt_refs: [],
    completion_disposition: "INCONCLUSIVE",
    reopen_conditions: ["new admitted evidence becomes available"],
    synthesis_candidate_ref: "synthesis-candidate-1",
    synthesis_is_candidate: true,
    disclosure_ref: "disclosure-1",
    retention_ref: "retention-1",
    expires_at: new Date(Date.now() + 86_400_000).toISOString(),
    unsupported_precision: [],
  };
}

beforeAll(async () => {
  await setupOrientationDatabase();
  await seedAuthority();
});

describe("authenticated federation runtime", () => {
  it("submits, replays, completes, reads manifest and bounded bytes", async () => {
    const exchangeId = "exchange-http-1";
    const idempotencyKey = "idempotency-http-1";
    const first = await submit(exchangeId, idempotencyKey);
    const second = await submit(exchangeId, idempotencyKey);
    expect(second.status).toEqual(first.status);
    expect(await count("federation_job")).toBe(1);

    const stored = await readFederationJob(db, exchangeId, idempotencyKey);
    expect(stored).not.toBeNull();
    const jobId = stored?.record.status.job_id as string;
    const bytes = encoder.encode('{"answer":"inconclusive"}');
    const result = bundle(
      exchangeId,
      jobId,
      stored?.record.request_digest as string,
      await federationSha256Bytes(bytes),
    );
    await putFederationBundleBytes(runtime.WORK_BUCKET, result, bytes);
    await completeD1FederationJob(
      db,
      runtime.WORK_BUCKET,
      authorityBinding(stored?.binding.trace_id ?? "trace-http"),
      exchangeId,
      idempotencyKey,
      result,
    );

    const selector = `?idempotency_key=${idempotencyKey}`;
    const completed = await jsonRequest<Record<string, unknown>>(
      `https://research.example/federation/v1/jobs/${exchangeId}${selector}`,
      { method: "GET", headers: federationHeaders() },
    );
    expect(completed.response.status).toBe(200);
    expect(completed.value.data).toMatchObject({
      transport_state: "COMPLETED",
      completion_disposition: "INCONCLUSIVE",
    });

    const resultRead = await jsonRequest<FederationEvidenceBundle>(
      `https://research.example/federation/v1/jobs/${exchangeId}/result${selector}`,
      { method: "GET", headers: federationHeaders() },
    );
    expect(resultRead.response.status).toBe(200);
    expect(resultRead.value.data).toMatchObject({
      job_id: jobId,
      synthesis_is_candidate: true,
      completion_disposition: "INCONCLUSIVE",
    });

    const manifestRead = await jsonRequest<FederationEvidenceBundle>(
      `https://research.example/federation/v1/bundles/${jobId}/revisions/1/manifest`,
      { method: "GET", headers: federationHeaders() },
    );
    expect(manifestRead.response.status).toBe(200);
    expect(manifestRead.value.data?.immutable_bundle_digest)
      .toBe(result.immutable_bundle_digest);

    const range = await run(new Request(
      `https://research.example/federation/v1/bundles/${jobId}/revisions/1`,
      {
        method: "GET",
        headers: { ...federationHeaders(), range: "bytes=0-3" },
      },
    ), verifier(CLIENT, "service_token"));
    expect(range.status).toBe(206);
    expect(new Uint8Array(await range.arrayBuffer()))
      .toEqual(bytes.slice(0, 4));
  });

  it("cancels once and never returns a result", async () => {
    const exchangeId = "exchange-http-2";
    const idempotencyKey = "idempotency-http-2";
    await submit(exchangeId, idempotencyKey);

    const cancelled = await jsonRequest<Record<string, unknown>>(
      `https://research.example/federation/v1/jobs/${exchangeId}/cancel`,
      {
        method: "POST",
        headers: federationHeaders(),
        body: JSON.stringify({
          idempotency_key: idempotencyKey,
          reason: "requester withdrew the bounded operation",
        }),
      },
    );
    expect(cancelled.response.status).toBe(200);
    expect(cancelled.value.data).toMatchObject({
      transport_state: "CANCELLED",
      completion_disposition: "CANCELLED",
    });

    const result = await jsonRequest(
      `https://research.example/federation/v1/jobs/${exchangeId}/result?idempotency_key=${idempotencyKey}`,
      { method: "GET", headers: federationHeaders() },
    );
    expect(result.response.status).toBe(404);
    expect(result.value.code).toBe("FEDERATION_HTTP_NOT_FOUND");
  });

  it("replays scope-bound changes with a peer-bound signed cursor", async () => {
    await insert("research_change_feed", {
      change_ref: "federation-change-http-1",
      kind: "SOURCE_UPDATED",
      subject_ref: "source-revision-http-1",
      subject_revision: 1,
      payload_ref: "payload-http-1",
      payload_sha256: "d".repeat(64),
      visibility_principal_ref: null,
      visibility_snapshot_id: SCOPE_REF.id,
      visibility_snapshot_revision: SCOPE_REF.revision,
      occurred_at: new Date().toISOString(),
      metadata_json: "{}",
    });

    const first = await jsonRequest<{
      next_cursor: string;
      changed_refs: readonly VersionedRef[];
    }>(
      "https://research.example/federation/v1/changes",
      {
        method: "POST",
        headers: federationHeaders(),
        body: JSON.stringify({
          after_cursor: "",
          allowed_scope_refs: [SCOPE_REF],
        }),
      },
    );
    expect(first.response.status).toBe(200);
    expect(first.value.data?.changed_refs).toContainEqual({
      id: "source-revision-http-1",
      revision: 1,
    });
    const cursor = first.value.data?.next_cursor as string;
    expect(cursor).toMatch(/^fc1\./u);

    const forged = await jsonRequest(
      "https://research.example/federation/v1/changes",
      {
        method: "POST",
        headers: federationHeaders(),
        body: JSON.stringify({
          after_cursor: `${cursor}x`,
          allowed_scope_refs: [SCOPE_REF],
        }),
      },
    );
    expect(forged.response.status).toBe(400);

    const other = await jsonRequest(
      "https://research.example/federation/v1/changes",
      {
        method: "POST",
        headers: federationHeaders(),
        body: JSON.stringify({
          after_cursor: cursor,
          allowed_scope_refs: [SCOPE_REF],
        }),
      },
      OTHER_CLIENT,
    );
    expect(other.response.status).toBe(409);
    expect(other.value.code).toBe(
      "FEDERATION_RUNTIME_CURSOR_AUTHORITY_MISMATCH",
    );
  });

  it("rejects a substituted client fence before durable reservation", async () => {
    const before = await count("federation_job");
    const response = await jsonRequest(
      "https://research.example/federation/v1/jobs",
      {
        method: "POST",
        headers: federationHeaders("different-client-fence"),
        body: JSON.stringify(
          request("exchange-http-denied", "idempotency-http-denied"),
        ),
      },
    );
    expect([403, 409]).toContain(response.response.status);
    expect(await count("federation_job")).toBe(before);
  });
});
