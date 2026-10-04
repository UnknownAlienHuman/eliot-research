/// <reference types="node" />
import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { canonicalJson } from "@eliotr/platform-cloudflare";
import {
  createD1ResearchRunConfigurationStore,
  RESEARCH_RUN_CONFIGURATION_PROTOCOL,
} from "@eliotr/cloudflare-research";
import type { Env } from "./env.js";
import {
  attachResearchRunConfiguration,
  captureResearchRunConfiguration,
  readResearchRunConfiguration,
} from "./research-run-configuration.js";

const actor = Object.freeze({
  operation_id: "run-config-core-1",
  investigation_id: "research-config-core-1",
  principal_ref: "owner-config-core-1",
  deployment_generation: "deployment-original-1",
});

const semantic = canonicalJson({ protocol: "eliotr.research-semantic-config.v1", marker: "captured-semantic" });
const sha256 = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");
const transport_policy = { version: 1, transport: "cloudflare-ai-gateway", api: "compat-chat-completions",
  provider: "workers-ai", model: "@cf/example/model", billing: { mode: "unified_billing" },
  capabilities: { reasoning_efforts: ["low", "medium", "high"] } };

function snapshotJson(mode: "snapshot-v1" | "snapshot-v2" = "snapshot-v1", routes = ["dynamic/eliotr-balanced", "dynamic/eliotr-audit-verifier"]): string {
  const spend = { protocol: mode === "snapshot-v2" ? "eliotr.research-owner-spend-template.v2" : "eliotr.research-owner-spend-template.v1" };
  const modelSelection = (stage: string, route: string) => ({ stage, route_ref: route, route_version: "version-1",
    candidate_ref: `candidate-${stage.toLowerCase()}`, candidate_sha256: "b".repeat(64),
    qualification_ref: `qualification-${stage.toLowerCase()}`, qualification_sha256: "c".repeat(64), transport_policy });
  return canonicalJson({
    protocol: RESEARCH_RUN_CONFIGURATION_PROTOCOL,
    mode,
    association: actor,
    project_configuration: { configuration_ref: "project-config-1", configuration_sha256: "d".repeat(64), selection_revision: 1 },
    model_selections: [modelSelection("SYNTHESIZE", routes[0] ?? ""), modelSelection("AUDIT_CLAIMS", routes[1] ?? "")],
    semantic: { source: "revision", config_json: semantic, revision_ref: "scr-123456789abc", config_sha256: sha256(semantic) },
    model_profile: { config_json: canonicalJson({ profile: "captured" }), provenance_ref: "profile-provenance-1" },
    spend_policy: { config_json: canonicalJson(spend), provenance_ref: "spend-provenance-1" },
    report: { config_json: canonicalJson({ report: "captured" }), provenance_ref: "report-provenance-1" },
  });
}

type MemoryAssociation = { readonly operation_id: string; readonly investigation_id: string; readonly principal_ref: string;
  readonly deployment_generation: string };
type MemoryRun = MemoryAssociation & { readonly configuration_required: number; configuration_ref: string | null };
type MemoryConfiguration = MemoryAssociation & {
  readonly protocol: typeof RESEARCH_RUN_CONFIGURATION_PROTOCOL;
  readonly mode: "snapshot-v1" | "snapshot-v2";
  readonly configuration_ref: string;
  readonly configuration_sha256: string;
  readonly configuration_json: string;
  readonly byte_length: number;
  readonly created_at: string;
};

function memoryDatabase(requiredRun?: 0 | 1): { readonly database: D1Database; readonly runs: Map<string, MemoryRun> } {
  const runs = new Map<string, MemoryRun>();
  const configurations = new Map<string, MemoryConfiguration>();
  const database = {
    prepare(rawQuery: string) {
      const query = rawQuery.replace(/\s+/gu, " ").trim();
      return {
        bind(...values: unknown[]) {
          return {
            async first<T>() {
              if (query.includes("FROM research_workflow_run")) {
                return (runs.get(String(values[0])) ?? null) as T | null;
              }
              if (query.includes("FROM research_run_configuration") && query.includes("WHERE operation_id=?1")) {
                return (configurations.get(String(values[0])) ?? null) as T | null;
              }
              if (query.includes("FROM research_run_configuration") && query.includes("WHERE configuration_ref=?1")) {
                return ([...configurations.values()].find((row) => row.configuration_ref === values[0]) ?? null) as T | null;
              }
              throw new Error(`Unexpected test D1 query: ${query}`);
            },
            async run() {
              if (query.startsWith("INSERT INTO research_run_configuration")) {
                const [operation_id, investigation_id, principal_ref, deployment_generation, protocol, mode,
                  configuration_ref, configuration_sha256, configuration_json, byte_length, created_at] = values as [
                  string, string, string, string, typeof RESEARCH_RUN_CONFIGURATION_PROTOCOL, "snapshot-v1" | "snapshot-v2",
                  string, string, string, number, string,
                ];
                if (!configurations.has(operation_id)) {
                  configurations.set(operation_id, { operation_id, investigation_id, principal_ref, deployment_generation,
                    protocol, mode, configuration_ref, configuration_sha256, configuration_json, byte_length, created_at });
                  return { success: true, meta: { changes: 1 } };
                }
                return { success: true, meta: { changes: 0 } };
              }
              if (query.startsWith("UPDATE research_workflow_run SET configuration_ref=")) {
                const [configuration_ref, operation_id] = values as [string, string];
                const run = runs.get(operation_id);
                if (run !== undefined && run.configuration_ref === null) run.configuration_ref = configuration_ref;
                return { success: true, meta: { changes: run?.configuration_ref === configuration_ref ? 1 : 0 } };
              }
              throw new Error(`Unexpected test D1 write: ${query}`);
            },
          };
        },
      };
    },
  };
  if (requiredRun !== undefined) runs.set(actor.operation_id, { ...actor, configuration_required: requiredRun, configuration_ref: null });
  return { database: database as unknown as D1Database, runs };
}

function testEnv(database: D1Database): Env {
  return { CORE_DB: database } as unknown as Env;
}

describe("research run configuration binding", () => {
  it("preserves an explicit pre-migration legacy-installed run", async () => {
    const { database } = memoryDatabase(0);
    const env = testEnv(database);
    const result = await readResearchRunConfiguration(env, actor);
    expect(result.mode).toBe("legacy-installed");
    expect(result.configuration_ref).toBeNull();
  });

  it("persists a snapshot before binding it and reloads exact vars without replacing live credentials", async () => {
    const { database, runs } = memoryDatabase();
    const env = { ...testEnv(database), DEPLOYMENT_GENERATION: "deployment-current-2",
      ELIOTR_MODEL_GATEWAY_TOKEN: "current-secret-token", ELIOTR_MODEL_PROFILE_DEFINITION_JSON: "old-profile" } as Env;
    const json = snapshotJson();
    const receipt = await createD1ResearchRunConfigurationStore(database).putImmutable({ ...actor,
      mode: "snapshot-v1", configuration_json: json, created_at: "2026-10-03T12:00:00.000Z" });
    runs.set(actor.operation_id, { ...actor, configuration_required: 1, configuration_ref: null });
    await attachResearchRunConfiguration(env, actor, { mode: "snapshot-v1", ...receipt });

    const result = await readResearchRunConfiguration(env, actor);
    expect(result).toMatchObject({ mode: "snapshot-v1", configuration_ref: receipt.configuration_ref,
      configuration_sha256: receipt.configuration_sha256 });
    expect(result.env.ELIOTR_RESEARCH_SEMANTIC_CONFIG_REF).toBe("scr-123456789abc");
    expect(result.env.ELIOTR_RESEARCH_SEMANTIC_CONFIG_SHA256).toBe(sha256(semantic));
    expect(result.env.ELIOTR_MODEL_PROFILE_DEFINITION_JSON).toBe(canonicalJson({ profile: "captured" }));
    expect(result.env.ELIOTR_MODEL_GATEWAY_TOKEN).toBe("current-secret-token");
    expect(result.env.DEPLOYMENT_GENERATION).toBe("deployment-current-2");
  });

  it("accepts canonical dynamic routes and rejects malformed route references on snapshot readback", async () => {
    const { database, runs } = memoryDatabase(1);
    const env = testEnv(database);
    const receipt = await createD1ResearchRunConfigurationStore(database).putImmutable({ ...actor,
      mode: "snapshot-v1", configuration_json: snapshotJson("snapshot-v1", ["route-synthesis", "route-audit"]) });
    const run = runs.get(actor.operation_id);
    if (run === undefined) throw new Error("test run row missing");
    run.configuration_ref = receipt.configuration_ref;
    await expect(readResearchRunConfiguration(env, actor)).rejects.toMatchObject({ code: "WORKFLOW_CONFIGURATION_INVALID" });
  });

  it("does not resolve current selection on idempotent replay and fails closed for a missing required pointer", async () => {
    const { database } = memoryDatabase(1);
    const env = testEnv(database);
    await createD1ResearchRunConfigurationStore(database).putImmutable({ ...actor,
      mode: "snapshot-v2", configuration_json: snapshotJson("snapshot-v2"), created_at: "2026-10-03T12:00:00.000Z" });
    const replay = await captureResearchRunConfiguration(env, { ...actor,
      select_project_configuration: async () => { throw new Error("current selection must not be read on retry"); } });
    expect(replay.mode).toBe("snapshot-v2");
    await expect(readResearchRunConfiguration(env, actor)).rejects.toMatchObject({ code: "WORKFLOW_CONFIGURATION_INVALID" });
  });
});
