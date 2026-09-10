import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import { modelGatewaySha256 } from "../../../packages/cloudflare-ai/src/model-gateway-request.js";
import {
  canonicalJson,
} from "@eliotr/platform-cloudflare";
import {
  createD1ResearchModelPricingSnapshotStore,
  type PutResearchModelPricingSnapshotInput,
  type ResearchModelPricingSnapshotDocument,
  type ResearchModelPricingSnapshotIdentity,
} from "../../../packages/cloudflare-research/src/research-model-pricing-store.js";

const runtime = env as unknown as {
  readonly CORE_DB: D1Database;
  readonly CORE_MIGRATIONS: Parameters<typeof applyD1Migrations>[1];
};

const NOW = "2026-09-10T12:00:00.000Z";

function identity(tag: string): ResearchModelPricingSnapshotIdentity {
  return {
    pricing_snapshot_ref: `pricing-snapshot-${tag}`,
    route_ref: `dynamic/eliotr-${tag}`,
    route_version: `route-${tag}`,
    provider: `provider-${tag}`,
    exact_model_id: `model-${tag}`,
  };
}

function snapshot(
  tag: string,
  overrides: Partial<ResearchModelPricingSnapshotDocument> = {},
): ResearchModelPricingSnapshotDocument {
  return {
    protocol: "eliotr.research-model-pricing.v1",
    ...identity(tag),
    pricing_basis: "EXACT_TOKEN_RATES_V1",
    input_rate_usd_per_1k_tokens: "0.00000125",
    output_rate_usd_per_1k_tokens: "0.00000450",
    effective_at: NOW,
    expires_at: "2026-09-10T13:00:00.000Z",
    provenance_ref: `pricing-provenance-${tag}`,
    approval_receipt_ref: `pricing-receipt-${tag}`,
    ...overrides,
  };
}

function input(tag: string, overrides: Partial<ResearchModelPricingSnapshotDocument> = {}): PutResearchModelPricingSnapshotInput {
  return { identity: identity(tag), snapshot: snapshot(tag, overrides) };
}

async function snapshotDigest(document: ResearchModelPricingSnapshotDocument): Promise<string> {
  return modelGatewaySha256(canonicalJson(document));
}

beforeAll(async () => {
  await applyD1Migrations(runtime.CORE_DB, runtime.CORE_MIGRATIONS);
});

describe("D1 research model pricing snapshot store over actual Worker D1", () => {
  it("persists the exact canonical document and replays one immutable identity", async () => {
    const command = input("canonical");
    const expectedDigest = await snapshotDigest(command.snapshot);
    const store = createD1ResearchModelPricingSnapshotStore(runtime.CORE_DB, { now: () => NOW });

    const first = await store.putImmutable(command);
    expect(first).toEqual({
      ...command.snapshot,
      snapshot_sha256: expectedDigest,
      created_at: NOW,
    });
    await expect(store.putImmutable(command)).resolves.toEqual(first);
    await expect(store.read(command.identity)).resolves.toEqual(first);

    const row = await runtime.CORE_DB.prepare(
      "SELECT pricing_snapshot_ref, route_ref, route_version, provider, exact_model_id, " +
        "pricing_basis, input_rate_usd_per_1k_tokens, output_rate_usd_per_1k_tokens, " +
        "provenance_ref, approval_receipt_ref, effective_at, expires_at, snapshot_sha256, " +
        "snapshot_json, created_at FROM research_model_pricing_snapshot WHERE pricing_snapshot_ref = ?1",
    ).bind(command.identity.pricing_snapshot_ref).first<Record<string, unknown>>();
    expect(row).toEqual({
      pricing_snapshot_ref: command.snapshot.pricing_snapshot_ref,
      route_ref: command.snapshot.route_ref,
      route_version: command.snapshot.route_version,
      provider: command.snapshot.provider,
      exact_model_id: command.snapshot.exact_model_id,
      pricing_basis: command.snapshot.pricing_basis,
      input_rate_usd_per_1k_tokens: command.snapshot.input_rate_usd_per_1k_tokens,
      output_rate_usd_per_1k_tokens: command.snapshot.output_rate_usd_per_1k_tokens,
      provenance_ref: command.snapshot.provenance_ref,
      approval_receipt_ref: command.snapshot.approval_receipt_ref,
      effective_at: command.snapshot.effective_at,
      expires_at: command.snapshot.expires_at,
      snapshot_sha256: expectedDigest,
      snapshot_json: canonicalJson(command.snapshot),
      created_at: NOW,
    });
  });

  it("refuses changed canonical bytes for an existing identity", async () => {
    const original = input("conflict");
    const store = createD1ResearchModelPricingSnapshotStore(runtime.CORE_DB, { now: () => NOW });
    await store.putImmutable(original);

    await expect(store.putImmutable({
      identity: original.identity,
      snapshot: snapshot("conflict", { output_rate_usd_per_1k_tokens: "0.00000451" }),
    })).rejects.toMatchObject({ code: "MODEL_PRICING_IDENTITY_CONFLICT" });
    await expect(store.read(original.identity)).resolves.toMatchObject({
      output_rate_usd_per_1k_tokens: "0.00000450",
    });
  });

  it("rejects unsupported basis and malformed decimal rates before D1 effects", async () => {
    const store = createD1ResearchModelPricingSnapshotStore(runtime.CORE_DB, { now: () => NOW });
    await expect(store.putImmutable({
      identity: identity("unsupported-basis"),
      snapshot: snapshot("unsupported-basis", { pricing_basis: "NEURONS_V1" as never }),
    })).rejects.toMatchObject({ code: "MODEL_PRICING_INPUT_INVALID" });
    await expect(store.putImmutable({
      identity: identity("malformed-rate"),
      snapshot: snapshot("malformed-rate", { input_rate_usd_per_1k_tokens: "01.25" }),
    })).rejects.toMatchObject({ code: "MODEL_PRICING_INPUT_INVALID" });
    await expect(store.putImmutable({
      identity: { ...identity("extra-identity"), unexpected: "caller-field" } as never,
      snapshot: snapshot("extra-identity"),
    })).rejects.toMatchObject({ code: "MODEL_PRICING_INPUT_INVALID" });

    const rows = await runtime.CORE_DB.prepare(
      "SELECT COUNT(*) AS count FROM research_model_pricing_snapshot WHERE pricing_snapshot_ref IN (?1, ?2, ?3)",
    ).bind("pricing-snapshot-unsupported-basis", "pricing-snapshot-malformed-rate", "pricing-snapshot-extra-identity").first<{ readonly count: number }>();
    expect(Number(rows?.count ?? 0)).toBe(0);
  });

  it("rejects a corrupt stored row instead of returning unverified pricing", async () => {
    const command = input("corrupt");
    const documentJson = canonicalJson(command.snapshot);
    const digest = await snapshotDigest(command.snapshot);
    const wrongDigest = digest[0] === "a" ? `b${digest.slice(1)}` : `a${digest.slice(1)}`;
    await runtime.CORE_DB.prepare(
      "INSERT INTO research_model_pricing_snapshot(" +
        "pricing_snapshot_ref, route_ref, route_version, provider, exact_model_id, pricing_basis, " +
        "input_rate_usd_per_1k_tokens, output_rate_usd_per_1k_tokens, provenance_ref, approval_receipt_ref, " +
        "effective_at, expires_at, snapshot_sha256, snapshot_json, created_at) " +
        "VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15)",
    ).bind(
      command.identity.pricing_snapshot_ref, command.identity.route_ref, command.identity.route_version,
      command.identity.provider, command.identity.exact_model_id, command.snapshot.pricing_basis,
      command.snapshot.input_rate_usd_per_1k_tokens, command.snapshot.output_rate_usd_per_1k_tokens,
      command.snapshot.provenance_ref, command.snapshot.approval_receipt_ref, command.snapshot.effective_at,
      command.snapshot.expires_at, wrongDigest, documentJson, NOW,
    ).run();

    await expect(createD1ResearchModelPricingSnapshotStore(runtime.CORE_DB).read(command.identity))
      .rejects.toMatchObject({ code: "MODEL_PRICING_READBACK_CORRUPT" });
  });

  it("reconciles a committed INSERT after a lost D1 acknowledgement without a second row", async () => {
    const command = input("lost-ack");
    let throwAfterCommit = true;
    const database = {
      prepare(sql: string) {
        const statement = runtime.CORE_DB.prepare(sql);
        if (!throwAfterCommit || !sql.includes("INSERT INTO research_model_pricing_snapshot")) return statement;
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

    const store = createD1ResearchModelPricingSnapshotStore(database, { now: () => NOW });
    const expectedDigest = await snapshotDigest(command.snapshot);
    await expect(store.putImmutable(command)).resolves.toMatchObject({
      pricing_snapshot_ref: command.identity.pricing_snapshot_ref,
      snapshot_sha256: expectedDigest,
    });
    const rows = await runtime.CORE_DB.prepare(
      "SELECT COUNT(*) AS count FROM research_model_pricing_snapshot WHERE pricing_snapshot_ref = ?1",
    ).bind(command.identity.pricing_snapshot_ref).first<{ readonly count: number }>();
    expect(Number(rows?.count ?? 0)).toBe(1);
  });

  it("keeps an expired snapshot readable for historical settlement", async () => {
    const command = input("historical-expired", {
      effective_at: "2026-09-10T10:00:00.000Z",
      expires_at: "2026-09-10T11:00:00.000Z",
    });
    const store = createD1ResearchModelPricingSnapshotStore(runtime.CORE_DB, { now: () => NOW });
    const expectedDigest = await snapshotDigest(command.snapshot);
    await store.putImmutable(command);

    await expect(store.read(command.identity)).resolves.toEqual({
      ...command.snapshot,
      snapshot_sha256: expectedDigest,
      created_at: NOW,
    });
  });
});
