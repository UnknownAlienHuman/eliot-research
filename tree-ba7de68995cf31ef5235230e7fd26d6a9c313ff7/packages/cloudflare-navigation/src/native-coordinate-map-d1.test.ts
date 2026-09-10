/// <reference types="node" />
/// <reference types="vite/client" />
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import type { ScopeSnapshot, SourceRevision } from "@eliotr/contracts";
import type { AdmittedCoordinateMap } from "@eliotr/cloudflare-evidence";
import { scopeSnapshotDigestPayload, scopeSnapshotIdentityPayload } from "@eliotr/domain";
import { canonicalEvidenceJson, createD1NavigationStore, evidenceSha256, evidenceSha256Bytes, evidenceUtf8Bytes } from "@eliotr/cloudflare-evidence";
import { describe, expect, it } from "vitest";
import m0001 from "../../../infra/d1/core/migrations/0001_initial.sql?raw";
import m0002 from "../../../infra/d1/core/migrations/0002_execution_coordination.sql?raw";
import m0003 from "../../../infra/d1/core/migrations/0003_delivery_inbox_payload_digest.sql?raw";
import m0004 from "../../../infra/d1/core/migrations/0004_outbox_delivery_fence.sql?raw";
import m0005 from "../../../infra/d1/core/migrations/0005_ingest_admission.sql?raw";
import m0006 from "../../../infra/d1/core/migrations/0006_projection_execution.sql?raw";
import m0007 from "../../../infra/d1/core/migrations/0007_evidence_resolution.sql?raw";
import m0008 from "../../../infra/d1/core/migrations/0008_erasure_closure.sql?raw";
import m0009 from "../../../infra/d1/core/migrations/0009_federation_authority.sql?raw";
import m0010 from "../../../infra/d1/core/migrations/0010_navigation_artifacts.sql?raw";
import { materializeStructuralNavigation, extractNavigationSections } from "@eliotr/retrieval";
import { persistCoordinateMap } from "./native-coordinate-map-adapter.js";

const NOW = "2026-09-09T00:00:00.000Z";
const HEX = (value: string): string => value.repeat(64);

function d1(database: DatabaseSync): D1Database {
  return {
    prepare(sql: string) {
      const statement = database.prepare(sql);
      const bind = (...values: unknown[]) => ({
        async all<T>() { return { success: true, results: statement.all(...values as SQLInputValue[]) as T[] }; },
        async first<T>() { return (statement.get(...values as SQLInputValue[]) as T | undefined) ?? null; },
        async run<T>() { statement.run(...values as SQLInputValue[]); return { success: true, results: [] as T[] }; },
      });
      return { bind, ...bind() };
    },
    async batch(statements: D1PreparedStatement[]) {
      for (const statement of statements) await statement.run();
      return [];
    },
  } as unknown as D1Database;
}

async function snapshot(): Promise<ScopeSnapshot> {
  const material = {
    revision: 1,
    resolved_scope_expression: { kind: "SELECTED_SOURCES" as const, source_ids: ["source-1"] },
    participant_generations: { "member-policy-closure": "generation-1" },
    member_source_revision_refs: ["revision-1"],
    source_owner_generations: { "revision-1": "generation-1" },
    policy_authority_ref: "policy-authority-1",
    disclosure_closure_digest: HEX("e"),
    purge_ledger_revision: 0,
    created_at: NOW,
    expires_at: "2027-09-09T00:00:00.000Z",
  };
  const snapshotId = `scope-${(await evidenceSha256(scopeSnapshotIdentityPayload(material))).slice(0, 48)}`;
  return {
    snapshot_id: snapshotId,
    ...material,
    digest: await evidenceSha256(scopeSnapshotDigestPayload({ snapshot_id: snapshotId, ...material })),
  };
}

async function setup(source: SourceRevision, scope: ScopeSnapshot): Promise<{ database: DatabaseSync; core: D1Database }> {
  const database = new DatabaseSync(":memory:");
  for (const migration of [m0001, m0002, m0003, m0004, m0005, m0006, m0007, m0008, m0009, m0010]) database.exec(migration);
  const core = d1(database);
  const decision = {
    source_namespace_id: "namespace-1", owner_system_id: "owner-1", source_owner_generation: "generation-1",
    source_revision_ref: "revision-1", origin_authentication_receipt_ref: "origin-1", source_class: "document",
    assurance_ceiling: "CAPTURED", instruction_taint: "DATA_ONLY", allowed_effects: "READ_ONLY",
    object_residency_key_digest: "b".repeat(64), allowed_use: ["research"], disclosure_ceiling: "owner-only",
    license_policy_ref: "license-1", decision: "ADMITTED", reason_codes: [], decision_receipt_ref: "decision-1",
  } as const;
  const decisionJson = canonicalEvidenceJson(decision);
  const decisionDigest = await evidenceSha256(decision);
  database.exec(`
    INSERT INTO source_namespace_ownership VALUES ('namespace-1',1,'owner-1','incarnation-1','generation-1',1,'ACTIVE',NULL,'${NOW}');
    INSERT INTO source VALUES ('source-1','namespace-1','owner-1','generation-1','immutable_import','document',NULL,'Fixture','storage-1','profile-1','document','license-1','retention-1',NULL,'${NOW}');
    INSERT INTO source_revision VALUES ('revision-1','source-1','generation-1','${source.content_sha256}','${"b".repeat(64)}',NULL,'manifest-key','${NOW}','parser-1','standard','LIVE','current_confirmed','view-1',NULL,'${NOW}');
    INSERT INTO bundle_ingest_operation (operation_id,principal_ref,origin_authentication_receipt_ref,idempotency_key,input_fingerprint,manifest_sha256,manifest_json,file_hashes_json,total_bytes,source_namespace_id,owner_system_id,source_owner_generation,source_revision_ref,source_id,expected_head_revision_ref,residency_key_json,residency_key_digest,policy_revision,policy_snapshot_json,policy_snapshot_sha256,candidate_id,staging_session_ref,qualification_report_ref,decision_receipt_ref,promotion_receipt_ref,state,bundle_receipt_json,bundle_receipt_sha256,created_at,updated_at,expires_at)
      VALUES ('operation-1','principal-1','origin-1','idempotency-1','${HEX("1")}','${HEX("2")}','{}','{}',1,'namespace-1','owner-1','generation-1','revision-1','source-1',NULL,'{}','${HEX("b")}',1,'{}','${HEX("3")}','candidate-1',NULL,NULL,NULL,NULL,'AUTHORIZED',NULL,NULL,'${NOW}','${NOW}','2027-09-09T00:00:00.000Z');
    INSERT INTO source_admission_decision VALUES ('decision-1','operation-1','namespace-1','owner-1','generation-1','revision-1','origin-1','document','CAPTURED','DATA_ONLY','READ_ONLY','${HEX("b")}','["research"]','owner-only','license-1',NULL,'ADMITTED','[]','${decisionJson}','${decisionDigest}','${NOW}');
    INSERT INTO scope_snapshot VALUES ('${scope.snapshot_id}',1,'${JSON.stringify(scope.resolved_scope_expression)}','${JSON.stringify(scope.participant_generations)}','["revision-1"]','${JSON.stringify(scope.source_owner_generations)}','policy-authority-1','${scope.disclosure_closure_digest}',0,NULL,'${scope.digest}','${NOW}','2027-09-09T00:00:00.000Z',NULL,NULL);
    INSERT INTO scope_access_grant VALUES ('${scope.snapshot_id}',1,'principal-1','owner_pwa','credential-1','policy-authority-1','["research"]','owner-only','authorization-1','ACTIVE','2027-09-09T00:00:00.000Z','${NOW}');
  `);
  return { database, core };
}

describe("admitted native coordinate map D1 persistence", () => {
  it("reads authority-backed source data and persists one immutable DocumentMap", async () => {
    const markdown = "# Heading\n\nCell text\n";
    const contentDigest = await evidenceSha256Bytes(evidenceUtf8Bytes(markdown));
    const source: SourceRevision = {
      source_revision_ref: "revision-1", source_id: "source-1", source_namespace_id: "namespace-1",
      source_owner_system_id: "owner-1", source_owner_generation: "generation-1", ownership_mode: "immutable_import",
      content_sha256: contentDigest, object_residency_key_digest: HEX("b"), normalized_artifact_ref: "manifest-key",
      captured_at: NOW, parser_profile_generation: "parser-1", quality_state: "standard", purge_state: "LIVE",
    };
    const scope = await snapshot();
    const { database, core } = await setup(source, scope);
    const structural = (await materializeStructuralNavigation({
      source_revision: source, normalized_markdown: markdown, generator_generation: "structural-v1", created_at: NOW,
    })).documentMap;
    const section = extractNavigationSections(structural).find((entry) => entry.label === "Heading");
    if (section?.normalized_start_byte === undefined || section.normalized_end_byte === undefined) throw new Error("section bounds missing");
    const admitted = {
      map: {
        protocol: "eliotr.coordinate-map.v1", source_owner_system_id: "owner-1", source_namespace_id: "namespace-1",
        source_owner_generation: "generation-1", source_logical_id: "source-1", source_revision_ref: "revision-1",
        source_content_sha256: contentDigest, normalized_content_path: "content.md", precision_ceiling: "table_cell",
        generator_generation: "coordinate-v1", created_at: NOW,
        entries: [{ anchor: { kind: "table_cell", table_id: "table-1", row: 0, column: 0 },
          normalized_start_byte: section.normalized_start_byte + 2, normalized_end_byte: section.normalized_end_byte - 1,
          excerpt_sha256: "a".repeat(64), section_ref: section.section_ref }],
      },
      map_object_ref: "map-object-key", map_sha256: "c".repeat(64), map_object_residency_key_digest: "d".repeat(64),
    } as unknown as AdmittedCoordinateMap;
    const store = createD1NavigationStore({
      database: core, scope_snapshot: scope,
      access: { principal_ref: "principal-1", client_class: "owner_pwa", credential_generation: "credential-1" },
      require_current: async (requested) => requested,
      now: () => Date.parse(NOW),
    });
    const first = await persistCoordinateMap({ store, source_revision: source, structural_map: structural,
      admitted_map: admitted, generator_generation: "coordinate-v1", created_at: NOW });
    const second = await persistCoordinateMap({ store, source_revision: source, structural_map: structural,
      admitted_map: admitted, generator_generation: "coordinate-v1", created_at: NOW });
    expect(second.map_ref).toEqual(first.map_ref);
    expect(database.prepare("SELECT count(*) AS count FROM navigation_artifact").get()).toEqual({ count: 1 });
    expect(first.mappings_to_original_ref).toBe("map-object-key");
    database.close();
  });
});
