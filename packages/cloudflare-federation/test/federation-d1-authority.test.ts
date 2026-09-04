import type {
  AllowedReferenceManifest,
  FederationJobStatus,
  FederationRequest,
} from "@eliotr/contracts";
import { describe, expect, it } from "vitest";
import {
  FEDERATION_REQUEST_JSON_MAX_BYTES,
  createD1FederationJobAuthority,
  createD1FederationManifestStore,
  federationCancellationReceiptRef,
  federationCanonicalJson,
  federationDigest,
  federationNow,
  readFederationJob,
  stableFederationJobId,
  type FederationAuthorityBinding,
} from "../src/index.js";

const NOW = Date.parse("2026-09-04T15:00:00.000Z");
const CREATED = "2026-09-04T15:00:00.000Z";
const CANCELLED = "2026-09-04T15:01:00.000Z";
const FUTURE = "2026-09-05T15:00:00.000Z";
const MANIFEST_REF = { id: "federation-manifest-1", revision: 1 } as const;
const SCOPE_REF = { id: "scope-snapshot-1", revision: 1 } as const;

interface Call {
  readonly method: "first" | "run";
  readonly sql: string;
  readonly values: readonly unknown[];
}
type FirstValue = Record<string, unknown> | null | Error;
type RunValue = D1Result<unknown> | Error;

function changed(changes = 1): D1Result<unknown> {
  return {
    success: true,
    results: [],
    meta: { changes },
  } as unknown as D1Result<unknown>;
}

function database(
  firstValues: readonly FirstValue[],
  runValues: readonly RunValue[] = [],
): { readonly db: D1Database; readonly calls: Call[] } {
  const calls: Call[] = [];
  let firstIndex = 0;
  let runIndex = 0;
  const db = {
    prepare(sql: string) {
      return {
        bind(...values: unknown[]) {
          return {
            async first<T>() {
              calls.push({ method: "first", sql, values });
              const result = firstValues[firstIndex++] ?? null;
              if (result instanceof Error) throw result;
              return result as T | null;
            },
            async run() {
              calls.push({ method: "run", sql, values });
              const result = runValues[runIndex++] ?? changed();
              if (result instanceof Error) throw result;
              return result;
            },
          };
        },
      };
    },
  } as unknown as D1Database;
  return { db, calls };
}

function binding(
  overrides: Partial<FederationAuthorityBinding> = {},
): FederationAuthorityBinding {
  return {
    requester_principal_ref: "memory-os-client",
    requester_credential_generation: "memory-os-credential-1",
    server_principal_ref: "eliot-research",
    server_credential_generation: "research-credential-1",
    bridge_generation: "bridge-generation-1",
    client_fence_ref: "client-fence-1",
    allowed_reference_manifest_ref: MANIFEST_REF,
    trace_id: "trace-1",
    ...overrides,
  };
}

async function manifest(
  overrides: Partial<Omit<AllowedReferenceManifest, "manifest_digest">> = {},
): Promise<AllowedReferenceManifest> {
  const payload: Omit<AllowedReferenceManifest, "manifest_digest"> = {
    manifest_ref: MANIFEST_REF,
    scope_snapshot_ref: SCOPE_REF,
    allowed_source_revision_refs: [],
    allowed_evidence_handle_refs: [],
    allowed_tool_definition_refs: [],
    allowed_verifier_refs: [],
    permitted_anchor_and_precision_ceilings: [],
    provider_and_policy_generations: {
      "memory-os-client": "memory-os-credential-1",
      "eliot-research": "research-credential-1",
    },
    stale_or_revoked_entries: [],
    permitted_acquisition_or_expansion_routes: [],
    disclosure_ceiling: "private",
    allowed_use: [
      "federation.submit",
      "federation.status",
      "federation.cancel",
    ],
    expires_at: FUTURE,
    client_fence_ref: "client-fence-1",
    ...overrides,
  };
  return {
    ...payload,
    manifest_digest: await federationDigest(payload),
  };
}

function request(
  overrides: Partial<FederationRequest> = {},
): FederationRequest {
  return {
    protocol: "eliotr.federation.v1",
    exchange_id: "exchange-1",
    bridge_generation: "bridge-generation-1",
    idempotency_key: "idempotency-1",
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
    ...overrides,
  };
}

function manifestRow(value: AllowedReferenceManifest): Record<string, unknown> {
  return {
    manifest_id: value.manifest_ref.id,
    revision: value.manifest_ref.revision,
    manifest_json: federationCanonicalJson(value),
    manifest_digest: value.manifest_digest,
    scope_snapshot_id: value.scope_snapshot_ref.id,
    scope_snapshot_revision: value.scope_snapshot_ref.revision,
    client_fence_ref: value.client_fence_ref ?? null,
    expires_at: value.expires_at,
    created_at: CREATED,
  };
}

async function jobRow(input: {
  readonly value?: FederationRequest;
  readonly authorityBinding?: FederationAuthorityBinding;
  readonly cancellationReason?: string;
  readonly corruptDigest?: string;
} = {}): Promise<Record<string, unknown>> {
  const value = input.value ?? request();
  const authorityBinding = input.authorityBinding ?? binding();
  const requestDigest = await federationDigest(value);
  const jobId = await stableFederationJobId(
    authorityBinding,
    value,
    requestDigest,
  );
  const cancellationReason = input.cancellationReason;
  const receiptRef = cancellationReason === undefined
    ? undefined
    : await federationCancellationReceiptRef(jobId, cancellationReason);
  const status: FederationJobStatus = {
    exchange_id: value.exchange_id,
    idempotency_key: value.idempotency_key,
    job_id: jobId,
    attempt: 1,
    transport_state: cancellationReason === undefined ? "ACCEPTED" : "CANCELLED",
    completion_disposition: cancellationReason === undefined ? null : "CANCELLED",
    completed_obligation_refs: [],
    partial_bundle_refs: [],
    open_research_debt_refs: [],
    ...(receiptRef === undefined
      ? {}
      : {
          cancellation_receipt_ref: receiptRef,
          terminal_receipt_ref: receiptRef,
        }),
  };
  return {
    job_id: jobId,
    exchange_id: value.exchange_id,
    idempotency_key: value.idempotency_key,
    request_digest: input.corruptDigest ?? requestDigest,
    request_json: federationCanonicalJson(value),
    requester_principal_ref: authorityBinding.requester_principal_ref,
    requester_credential_generation:
      authorityBinding.requester_credential_generation,
    server_principal_ref: authorityBinding.server_principal_ref,
    server_credential_generation:
      authorityBinding.server_credential_generation,
    bridge_generation: authorityBinding.bridge_generation,
    client_fence_ref: authorityBinding.client_fence_ref,
    allowed_manifest_id: authorityBinding.allowed_reference_manifest_ref.id,
    allowed_manifest_revision:
      authorityBinding.allowed_reference_manifest_ref.revision,
    origin_trace_id: authorityBinding.trace_id,
    attempt: 1,
    transport_state: status.transport_state,
    status_json: federationCanonicalJson(status),
    observed_completion_disposition:
      cancellationReason === undefined ? null : "CANCELLED",
    result_json: null,
    cancellation_reason: cancellationReason ?? null,
    cancelled_at: cancellationReason === undefined ? null : CANCELLED,
    created_at: CREATED,
    updated_at: cancellationReason === undefined ? CREATED : CANCELLED,
  };
}

function runs(calls: readonly Call[]): readonly Call[] {
  return calls.filter((call) => call.method === "run");
}

async function expectCode(
  promise: Promise<unknown>,
  code: string,
): Promise<void> {
  await expect(promise).rejects.toMatchObject({ code });
}

describe("ER-41 D1 federation manifest authority", () => {
  it("creates immutable canonical bytes and returns exact replay", async () => {
    const value = await manifest();
    const created = database([null, manifestRow(value)]);
    await expect(createD1FederationManifestStore(
      created.db,
      () => NOW,
    ).put(value)).resolves.toMatchObject({
      disposition: "CREATED",
      manifest: value,
    });
    expect(runs(created.calls)).toHaveLength(1);
    expect(runs(created.calls)[0]?.values[2]).toBe(
      federationCanonicalJson(value),
    );

    const replay = database([manifestRow(value)]);
    await expect(createD1FederationManifestStore(
      replay.db,
      () => NOW,
    ).put(value)).resolves.toMatchObject({ disposition: "EXISTING" });
    expect(runs(replay.calls)).toHaveLength(0);
  });

  it("rejects revision reuse with different valid bytes", async () => {
    const current = await manifest();
    const replacement = await manifest({ disclosure_ceiling: "restricted" });
    await expectCode(createD1FederationManifestStore(
      database([manifestRow(current)]).db,
      () => NOW,
    ).put(replacement), "FEDERATION_D1_MANIFEST_CONFLICT");
  });

  it("reconciles a lost insert acknowledgement exactly once", async () => {
    const value = await manifest();
    const fixture = database(
      [null, manifestRow(value)],
      [new Error("lost manifest acknowledgement")],
    );
    await expect(createD1FederationManifestStore(
      fixture.db,
      () => NOW,
    ).put(value)).resolves.toMatchObject({ disposition: "EXISTING" });
    expect(runs(fixture.calls)).toHaveLength(1);
  });

  it("does not guess when manifest mutation readback is absent", async () => {
    const value = await manifest();
    const fixture = database(
      [null, null],
      [new Error("manifest write effect unknown")],
    );
    await expectCode(createD1FederationManifestStore(
      fixture.db,
      () => NOW,
    ).put(value), "FEDERATION_D1_SETTLEMENT_UNCERTAIN");
    expect(runs(fixture.calls)).toHaveLength(1);
  });
});

describe("ER-41 D1 federation job identity", () => {
  it("binds job identity to all authority generations, fence and manifest", async () => {
    const value = request();
    const digest = await federationDigest(value);
    const base = await stableFederationJobId(binding(), value, digest);
    const variants = [
      binding({ requester_credential_generation: "memory-os-credential-2" }),
      binding({ server_credential_generation: "research-credential-2" }),
      binding({ bridge_generation: "bridge-generation-2" }),
      binding({ client_fence_ref: "client-fence-2" }),
      binding({
        allowed_reference_manifest_ref: {
          id: MANIFEST_REF.id,
          revision: 2,
        },
      }),
    ];
    for (const variant of variants) {
      await expect(
        stableFederationJobId(variant, value, digest),
      ).resolves.not.toBe(base);
    }
    await expect(stableFederationJobId(
      binding({ trace_id: "retry-trace" }),
      value,
      digest,
    )).resolves.toBe(base);
  });

  it("creates one ACCEPTED job and replays the exact identity", async () => {
    const allowed = await manifest();
    const value = request();
    const requestDigest = await federationDigest(value);
    const stored = await jobRow({ value });
    const created = database([manifestRow(allowed), null, stored]);
    await expect(createD1FederationJobAuthority(
      created.db,
      () => NOW,
    ).reserve({
      binding: binding(),
      request: value,
      request_digest: requestDigest,
    })).resolves.toMatchObject({
      outcome: "CREATED",
      record: {
        status: {
          transport_state: "ACCEPTED",
          completion_disposition: null,
        },
      },
    });
    expect(runs(created.calls)).toHaveLength(1);

    const replay = database([manifestRow(allowed), stored]);
    await expect(createD1FederationJobAuthority(
      replay.db,
      () => NOW,
    ).reserve({
      binding: binding({ trace_id: "retry-trace" }),
      request: value,
      request_digest: requestDigest,
    })).resolves.toMatchObject({ outcome: "REPLAY" });
    expect(runs(replay.calls)).toHaveLength(0);
  });

  it("returns conflict for idempotency payload substitution", async () => {
    const allowed = await manifest();
    const occupied = request({ question: "A different question" });
    const expected = request();
    await expect(createD1FederationJobAuthority(
      database([
        manifestRow(allowed),
        await jobRow({ value: occupied }),
      ]).db,
      () => NOW,
    ).reserve({
      binding: binding(),
      request: expected,
      request_digest: await federationDigest(expected),
    })).resolves.toMatchObject({
      outcome: "CONFLICT",
      existing_request_digest: await federationDigest(occupied),
    });
  });

  it("denies a rotated peer generation before reserving work", async () => {
    const allowed = await manifest();
    const value = request();
    const fixture = database([manifestRow(allowed)]);
    await expectCode(createD1FederationJobAuthority(
      fixture.db,
      () => NOW,
    ).reserve({
      binding: binding({
        requester_credential_generation: "memory-os-credential-2",
      }),
      request: value,
      request_digest: await federationDigest(value),
    }), "FEDERATION_D1_BINDING_MISMATCH");
    expect(runs(fixture.calls)).toHaveLength(0);
  });

  it("reconciles a lost reservation acknowledgement without retry", async () => {
    const allowed = await manifest();
    const value = request();
    const fixture = database(
      [manifestRow(allowed), null, await jobRow({ value })],
      [new Error("lost reservation acknowledgement")],
    );
    await expect(createD1FederationJobAuthority(
      fixture.db,
      () => NOW,
    ).reserve({
      binding: binding(),
      request: value,
      request_digest: await federationDigest(value),
    })).resolves.toMatchObject({ outcome: "REPLAY" });
    expect(runs(fixture.calls)).toHaveLength(1);
  });

  it("never repeats an unresolved reservation mutation", async () => {
    const allowed = await manifest();
    const value = request();
    const fixture = database(
      [manifestRow(allowed), null, null],
      [new Error("reservation effect unknown")],
    );
    await expectCode(createD1FederationJobAuthority(
      fixture.db,
      () => NOW,
    ).reserve({
      binding: binding(),
      request: value,
      request_digest: await federationDigest(value),
    }), "FEDERATION_D1_SETTLEMENT_UNCERTAIN");
    expect(runs(fixture.calls)).toHaveLength(1);
  });
});

describe("ER-41 D1 federation row integrity", () => {
  it("binds reads to exact peer generations and rejects corrupt digests", async () => {
    await expectCode(createD1FederationJobAuthority(
      database([await jobRow()]).db,
    ).read(
      binding({ requester_credential_generation: "rotated-credential" }),
      "exchange-1",
      "idempotency-1",
    ), "FEDERATION_D1_BINDING_MISMATCH");

    await expectCode(createD1FederationJobAuthority(
      database([await jobRow({ corruptDigest: "f".repeat(64) })]).db,
    ).read(
      binding(),
      "exchange-1",
      "idempotency-1",
    ), "FEDERATION_D1_INPUT_INVALID");
  });

  it("bounds stored JSON before parsing it", async () => {
    const row = await jobRow();
    row.request_json = `"${"x".repeat(FEDERATION_REQUEST_JSON_MAX_BYTES)}"`;
    await expectCode(readFederationJob(
      database([row]).db,
      "exchange-1",
      "idempotency-1",
    ), "FEDERATION_D1_INPUT_INVALID");
  });

  it("rejects forged cancellation and active terminal receipts", async () => {
    const cancelled = await jobRow({
      cancellationReason: "operator requested cancellation",
    });
    const cancelledStatus = JSON.parse(
      String(cancelled.status_json),
    ) as FederationJobStatus;
    cancelled.status_json = federationCanonicalJson({
      ...cancelledStatus,
      cancellation_receipt_ref: "forged-cancellation-receipt",
      terminal_receipt_ref: "forged-cancellation-receipt",
    });
    await expectCode(readFederationJob(
      database([cancelled]).db,
      "exchange-1",
      "idempotency-1",
    ), "FEDERATION_D1_INPUT_INVALID");

    const active = await jobRow();
    const activeStatus = JSON.parse(
      String(active.status_json),
    ) as FederationJobStatus;
    active.status_json = federationCanonicalJson({
      ...activeStatus,
      terminal_receipt_ref: "forged-terminal-receipt",
    });
    await expectCode(readFederationJob(
      database([active]).db,
      "exchange-1",
      "idempotency-1",
    ), "FEDERATION_D1_INPUT_INVALID");
  });

  it("classifies pre-mutation read failure without claiming an effect", async () => {
    const value = request();
    const fixture = database([new Error("D1 unavailable")]);
    await expectCode(createD1FederationJobAuthority(
      fixture.db,
      () => NOW,
    ).reserve({
      binding: binding(),
      request: value,
      request_digest: await federationDigest(value),
    }), "FEDERATION_D1_READ_FAILED");
    expect(runs(fixture.calls)).toHaveLength(0);
  });

  it("turns unsupported clocks and bindings into typed failures", () => {
    expect(() => federationNow(() => Number.MAX_SAFE_INTEGER)).toThrowError();
    expect(() => createD1FederationJobAuthority({} as D1Database))
      .toThrowError();
  });
});

describe("ER-41 D1 federation cancellation", () => {
  it("cancels with exact CAS and reconciles a lost acknowledgement", async () => {
    const reason = "operator requested cancellation";
    const first = database([
      await jobRow(),
      await jobRow({ cancellationReason: reason }),
    ]);
    await expect(createD1FederationJobAuthority(
      first.db,
      () => Date.parse(CANCELLED),
    ).cancel(
      binding(),
      "exchange-1",
      "idempotency-1",
      reason,
    )).resolves.toMatchObject({
      status: {
        transport_state: "CANCELLED",
        completion_disposition: "CANCELLED",
      },
    });
    const update = runs(first.calls)[0];
    expect(update?.sql).toContain("status_json=?1");
    expect(update?.sql).toContain("updated_at=?7");

    const lost = database([
      await jobRow(),
      await jobRow({ cancellationReason: reason }),
    ], [new Error("lost cancellation acknowledgement")]);
    await expect(createD1FederationJobAuthority(
      lost.db,
      () => Date.parse(CANCELLED),
    ).cancel(
      binding(),
      "exchange-1",
      "idempotency-1",
      reason,
    )).resolves.toMatchObject({
      status: { transport_state: "CANCELLED" },
    });
    expect(runs(lost.calls)).toHaveLength(1);
  });

  it("replays only the same cancellation reason", async () => {
    const prior = await jobRow({ cancellationReason: "first reason" });
    const replay = database([prior]);
    await expect(createD1FederationJobAuthority(replay.db).cancel(
      binding(),
      "exchange-1",
      "idempotency-1",
      "first reason",
    )).resolves.toMatchObject({
      status: { transport_state: "CANCELLED" },
    });
    expect(runs(replay.calls)).toHaveLength(0);

    const conflict = database([prior]);
    await expectCode(createD1FederationJobAuthority(conflict.db).cancel(
      binding(),
      "exchange-1",
      "idempotency-1",
      "second reason",
    ), "FEDERATION_D1_STATE_CONFLICT");
    expect(runs(conflict.calls)).toHaveLength(0);
  });

  it("rejects clock regression before issuing cancellation CAS", async () => {
    const fixture = database([await jobRow()]);
    await expectCode(createD1FederationJobAuthority(
      fixture.db,
      () => NOW - 1,
    ).cancel(
      binding(),
      "exchange-1",
      "idempotency-1",
      "operator requested cancellation",
    ), "FEDERATION_D1_INPUT_INVALID");
    expect(runs(fixture.calls)).toHaveLength(0);
  });
});
