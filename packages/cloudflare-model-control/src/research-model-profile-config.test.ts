import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { describe, expect, it } from "vitest";
import type { ScopeSnapshot } from "@eliotr/contracts";
import type { NavigationReadAuthority } from "@eliotr/cloudflare-evidence";
import { createPersistedModelProfileCurrentAuthorityReader } from "./research-model-profile-config.js";

const scope: ScopeSnapshot = {
  snapshot_id: "scope-1",
  revision: 1,
  resolved_scope_expression: { kind: "SELECTED_SOURCES", source_ids: ["source-1"] },
  participant_generations: { owner: "owner-generation-1" },
  member_source_revision_refs: ["source-1:1"],
  source_owner_generations: { "source-1": "owner-generation-1" },
  policy_authority_ref: "policy-authority-1",
  disclosure_closure_digest: "a".repeat(64),
  purge_ledger_revision: 0,
  digest: "b".repeat(64),
  created_at: "2026-10-06T00:00:00.000Z",
  expires_at: "2026-10-07T00:00:00.000Z",
};

function authorityDatabase(): { readonly database: D1Database; close(): void } {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(`
    CREATE TABLE research_workflow_current (
      operation_id TEXT, investigation_id TEXT, state TEXT, principal_ref TEXT,
      credential_generation TEXT, deployment_generation TEXT, policy_generation TEXT,
      policy_authority_ref TEXT, scope_snapshot_id TEXT, scope_snapshot_revision INTEGER,
      current_revision INTEGER, ledger_revision INTEGER, authorization_receipt_ref TEXT,
      next_stage_index INTEGER
    ) STRICT;
    CREATE TABLE investigation_ledger_head (investigation_id TEXT, model_profile_ref TEXT) STRICT;
    CREATE TABLE scope_snapshot (snapshot_id TEXT, revision INTEGER, expires_at TEXT) STRICT;
    CREATE TABLE scope_access_grant (
      snapshot_id TEXT, snapshot_revision INTEGER, principal_ref TEXT, credential_generation TEXT,
      policy_authority_ref TEXT, authorization_receipt_ref TEXT, expires_at TEXT
    ) STRICT;
    CREATE TABLE research_workflow_attempt (
      operation_id TEXT, stage_index INTEGER, state TEXT, output_json TEXT, budget_expires_at_ms INTEGER
    ) STRICT;
    INSERT INTO research_workflow_current VALUES (
      'operation-1','investigation-1','ACTIVE','principal-1','credential-1','deployment-1',
      'policy-generation-1','policy-authority-1','scope-1',1,11,11,'authorization-1',10
    );
    INSERT INTO investigation_ledger_head VALUES ('investigation-1','research-model-v1');
    INSERT INTO scope_snapshot VALUES ('scope-1',1,'2026-10-07T00:00:00.000Z');
    INSERT INTO scope_access_grant VALUES (
      'scope-1',1,'principal-1','credential-1','policy-authority-1','authorization-1',
      '2026-10-07T00:00:00.000Z'
    );
    INSERT INTO research_workflow_attempt VALUES ('operation-1',10,'STARTED',NULL,1791277375960);
  `);
  const database = {
    prepare(sql: string) {
      const statement = sqlite.prepare(sql);
      return {
        bind(...values: unknown[]) {
          const parameters = values as SQLInputValue[];
          return {
            async first<T>(): Promise<T | null> {
              return (statement.get(...parameters) as T | undefined) ?? null;
            },
          } as unknown as D1PreparedStatement;
        },
      } as unknown as D1PreparedStatement;
    },
  } as unknown as D1Database;
  return { database, close: () => sqlite.close() };
}

describe("persisted model-profile authority reader", () => {
  it("maps the live W2 budget column into the snapshot-v2 authority field", async () => {
    const { database, close } = authorityDatabase();
    const grant = {
      authorization_receipt_ref: "authorization-1",
      policy_authority_ref: "policy-authority-1",
      allowed_use: ["research"],
      disclosure_ceiling: "owner-authorized",
      expires_at: "2026-10-07T00:00:00.000Z",
    };
    const navigation = {
      scope,
      access: { principal_ref: "principal-1", client_class: "owner_pwa", credential_generation: "credential-1" },
      current: async () => grant,
    } as unknown as NavigationReadAuthority;
    try {
      const authority = await createPersistedModelProfileCurrentAuthorityReader({
        database,
        navigation,
        operation_id: "operation-1",
        investigation_id: "investigation-1",
        principal: {
          principal_ref: "principal-1",
          credential_generation: "credential-1",
          deployment_generation: "deployment-1",
        },
      })();
      expect(authority.run_budget_expires_at_ms).toBe(1791277375960);
    } finally {
      close();
    }
  });
});
