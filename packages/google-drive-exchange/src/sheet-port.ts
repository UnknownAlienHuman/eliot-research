import type { ExchangeGeneration } from "@eliotr/contracts";
import type { DriveChange, DriveChangePage, GoogleDrivePort } from "./port.js";
import { validateExchangeGeneration } from "./serializer.js";
import { boundedString, createGoogleJsonTransport, googleFileId, googleTimestamp, object, type GoogleRestOptions } from "./rest-transport.js";
import { decodeSheetRanges, exchangeRanges } from "./sheet-ranges.js";

/** Implemented Sheet/changes subset. OAuth admission, Doc delivery and export are separate checkpoints. */
export type GoogleExchangeSheetPort = Pick<GoogleDrivePort,
  "getStartPageToken" | "listChanges" | "readSheetRanges" | "batchUpdateSheet" | "getFileMetadata">;
export interface GoogleExchangeSheetOptions extends GoogleRestOptions {
  readonly generation: ExchangeGeneration;
}
const SHEET = "application/vnd.google-apps.spreadsheet";
const FOLDER = "application/vnd.google-apps.folder";
function endpoint(path: string, fields: string): URL {
  const url = new URL(path); url.searchParams.set("fields", fields); return url;
}

function ercAppendRequests(input: readonly unknown[], generation: ExchangeGeneration): unknown[] {
  if (!Array.isArray(input) || input.length < 1 || input.length > 16) throw new Error("GOOGLE_APPEND_INVALID");
  const writable = new Set([generation.sheet_ids.system, generation.sheet_ids.catalog, generation.sheet_ids.receipts, generation.sheet_ids.results]);
  let cells = 0; let rows = 0; let bytes = 0;
  return Array.from(input, (request) => {
    const item = object(request, ["appendCells"]);
    const append = object(item.appendCells, ["sheetId", "rows", "fields"]);
    if (typeof append.sheetId !== "number" || !writable.has(append.sheetId) || append.fields !== "userEnteredValue"
        || !Array.isArray(append.rows) || append.rows.length < 1 || (rows += append.rows.length) > 128) throw new Error("GOOGLE_APPEND_INVALID");
    const outputRows = Array.from(append.rows, (row) => {
      const data = object(row, ["values"]);
      if (!Array.isArray(data.values) || data.values.length < 1 || data.values.length > 64 || (cells += data.values.length) > 4096) {
        throw new Error("GOOGLE_APPEND_INVALID");
      }
      return { values: Array.from(data.values, (cell) => {
        const raw = object(cell, ["userEnteredValue"]);
        const value = object(raw.userEnteredValue, [], ["stringValue", "numberValue"]);
        if (Object.keys(value).length !== 1) throw new Error("GOOGLE_APPEND_INVALID");
        if (typeof value.stringValue === "string" && value.stringValue.length <= 30000 && value.stringValue.isWellFormed()) {
          bytes += new TextEncoder().encode(value.stringValue).byteLength;
          if (bytes > 128 * 1024) throw new Error("GOOGLE_APPEND_LIMIT");
          return { userEnteredValue: { stringValue: value.stringValue } };
        }
        if (typeof value.numberValue === "number" && Number.isFinite(value.numberValue) && Math.abs(value.numberValue) <= Number.MAX_SAFE_INTEGER) {
          bytes += String(value.numberValue).length;
          if (bytes > 128 * 1024) throw new Error("GOOGLE_APPEND_LIMIT");
          return { userEnteredValue: { numberValue: value.numberValue } };
        }
        throw new Error("GOOGLE_APPEND_INVALID");
      }) };
    });
    return { appendCells: { sheetId: append.sheetId, rows: outputRows, fields: "userEnteredValue" } };
  });
}

// IMPLEMENTED_NOT_LIVE: ER-20 bounded Exchange Sheet/changes REST subset; OAuth, Doc publication and durable cursor composition remain unfinished.
export function createGoogleExchangeSheetPort(options: GoogleExchangeSheetOptions): GoogleExchangeSheetPort {
  const generation = validateExchangeGeneration(options.generation);
  googleFileId(generation.spreadsheet_id); googleFileId(generation.folder_id);
  if (generation.spreadsheet_id === generation.folder_id || generation.status === "retired"
      || generation.connection_id !== options.connectionId || generation.generation_id !== options.generationId) {
    throw new Error("EXCHANGE_GENERATION_INVALID");
  }
  const json = createGoogleJsonTransport(options);
  const now = options.now ?? Date.now;
  const sheetUrl = `https://sheets.googleapis.com/v4/spreadsheets/${generation.spreadsheet_id}`;
  const requireSpreadsheet = (id: string) => { if (id !== generation.spreadsheet_id) throw new Error("GOOGLE_SPREADSHEET_MISMATCH"); };
  return {
    getStartPageToken() {
      return json(endpoint("https://www.googleapis.com/drive/v3/changes/startPageToken", "startPageToken"), undefined, false,
        (value) => boundedString(object(value, ["startPageToken"]).startPageToken));
    },
    listChanges(pageToken) {
      boundedString(pageToken);
      const url = endpoint("https://www.googleapis.com/drive/v3/changes", "nextPageToken,newStartPageToken,changes(fileId,removed,file(id,mimeType,modifiedTime))");
      url.searchParams.set("pageToken", pageToken); url.searchParams.set("pageSize", "100");
      url.searchParams.set("spaces", "drive"); url.searchParams.set("includeRemoved", "true");
      url.searchParams.set("includeItemsFromAllDrives", "false"); url.searchParams.set("restrictToMyDrive", "true");
      return json(url, undefined, false, (value): DriveChangePage => {
        const result = object(value, [], ["changes", "nextPageToken", "newStartPageToken"]);
        const next = result.nextPageToken === undefined ? undefined : boundedString(result.nextPageToken);
        const start = result.newStartPageToken === undefined ? undefined : boundedString(result.newStartPageToken);
        if ((next === undefined) === (start === undefined) || next === pageToken) throw new Error("GOOGLE_CURSOR_INVALID");
        const raw = result.changes === undefined ? [] : result.changes;
        if (!Array.isArray(raw) || raw.length > 100) throw new Error("GOOGLE_CHANGE_LIMIT");
        const changes: DriveChange[] = [];
        for (const entry of raw) {
          const change = object(entry, ["fileId"], ["removed", "file"]);
          const id = googleFileId(change.fileId);
          // Google JSON omits default false scalars; absence is not a positive removal claim.
          if (change.removed !== undefined && typeof change.removed !== "boolean") throw new Error("GOOGLE_CHANGE_INVALID");
          if (id !== generation.spreadsheet_id && id !== generation.folder_id) continue;
          const removed = change.removed === true;
          if (removed) { changes.push({ fileId: id, removed }); continue; }
          const file = object(change.file, ["id", "mimeType", "modifiedTime"]);
          if (file.id !== id || file.mimeType !== (id === generation.spreadsheet_id ? SHEET : FOLDER)) throw new Error("GOOGLE_CHANGE_INVALID");
          changes.push({ fileId: id, removed, modifiedTime: googleTimestamp(file.modifiedTime) });
        }
        if (next !== undefined) return { changes, nextPageToken: next };
        if (start === undefined) throw new Error("GOOGLE_CURSOR_INVALID");
        return { changes, newStartPageToken: start };
      });
    },
    readSheetRanges(spreadsheetId, requested) {
      requireSpreadsheet(spreadsheetId);
      const ranges = exchangeRanges(requested, generation);
      return json(endpoint(`${sheetUrl}/values:batchGetByDataFilter`, "spreadsheetId,valueRanges(dataFilters,valueRange)"),
        { dataFilters: ranges.map(({ grid }) => ({ gridRange: grid })), majorDimension: "ROWS",
          valueRenderOption: "UNFORMATTED_VALUE", dateTimeRenderOption: "SERIAL_NUMBER" }, false,
        (value) => decodeSheetRanges(value, ranges, generation));
    },
    batchUpdateSheet(spreadsheetId, requests) {
      requireSpreadsheet(spreadsheetId);
      if (generation.status !== "active") throw new Error("EXCHANGE_GENERATION_NOT_ACTIVE");
      const batch = ercAppendRequests(requests, generation);
      return json(endpoint(`${sheetUrl}:batchUpdate`, "spreadsheetId,replies"),
        { requests: batch, includeSpreadsheetInResponse: false }, true, (value) => {
          const response = object(value, ["spreadsheetId", "replies"]);
          if (response.spreadsheetId !== spreadsheetId || !Array.isArray(response.replies) || response.replies.length !== batch.length) {
            throw new Error("GOOGLE_APPEND_RESPONSE_INVALID");
          }
          // appendCells replies carry no readback. This receipt is transport-only, not exact-once admission.
          const replies = Array.from(response.replies, (reply) => object(reply, []));
          return { spreadsheetId, replies, writtenAt: new Date(now()).toISOString() };
        });
    },
    getFileMetadata(fileId) {
      if (fileId !== generation.spreadsheet_id && fileId !== generation.folder_id) throw new Error("GOOGLE_RESOURCE_MISMATCH");
      const fields = "id,name,mimeType,parents,webViewLink,modifiedTime,trashed,ownedByMe";
      return json(endpoint(`https://www.googleapis.com/drive/v3/files/${fileId}`, fields), undefined, false, (value) => {
        const file = object(value, ["id", "name", "mimeType", "webViewLink", "modifiedTime", "trashed", "ownedByMe"], ["parents"]);
        if (file.id !== fileId || file.mimeType !== (fileId === generation.spreadsheet_id ? SHEET : FOLDER)
            || file.trashed !== false || file.ownedByMe !== true) throw new Error("GOOGLE_METADATA_MISMATCH");
        const parents = file.parents === undefined ? [] : file.parents;
        if (!Array.isArray(parents) || parents.length > 1 || (fileId === generation.spreadsheet_id && parents[0] !== generation.folder_id)) {
          throw new Error("GOOGLE_METADATA_MISMATCH");
        }
        const ids = Array.from(parents, (id) => googleFileId(id));
        const link = new URL(boundedString(file.webViewLink, 1024));
        const sheet = fileId === generation.spreadsheet_id;
        if (link.protocol !== "https:" || link.port || link.username || link.password || link.hash ||
            link.hostname !== (sheet ? "docs.google.com" : "drive.google.com") ||
            link.pathname !== (sheet ? `/spreadsheets/d/${fileId}/edit` : `/drive/folders/${fileId}`) ||
            [...link.searchParams].some(([key, value]) => key !== "usp" || !["drivesdk", "sharing"].includes(value)) ||
            link.searchParams.getAll("usp").length > 1) throw new Error("GOOGLE_METADATA_MISMATCH");
        return { fileId, webViewUrl: link.href, modifiedTime: googleTimestamp(file.modifiedTime),
          name: boundedString(file.name, 256), mimeType: sheet ? SHEET : FOLDER, parents: ids };
      });
    },
  };
}
