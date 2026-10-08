/// <reference types="node" />
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { canonicalModelGatewayJson, modelGatewaySha256 } from "@eliotr/cloudflare-ai";
import {
  createD1ResearchProjectModelConfigurationStore,
  RESEARCH_PROJECT_MODEL_CONFIGURATION_PROTOCOL,
} from "./research-project-configuration-store.js";

const MIGRATION = readFileSync(resolve(__dirname, "../../../infra/d1/core/migrations/0106_research_project_model_configuration.sql"), "utf8");

function createD1Shim(db: DatabaseSync): D1Database {
  return {
    prepare(query: string) {
      const statement = db.prepare(query);
      return {
        bind(...parameters: SQLInputValue[]) {
          return {
            first: async <T,>() => {
              const row = statement.get(...parameters) as T | undefined;
              return row === undefined ? null : row;
            },
            all: async <T,>() => ({ results: (statement.all(...parameters) as T[]) ?? [] }),
            run: async () => {
              const result = statement.run(...parameters);
              return { meta: { changes: Number(result.changes) } };
            },
          };
        },
      };
    },
    async batch<T = unknown>(statements: D1PreparedStatement[]) {
      db.exec("BEGIN IMMEDIATE");
      try {
        const results = [] as Array<{ meta: { changes: number } }>;
        for (const statement of statements) {
          results.push(await (statement as unknown as { run(): Promise<{ meta: { changes: number } }> }).run());
        }
        db.exec("COMMIT");
        return results as unknown as D1Result<T>[];
      } catch (cause) {
        db.exec("ROLLBACK");
        throw cause;
      }
    },
  } as unknown as D1Database;
}

function freshDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE project(project_id TEXT PRIMARY KEY, generation INTEGER NOT NULL CHECK (generation > 0))");
  db.exec("CREATE TABLE project_owner(project_id TEXT PRIMARY KEY, principal_ref TEXT NOT NULL)");
  db.exec(MIGRATION);
  db.prepare("INSERT INTO project(project_id,generation) VALUES ('project-1',1)").run();
  db.prepare("INSERT INTO project_owner(project_id,principal_ref) VALUES ('project-1','owner-1')").run();
  return db;
}

async function bundle() {
  const semantic = canonicalModelGatewayJson({ protocol: "eliotr.research-semantic-config.v1", test: true });
  const semanticSha = await modelGatewaySha256(semantic);
  const transportPolicy = {
    version: 1,
    transport: "cloudflare-ai-gateway",
    api: "compat-chat-completions",
    provider: "zai",
    model: "glm-5.3-flash",
    billing: { mode: "unified" },
    capabilities: { max_output_tokens_field: "max_tokens", reasoning_efforts: ["low"] },
  } as const;
  return {
    protocol: RESEARCH_PROJECT_MODEL_CONFIGURATION_PROTOCOL,
    semantic_revision: { revision_ref: `scr-${semanticSha.slice(0, 12)}`, config_sha256: semanticSha },
    model_selections: [{
      stage: "SYNTHESIZE",
      route_ref: "dynamic/eliotr-balanced",
      route_version: "route-version-1",
      candidate_ref: "candidate-1",
      candidate_sha256: "a".repeat(64),
      qualification_ref: "qualification-1",
      qualification_sha256: "b".repeat(64),
      transport_policy: transportPolicy,
    }],
    vars: {
      ELIOTR_RESEARCH_SEMANTIC_CONFIG_JSON: semantic,
      ELIOTR_MODEL_PROFILE_DEFINITION_JSON: canonicalModelGatewayJson({ schema: "profile" }),
      ELIOTR_MODEL_PROFILE_PROVENANCE_REF: "profile-provenance-1",
      ELIOTR_MODEL_SPEND_POLICY_JSON: canonicalModelGatewayJson({ schema: "spend" }),
      ELIOTR_MODEL_SPEND_POLICY_PROVENANCE_REF: "spend-provenance-1",
      ELIOTR_RESEARCH_REPORT_CONFIG_JSON: canonicalModelGatewayJson({ schema: "report" }),
      ELIOTR_RESEARCH_REPORT_POLICY_PROVENANCE_REF: "report-provenance-1",
    },
  };
}

describe("research project model configuration store and 0106 migration", () => {
  it("stores immutable canonical revisions and advances the selected pointer with CAS", async () => {
    const db = freshDb();
    const store = createD1ResearchProjectModelConfigurationStore(createD1Shim(db), {
      now: () => "2026-10-03T12:00:00.000Z",
    });
    const input = await bundle();
    const first = await store.saveAndSelect({ owner_id: "owner-1", project_id: "project-1",
      expected_project_generation: 1, expected_revision: null, configuration: input });
    expect(first).toMatchObject({ selection_revision: 1, owner_id: "owner-1", project_id: "project-1" });
    expect(first.revision.configuration).toMatchObject(input);
    const second = await store.selectExisting({ owner_id: "owner-1", project_id: "project-1",
      expected_project_generation: 1, expected_revision: 1, configuration_ref: first.configuration_ref });
    expect(second.selection_revision).toBe(2);
    const lostAcknowledgementRetry = await store.saveAndSelect({ owner_id: "owner-1", project_id: "project-1",
      expected_project_generation: 1, expected_revision: 1, configuration: input });
    expect(lostAcknowledgementRetry.selection_revision).toBe(2);
    expect(lostAcknowledgementRetry.configuration_ref).toBe(first.configuration_ref);
    const staleImport = await bundle();
    const staleImportSelection = staleImport.model_selections[0];
    if (staleImportSelection === undefined) throw new Error("test bundle has no model selection");
    staleImport.model_selections[0] = { ...staleImportSelection, route_version: "route-version-stale" };
    await expect(store.saveAndSelect({ owner_id: "owner-1", project_id: "project-1",
      expected_project_generation: 1, expected_revision: 1, configuration: staleImport }))
      .rejects.toMatchObject({ code: "RESEARCH_PROJECT_MODEL_CONFIGURATION_CONFLICT", status: 409 });
    const revisionCount = db.prepare("SELECT COUNT(*) AS count FROM research_project_model_configuration_revision")
      .get() as { count: number };
    expect(revisionCount.count).toBe(1);
    await expect(store.selectExisting({ owner_id: "owner-1", project_id: "project-1",
      expected_project_generation: 1, expected_revision: null, configuration_ref: first.configuration_ref }))
      .rejects.toMatchObject({ code: "RESEARCH_PROJECT_MODEL_CONFIGURATION_CONFLICT", status: 409 });
    expect(() => db.prepare("UPDATE research_project_model_configuration_revision SET created_at='x'").run()).toThrow();
    expect(() => db.prepare("DELETE FROM research_project_model_configuration_revision").run()).toThrow();
    db.close();
  });

  it("fences revision and pointer writes on project generation and owner authority", async () => {
    const db = freshDb();
    const store = createD1ResearchProjectModelConfigurationStore(createD1Shim(db), {
      now: () => "2026-10-03T12:00:00.000Z",
    });
    const first = await store.saveAndSelect({ owner_id: "owner-1", project_id: "project-1",
      expected_project_generation: 1, expected_revision: null, configuration: await bundle() });
    const staleGenerationBundle = await bundle();
    const staleGenerationSelection = staleGenerationBundle.model_selections[0];
    if (staleGenerationSelection === undefined) throw new Error("test bundle has no model selection");
    staleGenerationBundle.model_selections[0] = { ...staleGenerationSelection, route_version: "route-version-after-precheck" };
    // Models a project-generation change after the service read its precheck
    // but before the D1 mutation batch begins.
    db.prepare("UPDATE project SET generation=2 WHERE project_id='project-1'").run();
    await expect(store.saveAndSelect({ owner_id: "owner-1", project_id: "project-1",
      expected_project_generation: 1, expected_revision: 1, configuration: staleGenerationBundle }))
      .rejects.toMatchObject({ code: "RESEARCH_PROJECT_MODEL_CONFIGURATION_CONFLICT", status: 409 });
    await expect(store.selectExisting({ owner_id: "owner-1", project_id: "project-1",
      expected_project_generation: 1, expected_revision: 1, configuration_ref: first.configuration_ref }))
      .rejects.toMatchObject({ code: "RESEARCH_PROJECT_MODEL_CONFIGURATION_CONFLICT", status: 409 });
    expect((db.prepare("SELECT COUNT(*) AS count FROM research_project_model_configuration_revision").get() as { count: number }).count)
      .toBe(1);
    expect(await store.readSelected("owner-1", "project-1")).toMatchObject({ selection_revision: 1,
      configuration_ref: first.configuration_ref });
    db.close();

    const ownerRemovedDb = freshDb();
    const ownerRemovedStore = createD1ResearchProjectModelConfigurationStore(createD1Shim(ownerRemovedDb), {
      now: () => "2026-10-03T12:00:00.000Z",
    });
    ownerRemovedDb.prepare("DELETE FROM project_owner WHERE project_id='project-1'").run();
    await expect(ownerRemovedStore.saveAndSelect({ owner_id: "owner-1", project_id: "project-1",
      expected_project_generation: 1, expected_revision: null, configuration: await bundle() }))
      .rejects.toMatchObject({ code: "RESEARCH_PROJECT_MODEL_CONFIGURATION_CONFLICT", status: 409 });
    expect((ownerRemovedDb.prepare("SELECT COUNT(*) AS count FROM research_project_model_configuration_revision").get() as { count: number }).count)
      .toBe(0);
    expect(await ownerRemovedStore.readSelected("owner-1", "project-1")).toBeNull();
    ownerRemovedDb.close();
  });

  it("rejects a malformed content-addressed ref in the SQL migration itself", () => {
    const db = freshDb();
    expect(() => db.prepare(`INSERT INTO research_project_model_configuration_revision
      (owner_id,project_id,configuration_ref,configuration_sha256,configuration_json,byte_length,protocol,created_at,created_by_principal_ref)
      VALUES ('owner-1','project-1','rpmc-${"g".repeat(64)}','${"a".repeat(64)}','{}',2,
        '${RESEARCH_PROJECT_MODEL_CONFIGURATION_PROTOCOL}','2026-10-03T12:00:00.000Z','owner-1')`).run())
      .toThrow();
    expect(() => db.prepare(`INSERT INTO research_project_model_configuration_revision
      (owner_id,project_id,configuration_ref,configuration_sha256,configuration_json,byte_length,protocol,created_at,created_by_principal_ref)
      VALUES ('owner-1','project-1','rpmc-${"b".repeat(64)}','${"a".repeat(64)}','{}',2,
        '${RESEARCH_PROJECT_MODEL_CONFIGURATION_PROTOCOL}','2026-10-03T12:00:00.000Z','owner-1')`).run())
      .toThrow();
    db.close();
  });
});
