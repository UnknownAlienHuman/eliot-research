import type { ScopeExpression, ScopeSnapshot } from "@eliotr/contracts";
import {
  scopeExpressionIdentity,
  type DeterministicScopeAtom,
  type DeterministicScopeAtomResolution,
  type DeterministicScopeMember,
} from "@eliotr/domain";
import { describe, expect, it } from "vitest";
import {
  createScopeService,
  ScopeServiceError,
  type ScopeAuthorityClosure,
  type ScopeAuthorityRequest,
  type ScopePersistenceOutcome,
  type ScopeRepository,
} from "./scope-service.js";

const A = "a".repeat(64);
const B = "b".repeat(64);
const NOW = Date.parse("2026-09-01T12:00:00.000Z");

function project(projectId: string): DeterministicScopeAtom {
  return { kind: "PROJECT", project_id: projectId };
}

function binary(
  kind: "UNION" | "INTERSECT" | "EXCEPT",
  left: ScopeExpression,
  right: ScopeExpression,
): ScopeExpression {
  return { kind, left, right };
}

function member(
  revision: string,
  owner = `owner-${revision}`,
  policy = `policy-${revision}`,
): DeterministicScopeMember {
  return {
    source_revision_ref: revision,
    source_owner_generation: owner,
    policy_closure_ref: policy,
  };
}

class MemoryScopeRepository implements ScopeRepository {
  public readonly atoms = new Map<string, DeterministicScopeAtomResolution>();
  public readonly atom_calls: string[] = [];
  public authority_calls = 0;
  public read_calls = 0;
  public last_authority_request?: ScopeAuthorityRequest;
  public force_conflict = false;
  public omit_readback = false;
  public atom_override?: unknown;
  public authority_raw: unknown = {
    policy_authority_ref: "policy-authority-1",
    disclosure_closure_digest: A,
    purge_ledger_revision: 1,
    client_fence_valid: true,
    denied_source_revision_refs: [],
  } satisfies ScopeAuthorityClosure;
  private readonly snapshots = new Map<string, ScopeSnapshot>();

  public constructor() {
    this.setAtom(project("alpha"), "generation-alpha-1", [member("revision-1"), member("revision-2")]);
    this.setAtom(project("beta"), "generation-beta-1", [member("revision-2"), member("revision-3")]);
  }

  public setAtom(atom: DeterministicScopeAtom, generation: string, members: readonly DeterministicScopeMember[]): void {
    this.atoms.set(scopeExpressionIdentity(atom), { atom_generation_ref: generation, members: [...members] });
  }

  public authority(): ScopeAuthorityClosure {
    return structuredClone(this.authority_raw) as ScopeAuthorityClosure;
  }

  public updateAuthority(patch: Partial<ScopeAuthorityClosure>): void {
    this.authority_raw = { ...this.authority(), ...patch };
  }

  public async resolveAtom(atom: DeterministicScopeAtom): Promise<DeterministicScopeAtomResolution> {
    const identity = scopeExpressionIdentity(atom);
    this.atom_calls.push(identity);
    if (this.atom_override !== undefined) return structuredClone(this.atom_override) as DeterministicScopeAtomResolution;
    const value = this.atoms.get(identity);
    if (value === undefined) throw new Error(`missing atom ${identity}`);
    return structuredClone(value);
  }

  public async resolveAuthorityClosure(request: ScopeAuthorityRequest): Promise<ScopeAuthorityClosure> {
    this.authority_calls += 1;
    this.last_authority_request = structuredClone(request);
    return structuredClone(this.authority_raw) as ScopeAuthorityClosure;
  }

  public async persistSnapshot(snapshot: ScopeSnapshot): Promise<ScopePersistenceOutcome> {
    if (this.force_conflict) return "CONFLICT";
    const key = `${snapshot.snapshot_id}@${snapshot.revision}`;
    const prior = this.snapshots.get(key);
    if (prior === undefined) {
      this.snapshots.set(key, structuredClone(snapshot));
      return "CREATED";
    }
    return JSON.stringify(prior) === JSON.stringify(snapshot) ? "REPLAY" : "CONFLICT";
  }

  public async readSnapshot(snapshotId: string, revision: number): Promise<ScopeSnapshot | null> {
    this.read_calls += 1;
    if (this.omit_readback) return null;
    const value = this.snapshots.get(`${snapshotId}@${revision}`);
    return value === undefined ? null : structuredClone(value);
  }
}

async function expectCode(operation: Promise<unknown>, code: string): Promise<ScopeServiceError> {
  try {
    await operation;
  } catch (error) {
    expect(error).toBeInstanceOf(ScopeServiceError);
    expect((error as ScopeServiceError).code).toBe(code);
    return error as ScopeServiceError;
  }
  throw new Error(`expected ${code}`);
}

describe("ER-30 persisted scope authority", () => {
  it("persists one deterministic snapshot for equivalent commutative expressions", async () => {
    const repository = new MemoryScopeRepository();
    const service = createScopeService(repository, { now: () => NOW });
    const first = binary("UNION", project("alpha"), project("beta"));
    const second = binary("UNION", project("beta"), binary("UNION", project("alpha"), project("alpha")));

    const left = await service.freeze(first, "client-fence-1");
    const right = await service.freeze(second, "client-fence-1");

    expect(right).toEqual(left);
    expect(left.member_source_revision_refs).toEqual(["revision-1", "revision-2", "revision-3"]);
    expect(left.participant_generations["member-policy-closure"]).toMatch(/^policy-closure-[a-f0-9]{48}$/u);
    expect(repository.last_authority_request?.member_policy_closure_refs).toEqual({
      "revision-1": "policy-revision-1",
      "revision-2": "policy-revision-2",
      "revision-3": "policy-revision-3",
    });
    expect(await service.validateCurrent(left)).toEqual({ current: true, invalidation_reason_codes: [] });
    const detachedRequireCurrent = service.requireCurrent;
    await expect(detachedRequireCurrent(left)).resolves.toEqual(left);
  });

  it("evaluates recursive INTERSECT and EXCEPT while resolving each atom once", async () => {
    const repository = new MemoryScopeRepository();
    const service = createScopeService(repository, { now: () => NOW });
    const expression = binary(
      "EXCEPT",
      binary("UNION", project("alpha"), project("beta")),
      binary("INTERSECT", project("beta"), project("beta")),
    );

    const snapshot = await service.freeze(expression);
    expect(snapshot.member_source_revision_refs).toEqual(["revision-1"]);
    expect(repository.atom_calls).toHaveLength(2);
    expect(new Set(repository.atom_calls)).toEqual(new Set([
      scopeExpressionIdentity(project("alpha")),
      scopeExpressionIdentity(project("beta")),
    ]));
  });

  it("freezes a selected-source scope without creating project membership", async () => {
    const repository = new MemoryScopeRepository();
    const selected: DeterministicScopeAtom = {
      kind: "SELECTED_SOURCES",
      source_ids: ["source-2", "source-1", "source-1"],
    };
    repository.setAtom(
      { kind: "SELECTED_SOURCES", source_ids: ["source-1", "source-2"] },
      "generation-selected-1",
      [member("revision-1"), member("revision-2")],
    );
    const service = createScopeService(repository, { now: () => NOW });

    const snapshot = await service.freeze(selected);
    expect(snapshot.resolved_scope_expression).toEqual({
      kind: "SELECTED_SOURCES",
      source_ids: ["source-1", "source-2"],
    });
    expect(repository.atom_calls).toEqual([
      scopeExpressionIdentity({ kind: "SELECTED_SOURCES", source_ids: ["source-1", "source-2"] }),
    ]);
    expect(repository.last_authority_request?.expression.kind).toBe("SELECTED_SOURCES");
  });

  it("invalidates a frozen snapshot when a member is purged", async () => {
    const repository = new MemoryScopeRepository();
    const service = createScopeService(repository, { now: () => NOW });
    const snapshot = await service.freeze(project("alpha"));

    repository.setAtom(project("alpha"), "generation-alpha-2", [member("revision-1")]);
    repository.updateAuthority({ purge_ledger_revision: 2 });

    const result = await service.validateCurrent(snapshot);
    expect(result.current).toBe(false);
    expect(result.invalidation_reason_codes).toEqual(expect.arrayContaining([
      "PARTICIPANT_GENERATION_STALE",
      "PURGE_LEDGER_ADVANCED",
      "SCOPE_MEMBERSHIP_CHANGED",
    ]));
    const error = await expectCode(service.requireCurrent(snapshot), "SCOPE_SNAPSHOT_STALE");
    expect(error.reason_codes).toEqual(expect.arrayContaining(["PURGE_LEDGER_ADVANCED"]));
  });

  it("binds member policy closures independently of aggregate policy authority", async () => {
    const repository = new MemoryScopeRepository();
    const service = createScopeService(repository, { now: () => NOW });
    const snapshot = await service.freeze(project("alpha"), "client-fence-1");

    repository.setAtom(project("alpha"), "generation-alpha-1", [
      member("revision-1", "owner-revision-1", "policy-revision-1-v2"),
      member("revision-2"),
    ]);
    let result = await service.validateCurrent(snapshot);
    expect(result.invalidation_reason_codes).toContain("MEMBER_POLICY_CLOSURE_STALE");

    repository.setAtom(project("alpha"), "generation-alpha-1", [
      member("revision-1", "owner-revision-1-v2", "policy-revision-1-v2"),
      member("revision-2"),
    ]);
    repository.updateAuthority({
      policy_authority_ref: "policy-authority-2",
      disclosure_closure_digest: B,
      client_fence_valid: false,
      denied_source_revision_refs: ["revision-1"],
    });
    result = await service.validateCurrent(snapshot);
    expect(result.invalidation_reason_codes).toEqual(expect.arrayContaining([
      "CLIENT_FENCE_STALE",
      "DISCLOSURE_CLOSURE_STALE",
      "MEMBER_POLICY_CLOSURE_STALE",
      "NEW_DENY_APPLIES",
      "POLICY_AUTHORITY_STALE",
      "SOURCE_OWNER_GENERATION_STALE",
    ]));
  });

  it("fails closed on stale fences, deny sets, conflicts and missing readback", async () => {
    const staleFence = new MemoryScopeRepository();
    staleFence.updateAuthority({ client_fence_valid: false });
    const staleFenceService = createScopeService(staleFence, { now: () => NOW });
    await expectCode(staleFenceService.freeze(project("alpha"), "client-fence-1"), "CLIENT_FENCE_STALE");
    expect(await staleFenceService.freeze(project("alpha"))).toBeDefined();

    const denied = new MemoryScopeRepository();
    denied.updateAuthority({ denied_source_revision_refs: ["revision-1"] });
    await expectCode(createScopeService(denied, { now: () => NOW }).freeze(project("alpha")), "SCOPE_DENIED");

    const unrelated = new MemoryScopeRepository();
    unrelated.updateAuthority({ denied_source_revision_refs: ["revision-unrelated"] });
    await expectCode(
      createScopeService(unrelated, { now: () => NOW }).freeze(project("alpha")),
      "SCOPE_AUTHORITY_INVALID",
    );

    const conflict = new MemoryScopeRepository();
    conflict.force_conflict = true;
    await expectCode(createScopeService(conflict, { now: () => NOW }).freeze(project("alpha")), "SCOPE_SNAPSHOT_CONFLICT");

    const missing = new MemoryScopeRepository();
    missing.omit_readback = true;
    await expectCode(
      createScopeService(missing, { now: () => NOW }).freeze(project("alpha")),
      "SCOPE_SNAPSHOT_READBACK_MISMATCH",
    );
  });

  it("rejects forged or expired snapshots before re-reading mutable authority", async () => {
    let now = NOW;
    const repository = new MemoryScopeRepository();
    const service = createScopeService(repository, { now: () => now, ttl_ms: 1_000 });
    const snapshot = await service.freeze(project("alpha"));

    const atomCalls = repository.atom_calls.length;
    const authorityCalls = repository.authority_calls;
    const forged = { ...snapshot, policy_authority_ref: "policy-forged" };
    const forgedResult = await service.validateCurrent(forged);
    expect(forgedResult.invalidation_reason_codes).toEqual(expect.arrayContaining([
      "SNAPSHOT_DIGEST_MISMATCH",
      "SNAPSHOT_ID_MISMATCH",
      "SNAPSHOT_PERSISTED_RECORD_MISMATCH",
    ]));
    expect(repository.atom_calls).toHaveLength(atomCalls);
    expect(repository.authority_calls).toBe(authorityCalls);

    now += 1_001;
    const expired = await service.validateCurrent(snapshot);
    expect(expired.invalidation_reason_codes).toContain("SNAPSHOT_EXPIRED");
    expect(repository.atom_calls).toHaveLength(atomCalls);
    expect(repository.authority_calls).toBe(authorityCalls);
  });

  it("enforces strict and pre-decode resource ceilings", async () => {
    const repository = new MemoryScopeRepository();
    const service = createScopeService(repository, { now: () => NOW });
    await expectCode(service.freeze({ ...project("alpha"), extra: true } as unknown as ScopeExpression), "SCOPE_EXPRESSION_INVALID");

    const bounded = createScopeService(new MemoryScopeRepository(), {
      now: () => NOW,
      max_snapshot_members: 1,
    });
    await expectCode(bounded.freeze(project("alpha")), "SCOPE_MEMBER_LIMIT");

    let deep: ScopeExpression = project("alpha");
    for (let index = 0; index < 33; index += 1) deep = binary("UNION", project("alpha"), deep);
    await expectCode(service.freeze(deep), "SCOPE_EXPRESSION_TOO_DEEP");

    const cyclicRecord: Record<string, unknown> = { kind: "UNION", right: project("alpha") };
    cyclicRecord.left = cyclicRecord;
    await expectCode(service.freeze(cyclicRecord as unknown as ScopeExpression), "SCOPE_EXPRESSION_CYCLIC");
    expect(() => createScopeService(repository, { ttl_ms: Number.MAX_SAFE_INTEGER })).toThrow(ScopeServiceError);
  });

  it("normalizes malformed repository output into stable service errors", async () => {
    const malformedAtom = new MemoryScopeRepository();
    malformedAtom.atom_override = {
      atom_generation_ref: "generation-1",
      members: [{ source_revision_ref: "revision-1" }],
    };
    await expectCode(
      createScopeService(malformedAtom, { now: () => NOW }).freeze(project("alpha")),
      "SCOPE_RESOLUTION_FAILED",
    );

    const malformedAuthority = new MemoryScopeRepository();
    malformedAuthority.authority_raw = {
      policy_authority_ref: "policy-1",
      disclosure_closure_digest: "not-a-digest",
      purge_ledger_revision: 1,
      client_fence_valid: true,
      denied_source_revision_refs: [],
    };
    await expectCode(
      createScopeService(malformedAuthority, { now: () => NOW }).freeze(project("alpha")),
      "SCOPE_AUTHORITY_INVALID",
    );

    const unknownAtomField = new MemoryScopeRepository();
    unknownAtomField.atom_override = {
      atom_generation_ref: "generation-1",
      members: [],
      unexpected: true,
    };
    await expectCode(
      createScopeService(unknownAtomField, { now: () => NOW }).freeze(project("alpha")),
      "SCOPE_RESOLUTION_FAILED",
    );

    const duplicateDeny = new MemoryScopeRepository();
    duplicateDeny.updateAuthority({ denied_source_revision_refs: ["revision-1", "revision-1"] });
    await expectCode(
      createScopeService(duplicateDeny, { now: () => NOW }).freeze(project("alpha")),
      "SCOPE_AUTHORITY_INVALID",
    );

    const unknownAuthorityField = new MemoryScopeRepository();
    unknownAuthorityField.authority_raw = { ...unknownAuthorityField.authority(), unexpected: true };
    await expectCode(
      createScopeService(unknownAuthorityField, { now: () => NOW }).freeze(project("alpha")),
      "SCOPE_AUTHORITY_INVALID",
    );

    await expectCode(
      createScopeService(new MemoryScopeRepository(), { now: () => -1 }).freeze(project("alpha")),
      "SCOPE_CLOCK_INVALID",
    );
  });
});
