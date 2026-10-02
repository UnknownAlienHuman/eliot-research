import { describe, expect, it } from "vitest";
import {
  scopeBackupEpochsForSubject,
  scopeBackupEpochsForSubjects,
  type BackupEpochScopeArchive,
  type BackupEpochScopeDraft,
  type BackupEpochScopeSubject,
  type VerifiedBackupSourceRows,
} from "./backup-epoch-scope.js";

const MANIFESTS = [
  "schema", "schema-inventory", "ownership", "sources", "revisions", "projects", "scopes",
  "handles", "heads", "generations", "retention", "purge", "r2-objects", "rebuild", "vector",
] as const;
const HASH = "a".repeat(64);
const EMPTY_HASH = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

async function draftFor(epochId: string): Promise<{ draft_json: string; bytes: Uint8Array }> {
  const bytes = new Uint8Array();
  const part_index = await Promise.all(MANIFESTS.map(async (manifest) => ({
    manifest,
    index: 1,
    part_key: `backup-parts/${epochId}/${manifest}/000001-${EMPTY_HASH}`,
    sha256: EMPTY_HASH,
    size_bytes: bytes.byteLength,
    etag: `etag-${manifest}`,
    existed_identically: false,
  })));
  const draft: BackupEpochScopeDraft = {
    epoch_id: epochId,
    schema_generation: "schema-v1",
    migration_ledger_digest: HASH,
    manifest_digests: Object.fromEntries(MANIFESTS.map((name) => [name, HASH])),
    group_digests: { core: HASH, heads: HASH, generations: HASH, r2: HASH },
    part_index,
    purge_ledger_revision: 0,
    purge_ledger_digest: HASH,
    r2_object_count: 0,
    r2_total_bytes: 0,
    audit_sample_receipt_ref: `audit-${epochId}`,
    vector_digest: HASH,
    vector_manifest_digest: HASH,
    cut_id: `cut-${epochId}`,
    manifest_protocol: "eliotr.backup-manifest.v1",
    created_at: "2026-10-01T00:00:00.000Z",
    expires_at: "2027-10-01T00:00:00.000Z",
  };
  return { draft_json: JSON.stringify(draft), bytes };
}

async function archive(epochId: string, verification_state: unknown = "VERIFIED"): Promise<BackupEpochScopeArchive> {
  const { draft_json, bytes } = await draftFor(epochId);
  return {
    epoch_id: epochId,
    verification_state,
    read_draft_json: async () => draft_json,
    read_plaintext_part: async () => bytes,
  };
}

const source = (sourceId: string, generation: string) => ({
  table: "source",
  row: { source_id: sourceId, source_owner_generation: generation },
});
const revision = (sourceId: string, generation: string, ref: string, content = HASH, residency = HASH) => ({
  table: "source_revision",
  row: {
    source_id: sourceId,
    source_owner_generation: generation,
    source_revision_ref: ref,
    content_sha256: content,
    object_residency_key_digest: residency,
  },
});
const subject: BackupEpochScopeSubject = {
  kind: "source",
  source_id: "source-A",
  source_owner_generation: "owner-gen-A",
};

describe("exact source-to-backup-epoch scope", () => {
  it("returns only epochs whose verified source rows bind the selected owner generation", async () => {
    const archives = [await archive("epoch-A"), await archive("epoch-B")];
    const result = await scopeBackupEpochsForSubject({
      subject,
      archives,
      copy_authority_epoch_ids: ["epoch-A", "epoch-B"],
      verify_manifests: async ({ draft }): Promise<VerifiedBackupSourceRows> => ({
        source_rows: draft.epoch_id === "epoch-A" ? [source("source-A", "owner-gen-A")] : [source("source-B", "owner-gen-B")],
      }),
    });
    expect(result).toEqual(["epoch-A"]);
  });

  it("requires the exact revision, source owner, content and residency identity", async () => {
    const archives = [await archive("epoch-A"), await archive("epoch-B")];
    const selectedRevision: BackupEpochScopeSubject = {
      kind: "source-revision",
      source_id: "source-A",
      source_owner_generation: "owner-gen-A",
      source_revision_ref: "revision-A",
      content_sha256: HASH,
      object_residency_key_digest: HASH,
    };
    const result = await scopeBackupEpochsForSubject({
      subject: selectedRevision,
      archives,
      copy_authority_epoch_ids: [],
      verify_manifests: async ({ draft }): Promise<VerifiedBackupSourceRows> => ({
        source_rows: draft.epoch_id === "epoch-A"
          ? [source("source-A", "owner-gen-A"), revision("source-A", "owner-gen-A", "revision-A")]
          : [source("source-B", "owner-gen-B")],
      }),
    });
    expect(result).toEqual(["epoch-A"]);
    await expect(scopeBackupEpochsForSubject({
      subject: selectedRevision,
      archives: [archives[0] as BackupEpochScopeArchive],
      copy_authority_epoch_ids: [],
      verify_manifests: async () => ({
        source_rows: [source("source-A", "owner-gen-A"), revision("source-A", "owner-gen-A", "revision-A", HASH, "b".repeat(64))],
      }),
    })).rejects.toMatchObject({ code: "ERASURE_CLOSURE_INCOMPLETE" });
  });

  it.each(["DRAFT", "PENDING", "FAILED", "UNKNOWN"])('blocks when any epoch has state %s', async (state) => {
    await expect(scopeBackupEpochsForSubject({
      subject,
      archives: [await archive("epoch-A"), await archive("epoch-B", state)],
      copy_authority_epoch_ids: [],
      verify_manifests: async () => ({ source_rows: [source("source-A", "owner-gen-A")] }),
    })).rejects.toMatchObject({ code: "ERASURE_CLOSURE_INCOMPLETE" });
  });

  it("blocks copy authority that refers to an epoch absent from the complete local inventory", async () => {
    await expect(scopeBackupEpochsForSubject({
      subject,
      archives: [await archive("epoch-A")],
      copy_authority_epoch_ids: ["epoch-missing"],
      verify_manifests: async () => ({ source_rows: [] }),
    })).rejects.toMatchObject({ code: "ERASURE_CLOSURE_INCOMPLETE" });
  });

  it("blocks missing or changed persisted part bytes before calling the manifest verifier", async () => {
    const valid = await archive("epoch-A");
    const changed: BackupEpochScopeArchive = {
      ...valid,
      read_plaintext_part: async () => new TextEncoder().encode("different bytes"),
    };
    const verify_manifests = async () => ({ source_rows: [] });
    await expect(scopeBackupEpochsForSubject({ subject, archives: [changed], copy_authority_epoch_ids: [], verify_manifests }))
      .rejects.toMatchObject({ code: "ERASURE_CLOSURE_INCOMPLETE" });
    await expect(scopeBackupEpochsForSubject({
      subject,
      archives: [{ ...valid, read_plaintext_part: async () => null }],
      copy_authority_epoch_ids: [],
      verify_manifests,
    })).rejects.toMatchObject({ code: "ERASURE_CLOSURE_INCOMPLETE" });
  });

  it("verifies every archive once and returns source-wide and revision-scoped epochs", async () => {
    const archives = [await archive("epoch-A"), await archive("epoch-B")];
    let verifications = 0;
    const subjects: BackupEpochScopeSubject[] = [
      subject,
      {
        kind: "source-revision",
        source_id: "source-A",
        source_owner_generation: "owner-gen-A",
        source_revision_ref: "revision-A",
        content_sha256: HASH,
        object_residency_key_digest: HASH,
      },
    ];
    const result = await scopeBackupEpochsForSubjects({
      subjects,
      archives,
      copy_authority_epoch_ids: [],
      verify_manifests: async ({ draft }) => {
        verifications += 1;
        return { source_rows: draft.epoch_id === "epoch-A"
          ? [source("source-A", "owner-gen-A"), revision("source-A", "owner-gen-A", "revision-A")]
          : [source("source-A", "owner-gen-A"), revision("source-A", "owner-gen-A", "revision-B")] };
      },
    });
    expect(result).toEqual([["epoch-A", "epoch-B"], ["epoch-A"]]);
    expect(verifications).toBe(2);
  });

  it("fails closed on malformed verifier output and unverified canonical manifests", async () => {
    const archives = [await archive("epoch-A")];
    await expect(scopeBackupEpochsForSubject({
      subject,
      archives,
      copy_authority_epoch_ids: [],
      verify_manifests: async () => ({ source_rows: [{ table: "source", row: [] as unknown as Readonly<Record<string, unknown>> }] }),
    })).rejects.toMatchObject({ code: "ERASURE_CLOSURE_INCOMPLETE" });
    await expect(scopeBackupEpochsForSubject({
      subject,
      archives,
      copy_authority_epoch_ids: [],
      verify_manifests: async () => { throw new Error("portable manifest digest mismatch"); },
    })).rejects.toMatchObject({ code: "ERASURE_CLOSURE_INCOMPLETE" });
  });
});
