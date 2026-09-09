import { describe, expect, it, vi } from "vitest";
import { createGoogleExchangeProvisioner, GOOGLE_EXCHANGE_SHEET_NAMES, type ExchangeGenerationRepository, type GoogleExchangeProvisionerDependencies } from "./provisioner.js";
import { createGoogleExchangeProvisioningPort } from "./provisioning-port.js";
import type { GoogleAccessLease } from "./rest-transport.js";
import type { DriveFileMetadata } from "./port.js";
import type { GoogleExchangeProvisioningPort, GoogleSpreadsheetResource } from "./provisioning-port.js";
import type { ExchangeProvisioningIntentStore, ProvisioningIntent, ProvisioningRecord } from "./provisioning-store.js";

const folder: DriveFileMetadata = { fileId: "folder-1", name: "Eliot Research Exchange", mimeType: "application/vnd.google-apps.folder", parents: [], webViewUrl: "https://drive.google.com/drive/folders/folder-1", modifiedTime: "2026-09-09T00:00:00Z" };
const sheet: GoogleSpreadsheetResource = { spreadsheetId: "sheet-1", title: "ERC Exchange", sheets: GOOGLE_EXCHANGE_SHEET_NAMES.map((title, index) => ({ sheetId: index + 1, title, index })) };
const metadata: DriveFileMetadata = { fileId: sheet.spreadsheetId, name: sheet.title, mimeType: "application/vnd.google-apps.spreadsheet", parents: [folder.fileId], webViewUrl: "https://docs.google.com/spreadsheets/d/sheet-1/edit", modifiedTime: "2026-09-09T00:00:00Z" };
function setup() {
  const state: { folder?: DriveFileMetadata; sheet?: GoogleSpreadsheetResource; intent?: ProvisioningRecord; cursor?: string; generation?: Parameters<ExchangeGenerationRepository["persistShadow"]>[0] } = {};
  const drive: GoogleExchangeProvisioningPort = {
    findExactFile: vi.fn(async (name, mime, parent) => name === folder.name ? (state.folder ? [state.folder] : []) : state.sheet && parent === folder.fileId ? [metadata] : []),
    createFolder: vi.fn(async () => state.folder = folder),
    createSpreadsheet: vi.fn(async () => state.sheet = sheet),
    attachToFolder: vi.fn(async () => metadata),
    readFileMetadata: vi.fn(async (id) => id === folder.fileId ? folder : metadata),
    readSpreadsheet: vi.fn(async () => state.sheet ?? sheet),
    getStartPageToken: vi.fn(async () => "start-1"),
  };
  const generations: ExchangeProvisioningIntentStore & ExchangeGenerationRepository & { initializeCursor: (connectionId: string, token: string) => Promise<void> } = {
    begin: vi.fn(async (input: ProvisioningIntent) => state.intent ??= { ...input, state: "PENDING" }),
    recordAssets: vi.fn(async (input) => { const current = state.intent; if (!current) throw new Error("missing intent"); state.intent = { ...current, generation_id: input.generation_id, folder_id: input.folder_id, spreadsheet_id: input.spreadsheet_id, sheet_ids_json: input.sheet_ids_json }; return state.intent; }),
    qualify: vi.fn(async (input) => { const current = state.intent; if (!current) throw new Error("missing intent"); state.intent = { ...current, state: "QUALIFIED", generation_id: input.generation_id, start_page_token: input.start_page_token }; return state.intent; }),
    read: vi.fn(async (input) => { const current = state.intent; return current !== undefined && current.principal_id === input.principal_id && current.operation_ref === input.operation_ref ? current : null; }),
    initializeCursor: vi.fn(async (_id: string, token: string) => { state.cursor = token; }),
    persistShadow: vi.fn(async (generation) => { state.generation = generation; }),
    activateShadow: vi.fn(async () => { if (state.generation) state.generation = { ...state.generation, status: "active" }; }),
    retire: vi.fn(async () => {}),
  };
  const dependencies: GoogleExchangeProvisionerDependencies = { drive, generations, assertBootstrapCurrent: vi.fn(async () => {}) };
  return { state, drive, generations, service: createGoogleExchangeProvisioner(dependencies) };
}
const input = { principal_id: "owner-1", operation_ref: "provision-1", connection_id: "connection-1", expected_credential_generation: "grant-1", expected_credential_revision: 1,
  created_at: "2026-09-09T00:00:00Z", generation_id: "generation-1", folder_name: "Eliot Research Exchange" as const, spreadsheet_name: "ERC Exchange" as const };

describe("fixed Google exchange provisioning boundary", () => {
  it("reconciles a completed intent without creating a second resource", async () => {
    const test = setup(); const generation = await test.service.provision(input); expect(generation.status).toBe("draining");
    expect(test.state.cursor).toBe("start-1"); expect(test.drive.createFolder).toHaveBeenCalledOnce(); expect(test.drive.createSpreadsheet).toHaveBeenCalledOnce();
    const retry = await test.service.provision(input); expect(retry.generation_id).toBe(generation.generation_id);
    expect(test.drive.createFolder).toHaveBeenCalledOnce(); expect(test.drive.createSpreadsheet).toHaveBeenCalledOnce();
  });
  it("rejects ambiguous fixed-name assets before schema qualification", async () => {
    const test = setup(); test.drive.findExactFile = vi.fn(async () => [folder, { ...folder, fileId: "folder-2" }]);
    await expect(test.service.provision(input)).rejects.toThrow("GOOGLE_PROVISIONING_DUPLICATE_FOLDER");
    expect(test.drive.createSpreadsheet).not.toHaveBeenCalled(); expect(test.generations.recordAssets).not.toHaveBeenCalled();
  });
  it("refuses schema drift and never persists a generation", async () => {
    const test = setup(); test.drive.createSpreadsheet = vi.fn(async () => ({ ...sheet, sheets: sheet.sheets.map((item, index) => index === 2 ? { ...item, title: "FOREIGN" } : item) }));
    await expect(test.service.provision(input)).rejects.toThrow("GOOGLE_PROVISIONING_SCHEMA_INVALID");
    expect(test.generations.recordAssets).not.toHaveBeenCalled(); expect(test.generations.persistShadow).not.toHaveBeenCalled();
  });
  it("uses only fixed creation, parent attachment and exact metadata endpoints", async () => {
    const calls: Array<{ url: string; method: string; body?: unknown }> = [];
    const lease: GoogleAccessLease = { connection_id: "connection-1", exchange_generation_id: "generation-1", access_token: "access-token", expires_at_epoch_ms: Date.now() + 60000, assertCurrent: async () => {} };
    const fetchImpl: typeof fetch = async (url, init) => {
      const parsed = String(url); calls.push({ url: parsed, method: String(init?.method), body: init?.body === undefined ? undefined : JSON.parse(String(init.body)) });
      const apiFolder = { id: folder.fileId, name: folder.name, mimeType: folder.mimeType, parents: folder.parents, webViewLink: folder.webViewUrl, modifiedTime: folder.modifiedTime, trashed: false, ownedByMe: true };
      const apiSheet = { id: metadata.fileId, name: metadata.name, mimeType: metadata.mimeType, parents: metadata.parents, webViewLink: metadata.webViewUrl, modifiedTime: metadata.modifiedTime, trashed: false, ownedByMe: true };
      if (parsed.includes("/drive/v3/files?") && init?.method === "POST") return Response.json(apiFolder);
      const apiSpreadsheet = { spreadsheetId: sheet.spreadsheetId, properties: { title: sheet.title }, sheets: sheet.sheets.map((item) => ({ properties: item })) };
      if (parsed.includes("/v4/spreadsheets?") && init?.method === "POST") return Response.json(apiSpreadsheet);
      if (parsed.includes("/drive/v3/files/sheet-1?") && init?.method === "PATCH") return Response.json(apiSheet);
      if (parsed.includes("/drive/v3/files/sheet-1?") && init?.method === "GET") return Response.json(apiSheet);
      if (parsed.includes("/v4/spreadsheets/sheet-1?") && init?.method === "GET") return Response.json(apiSpreadsheet);
      throw new Error("unexpected controlled endpoint");
    };
    const port = createGoogleExchangeProvisioningPort({ connectionId: "connection-1", generationId: "generation-1", operationRef: "operation-1", deadlineEpochMs: Date.now() + 60000, maxRequests: 8, authorize: async () => lease, fetchImpl });
    expect((await port.createFolder(folder.name)).fileId).toBe(folder.fileId);
    expect((await port.createSpreadsheet(sheet.title, GOOGLE_EXCHANGE_SHEET_NAMES)).spreadsheetId).toBe(sheet.spreadsheetId);
    expect((await port.attachToFolder(sheet.spreadsheetId, folder.fileId)).parents).toEqual([folder.fileId]);
    expect((await port.readFileMetadata(sheet.spreadsheetId, "application/vnd.google-apps.spreadsheet")).fileId).toBe(sheet.spreadsheetId);
    expect((await port.readSpreadsheet(sheet.spreadsheetId)).sheets).toHaveLength(7);
    expect(calls.map((call) => `${call.method} ${new URL(call.url).pathname}`)).toEqual([
      "POST /drive/v3/files", "POST /v4/spreadsheets", "PATCH /drive/v3/files/sheet-1", "GET /drive/v3/files/sheet-1", "GET /v4/spreadsheets/sheet-1",
    ]);
  });
});
