import type { DrivePayloadPart, DriveRequestRow, ExchangeGeneration } from "@eliotr/contracts";

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
  generation: ExchangeGeneration,
  request: DriveRequestRow,
  parts: readonly DrivePayloadPart[],
): readonly SheetsAppendCellsRequest[] {
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
