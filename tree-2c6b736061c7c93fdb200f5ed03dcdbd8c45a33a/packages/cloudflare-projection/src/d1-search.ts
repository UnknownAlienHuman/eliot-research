import type { ProjectionItem } from "@eliotr/contracts";
import type { MarkdownProjectionResult, ProjectionSpan } from "@eliotr/retrieval";
import {
  assertProjectionIdentifier,
  assertProjectionInteger,
  assertProjectionSha256,
  canonicalProjectionJson,
  projectionDigest,
  projectionFail,
  stableProjectionId,
} from "./canonical.js";
import type {
  ProjectionSearchPort,
  ProjectionSearchReceipt,
  ProjectionSourceContext,
} from "./types.js";

const INSERT_CHUNK_SIZE = 16;

interface GenerationRow {
  readonly state: unknown;
  readonly item_count: unknown;
  readonly item_set_digest: unknown;
  readonly readback_digest: unknown;
  readonly receipt_ref: unknown;
}

interface ReadbackRow {
  readonly item_key: unknown;
  readonly canonical_section_id: unknown;
  readonly content_sha256: unknown;
  readonly normalized_start_byte: unknown;
  readonly normalized_end_byte: unknown;
}

interface ActiveCountRow {
  readonly active_count: unknown;
}

interface ActivationGuardRow {
  readonly receipt_ref: unknown;
  readonly readback_digest: unknown;
  readonly item_count: unknown;
  readonly verified: unknown;
}

function exactProjectionOrder(
  projection: MarkdownProjectionResult,
): readonly {
  readonly item: ProjectionItem;
  readonly span: ProjectionSpan;
}[] {
  return projection.items.map((item, index) => {
    const span = projection.spans[index];
    if (span === undefined || span.item_key !== item.item_key) {
      projectionFail(
        "PROJECTION_INPUT_INVALID",
        "projection item/span alignment is invalid",
      );
    }
    return { item, span };
  });
}

function decodeGeneration(
  row: GenerationRow,
  expectedCount: number,
  expectedDigest: string,
): {
  readonly state: "BUILDING" | "READY" | "STALE" | "RETIRED";
  readonly receipt_ref?: string;
  readonly readback_digest?: string;
} {
  if (
    row.state !== "BUILDING" &&
    row.state !== "READY" &&
    row.state !== "STALE" &&
    row.state !== "RETIRED"
  ) {
    projectionFail("PROJECTION_AUTHORITY_CONFLICT", "stored projection generation state is invalid");
  }
  const count = assertProjectionInteger(row.item_count, "stored item_count", 1, 1024);
  const digest = assertProjectionSha256(row.item_set_digest, "stored item_set_digest");
  if (count !== expectedCount || digest !== expectedDigest) {
    projectionFail(
      "PROJECTION_AUTHORITY_CONFLICT",
      "projection generation is already bound to another item set",
    );
  }
  const receipt = row.receipt_ref === null
    ? undefined
    : assertProjectionIdentifier(row.receipt_ref, "stored projection receipt_ref");
  const readback = row.readback_digest === null
    ? undefined
    : assertProjectionSha256(row.readback_digest, "stored projection readback_digest");
  return {
    state: row.state,
    ...(receipt === undefined ? {} : { receipt_ref: receipt }),
    ...(readback === undefined ? {} : { readback_digest: readback }),
  };
}

async function readGeneration(
  database: D1Database,
  sourceRevisionRef: string,
  projectionGeneration: string,
): Promise<GenerationRow | null> {
  return database.prepare(
    "SELECT state, item_count, item_set_digest, readback_digest, receipt_ref " +
    "FROM projection_generation_receipt WHERE source_revision_ref = ?1 " +
    "AND projection_generation = ?2 LIMIT 1",
  ).bind(sourceRevisionRef, projectionGeneration).first<GenerationRow>();
}

async function activeItemCount(
  database: D1Database,
  sourceRevisionRef: string,
  projectionGeneration: string,
): Promise<number> {
  const row = await database.prepare(
    "SELECT COUNT(*) AS active_count FROM projection_item WHERE source_revision_ref = ?1 " +
    "AND projection_generation = ?2 AND active = 1",
  ).bind(sourceRevisionRef, projectionGeneration).first<ActiveCountRow>();
  return assertProjectionInteger(
    row?.active_count,
    "active projection item count",
    0,
    1024,
  );
}

async function readActivationGuard(
  database: D1Database,
  sourceRevisionRef: string,
  projectionGeneration: string,
): Promise<ActivationGuardRow | null> {
  return database.prepare(
    "SELECT receipt_ref, readback_digest, item_count, verified " +
    "FROM projection_activation_guard WHERE source_revision_ref = ?1 " +
    "AND projection_generation = ?2 LIMIT 1",
  ).bind(sourceRevisionRef, projectionGeneration).first<ActivationGuardRow>();
}

function validateActivationGuard(
  row: ActivationGuardRow,
  receiptRef: string,
  readbackDigest: string,
  itemCount: number,
): void {
  if (
    row.receipt_ref !== receiptRef ||
    row.readback_digest !== readbackDigest ||
    row.item_count !== itemCount ||
    row.verified !== 1
  ) {
    projectionFail(
      "PROJECTION_AUTHORITY_CONFLICT",
      "D1 Search activation guard differs from the generation receipt",
    );
  }
}

async function initializeGeneration(
  database: D1Database,
  context: ProjectionSourceContext,
  projectionGeneration: string,
  projection: MarkdownProjectionResult,
  now: string,
): Promise<ProjectionSearchReceipt | null> {
  const existing = await readGeneration(
    database,
    context.source_revision.source_revision_ref,
    projectionGeneration,
  );
  if (existing !== null) {
    const decoded = decodeGeneration(
      existing,
      projection.items.length,
      projection.item_set_digest,
    );
    if (
      decoded.state === "READY" &&
      decoded.receipt_ref !== undefined &&
      decoded.readback_digest !== undefined
    ) {
      const [guard, activeCount] = await Promise.all([
        readActivationGuard(
          database,
          context.source_revision.source_revision_ref,
          projectionGeneration,
        ),
        activeItemCount(
          database,
          context.source_revision.source_revision_ref,
          projectionGeneration,
        ),
      ]);
      if (guard === null || activeCount !== projection.items.length) {
        projectionFail(
          "PROJECTION_SETTLEMENT_UNCERTAIN",
          "READY D1 Search generation has incomplete activation authority",
          true,
        );
      }
      validateActivationGuard(
        guard,
        decoded.receipt_ref,
        decoded.readback_digest,
        projection.items.length,
      );
      return {
        receipt_ref: decoded.receipt_ref,
        readback_digest: decoded.readback_digest,
        item_set_digest: projection.item_set_digest,
        item_count: projection.items.length,
        projection_generation: projectionGeneration,
      };
    }
    if (decoded.state !== "BUILDING") {
      projectionFail(
        "PROJECTION_AUTHORITY_CONFLICT",
        "stale or retired projection generation cannot be rebuilt in place",
      );
    }
  } else {
    await database.prepare(
      "INSERT INTO projection_generation_receipt(" +
      "source_revision_ref, projection_generation, state, item_count, item_set_digest, " +
      "created_at, updated_at) VALUES (?1,?2,'BUILDING',?3,?4,?5,?5)",
    ).bind(
      context.source_revision.source_revision_ref,
      projectionGeneration,
      projection.items.length,
      projection.item_set_digest,
      now,
    ).run();
  }
  return null;
}

async function clearShadowGeneration(
  database: D1Database,
  sourceRevisionRef: string,
  projectionGeneration: string,
): Promise<void> {
  await database.batch([
    database.prepare(
      "DELETE FROM section_fts WHERE item_key IN (" +
      "SELECT item_key FROM projection_item WHERE source_revision_ref = ?1 " +
      "AND projection_generation = ?2 AND active = 0)",
    ).bind(sourceRevisionRef, projectionGeneration),
    database.prepare(
      "DELETE FROM projection_span WHERE source_revision_ref = ?1 " +
      "AND projection_generation = ?2",
    ).bind(sourceRevisionRef, projectionGeneration),
    database.prepare(
      "DELETE FROM projection_item WHERE source_revision_ref = ?1 " +
      "AND projection_generation = ?2 AND active = 0",
    ).bind(sourceRevisionRef, projectionGeneration),
  ]);
}

function insertionStatements(
  database: D1Database,
  context: ProjectionSourceContext,
  projectionGeneration: string,
  item: ProjectionItem,
  span: ProjectionSpan,
  now: string,
): readonly D1PreparedStatement[] {
  return [
    database.prepare(
      "INSERT INTO projection_item(" +
      "item_key, source_revision_ref, canonical_section_id, project_membership_ids_json, " +
      "source_class, title, heading_path, document_context_header, section_text, " +
      "normalized_offset_map_ref, content_sha256, instruction_taint, projection_generation, " +
      "active, updated_at) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,0,?14)",
    ).bind(
      item.item_key,
      item.source_revision_ref,
      item.canonical_section_id,
      canonicalProjectionJson(item.project_membership_ids),
      context.source_class,
      context.source_title,
      canonicalProjectionJson(item.heading_path),
      item.document_context_header,
      item.section_text,
      item.normalized_offset_map_ref,
      item.content_sha256,
      item.instruction_taint,
      projectionGeneration,
      now,
    ),
    database.prepare(
      "INSERT INTO section_fts(item_key, title, heading_path, document_context_header, section_text) " +
      "VALUES (?1,?2,?3,?4,?5)",
    ).bind(
      item.item_key,
      context.source_title,
      item.heading_path.join(" / "),
      item.document_context_header,
      item.section_text,
    ),
    database.prepare(
      "INSERT INTO projection_span(" +
      "item_key, source_revision_ref, normalized_start_byte, normalized_end_byte, " +
      "precision_kind, projection_generation) VALUES (?1,?2,?3,?4,'normalized_bytes',?5)",
    ).bind(
      item.item_key,
      item.source_revision_ref,
      span.normalized_start_byte,
      span.normalized_end_byte,
      projectionGeneration,
    ),
  ];
}

async function stageProjection(
  database: D1Database,
  context: ProjectionSourceContext,
  projectionGeneration: string,
  projection: MarkdownProjectionResult,
  now: string,
): Promise<void> {
  await clearShadowGeneration(
    database,
    context.source_revision.source_revision_ref,
    projectionGeneration,
  );
  const ordered = exactProjectionOrder(projection);
  for (let offset = 0; offset < ordered.length; offset += INSERT_CHUNK_SIZE) {
    const statements = ordered
      .slice(offset, offset + INSERT_CHUNK_SIZE)
      .flatMap(({ item, span }) => insertionStatements(
        database,
        context,
        projectionGeneration,
        item,
        span,
        now,
      ));
    await database.batch(statements);
  }
}

function decodeReadbackRow(row: ReadbackRow): {
  readonly item_key: string;
  readonly canonical_section_id: string;
  readonly content_sha256: string;
  readonly normalized_start_byte: number;
  readonly normalized_end_byte: number;
} {
  const start = assertProjectionInteger(
    row.normalized_start_byte,
    "stored normalized_start_byte",
    0,
    Number.MAX_SAFE_INTEGER,
  );
  const end = assertProjectionInteger(
    row.normalized_end_byte,
    "stored normalized_end_byte",
    1,
    Number.MAX_SAFE_INTEGER,
  );
  if (end <= start) {
    projectionFail("PROJECTION_AUTHORITY_CONFLICT", "stored projection span is empty or reversed");
  }
  return {
    item_key: assertProjectionIdentifier(row.item_key, "stored item_key"),
    canonical_section_id: assertProjectionIdentifier(
      row.canonical_section_id,
      "stored canonical_section_id",
    ),
    content_sha256: assertProjectionSha256(row.content_sha256, "stored content_sha256"),
    normalized_start_byte: start,
    normalized_end_byte: end,
  };
}

async function verifyShadow(
  database: D1Database,
  context: ProjectionSourceContext,
  projectionGeneration: string,
  projection: MarkdownProjectionResult,
): Promise<string> {
  const result = await database.prepare(
    "SELECT p.item_key, p.canonical_section_id, p.content_sha256, " +
    "s.normalized_start_byte, s.normalized_end_byte " +
    "FROM projection_item p JOIN projection_span s ON s.item_key = p.item_key " +
    "WHERE p.source_revision_ref = ?1 AND p.projection_generation = ?2 AND p.active = 0 " +
    "ORDER BY s.normalized_start_byte, p.item_key",
  ).bind(
    context.source_revision.source_revision_ref,
    projectionGeneration,
  ).all<ReadbackRow>();
  const rows = (result.results ?? []).map(decodeReadbackRow);
  const expected = exactProjectionOrder(projection).map(({ item, span }) => ({
    item_key: item.item_key,
    canonical_section_id: item.canonical_section_id,
    content_sha256: item.content_sha256,
    normalized_start_byte: span.normalized_start_byte,
    normalized_end_byte: span.normalized_end_byte,
  }));
  if (canonicalProjectionJson(rows) !== canonicalProjectionJson(expected)) {
    projectionFail(
      "PROJECTION_SETTLEMENT_UNCERTAIN",
      "D1 Search shadow generation readback differs from projector output",
      true,
    );
  }
  const digest = await projectionDigest(rows.map((row) => ({
    item_key: row.item_key,
    canonical_section_id: row.canonical_section_id,
    content_sha256: row.content_sha256,
    start: row.normalized_start_byte,
    end: row.normalized_end_byte,
  })));
  if (digest !== projection.item_set_digest) {
    projectionFail(
      "PROJECTION_AUTHORITY_CONFLICT",
      "D1 Search readback digest differs from the structural projector",
    );
  }
  return digest;
}

async function activateGeneration(
  database: D1Database,
  context: ProjectionSourceContext,
  projectionGeneration: string,
  projection: MarkdownProjectionResult,
  readbackDigest: string,
  now: string,
): Promise<ProjectionSearchReceipt> {
  const receiptRef = await stableProjectionId(
    "d1-search-receipt",
    context.source_revision.source_revision_ref,
    projectionGeneration,
    readbackDigest,
  );
  await database.batch([
    database.prepare(
      "UPDATE projection_item SET active = 0, updated_at = ?3 " +
      "WHERE source_revision_ref = ?1 AND projection_generation <> ?2 AND active = 1",
    ).bind(context.source_revision.source_revision_ref, projectionGeneration, now),
    database.prepare(
      "UPDATE projection_item SET active = 1, updated_at = ?3 " +
      "WHERE source_revision_ref = ?1 AND projection_generation = ?2",
    ).bind(context.source_revision.source_revision_ref, projectionGeneration, now),
    ...["exact", "lexical"].map((channel) => database.prepare(
      "INSERT INTO projection_watermark(" +
      "channel, projection_generation, source_revision_ref, projected_item_count, state, " +
      "readback_receipt_ref, updated_at) VALUES (?1,?2,?3,?4,'READY',?5,?6) " +
      "ON CONFLICT(channel, projection_generation, source_revision_ref) DO UPDATE SET " +
      "projected_item_count = excluded.projected_item_count, state = 'READY', " +
      "readback_receipt_ref = excluded.readback_receipt_ref, updated_at = excluded.updated_at",
    ).bind(
      channel,
      projectionGeneration,
      context.source_revision.source_revision_ref,
      projection.items.length,
      receiptRef,
      now,
    )),
    database.prepare(
      "UPDATE projection_generation_receipt SET state = 'READY', readback_digest = ?3, " +
      "receipt_ref = ?4, updated_at = ?5 WHERE source_revision_ref = ?1 " +
      "AND projection_generation = ?2 AND state = 'BUILDING' " +
      "AND item_count = ?6 AND item_set_digest = ?7",
    ).bind(
      context.source_revision.source_revision_ref,
      projectionGeneration,
      readbackDigest,
      receiptRef,
      now,
      projection.items.length,
      projection.item_set_digest,
    ),
    database.prepare(
      "INSERT INTO projection_activation_guard(" +
      "source_revision_ref, projection_generation, receipt_ref, readback_digest, " +
      "item_count, verified, created_at) SELECT ?1,?2,?3,?4,?5,CASE WHEN " +
      "EXISTS (SELECT 1 FROM projection_generation_receipt r " +
      "WHERE r.source_revision_ref = ?1 AND r.projection_generation = ?2 " +
      "AND r.state = 'READY' AND r.receipt_ref = ?3 AND r.readback_digest = ?4 " +
      "AND r.item_count = ?5 AND r.item_set_digest = ?6) " +
      "AND (SELECT COUNT(*) FROM projection_item p WHERE p.source_revision_ref = ?1 " +
      "AND p.projection_generation = ?2 AND p.active = 1) = ?5 " +
      "AND (SELECT COUNT(*) FROM projection_span s WHERE s.source_revision_ref = ?1 " +
      "AND s.projection_generation = ?2) = ?5 " +
      "AND (SELECT COUNT(*) FROM section_fts f JOIN projection_item p " +
      "ON p.item_key = f.item_key WHERE p.source_revision_ref = ?1 " +
      "AND p.projection_generation = ?2) = ?5 " +
      "AND (SELECT COUNT(*) FROM projection_item p WHERE p.source_revision_ref = ?1 " +
      "AND p.projection_generation <> ?2 AND p.active = 1) = 0 " +
      "THEN 1 ELSE NULL END,?7",
    ).bind(
      context.source_revision.source_revision_ref,
      projectionGeneration,
      receiptRef,
      readbackDigest,
      projection.items.length,
      projection.item_set_digest,
      now,
    ),
  ]);
  const [activeCount, generation, guard] = await Promise.all([
    activeItemCount(
      database,
      context.source_revision.source_revision_ref,
      projectionGeneration,
    ),
    readGeneration(
      database,
      context.source_revision.source_revision_ref,
      projectionGeneration,
    ),
    readActivationGuard(
      database,
      context.source_revision.source_revision_ref,
      projectionGeneration,
    ),
  ]);
  if (generation === null || guard === null || activeCount !== projection.items.length) {
    projectionFail(
      "PROJECTION_SETTLEMENT_UNCERTAIN",
      "D1 Search generation activation readback is incomplete",
      true,
    );
  }
  const decoded = decodeGeneration(
    generation,
    projection.items.length,
    projection.item_set_digest,
  );
  if (
    decoded.state !== "READY" ||
    decoded.receipt_ref !== receiptRef ||
    decoded.readback_digest !== readbackDigest
  ) {
    projectionFail(
      "PROJECTION_SETTLEMENT_UNCERTAIN",
      "D1 Search generation receipt did not settle exactly",
      true,
    );
  }
  validateActivationGuard(guard, receiptRef, readbackDigest, projection.items.length);
  return {
    receipt_ref: receiptRef,
    readback_digest: readbackDigest,
    item_set_digest: projection.item_set_digest,
    item_count: projection.items.length,
    projection_generation: projectionGeneration,
  };
}

export function createD1ProjectionSearchPort(database: D1Database): ProjectionSearchPort {
  return {
    async activate(context, projectionGeneration, projection) {
      const now = new Date().toISOString();
      const existing = await initializeGeneration(
        database,
        context,
        projectionGeneration,
        projection,
        now,
      );
      if (existing !== null) return existing;
      await stageProjection(database, context, projectionGeneration, projection, now);
      const readbackDigest = await verifyShadow(
        database,
        context,
        projectionGeneration,
        projection,
      );
      return activateGeneration(
        database,
        context,
        projectionGeneration,
        projection,
        readbackDigest,
        now,
      );
    },
  };
}
