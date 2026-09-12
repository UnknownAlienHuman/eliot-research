import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import type { ModelGatewayFingerprintStorePort } from "../../../packages/cloudflare-ai/src/model-gateway-execution-contract.js";
import {
  canonicalModelGatewayJson,
  modelGatewaySha256,
} from "../../../packages/cloudflare-ai/src/model-gateway-request.js";
import type { RouteFingerprint } from "@eliotr/platform-cloudflare";
import {
  createD1ModelGatewayFingerprintStore,
  readD1ModelGatewayFingerprint,
  type ResearchModelFingerprintStoreOptions,
} from "../../../packages/cloudflare-research/src/research-model-fingerprint-store.js";

const runtime = env as unknown as {
  readonly CORE_DB: D1Database;
  readonly CORE_MIGRATIONS: Parameters<typeof applyD1Migrations>[1];
};

const NOW = "2026-09-10T12:00:00.000Z";

interface FingerprintReceipt {
  readonly fingerprint_ref: string;
  readonly readback_sha256: string;
}

beforeAll(async () => {
  await applyD1Migrations(runtime.CORE_DB, runtime.CORE_MIGRATIONS);
});

function fingerprint(
  tag: string,
  route_ref: RouteFingerprint["route_ref"] = "dynamic/eliotr-balanced",
): RouteFingerprint {
  return Object.freeze({
    route_ref,
    route_version: `fixture-${tag}`,
    prompt_generation: `prompt-${tag}`,
    schema_generation: `schema-${tag}`,
    parameters_digest: "a".repeat(64),
    pricing_snapshot_ref: `pricing-${tag}`,
    provider: `provider-${tag}`,
    exact_model_id: `model-${tag}`,
  });
}

async function digestFingerprint(value: RouteFingerprint): Promise<string> {
  return modelGatewaySha256(canonicalModelGatewayJson(value));
}

async function activeGenerations(database: D1Database): Promise<ReadonlyArray<Record<string, unknown>>> {
  const result = await database.prepare(
    "SELECT route_ref, route_version, candidate_ref, candidate_sha256, promotion_ref, promoted_at " +
      "FROM dynamic_route_active_generation ORDER BY route_ref",
  ).all<Record<string, unknown>>();
  return result.results;
}

function store(
  options: ResearchModelFingerprintStoreOptions = {},
): ModelGatewayFingerprintStorePort {
  return createD1ModelGatewayFingerprintStore(runtime.CORE_DB, options);
}

describe("D1 model gateway fingerprint store over actual Worker D1", () => {
  it("persists the exact canonical fingerprint and replays the same immutable reference", async () => {
    const value = fingerprint("canonical");
    const expected = await digestFingerprint(value);
    const first = await store({ now: () => NOW }).putImmutable(value, expected) as FingerprintReceipt;

    expect(first).toEqual({
      fingerprint_ref: `route-fingerprint-${expected}`,
      readback_sha256: expected,
    });
    expect(await store({ now: () => NOW }).putImmutable(value, expected)).toEqual(first);

    const row = await runtime.CORE_DB.prepare(
      "SELECT fingerprint_ref, route_ref, fingerprint_sha256, fingerprint_json, observed_at " +
        "FROM research_model_fingerprint WHERE fingerprint_ref = ?1",
    ).bind(first.fingerprint_ref).first<{
      readonly fingerprint_ref: string;
      readonly route_ref: string;
      readonly fingerprint_sha256: string;
      readonly fingerprint_json: string;
      readonly observed_at: string;
    }>();
    expect(row).toEqual({
      fingerprint_ref: first.fingerprint_ref,
      route_ref: value.route_ref,
      fingerprint_sha256: expected,
      fingerprint_json: canonicalModelGatewayJson(value),
      observed_at: NOW,
    });
    await expect(store().getLatest(value.route_ref)).resolves.toEqual(value);
  });

  it("uses insertion order for latest, isolates routes, and never promotes an active generation", async () => {
    let now = "2026-09-10T12:00:00.000Z";
    const gateway = store({ now: () => now });
    const old = fingerprint("latest-old");
    const newest = fingerprint("latest-new");
    const isolated = fingerprint("latest-isolated", "dynamic/eliotr-strong");
    const oldDigest = await digestFingerprint(old);
    const newestDigest = await digestFingerprint(newest);
    const isolatedDigest = await digestFingerprint(isolated);

    const beforeActive = await activeGenerations(runtime.CORE_DB);
    await gateway.putImmutable(old, oldDigest);
    now = "2026-09-10T11:00:00.000Z";
    await gateway.putImmutable(newest, newestDigest);
    await gateway.putImmutable(isolated, isolatedDigest);

    await expect(readD1ModelGatewayFingerprint(runtime.CORE_DB, `route-fingerprint-${oldDigest}`)).resolves.toEqual(old);
    await expect(readD1ModelGatewayFingerprint(runtime.CORE_DB, "route-fingerprint-missing")).resolves.toBeNull();
    await expect(gateway.getLatest(old.route_ref)).resolves.toEqual(newest);
    await expect(gateway.getLatest(isolated.route_ref)).resolves.toEqual(isolated);
    await expect(gateway.putImmutable(old, oldDigest)).resolves.toEqual({
      fingerprint_ref: `route-fingerprint-${oldDigest}`,
      readback_sha256: oldDigest,
    });
    await expect(gateway.getLatest(old.route_ref)).resolves.toEqual(newest);
    await expect(activeGenerations(runtime.CORE_DB)).resolves.toEqual(beforeActive);
  });

  it("rejects invalid input and detects corrupt persisted fingerprint bytes", async () => {
    const value = fingerprint("validation");
    const expected = await digestFingerprint(value);
    const invalid = { ...value, provider: "" } as unknown as RouteFingerprint;
    await expect(store().putImmutable(invalid, expected)).rejects.toMatchObject({
      code: "MODEL_FINGERPRINT_INPUT_INVALID",
    });
    await expect(store().putImmutable(value, "f".repeat(64))).rejects.toMatchObject({
      code: "MODEL_FINGERPRINT_INPUT_INVALID",
    });

    const corrupt = fingerprint("corrupt", "dynamic/eliotr-extract");
    const corruptJson = canonicalModelGatewayJson(corrupt);
    const corruptDigest = await modelGatewaySha256(corruptJson);
    const wrongDigest = corruptDigest[0] === "a" ? `b${corruptDigest.slice(1)}` : `a${corruptDigest.slice(1)}`;
    await runtime.CORE_DB.prepare(
      "INSERT INTO research_model_fingerprint(fingerprint_ref, route_ref, fingerprint_sha256, fingerprint_json, observed_at) " +
        "VALUES (?1, ?2, ?3, ?4, ?5)",
    ).bind(`route-fingerprint-${wrongDigest}`, corrupt.route_ref, wrongDigest, corruptJson, NOW).run();
    await expect(store().getLatest(corrupt.route_ref)).rejects.toMatchObject({
      code: "MODEL_FINGERPRINT_READBACK_CORRUPT",
    });
  });

  it("reconciles a committed insert when the D1 acknowledgement is lost", async () => {
    const value = fingerprint("lost-ack", "dynamic/eliotr-audit-writer");
    const expected = await digestFingerprint(value);
    let throwAfterCommit = true;
    const database = {
      prepare(sql: string) {
        const statement = runtime.CORE_DB.prepare(sql);
        if (!throwAfterCommit || !sql.includes("INSERT INTO research_model_fingerprint")) return statement;
        return {
          bind(...bindings: unknown[]) {
            const bound = statement.bind(...bindings);
            return {
              first: async <T>() => {
                const result = await bound.first<T>();
                throwAfterCommit = false;
                if (result === null) throw new Error("controlled lost acknowledgement");
                throw new Error("controlled lost acknowledgement after commit");
              },
            };
          },
        };
      },
    } as unknown as D1Database;
    const receipt = await createD1ModelGatewayFingerprintStore(database, { now: () => NOW })
      .putImmutable(value, expected) as FingerprintReceipt;

    expect(receipt).toEqual({
      fingerprint_ref: `route-fingerprint-${expected}`,
      readback_sha256: expected,
    });
    const rows = await runtime.CORE_DB.prepare(
      "SELECT COUNT(*) AS count FROM research_model_fingerprint WHERE fingerprint_ref = ?1",
    ).bind(receipt.fingerprint_ref).first<{ readonly count: number }>();
    expect(Number(rows?.count ?? 0)).toBe(1);
  });
});
