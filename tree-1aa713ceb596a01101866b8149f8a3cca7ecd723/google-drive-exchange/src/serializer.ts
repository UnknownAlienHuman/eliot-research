import { ExchangeGenerationSchema, type DrivePayloadPart, type DriveRequestRow, type ExchangeGeneration } from "@eliotr/contracts";
import { assembleContribution } from "./contribution.js";

export function validateExchangeGeneration(input: ExchangeGeneration): ExchangeGeneration {
  const parsed = ExchangeGenerationSchema.safeParse(input);
  if (!parsed.success) throw new Error("EXCHANGE_GENERATION_INVALID");
  const ids = Object.values(parsed.data.sheet_ids);
  if (new Set(ids).size !== ids.length || ids.some((id) => !Number.isSafeInteger(id) || id > 2147483647)) {
    throw new Error("EXCHANGE_SHEET_ID_INVALID");
  }
  return parsed.data;
}

export interface SheetsAppendCellsRequest {
  readonly appendCells: {
    readonly sheetId: number;
    readonly rows: readonly { readonly values: readonly { readonly userEnteredValue: { readonly stringValue?: string; readonly numberValue?: number } }[] }[];
    readonly fields: "userEnteredValue";
  };
}

function stringCell(value: string): { userEnteredValue: { stringValue: string } } {
  return { userEnteredValue: { stringValue: value } };
}
function numberCell(value: number): { userEnteredValue: { numberValue: number } } {
  return { userEnteredValue: { numberValue: value } };
}

export function serializeAtomicContribution(
  rawGeneration: ExchangeGeneration,
  rawRequest: DriveRequestRow,
  rawParts: readonly DrivePayloadPart[],
): readonly SheetsAppendCellsRequest[] {
  const generation = validateExchangeGeneration(rawGeneration);
  if (generation.status !== "active") throw new Error("EXCHANGE_GENERATION_NOT_ACTIVE");
  const { request, parts } = assembleContribution(rawRequest, rawParts);
  const requestValues = [
    stringCell(request.protocol), stringCell(request.request_id), stringCell(request.idempotency_key),
    stringCell(request.actor_claim), stringCell(request.project_id), stringCell(request.operation),
    stringCell(request.intelligence), stringCell(request.scope_expression_json), stringCell(request.body_encoding),
    stringCell(request.inline_body), stringCell(request.payload_id ?? ""), numberCell(request.part_count),
    stringCell(request.requested_budget_json), stringCell(request.base_revision ?? ""),
    stringCell(request.evidence_handles_json), stringCell(request.created_at),
  ];
  const updates: SheetsAppendCellsRequest[] = [{
    appendCells: { sheetId: generation.sheet_ids.requests, rows: [{ values: requestValues }], fields: "userEnteredValue" },
  }];
  for (const part of parts) {
    updates.push({
      appendCells: {
        sheetId: generation.sheet_ids.payload_parts,
        rows: [{ values: [
          stringCell(part.payload_id), numberCell(part.part_index), numberCell(part.part_count),
          stringCell(part.utf8_text), stringCell(part.created_at),
        ] }],
        fields: "userEnteredValue",
      },
    });
  }
  return updates;
}
