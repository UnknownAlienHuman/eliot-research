import { describe, expect, it } from "vitest";
import type { SourceRevision } from "@eliotr/contracts";
import { projectNormalizedMarkdown } from "@eliotr/retrieval";
import type { ExecutionFence } from "@eliotr/platform-cloudflare";
import {
  canonicalProjectionJson,
  projectionExecutionOperationId,
  projectionDigest,
  projectionSha256Utf8,
  stableProjectionId,
} from "./canonical.js";
import {
  beginManagedItemDispatch,
  prepareManagedItemEffects,
  recordManagedItemReceipt,
} from "./core-managed-items.js";
import {
  readManagedItemGenerationProof,
  readManagedItemReceipts,
} from "./core-managed-item-receipts.js";
import type {
  ProjectionExecutionProfile,
  ProjectionSourceContext,
} from "./types.js";

const A = "a".repeat(64);
const B = "b".repeat(64);
const sourceRevision: SourceRevision = {
  source_revision_ref: "revision-1",
  source_id: "source-1",
  source_namespace_id: "namespace-1",
  source_owner_system_id: "owner-1",
  source_owner_generation: "owner-generation-1",
  ownership_mode: "immutable_import",
  content_sha256: A,
  object_residency_key_digest: B,
  normalized_artifact_ref: "normalized/manifest.json",
  captured_at: "2026-08-31T12:00:00.000Z",
  parser_profile_generation: "parser-1",
  quality_state: "standard",
  purge_state: "LIVE",
};

const context = {
  intent_ref: { id: "intent-1", revision: 1 },
  job_id: "job-1",
  acceptance_attempt_id: "attempt-1",
  instruction_taint: "DATA_ONLY",
  source_revision: {
    ...sourceRevision,
  },
} as ProjectionSourceContext;

const profile = {
  managed_instance_id: "instance-1",
  managed_generation: "managed-generation-1",
  maximum_synchronous_items: 64,
  maximum_item_utf8_bytes: 64 * 1024,
} as ProjectionExecutionProfile;

const intent = {
  desired_index: 0,
  item_key: "item-1",
  provider_key: "item-1.md",
  provider_source: "builtin" as const,
  managed_instance_id: profile.managed_instance_id,
  managed_generation: profile.managed_generation,
  section_content_sha256: A,
  normalized_start_byte: 0,
  normalized_end_byte: 1,
  document_sha256: B,
  document_size_bytes: 1,
  metadata: {
    canonical_section_id: "section-1",
    content_sha256: A,
    instruction_taint: "DATA_ONLY",
    projection_generation: profile.managed_generation,
    source_revision_ref: context.source_revision.source_revision_ref,
  },
};

function databaseForManifest(
  itemCount: number,
  digest: string,
  writes: string[],
  fence: ExecutionFence,
): D1Database {
  return {
    prepare(sql: string) {
      return {
        bind() {
          return {
            async first() {
              if (sql.includes("FROM operation_execution_lease")) {
                return {
                  operation_id: fence.operation_id,
                  operation_kind: "PROJECTION_EXECUTE",
                  lease_owner: fence.lease_owner,
                  lease_generation: fence.lease_generation,
                  lease_until: 10_000,
                  state: "LEASED",
                };
              }
              if (sql.includes("FROM projection_generation")) {
                return {
                  job_id: "job-1",
                  state: "MATERIALIZED",
                  item_count: itemCount,
                  item_set_digest: digest,
                };
              }
              throw new Error(`unexpected D1 read: ${sql}`);
            },
            async run() {
              writes.push(sql);
              return { meta: { changes: 1 } };
            },
          };
        },
      };
    },
  } as unknown as D1Database;
}

async function makeFence(
  lease_generation = 1,
  lease_owner = "worker-1",
): Promise<ExecutionFence> {
  return {
    operation_id: await projectionExecutionOperationId(context, "projection-generation-1"),
    lease_owner,
    lease_generation,
  };
}

describe("prepareManagedItemEffects", () => {
  it("blocks a same-count intent set whose durable manifest digest differs before insert", async () => {
    const writes: string[] = [];
    const fence = await makeFence();
    const database = databaseForManifest(1, B, writes, fence);

    await expect(prepareManagedItemEffects(
      database,
      () => 1_000,
      context,
      "projection-generation-1",
      profile,
      [intent],
      fence,
    )).rejects.toMatchObject({ code: "PROJECTION_AUTHORITY_CONFLICT" });
    expect(writes).toEqual([]);
  });

  it("rejects a same-count changed span against the structural projector manifest before insert", async () => {
    const projection = await projectNormalizedMarkdown({
      source_revision: sourceRevision,
      title: "Document",
      source_class: "document",
      markdown: "# Heading\n\nText only.\n",
      instruction_taint: "DATA_ONLY",
      project_membership_ids: [],
      projection_generation: "projection-generation-1",
      target_item_utf8_bytes: 1024,
      max_item_utf8_bytes: 4096,
    });
    const item = projection.items[0];
    const span = projection.spans[0];
    expect(projection.items).toHaveLength(1);
    expect(item).toBeDefined();
    expect(span).toBeDefined();
    if (item === undefined || span === undefined) throw new Error("projector fixture is incomplete");
    const document = item.document_context_header.trim().length === 0
      ? item.section_text
      : `${item.document_context_header.trim()}\n\n${item.section_text}`;
    const changedIntent = {
      ...intent,
      item_key: item.item_key,
      provider_key: `${item.item_key}.md`,
      section_content_sha256: item.content_sha256,
      normalized_start_byte: span.normalized_start_byte,
      normalized_end_byte: span.normalized_end_byte + 1,
      document_sha256: await projectionSha256Utf8(document),
      document_size_bytes: new TextEncoder().encode(document).byteLength,
      metadata: {
        canonical_section_id: item.canonical_section_id,
        content_sha256: item.content_sha256,
        instruction_taint: item.instruction_taint,
        projection_generation: profile.managed_generation,
        source_revision_ref: item.source_revision_ref,
      },
    };
    const writes: string[] = [];
    const fence = await makeFence();
    const database = databaseForManifest(
      projection.items.length,
      projection.item_set_digest,
      writes,
      fence,
    );

    await expect(prepareManagedItemEffects(
      database,
      () => 1_000,
      context,
      "projection-generation-1",
      profile,
      [changedIntent],
      fence,
    )).rejects.toMatchObject({ code: "PROJECTION_AUTHORITY_CONFLICT" });
    expect(writes).toEqual([]);
  });
});

describe("managed item execution caller fences", () => {
  it("rejects stale dispatch and refuses receipt settlement after lease drift", async () => {
    const generationId = "projection-generation-1";
    const staleFence = await makeFence(1, "worker-1");
    const successorFence = await makeFence(2, "worker-2");
    const initialLease = (fence: ExecutionFence) => ({
      operation_id: fence.operation_id,
      operation_kind: "PROJECTION_EXECUTE",
      lease_owner: fence.lease_owner,
      lease_generation: fence.lease_generation,
      lease_until: 10_000,
      state: "LEASED",
    });

    function executionDatabase(
      leaseAtStart: ReturnType<typeof initialLease>,
      effectAtStart: Record<string, unknown>,
      driftTo?: ReturnType<typeof initialLease>,
    ): {
      readonly database: D1Database;
      readonly writes: string[];
      readonly effect: () => Record<string, unknown>;
    } {
      let lease = leaseAtStart;
      let effect = effectAtStart;
      const writes: string[] = [];
      const database = {
        prepare(sql: string) {
          return {
            bind(...values: unknown[]) {
              return {
                async first() {
                  if (sql.includes("FROM operation_execution_lease")) return lease;
                  if (sql.includes("FROM projection_managed_item_effect")) return effect;
                  throw new Error(`unexpected D1 read: ${sql}`);
                },
                async run() {
                  writes.push(sql);
                  if (sql.includes("SET state = 'READBACK_VERIFIED'")) {
                    effect = {
                      ...effect,
                      state: "READBACK_VERIFIED",
                      provider_item_id: values[4],
                      readback_receipt_json: values[5],
                      readback_sha256: values[6],
                    };
                    if (driftTo !== undefined) lease = driftTo;
                  }
                  return { meta: { changes: 1 } };
                },
              };
            },
          };
        },
      } as unknown as D1Database;
      return { database, writes, effect: () => effect };
    }

    const staleDispatch = executionDatabase(
      initialLease(successorFence),
      {},
    );
    await expect(beginManagedItemDispatch(
      staleDispatch.database,
      () => 1_000,
      context,
      generationId,
      "item-1",
      staleFence,
    )).rejects.toMatchObject({ code: "PROJECTION_SETTLEMENT_UNCERTAIN" });
    expect(staleDispatch.writes).toEqual([]);

    const receipt = {
      item_key: "item-1",
      provider_item_id: "provider-item-1",
      provider_key: "item-1.md",
      file_size: 1,
      chunks_count: 1,
      content_sha256: B,
      readback_sha256: "c".repeat(64),
    };
    const receiptWrite = executionDatabase(
      initialLease(staleFence),
      {
        source_revision_ref: context.source_revision.source_revision_ref,
        projection_generation: generationId,
        job_id: context.job_id,
        item_key: receipt.item_key,
        intent_id: context.intent_ref.id,
        intent_revision: context.intent_ref.revision,
        attempt_id: context.acceptance_attempt_id,
        execution_operation_id: staleFence.operation_id,
        dispatch_lease_generation: staleFence.lease_generation,
        state: "DISPATCHED",
        provider_key: receipt.provider_key,
        document_sha256: receipt.content_sha256,
        document_size_bytes: receipt.file_size,
        provider_item_id: null,
        readback_receipt_json: null,
        readback_sha256: null,
      },
      initialLease(successorFence),
    );
    await expect(recordManagedItemReceipt(
      receiptWrite.database,
      () => 1_000,
      context,
      generationId,
      receipt,
      staleFence,
    )).rejects.toMatchObject({ code: "PROJECTION_SETTLEMENT_UNCERTAIN" });
    expect(receiptWrite.writes).toHaveLength(1);
    expect(receiptWrite.effect()).toMatchObject({ state: "READBACK_VERIFIED" });
  });
});

describe("readManagedItemReceipts", () => {
  const receipt = {
    item_key: "item-1",
    provider_item_id: "provider-item-1",
    provider_key: "item-1.md",
    file_size: 1,
    chunks_count: 1,
    content_sha256: B,
    readback_sha256: "c".repeat(64),
  };
  const row = {
    item_key: "item-1",
    desired_index: 0,
    normalized_start_byte: 0,
    normalized_end_byte: 1,
    metadata_json: canonicalProjectionJson({
      canonical_section_id: "section-1",
      content_sha256: A,
      instruction_taint: "DATA_ONLY",
      projection_generation: profile.managed_generation,
      source_revision_ref: sourceRevision.source_revision_ref,
    }),
    section_content_sha256: A,
    managed_generation: profile.managed_generation,
    state: "READBACK_VERIFIED",
    provider_item_id: receipt.provider_item_id,
    managed_instance_id: profile.managed_instance_id,
    provider_key: receipt.provider_key,
    document_sha256: B,
    document_size_bytes: 1,
    readback_receipt_json: canonicalProjectionJson(receipt),
    readback_sha256: receipt.readback_sha256,
    execution_operation_id: "",
    dispatch_lease_generation: 1,
  };
  const databaseForRows = (results: readonly typeof row[]): D1Database => ({
    prepare() {
      return {
        bind() {
          return {
            async all() { return { results }; },
          };
        },
      };
    },
  } as unknown as D1Database);

  it("recomputes the exact durable required-set digest from immutable intents", async () => {
    const requiredSetDigest = await projectionDigest([{
      item_key: row.item_key,
      canonical_section_id: "section-1",
      content_sha256: A,
      start: 0,
      end: 1,
    }]);
    const readbackDigest = await projectionDigest([receipt]);

    await expect(readManagedItemReceipts(
      databaseForRows([row]),
      context,
      "projection-generation-1",
      1,
      requiredSetDigest,
      readbackDigest,
    )).resolves.toEqual([receipt]);

    await expect(readManagedItemReceipts(
      databaseForRows([{ ...row, normalized_end_byte: 2 }]),
      context,
      "projection-generation-1",
      1,
      requiredSetDigest,
      readbackDigest,
    )).rejects.toMatchObject({ code: "PROJECTION_AUTHORITY_CONFLICT" });
  });

  async function generationProofDatabase(options: {
    readonly leaseState?: string;
    readonly terminalState?: "COMPLETED" | "PARTIAL";
  } = {}) {
    const generationId = "projection-generation-1";
    const operationId = await projectionExecutionOperationId(context, generationId);
    const durableRow = { ...row, execution_operation_id: operationId };
    const requiredSetDigest = await projectionDigest([{
      item_key: row.item_key,
      canonical_section_id: "section-1",
      content_sha256: A,
      start: 0,
      end: 1,
    }]);
    const readbackDigest = await projectionDigest([receipt]);
    const managedReceiptRef = await stableProjectionId(
      "managed-search-receipt",
      sourceRevision.source_revision_ref,
      generationId,
      profile.managed_generation,
      readbackDigest,
    );
    const terminalReceiptRef = "receipt:projection-terminal-1:1";
    const terminalState = options.terminalState ?? "COMPLETED";
    const generation = {
      source_owner_generation: sourceRevision.source_owner_generation,
      content_sha256: sourceRevision.content_sha256,
      object_residency_key_digest: sourceRevision.object_residency_key_digest,
      job_id: context.job_id,
      state: terminalState,
      item_count: 1,
      item_set_digest: requiredSetDigest,
      semantic_instance_id: profile.managed_instance_id,
      semantic_generation: profile.managed_generation,
      semantic_receipt_ref: terminalState === "COMPLETED" ? managedReceiptRef : null,
      semantic_readback_digest: terminalState === "COMPLETED" ? readbackDigest : null,
    };
    const job = { state: terminalState, terminal_receipt_ref: terminalReceiptRef };
    const lease = {
      operation_kind: "PROJECTION_EXECUTE",
      lease_generation: 1,
      state: options.leaseState ?? "COMPLETED",
      terminal_receipt_ref: terminalReceiptRef,
    };
    const database = {
      prepare(sql: string) {
        return {
          bind() {
            return {
              async first() {
                if (sql.includes("FROM projection_generation")) return generation;
                if (sql.includes("FROM job")) return job;
                if (sql.includes("FROM operation_execution_lease")) return lease;
                throw new Error(`unexpected D1 read: ${sql}`);
              },
              async all() {
                if (sql.includes("execution_operation_id")) {
                  return { results: [durableRow] };
                }
                if (sql.includes("FROM projection_managed_item_effect")) {
                  return { results: [durableRow] };
                }
                throw new Error(`unexpected D1 read: ${sql}`);
              },
            };
          },
        };
      },
    } as unknown as D1Database;
    return { database, generationId, requiredSetDigest, readbackDigest, managedReceiptRef };
  }

  it("proves the exact managed target only after every item readback and writer lease complete", async () => {
    const fixture = await generationProofDatabase();
    await expect(readManagedItemGenerationProof(
      fixture.database,
      context,
      fixture.generationId,
      {
        managed_instance_id: profile.managed_instance_id,
        managed_generation: profile.managed_generation,
      },
    )).resolves.toMatchObject({
      status: "ITEMS_READBACK_VERIFIED_WRITERS_DRAINED",
      source_revision_ref: sourceRevision.source_revision_ref,
      projection_generation: fixture.generationId,
      job_id: context.job_id,
      projection_terminal_state: "COMPLETED",
      managed_instance_id: profile.managed_instance_id,
      managed_generation: profile.managed_generation,
      managed_receipt_ref: fixture.managedReceiptRef,
      item_count: 1,
      item_set_digest: fixture.requiredSetDigest,
      readback_digest: fixture.readbackDigest,
      writer_drain: {
        operation_id: await projectionExecutionOperationId(context, fixture.generationId),
        lease_generation: 1,
        state: "COMPLETED",
        terminal_receipt_ref: "receipt:projection-terminal-1:1",
      },
    });
  });

  it("retains a readback proof for a shadowed partial terminal without claiming promotion", async () => {
    const fixture = await generationProofDatabase({ terminalState: "PARTIAL" });
    await expect(readManagedItemGenerationProof(
      fixture.database,
      context,
      fixture.generationId,
      {
        managed_instance_id: profile.managed_instance_id,
        managed_generation: profile.managed_generation,
      },
    )).resolves.toMatchObject({
      status: "ITEMS_READBACK_VERIFIED_WRITERS_DRAINED",
      projection_terminal_state: "PARTIAL",
      managed_receipt_ref: fixture.managedReceiptRef,
      item_set_digest: fixture.requiredSetDigest,
      readback_digest: fixture.readbackDigest,
    });
  });

  it("blocks a target mismatch and a lease that has not drained", async () => {
    const complete = await generationProofDatabase();
    await expect(readManagedItemGenerationProof(
      complete.database,
      context,
      complete.generationId,
      {
        managed_instance_id: profile.managed_instance_id,
        managed_generation: "another-generation",
      },
    )).rejects.toMatchObject({ code: "PROJECTION_AUTHORITY_CONFLICT" });

    const active = await generationProofDatabase({ leaseState: "LEASED" });
    await expect(readManagedItemGenerationProof(
      active.database,
      context,
      active.generationId,
      {
        managed_instance_id: profile.managed_instance_id,
        managed_generation: profile.managed_generation,
      },
    )).rejects.toMatchObject({
      code: "PROJECTION_SETTLEMENT_UNCERTAIN",
      retryable: true,
    });
  });
});
