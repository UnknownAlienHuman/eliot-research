/**
 * S91.6 managed generation promotion transactions over the actual migrated
 * SEARCH_DB.
 *
 * The production service (createAiSearchGenerationRegistryService) is bound to
 * the production D1 registry store (createD1AiSearchGenerationRegistryStore)
 * over env.SEARCH_DB, so declare, observe, and promote run through the genuine
 * authority artifact, its guarded compare-and-swap, and its durable readback.
 *
 * Controlled observation inputs come from the local fixture. These cases prove
 * transaction ordering, exact persistence, and authority preservation only. No
 * live AI Search provider is called, no success receipt is forged, no database
 * or service result is replaced, no result is mocked, and no row is purged.
 * Whole-91.6 purge-preserving rollback, full S91/S52, and native provider
 * qualification stay open.
 */

import { env } from "cloudflare:workers";
import { applyD1Migrations } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import type { AiSearchGenerationRegistrySnapshot } from "@eliotr/cloudflare-ai";
import {
  capturedFailure,
  countingRegistryService,
  declarationFor,
  durableRegistryRead,
  generationIdentity,
  observationFor,
  promotionFor,
  registryService,
} from "./index-generation-promotion-fixture.js";

const runtime = env as unknown as {
  readonly SEARCH_DB: D1Database;
  readonly SEARCH_MIGRATIONS: Parameters<typeof applyD1Migrations>[1];
};
const searchDb = runtime.SEARCH_DB;

beforeAll(async () => {
  await applyD1Migrations(searchDb, runtime.SEARCH_MIGRATIONS);
});

/** One durable registry row observation: exact revision, digest, and head. */
function durableStates(
  snapshot: AiSearchGenerationRegistrySnapshot | null,
): readonly (readonly [string, string])[] {
  return snapshot?.artifact.registry.generations.map((record) =>
    Object.freeze([record.generation, record.state] as const),
  ) ?? [];
}

describe("S91.6 managed generation promotion transactions over actual SEARCH_DB", () => {
  it("counts every durable authority change as one compare-and-swap", async () => {
    const identity = generationIdentity("cas-count", "alpha");
    const probe = countingRegistryService(searchDb);
    const service = probe.service;

    await service.declare(declarationFor(identity));
    await service.observe(identity.namespace, observationFor(identity));
    await service.promote(identity.namespace, promotionFor(identity, null));
    expect(probe.compareAndSwapCalls()).toBe(3);

    const replayed = await service.promote(
      identity.namespace,
      promotionFor(identity, null),
    );
    expect(replayed.disposition).toBe("EXISTING");
    expect(probe.compareAndSwapCalls()).toBe(3);

    const durable = await durableRegistryRead(searchDb, identity.namespace);
    expect(durable?.artifact.revision).toBe(3);
    expect(durable?.artifact.registry.active_head_generation).toBe(
      identity.generation,
    );
  });

  it("persists the exact revision, digest, and serving head of one promotion", async () => {
    const identity = generationIdentity("durable-promotion", "alpha");
    const service = registryService(searchDb);

    const declared = await service.declare(declarationFor(identity));
    expect(declared.operation).toBe("DECLARE");
    expect(declared.disposition).toBe("CREATED");
    expect(declared.previous_revision).toBeNull();
    expect(declared.revision).toBe(1);
    expect(declared.active_head_generation).toBeNull();

    const observed = await service.observe(identity.namespace, observationFor(identity));
    expect(observed.operation).toBe("OBSERVE");
    expect(observed.disposition).toBe("UPDATED");
    expect(observed.previous_revision).toBe(1);
    expect(observed.revision).toBe(2);
    expect(observed.active_head_generation).toBeNull();

    const promoted = await service.promote(identity.namespace, promotionFor(identity, null));
    expect(promoted.operation).toBe("PROMOTE");
    expect(promoted.disposition).toBe("UPDATED");
    expect(promoted.previous_revision).toBe(2);
    expect(promoted.revision).toBe(3);
    expect(promoted.active_head_generation).toBe(identity.generation);

    const durable = await durableRegistryRead(searchDb, identity.namespace);
    expect(durable?.artifact.namespace).toBe(identity.namespace);
    expect(durable?.artifact.revision).toBe(promoted.revision);
    expect(durable?.artifact_sha256).toBe(promoted.artifact_sha256);
    expect(durable?.artifact.registry.active_head_generation).toBe(identity.generation);
    expect(durableStates(durable)).toEqual([[identity.generation, "ACTIVE"]]);
  });

  it("keeps authority bytes and the CAS count unchanged across an exact logical replay", async () => {
    const identity = generationIdentity("replay-authority", "beta");
    const probe = countingRegistryService(searchDb);

    const declared = await probe.service.declare(declarationFor(identity));
    const replayedDeclaration = await probe.service.declare(declarationFor(identity));
    expect(replayedDeclaration.disposition).toBe("EXISTING");
    expect(replayedDeclaration.revision).toBe(declared.revision);
    expect(replayedDeclaration.artifact_sha256).toBe(declared.artifact_sha256);

    await probe.service.observe(identity.namespace, observationFor(identity));
    const replayedObservation = await probe.service.observe(
      identity.namespace,
      observationFor(identity),
    );
    expect(replayedObservation.disposition).toBe("EXISTING");
    expect(replayedObservation.revision).toBe(2);

    const promoted = await probe.service.promote(
      identity.namespace,
      promotionFor(identity, null),
    );
    const committed = await durableRegistryRead(searchDb, identity.namespace);
    const casAfterPromotion = probe.compareAndSwapCalls();
    expect(casAfterPromotion).toBe(3);

    const replayedPromotion = await probe.service.promote(
      identity.namespace,
      promotionFor(identity, null),
    );
    expect(replayedPromotion.disposition).toBe("EXISTING");
    expect(replayedPromotion.revision).toBe(promoted.revision);
    expect(replayedPromotion.artifact_sha256).toBe(promoted.artifact_sha256);
    expect(probe.compareAndSwapCalls()).toBe(casAfterPromotion);

    const afterReplay = await durableRegistryRead(searchDb, identity.namespace);
    expect(afterReplay?.artifact.revision).toBe(committed?.artifact.revision);
    expect(afterReplay?.artifact_sha256).toBe(committed?.artifact_sha256);
  });

  it("refuses promotion after insufficient or inconsistent evidence and preserves the durable head", async () => {
    const incomplete = generationIdentity("insufficient-evidence", "alpha");
    const inconsistent = generationIdentity("inconsistent-evidence", "beta");
    const service = registryService(searchDb);

    await service.declare(declarationFor(incomplete));
    await service.observe(incomplete.namespace, observationFor(incomplete, {
      readback_item_count: 0,
    }));
    const incompleteBefore = await durableRegistryRead(searchDb, incomplete.namespace);
    expect(incompleteBefore?.artifact.revision).toBe(2);

    await service.declare(declarationFor(inconsistent));
    await service.observe(inconsistent.namespace, observationFor(inconsistent, {
      mismatch_count: 1,
    }));
    const inconsistentBefore = await durableRegistryRead(searchDb, inconsistent.namespace);
    expect(inconsistentBefore?.artifact.revision).toBe(2);

    const insufficient = await capturedFailure(() =>
      service.promote(incomplete.namespace, promotionFor(incomplete, null)),
    );
    expect(insufficient.code).toBe("AI_SEARCH_SHADOW_INCOMPLETE");

    const inconsistentEvidence = await capturedFailure(() =>
      service.promote(inconsistent.namespace, promotionFor(inconsistent, null)),
    );
    expect(inconsistentEvidence.code).toBe("AI_SEARCH_SHADOW_INCOMPLETE");

    const incompleteAfter = await durableRegistryRead(searchDb, incomplete.namespace);
    expect(incompleteAfter?.artifact.revision).toBe(incompleteBefore?.artifact.revision);
    expect(incompleteAfter?.artifact_sha256).toBe(incompleteBefore?.artifact_sha256);
    expect(incompleteAfter?.artifact.registry.active_head_generation).toBeNull();

    const inconsistentAfter = await durableRegistryRead(searchDb, inconsistent.namespace);
    expect(inconsistentAfter?.artifact.revision).toBe(inconsistentBefore?.artifact.revision);
    expect(inconsistentAfter?.artifact_sha256).toBe(inconsistentBefore?.artifact_sha256);
    expect(inconsistentAfter?.artifact.registry.active_head_generation).toBeNull();
  });

  it("rejects a stale expected head and a competing genuine CAS winner without partial mutation", async () => {
    const stale = generationIdentity("stale-expected-head", "alpha");
    const service = registryService(searchDb);

    await service.declare(declarationFor(stale));
    await service.observe(stale.namespace, observationFor(stale));
    const staleBefore = await durableRegistryRead(searchDb, stale.namespace);

    const staleRefusal = await capturedFailure(() =>
      service.promote(stale.namespace, promotionFor(stale, "absent-active-head")),
    );
    expect(staleRefusal.code).toBe("AI_SEARCH_ACTIVE_HEAD_CONFLICT");

    const staleAfter = await durableRegistryRead(searchDb, stale.namespace);
    expect(staleAfter?.artifact.revision).toBe(staleBefore?.artifact.revision);
    expect(staleAfter?.artifact_sha256).toBe(staleBefore?.artifact_sha256);

    // Two fully observed candidates share one namespace row, so the service
    // revision both promoters read is the same revision one of them passes.
    const first = generationIdentity("competing-cas-winner", "alpha");
    const second = generationIdentity("competing-cas-winner", "beta");
    for (const identity of [first, second]) {
      await service.declare(declarationFor(identity));
      await service.observe(identity.namespace, observationFor(identity));
    }
    const contestedBefore = await durableRegistryRead(searchDb, first.namespace);
    expect(contestedBefore?.artifact.revision).toBe(4);

    let competingRevision = 0;
    const probe = countingRegistryService(searchDb, {
      beforeCompareAndSwap: async () => {
        const competing = await service.promote(
          first.namespace,
          promotionFor(second, null),
        );
        competingRevision = competing.revision;
      },
    });

    const contestedRefusal = await capturedFailure(() =>
      probe.service.promote(first.namespace, promotionFor(first, null)),
    );
    expect(contestedRefusal.code).toBe("AI_SEARCH_REGISTRY_WRITE_CONFLICT");
    expect(contestedRefusal.retryable).toBe(true);
    expect(probe.compareAndSwapCalls()).toBe(1);

    // The genuine winner owns the durable row; the rejected candidate left
    // no partial mutation behind.
    const contestedAfter = await durableRegistryRead(searchDb, first.namespace);
    expect(contestedAfter?.artifact.revision).toBe(competingRevision);
    expect(contestedAfter?.artifact.revision).toBe(5);
    expect(contestedAfter?.artifact.registry.active_head_generation).toBe(second.generation);
    expect(durableStates(contestedAfter)).toEqual([
      [first.generation, "SHADOW_COMPLETE"],
      [second.generation, "ACTIVE"],
    ]);
  });

  it("reconciles a committed promotion that lost its acknowledgement using one CAS", async () => {
    const identity = generationIdentity("lost-acknowledgement", "alpha");
    const service = registryService(searchDb);

    await service.declare(declarationFor(identity));
    await service.observe(identity.namespace, observationFor(identity));
    const before = await durableRegistryRead(searchDb, identity.namespace);
    expect(before?.artifact.registry.active_head_generation).toBeNull();

    const probe = countingRegistryService(searchDb, { fault: "LOST_ACKNOWLEDGEMENT" });
    const reconciled = await probe.service.promote(
      identity.namespace,
      promotionFor(identity, null),
    );
    expect(reconciled.operation).toBe("PROMOTE");
    expect(reconciled.disposition).toBe("RECONCILED");
    expect(reconciled.previous_revision).toBe(before?.artifact.revision);
    expect(reconciled.revision).toBe(3);
    expect(reconciled.active_head_generation).toBe(identity.generation);
    expect(probe.compareAndSwapCalls()).toBe(1);

    const recovered = await durableRegistryRead(searchDb, identity.namespace);
    expect(recovered?.artifact.revision).toBe(reconciled.revision);
    expect(recovered?.artifact_sha256).toBe(reconciled.artifact_sha256);
    expect(recovered?.artifact.registry.active_head_generation).toBe(identity.generation);

    const replay = await probe.service.promote(
      identity.namespace,
      promotionFor(identity, null),
    );
    expect(replay.disposition).toBe("EXISTING");
    expect(probe.compareAndSwapCalls()).toBe(1);

    const afterReplay = await durableRegistryRead(searchDb, identity.namespace);
    expect(afterReplay?.artifact.revision).toBe(recovered?.artifact.revision);
    expect(afterReplay?.artifact_sha256).toBe(recovered?.artifact_sha256);
  });

  it("keeps a started CAS write uncertain when the authoritative readback is missing", async () => {
    const identity = generationIdentity("missing-readback", "beta");
    const service = registryService(searchDb);

    await service.declare(declarationFor(identity));
    await service.observe(identity.namespace, observationFor(identity));
    const before = await durableRegistryRead(searchDb, identity.namespace);
    expect(before?.artifact.revision).toBe(2);

    const probe = countingRegistryService(searchDb, { fault: "MISSING_READBACK" });
    const refusal = await capturedFailure(() =>
      probe.service.promote(identity.namespace, promotionFor(identity, null)),
    );
    expect(refusal.code).toBe("AI_SEARCH_REGISTRY_WRITE_UNCERTAIN");
    expect(refusal.retryable).toBe(false);
    expect(refusal.ambiguousEffect).toBe("REGISTRY_CAS");
    expect(probe.compareAndSwapCalls()).toBe(1);

    // Recovery through a fresh genuine read shows the durable state the started
    // compare-and-swap committed, with no internal reapply of the effect.
    const recovered = await durableRegistryRead(searchDb, identity.namespace);
    expect(recovered?.artifact.revision).toBe((before?.artifact.revision ?? 0) + 1);
    expect(recovered?.artifact.registry.active_head_generation).toBe(identity.generation);
    expect(durableStates(recovered)).toEqual([[identity.generation, "ACTIVE"]]);

    const readAfterRecovery = await durableRegistryRead(searchDb, identity.namespace);
    expect(readAfterRecovery?.artifact_sha256).toBe(recovered?.artifact_sha256);
  });
});
