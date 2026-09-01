import type {
  ScopeExpression,
  ScopeSnapshot,
} from "@eliotr/contracts";
import {
  normalizeScopeExpression,
  scopeExpressionIdentity,
  type DeterministicScopeAtom,
  type DeterministicScopeAtomResolution,
} from "@eliotr/domain";
import { describe, expect, it } from "vitest";
import {
  ScopeServiceError,
  createScopeService,
  type ScopeAuthorityClosure,
  type ScopeAuthorityRequest,
  type ScopePersistenceOutcome,
  type ScopeRepository,
} from "./scope-service.js";

const NOW = Date.parse("2026-09-01T21:00:00.000Z");
const DISCLOSURE_DIGEST = "a".repeat(64);

function member(
  sourceRevisionRef: string,
  ownerGeneration = "owner-generation-1",
  policyClosureRef = "policy-closure-1",
) {
  return {
    source_revision_ref: sourceRevisionRef,
    source_owner_generation: ownerGeneration,
    policy_closure_ref: policyClosureRef,
  };
}

function project(projectId: string): ScopeExpression {
  return { kind: "PROJECT", project_id: projectId };
}

function binary(
  kind: "UNION" | "INTERSECT" | "EXCEPT",
  left: ScopeExpression,
  right: ScopeExpression,
): ScopeExpression {
  return { kind, left, right };
}

class MemoryScopeRepository implements ScopeRepository {
  public readonly snapshots = new Map<string, ScopeSnapshot>();
  public readonly atomCalls: string[] = [];
  public persistenceOverride: ScopePersistenceOutcome | null = null;
  public readbackOverride: ScopeSnapshot | null | undefined;
  public authority: ScopeAuthorityClosure = {
    policy_authority_ref: "policy-authority-1",
    disclosure_closure_digest: DISCLOSURE_DIGEST,
    purge_ledger_revision: 1,
    client_fence_valid: true,
    denied_source_revision_refs: [],
  };
  public atoms = new Map<string, DeterministicScopeAtomResolution>([
    [scopeExpressionIdentity(project("alpha")), {
      atom_generation_ref: "project-alpha-generation-1",
      members: [member("source-revision-2"), member("source-revision-1")],
    }],
    [scopeExpressionIdentity(project("beta")), {
      atom_generation_ref: "project-beta-generation-1",
      members: [member("source-revision-2"), member("source-revision-3")],
    }],
    [scopeExpressionIdentity({ kind: "SELECTED_SOURCES", source_ids: ["source-1"] }), {
      atom_generation_ref: "selected-source-generation-1",
      members: [member("source-revision-1")],
    }],
  ]);

  public async resolveAtom(
    atom: DeterministicScopeAtom,
    _observedAt: string,
  ): Promise<DeterministicScopeAtomResolution> {
    const identity = scopeExpressionIdentity(atom);
    this.atomCalls.push(identity);
    const resolution = this.atoms.get(identity);
    if (resolution === undefined) throw new Error(`unknown atom ${identity}`);
    return structuredClone(resolution);
  }

  public async resolveAuthorityClosure(
    request: ScopeAuthorityRequest,
  ): Promise<ScopeAuthorityClosure> {
    const members = new Set(request.member_source_revision_refs);
    for (const denied of this.authority.denied_source_revision_refs) {
      if (!members.has(denied)) throw new Error("authority denied an unrelated revision");
    }
    return structuredClone(this.authority);
  }

  public async persistSnapshot(snapshot: ScopeSnapshot): Promise<ScopePersistenceOutcome> {
    if (this.persistenceOverride !== null) return this.persistenceOverride;
    const key = `${snapshot.snapshot_id}@${snapshot.revision}`;
    const existing = this.snapshots.get(key);
    if (existing === undefined) {
      this.snapshots.set(key, structuredClone(snapshot));
      return "CREATED";
    }
    return existing.digest === snapshot.digest ? "REPLAY" : "CONFLICT";
  }

  public async readSnapshot(snapshotId: string, revision: number): Promise<ScopeSnapshot | null> {
    if (this.readbackOverride !== undefined) {
      return this.readbackOverride === null ? null : structuredClone(this.readbackOverride);
    }
    const snapshot = this.snapshots.get(`${snapshotId}@${revision}`);
    return snapshot === undefined ? null : structuredClone(snapshot);
  }
}

async function expectCode(promise: Promise<unknown>, code: string): Promise<ScopeServiceError> {
  try {
    await promise;
    throw new Error(`expected ${code}`);
  } catch (error) {
    expect(error).toBeInstanceOf(ScopeServiceError);
    expect(error).toMatchObject({ code });
    return error as ScopeServiceError;
  }
}

describe("ER-30 scope snapshot service", () => {
  it("persists one deterministic snapshot for equivalent UNION expressions", async () => {
    const repository = new MemoryScopeRepository();
    const service = createScopeService(repository, { now: () => NOW, ttl_ms: 60_000 });

    const first = await service.freeze(binary("UNION", project("beta"), project("alpha")), "client-fence-1");
    const second = await service.freeze(binary("UNION", project("alpha"), project("beta")), "client-fence-1");

    expect(second).toEqual(first);
    expect(first.member_source_revision_refs).toEqual([
      "source-revision-1",
      "source-revision-2",
      "source-revision-3",
    ]);
    expect(first.resolved_scope_expression).toEqual(normalizeScopeExpression(
      binary("UNION", project("alpha"), project("beta")),
    ));
    expect(first.snapshot_id).toMatch(/^scope-[a-f0-9]{48}$/u);
    expect(first.digest).toMatch(/^[a-f0-9]{64}$/u);
    expect(repository.snapshots).toHaveLength(1);
    expect(await service.validateCurrent(first)).toEqual({
      current: true,
      invalidation_reason_codes: [],
    });
  });

  it("does not create project membership for a temporary selected-source scope", async () => {
    const repository = new MemoryScopeRepository();
    const service = createScopeService(repository, { now: () => NOW });

    const snapshot = await service.freeze({
      kind: "SELECTED_SOURCES",
      source_ids: ["source-1", "source-1"],
    });

    expect(snapshot.member_source_revision_refs).toEqual(["source-revision-1"]);
    expect(Object.keys(repository)).not.toContain("createMembership");
  });

  it("invalidates a frozen scope after purge and blocks every old-cache authorization attempt", async () => {
    const repository = new MemoryScopeRepository();
    const service = createScopeService(repository, { now: () => NOW });
    const snapshot = await service.freeze(project("alpha"));

    repository.authority = {
      ...repository.authority,
      purge_ledger_revision: 2,
      denied_source_revision_refs: ["source-revision-2"],
    };
    repository.atoms.set(scopeExpressionIdentity(project("alpha")), {
      atom_generation_ref: "project-alpha-generation-2",
      members: [member("source-revision-1")],
    });

    const currentness = await service.validateCurrent(snapshot);
    expect(currentness.current).toBe(false);
    expect(currentness.invalidation_reason_codes).toEqual(expect.arrayContaining([
      "NEW_DENY_APPLIES",
      "PARTICIPANT_GENERATION_STALE",
      "PURGE_LEDGER_ADVANCED",
      "SCOPE_MEMBERSHIP_CHANGED",
    ]));
    const error = await expectCode(service.requireCurrent(snapshot), "SCOPE_SNAPSHOT_STALE");
    expect(error.reason_codes).toEqual(currentness.invalidation_reason_codes);
  });

  it("invalidates stale owner, disclosure, policy and client-fence generations", async () => {
    const repository = new MemoryScopeRepository();
    const service = createScopeService(repository, { now: () => NOW });
    const snapshot = await service.freeze(project("alpha"), "client-fence-1");

    repository.atoms.set(scopeExpressionIdentity(project("alpha")), {
      atom_generation_ref: "project-alpha-generation-1",
      members: [
        member("source-revision-1", "owner-generation-2", "policy-closure-2"),
        member("source-revision-2", "owner-generation-2", "policy-closure-2"),
      ],
    });
    repository.authority = {
      ...repository.authority,
      policy_authority_ref: "policy-authority-2",
      disclosure_closure_digest: "b".repeat(64),
      client_fence_valid: false,
    };

    expect((await service.validateCurrent(snapshot)).invalidation_reason_codes).toEqual(expect.arrayContaining([
      "CLIENT_FENCE_STALE",
      "DISCLOSURE_CLOSURE_STALE",
      "POLICY_AUTHORITY_STALE",
      "SOURCE_OWNER_GENERATION_STALE",
    ]));
  });

  it("rejects stale fences, denied members, CAS conflicts and readback mismatch", async () => {
    const staleFenceRepository = new MemoryScopeRepository();
    staleFenceRepository.authority = { ...staleFenceRepository.authority, client_fence_valid: false };
    await expectCode(
      createScopeService(staleFenceRepository, { now: () => NOW }).freeze(project("alpha"), "client-fence-1"),
      "CLIENT_FENCE_STALE",
    );

    const deniedRepository = new MemoryScopeRepository();
    deniedRepository.authority = {
      ...deniedRepository.authority,
      denied_source_revision_refs: ["source-revision-1"],
    };
    await expectCode(
      createScopeService(deniedRepository, { now: () => NOW }).freeze(project("alpha")),
      "SCOPE_DENIED",
    );

    const conflictRepository = new MemoryScopeRepository();
    conflictRepository.persistenceOverride = "CONFLICT";
    await expectCode(
      createScopeService(conflictRepository, { now: () => NOW }).freeze(project("alpha")),
      "SCOPE_SNAPSHOT_CONFLICT",
    );

    const missingReadbackRepository = new MemoryScopeRepository();
    missingReadbackRepository.readbackOverride = null;
    await expectCode(
      createScopeService(missingReadbackRepository, { now: () => NOW }).freeze(project("alpha")),
      "SCOPE_SNAPSHOT_READBACK_MISMATCH",
    );
  });

  it("binds currentness to expiry and exact persisted bytes", async () => {
    let now = NOW;
    const repository = new MemoryScopeRepository();
    const service = createScopeService(repository, { now: () => now, ttl_ms: 1_000 });
    const snapshot = await service.freeze(project("alpha"));

    const tampered = { ...snapshot, policy_authority_ref: "tampered-policy" };
    expect((await service.validateCurrent(tampered)).invalidation_reason_codes).toEqual(expect.arrayContaining([
      "SNAPSHOT_DIGEST_MISMATCH",
      "SNAPSHOT_ID_MISMATCH",
      "SNAPSHOT_PERSISTED_RECORD_MISMATCH",
    ]));

    now += 1_000;
    expect((await service.validateCurrent(snapshot)).invalidation_reason_codes).toContain("SNAPSHOT_EXPIRED");
  });

  it("rejects unknown fields and explicit resource-limit violations", async () => {
    const repository = new MemoryScopeRepository();
    const service = createScopeService(repository, {
      now: () => NOW,
      max_snapshot_members: 1,
    });

    await expectCode(service.freeze({
      kind: "PROJECT",
      project_id: "alpha",
      bypass_policy: true,
    } as ScopeExpression), "SCOPE_EXPRESSION_INVALID");
    await expectCode(service.freeze(project("alpha")), "SCOPE_MEMBER_LIMIT");
  });
});
