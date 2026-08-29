import type { DrivePayloadPart, DriveRequestRow, FrozenDriveContribution } from "@eliotr/contracts";
import { DrivePayloadPartSchema, DriveRequestRowSchema } from "@eliotr/contracts";

export const DRIVE_CONTRIBUTION_LIMITS = {
  target_bytes: 64 * 1024,
  hard_bytes: 128 * 1024,
  max_parts: 5,
  max_cell_characters: 30_000,
} as const;

export interface ParsedContribution {
  readonly request: DriveRequestRow;
  readonly parts: readonly DrivePayloadPart[];
  readonly body: string;
  readonly utf8_bytes: number;
}

export function parseRequestCells(cells: readonly unknown[]): DriveRequestRow {
  if (cells.length !== 16) throw new Error(`REQUESTS row must contain exactly 16 cells, got ${cells.length}`);
  return DriveRequestRowSchema.parse({
    protocol: String(cells[0] ?? ""), request_id: String(cells[1] ?? ""), idempotency_key: String(cells[2] ?? ""),
    actor_claim: String(cells[3] ?? ""), project_id: String(cells[4] ?? ""), operation: String(cells[5] ?? ""),
    intelligence: String(cells[6] ?? ""), scope_expression_json: String(cells[7] ?? ""), body_encoding: String(cells[8] ?? ""),
    inline_body: String(cells[9] ?? ""), payload_id: String(cells[10] ?? "") || undefined,
    part_count: Number(cells[11] ?? 0), requested_budget_json: String(cells[12] ?? ""),
    base_revision: String(cells[13] ?? "") || undefined, evidence_handles_json: String(cells[14] ?? ""),
    created_at: String(cells[15] ?? ""),
  });
}

export function parsePayloadPartCells(cells: readonly unknown[]): DrivePayloadPart {
  if (cells.length !== 5) throw new Error(`PAYLOAD_PARTS row must contain exactly 5 cells, got ${cells.length}`);
  return DrivePayloadPartSchema.parse({
    payload_id: String(cells[0] ?? ""), part_index: Number(cells[1]), part_count: Number(cells[2]),
    utf8_text: String(cells[3] ?? ""), created_at: String(cells[4] ?? ""),
  });
}

export function assembleContribution(request: DriveRequestRow, parts: readonly DrivePayloadPart[]): ParsedContribution {
  if (parts.length !== request.part_count) throw new Error("INCOMPLETE_PAYLOAD_PARTS");
  const ordered = [...parts].sort((left, right) => left.part_index - right.part_index);
  if (ordered.some((part, index) => part.part_index !== index || part.part_count !== request.part_count || part.payload_id !== request.payload_id)) {
    throw new Error("INVALID_PAYLOAD_PART_SEQUENCE");
  }
  const body = request.body_encoding === "inline_json" ? request.inline_body : ordered.map((part) => part.utf8_text).join("");
  const utf8_bytes = new TextEncoder().encode(body).byteLength;
  if (utf8_bytes > DRIVE_CONTRIBUTION_LIMITS.hard_bytes) throw new Error("CONTRIBUTION_TOO_LARGE");
  return { request, parts: ordered, body, utf8_bytes };
}

export interface ContributionFreezer {
  freeze(parsed: ParsedContribution, driveModifiedTime: string): Promise<FrozenDriveContribution>;
}
