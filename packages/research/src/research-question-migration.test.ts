import { describe, expect, it } from "vitest";
import { CORE_MIGRATIONS, setup, baseInput, seedHandles, invariant, codeOf } from "./research-test-fixture.js";

describe("S24 ledger question read/write parity", () => {
  it("persists exact multiline goal bytes above the old SQL and codec ceilings", async () => {
    const ctx = setup();
    const goal = "English question\r\n\tРусский вопрос 😀\n".repeat(300);
    const input = baseInput({ goal });
    seedHandles(ctx, input);
    await ctx.service.create(input);
    expect((await ctx.store.read("inv-1"))?.head.goal).toBe(goal);
    expect(ctx.raw.prepare("SELECT goal FROM investigation_ledger_head WHERE investigation_id='inv-1'").get()).toMatchObject({ goal });
    await ctx.service.create(input);
    expect(ctx.raw.prepare("SELECT count(*) AS n FROM investigation_ledger_event").get()).toMatchObject({ n: 1 });
    expect(await codeOf(ctx.service.create({ ...input, goal: goal.replaceAll("\r\n", "\n") }))).toBe("LEDGER_CONFLICT");
    await invariant(ctx, "inv-1");
  });
});


describe("S24 migration preserves durable research authority", () => {
  const migration = Object.entries(CORE_MIGRATIONS).find(([key]) => key.endsWith("/0069_research_question_envelopes.sql"))?.[1];
  it.each([false, true])("preserves existing rows, FK targets and every guard, rollback=%s", async (rollback) => {
    if (migration === undefined) throw new Error("S24 migration is missing");
    const ctx = setup(true);
    const input = baseInput({ goal: "Existing short question" });
    seedHandles(ctx, input);
    await ctx.service.create(input);
    ctx.raw.exec("UPDATE scope_access_grant SET allowed_use_json='[\"research\"]'");
    ctx.raw.prepare(`INSERT INTO research_workflow_run(operation_id,investigation_id,initial_revision,current_revision,
      principal_ref,credential_generation,deployment_generation,policy_generation,policy_authority_ref,
      authorization_receipt_ref,scope_snapshot_id,scope_snapshot_revision,purge_revision,idempotency_key,
      handler_generation,initial_manifest_json,next_stage_index,state,cancellation_receipt_ref,created_at)
      VALUES('run-existing','inv-1',1,1,'principal-1','cred-1','deploy-gen-1','policy-gen-1','policy-auth-1',
      'authz-scope-1-principal-1','scope-1',1,0,'run-existing-key','generation-1',?,0,'ACTIVE',NULL,?)`).run(
      JSON.stringify({ object_ref: input.portfolio_ref, sha256: input.input_digest }), input.created_at,
    );
    const head = ctx.raw.prepare("SELECT * FROM investigation_ledger_head").all();
    const events = ctx.raw.prepare("SELECT * FROM investigation_ledger_event").all();
    const workflows = ctx.raw.prepare("SELECT * FROM research_workflow_run").all();
    const guards = ctx.raw.prepare("SELECT type,name,sql FROM sqlite_schema WHERE type IN ('trigger','view','index') AND sql IS NOT NULL ORDER BY name").all();
    const originalTable = ctx.raw.prepare("SELECT sql FROM sqlite_schema WHERE name='investigation_ledger_head'").get();
    ctx.raw.exec("BEGIN");
    try {
      ctx.raw.exec(migration);
      if (rollback) throw new Error("simulated migration interruption");
      ctx.raw.exec("COMMIT");
    } catch (error) {
      ctx.raw.exec("ROLLBACK");
      if (!rollback) throw error;
    }
    expect(ctx.raw.prepare("SELECT * FROM investigation_ledger_head").all()).toEqual(head);
    expect(ctx.raw.prepare("SELECT * FROM investigation_ledger_event").all()).toEqual(events);
    expect(ctx.raw.prepare("SELECT * FROM research_workflow_run").all()).toEqual(workflows);
    expect(ctx.raw.prepare("SELECT type,name,sql FROM sqlite_schema WHERE type IN ('trigger','view','index') AND sql IS NOT NULL ORDER BY name").all()).toEqual(guards);
    expect(ctx.raw.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(ctx.raw.prepare("PRAGMA foreign_keys").get()).toMatchObject({ foreign_keys: 1 });
    expect(ctx.raw.prepare("SELECT name FROM sqlite_schema WHERE name LIKE '%s24_copy%'").all()).toEqual([]);
    const generation = ctx.raw.prepare("SELECT value FROM schema_state WHERE key='research_question_generation'").get();
    if (rollback) {
      expect(generation).toBeUndefined();
      expect(ctx.raw.prepare("SELECT sql FROM sqlite_schema WHERE name='investigation_ledger_head'").get()).toEqual(originalTable);
    } else {
      expect(generation).toMatchObject({ value: "research-question-v2-utf8-envelopes" });
      expect((await ctx.store.read("inv-1"))?.head.goal).toBe(input.goal);
      // The rebuilt table still refuses direct mutation/grade changes and retains W1 CAS.
      expect(() => ctx.raw.exec("UPDATE investigation_ledger_head SET goal='substituted' WHERE investigation_id='inv-1'")).toThrow();
      expect(() => ctx.raw.exec("UPDATE investigation_ledger_head SET evidence_grade='E3' WHERE investigation_id='inv-1'")).toThrow();
      expect(() => ctx.raw.exec("DELETE FROM investigation_ledger_head WHERE investigation_id='inv-1'")).toThrow();
      await ctx.service.create(input);
      ctx.digests.set("checkpoint-existing", "c".repeat(64));
      await ctx.service.checkpoint("inv-1", 1, 1, "principal-1", "event-existing", "checkpoint-existing", "c".repeat(64));
      expect((await ctx.store.read("inv-1"))?.head.goal).toBe(input.goal);
      await invariant(ctx, "inv-1");
    }
  });
});
