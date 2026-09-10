import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExchangeGeneration } from "@eliotr/contracts";
import { createGoogleExchangeSheetPort, type GoogleExchangeSheetOptions } from "./sheet-port.js";
import { createGoogleJsonTransport, GoogleRestError, type GoogleAccessLease } from "./rest-transport.js";
import { contributionFixture, exchangeFixture, payloadFixture } from "./drive-test-fixture.js";
import { serializeAtomicContribution } from "./serializer.js";
import { assembleContribution, parsePayloadPartCells, parseRequestCells } from "./contribution.js";

const NOW = Date.parse("2026-09-05T12:00:00Z");
const generation = exchangeFixture();
const append = (text = "receipt-1", sheetId = generation.sheet_ids.receipts) => [{ appendCells: { sheetId,
  rows: [{ values: [{ userEnteredValue: { stringValue: text } }] }], fields: "userEnteredValue" } }];
function setup(fetcher: typeof fetch, extra: Partial<GoogleExchangeSheetOptions> = {}) {
  const current = vi.fn(async () => {});
  const lease: GoogleAccessLease = { connection_id: generation.connection_id, exchange_generation_id: generation.generation_id,
    access_token: "secret-access-token", expires_at_epoch_ms: NOW + 60000, assertCurrent: current };
  const authorize = vi.fn(async () => lease); const calls = vi.fn(fetcher);
  const options: GoogleExchangeSheetOptions = { generation, connectionId: generation.connection_id, generationId: generation.generation_id,
    operationRef: "poll-1", deadlineEpochMs: NOW + 5000, maxRequests: 16, authorize, fetchImpl: calls, now: () => NOW, ...extra };
  return { port: createGoogleExchangeSheetPort(options), authorize, current, calls, lease };
}
function rangesReply(body: unknown, values: unknown[][][] = [[[]]]) {
  const input = body as { dataFilters: { gridRange: { sheetId: number; startRowIndex: number; endRowIndex: number;
    startColumnIndex: number; endColumnIndex: number } }[] };
  return { spreadsheetId: generation.spreadsheet_id, valueRanges: input.dataFilters.map((filter, index) => {
    const grid = filter.gridRange;
    const title = Object.entries(generation.sheet_ids).find(([, id]) => id === grid.sheetId)?.[0].toUpperCase();
    const column = (n: number) => String.fromCharCode(65 + n);
    return { dataFilters: [filter], valueRange: { range: `'${title}'!${column(grid.startColumnIndex)}${grid.startRowIndex + 1}:${column(grid.endColumnIndex - 1)}${grid.endRowIndex}`,
      majorDimension: "ROWS", values: values[index] ?? [] } };
  }) };
}
function metadata(fileId = generation.spreadsheet_id) {
  const sheet = fileId === generation.spreadsheet_id;
  return { id: fileId, name: sheet ? "ERC Exchange" : "Eliot Research Exchange",
    mimeType: sheet ? "application/vnd.google-apps.spreadsheet" : "application/vnd.google-apps.folder",
    parents: [sheet ? generation.folder_id : "parent_folder"],
    webViewLink: sheet ? `https://docs.google.com/spreadsheets/d/${fileId}/edit` : `https://drive.google.com/drive/folders/${fileId}`,
    modifiedTime: "2026-09-05T11:00:00Z", trashed: false, ownedByMe: true };
}
afterEach(() => vi.useRealTimers());

describe("required Google Exchange REST subset", () => {
  it("uses fixed official endpoint, current bearer lease, explicit fields and no ambient cookies", async () => {
    const test = setup(async () => Response.json({ startPageToken: "token+/=" }));
    expect(await test.port.getStartPageToken()).toBe("token+/=");
    const [input, init] = test.calls.mock.calls[0] ?? [];
    const url = new URL(String(input));
    expect(url.origin + url.pathname).toBe("https://www.googleapis.com/drive/v3/changes/startPageToken");
    expect(url.searchParams.get("fields")).toBe("startPageToken");
    expect(init).toMatchObject({ method: "GET", redirect: "manual", credentials: "omit", cache: "no-store",
      headers: { Authorization: "Bearer secret-access-token", Accept: "application/json" } });
    expect(test.authorize).toHaveBeenCalledOnce(); expect(test.current).toHaveBeenCalledTimes(2);
  });
  it("reads one bounded page, filters exact Exchange IDs and never advances a durable cursor", async () => {
    const test = setup(async () => Response.json({ nextPageToken: "next", changes: [
      { fileId: "other_file", removed: false },
      { fileId: generation.spreadsheet_id, file: { id: generation.spreadsheet_id,
        mimeType: "application/vnd.google-apps.spreadsheet", modifiedTime: "2026-09-05T11:00:00Z" } },
      { fileId: generation.folder_id, removed: true },
    ] }));
    expect(await test.port.listChanges("start+/=")).toEqual({ nextPageToken: "next", changes: [
      { fileId: generation.spreadsheet_id, removed: false, modifiedTime: "2026-09-05T11:00:00Z" }, { fileId: generation.folder_id, removed: true },
    ] });
    const url = new URL(String(test.calls.mock.calls[0]?.[0]));
    expect(url.searchParams.get("pageToken")).toBe("start+/="); expect(url.searchParams.get("pageSize")).toBe("100");
    expect(test.calls).toHaveBeenCalledOnce();
    expect(await setup(async () => Response.json({ newStartPageToken: "start" })).port.listChanges("start"))
      .toEqual({ changes: [], newStartPageToken: "start" });
  });
  it.each([
    {}, { nextPageToken: "start" }, { nextPageToken: "next", newStartPageToken: "done" },
    { newStartPageToken: "done", changes: null }, { newStartPageToken: "done", unexpected: true },
    { newStartPageToken: "done", changes: Array(101).fill({ fileId: "other_file", removed: true }) },
    { newStartPageToken: "done", changes: [{ fileId: generation.spreadsheet_id, removed: "false" }] },
    { newStartPageToken: "done", changes: [{ fileId: generation.spreadsheet_id, removed: false }] },
    { newStartPageToken: "done", changes: [{ fileId: generation.spreadsheet_id, file: {
      id: "wrong", mimeType: "application/vnd.google-apps.spreadsheet", modifiedTime: "2026-09-05T11:00:00Z" } }] },
  ])("rejects an invalid/ambiguous change page without retry: %j", async (reply) => {
    const test = setup(async () => Response.json(reply));
    await expect(test.port.listChanges("start")).rejects.toMatchObject({ code: "GOOGLE_READ_FAILED", writeOutcome: "NO_WRITE" });
    expect(test.calls).toHaveBeenCalledOnce();
  });
  it("selects bounded ranges by numeric sheet IDs, binds reordered replies and pads only trailing cells", async () => {
    const test = setup(async (_url, init) => {
      const body: unknown = JSON.parse(String(init?.body));
      expect(body).toMatchObject({ majorDimension: "ROWS", valueRenderOption: "UNFORMATTED_VALUE" });
      const result = rangesReply(body, [[['r1']], [['p1', 0]]]);
      result.valueRanges.reverse();
      return Response.json(result);
    });
    const result = await test.port.readSheetRanges(generation.spreadsheet_id, ["REQUESTS!A2:P3", "'PAYLOAD_PARTS'!A2:E2"]);
    expect(result.map((item) => item.range)).toEqual(["REQUESTS!A2:P3", "PAYLOAD_PARTS!A2:E2"]);
    expect(result[0]?.values).toEqual([["r1", ...Array(15).fill("")]]);
    expect(result[1]?.values).toEqual([["p1", 0, "", "", ""]]);
    const data = JSON.parse(String(test.calls.mock.calls[0]?.[1]?.body)) as { dataFilters: unknown[] };
    expect(data.dataFilters[0]).toEqual({ gridRange: { sheetId: 1001, startRowIndex: 1, endRowIndex: 3, startColumnIndex: 0, endColumnIndex: 16 } });
  });
  it("accepts omitted default-zero grid starts and empty values, never null-as-empty", async () => {
    const test = setup(async (_url, init) => {
      const result = rangesReply(JSON.parse(String(init?.body)) as unknown, [[]]);
      const match = result.valueRanges[0]; if (!match) throw new Error("fixture");
      Reflect.deleteProperty(match.dataFilters[0]?.gridRange ?? {}, "startRowIndex");
      Reflect.deleteProperty(match.dataFilters[0]?.gridRange ?? {}, "startColumnIndex");
      Reflect.deleteProperty(match.valueRange, "values");
      return Response.json(result);
    });
    expect(await test.port.readSheetRanges(generation.spreadsheet_id, ["REQUESTS!A1:P1"])).toEqual([{ range: "REQUESTS!A1:P1", values: [] }]);
  });
  it("rejects unbounded/overlapping/foreign ranges and IDs before token acquisition", () => {
    const test = setup(async () => { throw new Error("must not fetch"); });
    for (const ranges of [[], ["REQUESTS!A:A"], ["REQUESTS!A1:P257"], ["REQUESTS!A0:P1"], ["REQUESTS!Z1:A2"], ["UNKNOWN!A1:P1"],
      ["REQUESTS!A1:P256", "PAYLOAD_PARTS!A1:E1"], ["REQUESTS!A1:P10", "REQUESTS!B3:B4"], Array(17).fill("REQUESTS!A1:A1")]) {
      expect(() => test.port.readSheetRanges(generation.spreadsheet_id, ranges)).toThrow();
    }
    expect(() => test.port.readSheetRanges("other", ["REQUESTS!A1:A1"])).toThrow();
    expect(() => test.port.getFileMetadata("other")).toThrow();
    expect(test.authorize).not.toHaveBeenCalled(); expect(test.calls).not.toHaveBeenCalled();
  });
  it("rejects wrong spreadsheet/range/filter, duplicate matches, excess cells, objects and null bodies", async () => {
    const mutations = [
      (v: ReturnType<typeof rangesReply>) => { v.spreadsheetId = "other"; },
      (v: ReturnType<typeof rangesReply>) => { v.valueRanges = []; },
      (v: ReturnType<typeof rangesReply>) => { v.valueRanges.push(v.valueRanges[0] as (typeof v.valueRanges)[number]); },
      (v: ReturnType<typeof rangesReply>) => { const r = v.valueRanges[0]; if (r) r.valueRange.range = "CATALOG!A1:P1"; },
      (v: ReturnType<typeof rangesReply>) => { const r = v.valueRanges[0]; if (r) r.valueRange.majorDimension = "COLUMNS"; },
      (v: ReturnType<typeof rangesReply>) => { const g = v.valueRanges[0]?.dataFilters[0]?.gridRange; if (g) g.sheetId = 1003; },
      (v: ReturnType<typeof rangesReply>) => { const r = v.valueRanges[0]; if (r) r.valueRange.values = [[...Array(17).fill("")]]; },
      (v: ReturnType<typeof rangesReply>) => { const r = v.valueRanges[0]; if (r) r.valueRange.values = [[{ bad: "cell" }]]; },
      (v: ReturnType<typeof rangesReply>) => { const r = v.valueRanges[0]; if (r) r.valueRange.values = [["x".repeat(30001)]]; },
      (v: ReturnType<typeof rangesReply>) => { const r = v.valueRanges[0]; if (r) r.valueRange.values = [["\ud800"]]; },
      (v: ReturnType<typeof rangesReply>) => { const r = v.valueRanges[0]; if (r) Object.assign(r.valueRange, { values: null }); },
      (v: ReturnType<typeof rangesReply>) => { const g = v.valueRanges[0]?.dataFilters[0]?.gridRange; if (g) Object.assign(g, { startRowIndex: null }); },
    ];
    for (const mutate of mutations) {
      const test = setup(async (_url, init) => { const result = rangesReply(JSON.parse(String(init?.body)) as unknown); mutate(result); return Response.json(result); });
      await expect(test.port.readSheetRanges(generation.spreadsheet_id, ["REQUESTS!A1:P1"])).rejects.toMatchObject({ code: "GOOGLE_READ_FAILED" });
    }
  });
  it("executes one append-only ERC batch with literal string cells, not Google formula evaluation", async () => {
    const test = setup(async () => Response.json({ spreadsheetId: generation.spreadsheet_id, replies: [{}] }));
    const receipt = await test.port.batchUpdateSheet(generation.spreadsheet_id, append("=IMPORTXML(private)"));
    expect(receipt).toEqual({ spreadsheetId: generation.spreadsheet_id, replies: [{}], writtenAt: new Date(NOW).toISOString() });
    expect(test.calls).toHaveBeenCalledOnce();
    expect(JSON.parse(String(test.calls.mock.calls[0]?.[1]?.body))).toEqual({ requests: append("=IMPORTXML(private)"), includeSpreadsheetInResponse: false });
  });
  it("rejects raw ChatGPT tabs, updates, sorting, formulas, unknown fields and oversized writes before auth", () => {
    const test = setup(async () => { throw new Error("must not fetch"); });
    const invalid = [[], append("raw", 1001), append("part", 1002), append("dashboard", 1006),
      [{ deleteSheet: { sheetId: 1001 } }], [{ sortRange: {} }], [{ updateCells: {} }],
      append("x".repeat(30001)), Array(17).fill(append()[0]),
      [{ appendCells: { ...append()[0]?.appendCells, fields: "*" } }],
      [{ appendCells: { ...append()[0]?.appendCells, rows: [{ values: [{ userEnteredValue: { formulaValue: "=1" } }] }] } }],
      [{ appendCells: { ...append()[0]?.appendCells, rows: [{ values: [{ userEnteredValue: { stringValue: "a", numberValue: 1 } }] }] } }],
      [{ appendCells: { ...append()[0]?.appendCells, rows: [{ values: [{ userEnteredValue: { numberValue: NaN } }] }] } }],
    ];
    for (const request of invalid) expect(() => test.port.batchUpdateSheet(generation.spreadsheet_id, request)).toThrow();
    expect(() => test.port.batchUpdateSheet("other", append())).toThrow();
    expect(test.authorize).not.toHaveBeenCalled();
  });
  it.each([500, 502, 302, 204])("keeps uncertain write status %i UNKNOWN and never retries", async (status) => {
    const test = setup(async () => new Response(null, { status }));
    await expect(test.port.batchUpdateSheet(generation.spreadsheet_id, append())).rejects.toMatchObject({ writeOutcome: "UNKNOWN" });
    expect(test.calls).toHaveBeenCalledOnce();
  });
  it.each([400, 403, 404, 409, 412, 429])("classifies explicit Google write rejection %i without retry", async (status) => {
    const test = setup(async () => Response.json({ error: { message: "secret-reflection" } }, { status }));
    await expect(test.port.batchUpdateSheet(generation.spreadsheet_id, append())).rejects.toMatchObject({ code: "GOOGLE_HTTP_REJECTED", writeOutcome: "REJECTED", httpStatus: status });
    expect(test.calls).toHaveBeenCalledOnce();
  });
  it("maps 401 to reauthentication and does not issue refresh/retry/destructive calls", async () => {
    const test = setup(async () => new Response("secret-access-token", { status: 401 }));
    await expect(test.port.getStartPageToken()).rejects.toMatchObject({ code: "GOOGLE_REAUTH_REQUIRED", writeOutcome: "NO_WRITE" });
    expect(test.calls).toHaveBeenCalledOnce(); expect(test.authorize).toHaveBeenCalledOnce();
  });
  it("treats a lost write reply, malformed receipt, wrong identity and invented readback as uncertain", async () => {
    const responses = [null, {}, { spreadsheetId: "other", replies: [{}] }, { spreadsheetId: generation.spreadsheet_id, replies: [] },
      { spreadsheetId: generation.spreadsheet_id, replies: [{ canonical: true }] }];
    for (const reply of responses) {
      const test = setup(async () => { if (reply === null) throw new Error("secret-access-token"); return Response.json(reply); });
      const error: unknown = await test.port.batchUpdateSheet(generation.spreadsheet_id, append()).catch((e: unknown) => e);
      expect(error).toMatchObject({ code: "GOOGLE_WRITE_OUTCOME_UNKNOWN", writeOutcome: "UNKNOWN" });
      expect(String(error)).not.toContain("secret-access-token"); expect(test.calls).toHaveBeenCalledOnce();
    }
  });
  it("binds file metadata to dedicated-owned untrashed native Sheet/folder, exact parent and safe link", async () => {
    expect(await setup(async () => Response.json(metadata())).port.getFileMetadata(generation.spreadsheet_id))
      .toMatchObject({ fileId: generation.spreadsheet_id, parents: [generation.folder_id], name: "ERC Exchange" });
    expect(await setup(async () => Response.json(metadata(generation.folder_id))).port.getFileMetadata(generation.folder_id))
      .toMatchObject({ fileId: generation.folder_id });
    for (const change of [{ id: "other" }, { parents: ["other"] }, { ownedByMe: false }, { trashed: true }, { mimeType: "text/plain" },
      { webViewLink: "https://attacker.example" }, { modifiedTime: "yesterday" }, { modifiedTime: "2026-02-30T00:00:00Z" },
      { webViewLink: `${metadata().webViewLink}?redirect=https://other.example` }, { parents: null }]) {
      await expect(setup(async () => Response.json({ ...metadata(), ...change })).port.getFileMetadata(generation.spreadsheet_id)).rejects.toThrow();
    }
  });
  it("snapshots the generation/append input before asynchronous authorization; draining is read-only", async () => {
    const mutable = exchangeFixture(); const write = append();
    const test = setup(async (_url, init) => {
      expect(JSON.parse(String(init?.body)).requests).toEqual(append());
      return Response.json({ spreadsheetId: generation.spreadsheet_id, replies: [{}] });
    }, { generation: mutable });
    const pending = test.port.batchUpdateSheet(generation.spreadsheet_id, write);
    Object.assign(mutable.sheet_ids, { receipts: 1001 }); write[0]?.appendCells.rows.splice(0);
    await expect(pending).resolves.toHaveProperty("spreadsheetId", generation.spreadsheet_id);
    const draining = setup(async () => Response.json({ startPageToken: "start" }), { generation: { ...generation, status: "draining" } });
    expect(() => draining.port.batchUpdateSheet(generation.spreadsheet_id, append())).toThrow();
    await expect(draining.port.getStartPageToken()).resolves.toBe("start");
    for (const altered of [{ ...generation, status: "retired" }, { ...generation, connection_id: "other" },
      { ...generation, spreadsheet_id: "../escape" }]) {
      expect(() => setup(async () => Response.json({}), { generation: altered as ExchangeGeneration })).toThrow();
    }
  });
  it("round-trips the existing request serializer through numeric range readback and strict assembly", async () => {
    const part = payloadFixture(); const request = { ...contributionFixture(), body_encoding: "chunked_utf8" as const,
      inline_body: "", payload_id: part.payload_id, part_count: 1 };
    // Represents the independent ChatGPT append action. The ERC writer is expressly not used for these tabs.
    const submitted = serializeAtomicContribution(generation, request, [part]);
    const rawRows = submitted.map((item) => item.appendCells.rows.map((row) => row.values.map(({ userEnteredValue: cell }) => cell.stringValue ?? cell.numberValue)));
    const test = setup(async (_url, init) => Response.json(rangesReply(JSON.parse(String(init?.body)) as unknown, rawRows)));
    const ranges = await test.port.readSheetRanges(generation.spreadsheet_id, ["REQUESTS!A2:P2", "PAYLOAD_PARTS!A2:E2"]);
    expect(assembleContribution(parseRequestCells(ranges[0]?.values[0] ?? []), [parsePayloadPartCells(ranges[1]?.values[0] ?? [])]))
      .toMatchObject({ request, body: part.utf8_text });
    expect(() => test.port.batchUpdateSheet(generation.spreadsheet_id, [...submitted])).toThrow();
  });
});

describe("Google request lifetime and failure isolation", () => {
  it("rejects expired, wrong-connection/generation and header-injection leases before fetch", async () => {
    for (const change of [{ expires_at_epoch_ms: NOW }, { connection_id: "other" }, { exchange_generation_id: "other" },
      { access_token: "token\r\nSecret:bad" }, { access_token: "" }]) {
      const test = setup(async () => Response.json({ startPageToken: "start" })); Object.assign(test.lease, change);
      await expect(test.port.getStartPageToken()).rejects.toMatchObject({ writeOutcome: "NO_WRITE" }); expect(test.calls).not.toHaveBeenCalled();
    }
  });
  it("reauthorizes each request, enforces request count and checks revocation after the response", async () => {
    const test = setup(async () => Response.json({ startPageToken: "start" }), { maxRequests: 1 });
    await test.port.getStartPageToken(); await expect(test.port.getStartPageToken()).rejects.toMatchObject({ code: "GOOGLE_REQUEST_BUDGET_EXHAUSTED" });
    expect(test.authorize).toHaveBeenCalledOnce();
    const changed = setup(async () => { changed.current.mockRejectedValue(new Error("secret-policy")); return Response.json({ startPageToken: "start" }); });
    await expect(changed.port.getStartPageToken()).rejects.toMatchObject({ code: "GOOGLE_READ_FAILED" });
    expect(changed.current).toHaveBeenCalledTimes(2);
  });
  it("never reflects typed or raw token-provider failures", async () => {
    for (const error of [new Error("secret-refresh-token"), new GoogleRestError("secret-refresh-token", "REJECTED", 401)]) {
      const test = setup(async () => Response.json({}), { authorize: async () => { throw error; } });
      const failure: unknown = await test.port.getStartPageToken().catch((e: unknown) => e);
      expect(String(failure)).not.toContain("secret-refresh-token"); expect(failure).toMatchObject({ writeOutcome: "NO_WRITE" });
      expect(test.calls).not.toHaveBeenCalled();
    }
  });
  it("rejects cancelled/expired contexts before authorization or fetch", async () => {
    const abort = new AbortController(); abort.abort();
    for (const extra of [{ signal: abort.signal }, { deadlineEpochMs: NOW }]) {
      const test = setup(async () => Response.json({}), extra);
      await expect(test.port.getStartPageToken()).rejects.toMatchObject({ code: "GOOGLE_OPERATION_CANCELLED" }); expect(test.authorize).not.toHaveBeenCalled();
    }
  });
  it("bounds token acquisition and ignores a late authorization without dispatch", async () => {
    vi.useFakeTimers(); let resolveLease: ((lease: GoogleAccessLease) => void) | undefined;
    const test = setup(async () => Response.json({}), { authorize: () => new Promise((resolve) => { resolveLease = resolve; }) });
    const failure = test.port.getStartPageToken().catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(5001); expect(await failure).toMatchObject({ writeOutcome: "NO_WRITE" });
    resolveLease?.(test.lease); await vi.advanceTimersByTimeAsync(1); expect(test.calls).not.toHaveBeenCalled();
  });
  it("bounds connection and streaming-body stalls and cancels an over-budget body", async () => {
    vi.useFakeTimers(); let cancelled = false;
    for (const fetcher of [(() => new Promise<Response>(() => {})) as typeof fetch,
      (async () => new Response(new ReadableStream({ cancel() { cancelled = true; } }), { headers: { "content-type": "application/json" } })) as typeof fetch]) {
      const test = setup(fetcher); const failure = test.port.batchUpdateSheet(generation.spreadsheet_id, append()).catch((error: unknown) => error);
      await vi.advanceTimersByTimeAsync(5001); expect(await failure).toMatchObject({ code: "GOOGLE_WRITE_OUTCOME_UNKNOWN", writeOutcome: "UNKNOWN" });
      expect(test.calls).toHaveBeenCalledOnce();
    }
    expect(cancelled).toBe(true);
  });
  it("cleans up a late fetch result after deadline without exposing its body", async () => {
    vi.useFakeTimers(); let finish: ((response: Response) => void) | undefined; let cancelled = false;
    const test = setup(() => new Promise<Response>((resolve) => { finish = resolve; }));
    const failure = test.port.getStartPageToken().catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(5001); expect(await failure).toMatchObject({ code: "GOOGLE_READ_FAILED" });
    finish?.(new Response(new ReadableStream({ cancel() { cancelled = true; } }), { headers: { "content-type": "application/json" } }));
    await vi.advanceTimersByTimeAsync(1); expect(cancelled).toBe(true);
  });
  it("classifies post-write revocation UNKNOWN rather than authorizing a replacement append", async () => {
    const test = setup(async () => {
      test.current.mockRejectedValue(new Error("withdrawn"));
      return Response.json({ spreadsheetId: generation.spreadsheet_id, replies: [{}] });
    });
    await expect(test.port.batchUpdateSheet(generation.spreadsheet_id, append())).rejects.toMatchObject({ writeOutcome: "UNKNOWN" });
    expect(test.calls).toHaveBeenCalledOnce();
  });
  it("rejects other origins, API families, userinfo and a wrong mutation class before authorization", async () => {
    const authorize = vi.fn(async (): Promise<GoogleAccessLease> => { throw new Error("not permitted"); });
    const request = createGoogleJsonTransport({ connectionId: "connection-1", generationId: "exchange-1", operationRef: "op-1",
      deadlineEpochMs: NOW + 5000, maxRequests: 1, authorize, now: () => NOW });
    for (const url of ["http://www.googleapis.com/drive/v3/changes", "https://attacker.example/drive/v3/changes",
      "https://user:pass@www.googleapis.com/drive/v3/changes", "https://www.googleapis.com:444/drive/v3/changes",
      "https://www.googleapis.com/drive/v3/permissions", "https://www.googleapis.com/drive/v3/changes?access_token=secret",
      "https://www.googleapis.com/drive/v3/changes?fields=a&fields=b", "https://sheets.googleapis.com/v4/spreadsheets/id:batchUpdate"]) {
      await expect(request(new URL(url), undefined, false, (value) => value)).rejects.toBeInstanceOf(GoogleRestError);
    }
    expect(authorize).not.toHaveBeenCalled();
  });
  it("pins the validated credential destination before asynchronous authorization", async () => {
    const url = new URL("https://www.googleapis.com/drive/v3/changes/startPageToken");
    const current = vi.fn(async () => {});
    const calls = vi.fn(async () => Response.json({ startPageToken: "start" }));
    const request = createGoogleJsonTransport({ connectionId: "connection-1", generationId: "exchange-1", operationRef: "op-1",
      deadlineEpochMs: NOW + 5000, maxRequests: 1, now: () => NOW, fetchImpl: calls, authorize: async () => {
        url.hostname = "attacker.example";
        return { connection_id: "connection-1", exchange_generation_id: "exchange-1", access_token: "secret-access-token",
          expires_at_epoch_ms: NOW + 60000, assertCurrent: current };
      } });
    await request(url, undefined, false, (value) => value);
    expect(calls).toHaveBeenCalledWith("https://www.googleapis.com/drive/v3/changes/startPageToken", expect.any(Object));
  });
  it("rejects invalid budget inputs at construction, before creating a usable network port", () => {
    for (const value of [0, 65, -1, 1.5, NaN, Infinity]) expect(() => setup(async () => Response.json({}), { maxRequests: value })).toThrow();
    for (const value of [NaN, Infinity, 1.5]) expect(() => setup(async () => Response.json({}), { deadlineEpochMs: value })).toThrow();
  });
  it("rejects HTML, invalid UTF8/JSON, declared/chunked overflow and excessive empty chunks", async () => {
    const json = { "content-type": "application/json" };
    const factories = [() => new Response("<html>login</html>"), () => new Response("bad json", { headers: json }),
      () => new Response(new Uint8Array([255]), { headers: json }),
      () => new Response("{}", { headers: { ...json, "content-length": "1048577" } }),
      () => new Response("{}", { headers: { ...json, "content-length": "not-number" } }),
      () => new Response(" ".repeat(1048577), { headers: json }),
      () => new Response(new ReadableStream({ start(controller) {
        for (let n = 0; n < 4097; n += 1) controller.enqueue(new Uint8Array()); controller.close();
      } }), { headers: json })];
    for (const response of factories) {
      const test = setup(async () => response()); await expect(test.port.getStartPageToken()).rejects.toMatchObject({ code: "GOOGLE_READ_FAILED" });
    }
  });
});
