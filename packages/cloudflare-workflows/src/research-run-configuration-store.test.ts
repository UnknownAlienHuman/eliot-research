/// <reference types="node" />
import { describe, expect, it } from "vitest";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { canonicalJson } from "@eliotr/platform-cloudflare";
import {
  createD1ResearchRunConfigurationStore,
  deriveResearchRunConfigurationRef,
  RESEARCH_RUN_CONFIGURATION_PROTOCOL,
} from "./research-run-configuration-store.js";

const MIGRATIONS = resolve(__dirname, "../../../infra/d1/core/migrations");

function freshDb(withProjectSelection = false): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  for (const file of readdirSync(MIGRATIONS).sort().filter((name) => name.endsWith(".sql"))) {
    if (file > (withProjectSelection ? "0106_research_project_model_configuration.sql" : "0104_research_run_configuration.sql")) break;
    db.exec(readFileSync(resolve(MIGRATIONS, file), "utf8"));
  }
  if (withProjectSelection) {
    db.prepare(`INSERT INTO project(project_id,title,default_disclosure,retention_policy_ref,default_source_policy_ref,
      default_model_profile_ref,default_depth_profile_ref,generation,created_at)
      VALUES ('project-pin','Pinned model','owner','retention-1','source-policy-1','profile-1','depth-1',1,'2026-10-03T12:00:00.000Z')`).run();
    db.prepare(`INSERT INTO project_owner(project_id,principal_ref,deployment_generation,created_at,updated_at)
      VALUES ('project-pin','owner-config-1','deployment-1','2026-10-03T12:00:00.000Z','2026-10-03T12:00:00.000Z')`).run();
  }
  return db;
}

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
            run: async () => { const result = statement.run(...parameters); return { meta: { changes: Number(result.changes) } }; },
          };
        },
      };
    },
  } as unknown as D1Database;
}

const association = Object.freeze({
  operation_id: "run-config-1",
  investigation_id: "research-config-1",
  principal_ref: "owner-config-1",
  deployment_generation: "deployment-1",
});

function snapshot(mode: "snapshot-v1" | "snapshot-v2" = "snapshot-v1", extra: Record<string, unknown> = {}): string {
  return canonicalJson({
    protocol: RESEARCH_RUN_CONFIGURATION_PROTOCOL,
    mode,
    association,
    project_configuration: null,
    model_selections: [],
    semantic: { source: "legacy-installed", config_json: "{}", revision_ref: null, config_sha256: "a".repeat(64) },
    model_profile: { config_json: "{}", provenance_ref: "profile-1" },
    spend_policy: { config_json: "{}", provenance_ref: "spend-1" },
    report: { config_json: "{}", provenance_ref: "report-1" },
    ...extra,
  });
}

const sha256 = (raw: string) => createHash("sha256").update(raw, "utf8").digest("hex");

describe("research run configuration store", () => {
  it("stores and reloads a canonical snapshot with exact association and digest", async () => {
    const db = freshDb();
    const store = createD1ResearchRunConfigurationStore(createD1Shim(db));
    const json = snapshot();
    const receipt = await store.putImmutable({ ...association, mode: "snapshot-v1", configuration_json: json,
      created_at: "2026-10-03T12:00:00.000Z" });
    const record = await store.getByOperation(association.operation_id);
    expect(receipt).toEqual({ configuration_ref: `rrc-${sha256(json).slice(0, 24)}`, configuration_sha256: sha256(json), created: true });
    expect(record).toMatchObject({ ...association, protocol: RESEARCH_RUN_CONFIGURATION_PROTOCOL,
      mode: "snapshot-v1", configuration_ref: receipt.configuration_ref, configuration_sha256: receipt.configuration_sha256,
      configuration_json: json, byte_length: new TextEncoder().encode(json).byteLength });
    await expect(store.getByReference(receipt.configuration_ref)).resolves.toEqual(record);
    db.close();
  });

  it("reuses identical writes and rejects a changed replay or association", async () => {
    const db = freshDb();
    const store = createD1ResearchRunConfigurationStore(createD1Shim(db));
    const firstJson = snapshot();
    const first = await store.putImmutable({ ...association, mode: "snapshot-v1", configuration_json: firstJson,
      created_at: "2026-10-03T12:00:00.000Z" });
    await expect(store.putImmutable({ ...association, mode: "snapshot-v1", configuration_json: firstJson,
      created_at: "2026-10-03T12:01:00.000Z" })).resolves.toMatchObject({
        configuration_ref: first.configuration_ref, configuration_sha256: first.configuration_sha256, created: false,
      });
    await expect(store.putImmutable({ ...association, mode: "snapshot-v1", configuration_json: snapshot("snapshot-v1", {
      model_profile: { config_json: "{\"changed\":true}", provenance_ref: "profile-1" },
    }) })).rejects.toMatchObject({ code: "RESEARCH_RUN_CONFIGURATION_CONFLICT" });
    await expect(store.putImmutable({ ...association, principal_ref: "owner-other", mode: "snapshot-v1",
      configuration_json: firstJson })).rejects.toMatchObject({ code: "RESEARCH_RUN_CONFIGURATION_INPUT_INVALID" });
    expect((db.prepare("SELECT COUNT(*) AS n FROM research_run_configuration").get() as { n: number }).n).toBe(1);
    db.close();
  });

  it("freezes only while the exact selected project configuration pointer is current", async () => {
    const db = freshDb(true);
    const store = createD1ResearchRunConfigurationStore(createD1Shim(db));
    const firstSha = "c".repeat(64);
    const firstRef = `rpmc-${firstSha}`;
    const secondSha = "d".repeat(64);
    const secondRef = `rpmc-${secondSha}`;
    const configurationRevision = (reference: string, sha: string) => {
      const json = "{}";
      db.prepare(`INSERT INTO research_project_model_configuration_revision
        (owner_id,project_id,configuration_ref,configuration_sha256,configuration_json,byte_length,protocol,created_at,created_by_principal_ref)
        VALUES ('owner-config-1','project-pin',?1,?2,?3,2,'eliotr.research-project-model-configuration.v1',
          '2026-10-03T12:00:00.000Z','owner-config-1')`).run(reference, sha, json);
    };
    configurationRevision(firstRef, firstSha);
    db.prepare(`INSERT INTO research_project_model_configuration_selection
      (owner_id,project_id,selection_revision,configuration_ref,configuration_sha256,selected_at,selected_by_principal_ref)
      VALUES ('owner-config-1','project-pin',2,?1,?2,'2026-10-03T12:00:00.000Z','owner-config-1')`).run(firstRef, firstSha);

    const guard = { owner_id: "owner-config-1", project_id: "project-pin", configuration_ref: firstRef,
      configuration_sha256: firstSha, selection_revision: 2 };
    const pinnedSnapshot = snapshot("snapshot-v1", { project_configuration: {
      configuration_ref: firstRef, configuration_sha256: firstSha, selection_revision: 2,
      owner_ref: guard.owner_id, project_id: guard.project_id,
    } });
    await expect(store.putImmutable({ ...association, mode: "snapshot-v1", configuration_json: pinnedSnapshot,
      selection_guard: guard, created_at: "2026-10-03T12:00:00.000Z" })).resolves.toMatchObject({ created: true });

    configurationRevision(secondRef, secondSha);
    db.prepare(`UPDATE research_project_model_configuration_selection
      SET selection_revision=selection_revision+1,configuration_ref=?1,configuration_sha256=?2
      WHERE owner_id='owner-config-1' AND project_id='project-pin'`).run(secondRef, secondSha);
    const staleSnapshot = snapshot("snapshot-v1", { ...JSON.parse(pinnedSnapshot) as Record<string, unknown>,
      association: { ...association, operation_id: "run-config-stale" } });
    await expect(store.putImmutable({ ...association, operation_id: "run-config-stale", mode: "snapshot-v1",
      configuration_json: staleSnapshot, selection_guard: guard,
      created_at: "2026-10-03T12:01:00.000Z" })).rejects.toMatchObject({
        code: "RESEARCH_RUN_CONFIGURATION_SELECTION_STALE",
      });
    expect((db.prepare("SELECT COUNT(*) AS n FROM research_run_configuration").get() as { n: number }).n).toBe(1);
    db.close();
  });

  it("freezes the installed Cloudflare model only while every captured global qualification remains active", async () => {
    const db = freshDb(true);
    const store = createD1ResearchRunConfigurationStore(createD1Shim(db));
    const expectedModelId = "@cf/meta/llama-3.1-8b-instruct";
    const makeSelection = (stage: string, suffix: string, model: string) => {
      const route_ref = `route-${suffix}`;
      const route_version = `version-${suffix}`;
      const candidate_ref = `candidate-${suffix}`;
      const candidate_sha256 = suffix === "synthesis" ? "e".repeat(64) : "f".repeat(64);
      const qualification_ref = `qualification-${suffix}`;
      const qualification_sha256 = suffix === "synthesis" ? "1".repeat(64) : "2".repeat(64);
      db.prepare(`INSERT INTO dynamic_route_candidate
        (candidate_ref,route_ref,route_version,candidate_sha256,candidate_json,staged_at)
        VALUES (?1,?2,?3,?4,'{}','2026-10-03T12:00:00.000Z')`)
        .run(candidate_ref, route_ref, route_version, candidate_sha256);
      db.prepare(`INSERT INTO dynamic_route_active_generation
        (route_ref,route_version,candidate_ref,candidate_sha256,promotion_ref,promoted_at)
        VALUES (?1,?2,?3,?4,?5,'2026-10-03T12:00:00.000Z')`)
        .run(route_ref, route_version, candidate_ref, candidate_sha256, `promotion-${suffix}`);
      const qualificationJson = JSON.stringify({ qualification: { tier: "LIVE" } });
      db.prepare(`INSERT INTO dynamic_route_qualification_proof
        (qualification_ref,proof_sha256,qualification_json,route_ref,route_version,candidate_ref,candidate_sha256,created_at)
        VALUES (?1,?2,?3,?4,?5,?6,?7,'2026-10-03T12:00:00.000Z')`)
        .run(qualification_ref, qualification_sha256, qualificationJson, route_ref, route_version,
          candidate_ref, candidate_sha256);
      db.prepare(`INSERT INTO dynamic_route_active_qualification
        (route_ref,route_version,candidate_ref,candidate_sha256,qualification_ref,qualification_sha256,activated_at)
        VALUES (?1,?2,?3,?4,?5,?6,'2026-10-03T12:00:00.000Z')`)
        .run(route_ref, route_version, candidate_ref, candidate_sha256, qualification_ref, qualification_sha256);
      return { stage, route_ref, route_version, candidate_ref, candidate_sha256, qualification_ref,
        qualification_sha256, transport_policy: { provider: "workers-ai", model } };
    };
    const selections = [
      makeSelection("SYNTHESIZE", "synthesis", expectedModelId),
      makeSelection("AUDIT_CLAIMS", "audit", "@cf/meta/llama-3.1-8b-instruct-fast"),
    ];
    const baseJson = snapshot("snapshot-v2", { project_configuration: null, model_selections: selections });
    const guard = { expected_model_id: expectedModelId };
    await expect(store.putImmutable({ ...association, mode: "snapshot-v2", configuration_json: baseJson,
      installed_native_model_guard: guard, created_at: "2026-10-03T12:00:00.000Z" }))
      .resolves.toMatchObject({ created: true });

    db.prepare(`INSERT INTO dynamic_route_qualification_revocation
      (qualification_ref,qualification_sha256,reason,revoked_by,revoked_at)
      VALUES ('qualification-synthesis',?1,'qualification revoked','operator-1','2026-10-03T12:01:00.000Z')`)
      .run("1".repeat(64));
    const replayJson = snapshot("snapshot-v2", {
      ...JSON.parse(baseJson) as Record<string, unknown>,
      association: { ...association, operation_id: "run-config-native-revoked" },
    });
    await expect(store.putImmutable({ ...association, operation_id: "run-config-native-revoked",
      mode: "snapshot-v2", configuration_json: replayJson, installed_native_model_guard: guard,
      created_at: "2026-10-03T12:01:00.000Z" })).rejects.toMatchObject({
        code: "RESEARCH_RUN_CONFIGURATION_SELECTION_STALE",
      });
    expect((db.prepare("SELECT COUNT(*) AS n FROM research_run_configuration").get() as { n: number }).n).toBe(1);
    db.close();
  });

  it("rejects noncanonical, oversized, credential-bearing and malformed snapshots", async () => {
    const db = freshDb();
    const store = createD1ResearchRunConfigurationStore(createD1Shim(db));
    const valid = JSON.parse(snapshot()) as Record<string, unknown>;
    await expect(store.putImmutable({ ...association, mode: "snapshot-v1",
      configuration_json: JSON.stringify({ reordered: true, ...valid }) }))
      .rejects.toMatchObject({ code: "RESEARCH_RUN_CONFIGURATION_INPUT_INVALID" });
    await expect(store.putImmutable({ ...association, mode: "snapshot-v1", configuration_json: snapshot("snapshot-v1", {
      gateway_token: "never-store-this",
    }) })).rejects.toMatchObject({ code: "RESEARCH_RUN_CONFIGURATION_INPUT_INVALID" });
    await expect(store.putImmutable({ ...association, mode: "snapshot-v1", configuration_json: snapshot("snapshot-v1", {
      padding: "x".repeat(530_000),
    }) })).rejects.toMatchObject({ code: "RESEARCH_RUN_CONFIGURATION_INPUT_INVALID" });
    await expect(store.putImmutable({ ...association, mode: "snapshot-v1", configuration_json: "not-json" }))
      .rejects.toMatchObject({ code: "RESEARCH_RUN_CONFIGURATION_INPUT_INVALID" });
    db.close();
  });

  it("fails closed on row tamper and binds the workflow pointer to the exact snapshot association", async () => {
    const db = freshDb();
    const store = createD1ResearchRunConfigurationStore(createD1Shim(db));
    const json = snapshot();
    const receipt = await store.putImmutable({ ...association, mode: "snapshot-v1", configuration_json: json,
      created_at: "2026-10-03T12:00:00.000Z" });

    db.exec("DROP TRIGGER research_run_configuration_no_update");
    const tampered = snapshot("snapshot-v1", { marker: "tampered" });
    db.prepare("UPDATE research_run_configuration SET configuration_json=?1,byte_length=?2 WHERE operation_id=?3")
      .run(tampered, new TextEncoder().encode(tampered).byteLength, association.operation_id);
    await expect(store.getByOperation(association.operation_id)).rejects.toMatchObject({
      code: "RESEARCH_RUN_CONFIGURATION_CONFLICT",
    });
    db.prepare("UPDATE research_run_configuration SET configuration_json=?1,byte_length=?2 WHERE operation_id=?3")
      .run(json, new TextEncoder().encode(json).byteLength, association.operation_id);
    db.exec("CREATE TRIGGER research_run_configuration_no_update BEFORE UPDATE ON research_run_configuration BEGIN SELECT RAISE(ABORT,'RESEARCH_RUN_CONFIGURATION_IMMUTABLE'); END");

    db.exec("PRAGMA foreign_keys=OFF; DROP TRIGGER research_workflow_run_initial_shape; DROP TRIGGER research_workflow_run_authority;");
    db.prepare(`INSERT INTO research_workflow_run
      (operation_id,investigation_id,initial_revision,current_revision,principal_ref,credential_generation,
       deployment_generation,policy_generation,policy_authority_ref,authorization_receipt_ref,scope_snapshot_id,
       scope_snapshot_revision,purge_revision,idempotency_key,handler_generation,initial_manifest_json,created_at)
      VALUES (?1,?2,1,1,?3,'credential-1',?4,'policy-1','authority-1','receipt-1','scope-1',1,0,'idem-1','handler-1',?5,'2026-10-03T12:00:00.000Z')`)
      .run(association.operation_id, association.investigation_id, association.principal_ref,
        association.deployment_generation, canonicalJson({ object_ref: "payload-1", sha256: "b".repeat(64) }));
    db.prepare("UPDATE research_workflow_run SET configuration_ref=?1 WHERE operation_id=?2")
      .run(receipt.configuration_ref, association.operation_id);
    expect((db.prepare("SELECT configuration_ref FROM research_workflow_run WHERE operation_id=?1")
      .get(association.operation_id) as { configuration_ref: string }).configuration_ref).toBe(receipt.configuration_ref);
    expect(() => db.prepare("UPDATE research_workflow_run SET configuration_ref=NULL WHERE operation_id=?1")
      .run(association.operation_id)).toThrow();
    expect(() => db.prepare("UPDATE research_workflow_run SET configuration_ref='rrc-eeeeeeeeeeeeeeeeeeeeeeee' WHERE operation_id=?1")
      .run(association.operation_id)).toThrow();
    db.close();
  });

  it("derives only the content-addressed short reference", () => {
    const digest = "ab".repeat(32);
    expect(deriveResearchRunConfigurationRef(digest)).toBe(`rrc-${"ab".repeat(12)}`);
    expect(() => deriveResearchRunConfigurationRef("bad")).toThrow();
  });
});
