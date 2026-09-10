import type { ExchangeGeneration } from "@eliotr/contracts";
import type { SheetRange } from "./port.js";
import { boundedString, object } from "./rest-transport.js";

export interface ExchangeRange {
  readonly name: string;
  readonly grid: { readonly sheetId: number; readonly startRowIndex: number; readonly endRowIndex: number;
    readonly startColumnIndex: number; readonly endColumnIndex: number };
}

function column(label: string): number {
  return [...label].reduce((result, character) => result * 26 + character.charCodeAt(0) - 64, 0) - 1;
}
function readRange(value: string, generation: ExchangeGeneration): ExchangeRange {
  if (typeof value !== "string" || value.length > 100) throw new Error("GOOGLE_RANGE_INVALID");
  const match = /^(?:'([A-Z_]+)'|([A-Z_]+))!([A-Z]{1,2})([1-9][0-9]{0,9}):([A-Z]{1,2})([1-9][0-9]{0,9})$/u.exec(value);
  if (!match) throw new Error("GOOGLE_RANGE_INVALID");
  const title = match[1] ?? match[2] ?? "";
  const entry = Object.entries(generation.sheet_ids).find(([key]) => key.toUpperCase() === title);
  if (!entry) throw new Error("GOOGLE_RANGE_INVALID");
  const firstRow = Number(match[4]) - 1; const lastRow = Number(match[6]);
  const firstColumn = column(match[3] ?? ""); const lastColumn = column(match[5] ?? "") + 1;
  if (lastRow <= firstRow || lastRow > 2147483647 || lastColumn <= firstColumn || firstColumn < 0 || lastColumn > 64
      || lastRow - firstRow > 256) throw new Error("GOOGLE_RANGE_LIMIT");
  return { name: `${title}!${match[3]}${match[4]}:${match[5]}${match[6]}`,
    grid: { sheetId: entry[1], startRowIndex: firstRow, endRowIndex: lastRow,
      startColumnIndex: firstColumn, endColumnIndex: lastColumn } };
}
function key(grid: ExchangeRange["grid"]): string {
  return [grid.sheetId, grid.startRowIndex, grid.endRowIndex, grid.startColumnIndex, grid.endColumnIndex].join(":");
}

export function exchangeRanges(ranges: readonly string[], generation: ExchangeGeneration): readonly ExchangeRange[] {
  if (!Array.isArray(ranges) || ranges.length < 1 || ranges.length > 16) throw new Error("GOOGLE_RANGE_LIMIT");
  const parsed = Array.from(ranges, (range) => readRange(range, generation));
  let cells = 0;
  for (let index = 0; index < parsed.length; index += 1) {
    const current = parsed[index]; if (!current) throw new Error("GOOGLE_RANGE_INVALID");
    const a = current.grid;
    cells += (a.endRowIndex - a.startRowIndex) * (a.endColumnIndex - a.startColumnIndex);
    if (cells > 4096) throw new Error("GOOGLE_RANGE_LIMIT");
    if (parsed.slice(0, index).some(({ grid: b }) => a.sheetId === b.sheetId &&
        a.startRowIndex < b.endRowIndex && b.startRowIndex < a.endRowIndex &&
        a.startColumnIndex < b.endColumnIndex && b.startColumnIndex < a.endColumnIndex)) throw new Error("GOOGLE_RANGE_OVERLAP");
  }
  return parsed;
}

export function decodeSheetRanges(value: unknown, ranges: readonly ExchangeRange[], generation: ExchangeGeneration): SheetRange[] {
  const body = object(value, ["spreadsheetId", "valueRanges"]);
  if (body.spreadsheetId !== generation.spreadsheet_id || !Array.isArray(body.valueRanges) || body.valueRanges.length !== ranges.length) {
    throw new Error("GOOGLE_RANGE_BINDING_MISMATCH");
  }
  const expected = new Map(ranges.map((range) => [key(range.grid), range]));
  const results = new Map<string, SheetRange>();
  for (const raw of body.valueRanges) {
    const matched = object(raw, ["dataFilters", "valueRange"]);
    if (!Array.isArray(matched.dataFilters) || matched.dataFilters.length !== 1) throw new Error("GOOGLE_RANGE_BINDING_MISMATCH");
    const filter = object(matched.dataFilters[0], ["gridRange"]);
    const grid = object(filter.gridRange, ["sheetId", "endRowIndex", "endColumnIndex"], ["startRowIndex", "startColumnIndex"]);
    const identity = [grid.sheetId, grid.startRowIndex === undefined ? 0 : grid.startRowIndex, grid.endRowIndex, grid.startColumnIndex === undefined ? 0 : grid.startColumnIndex, grid.endColumnIndex];
    if (identity.some((item) => typeof item !== "number" || !Number.isSafeInteger(item))) throw new Error("GOOGLE_RANGE_BINDING_MISMATCH");
    const wanted = expected.get(identity.join(":"));
    if (!wanted || results.has(wanted.name)) throw new Error("GOOGLE_RANGE_BINDING_MISMATCH");
    const range = object(matched.valueRange, ["range", "majorDimension"], ["values"]);
    if (range.majorDimension !== "ROWS" || readRange(boundedString(range.range, 100), generation).name !== wanted.name) {
      throw new Error("GOOGLE_RANGE_BINDING_MISMATCH");
    }
    const rows = range.values === undefined ? [] : range.values;
    const width = wanted.grid.endColumnIndex - wanted.grid.startColumnIndex;
    if (!Array.isArray(rows) || rows.length > wanted.grid.endRowIndex - wanted.grid.startRowIndex) throw new Error("GOOGLE_RANGE_LIMIT");
    const values = Array.from(rows, (rawRow) => {
      if (!Array.isArray(rawRow) || rawRow.length > width) throw new Error("GOOGLE_RANGE_LIMIT");
      // Sheets omits trailing empty cells. Pad cells only, never synthesize absent source rows.
      return Array.from({ length: width }, (_, index): unknown => {
        if (index >= rawRow.length) return "";
        const cell: unknown = rawRow[index];
        if (typeof cell === "string" && cell.length <= 30000 && cell.isWellFormed()) return cell;
        if (typeof cell === "boolean" || (typeof cell === "number" && Number.isFinite(cell))) return cell;
        throw new Error("GOOGLE_CELL_INVALID");
      });
    });
    results.set(wanted.name, { range: wanted.name, values });
  }
  return ranges.map(({ name }) => { const result = results.get(name); if (!result) throw new Error("GOOGLE_RANGE_BINDING_MISMATCH"); return result; });
}
