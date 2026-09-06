# Required Drive Exchange: bounded REST checkpoint

Authority: `ELIOT_RESEARCH.md` v29.1 §§12.4–12.10; ER-18/20. This implements the Sheet/changes
transport subset, not the complete ChatGPT connector. Drive remains `IN_PROGRESS` at composition.
No canonical document, wire version, identity preimage, dependency pin or deployment flag changed.

## Executable paths

`createGoogleExchangeSheetPort` implements five existing `GoogleDrivePort` methods:

| Method | Behavior |
|---|---|
| `getStartPageToken` | Read one opaque token before exposing an exchange generation. It does not store/advance the cursor. |
| `listChanges` | Read one page of at most 100 changes; return only the pinned Sheet/folder IDs. Intermediate/final token shape is checked, including pagination loops. |
| `readSheetRanges` | Convert finite fixed-tab A1 ranges to numeric `GridRange` filters. Bind spreadsheet ID, returned filters, tab names and range extents; restore requested order, reject duplicates/overlaps and pad omitted trailing cells only. |
| `batchUpdateSheet` | One append-only batch to ERC-owned SYSTEM/CATALOG/RECEIPTS/RESULTS tabs. Reject REQUESTS/PAYLOAD_PARTS/DASHBOARD, edits, sorting, deletes, formulas, unknown fields and oversize input before authorization. |
| `getFileMetadata` | Read only the configured native Sheet/folder; check ID, MIME, dedicated-account ownership flag, trash state, Sheet parent and safe native web link. This observation is not source/evidence authority. |

The factory returns an explicit `Pick<GoogleDrivePort, ...>`; it has no pretend implementation of
`createResultDocument` or `exportDocument`. There is no environment-driven endpoint override or new
Worker route. Retired generations are rejected. This initial subset reads draining generations but
writes only active ones; completion/delivery during draining must be integrated with the pending
G3/G6 generation/publisher lifecycle, not silently redirected to another Sheet.

The existing `serializeAtomicContribution` remains the **independent ChatGPT submission format**:
one request plus all parts in a single `appendCells` batch. The ERC adapter is deliberately not a
second REQUESTS/PAYLOAD_PARTS writer. Templates/fixture tooling use the serializer without granting
runtime source access. Strings use `stringValue`, not formulas. Numeric counter cells remain numbers.

## Caller contract and failure handling

Create a request-scoped port with the pinned generation, connection ID, operation reference, absolute
deadline, request-count budget and optional cancellation signal. The trusted `authorize(signal)` port
must come from the **admitted dedicated-account OAuth lifecycle**, not an arbitrary client token. It
returns a short-lived `GoogleAccessLease` bound to the expected connection/generation and a read-only
`assertCurrent(signal)` hook for current connection/generation authority. The REST adapter verifies
lease shape/expiry and calls that hook before sending and after reading. The implemented D1 credential provider in `drive-credentials.md` now supplies this boundary from
previously admitted records, with encryption/refresh/CAS/currentness checks. Initial browser OAuth and
verified subject/email admission are still missing, not replaced by a hardcoded credential or test switch.

Only the official Drive v3 and Sheets v4 HTTPS endpoints are used. No redirects, ambient cookies,
credential-bearing URL parameters or reflected upstream diagnostics. Token acquisition, currentness
checks, response headers and streaming bodies share the request deadline. Late responses are cancelled.
The operation reference is caller correlation, **not** a Google idempotency guarantee.

`GoogleRestError.writeOutcome` distinguishes:

- `NO_WRITE`: reads or a failure before mutation dispatch;
- `REJECTED`: an explicit supported Google 4xx rejection;
- `UNKNOWN`: a lost, timed-out, redirected, malformed or uncertain mutation response, including a
  changed credential/generation after the response. Never issue a replacement append on that result.

There are no automatic retries. A 401 returns `GOOGLE_REAUTH_REQUIRED`; the OAuth owner must persist
that connector state without touching canonical artifacts. `WriteReceipt.writtenAt` is a **local HTTP
acknowledgement observation**, not a provider commit timestamp or exact row readback. Neither a 200 nor
that receipt admits a contribution. Cursor/exact-row readback and D1 idempotency remain required.

## Bounds and unchanged semantics

One context permits at most 64 request attempts. Each call has a maximum 15-second deadline and
1 MiB request/response JSON budget; streamed reads also cap chunk count at 4096. There is no automatic
full-sheet scan or changes-page loop. Reads allow at most 16 non-overlapping ranges, 256 rows per
range, columns A–BL and 4096 cells in total. ERC append is limited to 16 requests, 128 rows, 4096 cells
and 128 KiB of cell-value UTF-8. A caller must partition larger scans without treating a partial scan
as completion/absence proof.

The v1 contribution guard now enforces the already documented maximum five parts, 30,000 UTF-16 code
units per cell (the existing schema's string-length unit), and 128 KiB over **all transported cell
values**, including request metadata. HTTP escaping has a separate byte limit. It rejects unknown
fields, numeric/boolean/object-to-string coercion, sparse cells, malformed surrogate pairs, mixed body
encodings, mismatched payload IDs/counts and duplicate indices before serialization. Parts are assembled
by their declared index, never row position. `utf8_bytes` remains the body byte count; valid field names,
sixteen/five-column layouts and canonical identity preimages are unchanged. Semantic interpretation of
scope, budget and body remains the existing contribution/domain owner's responsibility.

## Remaining implementation and agent acceptance

G1 Sheet/changes code, serializer guards and G2 encrypted credential/refresh machinery are implemented.
Initial browser OAuth/verified admission (remaining G2), generation provisioning,
durable leased cursor/audit/freeze/ContributionIntent (G3–G5), Doc/export/publication (G6), runtime/UI
composition and the complete actual-storage/browser loop (G7–G8) remain open in #95. Do not activate
DRIVE_EXCHANGE or remove the launch hold based on this subset. Continue with the initial verified OAuth admission into the existing encrypted lease provider
and operation-specific adapters; reuse these methods rather than creating another client.

The tests execute the actual serializer, fetch port, response decoder and contribution assembler with
controlled provider responses. They cover all seven reproduced serializer/reader defect groups,
malformed/currentness/size/deadline negatives, numeric-range binding, one-attempt uncertain writes,
request/response cancellation and the prohibition on ERC writing the ChatGPT tabs. They do not prove
an actual Google login, append, schema readback, canonical admission or completed end-to-end exchange.

At the first **complete** approved staging trial, ER-26/27 must retain genuine dedicated-account
identity/scopes, numeric-tab/schema and omission/default-field observations, independent ChatGPT atomic
append, exact readback, cursor replay, lost-ACK/tamper/currentness failures and canonical D1/R2 results.
Use the shared `launch-prs/cloudflare-handoff.md` prerequisites. Missing code stays off-account work;
missing credentials are `NOT_EXECUTED`, performed failures are `FAIL`, not fabricated success.

## API references checked 2026-09-05

Drive **v3**, Sheets **v4**; official REST specifications, not SDK assumptions:

- https://developers.google.com/workspace/drive/api/reference/rest/v3/changes/getStartPageToken
- https://developers.google.com/workspace/drive/api/reference/rest/v3/changes/list
- https://developers.google.com/workspace/drive/api/reference/rest/v3/files
- https://developers.google.com/workspace/sheets/api/reference/rest/v4/spreadsheets.values/batchGetByDataFilter
- https://developers.google.com/workspace/sheets/api/reference/rest/v4/spreadsheets/batchUpdate
- https://developers.google.com/workspace/sheets/api/reference/rest/v4/spreadsheets/request#AppendCellsRequest
