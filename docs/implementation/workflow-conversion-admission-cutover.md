# Workflow conversion/admission inputs and remaining cutover

Source inspection on 2026-10-09, committed baseline `308729c6`, with shared
backend implementation in progress. The Goal remains ACTIVE; independent work
continues.

## Missing selected conversion request

Status: **INPUT_PENDING before automatic conversion**.

The native acquisition selection authorizes capture and supplies its immutable
profile. It does not supply `RawMarkdownConversionRequest`: `max_output_bytes`,
`max_tokens`, `timeout_ms` and optional `conversion_options`. These fields are
required by the existing converter in
`packages/cloudflare-markdown/src/raw-markdown-conversion-contract.ts`.
The owner HTTP flow receives this separate request explicitly. No documented
Workflow producer of that request was found in the inspected acquisition route.

The existing PWA composition derives conversion `profile_generation` from
`DEPLOYMENT_GENERATION`; that observed choice does not provide the missing
request bounds or authorize copying capture limits into conversion. The
Workflow must consume an explicitly selected existing configuration/request,
then use the identical credential/deployment/profile tuple for conversion
and `readRawMarkdownCandidate(expectedConversionContext)` readback. Automatic
conversion stays deferred until that concrete request source is identified.

## Independent implementation available

The existing Core native-capture reader already checks exact operation,
principal, credential, deployment, ACTIVE run, owner Access and held scope.
Its extraction into a reusable Core reader is in progress; no new grant or
fabricated HTTP context is needed.

The published Workflow ingest-owner factory reuses the shared ingest engine,
D1 authority, R2 staging and promotion verifier. Its composition must retain
`requireCurrentIngestPolicy` and the same source-admission service used by
`createIngestApplicationService`. Normalized-admission reservation/status
writes additionally need the Workflow current-authority callback; that seam
is being implemented independently of provider selection.

Full capture bytes/storage identity must be read through a guarded internal
port. Native stage output intentionally does not expose `object_key` or
`source_logical_id`. Neither a URL nor `capture_id` substitutes for the
canonical logical source identity.

## Scope after admission

Admission does not extend the current run's frozen scope. A subsequent owner
run needs a new idempotency identity and explicit `scope_expression`.
`SELECTED_SOURCES` takes canonical logical source IDs and resolves current heads;
the newly frozen snapshot must be compared with the admitted source revision
before executing the new run. A mismatch must fail closed. No automatic scope
expansion or replay of the historical uncertain run is included.

Owning source anchors: `apps/eliotr-core/src/research-native-capture-owner.ts`,
`apps/eliotr-core/src/ingest-composition.ts`,
`packages/cloudflare-research-runtime/src/research-native-acquisition.ts`,
`packages/cloudflare-raw-ingest/src/raw-normalized-admission-service.ts`,
`packages/cloudflare-markdown/src/raw-markdown-conversion-contract.ts`, and
`packages/cloudflare-navigation/src/scope-service.ts`.
