import type {
  OperationReceipt,
  SourceRevision,
} from "@eliotr/contracts";
import type { DeliveryMessage } from "@eliotr/platform-cloudflare";
import { describe, expect, it } from "vitest";
import {
  canonicalProjectionJson,
  legacyProjectionGeneration,
  projectionDigest,
  projectionExecutionOperationId,
  projectionGeneration as targetProjectionGeneration,
  stableProjectionId,
} from "./canonical.js";
import { createD1ProjectionAuthority } from "./core-authority.js";
import { MANAGED_ITEM_PROTOCOL_VERSION } from "./core-managed-item-receipts.js";
import type {
  ProjectionExecutionProfile,
  ProjectionSourceContext,
} from "./types.js";

const A = "a".repeat(64);
const B = "b".repeat(64);
const projectionGeneration = "projection-generation-1";
const message: DeliveryMessage = {
  protocol: "eliotr.delivery.message.v1",
  message_id: "outbox-1:1",
  topic: "source.revision.admitted",
  payload_ref: "revision-1",
  payload_sha256: A,
  idempotency_key: "projection-1",
  outbox_id: "outbox-1",
  outbox_attempt: 1,
  created_at_ms: 1,
};
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
const context: ProjectionSourceContext = {
  message,
  intent_ref: { id: "intent-1", revision: 1 },
  job_id: "job-1",
  job_state: "COMPLETED",
  acceptance_attempt_id: "attempt-1",
  source_revision: sourceRevision,
  source_title: "Document",
  source_class: "document",
  instruction_taint: "DATA_ONLY",
  project_membership_ids: [],
};
const profile: ProjectionExecutionProfile = {
  projector_profile: "structural-markdown-v1",
  managed_instance_id: "private-prose-g1",
  managed_generation: "g1",
  managed_generation_active: true,
  maximum_markdown_bytes: 4 * 1024 * 1024,
  maximum_synchronous_items: 64,
  target_item_utf8_bytes: 1024,
  maximum_item_utf8_bytes: 4096,
  managed_poll_interval_ms: 100,
  managed_timeout_ms: 1_000,
};

interface GenerationFixture {
  readonly job_id: unknown;
  readonly source_owner_generation: unknown;
  readonly content_sha256: unknown;
  readonly object_residency_key_digest: unknown;
  readonly projector_profile: unknown;
  readonly state: unknown;
  readonly item_count: unknown;
  readonly item_set_digest: unknown;
  readonly work_manifest_ref: unknown;
  readonly work_manifest_sha256: unknown;
  readonly d1_search_receipt_ref: unknown;
  readonly d1_search_readback_digest: unknown;
  readonly semantic_instance_id: unknown;
  readonly semantic_generation: unknown;
  readonly managed_item_protocol: unknown;
  readonly managed_target_instance_id: unknown;
  readonly managed_target_generation: unknown;
  readonly semantic_receipt_ref: unknown;
  readonly semantic_readback_digest: unknown;
  readonly reason_codes_json: unknown;
}

function terminalGeneration(
  overrides: Partial<GenerationFixture> = {},
): GenerationFixture {
  return {
    job_id: context.job_id,
    source_owner_generation: sourceRevision.source_owner_generation,
    content_sha256: sourceRevision.content_sha256,
    object_residency_key_digest: sourceRevision.object_residency_key_digest,
    projector_profile: profile.projector_profile,
    state: "COMPLETED",
    item_count: 1,
    item_set_digest: B,
    work_manifest_ref: "work-manifest-1",
    work_manifest_sha256: A,
    d1_search_receipt_ref: "search-receipt-1",
    d1_search_readback_digest: B,
    semantic_instance_id: profile.managed_instance_id,
    semantic_generation: profile.managed_generation,
    managed_item_protocol: null,
    managed_target_instance_id: null,
    managed_target_generation: null,
    semantic_receipt_ref: "managed-receipt-1",
    semantic_readback_digest: A,
    reason_codes_json: "[]",
    ...overrides,
  };
}

function terminalDatabase(
  generation: GenerationFixture,
  itemRows: readonly unknown[] = [],
  options: {
    readonly generationId?: string;
    readonly generationsById?: ReadonlyMap<string, GenerationFixture>;
    readonly terminalReceipt?: OperationReceipt;
    readonly executionLeaseState?: unknown;
  } = {},
): {
  readonly database: D1Database;
  readonly queries: string[];
  readonly generationLookups: string[];
} {
  const terminalGenerationId = options.generationId ?? projectionGeneration;
  const generationsById = options.generationsById ??
    new Map([[terminalGenerationId, generation]]);
  const queries: string[] = [];
  const generationLookups: string[] = [];
  const receipt: OperationReceipt = options.terminalReceipt ?? {
    receipt_ref: { id: "terminal-receipt-1", revision: 1 },
    intent_ref: context.intent_ref,
    attempt_id: context.acceptance_attempt_id,
    outcome: "SUCCEEDED",
    output_refs: [
      context.job_id,
      "projection-generation:" + terminalGenerationId,
    ],
    readback_receipt_refs: ["managed-receipt-1"],
    reconciliation_required: false,
    reason_codes: [],
    created_at: "2026-08-31T12:00:00.000Z",
  };
  const database = {
    prepare(sql: string) {
      queries.push(sql);
      return {
        bind(...values: readonly unknown[]) {
          return {
            async first<T>() {
              if (sql.includes("FROM projection_generation")) {
                const requestedGeneration = values[1];
                if (typeof requestedGeneration !== "string") return null as T;
                generationLookups.push(requestedGeneration);
                return (generationsById.get(requestedGeneration) ?? null) as T;
              }
              if (sql.includes("FROM job ")) {
                return {
                  state: generation.state === "PARTIAL" ? "PARTIAL" : "COMPLETED",
                  terminal_receipt_ref: "receipt:terminal-receipt-1:1",
                } as T;
              }
              if (sql.includes("FROM operation_execution_lease")) {
                return {
                  operation_kind: "PROJECTION_EXECUTE",
                  lease_generation: 1,
                  state: options.executionLeaseState ?? "COMPLETED",
                  terminal_receipt_ref: "receipt:terminal-receipt-1:1",
                } as T;
              }
              if (sql.includes("FROM operation_receipt")) {
                return {
                  receipt_id: receipt.receipt_ref.id,
                  revision: receipt.receipt_ref.revision,
                  intent_id: receipt.intent_ref.id,
                  intent_revision: receipt.intent_ref.revision,
                  attempt_id: receipt.attempt_id,
                  outcome: receipt.outcome,
                  output_refs_json: canonicalProjectionJson(receipt.output_refs),
                  readback_receipt_refs_json: canonicalProjectionJson(
                    receipt.readback_receipt_refs,
                  ),
                  reconciliation_required: receipt.reconciliation_required ? 1 : 0,
                  reason_codes_json: canonicalProjectionJson(receipt.reason_codes),
                  created_at: receipt.created_at,
                } as T;
              }
              if (sql.includes("FROM projection_terminal_guard")) {
                if (values[1] !== terminalGenerationId) return null as T;
                return {
                  job_id: context.job_id,
                  terminal_receipt_id: receipt.receipt_ref.id,
                  terminal_receipt_revision: receipt.receipt_ref.revision,
                  outcome: receipt.outcome,
                  verified: 1,
                } as T;
              }
              throw new Error("unexpected first() query: " + sql);
            },
            async all<T>() {
              if (sql.includes("FROM projection_managed_item_effect")) {
                return { results: itemRows as T[] };
              }
              throw new Error("unexpected all() query: " + sql);
            },
          };
        },
      };
    },
  } as unknown as D1Database;
  return { database, queries, generationLookups };
}

async function validManagedTerminalFixture(): Promise<{
  readonly generation: GenerationFixture;
  readonly itemRows: readonly unknown[];
  readonly managedReceiptRef: string;
  readonly terminalReceipt: OperationReceipt;
}> {
  const itemKey = "item-1";
  const canonicalSectionId = "section-1";
  const itemReceipt = {
    item_key: itemKey,
    provider_item_id: "provider-item-1",
    provider_key: `${itemKey}.md`,
    file_size: 3,
    chunks_count: 1,
    content_sha256: A,
    readback_sha256: B,
  };
  const itemSetDigest = await projectionDigest([{
    item_key: itemKey,
    canonical_section_id: canonicalSectionId,
    content_sha256: A,
    start: 0,
    end: 3,
  }]);
  const readbackDigest = await projectionDigest([itemReceipt]);
  const managedReceiptRef = await stableProjectionId(
    "managed-search-receipt",
    sourceRevision.source_revision_ref,
    projectionGeneration,
    profile.managed_generation,
    readbackDigest,
  );
  const generation = terminalGeneration({
    managed_item_protocol: MANAGED_ITEM_PROTOCOL_VERSION,
    managed_target_instance_id: profile.managed_instance_id,
    managed_target_generation: profile.managed_generation,
    item_set_digest: itemSetDigest,
    semantic_receipt_ref: managedReceiptRef,
    semantic_readback_digest: readbackDigest,
  });
  const operationId = await projectionExecutionOperationId(context, projectionGeneration);
  const itemRows = [{
    execution_operation_id: operationId,
    dispatch_lease_generation: 1,
    managed_instance_id: profile.managed_instance_id,
    managed_generation: profile.managed_generation,
    state: "READBACK_VERIFIED",
    item_key: itemKey,
    desired_index: 0,
    normalized_start_byte: 0,
    normalized_end_byte: 3,
    metadata_json: canonicalProjectionJson({
      canonical_section_id: canonicalSectionId,
      content_sha256: A,
      instruction_taint: context.instruction_taint,
      projection_generation: profile.managed_generation,
      source_revision_ref: sourceRevision.source_revision_ref,
    }),
    section_content_sha256: A,
    provider_item_id: itemReceipt.provider_item_id,
    provider_key: itemReceipt.provider_key,
    document_sha256: A,
    document_size_bytes: 3,
    readback_receipt_json: canonicalProjectionJson(itemReceipt),
    readback_sha256: B,
  }];
  const terminalReceipt: OperationReceipt = {
    receipt_ref: { id: "terminal-receipt-1", revision: 1 },
    intent_ref: context.intent_ref,
    attempt_id: context.acceptance_attempt_id,
    outcome: "SUCCEEDED",
    output_refs: [
      context.job_id,
      `projection-generation:${projectionGeneration}`,
      managedReceiptRef,
    ],
    readback_receipt_refs: [managedReceiptRef],
    reconciliation_required: false,
    reason_codes: [],
    created_at: "2026-08-31T12:00:00.000Z",
  };
  return { generation, itemRows, managedReceiptRef, terminalReceipt };
}

describe("projection terminal managed-item compatibility", () => {
  it("replays a legacy aggregate success without item rows and never proves per-item generation", async () => {
    // These legacy NULL rows remain unchanged by 0128_managed_item_effects.sql
    // and 0129_managed_item_protocol.sql; no per-item receipt backfill is implied.
    const { database, queries } = terminalDatabase(terminalGeneration());
    const authority = createD1ProjectionAuthority({ database });

    const terminal = await authority.readTerminal(
      context,
      projectionGeneration,
      profile,
    );
    expect(terminal?.outcome).toBe("SUCCEEDED");
    expect(terminal?.receipt_ref).toBe("receipt:terminal-receipt-1:1");
    expect(queries.some((sql) => sql.includes("projection_managed_item_effect"))).toBe(false);

    await expect(authority.readManagedItemGenerationProof(
      context,
      projectionGeneration,
      {
        managed_instance_id: profile.managed_instance_id,
        managed_generation: profile.managed_generation,
      },
    )).rejects.toMatchObject({ code: "PROJECTION_AUTHORITY_CONFLICT" });
    expect(queries.some((sql) => sql.includes("projection_managed_item_effect"))).toBe(false);
  });

  it("replays the stored legacy terminal when the requested target-bound generation is absent", async () => {
    const targetGeneration = await targetProjectionGeneration(context, profile);
    const legacyGeneration = await legacyProjectionGeneration(context, profile);
    expect(targetGeneration).not.toBe(legacyGeneration);

    const historical = terminalGeneration();
    const historicalDatabase = terminalDatabase(historical, [], {
      generationId: legacyGeneration,
      generationsById: new Map([[legacyGeneration, historical]]),
    });
    const terminal = await createD1ProjectionAuthority({
      database: historicalDatabase.database,
    }).readTerminal(context, targetGeneration, profile);

    expect(terminal?.outcome).toBe("SUCCEEDED");
    expect(terminal?.receipt_ref).toBe("receipt:terminal-receipt-1:1");
    expect(terminal?.projection_generation).toBe(legacyGeneration);
    expect(historicalDatabase.generationLookups).toEqual([
      targetGeneration,
      legacyGeneration,
    ]);
    expect(
      historicalDatabase.queries.some((sql) => sql.includes("projection_managed_item_effect")),
    ).toBe(false);

    const retargeted = terminalGeneration({
      semantic_generation: "another-managed-generation",
    });
    const retargetedDatabase = terminalDatabase(retargeted, [], {
      generationId: legacyGeneration,
      generationsById: new Map([[legacyGeneration, retargeted]]),
    });
    await expect(createD1ProjectionAuthority({
      database: retargetedDatabase.database,
    }).readTerminal(context, targetGeneration, profile)).rejects.toMatchObject({
      code: "PROJECTION_AUTHORITY_CONFLICT",
    });

    const nonterminal = terminalGeneration({
      state: "MATERIALIZED",
      semantic_generation: "not-a-terminal-target",
    });
    const nonterminalDatabase = terminalDatabase(nonterminal, [], {
      generationId: legacyGeneration,
      generationsById: new Map([[legacyGeneration, nonterminal]]),
    });
    await expect(createD1ProjectionAuthority({
      database: nonterminalDatabase.database,
    }).readTerminal(context, targetGeneration, profile)).resolves.toBeNull();
  });

  it("requires item readback for the new protocol and fails closed on unknown markers", async () => {
    const versioned = terminalGeneration({
      managed_item_protocol: MANAGED_ITEM_PROTOCOL_VERSION,
      managed_target_instance_id: profile.managed_instance_id,
      managed_target_generation: profile.managed_generation,
    });
    const missingItems = terminalDatabase(versioned);
    const authority = createD1ProjectionAuthority({
      database: missingItems.database,
    });
    await expect(authority.readTerminal(
      context,
      projectionGeneration,
      profile,
    )).rejects.toMatchObject({ code: "PROJECTION_AUTHORITY_CONFLICT" });
    expect(
      missingItems.queries.some((sql) => sql.includes("projection_managed_item_effect")),
    ).toBe(true);

    const unknown = terminalDatabase(terminalGeneration({
      managed_item_protocol: "eliotr.managed-item-effects.v2",
      managed_target_instance_id: profile.managed_instance_id,
      managed_target_generation: profile.managed_generation,
    }));
    await expect(createD1ProjectionAuthority({ database: unknown.database }).readTerminal(
      context,
      projectionGeneration,
      profile,
    )).rejects.toMatchObject({ code: "PROJECTION_AUTHORITY_CONFLICT" });
    expect(unknown.queries.some((sql) => sql.includes("projection_managed_item_effect"))).toBe(false);
  });

  it("requires the exact managed proof and binds it into terminal output and readback refs", async () => {
    const valid = await validManagedTerminalFixture();
    const missingReceipt = terminalDatabase(terminalGeneration({
      ...valid.generation,
      semantic_receipt_ref: null,
      semantic_readback_digest: null,
    }), valid.itemRows, { terminalReceipt: valid.terminalReceipt });
    await expect(createD1ProjectionAuthority({ database: missingReceipt.database }).readTerminal(
      context,
      projectionGeneration,
      profile,
    )).rejects.toMatchObject({ code: "PROJECTION_AUTHORITY_CONFLICT" });

    const forgedReference = terminalDatabase(terminalGeneration({
      ...valid.generation,
      semantic_receipt_ref: "forged-managed-receipt",
    }), valid.itemRows, { terminalReceipt: valid.terminalReceipt });
    await expect(createD1ProjectionAuthority({ database: forgedReference.database }).readTerminal(
      context,
      projectionGeneration,
      profile,
    )).rejects.toMatchObject({ code: "PROJECTION_AUTHORITY_CONFLICT" });

    const unboundOutput = terminalDatabase(valid.generation, valid.itemRows, {
      terminalReceipt: {
        ...valid.terminalReceipt,
        output_refs: valid.terminalReceipt.output_refs.filter((ref) =>
          ref !== valid.managedReceiptRef
        ),
      },
    });
    await expect(createD1ProjectionAuthority({ database: unboundOutput.database }).readTerminal(
      context,
      projectionGeneration,
      profile,
    )).rejects.toMatchObject({ code: "PROJECTION_AUTHORITY_CONFLICT" });

    const unboundReadback = terminalDatabase(valid.generation, valid.itemRows, {
      terminalReceipt: {
        ...valid.terminalReceipt,
        readback_receipt_refs: [],
      },
    });
    await expect(createD1ProjectionAuthority({ database: unboundReadback.database }).readTerminal(
      context,
      projectionGeneration,
      profile,
    )).rejects.toMatchObject({ code: "PROJECTION_AUTHORITY_CONFLICT" });

    const runningLease = terminalDatabase(valid.generation, valid.itemRows, {
      terminalReceipt: valid.terminalReceipt,
      executionLeaseState: "LEASED",
    });
    const runningTerminal = await createD1ProjectionAuthority({
      database: runningLease.database,
    }).readTerminal(context, projectionGeneration, profile);
    expect(runningTerminal?.outcome).toBe("SUCCEEDED");
    expect(runningLease.queries.some((sql) => sql.includes("FROM operation_execution_lease"))).toBe(false);

    const partialGeneration = terminalGeneration({
      state: "PARTIAL",
      managed_item_protocol: MANAGED_ITEM_PROTOCOL_VERSION,
      managed_target_instance_id: profile.managed_instance_id,
      managed_target_generation: profile.managed_generation,
      semantic_receipt_ref: null,
      semantic_readback_digest: null,
    });
    const partialReceipt: OperationReceipt = {
      receipt_ref: { id: "terminal-receipt-1", revision: 1 },
      intent_ref: context.intent_ref,
      attempt_id: context.acceptance_attempt_id,
      outcome: "PARTIAL",
      output_refs: [
        context.job_id,
        `projection-generation:${projectionGeneration}`,
        "work-manifest-1",
        "search-receipt-1",
      ],
      readback_receipt_refs: ["work-manifest-1", "search-receipt-1"],
      reconciliation_required: true,
      reason_codes: ["MANAGED_SEMANTIC_DEGRADED"],
      created_at: "2026-08-31T12:00:00.000Z",
    };
    const partialDegraded = terminalDatabase(partialGeneration, [], {
      terminalReceipt: partialReceipt,
    });
    const partialTerminal = await createD1ProjectionAuthority({
      database: partialDegraded.database,
    }).readTerminal(context, projectionGeneration, profile);
    expect(partialTerminal?.outcome).toBe("PARTIAL");
    expect(
      partialDegraded.queries.some((sql) => sql.includes("projection_managed_item_effect")),
    ).toBe(false);

    const partialReadyClaim = terminalDatabase(partialGeneration, [], {
      terminalReceipt: {
        ...partialReceipt,
        output_refs: [...partialReceipt.output_refs, "unpersisted-managed-ready-ref"],
        readback_receipt_refs: [
          ...partialReceipt.readback_receipt_refs,
          "unpersisted-managed-ready-ref",
        ],
      },
    });
    await expect(createD1ProjectionAuthority({ database: partialReadyClaim.database }).readTerminal(
      context,
      projectionGeneration,
      profile,
    )).rejects.toMatchObject({ code: "PROJECTION_AUTHORITY_CONFLICT" });
  });

  it("rejects retargeting a legacy terminal whose stored semantic target differs", async () => {
    const { database, queries } = terminalDatabase(terminalGeneration({
      semantic_instance_id: "another-managed-instance",
    }));
    await expect(createD1ProjectionAuthority({ database }).readTerminal(
      context,
      projectionGeneration,
      profile,
    )).rejects.toMatchObject({ code: "PROJECTION_AUTHORITY_CONFLICT" });
    expect(queries).toHaveLength(1);
  });
});
