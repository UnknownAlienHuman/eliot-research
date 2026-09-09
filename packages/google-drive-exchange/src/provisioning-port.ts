import { boundedString, createGoogleJsonTransport, googleFileId, googleTimestamp, object, type GoogleRestOptions } from "./rest-transport.js";
import type { DriveFileMetadata } from "./port.js";

export const GOOGLE_FOLDER_MIME = "application/vnd.google-apps.folder" as const;
export const GOOGLE_SPREADSHEET_MIME = "application/vnd.google-apps.spreadsheet" as const;

export interface GoogleSpreadsheetSheet {
  readonly sheetId: number;
  readonly title: string;
  readonly index: number;
}

export interface GoogleSpreadsheetResource {
  readonly spreadsheetId: string;
  readonly title: string;
  readonly sheets: readonly GoogleSpreadsheetSheet[];
}

export interface GoogleExchangeProvisioningPort {
  findExactFile(name: string, mimeType: typeof GOOGLE_FOLDER_MIME | typeof GOOGLE_SPREADSHEET_MIME,
    parentId?: string): Promise<readonly DriveFileMetadata[]>;
  createFolder(name: string): Promise<DriveFileMetadata>;
  createSpreadsheet(name: string, sheetNames: readonly string[]): Promise<GoogleSpreadsheetResource>;
  attachToFolder(fileId: string, parentId: string): Promise<DriveFileMetadata>;
  readFileMetadata(fileId: string, expectedMimeType: typeof GOOGLE_FOLDER_MIME | typeof GOOGLE_SPREADSHEET_MIME): Promise<DriveFileMetadata>;
  readSpreadsheet(spreadsheetId: string): Promise<GoogleSpreadsheetResource>;
  getStartPageToken(): Promise<string>;
}

function endpoint(path: string, fields: string, query: Record<string, string> = {}): URL {
  const url = new URL(path); url.searchParams.set("fields", fields);
  for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
  return url;
}

function text(value: unknown, maximum = 256): string { return boundedString(value, maximum); }

function asset(value: unknown, expectedMimeType?: string): DriveFileMetadata {
  const raw = object(value, ["id", "name", "mimeType", "webViewLink", "modifiedTime", "trashed", "ownedByMe"], ["parents"]);
  const id = googleFileId(raw.id); const mimeType = text(raw.mimeType, 128);
  if (expectedMimeType !== undefined && mimeType !== expectedMimeType) throw new Error("GOOGLE_PROVISIONING_METADATA_INVALID");
  if (raw.trashed !== false || raw.ownedByMe !== true) throw new Error("GOOGLE_PROVISIONING_METADATA_INVALID");
  const parents = raw.parents === undefined ? [] : raw.parents;
  if (!Array.isArray(parents) || parents.length > 1 || parents.some((parent) => typeof parent !== "string")) {
    throw new Error("GOOGLE_PROVISIONING_METADATA_INVALID");
  }
  const parentIds = parents.map((parent) => googleFileId(parent));
  const link = new URL(text(raw.webViewLink, 1024));
  if (link.protocol !== "https:" || link.port || link.username || link.password || link.hash ||
      link.hostname !== (mimeType === GOOGLE_SPREADSHEET_MIME ? "docs.google.com" : "drive.google.com") ||
      [...link.searchParams].some(([key, value]) => key !== "usp" || !["drivesdk", "sharing"].includes(value)) ||
      link.searchParams.getAll("usp").length > 1) throw new Error("GOOGLE_PROVISIONING_METADATA_INVALID");
  return { fileId: id, webViewUrl: link.href, modifiedTime: googleTimestamp(raw.modifiedTime),
    name: text(raw.name), mimeType, parents: parentIds };
}

function spreadsheet(value: unknown): GoogleSpreadsheetResource {
  const raw = object(value, ["spreadsheetId", "properties", "sheets"]);
  const properties = object(raw.properties, ["title"]);
  if (!Array.isArray(raw.sheets) || raw.sheets.length < 1 || raw.sheets.length > 16) throw new Error("GOOGLE_PROVISIONING_SHEET_INVALID");
  const sheets = raw.sheets.map((entry) => {
    const item = object(entry, ["properties"]); const props = object(item.properties, ["sheetId", "title", "index"]);
    if (!Number.isSafeInteger(props.sheetId) || (props.sheetId as number) < 0 || !Number.isSafeInteger(props.index) ||
        (props.index as number) < 0 || props.index !== sheetsIndexGuard(props.index) || typeof props.title !== "string") {
      throw new Error("GOOGLE_PROVISIONING_SHEET_INVALID");
    }
    return { sheetId: props.sheetId as number, title: text(props.title), index: props.index as number };
  });
  const ids = new Set(sheets.map((sheet) => sheet.sheetId)); const indices = new Set(sheets.map((sheet) => sheet.index));
  if (ids.size !== sheets.length || indices.size !== sheets.length || sheets.some((sheet, index) => sheet.index !== index)) {
    throw new Error("GOOGLE_PROVISIONING_SHEET_INVALID");
  }
  return { spreadsheetId: googleFileId(raw.spreadsheetId), title: text(properties.title), sheets };
}

function sheetsIndexGuard(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > 15) throw new Error("GOOGLE_PROVISIONING_SHEET_INVALID");
  return value as number;
}

export function createGoogleExchangeProvisioningPort(options: GoogleRestOptions): GoogleExchangeProvisioningPort {
  const json = createGoogleJsonTransport(options);
  const fileFields = "id,name,mimeType,parents,webViewLink,modifiedTime,trashed,ownedByMe";
  const findExactFile = async (name: string, mimeType: typeof GOOGLE_FOLDER_MIME | typeof GOOGLE_SPREADSHEET_MIME,
    parentId?: string): Promise<readonly DriveFileMetadata[]> => {
    const safeName = text(name); const safeParent = parentId === undefined ? undefined : googleFileId(parentId);
    const escapedName = safeName.replace(/\\/gu, "\\\\").replace(/'/gu, "\\'");
    const clauses = [`name = '${escapedName}'`, `mimeType = '${mimeType}'`, "trashed = false"];
    if (safeParent !== undefined) clauses.push(`'${safeParent}' in parents`);
    const value = await json(endpoint("https://www.googleapis.com/drive/v3/files", `files(${fileFields}),nextPageToken`,
      { q: clauses.join(" and "), pageSize: "100", spaces: "drive", orderBy: "createdTime desc" }), undefined, false,
      (raw) => {
        const result = object(raw, ["files"], ["nextPageToken"]);
        if (!Array.isArray(result.files) || result.files.length > 100 || result.nextPageToken !== undefined) {
          throw new Error("GOOGLE_PROVISIONING_MATCHES_INCOMPLETE");
        }
        return result.files.map((entry) => asset(entry, mimeType));
      });
    return value;
  };
  const createFolder = (name: string) => json(endpoint("https://www.googleapis.com/drive/v3/files", fileFields),
    { name: text(name), mimeType: GOOGLE_FOLDER_MIME }, true, (raw) => asset(raw, GOOGLE_FOLDER_MIME));
  const createSpreadsheet = (name: string, sheetNames: readonly string[]) => {
    if (!Array.isArray(sheetNames) || sheetNames.length < 1 || sheetNames.length > 16) throw new Error("GOOGLE_PROVISIONING_SHEET_INVALID");
    const names = sheetNames.map((sheetName) => text(sheetName));
    if (new Set(names).size !== names.length) throw new Error("GOOGLE_PROVISIONING_SHEET_INVALID");
    return json(endpoint("https://sheets.googleapis.com/v4/spreadsheets", "spreadsheetId,properties(title),sheets(properties(sheetId,title,index))"),
      { properties: { title: text(name) }, sheets: names.map((title, index) => ({ properties: { title, index } })) }, true,
      (raw) => spreadsheet(raw));
  };
  const attachToFolder = (fileId: string, parentId: string) => {
    const file = googleFileId(fileId); const parent = googleFileId(parentId);
    return json(endpoint(`https://www.googleapis.com/drive/v3/files/${file}`, fileFields, { addParents: parent, removeParents: "root" }),
      {}, true, (raw) => asset(raw, GOOGLE_SPREADSHEET_MIME));
  };
  const readFileMetadata = (fileId: string, expectedMimeType: typeof GOOGLE_FOLDER_MIME | typeof GOOGLE_SPREADSHEET_MIME) => {
    const file = googleFileId(fileId);
    return json(endpoint(`https://www.googleapis.com/drive/v3/files/${file}`, fileFields), undefined, false,
      (raw) => asset(raw, expectedMimeType));
  };
  const readSpreadsheet = (spreadsheetId: string) => {
    const id = googleFileId(spreadsheetId);
    return json(endpoint(`https://sheets.googleapis.com/v4/spreadsheets/${id}`, "spreadsheetId,properties(title),sheets(properties(sheetId,title,index))"),
      undefined, false, spreadsheet);
  };
  return { findExactFile, createFolder, createSpreadsheet, attachToFolder, readFileMetadata, readSpreadsheet,
    getStartPageToken: () => json(endpoint("https://www.googleapis.com/drive/v3/changes/startPageToken", "startPageToken"), undefined, false,
      (raw) => text(object(raw, ["startPageToken"]).startPageToken, 1024)) };
}
