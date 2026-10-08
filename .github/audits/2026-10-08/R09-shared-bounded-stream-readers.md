# R09 — One bounded stream-read boundary

Date: 2026-10-08  
Source baseline: `3e6c25660c1ae515760e19d5f9e6b8a735795c4c`  
Scope: backend runtime utility integration. Documentation task; runtime is not changed here.

## 1. Problem

Eliot already has a bounded Web Streams primitive in:

```text
packages/platform-cloudflare/src/runtime-limits.ts
  readStreamWithinBytes
  readRequestBodyWithinBytes
  readResponseBodyWithinBytes
```

PR #321 fixes two concrete cleanup defects in that primitive. Several production modules nevertheless implement separate and weaker readers.

### Duplicated full-body readers

```text
packages/cloudflare-ai/src/provider-config-rest-response.ts
  readJson
  readStream
  cancelQuietly

packages/cloudflare-ai/src/custom-provider-rest-response.ts
  readJson
  readStream
  cancelQuietly
```

Both copies:

- omit a chunk-count bound;
- retain caller-provided mutable `Uint8Array` views rather than copying chunks;
- do not release the reader lock;
- await cancellation after the primary error is already known;
- repeat Content-Length, UTF-8 and JSON plumbing.

### Other local stream loops

```text
packages/cloudflare-workflows/src/objects.ts
  readWorkflowObject

packages/cloudflare-evidence/src/content-store.ts
  locateLines
  openRange cleanup
```

`readWorkflowObject` is a full bounded read and can use the common primitive. `locateLines` is an intentional streaming seek that discards a prefix; it should remain specialized, but its cleanup must use the same non-blocking cancellation semantics.

## 2. Goal

One implementation owns full-body byte/chunk/copy/lock/cancellation mechanics.

Domain modules own only:

```text
limit selection
domain error mapping
UTF-8/JSON/schema decoding
effect/authority semantics
```

Do not build a generic HTTP framework or permissive universal decoder.

## 3. Dependency

Integrate or faithfully absorb #321 first. R09 assumes the common reader:

- starts best-effort cancellation without awaiting a hostile source;
- consumes cancellation rejection;
- releases the reader lock;
- copies chunks;
- caps bytes and chunks;
- cancels unused bodies rejected by Content-Length preflight.

If #321 is absorbed rather than merged, preserve its exact hostile-stream regressions.

## 4. CODE — ordered changes

### 4.1 Platform primitive

File:

```text
packages/platform-cloudflare/src/runtime-limits.ts
```

Keep the existing public API unless one narrowly required option is missing. Do not add callbacks, codecs, HTTP status handling or domain errors to the platform utility.

If specialized early-stop readers need shared cleanup, add only a minimal helper such as:

```ts
cancelReaderBestEffort(reader, reason?): void
```

It must:

- never await source cancellation;
- consume a rejected cancellation promise;
- never replace the primary result/error;
- not release a reader it does not own.

Do not introduce a generalized stream pipeline abstraction.

### 4.2 Cloudflare AI control-plane responses

Files:

```text
packages/cloudflare-ai/src/provider-config-rest-response.ts
packages/cloudflare-ai/src/custom-provider-rest-response.ts
```

Replace both local `readStream`/`cancelQuietly` implementations with `readResponseBodyWithinBytes` from `@eliotr/platform-cloudflare`.

Use a narrow internal helper in the same package only if it removes repeated neutral mechanics, for example:

```ts
readCloudflareControlPlaneJson(response, {
  label,
  max_bytes,
  mapRuntimeLimitError,
  mapTransportError,
})
```

The helper may:

- read bounded bytes;
- fatal-decode UTF-8;
- parse JSON.

It must not:

- decide provider/custom-provider business success;
- merge their error-code vocabularies;
- swallow an ambiguous CREATE effect;
- accept extra envelope fields;
- return an empty object on failure.

Preserve `ProviderConfigRestError` and `CustomProviderRestError` as the public domain errors.

Map common errors explicitly:

```text
invalid Content-Length / non-byte chunk / invalid UTF-8 / invalid JSON
  → *_RESPONSE_INVALID

byte/chunk limit
  → *_RESPONSE_TOO_LARGE

unknown body transport failure
  → *_TRANSPORT_FAILED (retryable according to existing policy)
```

### 4.3 Workflow R2 object reads

File:

```text
packages/cloudflare-workflows/src/objects.ts
```

After pinned HEAD/GET and metadata checks, use the common reader for the complete object body with:

```text
max_bytes = expected.byte_length
bounded max_chunks
```

Then retain the existing checks:

```text
actual length == expected.byte_length
digest == expected.sha256
same pinned object / immutable metadata
```

Map:

- byte/chunk/non-byte limit error → `WORKFLOW_OUTPUT_CORRUPT`;
- unknown transport read failure → `WORKFLOW_OUTPUT_UNAVAILABLE`;
- authority/metadata mismatch remains corrupt/stale according to current contract.

Do not weaken exact readback or replace the R2 object descriptor.

### 4.4 Evidence line seek

File:

```text
packages/cloudflare-evidence/src/content-store.ts
```

`locateLines` must remain a streaming scan because buffering a 4 MiB prefix solely to find a line is wasteful.

Change only cleanup/limit consistency:

- validate `Uint8Array` before byte access;
- preserve byte and chunk caps;
- on early success or error, start best-effort cancellation without awaiting it;
- release lock in `finally`;
- cancellation failure never changes the exact evidence result/error.

`openRange` error cleanup follows the same rule. A primary authority error must not hang behind body cancellation.

## 5. Delete duplicated code

Completion requires removal, not deprecation, of:

```text
provider-config-rest-response.ts::readStream
provider-config-rest-response.ts::cancelQuietly
custom-provider-rest-response.ts::readStream
custom-provider-rest-response.ts::cancelQuietly
```

Remove now-unused encoders/helpers only when their remaining envelope/message code no longer needs them.

Do not keep local readers “for compatibility”; they are private functions with no wire format.

## 6. Acceptance

### Common primitive

- byte overflow rejects promptly even when `cancel()` never settles;
- chunk overflow rejects promptly;
- non-byte chunk rejects promptly;
- rejected cancellation creates no unhandled rejection;
- reused/mutated source buffer does not change earlier chunks;
- reader lock released on success/failure;
- invalid/oversized Content-Length cancels body without reading.

### Provider/custom-provider

- exact current envelope acceptance unchanged;
- unknown fields still rejected;
- API messages remain bounded;
- 409/5xx CREATE ambiguity preserved;
- invalid header/body/UTF-8/JSON maps to the existing domain code;
- hostile cancellation cannot hang response decoding.

### Workflow objects

- short/long/non-byte/chunk-flood bodies are corrupt;
- transport read failure is unavailable, not corrupt;
- exact length/hash succeeds;
- lost/failed cleanup does not mask the primary outcome.

### Evidence line seek

- early line hit returns without waiting for cancel;
- missing line and scan cap retain existing error class;
- hostile cancel does not hang;
- no full-prefix buffer allocation is introduced;
- CRLF/BOM/final-LF semantics remain unchanged.

## 7. Code reduction receipt

The implementation PR must report:

```text
removed private reader functions
removed duplicated LOC
new shared helper LOC, if any
net production LOC
bundle delta
all migrated callers
specialized loops intentionally retained and why
```

A new wrapper while retaining the old readers is not completion.

## 8. Verification

```sh
pnpm --filter @eliotr/platform-cloudflare typecheck
pnpm --filter @eliotr/cloudflare-ai typecheck
pnpm --filter @eliotr/cloudflare-workflows typecheck
pnpm --filter @eliotr/cloudflare-evidence typecheck

pnpm exec eslint \
  packages/platform-cloudflare/src/runtime-limits.ts \
  packages/cloudflare-ai/src/provider-config-rest-response.ts \
  packages/cloudflare-ai/src/custom-provider-rest-response.ts \
  packages/cloudflare-workflows/src/objects.ts \
  packages/cloudflare-evidence/src/content-store.ts

pnpm exec vitest run \
  packages/platform-cloudflare/src/runtime-limits.test.ts \
  packages/cloudflare-ai/src/provider-config-rest-response.test.ts \
  packages/cloudflare-ai/src/custom-provider-rest-response.test.ts
```

Add focused workflow/evidence hostile-stream tests in their existing suites. Native Workers stream acceptance is later; no provider calls are needed.

## 9. Out of scope

- new HTTP client framework;
- response schema redesign;
- R2 storage redesign;
- unbounded streaming parser;
- provider retries;
- deployment or live control-plane calls.

## 10. Completion result

All complete response bodies use one bounded Cloudflare Web Streams implementation. Specialized evidence seek keeps only domain logic and shares the safe cancellation rule. No duplicate private reader retains weaker guarantees.
