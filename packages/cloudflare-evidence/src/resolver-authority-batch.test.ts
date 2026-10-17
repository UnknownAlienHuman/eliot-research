/// <reference types="node" />
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import type { EvidenceHandle, LocatorCandidate, ScopeSnapshot, SourceAdmissionDecision } from "@eliotr/contracts";
import { scopeSnapshotDigestPayload, scopeSnapshotIdentityPayload } from "@eliotr/domain";
import { describe, expect, it, vi } from "vitest";
import { createD1EvidenceAuthorityPort } from "./authority.js";
import { canonicalEvidenceJson, evidenceSha256, evidenceSha256Bytes } from "./canonical.js";
import { createCloudflareEvidenceResolver } from "./resolver.js";
import { scopeStorageValues } from "./scope-codec.js";
import type { EvidenceAuthorityPort } from "./types.js";

const NOW = Date.parse("2026-10-17T05:00:00.000Z");
const UNTIL = "2027-10-17T05:00:00.000Z";
const A = "a".repeat(64);
const B = "b".repeat(64);
const access = { principal_ref: "owner-1", client_class: "owner_pwa" as const, credential_generation: "credential-1" };
const candidate: LocatorCandidate = {
  candidate_id: "candidate-1", lane: "LEX", source_revision_ref: "revision-1", canonical_section_id: "section-1",
  preview: "untrusted preview", raw_score: 1, rank: 1, index_generation: "projection-1", metadata: { item_key: "item-1" },
};

// Same synchronous SQLite transaction seam as navigation-storage-authority.test.ts.
function d1(database: DatabaseSync) {
  let firstCalls = 0;
  let batchCalls = 0;
  let resultFault: { index: number; error: string } | undefined;
  let afterRead: ((index: number) => void) | undefined;
  let mapBatch: ((results: D1Result[]) => D1Result[]) | undefined;
  const reads = new WeakMap<D1PreparedStatement, () => D1Result>();
  function statement(sql: string, values: unknown[] = []): D1PreparedStatement {
    const index = sql.includes("FROM scope_snapshot") ? 0 : sql.includes("FROM scope_access_grant_effective") ? 1 : 2;
    const read = (): D1Result => {
      const results = database.prepare(sql).all(...values as SQLInputValue[]);
      afterRead?.(index);
      return resultFault?.index === index
        ? { success: false, results: [], error: resultFault.error } as unknown as D1Result
        : { success: true, results } as D1Result;
    };
    const prepared = {
      bind: (...bound: unknown[]) => statement(sql, bound),
      async first<T>() {
        firstCalls += 1;
        const result = read();
        if (!result.success) throw new Error(result.error);
        return (result.results[0] as T | undefined) ?? null;
      },
    } as unknown as D1PreparedStatement;
    reads.set(prepared, read);
    return prepared;
  }
  const binding = {
    prepare: statement,
    async batch(statements: D1PreparedStatement[]) {
      batchCalls += 1;
      database.exec("BEGIN");
      try {
        const results = statements.map((prepared) => {
          const read = reads.get(prepared);
          if (read === undefined) throw new Error("unknown fixture statement");
          return read();
        });
        database.exec("COMMIT");
        return mapBatch?.(results) ?? results;
      } catch (cause) {
        database.exec("ROLLBACK");
        throw cause;
      }
    },
  } as unknown as D1Database;
  return {
    binding,
    counts: () => ({ first: firstCalls, batch: batchCalls, rpc: firstCalls + batchCalls }),
    reset: () => { firstCalls = 0; batchCalls = 0; },
    failResult: (index: number) => { resultFault = { index, error: `D1_ERROR: fixture SELECT ${index}` }; },
    afterRead: (hook: typeof afterRead) => { afterRead = hook; },
    mapBatch: (hook: typeof mapBatch) => { mapBatch = hook; },
  };
}

async function fixture(batched = true) {
  const material = {
    revision: 1, resolved_scope_expression: { kind: "SELECTED_SOURCES" as const, source_ids: ["source-1"] },
    participant_generations: { "member-policy-closure": "generation-1" }, member_source_revision_refs: ["revision-1"],
    source_owner_generations: { "revision-1": "generation-1" }, policy_authority_ref: "policy-1",
    disclosure_closure_digest: B, purge_ledger_revision: 0, client_fence_ref: "credential-1",
    created_at: new Date(NOW).toISOString(), expires_at: UNTIL,
  };
  const snapshotId = `scope-${(await evidenceSha256(scopeSnapshotIdentityPayload(material))).slice(0, 48)}`;
  const snapshot: ScopeSnapshot = { snapshot_id: snapshotId, ...material,
    digest: await evidenceSha256(scopeSnapshotDigestPayload({ snapshot_id: snapshotId, ...material })) };
  const admission: SourceAdmissionDecision = {
    source_namespace_id: "namespace-1", owner_system_id: "owner-1", source_owner_generation: "generation-1",
    source_revision_ref: "revision-1", origin_authentication_receipt_ref: "origin-1", source_class: "document",
    assurance_ceiling: "QUALIFIED", instruction_taint: "DATA_ONLY", allowed_effects: "READ_ONLY",
    object_residency_key_digest: B, allowed_use: ["research"], disclosure_ceiling: "private",
    license_policy_ref: "license-1", expires_at: UNTIL, decision: "ADMITTED", reason_codes: [], decision_receipt_ref: "admission-1",
  };
  const database = new DatabaseSync(":memory:");
  database.exec(`
    CREATE TABLE scope_snapshot (
      snapshot_id TEXT, revision INTEGER, resolved_scope_expression_json TEXT, participant_generations_json TEXT,
      member_source_revision_refs_json TEXT, source_owner_generations_json TEXT, policy_authority_ref TEXT,
      disclosure_closure_digest TEXT, purge_ledger_revision INTEGER, client_fence_ref TEXT, snapshot_digest TEXT,
      created_at TEXT, expires_at TEXT, invalidated_at TEXT, invalidation_reason TEXT
    );
    CREATE TABLE scope_access_grant_effective (
      snapshot_id TEXT, snapshot_revision INTEGER, principal_ref TEXT, client_class TEXT, credential_generation TEXT,
      authorization_receipt_ref TEXT, policy_authority_ref TEXT, allowed_use_json TEXT, disclosure_ceiling TEXT,
      expires_at TEXT, state TEXT
    );
    CREATE TABLE source (source_id TEXT, source_owner_system_id TEXT, source_namespace_id TEXT, title TEXT, source_class TEXT);
    CREATE TABLE source_revision (source_revision_ref TEXT, source_id TEXT, source_owner_generation TEXT,
      content_sha256 TEXT, object_residency_key_digest TEXT, normalized_artifact_ref TEXT, purge_state TEXT);
    CREATE TABLE source_namespace_ownership (source_namespace_id TEXT, source_owner_generation TEXT, status TEXT);
    CREATE TABLE source_admission_decision (source_revision_ref TEXT, decision TEXT, decision_receipt_ref TEXT,
      decision_json TEXT, decision_sha256 TEXT, created_at TEXT);
    INSERT INTO source VALUES ('source-1','owner-1','namespace-1','Source One','document');
    INSERT INTO source_namespace_ownership VALUES ('namespace-1','generation-1','ACTIVE');
  `);
  database.prepare("INSERT INTO scope_snapshot VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)").run(...scopeStorageValues(snapshot));
  database.prepare("INSERT INTO scope_access_grant_effective VALUES (?,?,?,?,?,?,?,?,?,?,?)").run(
    snapshotId, 1, access.principal_ref, access.client_class, access.credential_generation, "grant-1", "policy-1",
    '["research"]', "private", UNTIL, "ACTIVE",
  );
  database.prepare("INSERT INTO source_revision VALUES (?,?,?,?,?,?,?)").run(
    "revision-1", "source-1", "generation-1", A, B, "normalized-1", "LIVE",
  );
  database.prepare("INSERT INTO source_admission_decision VALUES (?,?,?,?,?,?)").run(
    "revision-1", "ADMITTED", "admission-1", canonicalEvidenceJson(admission), await evidenceSha256(admission), material.created_at,
  );
  const core = d1(database);
  let time = NOW;
  let storedHandle: EvidenceHandle | null = null;
  const base = createD1EvidenceAuthorityPort({ core_database: core.binding, search_database: core.binding, now: () => time });
  const { loadFreshAuthority: _batch, ...separate } = base;
  const bytes = new TextEncoder().encode("alpha");
  const excerptDigest = await evidenceSha256Bytes(bytes);
  const persist = vi.fn<EvidenceAuthorityPort["persistResolution"]>(async (input) => {
    storedHandle = input.proposed_handle;
    return { handle: storedHandle, receipt: input.resolution_receipt };
  });
  const invalidate = vi.fn<EvidenceAuthorityPort["invalidateHandle"]>(async (handle, state) => {
    storedHandle = { ...handle, terminal_state: state, invalidation_ref: "invalidation-1" };
    return storedHandle;
  });
  const materialize = vi.fn(async () => ({ exact_excerpt: "alpha", excerpt_sha256: excerptDigest, excerpt_byte_length: bytes.byteLength,
    normalized_object_ref: "normalized/object/content.md", normalized_object_ref_digest: A, source_object_size: 5, source_object_sha256: A }));
  const authority: EvidenceAuthorityPort = {
    ...(batched ? base : separate), persistResolution: persist, invalidateHandle: invalidate,
    loadHandle: async () => storedHandle,
    resolveCandidate: async () => ({ anchor: { kind: "normalized_byte_range", start: 0, end: 5 },
      item_key: "item-1", content_sha256: excerptDigest, coordinate_map_ref: "offset-map-1", projection_generation: "projection-1" }),
  };
  const resolver = createCloudflareEvidenceResolver({ authority, content: { materialize }, now: () => time });
  const ref = { id: snapshotId, revision: 1 };
  return { database, core, resolver, materialize, persist, invalidate,
    resolve: () => resolver.resolveCandidate({ candidate, scope_snapshot_ref: ref, access }),
    reopen: () => {
      if (storedHandle === null) throw new Error("missing fixture handle");
      return resolver.resolveHandle({ handle_ref: storedHandle.handle_ref, expected_scope_snapshot_ref: ref, access });
    },
    expireHandle: () => {
      if (storedHandle === null) throw new Error("missing fixture handle");
      storedHandle = { ...storedHandle, expires_at: new Date(NOW - 1).toISOString() };
    },
    setTime: (value: number) => { time = value; },
  };
}

describe("fresh D1 evidence authority batch at the resolver seam", () => {
  it("returns identical candidate and handle evidence while reducing three primary reads to one RPC", async () => {
    const batch = await fixture();
    const separate = await fixture(false);
    try {
      for (let index = 0; index < 16; index += 1) expect(await batch.resolve()).toEqual(await separate.resolve());
      expect(batch.core.counts()).toEqual({ first: 0, batch: 16, rpc: 16 });
      expect(separate.core.counts()).toEqual({ first: 48, batch: 0, rpc: 48 });
      batch.core.reset();
      separate.core.reset();
      expect(await batch.reopen()).toEqual(await separate.reopen());
      expect(batch.core.counts()).toEqual({ first: 0, batch: 1, rpc: 1 });
      expect(separate.core.counts()).toEqual({ first: 3, batch: 0, rpc: 3 });
      expect(batch.materialize).toHaveBeenCalledTimes(17);
      expect(batch.persist).toHaveBeenCalledTimes(17);
    } finally { batch.database.close(); separate.database.close(); }
  });

  it.each([
    ["scope missing", "DELETE FROM scope_snapshot", "EVIDENCE_SCOPE_NOT_FOUND"],
    ["scope digest", "UPDATE scope_snapshot SET snapshot_digest='bad'", "EVIDENCE_INPUT_INVALID"],
    ["scope invalidated", "UPDATE scope_snapshot SET invalidated_at='2026-10-17T05:00:00.000Z',invalidation_reason='revoked'", "EVIDENCE_SCOPE_INVALIDATED"],
    ["grant withdrawn", "UPDATE scope_access_grant_effective SET state='REVOKED'", "EVIDENCE_AUTHORIZATION_DENIED"],
    ["credential changed", "UPDATE scope_access_grant_effective SET credential_generation='credential-2'", "EVIDENCE_AUTHORIZATION_DENIED"],
    ["policy changed", "UPDATE scope_access_grant_effective SET policy_authority_ref='policy-2'", "EVIDENCE_AUTHORIZATION_DENIED"],
    ["source withdrawn", "UPDATE source_namespace_ownership SET status='FENCED'", "EVIDENCE_OWNER_GENERATION_MISMATCH"],
    ["source purged", "UPDATE source_revision SET purge_state='PURGE_REQUESTED'", "EVIDENCE_SOURCE_NOT_LIVE"],
    ["source missing", "DELETE FROM source_revision", "EVIDENCE_SOURCE_NOT_FOUND"],
    ["admission corrupt", `UPDATE source_admission_decision SET decision_sha256='${A}'`, "EVIDENCE_INPUT_INVALID"],
  ])("keeps the separate-read denial for %s", async (_label, mutation, code) => {
    for (const batched of [false, true]) {
      const f = await fixture(batched);
      try {
        f.database.exec(mutation);
        await expect(f.resolve()).rejects.toMatchObject({ code });
        expect(f.materialize).not.toHaveBeenCalled();
        expect(f.persist).not.toHaveBeenCalled();
      } finally { f.database.close(); }
    }
  });

  it.each([
    ["grant withdrawal", "UPDATE scope_access_grant_effective SET state='REVOKED'", "EVIDENCE_AUTHORIZATION_DENIED"],
    ["source withdrawal", "UPDATE source_namespace_ownership SET status='FENCED'", "EVIDENCE_OWNER_GENERATION_MISMATCH"],
    ["purge", "UPDATE source_revision SET purge_state='PURGE_REQUESTED'", "EVIDENCE_SOURCE_NOT_LIVE"],
  ])("rereads authority after %s between independent resolutions", async (_label, mutation, code) => {
    const f = await fixture();
    try {
      await f.resolve();
      f.database.exec(mutation);
      await expect(f.resolve()).rejects.toMatchObject({ code });
      expect(f.core.counts()).toEqual({ first: 0, batch: 2, rpc: 2 });
      expect(f.materialize).toHaveBeenCalledTimes(1);
      expect(f.persist).toHaveBeenCalledTimes(1);
    } finally { f.database.close(); }
  });

  it.each([
    [0, "UPDATE scope_access_grant_effective SET state='REVOKED'", "EVIDENCE_AUTHORIZATION_DENIED"],
    [1, "UPDATE source_revision SET purge_state='PURGE_REQUESTED'", "EVIDENCE_SOURCE_NOT_LIVE"],
  ])("observes a withdrawal at SQLite read boundary %s", async (boundary, mutation, code) => {
    const f = await fixture();
    try {
      f.core.afterRead((index) => {
        if (index !== boundary) return;
        f.core.afterRead(undefined);
        f.database.exec(mutation);
      });
      await expect(f.resolve()).rejects.toMatchObject({ code });
      expect(f.core.counts().rpc).toBe(1);
      expect(f.materialize).not.toHaveBeenCalled();
    } finally { f.database.close(); }
  });

  it.each([
    ["missing scope", "DELETE FROM scope_snapshot", 1, "EVIDENCE_SCOPE_NOT_FOUND"],
    ["corrupt scope", "UPDATE scope_snapshot SET snapshot_digest='bad'", 1, "EVIDENCE_INPUT_INVALID"],
    ["invalidated scope", "UPDATE scope_snapshot SET invalidated_at='2026-10-17T05:00:00.000Z',invalidation_reason='revoked'", 1, "EVIDENCE_SCOPE_INVALIDATED"],
    ["withdrawn grant", "UPDATE scope_access_grant_effective SET state='REVOKED'", 2, "EVIDENCE_AUTHORIZATION_DENIED"],
  ])("preserves %s ahead of a later failed D1 result", async (_label, mutation, failureIndex, code) => {
    for (const batched of [false, true]) {
      const f = await fixture(batched);
      try {
        f.database.exec(mutation);
        f.core.failResult(failureIndex);
        await expect(f.resolve()).rejects.toMatchObject({ code });
        expect(f.materialize).not.toHaveBeenCalled();
      } finally { f.database.close(); }
    }
  });

  it.each([0, 1, 2])("preserves the error and retryability of failed D1 result %s", async (failureIndex) => {
    for (const batched of [false, true]) {
      const f = await fixture(batched);
      try {
        f.core.failResult(failureIndex);
        if (failureIndex === 0) {
          await expect(f.resolve()).rejects.toMatchObject({ code: "EVIDENCE_SETTLEMENT_UNCERTAIN", retryable: true,
            cause: { message: "D1_ERROR: fixture SELECT 0" } });
        } else {
          await expect(f.resolve()).rejects.toMatchObject({ name: "Error", message: `D1_ERROR: fixture SELECT ${failureIndex}` });
        }
        expect(f.materialize).not.toHaveBeenCalled();
      } finally { f.database.close(); }
    }
  });

  it.each([0, 1, 2])("fails closed on a missing D1 result at position %s", async (index) => {
    const f = await fixture();
    try {
      f.core.mapBatch((results) => results.slice(0, index));
      if (index === 0) await expect(f.resolve()).rejects.toMatchObject({ code: "EVIDENCE_SETTLEMENT_UNCERTAIN", retryable: true });
      else await expect(f.resolve()).rejects.toThrow("D1 authority read result is incomplete");
      expect(f.materialize).not.toHaveBeenCalled();
    } finally { f.database.close(); }
  });

  it.each([
    ["DELETE FROM scope_snapshot", "EVIDENCE_SCOPE_NOT_FOUND"],
    ["UPDATE scope_access_grant_effective SET state='REVOKED'", "EVIDENCE_AUTHORIZATION_DENIED"],
  ])("uses ordered reads when a later SQL statement rejects the entire batch: %s", async (mutation, code) => {
    const f = await fixture();
    try {
      f.database.exec(mutation);
      f.database.exec("DROP TABLE source_admission_decision");
      await expect(f.resolve()).rejects.toMatchObject({ code });
      expect(f.core.counts().batch).toBe(1);
      expect(f.materialize).not.toHaveBeenCalled();
    } finally { f.database.close(); }
  });

  it("keeps source errors after handle expiry and within the existing invalidation catch", async () => {
    for (const batched of [false, true]) {
      const f = await fixture(batched);
      try {
        await f.resolve();
        f.expireHandle();
        f.core.failResult(2);
        await expect(f.reopen()).rejects.toMatchObject({ code: "EVIDENCE_HANDLE_NOT_LIVE" });
        expect(f.invalidate).toHaveBeenCalledWith(expect.anything(), "STALE", "EVIDENCE_HANDLE_EXPIRED", expect.any(String));
        expect(f.materialize).toHaveBeenCalledTimes(1);
      } finally { f.database.close(); }
    }
  });

  it("retains source-withdrawal invalidation when a live handle is reopened", async () => {
    const f = await fixture();
    try {
      await f.resolve();
      f.database.exec("UPDATE source_namespace_ownership SET status='FENCED'");
      await expect(f.reopen()).rejects.toMatchObject({ code: "EVIDENCE_OWNER_GENERATION_MISMATCH" });
      expect(f.invalidate).toHaveBeenCalledWith(expect.anything(), "STALE", "EVIDENCE_OWNER_GENERATION_MISMATCH", expect.any(String));
      expect(f.materialize).toHaveBeenCalledTimes(1);
    } finally { f.database.close(); }
  });

  it("preserves raw admission field errors instead of reclassifying them", async () => {
    for (const batched of [false, true]) {
      const f = await fixture(batched);
      try {
        f.database.exec("UPDATE source_admission_decision SET decision_sha256='bad'");
        await expect(f.resolve()).rejects.toMatchObject({ name: "TypeError",
          message: "source admission decision digest is not a lowercase SHA-256 digest" });
        expect(f.materialize).not.toHaveBeenCalled();
      } finally { f.database.close(); }
    }
  });

  it("checks expiry before a later D1 failure and retains exact materialization and persistence errors", async () => {
    const f = await fixture();
    try {
      f.setTime(Date.parse(UNTIL));
      f.core.failResult(1);
      await expect(f.resolve()).rejects.toMatchObject({ code: "EVIDENCE_SCOPE_EXPIRED" });
    } finally { f.database.close(); }
    const hash = await fixture();
    try {
      hash.materialize.mockResolvedValueOnce({ ...await hash.materialize(), source_object_sha256: B });
      await expect(hash.resolve()).rejects.toMatchObject({ code: "EVIDENCE_OBJECT_INTEGRITY" });
      expect(hash.persist).not.toHaveBeenCalled();
    } finally { hash.database.close(); }
    for (const target of ["materialize", "persist"] as const) {
      const failed = await fixture();
      try {
        const cause = new Error(`${target} unavailable`);
        failed[target].mockRejectedValueOnce(cause);
        if (target === "persist") {
          await expect(failed.resolve()).rejects.toMatchObject({ code: "EVIDENCE_SETTLEMENT_UNCERTAIN", retryable: true, cause });
        } else await expect(failed.resolve()).rejects.toBe(cause);
      } finally { failed.database.close(); }
    }
  });
});
