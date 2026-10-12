import { beforeAll, describe, expect, it } from "vitest";
import { createD1ResearchModelPricingSnapshotStore } from "@eliotr/cloudflare-model-control";
import type { ModelRouteDeployment } from "@eliotr/platform-cloudflare";
import {
  createD1ResearchModelAttemptRevalidator,
  type SpendAuthorizationReadRequest,
  type SpendAuthorizationReadback,
} from "../../../packages/cloudflare-research/src/research-model-attempt-revalidator.js";
import {
  createGovernedModelAttemptHandler,
  deriveModelAttemptIdentity,
  type ModelAttemptPreparationContext,
} from "../../../packages/cloudflare-research/src/model-attempt-handler.js";
import type { ModelAttemptReservation, ModelAttemptReservationInput } from "../../../packages/cloudflare-research/src/model-attempt-types.js";
import { digest } from "@eliotr/cloudflare-workflows";
import {
  governedModelAttemptFixture,
  initializeModelAttemptRuntime,
  runtime,
} from "./model-attempt-fixture.js";
import { WorkflowCheckpointStore } from "@eliotr/cloudflare-workflows";
import { principal as workflowPrincipal, workflowFixture } from "./research-workflow-fixture.js";

const SUPPORTED_ROUTE = "dynamic/eliotr-report-section" as const;
const CURRENTNESS_DIGEST = "a".repeat(64);
const DECISION_DIGEST = "b".repeat(64);

interface RevalidatorCase {
  readonly tag: string;
  readonly fixture: Awaited<ReturnType<typeof governedModelAttemptFixture>>;
  readonly context: ModelAttemptPreparationContext;
  readonly prepared: ModelAttemptReservationInput;
  readonly reservation: ModelAttemptReservation;
  readonly deployment: ModelRouteDeployment;
  readonly read: (request: SpendAuthorizationReadRequest) => Promise<SpendAuthorizationReadback | null>;
  readonly routeAuthority: { resolve(routeRef: string): Promise<unknown | null> };
}

beforeAll(initializeModelAttemptRuntime);

async function countModelRows(idempotencyKey: string): Promise<number> {
  const row = await runtime.CORE_DB.prepare(
    "SELECT COUNT(*) AS count FROM research_model_attempt WHERE idempotency_key = ?1",
  ).bind(idempotencyKey).first<{ readonly count: number }>();
  return Number(row?.count ?? 0);
}

async function revalidatorCase(tag: string, pricingOptions: {
  readonly kind?: "missing" | "expired" | "future" | "wrong-route";
  readonly expires_at?: string;
  readonly begin?: boolean;
} = {}): Promise<RevalidatorCase> {
  const workflow = await workflowFixture(`revalidator-${tag}`);
  const workflowStore = new WorkflowCheckpointStore(workflow.db);
  const stageRequestSha256 = await digest(new TextEncoder().encode(JSON.stringify(workflow.request)));
  await workflowStore.ensureRun(workflow.request, workflowPrincipal);
  await workflowStore.reserve(workflow.request, stageRequestSha256, crypto.randomUUID(), workflow.budget);
  const fixture = await governedModelAttemptFixture(`revalidator-${tag}`, {
    database: workflow.db,
    bucket: workflow.bucket,
    request: workflow.request,
    principal: workflowPrincipal,
    inputBytes: workflow.bytes,
  });
  const invocation = fixture.invocation("FREEZE_PROTOCOL_AND_SCOPE", fixture.stageAttemptRef);
  const identity = await deriveModelAttemptIdentity({
    stage_request_sha256: stageRequestSha256,
    principal_ref: invocation.principal.principal_ref,
    credential_generation: invocation.principal.credential_generation,
    deployment_generation: invocation.principal.deployment_generation,
  });
  const modelOutputObjectRef = `model-output/${identity.idempotency_key.slice("model-idempotency-".length)}/${fixture.stageAttemptRef}`;
  const context: ModelAttemptPreparationContext = Object.freeze({
    request: invocation.request,
    principal: invocation.principal,
    input_bytes: new Uint8Array(invocation.input_bytes),
    attempt_ref: fixture.stageAttemptRef,
    budget_receipt_ref: invocation.budget_receipt_ref,
    model_output_object_ref: modelOutputObjectRef,
    stage_request_sha256: stageRequestSha256,
    model_operation_id: identity.operation_id,
    model_idempotency_key: identity.idempotency_key,
  });
  const original = await fixture.dependencies.prepare(context);
  const prepared: ModelAttemptReservationInput = Object.freeze({
    ...original,
    authority: Object.freeze({
      ...original.authority,
      policy_generation: "workflow-policy",
      currentness_digest: CURRENTNESS_DIGEST,
    }),
    call: Object.freeze({ ...original.call, route_ref: SUPPORTED_ROUTE }),
    quote: Object.freeze({ ...original.quote, selected_routes: [SUPPORTED_ROUTE] }),
  });
  const reservation = await fixture.dependencies.attempts.reserve(prepared);
  if (pricingOptions.begin !== false) {
    const started = await fixture.dependencies.attempts.beginAttempt(reservation);
    if (started.state !== "STARTED" || started.attempt === null) {
      throw new Error("revalidator fixture did not create a real STARTED W3 attempt");
    }
  }

  const deployment: ModelRouteDeployment = Object.freeze({
    route_ref: SUPPORTED_ROUTE,
    route_version: `${tag}-route-v1`,
    prompt_generation: original.call.prompt_generation,
    schema_generation: original.call.schema_generation,
    parameters_digest: "c".repeat(64),
    pricing_snapshot_ref: `${tag}-pricing`,
  });
  if (pricingOptions.kind !== "missing") {
    const identity = {
      pricing_snapshot_ref: deployment.pricing_snapshot_ref,
      route_ref: deployment.route_ref,
      route_version: pricingOptions.kind === "wrong-route" ? tag + "-different-route" : deployment.route_version,
      provider: "controlled-provider",
      exact_model_id: "controlled-model",
    };
    await createD1ResearchModelPricingSnapshotStore(runtime.CORE_DB, {
      now: () => "2026-09-10T11:59:00.000Z",
    }).putImmutable({ identity, snapshot: {
      protocol: "eliotr.research-model-pricing.v1", ...identity,
      pricing_basis: "EXACT_TOKEN_RATES_V1",
      input_rate_usd_per_1k_tokens: "0", output_rate_usd_per_1k_tokens: "0",
      effective_at: pricingOptions.kind === "future" ? "2026-09-10T12:01:00.000Z" : "2026-09-10T11:59:00.000Z",
      expires_at: pricingOptions.expires_at ?? (pricingOptions.kind === "expired"
        ? "2026-09-10T12:00:00.000Z" : "2026-09-10T13:00:00.000Z"),
      provenance_ref: tag + "-pricing-provenance", approval_receipt_ref: tag + "-pricing-approval",
    } });
  }
  const read = async (request: SpendAuthorizationReadRequest): Promise<SpendAuthorizationReadback> => ({
    authorization_ref: `${tag}-spend-authorization`,
    decision_digest: DECISION_DIGEST,
    operation_id: request.operation_id,
    principal_ref: request.principal_ref,
    stage_attempt_ref: request.stage_attempt_ref,
    stage_request_sha256: request.stage_request_sha256,
    reservation_id: request.reservation_id,
    quote_ref: request.quote_ref,
    route_ref: request.route_ref,
    scope_snapshot_ref: request.scope_snapshot_ref,
    workflow_authorization_receipt_ref: request.workflow_authorization_receipt_ref,
    policy_generation: prepared.authority.policy_generation,
    currentness_digest: CURRENTNESS_DIGEST,
    expires_at: "2026-09-10T12:30:00.000Z",
    expected_deployment: deployment,
  });
  const routeAuthority = { resolve: async (_routeRef: string): Promise<unknown> => deployment };
  return { tag, fixture, context, prepared, reservation, deployment, read, routeAuthority };
}

function makeRevalidator(value: RevalidatorCase, overrides: {
  readonly now?: () => number;
  readonly read?: (request: SpendAuthorizationReadRequest) => Promise<SpendAuthorizationReadback | null>;
  readonly resolve?: (routeRef: string) => Promise<unknown | null>;
} = {}) {
  return createD1ResearchModelAttemptRevalidator({
    database: runtime.CORE_DB,
    spendAuthorization: { read: overrides.read ?? value.read },
    routeAuthority: { resolve: overrides.resolve ?? value.routeAuthority.resolve },
    now: overrides.now ?? (() => Date.parse("2026-09-10T12:00:00.000Z")),
  });
}

async function assertNoNewAttempt(value: RevalidatorCase, invoke: () => Promise<unknown>): Promise<void> {
  const before = await countModelRows(value.prepared.idempotency_key);
  try {
    await invoke();
  } finally {
    expect(await countModelRows(value.prepared.idempotency_key)).toBe(before);
  }
}

async function revokeGrant(value: RevalidatorCase): Promise<void> {
  const scope = value.prepared.authority.scope_snapshot_ref;
  const identity = [scope.id, scope.revision, value.fixture.principal.principal_ref, "owner_pwa", value.fixture.principal.credential_generation] as const;
  const active = await runtime.CORE_DB.prepare(
    "SELECT COUNT(*) AS count FROM scope_access_grant WHERE snapshot_id = ?1 AND snapshot_revision = ?2 AND principal_ref = ?3 AND client_class = ?4 AND credential_generation = ?5 AND state = 'ACTIVE'",
  ).bind(...identity).first<{ readonly count: number }>();
  expect(active?.count).toBe(1);
  await runtime.CORE_DB.prepare(
    "UPDATE scope_access_grant SET state = 'REVOKED' WHERE snapshot_id = ?1 AND snapshot_revision = ?2 AND principal_ref = ?3 AND client_class = ?4 AND credential_generation = ?5 AND state = 'ACTIVE'",
  ).bind(...identity).run();
  const changes = await runtime.CORE_DB.prepare("SELECT changes() AS count").bind().first<{ readonly count: number }>();
  expect(changes?.count).toBe(1);
  const row = await runtime.CORE_DB.prepare(
    "SELECT state FROM scope_access_grant WHERE snapshot_id = ?1 AND snapshot_revision = ?2 AND principal_ref = ?3 AND client_class = ?4 AND credential_generation = ?5",
  ).bind(...identity)
    .first<{ readonly state: string }>();
  expect(row).toEqual({ state: "REVOKED" });
}

describe("research model attempt revalidation over actual D1", () => {
  it("durably cancels expired pricing before dispatch instead of retaining an uncertain model attempt", async () => {
    const value = await revalidatorCase("pricing-durable-preeffect", { kind: "expired", begin: false });
    const handler = createGovernedModelAttemptHandler({
      ...value.fixture.dependencies,
      prepare: async () => value.prepared,
      revalidate: async (context, prepared) => { await makeRevalidator(value)(context, prepared); },
    });
    await expect(handler.handler(value.fixture.invocation("FREEZE_PROTOCOL_AND_SCOPE", value.fixture.stageAttemptRef)))
      .rejects.toMatchObject({ code: "WORKFLOW_AUTHORITY_STALE" });
    const row = await runtime.CORE_DB.prepare(
      "SELECT state,error_code,receipt_json,output_sha256,ended_at FROM research_model_attempt WHERE idempotency_key=?1",
    ).bind(value.prepared.idempotency_key).first<{
      readonly state: string; readonly error_code: string; readonly receipt_json: string | null;
      readonly output_sha256: string | null; readonly ended_at: string | null;
    }>();
    expect(row).toMatchObject({ state: "CANCELLED", error_code: "WORKFLOW_AUTHORITY_STALE", receipt_json: null, output_sha256: null });
    expect(row?.ended_at).not.toBeNull();
    expect(await countModelRows(value.prepared.idempotency_key)).toBe(1);
    expect(value.fixture.calls()).toBe(0);
  });
  it.each(["missing", "expired", "future", "wrong-route"] as const)(
    "rejects %s approved pricing before a provider call",
    async (kind) => {
      const value = await revalidatorCase("pricing-" + kind, { kind });
      await expect(assertNoNewAttempt(value, () => makeRevalidator(value)(value.context, value.prepared)))
        .rejects.toMatchObject({ code: "MODEL_ATTEMPT_AUTHORITY_STALE" });
      expect(value.fixture.calls()).toBe(0);
    },
  );

  it("rejects current pricing expiring inside the existing admitted effect window", async () => {
    const value = await revalidatorCase("pricing-short-window", { expires_at: "2026-09-10T12:00:00.001Z" });
    await expect(assertNoNewAttempt(value, () => makeRevalidator(value)(value.context, value.prepared)))
      .rejects.toMatchObject({ code: "MODEL_ATTEMPT_AUTHORITY_STALE" });
    expect(value.fixture.calls()).toBe(0);
  });

  it("rejects pricing expiry crossed during final authority readback", async () => {
    const expiry = "2026-09-10T13:00:00.000Z";
    const value = await revalidatorCase("pricing-crosses-final-read", { expires_at: expiry });
    let clockReads = 0;
    const now = () => {
      clockReads += 1;
      return Date.parse(clockReads >= 4 ? expiry : "2026-09-10T12:00:00.000Z");
    };
    await expect(assertNoNewAttempt(value, () => makeRevalidator(value, { now })(value.context, value.prepared)))
      .rejects.toMatchObject({ code: "MODEL_ATTEMPT_AUTHORITY_STALE" });
    expect(clockReads).toBeGreaterThanOrEqual(4);
    expect(value.fixture.calls()).toBe(0);
  });
  it("accepts a real STARTED W2-bound attempt with opaque trusted currentness", async () => {
    const value = await revalidatorCase("positive");
    let resolves = 0;
    await makeRevalidator(value, {
      resolve: async () => {
        resolves += 1;
        return value.deployment;
      },
    })(value.context, value.prepared);
    expect(resolves).toBe(1);
    expect(await countModelRows(value.prepared.idempotency_key)).toBe(1);
    expect(value.fixture.calls()).toBe(0);
  });

  it.each([
    ["revoked grant", async (value: RevalidatorCase) => {
      await revokeGrant(value);
    }],
    ["retired policy", async (_value: RevalidatorCase) => {
      await runtime.CORE_DB.prepare(
        "UPDATE investigation_current_policy SET state = 'RETIRED' WHERE policy_generation = 'workflow-policy'",
      ).run();
    }],
    ["retired deployment", async (_value: RevalidatorCase) => {
      await runtime.CORE_DB.prepare(
        "UPDATE investigation_current_deployment SET state = 'RETIRED' WHERE deployment_generation = 'workflow-deployment'",
      ).run();
    }],
  ] as const)("rejects %s without a new attempt or route call", async (label, mutate) => {
    const value = await revalidatorCase(`negative-${label.replaceAll(" ", "-")}`);
    await mutate(value);
    const revalidate = makeRevalidator(value);
    await expect(assertNoNewAttempt(value, () => revalidate(value.context, value.prepared))).rejects.toMatchObject({
      code: "MODEL_ATTEMPT_AUTHORITY_STALE",
    });
    expect(value.fixture.calls()).toBe(0);
  });

  it("rejects a changed active route deployment without a route call", async () => {
    const value = await revalidatorCase("route-change");
    const changed = { ...value.deployment, route_version: "route-version-rotated" };
    const revalidate = makeRevalidator(value, { resolve: async () => changed });
    await expect(assertNoNewAttempt(value, () => revalidate(value.context, value.prepared))).rejects.toMatchObject({
      code: "MODEL_ATTEMPT_AUTHORITY_STALE",
    });
    expect(value.fixture.calls()).toBe(0);
  });

  it("rejects an expired W2 budget with the typed budget stop and no route call", async () => {
    const value = await revalidatorCase("budget-expired");
    const row = await runtime.CORE_DB.prepare(
      "SELECT budget_expires_at_ms FROM research_workflow_attempt WHERE attempt_ref = ?1",
    ).bind(value.fixture.stageAttemptRef).first<{ readonly budget_expires_at_ms: number }>();
    if (row === null) throw new Error("revalidator fixture is missing its persisted W2 budget");
    const revalidate = makeRevalidator(value, { now: () => Number(row.budget_expires_at_ms) + 1 });
    await expect(assertNoNewAttempt(value, () => revalidate(value.context, value.prepared))).rejects.toMatchObject({
      code: "MODEL_ATTEMPT_BUDGET_EXPIRED",
    });
    expect(value.fixture.calls()).toBe(0);
  });

  it("rejects missing and mismatched trusted spend authorization", async () => {
    const missing = await revalidatorCase("missing-spend");
    await expect(assertNoNewAttempt(missing, () => makeRevalidator(missing, {
      read: async () => null,
    })(missing.context, missing.prepared))).rejects.toMatchObject({ code: "MODEL_ATTEMPT_AUTHORITY_STALE" });

    const mismatched = await revalidatorCase("mismatched-spend");
    await expect(assertNoNewAttempt(mismatched, () => makeRevalidator(mismatched, {
      read: async (request) => {
        const authorization = await mismatched.read(request);
        if (authorization === null) throw new Error("controlled trusted authorization unexpectedly missing");
        return { ...authorization, reservation_id: "foreign-reservation" };
      },
    })(mismatched.context, mismatched.prepared))).rejects.toMatchObject({ code: "MODEL_ATTEMPT_AUTHORITY_STALE" });
    expect(missing.fixture.calls()).toBe(0);
    expect(mismatched.fixture.calls()).toBe(0);
  });

  it("rejects prepared request limits changed from the durable model request", async () => {
    const value = await revalidatorCase("prepared-request-change");
    const changed = Object.freeze({
      ...value.prepared,
      call: Object.freeze({ ...value.prepared.call, max_input_bytes: value.prepared.call.max_input_bytes + 1 }),
    });
    await expect(assertNoNewAttempt(value, () => makeRevalidator(value)(value.context, changed))).rejects.toMatchObject({
      code: "MODEL_ATTEMPT_AUTHORITY_STALE",
    });
    expect(value.fixture.calls()).toBe(0);
  });

  it("catches grant revocation performed while the trusted spend reader is awaited", async () => {
    const value = await revalidatorCase("grant-revoked-during-spend-read");
    let revoked = false;
    const read = async (request: SpendAuthorizationReadRequest) => {
      await revokeGrant(value);
      revoked = true;
      return value.read(request);
    };
    await expect(assertNoNewAttempt(value, () => makeRevalidator(value, { read })(value.context, value.prepared))).rejects.toMatchObject({
      code: "MODEL_ATTEMPT_AUTHORITY_STALE",
    });
    expect(revoked).toBe(true);
    expect(value.fixture.calls()).toBe(0);
  });

  it("catches grant revocation performed by the final route authority read", async () => {
    const value = await revalidatorCase("grant-revoked-during-final-route-read");
    let resolves = 0;
    const resolve = async () => {
      resolves += 1;
      if (resolves === 1) {
        await revokeGrant(value);
      }
      return value.deployment;
    };
    await expect(assertNoNewAttempt(value, () => makeRevalidator(value, { resolve })(value.context, value.prepared))).rejects.toMatchObject({
      code: "MODEL_ATTEMPT_AUTHORITY_STALE",
    });
    expect(resolves).toBe(1);
    expect(value.fixture.calls()).toBe(0);
  });

  it("catches budget expiry crossed during the final route authority read", async () => {
    const value = await revalidatorCase("budget-expires-during-final-route-read");
    const row = await runtime.CORE_DB.prepare(
      "SELECT budget_expires_at_ms FROM research_workflow_attempt WHERE attempt_ref = ?1",
    ).bind(value.fixture.stageAttemptRef).first<{ readonly budget_expires_at_ms: number }>();
    if (row === null) throw new Error("revalidator fixture is missing its persisted W2 budget");
    let resolves = 0;
    let clockMs = Date.parse("2026-09-10T12:00:00.000Z");
    const resolve = async () => {
      resolves += 1;
      if (resolves === 1) clockMs = Number(row.budget_expires_at_ms) + 1;
      return value.deployment;
    };
    await expect(assertNoNewAttempt(value, () => makeRevalidator(value, {
      now: () => clockMs,
      resolve,
    })(value.context, value.prepared))).rejects.toMatchObject({ code: "MODEL_ATTEMPT_BUDGET_EXPIRED" });
    expect(resolves).toBe(1);
    expect(value.fixture.calls()).toBe(0);
  });
});
