/// <reference types="node" />
import { describe, expect, it } from "vitest";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  dynamicRouteJsonArtifact,
  type DynamicRouteCandidate,
  type DynamicRouteQualificationEvidence,
  type DynamicRouteQualificationProbeInput,
} from "@eliotr/cloudflare-ai";
import type { ApplicationModelRoute } from "@eliotr/platform-cloudflare";
import { createD1DynamicRouteRegistry } from "./model-gateway-deployment-registry-d1.js";
import { createD1ResearchModelQualificationObservationStore } from "./research-model-qualification-store.js";
import {
  createResearchModelQualificationRenewal,
  type ResearchModelQualificationRenewalInput,
} from "./research-model-qualification-renewal.js";

// Cross-operation single-flight for lazy model-proof renewal, tested against a
// real SQLite database (node:sqlite) with the real D1 migrations and the real
// candidate registry, observation store, and proof store. Only the provider
// call is stubbed, through the renewal port's `qualify` seam: the stub returns
// evidence bound to a real seeded observation, with a fresh
// control_plane_readback_ref per call, exactly like the native qualify would.

const NOW = "2026-10-01T12:00:00.000Z";
const VERIFIED_AT = "2026-10-01T11:00:00.000Z";
const EXPIRES_AT = "2026-10-01T13:00:00.000Z";
const DIGEST = "a".repeat(64);
const INPUT_DIGEST = "b".repeat(64);
const OBSERVATION_PROTOCOL = "eliotr.dynamic-route-qualification-observation.v1";
const ROUTE_A: ApplicationModelRoute = "dynamic/eliotr-balanced";
const ROUTE_B: ApplicationModelRoute = "dynamic/eliotr-economy";

const MIGRATIONS_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "..", "..", "..",
  "infra", "d1", "core", "migrations",
);

function testDatabase(): D1Database {
  const db = new DatabaseSync(":memory:");
  for (const name of [
    "0035_model_route_registry.sql",
    "0054_model_route_qualification.sql",
    "0056_model_route_qualification_renewal.sql",
  ]) {
    db.exec(readFileSync(join(MIGRATIONS_DIR, name), "utf8"));
  }
  const database = {
    prepare(sql: string) {
      const statement = db.prepare(sql);
      return {
        bind(...args: unknown[]) {
          const params = args as SQLInputValue[];
          return {
            async first<T>(): Promise<T | null> {
              const row = statement.get(...params) as T | undefined;
              return row === undefined ? null : row;
            },
            async all<T>(): Promise<{ results: T[] }> {
              return { results: statement.all(...params) as T[] };
            },
            async run(): Promise<{ success: boolean; meta: { changes: number } }> {
              const info = statement.run(...params);
              return { success: true, meta: { changes: Number(info.changes) } };
            },
          };
        },
      };
    },
  };
  return database as unknown as D1Database;
}

interface FixtureCandidate {
  readonly value: DynamicRouteCandidate;
  readonly candidateRef: string;
  readonly candidateSha256: string;
  readonly originalProbeKey: string;
}

function candidateValue(routeRef: ApplicationModelRoute, version: string, executionProbeRef: string): DynamicRouteCandidate {
  return {
    schema: "eliotr.dynamic-route-candidate.v1",
    deployment: {
      route_ref: routeRef,
      route_version: version,
      prompt_generation: "prompt-v1",
      schema_generation: "schema-v1",
      parameters_digest: DIGEST,
      pricing_snapshot_ref: "pricing-v1",
    },
    provider_route_id: `provider-route-${version}`,
    provider_route_name: `balanced-${version}`,
    route_definition_sha256: DIGEST,
    provider_snapshot_sha256: DIGEST,
    control_plane_receipt_ref: `control-plane-${version}`,
    qualification_tier: "LIVE",
    control_plane_readback_ref: `control-readback-${version}`,
    execution_probe_ref: executionProbeRef,
    qualification_expires_at: EXPIRES_AT,
  };
}

async function seedObservation(
  database: D1Database,
  probeKey: string,
  routeRef: ApplicationModelRoute,
  version: string,
): Promise<string> {
  const store = createD1ResearchModelQualificationObservationStore(database, () => NOW);
  const claimRef = `claim-${probeKey}`;
  await store.claim({ probe_idempotency_key: probeKey, probe_input_sha256: INPUT_DIGEST, claim_ref: claimRef });
  const raw = await store.putImmutable(
    {
      protocol: OBSERVATION_PROTOCOL,
      probe_idempotency_key: probeKey,
      probe_input_sha256: INPUT_DIGEST,
      route_fingerprint: {
        route_ref: routeRef,
        route_version: version,
        prompt_generation: "prompt-v1",
        schema_generation: "schema-v1",
        parameters_digest: DIGEST,
        pricing_snapshot_ref: "pricing-v1",
        provider: "compat",
        exact_model_id: "model-1",
      },
      route_fingerprint_ref: `fingerprint-${probeKey}`,
      gateway_log_id: `gateway-log-${probeKey}`,
      request_body_sha256: DIGEST,
      request_parameters_sha256: DIGEST,
      response_body_sha256: DIGEST,
      response_model: "model-1",
      verified_at: VERIFIED_AT,
      expires_at: EXPIRES_AT,
    },
    claimRef,
  );
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error("invalid observation receipt");
  }
  const receipt = raw as { execution_probe_ref?: unknown };
  if (typeof receipt.execution_probe_ref !== "string") throw new Error("invalid observation receipt");
  return receipt.execution_probe_ref;
}

async function seedCandidate(
  database: D1Database,
  routeRef: ApplicationModelRoute,
  version: string,
  originalProbeKey: string,
): Promise<FixtureCandidate> {
  const registry = createD1DynamicRouteRegistry(database, { now: () => NOW, environment: "TEST" });
  const executionProbeRef = await seedObservation(database, originalProbeKey, routeRef, version);
  const value = candidateValue(routeRef, version, executionProbeRef);
  const artifact = await dynamicRouteJsonArtifact(value);
  const stagedRaw = await registry.stageCandidate(value, artifact.sha256);
  if (typeof stagedRaw !== "object" || stagedRaw === null || Array.isArray(stagedRaw)) {
    throw new Error("invalid candidate stage receipt");
  }
  const staged = stagedRaw as { candidate_ref?: unknown; readback_sha256?: unknown };
  if (typeof staged.candidate_ref !== "string" || typeof staged.readback_sha256 !== "string") {
    throw new Error("invalid candidate stage receipt");
  }
  await registry.promote({
    route_ref: routeRef,
    expected_active_route_version: null,
    target_route_version: version,
    candidate_ref: staged.candidate_ref,
    candidate_sha256: staged.readback_sha256,
  });
  return { value, candidateRef: staged.candidate_ref, candidateSha256: staged.readback_sha256, originalProbeKey };
}

function probeInput(candidate: FixtureCandidate, probeKey: string): ResearchModelQualificationRenewalInput["fresh"] {
  const value = candidate.value;
  const deployment = value.deployment;
  return {
    provisioning: {
      disposition: "EXISTING_MATCH",
      deployment: { ...deployment },
      provider_route_id: value.provider_route_id,
      provider_route_name: value.provider_route_name,
      route_definition_sha256: value.route_definition_sha256,
      provider_snapshot_sha256: value.provider_snapshot_sha256,
      control_plane_receipt_ref: value.control_plane_receipt_ref,
    },
    route_definition: { probe: probeKey },
    route_definition_sha256: value.route_definition_sha256,
    model_call: {
      route_ref: deployment.route_ref,
      prompt_generation: deployment.prompt_generation,
      schema_generation: deployment.schema_generation,
      budget_reservation_ref: "budget-reservation-1",
      output_object_ref: `model-qualification-output-${"c".repeat(64)}`,
      max_input_bytes: 1024,
      max_output_bytes: 1024,
      evidence_pack: {
        pack_ref: { id: "pack-1", revision: 1 },
        scope_snapshot_ref: { id: "scope-1", revision: 1 },
        trace_ref: { id: "trace-1", revision: 1 },
        total_utf8_bytes: 0,
        resolved_evidence: [],
      },
    },
    expected_provider: "compat",
    expected_model: "model-1",
    probe_idempotency_key: probeKey,
    verified_at: VERIFIED_AT,
    expires_at: EXPIRES_AT,
  } as unknown as ResearchModelQualificationRenewalInput["fresh"];
}

function renewalInput(candidate: FixtureCandidate, probeKey: string): ResearchModelQualificationRenewalInput {
  return {
    candidate_ref: candidate.candidateRef,
    candidate_sha256: candidate.candidateSha256,
    fresh: probeInput(candidate, probeKey),
    expected_latest: null,
  };
}

/**
 * Stubs the provider call. Returns evidence bound to the real seeded
 * observation for the probe's route, with a fresh control_plane_readback_ref
 * per call — so a second real execution would mint a different proof, exactly
 * like the native qualify. Routes by deployment so one stub serves several
 * candidate identities.
 */
function stubQualify(executionProbeRefByRoute: Record<string, string>) {
  let calls = 0;
  const qualify = async (fresh: DynamicRouteQualificationProbeInput): Promise<DynamicRouteQualificationEvidence> => {
    calls += 1;
    const deployment = fresh.provisioning.deployment;
    const provisioning = fresh.provisioning;
    const executionProbeRef = executionProbeRefByRoute[deployment.route_ref];
    if (executionProbeRef === undefined) throw new Error(`no seeded observation for route ${deployment.route_ref}`);
    return {
      tier: "LIVE",
      gateway_id: "eliotr-reasoning",
      route_ref: deployment.route_ref,
      route_version: deployment.route_version,
      prompt_generation: deployment.prompt_generation,
      schema_generation: deployment.schema_generation,
      parameters_digest: deployment.parameters_digest,
      pricing_snapshot_ref: deployment.pricing_snapshot_ref,
      provider_route_id: provisioning.provider_route_id,
      provider_route_name: provisioning.provider_route_name,
      route_definition_sha256: provisioning.route_definition_sha256,
      provider_snapshot_sha256: provisioning.provider_snapshot_sha256,
      control_plane_readback_ref: `control-readback-renewal-${calls}`,
      execution_probe_ref: executionProbeRef,
      verified_at: VERIFIED_AT,
      expires_at: EXPIRES_AT,
    };
  };
  return { qualify, calls: () => calls };
}

function renewalPort(database: D1Database, qualify: (fresh: DynamicRouteQualificationProbeInput) => Promise<DynamicRouteQualificationEvidence>) {
  return createResearchModelQualificationRenewal({
    database,
    work_bucket: { put: async () => ({}) } as unknown as R2Bucket,
    gateway: { reasoning_gateway_base_url: "https://example.test", gateway_token: "token" },
    control_plane: { get: async () => { throw new Error("control plane is stubbed out"); } },
    prompt_compiler: { compile: async () => { throw new Error("prompt compiler is stubbed out"); } },
    now: () => NOW,
    qualify,
  });
}

describe("research model qualification renewal single-flight", () => {
  it("coalesces concurrent same-identity renewals to one proof", async () => {
    const database = testDatabase();
    const candidate = await seedCandidate(database, ROUTE_A, "v1", "original-probe-key-a1");
    const renewalObsRef = await seedObservation(database, "renewal-key-a1", ROUTE_A, "v1");
    const stub = stubQualify({ [ROUTE_A]: renewalObsRef });

    // The leader blocks inside qualify until the follower has joined the
    // flight; without coalescing, the follower would run qualify itself.
    let releaseLeader!: () => void;
    const gate = new Promise<void>((resolve) => { releaseLeader = resolve; });
    let calls = 0;
    const gatedQualify = async (fresh: DynamicRouteQualificationProbeInput) => {
      calls += 1;
      if (calls === 1) await gate;
      return stub.qualify(fresh);
    };
    const gatedPort = renewalPort(database, gatedQualify);

    const first = gatedPort.renew(renewalInput(candidate, "renewal-key-a1"));
    const second = gatedPort.renew(renewalInput(candidate, "renewal-key-a2"));
    await new Promise((resolve) => setTimeout(resolve, 50));
    releaseLeader();
    const [firstResult, secondResult] = await Promise.all([first, second]);

    expect(calls).toBe(1);
    expect(secondResult.qualification_ref).toBe(firstResult.qualification_ref);
    expect(secondResult.qualification_sha256).toBe(firstResult.qualification_sha256);
    expect(secondResult.latest.qualification_ref).toBe(firstResult.latest.qualification_ref);
  });

  it("returns the existing proof on same-key replay instead of conflicting", async () => {
    const database = testDatabase();
    const candidate = await seedCandidate(database, ROUTE_A, "v1", "original-probe-key-a2");
    const renewalObsRef = await seedObservation(database, "renewal-key-b1", ROUTE_A, "v1");
    const stub = stubQualify({ [ROUTE_A]: renewalObsRef });
    const port = renewalPort(database, stub.qualify);

    const input = renewalInput(candidate, "renewal-key-b1");
    const first = await port.renew(input);
    expect(first.latest.qualification_ref).toBe(first.qualification_ref);
    expect(stub.calls()).toBe(1);

    const replayed = await port.renew(input);
    // The replay fast-path must kick in: a second real execution would mint a
    // different proof (fresh control_plane_readback_ref), so equal refs prove
    // qualify was not called again.
    expect(stub.calls()).toBe(1);
    expect(replayed.qualification_ref).toBe(first.qualification_ref);
    expect(replayed.qualification_sha256).toBe(first.qualification_sha256);
    expect(replayed.qualification.control_plane_readback_ref).toBe(first.qualification.control_plane_readback_ref);
    expect(replayed.latest.qualification_ref).toBe(first.latest.qualification_ref);
  });

  it("renews different identities separately", async () => {
    const database = testDatabase();
    const candidateA = await seedCandidate(database, ROUTE_A, "v1", "original-probe-key-a3");
    const candidateB = await seedCandidate(database, ROUTE_B, "v1", "original-probe-key-b3");
    const obsRefA = await seedObservation(database, "renewal-key-a3", ROUTE_A, "v1");
    const obsRefB = await seedObservation(database, "renewal-key-b3", ROUTE_B, "v1");
    const stub = stubQualify({ [ROUTE_A]: obsRefA, [ROUTE_B]: obsRefB });
    const port = renewalPort(database, stub.qualify);

    const [resultA, resultB] = await Promise.all([
      port.renew(renewalInput(candidateA, "renewal-key-a3")),
      port.renew(renewalInput(candidateB, "renewal-key-b3")),
    ]);

    expect(stub.calls()).toBe(2);
    expect(resultA.qualification_ref).not.toBe(resultB.qualification_ref);
    expect(resultA.latest.route_ref).toBe(ROUTE_A);
    expect(resultB.latest.route_ref).toBe(ROUTE_B);
  });

  it("fails closed when a replayed key does not match a completed renewal", async () => {
    const database = testDatabase();
    const candidate = await seedCandidate(database, ROUTE_A, "v1", "original-probe-key-a4");
    const renewalObsRef = await seedObservation(database, "renewal-key-c1", ROUTE_A, "v1");
    const stub = stubQualify({ [ROUTE_A]: renewalObsRef });
    const port = renewalPort(database, stub.qualify);

    const renewed = await port.renew(renewalInput(candidate, "renewal-key-c1"));
    expect(renewed.latest.qualification_ref).toBe(renewed.qualification_ref);

    // The candidate's original probe key completed the initial qualification,
    // never a renewal: replaying it must fail closed, not resurrect or
    // overwrite the completed renewal.
    await expect(port.renew(renewalInput(candidate, candidate.originalProbeKey))).rejects.toMatchObject({
      code: "DYNAMIC_ROUTE_PROMOTION_CONFLICT",
    });
    expect(stub.calls()).toBe(1);
  });
});
