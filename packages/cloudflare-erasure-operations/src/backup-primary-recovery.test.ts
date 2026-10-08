import { describe, expect, it } from "vitest";
import { erasureDigest } from "@eliotr/cloudflare-erasure";
import {
  advanceToPrimaryPurge,
  caughtErrorSummary,
  createRecoveryFixture,
} from "./backup-primary-recovery-fixtures.js";
describe("primary backup deletion recovery over SQLite authority and R2 readback", () => {
  it.each([
    { mode: "before" as const, keyInitiallyPresentAfterLostAck: true },
    { mode: "after" as const, keyInitiallyPresentAfterLostAck: false },
  ])("replays an immutable two-plus-part plan after a lost $mode-delete acknowledgement", async ({ mode, keyInitiallyPresentAfterLostAck }) => {
    const fixture = await createRecoveryFixture();
    const { epoch, request, authority, location, backend } = fixture;
    try {
      const persisted = epoch.db.prepare("SELECT epoch_id,draft_json FROM backup_epoch_receipt WHERE epoch_id=?1")
        .get(epoch.id) as { readonly epoch_id: string; readonly draft_json: string } | undefined;
      expect(persisted?.epoch_id).toBe(epoch.id);
      expect(JSON.parse(persisted?.draft_json ?? "null")).toEqual(epoch.draft);
      const firstLease = await authority.acquire(request);
      expect(firstLease.disposition).toBe("ACQUIRED");
      if (firstLease.disposition !== "ACQUIRED") throw new Error("initial recovery lease was not acquired");
      const firstFence = firstLease.fence;
      const firstPlan = await advanceToPrimaryPurge(fixture, firstFence);
      const planGeneration = firstFence.lease_generation;
      const plannedRows = epoch.db.prepare(
        "SELECT part_key,state FROM backup_erasure_primary_delete_item " +
          "WHERE erasure_id=?1 AND erasure_revision=?2 AND lease_generation=?3 AND target_id=?4 ORDER BY part_key",
      ).all(request.erasure_ref.id, request.erasure_ref.revision, planGeneration, firstPlan.target.target_id) as {
        readonly part_key: string;
        readonly state: string;
      }[];
      expect(plannedRows.length).toBeGreaterThanOrEqual(2);
      const [firstPart, untouchedPart] = plannedRows;
      if (firstPart === undefined || untouchedPart === undefined) throw new Error("recovery fixture needs two sealed part pins");

      const untouchedObject = epoch.part_objects.get(untouchedPart.part_key);
      if (untouchedObject === undefined) throw new Error("second sealed part is absent before deletion");
      epoch.part_objects.delete(untouchedPart.part_key);
      await expect(location.purge(request, firstFence, firstPlan.target))
        .rejects.toMatchObject({ code: "ERASURE_SETTLEMENT_UNCERTAIN", retryable: true });
      epoch.part_objects.set(untouchedPart.part_key, untouchedObject);

      const firstObject = epoch.part_objects.get(firstPart.part_key);
      if (firstObject === undefined) throw new Error("first sealed part is absent before deletion");
      epoch.part_objects.set(firstPart.part_key, {
        ...firstObject,
        etag: "replacement-etag",
        version: "replacement-version",
      });
      await expect(location.purge(request, firstFence, firstPlan.target))
        .rejects.toMatchObject({ code: "ERASURE_SETTLEMENT_UNCERTAIN", retryable: true });
      epoch.part_objects.set(firstPart.part_key, firstObject);

      epoch.part_objects.set("backup-parts/unplanned/orphan", {
        ...firstObject,
        etag: "orphan-etag",
        version: "orphan-version",
      });
      await expect(location.purge(request, firstFence, firstPlan.target))
        .rejects.toMatchObject({ code: "ERASURE_SETTLEMENT_UNCERTAIN", retryable: true });
      epoch.part_objects.delete("backup-parts/unplanned/orphan");

      epoch.failNextDelete(mode, firstPart.part_key);
      let lostAck: unknown;
      try { await backend.purge(request, firstFence, firstPlan.target); }
      catch (cause) { lostAck = cause; }
      const actualPurgeError = caughtErrorSummary(lostAck);
      expect(lostAck, `backend.purge caught ${actualPurgeError}`)
        .toMatchObject({ code: "ERASURE_SETTLEMENT_UNCERTAIN", retryable: true });
      const unknownPart = epoch.db.prepare(
        "SELECT state,delete_intent_ref,delete_intent_digest FROM backup_erasure_primary_delete_item " +
          "WHERE erasure_id=?1 AND erasure_revision=?2 AND lease_generation=?3 AND target_id=?4 AND part_key=?5",
      ).get(request.erasure_ref.id, request.erasure_ref.revision, planGeneration,
        firstPlan.target.target_id, firstPart.part_key) as {
        readonly state: string;
        readonly delete_intent_ref: string | null;
        readonly delete_intent_digest: string | null;
      } | undefined;
      expect(unknownPart, `delete-item readback after ${actualPurgeError}`)
        .toMatchObject({ state: "UNKNOWN" });
      expect(unknownPart?.delete_intent_ref).toEqual(expect.any(String));
      expect(unknownPart?.delete_intent_digest).toMatch(/^[a-f0-9]{64}$/u);
      expect(epoch.part_objects.has(firstPart.part_key)).toBe(keyInitiallyPresentAfterLostAck);
      await backend.fail(request, firstFence, "ERASURE_SETTLEMENT_UNCERTAIN");
      const failed = epoch.db.prepare(
        "SELECT state FROM erasure_execution WHERE erasure_id=?1 AND revision=?2",
      ).get(request.erasure_ref.id, request.erasure_ref.revision) as { readonly state: string } | undefined;
      expect(failed?.state).toBe("FAILED");

      await expect(authority.acquire(request)).rejects.toMatchObject({ code: "ERASURE_LEASE_LOST" });
      fixture.advancePastSharedFenceLeaseExpiry();
      const secondLease = await authority.acquire(request);
      expect(secondLease.disposition).toBe("ACQUIRED");
      if (secondLease.disposition !== "ACQUIRED") throw new Error("recovery lease was not reacquired");
      const secondFence = secondLease.fence;
      expect(secondFence.lease_generation).toBeGreaterThan(firstFence.lease_generation);
      await expect(location.purge(request, firstFence, firstPlan.target))
        .rejects.toMatchObject({ code: "ERASURE_LEASE_LOST" });

      const replay = await advanceToPrimaryPurge(fixture, secondFence);
      const originalHeader = epoch.db.prepare(
        "SELECT plan_digest,state FROM backup_erasure_primary_closure WHERE erasure_id=?1 AND " +
          "erasure_revision=?2 AND lease_generation=?3",
      ).get(request.erasure_ref.id, request.erasure_ref.revision, planGeneration) as {
        readonly plan_digest: string;
        readonly state: string;
      } | undefined;
      const handoff = epoch.db.prepare(
        "SELECT state,plan_lease_generation,current_lease_generation,original_plan_digest " +
          "FROM backup_erasure_primary_handoff WHERE erasure_id=?1 AND erasure_revision=?2 AND current_lease_generation=?3",
      ).get(request.erasure_ref.id, request.erasure_ref.revision, secondFence.lease_generation) as {
        readonly state: string;
        readonly plan_lease_generation: number;
        readonly current_lease_generation: number;
        readonly original_plan_digest: string;
      } | undefined;
      expect(originalHeader?.state).toBe("SEALED");
      expect(handoff).toMatchObject({
        state: "SEALED",
        plan_lease_generation: planGeneration,
        current_lease_generation: secondFence.lease_generation,
        original_plan_digest: originalHeader?.plan_digest,
      });
      expect(replay.target.target_id).toBe(firstPlan.target.target_id);

      const purge = await backend.purge(request, secondFence, replay.target);
      expect(purge.disposition).toBe("DELETE_ACCEPTED");
      await backend.advanceLifecycle(
        request,
        secondFence,
        "PURGE_EACH_LOCATION",
        "VERIFY_ABSENCE_OR_BLOCK",
        await erasureDigest([purge]),
      );
      const absence = await backend.verifyAbsent(request, secondFence, replay.target, purge);
      expect(absence.absent).toBe(true);
      expect([...epoch.part_objects.keys()].filter((key) => key.startsWith(`backup-parts/${epoch.id}/`))).toEqual([]);
      const deleteObligation = epoch.db.prepare(
        "SELECT primary_delete_intent_ref,primary_delete_intent_digest,primary_delete_receipt_ref " +
          "FROM backup_purge_obligation WHERE erasure_id=?1 AND erasure_revision=?2 AND backup_epoch_id=?3",
      ).get(request.erasure_ref.id, request.erasure_ref.revision, epoch.id) as {
        readonly primary_delete_intent_ref: string | null;
        readonly primary_delete_intent_digest: string | null;
        readonly primary_delete_receipt_ref: string | null;
      } | undefined;
      expect(deleteObligation?.primary_delete_intent_ref).toEqual(expect.any(String));
      expect(deleteObligation?.primary_delete_intent_digest).toMatch(/^[a-f0-9]{64}$/u);
      expect(deleteObligation?.primary_delete_receipt_ref).toEqual(expect.any(String));
    } finally {
      epoch.db.close();
    }
  }, 60_000);
});
