# Local launch checkpoint

## Implemented owner loop

`PWA Corpus Lens → POST /api/v1/research/orient → namespace read policy → admitted source heads →
immutable ScopeSnapshot → explicit scope grant → persisted SourceCards/DocumentMaps → result + trace`.
`GET /api/v1/research/trace/:ref` rechecks the same owner's current scope and grant before returning a
persisted trace. No model, AI Search or R2 payload call occurs in this metadata profile.

The profile is deliberately explicit: product `ORIENT`, evidence grade `E0`, budget
`orientation-metadata-v1`, no literal probes, at most 64 admitted source revisions and 16 displayed
sources, 16 KiB request, and at most 15 minutes per operation. Selected sources, the authorized global
library, source class, project/tag membership and bounded UNION/INTERSECT/EXCEPT use the real D1
resolver. More than 64 sources is an error, not silent corpus truncation. Omitted displayed sources
are counted. Focus text is retained in the trace but **is not semantic filtering or ranking**.

Cards come from admitted source metadata. Maps explicitly report missing structure. There are no
fabricated headings, source excerpts, summaries, citation handles or completeness claims. The returned
EvidencePack contains zero resolved evidence. Full Atlas/section expansion, query/research, federation,
Wiki/reports and Rust authority promotion remain mandatory unfinished launch work.

## Prepare and run

Use the pinned Node/pnpm/Rust toolchain in `toolchain.md`, then from the checkout root:

```text
pnpm install --frozen-lockfile
pnpm local:prepare
pnpm local:dev
```

`local:prepare` builds the actual PWA and applies **all** committed Core/Search migrations to local D1.
`local:dev` repeats this idempotent preparation and binds the one Worker to `127.0.0.1:8787`. Generated
`apps/eliotr-core/wrangler.local.jsonc` and `.eliotr-state/local/` are ignored. There are no remote
AI Search bindings, schedules, resource provisioning or deployment in this command. Real Access
configuration is preserved; API authentication is never disabled. External provider features are not
simulated as working.

The empty-store smoke is: `/healthz` returns ready, `/` serves the built PWA, and a protected API without
an Access assertion returns `401 ACCESS_JWT_MISSING`. This proves local runtime/schema setup, **not** an
authenticated owner session or a populated corpus.

## Authentication and initial authority

The current authentication boundary expects a **valid signed Cloudflare Access assertion** in
`Cf-Access-Jwt-Assertion`, with the exact issuer/audience configured in `.dev.vars`. Raw service-token
headers, an unsigned owner header and an arbitrary cookie are not accepted. A direct localhost browser
does not receive Cloudflare edge assertion injection: an interactive local owner-session bridge is
still pending. Do not work around that by weakening production authentication.

Sources must first be admitted by the existing governed ingest path. `scope_read_policy` requires an
explicit operator-installed row for each source namespace and signed owner principal: `owner_pwa`,
policy identity and positive generation, canonical allowed-use JSON containing `research`, matching
disclosure ceiling, `ACTIVE`, and finite expiry. Upload/admission permissions never create this row.
The orientation operation derives only an exact scoped grant from it; the grant cannot outlive the
policy or frozen scope. A UI/operator command for initial read-policy provisioning remains launch work;
integration fixtures install controlled policies in disposable D1, not in a remote account.

For an already configured local authorized request, the body is:

```json
{
  "query": "",
  "product": "ORIENT",
  "scope_expression": {"kind": "SELECTED_SOURCES", "source_ids": ["your-admitted-source-id"]},
  "literals": [],
  "evidence_grade": "E0",
  "budget_ref": "orientation-metadata-v1",
  "max_results": 8
}
```

POST with `Content-Type: application/json`, a stable `Idempotency-Key` and a valid Access assertion.
The PWA uses the same API and keeps the key for a retry with unchanged inputs. It clears result data on
offline transition, handles cancellation/out-of-order responses, and never caches private API payloads.

## Persistence and changes

Migration `0011_owner_orientation.sql` adds read policies, durable operation/result records, exact
invalidation triggers and a primary D1 authority epoch. Startup requires `core-v11-owner-orientation`.
Do not update `schema_state` by hand to skip migrations.

A repeated identical request returns the same result/trace. Lost write acknowledgements are resolved
by exact readback; an uncertain partial operation remains resumable, never fabricated as complete.
Navigation batch writes are atomic. Policy/grant withdrawal, source purge or membership changes
invalidate dependent scope/results and clear stored result bodies. Request-local currentness caching
checks a primary D1 epoch on every use and never crosses policy/admission/membership expiry. It does
not cache per-artifact source or grant authorization.

The initially empty purge ledger is correctly revision **0**. ScopeSnapshot, RetrievalTrace and
Investigation schema histories advance to generation 2, admitting nonnegative purge revisions; old
positive-revision bytes and identities are unchanged. Upgrade dependent readers before consuming a
zero-frontier snapshot. Never insert a fictitious purge record merely to satisfy a positive-integer
validator.

## Deployment hold

`pnpm launch:code` reports known mandatory pending code paths. The normal live deploy orchestrator
runs that negative gate before local release commands or any remote mutation. There is no skip flag.
An absence of listed blockers is not a completeness proof: Rust promotion, full product paths,
representative quality tests, backup/restore and retained real T4/T6 receipts are still required by
`production-readiness-plan.md`. Do not upload partial product slices with raw Wrangler to evade it.

## Verification scope

Tests apply the full migration chain in local Workers/D1 and exercise the actual HTTP dispatcher and
application (only signed-identity verification is replaced by a controlled test verifier). Another
integration case calls the real PWA transport, decoder and renderer through that Worker. Tests cover
concurrent/restart replay, lost acknowledgements, cancellation, grant/policy races, malformed inputs,
64/65-source bounds and real D1 batch rollback. These are not browser automation, signed-JWT end-to-end
qualification, remote Cloudflare latency measurements or live provider receipts.
