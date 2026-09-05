import { beforeAll, describe, expect, it } from "vitest";
import { canonicalEvidenceJson, evidenceSha256 } from "@eliotr/cloudflare-evidence";
import type { SourceAdmissionDecision } from "@eliotr/contracts";
import type { AuthenticatedRequestContext, SourceRevisionsResult } from "@eliotr/interfaces";
import { handleHttp } from "../src/http.js";
import { readSourceRevisions } from "../src/source-revisions.js";
import { decodeSourceRevisions } from "../../eliotr-pwa/src/source-revisions-api.js";
import { db, insert, observeDatabase, principal, runtime, seedSource, setupOrientationDatabase, verifier } from "./orientation-fixture.js";

beforeAll(setupOrientationDatabase);
const getRequest = (source: string, query = "") => new Request(`https://research.example/api/v1/library/revisions?source_id=${encodeURIComponent(source)}${query}`);
const context = (source: string, signal?: AbortSignal): AuthenticatedRequestContext => ({
  request: new Request(getRequest(source), signal ? { signal } : {}), principal_ref: principal,
  credential_generation: "credential-v1", client_class: "owner_pwa", trace_id: "revision-test",
});
async function get(source: string, query = "", database = db, who = principal) {
  const response = await handleHttp(getRequest(source, query), { ...runtime, CORE_DB: database }, {} as ExecutionContext, { accessVerifier: verifier(who) });
  const envelope = await response.json() as { data?: SourceRevisionsResult; code?: string };
  return { response, envelope };
}
async function history(source: string, ref: string, admitted = "2026-08-20T12:00:00.000Z") {
  const original = await db.prepare("SELECT * FROM source_revision WHERE source_revision_ref=?1").bind(`rev-${source}`).first<Record<string, string | number | null>>();
  const op = await db.prepare("SELECT * FROM bundle_ingest_operation WHERE source_revision_ref=?1").bind(`rev-${source}`).first<Record<string, string | number | null>>();
  const receipt = await db.prepare("SELECT * FROM source_admission_decision WHERE source_revision_ref=?1").bind(`rev-${source}`).first<Record<string, string | number | null>>();
  if (!original || !op || !receipt) throw new Error("Missing test authority");
  await insert("source_revision", { ...original, source_revision_ref: ref, admitted_at: admitted });
  await insert("bundle_ingest_operation", { ...op, operation_id: `op-${ref}`, source_revision_ref: ref,
    idempotency_key: `key-${ref}`, candidate_id: `candidate-${ref}` });
  const decision = JSON.parse(String(receipt.decision_json)) as SourceAdmissionDecision;
  const changed = { ...decision, source_revision_ref: ref, decision_receipt_ref: `decision-${ref}` };
  await insert("source_admission_decision", { ...receipt, source_revision_ref: ref, operation_id: `op-${ref}`,
    decision_receipt_ref: changed.decision_receipt_ref, decision_json: canonicalEvidenceJson(changed), decision_sha256: await evidenceSha256(changed) });
}
async function ready(ref: string, channel: string, state: string, fields: Record<string, string | null> = {}) {
  await insert("source_readiness", { source_revision_ref: ref, channel, state, generation: "projection-1", receipt_ref: "receipt-1",
    reason_codes_json: "[]", updated_at: "2026-08-20T12:00:00.000Z", ...fields });
}

describe("owner revision history through actual HTTP and local D1", () => {
  it("paginates immutable permitted revisions newest-admission-first with deterministic ties", async () => {
    await seedSource("history-page"); await history("history-page", "old-page-a"); await history("history-page", "old-page-b");
    const first = await get("history-page", "&limit=1");
    expect(first.response.status, JSON.stringify(first.envelope)).toBe(200);
    expect(first.envelope.data?.revisions.map((row) => row.source_revision_ref)).toEqual(["rev-history-page"]);
    expect(first.envelope.data?.head_revision_ref).toBe("rev-history-page");
    const second = await get("history-page", `&limit=1&cursor=${first.envelope.data?.next_cursor}`);
    expect(second.envelope.data?.revisions.map((row) => row.source_revision_ref)).toEqual(["old-page-b"]);
    const third = await get("history-page", `&limit=1&cursor=${second.envelope.data?.next_cursor}`);
    expect(third.envelope.data?.revisions.map((row) => row.source_revision_ref)).toEqual(["old-page-a"]);
    expect(third.envelope.data?.next_cursor).toBeUndefined();
    expect(first.response.headers.get("cache-control")).toBe("no-store");
  });
  it("uses real admission timestamps including timezone offsets, not lexical timestamp order", async () => {
    await seedSource("history-time-order");
    await history("history-time-order", "offset-older", "2026-08-20T14:00:00+03:00");
    await history("history-time-order", "offset-newer", "2026-08-20T12:00:00Z");
    const first = await get("history-time-order", "&limit=2");
    expect(first.envelope.data?.revisions.map((row) => row.source_revision_ref)).toEqual(["rev-history-time-order", "offset-newer"]);
    const second = await get("history-time-order", `&limit=2&cursor=${first.envelope.data?.next_cursor}`);
    expect(second.envelope.data?.revisions.map((row) => row.source_revision_ref)).toEqual(["offset-older"]);
  });
  it("returns recorded channel states and provenance without inventing missing readiness or probing indexes", async () => {
    await seedSource("history-readiness");
    await ready("rev-history-readiness", "lexical_ready", "ready");
    await ready("rev-history-readiness", "semantic_ready", "degraded", { generation: null, receipt_ref: null,
      reason_codes_json: '["AI_SEARCH_UNAVAILABLE"]' });
    const before = await db.prepare("SELECT COUNT(*) AS n FROM source_readiness").first("n");
    const result = await get("history-readiness");
    expect(result.response.status, JSON.stringify(result.envelope)).toBe(200);
    const page = decodeSourceRevisions(result.envelope, "history-readiness", runtime.DEPLOYMENT_GENERATION);
    expect(page.readiness_basis).toBe("RECORDED_ONLY");
    expect(page.revisions[0]?.readiness.map((row) => [row.channel, row.state])).toEqual([["lexical_ready", "ready"], ["semantic_ready", "degraded"]]);
    expect(page.revisions[0]?.readiness[0]?.receipt_ref).toBe("receipt-1");
    expect(page.revisions[0]?.readiness.some((row) => row.channel === "exact_ready")).toBe(false);
    expect(await db.prepare("SELECT COUNT(*) AS n FROM source_readiness").first("n")).toBe(before);
  });
  it("does not infer readiness from an admitted head or change durable state while reading", async () => {
    await seedSource("history-no-state");
    const before = await db.prepare("SELECT generation FROM orientation_authority_epoch").first("generation");
    const result = await get("history-no-state");
    expect(result.envelope.data?.revisions[0]?.readiness).toEqual([]);
    expect(await db.prepare("SELECT generation FROM orientation_authority_epoch").first("generation")).toBe(before);
  });
  it("withholds foreign and unknown sources identically, despite a guessed source ID", async () => {
    await seedSource("history-hidden", false); await seedSource("history-visible");
    const hidden = await get("history-hidden"); const absent = await get("history-absent");
    expect(hidden.response.status).toBe(404); expect(hidden.envelope.code).toBe(absent.envelope.code);
    expect(hidden.envelope.data).toBeUndefined();
    expect((await get("history-visible", "", db, "other-principal")).response.status).toBe(403);
  });
  it("excludes purged, quarantined and inactive-owner historical revisions without disclosing their IDs", async () => {
    await seedSource("history-filter");
    for (const ref of ["redacted-history", "quarantine-history", "foreign-history"]) await history("history-filter", ref);
    await db.prepare("UPDATE source_revision SET purge_state='REDACTED' WHERE source_revision_ref='redacted-history'").run();
    await db.prepare("UPDATE source_revision SET purge_state='QUARANTINED' WHERE source_revision_ref='quarantine-history'").run();
    await db.prepare("UPDATE source_revision SET source_owner_generation='old-generation' WHERE source_revision_ref='foreign-history'").run();
    const result = await get("history-filter");
    expect(result.envelope.data?.revisions.map((row) => row.source_revision_ref)).toEqual(["rev-history-filter"]);
    expect(JSON.stringify(result.envelope)).not.toContain("redacted-history");
  });
  it("requires an authorized current head rather than using historical access to disclose a hidden head", async () => {
    await seedSource("history-head"); await history("history-head", "head-old-live");
    await db.prepare("UPDATE source_revision SET purge_state='PURGE_REQUESTED' WHERE source_revision_ref='rev-history-head'").run();
    expect((await get("history-head")).response.status).toBe(404);
  });
  it("checks every historical admission digest, not just the current head", async () => {
    await seedSource("history-corrupt"); await history("history-corrupt", "bad-digest-history");
    await db.prepare("UPDATE source_admission_decision SET decision_sha256=?1 WHERE source_revision_ref='bad-digest-history'").bind("0".repeat(64)).run();
    const result = await get("history-corrupt");
    expect(result.response.status).not.toBe(200); expect(result.envelope.data).toBeUndefined();
  });
  it("binds cursors to the source, principal, credential and deployment", async () => {
    await seedSource("history-cursor"); await history("history-cursor", "cursor-old");
    const first = await readSourceRevisions(db, context("history-cursor"), { source_id: "history-cursor", limit: 1 }, "deployment-1");
    const query = { source_id: "history-cursor", limit: 1, cursor: String(first.next_cursor) };
    await expect(readSourceRevisions(db, context("history-cursor"), query, "deployment-2")).rejects.toMatchObject({ code: "SOURCE_REVISIONS_CURSOR_CONTEXT" });
    for (const change of [{ principal_ref: "different" }, { credential_generation: "credential-2" }]) {
      await expect(readSourceRevisions(db, { ...context("history-cursor"), ...change }, query, "deployment-1")).rejects.toMatchObject({ status: 403 });
    }
    await expect(readSourceRevisions(db, context("history-cursor"), { ...query, source_id: "another" }, "deployment-1"))
      .rejects.toMatchObject({ code: "SOURCE_REVISIONS_CURSOR_INVALID" });
  });
  it("invalidates cursors on policy withdrawal and expiry", async () => {
    await seedSource("history-stale"); await history("history-stale", "stale-old");
    const start = Date.now(); const first = await readSourceRevisions(db, context("history-stale"), { source_id: "history-stale", limit: 1 }, "deployment-1", () => start);
    const query = { source_id: "history-stale", limit: 1, cursor: String(first.next_cursor) };
    await expect(readSourceRevisions(db, context("history-stale"), query, "deployment-1", () => start + 300_000)).rejects.toMatchObject({ code: "SOURCE_REVISIONS_CURSOR_STALE" });
    await db.prepare("UPDATE scope_read_policy SET state='REVOKED' WHERE source_namespace_id='ns-history-stale'").run();
    await expect(readSourceRevisions(db, context("history-stale"), query, "deployment-1", () => start)).rejects.toMatchObject({ code: "SOURCE_REVISIONS_CURSOR_STALE" });
  });
  it("invalidates an existing cursor when the readable head changes", async () => {
    await seedSource("history-head-change"); await history("history-head-change", "previous-head");
    const request = { source_id: "history-head-change", limit: 1 };
    const first = await readSourceRevisions(db, context(request.source_id), request, "deployment-1");
    await db.prepare("UPDATE source SET head_rev='previous-head' WHERE source_id='history-head-change'").run();
    await expect(readSourceRevisions(db, context(request.source_id), { ...request, cursor: String(first.next_cursor) }, "deployment-1"))
      .rejects.toMatchObject({ code: "SOURCE_REVISIONS_CURSOR_STALE" });
  });
  it("bounds each page and supports slash-bearing source IDs without a path-segment bypass", async () => {
    const source = "history/slashed"; await seedSource(source);
    for (let i = 0; i < 11; i += 1) await history(source, `history-${String(i).padStart(2, "0")}`);
    const first = await get(source);
    expect(first.response.status).toBe(200); expect(first.envelope.data?.revisions).toHaveLength(10);
    const second = await get(source, `&cursor=${String(first.envelope.data?.next_cursor)}`);
    expect(second.response.status).toBe(200); expect(second.envelope.data?.revisions).toHaveLength(2);
    expect(second.envelope.data?.next_cursor).toBeUndefined();
    expect(new Set([...first.envelope.data?.revisions ?? [], ...second.envelope.data?.revisions ?? []]
      .map((row) => row.source_revision_ref)).size).toBe(12);
  });
  it("blocks policy withdrawal racing metadata selection", async () => {
    await seedSource("history-race"); let changed = false;
    const observed = observeDatabase(async (sql, phase) => {
      if (!changed && sql === "BATCH" && phase === "after") { changed = true;
        await db.prepare("UPDATE scope_read_policy SET state='REVOKED' WHERE source_namespace_id='ns-history-race'").run(); }
    });
    const result = await get("history-race", "", observed);
    expect(changed).toBe(true); expect(result.response.status).not.toBe(200); expect(result.envelope.data).toBeUndefined();
  });
  it("blocks purge after an authority read rather than returning its earlier metadata", async () => {
    await seedSource("history-purge-race"); let changed = false;
    const observed = observeDatabase(async (sql, phase) => {
      if (!changed && sql.includes("SELECT s.source_id, s.source_owner_system_id") && phase === "after") { changed = true;
        await db.prepare("UPDATE source_revision SET purge_state='REDACTED' WHERE source_revision_ref='rev-history-purge-race'").run(); }
    });
    const result = await get("history-purge-race", "", observed);
    expect(changed).toBe(true); expect(result.response.status).not.toBe(200); expect(result.envelope.data).toBeUndefined();
  });
  it("rejects time-only policy expiry and cancellation during read", async () => {
    await seedSource("history-time"); let instant = Date.now(); const expires = instant + 50_000;
    await db.prepare("UPDATE scope_read_policy SET expires_at=?1 WHERE source_namespace_id='ns-history-time'").bind(new Date(expires).toISOString()).run();
    const observed = observeDatabase(async (sql, phase) => { if (sql === "BATCH" && phase === "after") instant = expires; });
    await expect(readSourceRevisions(observed, context("history-time"), { source_id: "history-time", limit: 2 }, "deployment-1", () => instant)).rejects.toBeDefined();
    await seedSource("history-cancel"); const abort = new AbortController();
    const cancelled = observeDatabase(async (sql, phase) => { if (sql === "BATCH" && phase === "after") abort.abort(); });
    await expect(readSourceRevisions(cancelled, context("history-cancel", abort.signal), { source_id: "history-cancel", limit: 2 }, "deployment-1"))
      .rejects.toMatchObject({ code: "CATALOG_REQUEST_ABORTED" });
  });
  it.each(["oversize-reasons", "duplicate-reasons", "oversize-receipt", "malformed-date"])("rejects %s stored readiness without partial output", async (fault) => {
    const name = `history-${fault}`; await seedSource(name);
    const fields = fault === "oversize-reasons" ? { reason_codes_json: JSON.stringify(["x".repeat(1024)]) } :
      fault === "duplicate-reasons" ? { reason_codes_json: '["DUP","DUP"]' } :
      fault === "oversize-receipt" ? { receipt_ref: "x".repeat(257) } : { updated_at: "not-a-date" };
    await ready(`rev-${name}`, "exact_ready", "ready", fields);
    const result = await get(name);
    expect(result.response.status).toBe(503); expect(result.envelope.code).toBe("SOURCE_REVISIONS_AUTHORITY_INVALID");
    expect(result.envelope.data).toBeUndefined();
  });
  it("rejects invalid limits, borrowed catalog cursors, provider fields, missing/duplicate query keys", async () => {
    for (const suffix of ["&limit=11", "&limit=1.5", "&limit=0", "&source_id=other", "&database=CORE_DB", "&cursor=not=json"]) {
      expect((await get("history-page", suffix)).response.status).toBe(400);
    }
    const missing = await handleHttp(new Request("https://research.example/api/v1/library/revisions"), runtime, {} as ExecutionContext, { accessVerifier: verifier() });
    expect(missing.status).toBe(400);
  });
  it("does not convert a failed D1 read to a valid empty page", async () => {
    await seedSource("history-failure");
    const failed = new Proxy(db, { get(target, key) {
      if (key === "batch") return async () => [{ success: false, results: [] }, { success: true, results: [] }];
      const value = Reflect.get(target, key, target); return typeof value === "function" ? value.bind(target) : value;
    } });
    expect((await get("history-failure", "", failed)).envelope.code).toBe("SOURCE_REVISIONS_READ_FAILED");
  });
  it("denies service principals and aborted requests before a database read", async () => {
    const noDatabase = { prepare() { throw new Error("Must not read D1"); } } as unknown as D1Database;
    await expect(readSourceRevisions(noDatabase, { ...context("source"), client_class: "trusted_agent" }, { source_id: "source", limit: 1 }, "deploy"))
      .rejects.toMatchObject({ code: "CATALOG_OWNER_REQUIRED" });
    const abort = new AbortController(); abort.abort();
    await expect(readSourceRevisions(noDatabase, context("source", abort.signal), { source_id: "source", limit: 1 }, "deploy"))
      .rejects.toMatchObject({ code: "CATALOG_REQUEST_ABORTED" });
    const response = await handleHttp(getRequest("source"), runtime, {} as ExecutionContext, { accessVerifier: verifier("service", "service_token") });
    expect(response.status).toBe(403);
  });
});
