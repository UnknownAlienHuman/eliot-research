import { afterEach, describe, expect, it, vi } from "vitest";
import { canonicalJson } from "@eliotr/platform-cloudflare";
import { loadScopeAuthority, createNavigationReadAuthority } from "@eliotr/cloudflare-evidence";
import { createD1ScopeService, createOwnerScopeAuthority } from "@eliotr/cloudflare-navigation";
import { createArtifactSectionReviseWorkflowStore } from "@eliotr/cloudflare-workflows";
import { resolveReauthorizedArtifactEvidence } from "@eliotr/cloudflare-research";
import { principal } from "./research-evidence-freeze-fixture.js";
import { runtime, fixture, crashBeforeW2Commit, requestBytes } from "./artifact-cow-http-fixture.js";

describe("owner COW HTTP/runner on native Workerd D1/R2", () => {
  afterEach(() => vi.useRealTimers());
  it("recovers a finalized child before model preparation and preserves historical bytes under a fresh REPORT scope", async () => {
    const data = await fixture();
    expect((await data.post(data.configuredEnv, "cow-http-service-denied", data.artifact_ref, true)).status).toBe(403);
    expect(data.modelCalls()).toBe(0);
    const crash = crashBeforeW2Commit(runtime.CORE_DB);
    const first = await data.post({ ...data.configuredEnv, CORE_DB: crash.database }, "cow-http-crash");
    expect(first.status, JSON.stringify(first.body)).toBeGreaterThanOrEqual(400);
    expect(crash.interrupted(), JSON.stringify({ first, calls: data.modelCalls(), attempts: (await runtime.CORE_DB.prepare("SELECT state,error_code FROM research_model_attempt WHERE cow_operation_id IS NOT NULL").all()).results })).toBe(true);
    expect(data.modelCalls()).toBe(2);
    const row = await runtime.CORE_DB.prepare("SELECT operation_id,scope_snapshot_id FROM artifact_section_revise_run WHERE idempotency_key=?1").bind("cow-http-crash").first<{ operation_id: string; scope_snapshot_id: string }>();
    if (row === null) throw new Error("COW W2 missing");
    expect(row.scope_snapshot_id).not.toBe(data.freeze.scope.snapshot_id);
    const store = createArtifactSectionReviseWorkflowStore(runtime.CORE_DB);
    const recorded = await store.read(row.operation_id);
    expect(recorded?.state).toBe("OUTPUT_RECORDED");
    if (recorded === null) throw new Error("Recorded COW attempt disappeared");
    expect(Date.now()).toBeLessThan(recorded.budget.expires_at_ms);
    expect((await runtime.CORE_DB.prepare("SELECT state FROM artifact_draft_reservation WHERE cow_operation_id=?1").bind(row.operation_id).first())?.state).toBe("FINALIZED");
    expect((await runtime.CORE_DB.prepare("SELECT scope_snapshot_id FROM artifact_section_revise_spend_admission WHERE stage_attempt_ref=?1 ORDER BY call_slot").bind(recorded.attempt_ref).all()).results)
      .toEqual([{ scope_snapshot_id: row.scope_snapshot_id }, { scope_snapshot_id: row.scope_snapshot_id }]);
    const saved = await requestBytes(row.operation_id);
    const puts = data.counted.puts();
    expect(puts).toBeGreaterThan(0);
    await data.originalsUnchanged();
    // A restarted request cannot construct a model profile. It must reconcile exact receipts first.
    const withoutModels = { ...data.configuredEnv, ELIOTR_MODEL_PROFILE_DEFINITION_JSON: "invalid", ELIOTR_RESEARCH_SEMANTIC_CONFIG_JSON: undefined };
    vi.setSystemTime(Date.now() + 1000);
    const recovered = await data.post(withoutModels, "cow-http-crash");
    expect(recovered.status, JSON.stringify(recovered.body)).toBe(200);
    expect(recovered.body.data?.state).toBe("COMMITTED");
    expect(recovered.body.data?.draft?.artifact_ref).toEqual({ ...data.artifact_ref, revision: 2 });
    expect((await data.post(withoutModels, "cow-http-crash")).body.data?.state).toBe("COMMITTED");
    expect(data.modelCalls()).toBe(2);
    expect(data.counted.puts()).toBe(puts);
    expect(await requestBytes(row.operation_id)).toBe(saved);
    await data.originalsUnchanged();
    await runtime.CORE_DB.prepare("UPDATE scope_access_grant SET state='REVOKED' WHERE snapshot_id=?1 AND principal_ref=?2")
      .bind(row.scope_snapshot_id, principal.principal_ref).run();
    const revoked = await data.post(withoutModels, "cow-http-crash");
    expect(revoked.status).toBeGreaterThanOrEqual(400);
    expect(data.modelCalls()).toBe(2);
    expect(data.counted.puts()).toBe(puts);
    expect(await requestBytes(row.operation_id)).toBe(saved);
    await data.originalsUnchanged();
  }, 120_000);

  it("keeps OUTPUT_RECORDED pending when current authority is revoked and rejects a saved-handle redaction race", async () => {
    const data = await fixture();
    const crash = crashBeforeW2Commit(runtime.CORE_DB);
    expect((await data.post({ ...data.configuredEnv, CORE_DB: crash.database }, "cow-http-revoked-output")).status).toBeGreaterThanOrEqual(400);
    expect(crash.interrupted()).toBe(true);
    expect(data.modelCalls()).toBe(2);
    const row = await runtime.CORE_DB.prepare("SELECT operation_id FROM artifact_section_revise_run WHERE idempotency_key=?1")
      .bind("cow-http-revoked-output").first<{ operation_id: string }>();
    if (row === null) throw new Error("Revoked-output COW W2 missing");
    const store = createArtifactSectionReviseWorkflowStore(runtime.CORE_DB);
    const recorded = await store.read(row.operation_id);
    if (recorded === null) throw new Error("Revoked-output COW attempt missing");
    expect(recorded.state).toBe("OUTPUT_RECORDED");
    const scope = await loadScopeAuthority(runtime.CORE_DB, recorded.request.scope_snapshot_ref);
    if (scope === null) throw new Error("Current REPORT scope missing");
    const scopes = createD1ScopeService(runtime.CORE_DB, createOwnerScopeAuthority(runtime.CORE_DB, data.context, Date.now));
    const navigation = createNavigationReadAuthority({ database: runtime.CORE_DB, scope_snapshot: scope.snapshot,
      access: data.context, require_current: (requested) => scopes.requireCurrent(requested), now: Date.now });
    const ledger = data.snapshot.referenced_objects.find((object) => object.object_kind === "EVIDENCE_LEDGER");
    if (ledger === undefined) throw new Error("Original evidence ledger missing");
    const evidence = (JSON.parse(new TextDecoder().decode(ledger.bytes)) as { resolved_evidence: { handle: {
      handle_ref: { id: string; revision: number }; excerpt_sha256: string } }[] }).resolved_evidence[0];
    if (evidence === undefined) throw new Error("Original evidence handle missing");
    let redactedDuringRead = false;
    const racedBucket = Object.create(runtime.EVIDENCE_BUCKET) as R2Bucket;
    racedBucket.head = runtime.EVIDENCE_BUCKET.head.bind(runtime.EVIDENCE_BUCKET);
    racedBucket.get = async (...args: Parameters<R2Bucket["get"]>) => {
      if (!redactedDuringRead) {
        redactedDuringRead = true;
        await runtime.CORE_DB.prepare("UPDATE evidence_handle SET terminal_state='REDACTED',invalidation_ref='cow-http-redaction-race' WHERE handle_id=?1 AND revision=?2")
          .bind(evidence.handle.handle_ref.id, evidence.handle.handle_ref.revision).run();
      }
      return runtime.EVIDENCE_BUCKET.get(...args);
    };
    const authorizationBeforeRace = await navigation.current();
    await expect(resolveReauthorizedArtifactEvidence({ database: runtime.CORE_DB, search_database: runtime.SEARCH_DB,
      evidence_bucket: racedBucket, access: data.context, current_navigation: navigation,
      current_authorization: authorizationBeforeRace, original_handle_ref: evidence.handle.handle_ref,
      original_scope_snapshot_ref: data.snapshot.spec.scope_snapshot_ref,
      expected_excerpt_sha256: evidence.handle.excerpt_sha256 })).rejects.toMatchObject({ code: "ARTIFACT_DRAFT_READ_STALE" });
    expect(redactedDuringRead).toBe(true);
    expect(canonicalJson(await navigation.current())).toBe(canonicalJson(authorizationBeforeRace));
    const saved = await requestBytes(row.operation_id);
    const puts = data.counted.puts();
    await runtime.CORE_DB.prepare("UPDATE scope_access_grant SET state='REVOKED' WHERE snapshot_id=?1 AND principal_ref=?2")
      .bind(scope.snapshot.snapshot_id, principal.principal_ref).run();
    const denied = await data.post({ ...data.configuredEnv, ELIOTR_RESEARCH_SEMANTIC_CONFIG_JSON: undefined }, "cow-http-revoked-output");
    expect(denied.status).toBeGreaterThanOrEqual(400);
    expect((await store.read(row.operation_id))?.state).toBe("OUTPUT_RECORDED");
    expect(data.modelCalls()).toBe(2);
    expect(data.counted.puts()).toBe(puts);
    expect(await requestBytes(row.operation_id)).toBe(saved);
    await data.originalsUnchanged();
  }, 120_000);

  it("returns durable UNKNOWN on replay without another model effect", async () => {
    const data = await fixture();
    data.failProvider();
    const first = await data.post(data.configuredEnv, "cow-http-unknown");
    expect(first.status).toBeGreaterThanOrEqual(400);
    expect(data.modelCalls()).toBe(1);
    const row = await runtime.CORE_DB.prepare("SELECT operation_id FROM artifact_section_revise_run WHERE idempotency_key=?1").bind("cow-http-unknown").first<{ operation_id: string }>();
    if (row === null) throw new Error("UNKNOWN COW W2 missing");
    expect((await createArtifactSectionReviseWorkflowStore(runtime.CORE_DB).read(row.operation_id))?.state).toBe("UNKNOWN");
    const saved = await requestBytes(row.operation_id);
    const puts = data.counted.puts();
    const replay = await data.post({ ...data.configuredEnv, ELIOTR_RESEARCH_SEMANTIC_CONFIG_JSON: undefined }, "cow-http-unknown");
    expect(replay.status, JSON.stringify(replay.body)).toBe(200);
    expect(replay.body.data?.state).toBe("UNKNOWN");
    expect(data.modelCalls()).toBe(1);
    expect(data.counted.puts()).toBe(puts);
    expect(await requestBytes(row.operation_id)).toBe(saved);
    await data.originalsUnchanged();
  }, 120_000);
});
