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

const encoder = new TextEncoder();

function validText(value: unknown): value is string {
  return typeof value === "string" && value.length <= DRIVE_CONTRIBUTION_LIMITS.max_cell_characters
    && value.isWellFormed();
}

function boundedRecord(value: unknown, maxKeys: number, label: string): void {
  if (value === null || typeof value !== "object" || Array.isArray(value)
      || Object.keys(value).length > maxKeys) throw new Error(label);
  // Reject before schema cloning or UTF-8 allocation, including malformed surrogate pairs.
  for (const item of Object.values(value)) {
    if (typeof item === "string" && !validText(item)) throw new Error("DRIVE_CELL_INVALID");
  }
}

function requestValue(value: unknown): DriveRequestRow {
  boundedRecord(value, 16, "DRIVE_REQUEST_INVALID");
  const parsed = DriveRequestRowSchema.safeParse(value);
  if (!parsed.success) throw new Error("DRIVE_REQUEST_INVALID");
  const request = parsed.data;
  if (request.body_encoding === "inline_json") {
    if (request.part_count !== 0 || request.payload_id !== undefined) throw new Error("DRIVE_ENCODING_CONFLICT");
  } else if (request.part_count < 1 || !request.payload_id || request.inline_body !== "") {
    throw new Error("DRIVE_ENCODING_CONFLICT");
  }
  return request;
}

function partValue(value: unknown): DrivePayloadPart {
  boundedRecord(value, 5, "DRIVE_PART_INVALID");
  const parsed = DrivePayloadPartSchema.safeParse(value);
  if (!parsed.success || parsed.data.part_index >= parsed.data.part_count) throw new Error("DRIVE_PART_INVALID");
  return parsed.data;
}

function requireCells(cells: readonly unknown[], count: number, numeric: readonly number[]): void {
  if (!Array.isArray(cells) || cells.length !== count) throw new Error("DRIVE_ROW_WIDTH_INVALID");
  for (let index = 0; index < count; index += 1) {
    const cell = cells[index];
    if (numeric.includes(index) ? typeof cell !== "number" || !Number.isSafeInteger(cell) : !validText(cell)) {
      throw new Error("DRIVE_CELL_INVALID");
    }
  }
}

export function parseRequestCells(cells: readonly unknown[]): DriveRequestRow {
  requireCells(cells, 16, [11]);
  return requestValue({
    protocol: cells[0], request_id: cells[1], idempotency_key: cells[2], actor_claim: cells[3],
    project_id: cells[4], operation: cells[5], intelligence: cells[6], scope_expression_json: cells[7],
    body_encoding: cells[8], inline_body: cells[9],
    ...(cells[10] === "" ? {} : { payload_id: cells[10] }), part_count: cells[11], requested_budget_json: cells[12],
    ...(cells[13] === "" ? {} : { base_revision: cells[13] }), evidence_handles_json: cells[14], created_at: cells[15],
  });
}

export function parsePayloadPartCells(cells: readonly unknown[]): DrivePayloadPart {
  requireCells(cells, 5, [1, 2]);
  return partValue({ payload_id: cells[0], part_index: cells[1], part_count: cells[2], utf8_text: cells[3], created_at: cells[4] });
}

export function assembleContribution(rawRequest: DriveRequestRow, rawParts: readonly DrivePayloadPart[]): ParsedContribution {
  const request = requestValue(rawRequest);
  if (!Array.isArray(rawParts) || rawParts.length > DRIVE_CONTRIBUTION_LIMITS.max_parts) throw new Error("DRIVE_PART_SET_INVALID");
  if (rawParts.length !== request.part_count) throw new Error("INCOMPLETE_PAYLOAD_PARTS");
  const parts: DrivePayloadPart[] = [];
  for (let index = 0; index < rawParts.length; index += 1) parts.push(partValue(rawParts[index]));
  const ordered = parts.sort((left, right) => left.part_index - right.part_index);
  if (ordered.some((part, index) => part.part_index !== index || part.part_count !== request.part_count || part.payload_id !== request.payload_id)) {
    throw new Error("INVALID_PAYLOAD_PART_SEQUENCE");
  }
  // Count all transported cell values, not only body text. JSON escaping is a separate HTTP budget.
  let contributionBytes = 0;
  for (const record of [request, ...ordered]) {
    for (const value of Object.values(record)) {
      if (value !== undefined) contributionBytes += encoder.encode(String(value)).byteLength;
      if (contributionBytes > DRIVE_CONTRIBUTION_LIMITS.hard_bytes) throw new Error("CONTRIBUTION_TOO_LARGE");
    }
  }
  const body = request.body_encoding === "inline_json" ? request.inline_body : ordered.map((part) => part.utf8_text).join("");
  return { request, parts: ordered, body, utf8_bytes: encoder.encode(body).byteLength };
}

export interface ContributionFreezer {
  freeze(parsed: ParsedContribution, driveModifiedTime: string): Promise<FrozenDriveContribution>;
}
