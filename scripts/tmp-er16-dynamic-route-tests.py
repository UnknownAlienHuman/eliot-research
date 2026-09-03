from pathlib import Path
import re


def write(path: str, content: str) -> None:
    target = Path(path)
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(content.rstrip() + "\n", encoding="utf-8")


codec_path = Path("packages/cloudflare-ai/src/dynamic-route-provisioning-codec.ts")
codec = codec_path.read_text(encoding="utf-8")
for name in (
    "PROVISIONING_RECEIPT_KEYS",
    "QUALIFICATION_KEYS",
    "CANDIDATE_WRITE_KEYS",
    "ACTIVE_KEYS",
    "PROMOTION_WRITE_KEYS",
):
    codec, count = re.subn(
        rf"const {name} = new Set\(\[.*?\]\);\n",
        "",
        codec,
        count=1,
        flags=re.S,
    )
    if count != 1:
        raise SystemExit(f"failed to remove split-only constant {name}")
codec_path.write_text(codec.rstrip() + "\n", encoding="utf-8")


write(
    "packages/cloudflare-ai/src/dynamic-route-provisioning.test.ts",
    r'''import { describe, expect, it, vi } from "vitest";
import {
  canonicalModelGatewayJson,
  modelGatewaySha256,
} from "./model-gateway-request.js";
import {
  DYNAMIC_ROUTE_GATEWAY_ID,
  DynamicRouteProvisioningError,
  type DynamicRouteActiveGeneration,
  type DynamicRouteCandidate,
  type DynamicRouteControlPlanePort,
  type DynamicRouteCreateRequest,
  type DynamicRoutePromotionCommand,
  type DynamicRouteProviderSnapshot,
  type DynamicRouteProvisioningReceipt,
  type DynamicRouteQualificationEvidence,
  type DynamicRouteRegistryPort,
} from "./dynamic-route-provisioning-contract.js";
import { compileDynamicRouteDesired } from "./dynamic-route-provisioning-codec.js";
import {
  createDynamicRouteProvisioner,
  promoteDynamicRouteGeneration,
  provisionDynamicRouteGeneration,
} from "./dynamic-route-provisioning.js";

const PARAMETERS_DIGEST = "a".repeat(64);
const VERIFIED_AT = "2026-09-03T06:00:00.000Z";
const EXPIRES_AT = "2026-09-03T06:30:00.000Z";
const NOW = "2026-09-03T06:10:00.000Z";

function deployment(overrides: Readonly<Record<string, unknown>> = {}) {
  return {
    route_ref: "dynamic/eliotr-balanced",
    route_version: "route-v4",
    prompt_generation: "prompt-v3",
    schema_generation: "schema-v5",
    parameters_digest: PARAMETERS_DIGEST,
    pricing_snapshot_ref: "pricing-2026-09-03",
    ...overrides,
  };
}

function routeDefinition() {
  return {
    version: 1,
    entry: "primary",
    nodes: [
      {
        id: "primary",
        provider: "openai",
        model: "gpt-5.1",
        fallback: "secondary",
      },
      {
        id: "secondary",
        provider: "google-vertex-ai",
        model: "gemini-3.8-flash",
      },
    ],
  };
}

async function provisioningInput(
  definition: unknown = routeDefinition(),
  deploymentValue: unknown = deployment(),
) {
  const digest = await modelGatewaySha256(
    canonicalModelGatewayJson(definition),
  );
  return {
    deployment: deploymentValue,
    route_definition: definition,
    route_definition_sha256: digest,
  };
}

function snapshotFor(
  desired: Awaited<ReturnType<typeof compileDynamicRouteDesired>>,
  providerRouteId = "provider-route-1",
): DynamicRouteProviderSnapshot {
  return Object.freeze({
    provider_route_id: providerRouteId,
    gateway_id: DYNAMIC_ROUTE_GATEWAY_ID,
    name: desired.provider_route_name,
    route_definition: desired.route_definition,
    metadata: desired.create_request.metadata,
  });
}

function controlPlane(seed: readonly DynamicRouteProviderSnapshot[] = []) {
  const snapshots = [...seed];
  const list = vi.fn(async (): Promise<unknown> => ({
    routes: snapshots.map((snapshot) => ({
      provider_route_id: snapshot.provider_route_id,
      name: snapshot.name,
    })),
  }));
  const get = vi.fn(
    async (_gatewayId: string, providerRouteId: string): Promise<unknown> => {
      const snapshot = snapshots.find(
        (candidate) => candidate.provider_route_id === providerRouteId,
      );
      if (snapshot === undefined) throw new Error("missing provider route");
      return snapshot;
    },
  );
  const create = vi.fn(
    async (request: DynamicRouteCreateRequest): Promise<unknown> => {
      const providerRouteId = `provider-route-${snapshots.length + 1}`;
      snapshots.push(
        Object.freeze({
          provider_route_id: providerRouteId,
          gateway_id: request.gateway_id,
          name: request.name,
          route_definition: request.route_definition,
          metadata: request.metadata,
        }),
      );
      return { provider_route_id: providerRouteId };
    },
  );
  const port: DynamicRouteControlPlanePort = Object.freeze({
    list,
    get,
    create,
  });
  return { port, snapshots, list, get, create };
}

function registry(initial: DynamicRouteActiveGeneration | null = null) {
  let active = initial;
  let stagedCandidate: DynamicRouteCandidate | null = null;
  const stageCandidate = vi.fn(
    async (
      candidate: DynamicRouteCandidate,
      expectedSha256: string,
    ): Promise<unknown> => {
      stagedCandidate = candidate;
      return {
        candidate_ref: "dynamic-route-candidate-1",
        readback_sha256: expectedSha256,
      };
    },
  );
  const getActive = vi.fn(async (): Promise<unknown | null> => active);
  const promote = vi.fn(
    async (command: DynamicRoutePromotionCommand): Promise<unknown> => {
      active = Object.freeze({
        route_ref: command.route_ref,
        route_version: command.target_route_version,
        candidate_ref: command.candidate_ref,
        candidate_sha256: command.candidate_sha256,
      });
      return {
        promotion_ref: "dynamic-route-promotion-write-1",
        active,
      };
    },
  );
  const port: DynamicRouteRegistryPort = Object.freeze({
    stageCandidate,
    getActive,
    promote,
  });
  return {
    port,
    stageCandidate,
    getActive,
    promote,
    stagedCandidate: () => stagedCandidate,
    active: () => active,
  };
}

function qualification(
  receipt: DynamicRouteProvisioningReceipt,
  tier: "FIXTURE" | "LIVE" = "LIVE",
  overrides: Readonly<Record<string, unknown>> = {},
): DynamicRouteQualificationEvidence {
  return {
    tier,
    gateway_id: DYNAMIC_ROUTE_GATEWAY_ID,
    route_ref: receipt.deployment.route_ref,
    route_version: receipt.deployment.route_version,
    prompt_generation: receipt.deployment.prompt_generation,
    schema_generation: receipt.deployment.schema_generation,
    parameters_digest: receipt.deployment.parameters_digest,
    pricing_snapshot_ref: receipt.deployment.pricing_snapshot_ref,
    provider_route_id: receipt.provider_route_id,
    provider_route_name: receipt.provider_route_name,
    route_definition_sha256: receipt.route_definition_sha256,
    provider_snapshot_sha256: receipt.provider_snapshot_sha256,
    control_plane_readback_ref: "control-plane-readback-1",
    execution_probe_ref: "route-execution-probe-1",
    verified_at: VERIFIED_AT,
    expires_at: EXPIRES_AT,
    ...overrides,
  } as DynamicRouteQualificationEvidence;
}

async function expectError(
  call: Promise<unknown>,
  code: DynamicRouteProvisioningError["code"],
  ambiguousEffect: DynamicRouteProvisioningError["ambiguous_effect"],
) {
  try {
    await call;
    throw new Error(`expected ${code}`);
  } catch (error) {
    expect(error).toBeInstanceOf(DynamicRouteProvisioningError);
    expect((error as DynamicRouteProvisioningError).code).toBe(code);
    expect((error as DynamicRouteProvisioningError).ambiguous_effect).toBe(
      ambiguousEffect,
    );
    return error as DynamicRouteProvisioningError;
  }
}

describe("ER-16 versioned Dynamic Route provisioning", () => {
  it("creates, exactly reads back, stages, and CAS-promotes one immutable generation", async () => {
    const input = await provisioningInput();
    const provider = controlPlane();
    const authority = registry();
    const adapter = createDynamicRouteProvisioner(provider.port, authority.port);

    const receipt = await adapter.provision(input);
    expect(receipt.disposition).toBe("CREATED");
    expect(receipt.provider_route_name).toMatch(
      /^eliotr-balanced--[a-f0-9]{24}$/u,
    );
    expect(receipt.control_plane_receipt_ref).toMatch(
      /^dynamic-route-provision-[a-f0-9]{48}$/u,
    );
    expect(provider.create).toHaveBeenCalledOnce();
    expect(provider.get).toHaveBeenCalledOnce();
    expect(Object.keys(provider.port).sort()).toEqual(["create", "get", "list"]);

    const promoted = await adapter.promote(
      receipt,
      qualification(receipt),
      {
        environment: "PRODUCTION",
        expected_active_route_version: null,
        now: NOW,
      },
    );
    expect(promoted).toMatchObject({
      route_ref: "dynamic/eliotr-balanced",
      previous_route_version: null,
      active_route_version: "route-v4",
      qualification_tier: "LIVE",
    });
    expect(promoted.receipt_ref).toMatch(
      /^dynamic-route-promotion-[a-f0-9]{48}$/u,
    );
    expect(authority.stageCandidate).toHaveBeenCalledOnce();
    expect(authority.promote).toHaveBeenCalledOnce();
    expect(authority.stagedCandidate()).toMatchObject({
      schema: "eliotr.dynamic-route-candidate.v1",
      qualification_tier: "LIVE",
      provider_route_id: receipt.provider_route_id,
    });
    expect(authority.active()?.route_version).toBe("route-v4");
    expect(Object.keys(adapter).sort()).toEqual(["promote", "provision"]);
  });

  it("reuses only an exact existing version without issuing create", async () => {
    const input = await provisioningInput();
    const desired = await compileDynamicRouteDesired(input);
    const provider = controlPlane([snapshotFor(desired)]);

    const receipt = await provisionDynamicRouteGeneration(provider.port, input);
    expect(receipt.disposition).toBe("EXISTING_MATCH");
    expect(provider.create).not.toHaveBeenCalled();
    expect(provider.list).toHaveBeenCalledOnce();
    expect(provider.get).toHaveBeenCalledOnce();
  });

  it("reconciles a lost create acknowledgement through exact list/get readback", async () => {
    const input = await provisioningInput();
    const desired = await compileDynamicRouteDesired(input);
    const provider = controlPlane();
    provider.create.mockImplementationOnce(
      async (_request: DynamicRouteCreateRequest): Promise<unknown> => {
        provider.snapshots.push(snapshotFor(desired));
        throw new Error("lost create acknowledgement");
      },
    );

    const receipt = await provisionDynamicRouteGeneration(provider.port, input);
    expect(receipt.disposition).toBe("CREATE_RECONCILED");
    expect(provider.create).toHaveBeenCalledOnce();
    expect(provider.list).toHaveBeenCalledTimes(2);
    expect(provider.get).toHaveBeenCalledOnce();
  });

  it("returns CREATE_UNCERTAIN instead of replaying an unreconciled provider mutation", async () => {
    const input = await provisioningInput();
    const provider = controlPlane();
    provider.create.mockRejectedValueOnce(new Error("timeout after dispatch"));

    const error = await expectError(
      provisionDynamicRouteGeneration(provider.port, input),
      "DYNAMIC_ROUTE_CREATE_UNCERTAIN",
      "PROVIDER_CREATE",
    );
    expect(error.retryable).toBe(false);
    expect(provider.create).toHaveBeenCalledOnce();
    expect(provider.list).toHaveBeenCalledTimes(2);
    expect(provider.get).not.toHaveBeenCalled();
  });

  it("fails closed when the deterministic provider name is occupied by drifted bytes", async () => {
    const input = await provisioningInput();
    const desired = await compileDynamicRouteDesired(input);
    const exact = snapshotFor(desired);
    const collision: DynamicRouteProviderSnapshot = {
      ...exact,
      metadata: {
        ...exact.metadata,
        route_version: "route-v999",
      },
    };
    const provider = controlPlane([collision]);

    await expectError(
      provisionDynamicRouteGeneration(provider.port, input),
      "DYNAMIC_ROUTE_PROVIDER_NAME_COLLISION",
      "NONE",
    );
    expect(provider.create).not.toHaveBeenCalled();
  });

  it("strictly rejects unknown, duplicate, and malformed control-plane observations", async () => {
    const input = await provisioningInput();
    const malformedPorts: DynamicRouteControlPlanePort[] = [
      {
        list: vi.fn(async () => ({ routes: [], cursor: "forbidden" })),
        get: vi.fn(),
        create: vi.fn(),
      },
      {
        list: vi.fn(async () => ({
          routes: [
            { provider_route_id: "same", name: "route-a" },
            { provider_route_id: "same", name: "route-b" },
          ],
        })),
        get: vi.fn(),
        create: vi.fn(),
      },
      {
        list: vi.fn(async () => ({ routes: [{ name: "missing-id" }] })),
        get: vi.fn(),
        create: vi.fn(),
      },
    ];
    for (const port of malformedPorts) {
      await expectError(
        provisionDynamicRouteGeneration(port, input),
        "DYNAMIC_ROUTE_CONTROL_PLANE_RESPONSE_INVALID",
        "NONE",
      );
      expect(port.create).not.toHaveBeenCalled();
    }
  });

  it("requires fresh exact LIVE evidence before production promotion", async () => {
    const input = await provisioningInput();
    const provider = controlPlane();
    const receipt = await provisionDynamicRouteGeneration(provider.port, input);
    const authority = registry();

    await expectError(
      promoteDynamicRouteGeneration(
        authority.port,
        receipt,
        qualification(receipt, "FIXTURE"),
        {
          environment: "PRODUCTION",
          expected_active_route_version: null,
          now: NOW,
        },
      ),
      "DYNAMIC_ROUTE_LIVE_GATE_REQUIRED",
      "NONE",
    );
    await expectError(
      promoteDynamicRouteGeneration(
        authority.port,
        receipt,
        qualification(receipt, "LIVE", {
          provider_snapshot_sha256: "b".repeat(64),
        }),
        {
          environment: "TEST",
          expected_active_route_version: null,
          now: NOW,
        },
      ),
      "DYNAMIC_ROUTE_QUALIFICATION_INVALID",
      "NONE",
    );
    await expectError(
      promoteDynamicRouteGeneration(
        authority.port,
        receipt,
        qualification(receipt, "LIVE"),
        {
          environment: "TEST",
          expected_active_route_version: null,
          now: "2026-09-03T07:00:00.000Z",
        },
      ),
      "DYNAMIC_ROUTE_QUALIFICATION_INVALID",
      "NONE",
    );
    expect(authority.stageCandidate).not.toHaveBeenCalled();
  });

  it("distinguishes staged-candidate drift, CAS conflict, and ambiguous promotion", async () => {
    const input = await provisioningInput();
    const provider = controlPlane();
    const receipt = await provisionDynamicRouteGeneration(provider.port, input);
    const evidence = qualification(receipt, "FIXTURE");

    const badStage = registry();
    badStage.stageCandidate.mockResolvedValueOnce({
      candidate_ref: "dynamic-route-candidate-1",
      readback_sha256: "b".repeat(64),
    });
    await expectError(
      promoteDynamicRouteGeneration(badStage.port, receipt, evidence, {
        environment: "TEST",
        expected_active_route_version: null,
        now: NOW,
      }),
      "DYNAMIC_ROUTE_REGISTRY_STAGE_FAILED",
      "REGISTRY_STAGE",
    );
    expect(badStage.promote).not.toHaveBeenCalled();

    const conflicted = registry({
      route_ref: receipt.deployment.route_ref,
      route_version: "route-v3",
      candidate_ref: "old-candidate",
      candidate_sha256: "c".repeat(64),
    });
    await expectError(
      promoteDynamicRouteGeneration(conflicted.port, receipt, evidence, {
        environment: "TEST",
        expected_active_route_version: "route-v2",
        now: NOW,
      }),
      "DYNAMIC_ROUTE_PROMOTION_CONFLICT",
      "REGISTRY_STAGE",
    );
    expect(conflicted.promote).not.toHaveBeenCalled();

    const ambiguous = registry();
    ambiguous.promote.mockRejectedValueOnce(new Error("lost CAS acknowledgement"));
    await expectError(
      promoteDynamicRouteGeneration(ambiguous.port, receipt, evidence, {
        environment: "TEST",
        expected_active_route_version: null,
        now: NOW,
      }),
      "DYNAMIC_ROUTE_PROMOTION_FAILED",
      "REGISTRY_PROMOTION",
    );
    expect(ambiguous.promote).toHaveBeenCalledOnce();
  });
});
''',
)


write(
    "infra/ai-search/dynamic-route-provisioning-capability.json",
    r'''{
  "schema": "eliotr.dynamic-route-provisioning-capability.v1",
  "gateway_id": "eliotr-reasoning",
  "control_plane_operations": ["list", "get", "create"],
  "update_in_place": false,
  "delete_owned": false,
  "provider_name_identity": "route_ref + deployment_sha256_prefix",
  "create_reconciliation": "exact list/get readback only",
  "candidate_registry": "immutable digest readback",
  "promotion": "expected-active-version CAS",
  "production_gate": {
    "qualification_tier": "LIVE",
    "maximum_age_seconds": 3600,
    "bindings": [
      "gateway_id",
      "route_ref",
      "route_version",
      "prompt_generation",
      "schema_generation",
      "parameters_digest",
      "pricing_snapshot_ref",
      "provider_route_id",
      "provider_route_name",
      "route_definition_sha256",
      "provider_snapshot_sha256",
      "control_plane_readback_ref",
      "execution_probe_ref"
    ]
  },
  "live_control_plane_write_readback": "NOT_EXECUTED",
  "live_route_execution_probe": "NOT_EXECUTED",
  "live_fallback_probe": "NOT_EXECUTED",
  "live_spend_limit_probe": "NOT_EXECUTED"
}
''',
)

readme_path = Path("packages/cloudflare-ai/README.md")
readme = readme_path.read_text(encoding="utf-8").rstrip()
heading = "## Versioned Dynamic Route provisioning"
if heading not in readme:
    readme += r'''

## Versioned Dynamic Route provisioning

Dynamic Route generations are create-only. A deterministic provider name is bound to the decoded
`ModelRouteDeployment` identity, while the complete route definition and deployment metadata are
independently SHA-256 bound. The provisioner exposes only `list`, `get`, and `create`; it owns no provider
update or delete operation.

A failed create is never replayed blindly. The adapter performs one exact list/get reconciliation and
returns `CREATE_RECONCILED` only when the immutable provider snapshot matches. Otherwise it reports
`DYNAMIC_ROUTE_CREATE_UNCERTAIN` with `PROVIDER_CREATE` as the unresolved effect.

Promotion is a separate authority transition. The provider snapshot is staged as an immutable candidate,
then activated through expected-active-version CAS. Production promotion requires fresh `LIVE`
qualification bound to the exact gateway, deployment generations, provider identity, definition digest,
snapshot digest, control-plane readback, and execution probe. Fixture evidence can promote only in the
`TEST` environment.
'''.rstrip()
readme_path.write_text(readme + "\n", encoding="utf-8")

packet_path = Path("docs/agent-work/ER-16-ai-search-and-model-gateway-adapters.md")
packet = packet_path.read_text(encoding="utf-8").rstrip()
heading = "## Active implementation slice — versioned Dynamic Route provisioning"
if heading not in packet:
    packet += r'''

## Active implementation slice — versioned Dynamic Route provisioning

ER-16 now contains a create-only versioned Dynamic Route provisioner and an explicit promotion gate.
The provider-facing port deliberately contains only `list`, `get`, and `create`; route policy is never
updated in place and this slice owns no provider deletion.

Each desired generation binds the decoded `ModelRouteDeployment`, canonical route-definition bytes,
parameter digest, prompt generation, schema generation, and pricing snapshot. Its deterministic provider
name includes the deployment-identity digest. Existing names are accepted only after exact detail
readback; drift is a hard collision.

One uncertain create is reconciled by one list/get readback. No second create is issued. An exact match
returns `CREATE_RECONCILED`; absence, conflicting bytes, or unavailable readback leaves a typed
`PROVIDER_CREATE` unresolved effect.

Provider provisioning and authority promotion are separate phases. Promotion first requires qualification
evidence bound to the exact provider snapshot and route execution probe, stages one immutable candidate
with digest readback, reads the active generation, and performs expected-active-version CAS. Production
accepts only fresh `LIVE` qualification with a maximum one-hour validity window; `FIXTURE` evidence is
restricted to `TEST`.

The fixture corpus covers exact creation, existing-version reuse, lost-acknowledgement reconciliation,
create uncertainty, provider-name collision, malformed control-plane responses, stale or drifted
qualification, candidate readback mismatch, active-generation race, and ambiguous promotion settlement.
The capability fixture keeps live Cloudflare control-plane write/readback, route execution, fallback, and
Spend Limit probes explicitly `NOT_EXECUTED`.
'''.rstrip()
packet_path.write_text(packet + "\n", encoding="utf-8")
