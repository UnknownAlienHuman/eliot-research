import type {
  AllowedReferenceManifest,
  CompletionDisposition,
  FederationEvidenceBundle,
  FederationJobStatus,
  FederationRequest,
  VersionedRef,
} from "@eliotr/contracts";
import type { FederationAuthenticatedContext } from "@eliotr/interfaces";
import { describe, expect, it, vi } from "vitest";
import {
  FederationServiceError,
  createFederationService,
  type FederationJobRecord,
  type FederationServiceDependencies,
} from "./federation-service.js";

const NOW = Date.parse("2026-09-01T20:00:00.000Z");
const FUTURE = "2026-09-02T20:00:00.000Z";
const PAST = "2026-08-31T20:00:00.000Z";
const DIGEST = "a".repeat(64);
const encoder = new TextEncoder();

function ref(id: string, revision = 1): VersionedRef {
  return { id, revision };
}

const scopeRef = ref("scope-snapshot");
const manifestRef = ref("allowed-reference-manifest");
const allowedHandle = ref("evidence-handle");
const bundleRef = ref("federation-bundle");
const allowedUses = [
  "federation.submit",
  "federation.status",
  "federation.result",
  "federation.cancel",
  "federation.bundle.read",
  "federation.bundle.manifest",
  "federation.changes",
] as const;

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const record = value as Readonly<Record<string, unknown>>;
  return `{${Object.keys(record).sort().map(
    (key) => `${JSON.stringify(key)}:${canonical(record[key])}`,
  ).join(",")}}`;
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(value));
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function deeplyNestedScope(depth: number): unknown {
  let scope: unknown = { kind: "PROJECT", project_id: "project-1" };
  for (let index = 1; index < depth; index += 1) {
    scope = {
      kind: "UNION",
      left: scope,
      right: { kind: "TAG", tag: `tag-${index}` },
    };
  }
  return scope;
}

function request(overrides: Partial<FederationRequest> = {}): FederationRequest {
  return {
    protocol: "eliotr.federation.v1",
    exchange_id: "exchange-1",
    bridge_generation: "bridge-generation-1",
    idempotency_key: "idempotency-1",
    requester_principal_ref: "client-principal",
    client_fence_ref: "client-fence-1",
    question: "What evidence is available?",
    scope_expression: { kind: "PROJECT", project_id: "project-1" },
    expected_decision_or_artifact: "evidence bundle",
    source_classes: ["primary"],
    coverage_goal: "high_recall",
    allowed_input_handle_refs: [allowedHandle],
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
    ...overrides,
  };
}

function status(
  transportState: FederationJobStatus["transport_state"] = "COMPLETED",
  disposition: CompletionDisposition | null = "ANSWERED_WITH_SUPPORTED_RESULT",
): FederationJobStatus {
  return {
    exchange_id: "exchange-1",
    idempotency_key: "idempotency-1",
    job_id: "job-1",
    attempt: 1,
    transport_state: transportState,
    completion_disposition: disposition,
    completed_obligation_refs: [],
    partial_bundle_refs: [],
    open_research_debt_refs: [],
    terminal_receipt_ref: "terminal-receipt-1",
  };
}

function bundle(
  disposition: CompletionDisposition = "ANSWERED_WITH_SUPPORTED_RESULT",
  overrides: Partial<FederationEvidenceBundle> = {},
): FederationEvidenceBundle {
  return {
    protocol: "eliotr.federation.v1",
    exchange_id: "exchange-1",
    request_digest: DIGEST,
    job_id: "job-1",
    system_generation: "system-generation-1",
    immutable_bundle_digest: DIGEST,
    origin_authentication_ref: "origin-authentication-1",
    source_owner_generations: {},
    source_catalog_snapshot_refs: [],
    exact_citation_handle_refs: [allowedHandle],
    claim_counterclaim_matrix_ref: "claim-matrix-1",
    independence_matrix_ref: "independence-matrix-1",
    bounded_excerpt_refs: [],
    artifact_handle_refs: [],
    coverage_receipt: {
      receipt_ref: ref("coverage-receipt"),
      requested_scope_expression: { kind: "PROJECT", project_id: "project-1" },
      frozen_scope_snapshot_ref: scopeRef,
      coverage_denominator_ref: ref("coverage-denominator"),
      denominator_kind: "unknown",
      eligible_source_refs: [],
      represented_source_refs: [],
      cited_source_refs: [],
      omitted_sources: [],
      unknown_coverage_reason: "the available corpus did not resolve the question",
      source_families_and_independence_profile_ref: "independence-profile-1",
      lanes_used: [],
      stale_or_skipped_lanes: [],
      failed_acquisition_refs: [],
      provider_degradation_refs: [],
      parser_degradation_refs: [],
      redacted_dependency_refs: [],
      counter_search_status: "PARTIAL",
      budget_limitations: [],
      terminal_disposition: disposition,
    },
    unknowns: ["the evidence remains inconclusive"],
    failed_acquisition_refs: [],
    research_debt_refs: [],
    completion_disposition: disposition,
    reopen_conditions: ["new primary evidence becomes available"],
    synthesis_candidate_ref: "synthesis-candidate-1",
    synthesis_is_candidate: true,
    disclosure_ref: "disclosure-1",
    retention_ref: "retention-1",
    expires_at: FUTURE,
    unsupported_precision: [],
    ...overrides,
  };
}

function record(
  observed: CompletionDisposition | null = "INCONCLUSIVE",
  transportState: FederationJobStatus["transport_state"] = "COMPLETED",
): FederationJobRecord {
  return {
    request_digest: DIGEST,
    status: status(transportState),
    observed_completion_disposition: observed,
    result: transportState === "COMPLETED" ? bundle() : null,
  };
}

async function manifest(
  uses: readonly string[] = allowedUses,
  overrides: Partial<Omit<AllowedReferenceManifest, "manifest_digest">> = {},
): Promise<AllowedReferenceManifest> {
  const payload: Omit<AllowedReferenceManifest, "manifest_digest"> = {
    manifest_ref: manifestRef,
    scope_snapshot_ref: scopeRef,
    allowed_source_revision_refs: [],
    allowed_evidence_handle_refs: [allowedHandle],
    allowed_tool_definition_refs: [],
    allowed_verifier_refs: [],
    permitted_anchor_and_precision_ceilings: [],
    provider_and_policy_generations: {
      "client-principal": "client-credential-generation-1",
      "server-principal": "server-credential-generation-1",
      "privacy-policy-1": "privacy-generation-1",
      "disclosure-policy-1": "disclosure-generation-1",
      "retention-policy-1": "retention-generation-1",
      "license-policy-1": "license-generation-1",
      "residency-profile-1": "residency-generation-1",
      "budget-1": "budget-generation-1",
      "stop-rule-1": "stop-generation-1",
    },
    stale_or_revoked_entries: [],
    permitted_acquisition_or_expansion_routes: [],
    disclosure_ceiling: "disclosure-ceiling-1",
    allowed_use: [...uses],
    expires_at: FUTURE,
    client_fence_ref: "client-fence-1",
    ...overrides,
  };
  return { ...payload, manifest_digest: await sha256(canonical(payload)) };
}

function context(
  overrides: Partial<FederationAuthenticatedContext> = {},
): FederationAuthenticatedContext {
  return {
    request: new Request("https://research.example/federation"),
    principal_ref: "client-principal",
    client_class: "federation_client",
    credential_generation: "client-credential-generation-1",
    client_fence_ref: "client-fence-1",
    allowed_reference_manifest_ref: manifestRef,
    server_principal_ref: "server-principal",
    server_credential_generation: "server-credential-generation-1",
    trace_id: "trace-1",
    ...overrides,
  };
}

type ManifestFactory = () => Promise<AllowedReferenceManifest>;

function dependencies(
  jobRecord: FederationJobRecord = record(),
  uses: readonly string[] = allowedUses,
  manifestFactory: ManifestFactory = () => manifest(uses),
): FederationServiceDependencies {
  return {
    identity: {
      principal_ref: "server-principal",
      credential_generation: "server-credential-generation-1",
      bridge_generation: "bridge-generation-1",
    },
    jobs: {
      reserve: vi.fn(async (submission) => ({
        outcome: "CREATED" as const,
        request_digest: submission.request_digest,
        record: {
          ...jobRecord,
          request_digest: submission.request_digest,
          result: jobRecord.result === null
            ? null
            : { ...jobRecord.result, request_digest: submission.request_digest },
        },
      })),
      read: vi.fn(async () => jobRecord),
      cancel: vi.fn(async () => ({
        request_digest: DIGEST,
        status: status("CANCELLED", "CANCELLED"),
        observed_completion_disposition: "CANCELLED" as const,
        result: null,
      })),
    },
    manifests: { get: vi.fn(manifestFactory) },
    bundles: {
      readAuthorizedManifest: vi.fn(async () => bundle()),
      readAuthorizedBytes: vi.fn(async () => new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array([1, 2, 3]));
          controller.close();
        },
      })),
    },
    changes: {
      readAuthorized: vi.fn(async () => ({
        next_cursor: "cursor-2",
        changed_refs: [bundleRef],
      })),
    },
    now: () => NOW,
  };
}

async function expectCode(promise: Promise<unknown>, code: string): Promise<void> {
  try {
    await promise;
    throw new Error(`expected ${code}`);
  } catch (error) {
    expect(error).toBeInstanceOf(FederationServiceError);
    expect(error).toMatchObject({ code });
  }
}

describe("ER-22 federation service", () => {
  it("keeps transport completion orthogonal and downgrades claims to the observed disposition", async () => {
    const service = createFederationService(dependencies());

    const submitted = await service.submit(context(), request());
    const completed = await service.status(context(), "exchange-1", "idempotency-1");
    const result = await service.result(context(), "exchange-1", "idempotency-1");

    expect(submitted).toMatchObject({
      transport_state: "COMPLETED",
      completion_disposition: "INCONCLUSIVE",
    });
    expect(completed).toMatchObject({
      transport_state: "COMPLETED",
      completion_disposition: "INCONCLUSIVE",
    });
    expect(result).toMatchObject({
      completion_disposition: "INCONCLUSIVE",
      synthesis_is_candidate: true,
      coverage_receipt: { terminal_disposition: "INCONCLUSIVE" },
    });
  });

  it("rejects a tampered manifest before invoking durable job authority", async () => {
    const signed = await manifest();
    const tampered: AllowedReferenceManifest = {
      ...signed,
      allowed_evidence_handle_refs: [ref("forged-handle")],
    };
    const input = dependencies(record(), allowedUses, async () => tampered);
    const service = createFederationService(input);

    await expectCode(
      service.submit(context(), request({ allowed_input_handle_refs: [ref("forged-handle")] })),
      "FEDERATION_MANIFEST_DIGEST_MISMATCH",
    );
    expect(input.jobs.reserve).not.toHaveBeenCalled();
  });

  it("rejects revoked handles and policy references outside the signed manifest", async () => {
    const revoked = dependencies(
      record(),
      allowedUses,
      () => manifest(allowedUses, { stale_or_revoked_entries: [allowedHandle.id] }),
    );
    await expectCode(
      createFederationService(revoked).submit(context(), request()),
      "FEDERATION_REFERENCE_DENIED",
    );

    const generations = (await manifest()).provider_and_policy_generations;
    const { "budget-1": _budgetGeneration, ...withoutBudget } = generations;
    const missingBudget = dependencies(
      record(),
      allowedUses,
      () => manifest(allowedUses, { provider_and_policy_generations: withoutBudget }),
    );
    await expectCode(
      createFederationService(missingBudget).submit(context(), request()),
      "FEDERATION_REFERENCE_DENIED",
    );
  });

  it("never strengthens conflicting completion claims and rejects failed terminal claims", async () => {
    const conflicting: FederationJobRecord = {
      request_digest: DIGEST,
      status: status("COMPLETED", "INCONCLUSIVE"),
      observed_completion_disposition: "ANSWERED_WITH_SUPPORTED_RESULT",
      result: bundle(),
    };
    const service = createFederationService(dependencies(conflicting));
    await expect(service.status(context(), "exchange-1", "idempotency-1")).resolves.toMatchObject({
      transport_state: "COMPLETED",
      completion_disposition: "INCONCLUSIVE",
    });
    await expect(service.result(context(), "exchange-1", "idempotency-1")).resolves.toMatchObject({
      completion_disposition: "INCONCLUSIVE",
      coverage_receipt: { terminal_disposition: "INCONCLUSIVE" },
    });

    const failed: FederationJobRecord = {
      request_digest: DIGEST,
      status: status("FAILED", "ANSWERED_WITH_SUPPORTED_RESULT"),
      observed_completion_disposition: "ANSWERED_WITH_SUPPORTED_RESULT",
      result: null,
    };
    await expectCode(
      createFederationService(dependencies(failed)).status(
        context(),
        "exchange-1",
        "idempotency-1",
      ),
      "FEDERATION_AUTHORITY_INVALID",
    );
  });

  it("rejects expired or wrong-scope evidence bundles", async () => {
    const base = dependencies();
    const wrongScope: FederationServiceDependencies = {
      ...base,
      bundles: {
        ...base.bundles,
        readAuthorizedManifest: vi.fn(async () => bundle(
          "ANSWERED_WITH_SUPPORTED_RESULT",
          {
            coverage_receipt: {
              ...bundle().coverage_receipt,
              frozen_scope_snapshot_ref: ref("other-scope"),
            },
          },
        )),
      },
    };
    await expectCode(
      createFederationService(wrongScope).readBundleManifest(context(), bundleRef),
      "FEDERATION_SCOPE_MISMATCH",
    );

    const expired: FederationServiceDependencies = {
      ...base,
      bundles: {
        ...base.bundles,
        readAuthorizedManifest: vi.fn(async () => bundle(
          "ANSWERED_WITH_SUPPORTED_RESULT",
          { expires_at: PAST },
        )),
      },
    };
    await expectCode(
      createFederationService(expired).readBundleManifest(context(), bundleRef),
      "FEDERATION_BUNDLE_EXPIRED",
    );
  });

  it("rejects excessive scope depth before recursive schema parsing", async () => {
  const input = dependencies();
  const service = createFederationService(input);
  const malicious = {
    ...request(),
    scope_expression: deeplyNestedScope(10_000),
  } as FederationRequest;

  await expectCode(
    service.submit(context(), malicious),
    "FEDERATION_SCOPE_TOO_DEEP",
  );
  expect(input.jobs.reserve).not.toHaveBeenCalled();
});

it("fails closed on unknown request, scope, security and budget fields", async () => {
    const service = createFederationService(dependencies());
    const base = request();

    await expectCode(
      service.submit(context(), { ...base, unexpected: true } as FederationRequest),
      "FEDERATION_REQUEST_INVALID",
    );
    await expectCode(service.submit(context(), {
      ...base,
      scope_expression: { kind: "PROJECT", project_id: "project-1", bypass: true },
    } as FederationRequest), "FEDERATION_REQUEST_INVALID");
    await expectCode(
      service.submit(context(), { ...base, privacy_override: true } as FederationRequest),
      "FEDERATION_REQUEST_INVALID",
    );
    await expectCode(
      service.submit(context(), { ...base, budget_override: { unlimited: true } } as FederationRequest),
      "FEDERATION_REQUEST_INVALID",
    );
  });

  it("rejects references and scopes outside the exact AllowedReferenceManifest", async () => {
    const service = createFederationService(dependencies());

    await expectCode(service.submit(context(), request({
      allowed_input_handle_refs: [ref("not-allowed")],
    })), "FEDERATION_REFERENCE_DENIED");
    await expectCode(
      service.changes(context(), "cursor-1", [ref("other-scope")]),
      "FEDERATION_REFERENCE_DENIED",
    );
  });

  it("binds every call to the authenticated peer, server generation and client fence", async () => {
    const service = createFederationService(dependencies());

    await expectCode(
      service.submit(context({ client_fence_ref: "stale-fence" }), request()),
      "FEDERATION_CLIENT_FENCE_MISMATCH",
    );
    await expectCode(
      service.submit(context({ server_credential_generation: "stale-server" }), request()),
      "FEDERATION_SERVER_IDENTITY_MISMATCH",
    );
    await expectCode(
      service.submit(context(), request({ requester_principal_ref: "other-client" })),
      "FEDERATION_REQUEST_BINDING_MISMATCH",
    );
  });

  it("surfaces an idempotency conflict instead of starting duplicate work", async () => {
    const base = dependencies();
    const input: FederationServiceDependencies = {
      ...base,
      jobs: {
        ...base.jobs,
        reserve: vi.fn(async () => ({
          outcome: "CONFLICT" as const,
          existing_request_digest: "b".repeat(64),
        })),
      },
    };
    const service = createFederationService(input);

    await expectCode(
      service.submit(context(), request()),
      "FEDERATION_IDEMPOTENCY_CONFLICT",
    );
  });

  it("strictly validates change pages, bounded ranges, and the read-only surface", async () => {
    const base = dependencies();
    const malformed: FederationServiceDependencies = {
      ...base,
      changes: {
        readAuthorized: vi.fn(async () => ({
          next_cursor: "cursor-2",
          changed_refs: [],
          unexpected: true,
        } as never)),
      },
    };
    await expectCode(
      createFederationService(malformed).changes(context(), "cursor-1", [scopeRef]),
      "FEDERATION_AUTHORITY_INVALID",
    );

    const service = createFederationService(base);
    await expectCode(service.readBundle(context(), bundleRef, {
      start: 0,
      endExclusive: 8 * 1024 * 1024 + 1,
    }), "FEDERATION_RANGE_INVALID");
    expect(Object.keys(service).sort()).toEqual([
      "cancel",
      "changes",
      "readBundle",
      "readBundleManifest",
      "result",
      "status",
      "submit",
    ]);
  });
});
