# Browser transport audit — input to ER-48

**Date:** 2026-10-08
**Baseline file:** `packages/pwa-http-client/src/api.ts` at main
`3e6c25660c1ae515760e19d5f9e6b8a735795c4c`; relevant browser transport source was unchanged through reviewed
PR base `517723e3ee41d208bbc1e1696ed23070000a0150`.
**Status:** static code audit; no browser/network execution
**Purpose:** preserve proven safeguards while removing hidden global state and correcting lifecycle, header,
body and range semantics in `@eliotr/owner-api-client`.

## 1. Existing safeguards to preserve

The current transport is substantially stricter than `fetch().json()`:

- only normalized same-origin `/api/v1/` paths are accepted;
- backslash, fragment, control/space and URL-normalization changes are rejected before credentials attach;
- `redirect: "manual"` prevents Access/login redirects becoming trusted API content;
- `credentials: "same-origin"` preserves the owner session model;
- `cache: "no-store"` prevents ordinary HTTP/browser caching of protected API reads;
- `Accept` is explicit;
- JSON response Content-Type, body and status are checked;
- bodies are streamed under byte/chunk budgets before UTF-8/JSON decoding;
- malformed UTF-8/JSON, unknown/missing fields and generation mismatch fail closed;
- typed problem status must equal HTTP status;
- retryability comes from a validated typed problem, not all failures;
- binary/text reads have explicit content type and bounded application ceilings;
- redirect and selected authorization-loss observations clear legacy state;
- timers/listeners are removed and incomplete readers are cancelled best-effort.

ER-48 must not replace these controls with a generic client generator or unbounded framework proxy.

## 2. Confirmed coupling and defects

### T1 — hidden global authorization side effect

`notifyAuthorizationCleared()` dispatches `eliotr:authorization-cleared` on `window`. A transport request
therefore mutates global application state although the package appears transport-only.

Risks: concurrent duplicate transitions, old-session responses clearing a new session, two owners for React
Query/session state, and tests that require browser globals.

**Repair:** injected `onAuthorizationLoss(observation)` callback plus epoch-aware coalescing in adapters.
Only the legacy adapter emits the old event.

### T2 — caller cancellation and deadline timeout collapse

Caller signal and timer abort one controller. Catch maps either to `API_REQUEST_ABORTED` with a retryable
“same inputs” message.

**Repair:** retain client-local typed causes at least for:

```text
CALLER_ABORTED
DEADLINE_EXCEEDED
NETWORK_UNREACHABLE
BODY_READ_INTERRUPTED
```

Do not casually add wire enums. A user/navigation abort is not an outage. Mutations remain explicit readback
and reconciliation only regardless of cause.

### T3 — `RequestInit.headers` merge is not valid for all allowed shapes

The JSON helper spreads `init.headers` into an object. `Headers`, tuple lists and records are all legal but
object spread does not normalize them equivalently.

**Repair:** use `new Headers(init.headers)`, then set/validate required headers. Test record, `Headers`, tuples,
CSRF/idempotency preservation and forbidden override policy.

### T4 — transport construction is hard-coded

Global `fetch`, fixed base, global event and defaults are embedded in helpers.

**Repair:** create an explicit owner client with injected fetch/base URL/auth-loss/timer dependencies. The
production browser still enforces same-origin API paths; configurable base exists for deterministic
composition, not cross-origin production calls.

### T5 — one JSON response budget for all endpoint classes

All JSON responses use 512 KiB. This is bounded but too broad for small controls and not explicit enough for
large manifests.

**Repair:** preserve a hard absolute maximum and assign smaller method budgets where contracts define them.
Any larger response requires explicit review. No unbounded JSON.

### T6 — binary path lacks early Content-Length and Content-Type rejection

`requestApiBytes` streams under `maximumBytes`, but does not reject an oversized valid Content-Length before
reading. For successful responses it checks Content-Type only **after** buffering the body.

**Repair:**

- parse canonical nonnegative Content-Length before acquiring/reading the body;
- reject above the method maximum and cancel unused body best-effort;
- check successful response Content-Type before large reads;
- retain streaming enforcement because headers are optional/untrusted and transparent content decoding can
  make header length different from delivered bytes;
- keep exact-size/digest checks in feature clients.

### T7 — auth/session classification must remain narrow

The current code intentionally clears session on 401, redirect, or typed `ACCESS_*` 403—not every 403.
Resource/policy denial is not owner-session loss.

**Repair:** preserve this distinction. An HTML/non-JSON 403 is malformed/untrusted unless an exact independent
Access signal establishes auth loss.

### T8 — bounded-reader cancellation/release needs adversarial tests

JSON and binary helpers duplicate read/cancel cleanup. Similar repository code has already needed repair.

**Repair:** one browser-compatible bounded reader or equivalent tested implementations. Cover cancel
resolve/reject/hang, abort/deadline during read, excess chunks/bytes, reader failure and lock release. Cleanup
must preserve the original typed error and not wait forever for hostile source cancellation.

### T9 — generic binary helper accepts unrequested, unverified partial responses

`requestApiBytes` always sends an ordinary GET with no `Range` header, but treats both `200` and `206` as
successful. It does not require or parse `Content-Range`, bind returned bytes to a requested interval, or
verify total/range arithmetic.

**Repair:** choose explicit APIs:

```text
requestWholeObject(...)  -> accepts 200 only
requestObjectRange(range) -> sends one exact Range, accepts 206 only, validates Content-Range/length/total
```

If a named endpoint intentionally returns 206 without request Range, document and validate its versioned
contract rather than leaving it in the generic helper. Tests cover missing/malformed/foreign/overlapping/
off-by-one Content-Range, 200 to range request, 206 to whole-object request, 416, empty and maximum ranges.

### T10 — error bodies inherit the large success-object budget and weak media preflight

For binary reads, non-OK responses are buffered under the caller’s `maximumBytes`, which can be up to the
8 MiB application ceiling, then decoded as JSON without first requiring JSON Content-Type. An Access HTML or
provider/proxy error can therefore consume a document-sized budget before failing.

**Repair:** split success and problem readers:

- error/problem bodies have a small fixed JSON budget independent of object maximum;
- require appropriate JSON media type before decoding a typed problem;
- handle 502/503/504 non-JSON/unavailable responses without large buffering;
- cancel unused/oversized/wrong-type response bodies best-effort;
- never expose raw HTML/provider error text.

### T11 — accepted status lists are an unchecked internal policy input

`requestApiWithStatuses` trusts any status array supplied by a caller and checks it only after decoding a
JSON body. Empty, duplicate, non-success or endpoint-incompatible lists are not rejected at construction.

**Repair:** prefer endpoint-specific methods. If the generic helper remains, canonicalize a nonempty unique
allowlist of valid success statuses and keep body semantics explicit. Do not make a status list a way to bypass
endpoint contracts.

### T12 — a byte range is not bound to one immutable representation

Valid `Content-Range` arithmetic alone does not prove that delivered bytes belong to the expected admitted
revision. Intermediaries or server configuration can apply content coding; a browser may expose decoded bytes
while length/range headers describe another representation. A mutable resource can also change between
metadata and range reads.

**Repair:** range support is endpoint-specific and requires an immutable representation contract:

- one range only; reject multipart/byteranges;
- exact admitted revision/object identity in route or request metadata;
- a strong validator such as strong ETag or exact digest/version header obtained from authorized metadata;
- send the endpoint-approved conditional (`If-Match` or equivalent) and reject missing, weak, changed or
  foreign validators;
- successful byte endpoints return no `Content-Encoding` other than an explicitly accepted identity form;
  reject transformed/compressed range representations;
- require numeric total length and validate interval length against delivered decoded bytes;
- feature client rechecks revision, validator, digest/coordinate metadata and lifecycle/generation before use;
- 412/416 and representation mismatch are typed currentness failures, never silent full-object fallback.

The browser cannot rely on setting forbidden transport headers to force identity coding. The owner API must
provide a stable untransformed byte representation, and U3-D/server contract tests must prove it.

## 3. Target layers

```text
pure validators/decoders
  no fetch, clock, DOM or application state

bounded browser transport
  injected fetch + timer/clock
  path/header/status/content-type/body/range limits
  distinct caller/deadline/network/body causes
  emits typed observations only

owner API feature clients
  endpoint-specific budgets/status/body/range/validator rules
  mutation identities/readback semantics

legacy adapter
  maps auth-loss observation to existing global event

React session/query adapter
  epoch-aware clear, Query cancellation/removal, navigation/re-auth UI
```

The transport imports neither React, TanStack Query, UI code nor Cloudflare bindings.

## 4. Required test matrix

### Path and credentials

- valid paths/queries and identifier punctuation;
- absolute/protocol-relative URL, backslash, fragment, encoded parent segment, control/space;
- same-origin credentials/manual redirect/no-store always present;
- configurable test base cannot authorize cross-origin production access.

### Headers

- record, `Headers`, tuple input;
- required Accept and method Content-Type preserved;
- CSRF/custom idempotency headers retained;
- conflicting override follows one explicit fail/set policy.

### Status and authentication

- expected 200/202 endpoint-specific success;
- unexpected/duplicate/empty status policy;
- manual/opaque redirect;
- 401;
- typed `ACCESS_*` 403;
- ordinary policy/resource 403;
- non-JSON 502/503/504;
- HTML/login page at 200/403 never decodes as API success.

### Body and decoder

- media-type parameters;
- absent body and illegal bodyless status for JSON method;
- missing/valid/malformed/oversized Content-Length;
- body under/exact/over limit and too many chunks;
- valid/invalid UTF-8 and malformed JSON;
- valid/malformed typed problem, unknown fields/status mismatch;
- generation mismatch and unknown load-bearing fields;
- wrong success/error media type rejected before large read;
- problem body cannot consume object-byte ceiling.

### Whole/range binary reads

- whole object accepts 200 and rejects 206;
- range request emits one exact Range and accepts validated 206;
- Content-Range start/end/length/numeric-total arithmetic;
- reject multipart/byteranges and multiple-range request;
- strong validator/conditional match; reject missing, weak, changed or foreign validator;
- reject transformed/compressed `Content-Encoding` and representation mismatch;
- 200 fallback policy is explicit, not accidental;
- 412/416 and malformed/missing range metadata;
- feature revision/digest/coordinate/currentness checks still execute.

### Lifecycle

- already-aborted caller;
- abort before headers, during body and after completion;
- deadline before headers/during body;
- network/reader failure;
- cancel resolves/rejects/hangs;
- reader lock release;
- concurrent auth failures coalesce per old epoch;
- old-epoch failure cannot clear a newly verified session;
- timers/listeners removed and no unhandled rejection.

### Mutations

- unknown outcome never auto-retries;
- explicit retry reuses method/path/body/operation identity;
- typed nonretryable conflict is not converted to retryable network failure;
- readback resolves lost acknowledgement without repeating effect.

## 5. Compatibility requirements

- Existing accepted envelopes and `ApiRequestError` consumers retain compatible semantics or receive an
  explicit adapter/version.
- ER-25 browser tests continue through the legacy event adapter.
- ER-47 consumes injected observations and never the global event.
- No two independent maintained bounded readers/problem decoders remain after a family moves.
- Bundle inspection proves client root excludes panel/render/worker code.
- Range support is explicit per endpoint, generic 206 acceptance is removed, and exact byte reads are bound to
  one immutable untransformed representation.

## 6. Status

Static source review only. No browser, stream fixture, TypeScript build or package test was executed. T1–T12
are confirmed implementation requirements/findings, not claims that ER-48 source exists or passes.
