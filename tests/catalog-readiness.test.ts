/// <reference types="node" />
import { DatabaseSync, type SQLInputValue, type SQLOutputValue } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readCatalog } from "../packages/cloudflare-navigation/src/catalog-service.js";
import { parseCatalogRequest } from "../packages/cloudflare-http-protocol/src/http-route-inputs.js";
import type { AuthenticatedRequestContext } from "../packages/interfaces/src/index.js";

const authority = vi.hoisted(() => ({ requireReadPolicy: vi.fn(), sources: vi.fn() }));
vi.mock("../packages/cloudflare-navigation/src/orientation-authority.js", async original => ({
  ...await original<Record<string, unknown>>(), createOwnerScopeAuthority: () => authority,
}));
let sqlite: DatabaseSync;
let open = false;
afterEach(() => { if (open) { sqlite.close(); open = false; } vi.restoreAllMocks(); });
const NOW = "2026-10-17T12:00:00.000Z";
const context = { request: new Request("https://owner.invalid/api/v1/research/catalog"), principal_ref: "owner",
  credential_generation: "credential", client_class: "owner_pwa" } as AuthenticatedRequestContext;

function fixture(count = 2) {
  authority.requireReadPolicy.mockReset().mockResolvedValue(undefined); authority.sources.mockReset();
  sqlite = new DatabaseSync(":memory:");
  open = true;
  sqlite.exec([
    "CREATE TABLE orientation_authority_epoch(singleton INTEGER,generation INTEGER); INSERT INTO orientation_authority_epoch VALUES(1,1);",
    "CREATE TABLE source(source_id TEXT,head_rev TEXT,title TEXT,source_namespace_id TEXT,source_owner_system_id TEXT,source_owner_generation TEXT);",
    "CREATE TABLE source_revision(source_revision_ref TEXT,source_id TEXT,source_owner_generation TEXT,purge_state TEXT,quality_state TEXT);",
    "CREATE TABLE source_namespace_ownership(source_namespace_id TEXT,status TEXT,owner_system_id TEXT,source_owner_generation TEXT);",
    "CREATE TABLE scope_read_policy(source_namespace_id TEXT,principal_ref TEXT,client_class TEXT,state TEXT,expires_at TEXT,disclosure_ceiling TEXT,allowed_use_json TEXT);",
    "CREATE TABLE source_admission_decision(source_revision_ref TEXT,decision TEXT,decision_receipt_ref TEXT,created_at TEXT,owner_system_id TEXT,source_namespace_id TEXT,source_owner_generation TEXT,expires_at TEXT,disclosure_ceiling TEXT,allowed_use_json TEXT);",
    "CREATE TABLE project(project_id TEXT,title TEXT,generation INTEGER);",
    "CREATE TABLE project_source_membership(project_id TEXT,source_id TEXT,valid_from TEXT,valid_to TEXT);",
    "CREATE TABLE source_readiness(source_revision_ref TEXT,channel TEXT,state TEXT,generation TEXT,receipt_ref TEXT,reason_codes_json TEXT,updated_at TEXT);",
    "INSERT INTO source_namespace_ownership VALUES('namespace','ACTIVE','system','owner-generation');",
    "INSERT INTO scope_read_policy VALUES('namespace','owner','owner_pwa','ACTIVE','2027-01-01T00:00:00Z','private','[\"research\"]');",
    "INSERT INTO project VALUES('project','Project',1);",
    "CREATE TRIGGER source_epoch AFTER UPDATE ON source BEGIN UPDATE orientation_authority_epoch SET generation=generation+1; END;",
    "CREATE TRIGGER policy_epoch AFTER UPDATE ON scope_read_policy BEGIN UPDATE orientation_authority_epoch SET generation=generation+1; END;",
    "CREATE TRIGGER revision_epoch AFTER UPDATE ON source_revision BEGIN UPDATE orientation_authority_epoch SET generation=generation+1; END;",
  ].join("\n"));
  for (let index = 0; index < count; index++) {
    const source = "source-" + String(index).padStart(3, "0"), ref = source + "-revision";
    sqlite.prepare("INSERT INTO source VALUES(?,?,?,'namespace','system','owner-generation')").run(source, ref, source);
    sqlite.prepare("INSERT INTO source_revision VALUES(?,?,'owner-generation','LIVE','standard')").run(ref, source);
    sqlite.prepare("INSERT INTO project_source_membership VALUES('project',?,'2026-01-01T00:00:00Z',NULL)").run(source);
    sqlite.prepare("INSERT INTO source_admission_decision VALUES(?,'ADMITTED',?,'2026-01-01T00:00:00Z','system','namespace','owner-generation',NULL,'private','[\"research\"]')").run(ref, "admission-" + index);
    for (const channel of ["exact_ready", "lexical_ready", "semantic_ready"]) {
      sqlite.prepare("INSERT INTO source_readiness VALUES(?,?,'queued',NULL,NULL,'[]','2026-10-16T10:00:00Z')").run(ref, channel);
    }
  }
  const state = { afterSources: () => {}, corrupt: (rows: Record<string, SQLOutputValue>[]) => rows };
  authority.sources.mockImplementation(async (refs: string[]) => {
    const result = refs.map(ref => {
      const row = sqlite.prepare("SELECT source_revision_ref,source_id,quality_state FROM source_revision WHERE source_revision_ref=?").get(ref);
      if (!row) throw new Error("Unadmitted source");
      return { revision: row };
    });
    state.afterSources(); return result;
  });
  const statement = (sql: string, values: unknown[] = []) => {
    const parameters = Object.fromEntries(values.map((value, index) => ["?" + (index + 1), value as SQLInputValue]));
    return { sql, bind: (...bound: unknown[]) => statement(sql, bound),
      first: async () => sqlite.prepare(sql).get(parameters) ?? null,
      all: async () => ({ success: true, results: sqlite.prepare(sql).all(parameters) }) };
  };
  const batch = vi.fn(async (statements: ReturnType<typeof statement>[]) => {
    sqlite.exec("BEGIN");
    try {
      const results = await Promise.all(statements.map(value => value.all()));
      if (results[2]) results[2].results = state.corrupt(results[2].results);
      sqlite.exec("COMMIT"); return results;
    } catch (error) { sqlite.exec("ROLLBACK"); throw error; }
  });
  const database = { prepare: (sql: string) => {
    if (!sql.trimStart().startsWith("SELECT") && !sql.trimStart().startsWith("WITH")) throw new Error("Read must not mutate D1");
    return statement(sql);
  }, batch } as unknown as D1Database;
  return { database, batch, state, read: (extra = {}) => readCatalog(database, context,
    { limit: 20, project_id: "project", readiness: "recorded-v1", ...extra }, "deploy", () => Date.parse(NOW)) };
}

describe("catalog recorded-readiness batch", () => {
  it("reads twenty summaries plus lookahead in one bounded batch and preserves cursor order", async () => {
    const nativeFetch = vi.spyOn(globalThis, "fetch");
    const f = fixture(25), before = sqlite.prepare("SELECT total_changes() AS n").get();
    const page = await f.read();
    expect(f.batch).toHaveBeenCalledTimes(1); expect(f.batch.mock.calls[0]?.[0]).toHaveLength(3);
    expect(page.sources).toHaveLength(20);
    expect(page.sources[0]?.readiness_summary).toMatchObject({ basis: "RECORDED_ONLY", scope: "SOURCE_PROJECTION",
      source_revision_ref: "source-000-revision", observed_at: NOW, channels: expect.arrayContaining([expect.objectContaining({state:"queued"})]) });
    const next = await f.read({ cursor: page.next_cursor });
    expect(next.sources.map(row => row.id)).toEqual(["source-020","source-021","source-022","source-023","source-024"]);
    expect(next.next_cursor).toBeUndefined();
    expect(sqlite.prepare("SELECT total_changes() AS n").get()).toEqual(before);
    expect(nativeFetch).not.toHaveBeenCalled();
  });
  it("keeps the legacy two-statement batch and exact source shape", async () => {
    const f = fixture();
    const page = await readCatalog(f.database, context, { limit:20 }, "deploy", () => Date.parse(NOW));
    expect(f.batch.mock.calls[0]?.[0]).toHaveLength(2);
    expect(page.sources[0]).toEqual({id:"source-000",title:"source-000",readiness_ref:"readiness:source-000:source-000-revision"});
  });
  it("keeps missing, stale, and receipt-backed ready observations distinct", async () => {
    const f = fixture(3);
    sqlite.exec("DELETE FROM source_readiness WHERE source_revision_ref='source-000-revision';" +
      "UPDATE source_readiness SET state='stale' WHERE source_revision_ref='source-001-revision';" +
      "UPDATE source_readiness SET state='ready',generation='generation',receipt_ref='receipt' WHERE source_revision_ref='source-002-revision'");
    const page = await f.read();
    expect(page.sources[0]?.readiness_summary?.channels).toEqual([]);
    expect(page.sources[1]?.readiness_summary?.channels.every(row => row.state === "stale")).toBe(true);
    expect(page.sources[2]?.readiness_summary?.channels.every(row => row.state === "ready" && row.receipt_ref === "receipt")).toBe(true);
  });
  it.each(["missing receipt", "bad reasons", "wrong revision", "duplicate channel", "oversize generation"])("rejects corrupt %s observations", async kind => {
    const f = fixture();
    if (kind === "missing receipt") sqlite.exec("UPDATE source_readiness SET state='ready'");
    else if (kind === "bad reasons") sqlite.exec("UPDATE source_readiness SET reason_codes_json='broken'");
    else if (kind === "oversize generation") sqlite.prepare("UPDATE source_readiness SET generation=?").run("x".repeat(257));
    else f.state.corrupt = rows => kind === "wrong revision"
      ? rows.map((row, index) => index ? row : {...row, source_revision_ref:"foreign-revision"})
      : [...rows, rows[0] as Record<string, SQLOutputValue>];
    await expect(f.read()).rejects.toMatchObject({code:"CATALOG_READINESS_INVALID"});
  });
  it("does not expose quarantined heads or borrow observations from an older revision", async () => {
    const f = fixture();
    sqlite.exec("UPDATE source_revision SET purge_state='QUARANTINED' WHERE source_id='source-001';" +
      "DELETE FROM source_readiness WHERE source_revision_ref='source-000-revision';" +
      "INSERT INTO source_readiness VALUES('old-revision','exact_ready','ready','generation','receipt','[]','2026-10-16T10:00:00Z')");
    const page = await f.read();
    expect(page.sources.map(row => row.id)).toEqual(["source-000"]);
    expect(page.sources[0]?.readiness_summary?.channels).toEqual([]);
  });
  it.each(["policy", "head", "purge"])("rejects %s changes after source authorization", async changed => {
    const f = fixture();
    f.state.afterSources = () => sqlite.exec(changed === "policy"
      ? "UPDATE scope_read_policy SET state='REVOKED'"
      : changed === "head" ? "UPDATE source SET head_rev='changed-revision'"
        : "UPDATE source_revision SET purge_state='QUARANTINED'");
    await expect(f.read()).rejects.toMatchObject({code:"CATALOG_AUTHORITY_CHANGED"});
  });
  it("accepts only the explicit opt-in without changing legacy parsed input", () => {
    const url = new URL("https://owner.invalid/api/v1/research/catalog?limit=20");
    expect(parseCatalogRequest(url)).toEqual({limit:20});
    url.searchParams.set("readiness","recorded-v1");
    expect(parseCatalogRequest(url)).toEqual({limit:20,readiness:"recorded-v1"});
    for (const mode of ["", "ready", "recorded-v2"]) {
      url.searchParams.set("readiness",mode); expect(() => parseCatalogRequest(url)).toThrow();
    }
    url.searchParams.set("readiness","recorded-v1"); url.searchParams.append("readiness","recorded-v1");
    expect(() => parseCatalogRequest(url)).toThrow();
  });
});

