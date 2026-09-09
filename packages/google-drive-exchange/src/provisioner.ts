import type { ExchangeGeneration } from "@eliotr/contracts";
import type { GoogleDrivePort } from "./port.js";
import type { GoogleExchangeProvisioningPort, GoogleSpreadsheetResource } from "./provisioning-port.js";
import type { ExchangeProvisioningIntentStore, ProvisioningIntent } from "./provisioning-store.js";
import { validateExchangeGeneration } from "./serializer.js";

export interface ExchangeTemplate {
  readonly protocol_version: "eliotr.drive.exchange.v1";
  readonly folder_name: "Eliot Research Exchange";
  readonly spreadsheet_name: "ERC Exchange";
  readonly sheet_ids: Readonly<Record<"SYSTEM" | "CATALOG" | "REQUESTS" | "PAYLOAD_PARTS" | "RECEIPTS" | "RESULTS" | "DASHBOARD", number>>;
}

export interface ExchangeGenerationRepository {
  persistShadow(generation: ExchangeGeneration): Promise<void>;
  activateShadow(generationId: string, expectedActiveGenerationId?: string): Promise<void>;
  retire(generationId: string): Promise<void>;
  readonly initializeCursor?: (connectionId: string, startPageToken: string) => Promise<string>;
}

export interface ExchangeProvisioner {
  provisionShadow(template: ExchangeTemplate): Promise<ExchangeGeneration>;
  runAppendImportReadbackFixture(generation: ExchangeGeneration): Promise<{ passed: boolean; receipt_ref?: string; reason_codes: readonly string[] }>;
  activate(generation: ExchangeGeneration, expectedActiveGenerationId?: string): Promise<void>;
}

export interface ExchangeProvisionerDependencies {
  readonly drive: GoogleDrivePort;
  readonly generations: ExchangeGenerationRepository;
}

export const GOOGLE_EXCHANGE_SHEET_NAMES = Object.freeze(["SYSTEM", "CATALOG", "REQUESTS", "PAYLOAD_PARTS", "RECEIPTS", "RESULTS", "DASHBOARD"] as const);
export interface GoogleExchangeProvisioningInput extends ProvisioningIntent {
  readonly folder_name: "Eliot Research Exchange";
  readonly spreadsheet_name: "ERC Exchange";
  /** Allocated before the REST lease is created, so the lease and durable generation share one identity. */
  readonly generation_id: string;
}
export interface GoogleExchangeProvisionerDependencies {
  readonly drive: GoogleExchangeProvisioningPort;
  readonly generations: ExchangeProvisioningIntentStore & ExchangeGenerationRepository & {
    readonly initializeCursor: (connectionId: string, startPageToken: string) => Promise<string>;
  };
  /** Admission authority for the one bootstrap operation; it must reject revoked or stale AUTHORIZING rows. */
  readonly assertBootstrapCurrent: (input: GoogleExchangeProvisioningInput, signal: AbortSignal) => Promise<void>;
}
export interface GoogleExchangeProvisioner {
  provision(input: GoogleExchangeProvisioningInput, signal?: AbortSignal): Promise<ExchangeGeneration>;
  activate(generationId: string, expectedActiveGenerationId?: string): Promise<void>;
}

function provisioningError(code: string): never { throw new Error(code); }
function safeText(value: unknown, code: string, max = 256): string {
  if (typeof value !== "string" || value.length < 1 || value.length > max || /[\u0000-\u001f\u007f]/u.test(value)) provisioningError(code);
  return value;
}
function iso(value: unknown): string { const result = safeText(value, "GOOGLE_PROVISIONING_TIME_INVALID", 64); if (!Number.isFinite(Date.parse(result))) provisioningError("GOOGLE_PROVISIONING_TIME_INVALID"); return result; }
function resourceSheets(resource: GoogleSpreadsheetResource): Record<"system" | "catalog" | "requests" | "payload_parts" | "receipts" | "results" | "dashboard", number> {
  if (resource.sheets.length !== GOOGLE_EXCHANGE_SHEET_NAMES.length || resource.title !== "ERC Exchange") provisioningError("GOOGLE_PROVISIONING_SCHEMA_INVALID");
  const output: Record<string, number> = {};
  for (const [index, name] of GOOGLE_EXCHANGE_SHEET_NAMES.entries()) {
    const sheet = resource.sheets[index]; if (!sheet || sheet.title !== name || sheet.index !== index || !Number.isSafeInteger(sheet.sheetId) || sheet.sheetId < 0) provisioningError("GOOGLE_PROVISIONING_SCHEMA_INVALID");
    output[name.toLowerCase() === "payload_parts" ? "payload_parts" : name.toLowerCase()] = sheet.sheetId;
  }
  return output as Record<"system" | "catalog" | "requests" | "payload_parts" | "receipts" | "results" | "dashboard", number>;
}

/** Fixed asset provisioning with durable intent/readback. This path is intentionally separate from ordinary polling/publication. */
export function createGoogleExchangeProvisioner(options: GoogleExchangeProvisionerDependencies): GoogleExchangeProvisioner {
  const provision = async (input: GoogleExchangeProvisioningInput, signal: AbortSignal = new AbortController().signal): Promise<ExchangeGeneration> => {
    const requestedGenerationId = safeText(input.generation_id, "GOOGLE_PROVISIONING_INPUT_INVALID");
    const intent: ProvisioningIntent = { principal_id: safeText(input.principal_id, "GOOGLE_PROVISIONING_INPUT_INVALID"), operation_ref: safeText(input.operation_ref, "GOOGLE_PROVISIONING_INPUT_INVALID"),
      connection_id: safeText(input.connection_id, "GOOGLE_PROVISIONING_INPUT_INVALID"), expected_credential_generation: safeText(input.expected_credential_generation, "GOOGLE_PROVISIONING_INPUT_INVALID"),
      expected_credential_revision: input.expected_credential_revision, created_at: iso(input.created_at), generation_id: requestedGenerationId };
    if (input.folder_name !== "Eliot Research Exchange" || input.spreadsheet_name !== "ERC Exchange") provisioningError("GOOGLE_PROVISIONING_TEMPLATE_INVALID");
    signal.throwIfAborted(); await options.assertBootstrapCurrent(input, signal); signal.throwIfAborted();
    const record = await options.generations.begin(intent);
    if (record.failure_code) provisioningError("GOOGLE_PROVISIONING_CREATE_OUTCOME_UNKNOWN");
    if (record.state === "ACTIVATED" && record.generation_id) {
      const active = await options.generations.read({ principal_id: intent.principal_id, operation_ref: intent.operation_ref });
      if (!active?.generation_id) provisioningError("GOOGLE_PROVISIONING_RECORD_INVALID");
      return generationFromRecord(active);
    }
    if (record.state === "FAILED") provisioningError("GOOGLE_PROVISIONING_INTENT_FAILED");
    if (record.state === "QUALIFIED" && record.generation_id) return generationFromRecord(record);
    const generationId = record.generation_id ?? requestedGenerationId;
    let folder;
    if (record.folder_id) folder = await options.drive.readFileMetadata(record.folder_id, "application/vnd.google-apps.folder");
    else {
      const matches = await options.drive.findExactFile(input.folder_name, "application/vnd.google-apps.folder", "root");
      if (matches.length > 1) provisioningError("GOOGLE_PROVISIONING_DUPLICATE_FOLDER");
      if (matches[0]) folder = matches[0];
      else { await options.generations.markCreateAttempt(intent); folder = await options.drive.createFolder(input.folder_name); }
    }
    if (folder.name !== input.folder_name || folder.mimeType !== "application/vnd.google-apps.folder" || folder.parents.length !== 1) provisioningError("GOOGLE_PROVISIONING_FOLDER_INVALID");
    signal.throwIfAborted(); await options.assertBootstrapCurrent(input, signal);
    let spreadsheet: GoogleSpreadsheetResource;
    let spreadsheetId = record.spreadsheet_id;
    if (spreadsheetId) spreadsheet = await options.drive.readSpreadsheet(spreadsheetId);
    else {
      const matches = await options.drive.findExactFile(input.spreadsheet_name, "application/vnd.google-apps.spreadsheet", folder.fileId);
      if (matches.length > 1) provisioningError("GOOGLE_PROVISIONING_DUPLICATE_SPREADSHEET");
      if (matches.length === 1) { const match = matches[0]; if (!match) provisioningError("GOOGLE_PROVISIONING_MATCH_INVALID"); const discoveredId = match.fileId; spreadsheetId = discoveredId; spreadsheet = await options.drive.readSpreadsheet(discoveredId); }
      else { await options.generations.markCreateAttempt(intent); spreadsheet = await options.drive.createSpreadsheet(input.spreadsheet_name, GOOGLE_EXCHANGE_SHEET_NAMES); spreadsheetId = spreadsheet.spreadsheetId; }
    }
    const finalSpreadsheetId = spreadsheetId; if (!finalSpreadsheetId || finalSpreadsheetId !== spreadsheet.spreadsheetId) provisioningError("GOOGLE_PROVISIONING_SPREADSHEET_INVALID");
    resourceSheets(spreadsheet);
    const metadata = await options.drive.attachToFolder(finalSpreadsheetId, folder.fileId);
    if (metadata.fileId !== finalSpreadsheetId || metadata.parents.length !== 1 || metadata.parents[0] !== folder.fileId || metadata.name !== input.spreadsheet_name) provisioningError("GOOGLE_PROVISIONING_PARENT_INVALID");
    const verified = await options.drive.readFileMetadata(finalSpreadsheetId, "application/vnd.google-apps.spreadsheet");
    if (verified.parents.length !== 1 || verified.parents[0] !== folder.fileId || verified.name !== input.spreadsheet_name) provisioningError("GOOGLE_PROVISIONING_PARENT_INVALID");
    await options.generations.recordAssets({ intent, generation_id: generationId, folder_id: folder.fileId, spreadsheet_id: finalSpreadsheetId, sheet_ids_json: JSON.stringify(resourceSheets(spreadsheet)) });
    signal.throwIfAborted(); await options.assertBootstrapCurrent(input, signal);
    const cursor = await options.drive.getStartPageToken(); safeText(cursor, "GOOGLE_PROVISIONING_CURSOR_INVALID", 1024);
    const generation: ExchangeGeneration = { generation_id: generationId, connection_id: intent.connection_id, folder_id: folder.fileId,
      spreadsheet_id: finalSpreadsheetId, sheet_ids: resourceSheets(spreadsheet), protocol_version: "eliotr.drive.exchange.v1", status: "draining", created_at: iso(input.created_at) };
    const durableCursor = await options.generations.initializeCursor(intent.connection_id, cursor);
    safeText(durableCursor, "GOOGLE_PROVISIONING_CURSOR_INVALID", 1024);
    await options.generations.persistShadow(generation);
    signal.throwIfAborted(); await options.assertBootstrapCurrent(input, signal);
    const qualified = await options.generations.qualify({ intent, generation_id: generation.generation_id, start_page_token: durableCursor });
    if (qualified.state !== "QUALIFIED") provisioningError("GOOGLE_PROVISIONING_QUALIFY_INVALID");
    return generation;
  };
  return { provision, activate: (generationId, expectedActiveGenerationId) => options.generations.activateShadow(generationId, expectedActiveGenerationId) };
}

function generationFromRecord(record: { readonly generation_id?: string; readonly connection_id: string; readonly folder_id?: string; readonly spreadsheet_id?: string; readonly sheet_ids_json?: string; readonly created_at: string }): ExchangeGeneration {
  if (!record.generation_id || !record.folder_id || !record.spreadsheet_id || !record.sheet_ids_json) provisioningError("GOOGLE_PROVISIONING_RECORD_INVALID");
  let sheets: unknown; try { sheets = JSON.parse(record.sheet_ids_json); } catch { provisioningError("GOOGLE_PROVISIONING_RECORD_INVALID"); }
  try {
    return validateExchangeGeneration({ generation_id: record.generation_id, connection_id: record.connection_id, folder_id: record.folder_id, spreadsheet_id: record.spreadsheet_id,
      sheet_ids: sheets as ExchangeGeneration["sheet_ids"], protocol_version: "eliotr.drive.exchange.v1", status: "draining", created_at: iso(record.created_at) });
  } catch { provisioningError("GOOGLE_PROVISIONING_RECORD_INVALID"); }
}
