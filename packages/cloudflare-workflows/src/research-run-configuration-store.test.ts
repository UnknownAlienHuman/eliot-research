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

function freshDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  for (const file of readdirSync(MIGRATIONS).sort().filter((name) => name.endsWith(".sql"))) {
    if (file > "0104_research_run_configuration.sql") break;
    db.exec(readFileSync(resolve(MIGRATIONS, file), "utf8"));
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
