import type { DrivePayloadPart, DriveRequestRow, ExchangeGeneration } from "@eliotr/contracts";

export function exchangeFixture(): ExchangeGeneration {
  return { generation_id: "exchange-1", connection_id: "connection-1", folder_id: "folder_1",
    spreadsheet_id: "spreadsheet_1", sheet_ids: { system: 1000, catalog: 1003, requests: 1001,
      payload_parts: 1002, receipts: 1004, results: 1005, dashboard: 1006 },
    protocol_version: "eliotr.drive.exchange.v1", status: "active", created_at: "2026-09-05T12:00:00Z" };
}
export function contributionFixture(): DriveRequestRow {
  return { protocol: "eliotr.drive.exchange.v1", request_id: "request-1", idempotency_key: "intent-1",
    actor_claim: "chatgpt-web", project_id: "project-1", operation: "audit", intelligence: "strong",
    scope_expression_json: '{"kind":"GLOBAL"}', body_encoding: "inline_json", inline_body: '{"question":"test"}',
    part_count: 0, requested_budget_json: '{"max_usd":0.25}', evidence_handles_json: "[]", created_at: "2026-09-05T12:00:00Z" };
}
export function payloadFixture(): DrivePayloadPart {
  return { payload_id: "payload-1", part_index: 0, part_count: 1, utf8_text: "Original текст 日本語 🙂",
    created_at: "2026-09-05T12:00:00Z" };
}
