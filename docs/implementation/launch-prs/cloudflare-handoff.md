# Cloudflare agent handoff — existing launch PRs #89–#97

Status: **execution blocked by unfinished mandatory application code**. This is an execution contract,
not a receipt of deployment or permission to publish an incomplete feature branch. Implement missing
adapters, fixtures, browser loops and probe scripts without an account first. Account access is needed
for real platform observations, not for ordinary application development.

## Authority and order

Read `../../architecture/ELIOT_RESEARCH.md` (ownership/admission, §19.1 T4–T6 and §19.13),
`../../architecture/LANGUAGE_RUNTIME_CONTRACT.md`, `../production-readiness-plan.md`,
`../cloudflare-runbook.md`, `../slice-gates.md`, `../release-checklist.md` and the current owning packets.
ER-26 owns provisioning; ER-27 owns `tests/integration/**`; domain/schema/product owners retain their
existing paths. This document adds no schema, generation, state family, product or second deployment
entrypoint. Follow each PR's implementation predecessors from `README.md` in this directory.

There are three separate milestones:

1. **Off-account code acceptance:** mandatory paths and production-critical Rust promotion implemented,
   local/recorded failure cases and complete user loops tested. Unexecuted real-platform gates remain
   `NOT_EXECUTED`; a theme is not production-qualified merely because its code can be merged.
2. **First complete staging trial:** integrate the accepted themes on current main, obtain the owner's
   explicit target/account configuration and authorization, then deploy the complete application once.
   Existing live receipts are not a prerequisite for this first trial; executable probe code and exact
   expected results are. Do not evade the code hold with a raw Wrangler command.
3. **Production qualification:** real retained T0–T6 evidence, security resolution, restore/rollback,
   quality, capacity and cost acceptance required by the normative plan. Failed, absent, partial or
   ambiguous results never become PASS by editing a status file.

### Still off-account work, not a Cloudflare excuse

#89 merged a tested checkpoint; #98 retains active-readiness/project workflows, remaining failure UI
and the complete empty-setup -> import -> Library -> Lens browser/storage loop. The raw-file managed
conversion -> qualification -> projection path required by §4.1 is also ordinary missing code, not a
post-deployment enhancement; normalized-folder ingest alone does not satisfy it. Known-ID reload recovery
and read-only exact-folder discovery of lost IDs are implemented without browser persistence. The initializer
supports only a local absent immutable-import namespace. A governed remote setup adapter must be
implemented/tested before a staging agent can use it; copying fixture SQL is not that adapter.
#90–#97 still require the code checklists in their PRs. Implement live probe runners, their missing-input
and failure branches, independent clients, cost stops and redacted receipt validators locally as part
of those themes. A cloud agent finding missing mandatory code must return it to the corresponding PR,
not develop against a partially deployed Worker or replace the missing path with an always-PASS probe.

## Shared staging entry checklist — ER-26 / ER-27, tracked in #96

- [ ] Pin integrated main SHA/tree, release profile, toolchain and dependency lockfiles; archive exact
      Worker/Wasm/PWA build digests. No upgrades or regenerated identities hidden in the deployment.
- [ ] Require full CI, strict Workers fixture typecheck, `pnpm local:smoke`, browser user-loop tests,
      `pnpm cf:dry-run` and `pnpm launch:code`. The last command correctly fails today: mandatory code
      remains unavailable. Do not remove that gate to satisfy this checklist.
- [ ] Obtain the reviewed account/hostname/jurisdiction and declared owner/service identities from the
      operator, not from guesses or a fixture. Use the exact `infra/cloudflare/` desired state and
      selected AI Search/Gateway profile. Keep credentials, account-specific generated config and raw
      private observations out of git and PR comments. `ELIOTR_ENVIRONMENT=staging` is only a runtime
      label: it does not isolate fixed-name D1/R2/Queue resources. Require a dedicated approved staging
      account or a separately reviewed isolated resource profile; otherwise stop before provisioning.
- [ ] Set `ELIOTR_ENVIRONMENT=staging` explicitly (the existing live default is production) and an exact
      `ELIOTR_DEPLOYMENT_GENERATION` for the tested build. Validate every required value listed in
      `../cloudflare-runbook.md`. Never print API tokens, JWTs, cookies or provider credentials.
- [ ] Run `pnpm cf:preflight:remote` only after those prerequisites. It is read-only; incompatibility in
      ANY product must stop before any create/update. Review unexpected resources, policy drift and
      ambiguous responses rather than silently adopting them.
- [ ] Use `node scripts/deploy-cloudflare.mjs --confirm-live` after the code gate and target approval.
      Keep generated-config dry-run before remote D1 migrations; preserve digest checks between effects.
      Use one hostname Access contour, no Worker-level Access and no `--keep-vars` override.
- [ ] Read back the actual deployed version, ALL required bindings/IDs/exports, both D1 schema/ledger
      states, assets/Wasm/config digests and selected search/gateway generations. The current bounded
      Worker inventory receipt does NOT prove complete binding/version identity; implement the missing
      attestation reader/test before relying on it.
- [ ] Run authenticated owner and service-class probes against the exact allowed HTTPS origin. Missing
      smoke credentials mean `NOT_EXECUTED`, not a successful login or empty successful result. A valid
      HTTP status, health check, provider acceptance, Queue ACK or Workflow completion is insufficient
      for the product assertions below.

The existing supported CLI performs its own preflight; do not use a hand-edited generated file or a
second release script. When real product probes do not yet have an executable entrypoint, the owning
PR must add one plus negative tests first. No command name in the checklists below implies an existing
runner. Use ER-27's integration directory and gate receipt family instead of parallel harnesses.

## Per-PR Cloudflare work and exact acceptance

### #89 — Library / ingest (ER-14, ER-29, ER-37, ER-44; ER-26/27)

- [ ] Governed staging namespace/admission setup: exact owner tuple and initial policy, explicit separate
      read grant, no owner resurrection/takeover, and no admission privilege from login alone. The local
      `--initialize-namespace` command has no remote mode; implement/review any remote adapter separately.
- [ ] Use a real signed owner session and controlled normalized bundle; record exact input and canonical
      manifest digests. Exercise actual R2 multipart prepare/part/complete, promotion and guarded D1
      admission/readback, followed by authorized Library enumeration and Lens selection.
- [ ] Interrupt acknowledgements at prepare, part, file completion and commit; reconcile the same intent
      without a second source/head/outbox. Reject a different file or policy under that identity. Revoke
      the admission policy between stages and race a policy change with final commit; no source/head/
      outbox may become visible under the stale policy. Reconcile leftover staging through governed
      cleanup, never by deleting an unconfirmed canonical object.
- [ ] Lose the prepare response before retaining its operation ID; rediscover by exact reselected folder
      under the same signed principal, then explicitly continue the original operation. Discovery must
      change no D1/R2 state. Missing/foreign lookups both return 404; changed bytes/metadata, expired
      reservations and policy withdrawal must disclose no recovery key or start a replacement import.
- [ ] Test read-policy withdrawal, owner rotation, expired/foreign cursors and ungranted service tokens.
      Report R2 delivery, canonical admission, Queue delivery and index readiness separately.

- [ ] Verify the owner Library revision endpoint against multiple real admitted revisions. Deny foreign,
      purged, expired and old-owner histories; race head/policy withdrawal with pagination. The existing
      screen declares RECORDED_ONLY: compare its recorded channel generation/receipt with independent
      active D1 Search/AI Search readback. Never infer live indexing or exact evidence from a stored
      `ready` row. The history GET must not create grants, mutate indexes or trigger provider calls.

### #90 — Retrieval and evidence (ER-06/07/16/38/39; ER-24/27)

- [ ] Ingest through #89, execute the real outbox/Queue/projection path and observe the active D1 Search
      generation. Do not seed the index and label that end-to-end ingest coverage.
- [ ] Promote only an exact read-back AI Search generation with the required T2/T3 evidence; query real
      RU/EN/code/table cases. Validate locators and source/section/generation metadata, then resolve
      through canonical D1/R2 bytes and reopen/verify the returned handle.
- [ ] Exercise managed-search outage, stale/forged hits, a partial index and policy/purge changes during
      resolution. Local lexical/exact access must retain its declared degraded behavior; top-k absence
      cannot become corpus completeness or an absence proof. Retain query budgets, bytes and latency.

### #91 — Structural Lens (ER-31/06/07/39; ER-25/27)

- [ ] Materialize structure from admitted coordinate-map bytes under the pinned revision; verify
      SourceCard/DocumentMap/ProjectAtlas identity and source-set accounting on real D1/R2.
- [ ] Browser path: Library -> Atlas -> section -> authorized exact source bytes. Cover missing maps,
      real long/mixed documents, explicit omissions, membership change and source purge; no synthetic
      headings or metadata-only fallback reported as structural qualification.

### #92 — Research / sessions (ER-08/09/10/20/24; ER-27)

- [ ] Start a real bounded investigation; interrupt every Workflow checkpoint, restart and reconcile
      durable D1/R2 state. Verify budget/cancellation before AND after external calls and honest final
      disposition. A paid call with unknown settlement stays unknown until provider evidence resolves it.
- [ ] Exercise actual Durable Object hibernation/WebSocket reconnect, cursor replay, backpressure and
      concurrent observers. Losing transient session/Queue state must not lose the investigation or
      allow a stale attempt to overwrite the current result. Retain exact model/gateway generations.

### #93 — Memory OS federation (ER-22/41/24; ER-27)

- [ ] Pin an independent client's actual contract/manifest/version; exercise all seven public operations
      through mutually authenticated service identities: submit/status/cancel/result, manifest, bounded
      range and changes. No peer canonical writes or reverse agent authority.
- [ ] Cover duplicate/lost ACK, restart, token rotation, cross-principal/scope cursor substitution,
      unsupported peer version and partial output. Transport COMPLETED with internal INCONCLUSIVE must
      remain inconclusive; result bytes/citations/ranges require exact canonical identity on readback.

### #94 — Wiki / reports (ER-11/12/21/24/25; ER-27/28)

- [ ] Research -> draft -> explicit review -> publication -> reopen -> revision with real D1/R2 and
      evidence resolver. Verify immutable body digests, expected-head CAS and exact dependency closure.
- [ ] Unresolved/stale/purged citations block publication; race withdrawal/purge with publication and
      competing head updates. Verify section copy-on-write, changes/trace cursor binding, lost-ACK replay
      and dependent output invalidation. A draft rendered successfully is not a published report.

### #95 — Required ChatGPT Drive Exchange and optional Gemini MCP (ER-18/19/20/36; ER-17/26/27)

- [ ] Implement and locally test the mandatory Drive adapters BEFORE accessing an account. Canonical
      §§12.3–12.12 and ADR-0003 still select Drive for Day-0 ChatGPT. The Gemini MCP flag/helper is not
      a qualified replacement; one active ChatGPT write transport only. Do not equate an interface,
      serializer or self-reported Gemini observation with the complete exchange.
- [ ] Qualify the exact dedicated subject/account, native Sheet/file and numeric tab IDs, exchange
      generation, narrow offline drive.file token lifecycle and approved scopes. Demonstrate one
      atomic REQUESTS/PAYLOAD_PARTS append through the actual ChatGPT action, then exact readback.
      Historical connector observations do not qualify today's account/action. Keep secrets out of git.
- [ ] Verify leased changes replay, exact file-ID filtering, bounded ID-column/range reads, R2 freeze,
      idempotent D1 ContributionIntent and cursor commit only after reconciliation. Reorder/edit/delete
      historical rows, drop notifications and interrupt each ACK; detect tampering without duplicate
      canonical admission. OAuth invalid_grant stops only this transport with REAUTH_REQUIRED.
- [ ] Publish result Doc/RESULTS after the canonical artifact and terminal D1 receipt; read back exact
      metadata/rows. Failure of the delivery copy must leave the canonical artifact available.
- [ ] Qualify optional Gemini MCP separately only when explicitly selected. Use its exact signed service
      identity; no owner impersonation or ungranted catalog reads. v1 receipt checks are bounded,
      self-reported consistency only, not proof of plan issuance, provider state or honored write CAS.
      Read observations bind resource ID/digest/revision and time; unsupported/unbound checks stay
      unverified. Future/expired observations or changed plan descriptors cannot be accepted as a match.
- [ ] Retain real Drive action/readback/freeze/reconciliation and, when applicable, Access/MCP receipts
      separately. Never use a generic `OBSERVED_MATCH` as T4 or canonical admission evidence.

### #96 — Erasure / recovery / operations (ER-28/33/34/35; ER-26/27)

- [ ] Verify every canonical, derived, cache and offsite deletion location; held/blocked backups prevent
      complete erasure. Restore an isolated clean target from a real backup, apply the CURRENT purge
      ledger BEFORE any payload can be served, rebuild indices and prove erased data did not return.
- [ ] Exercise interruption and separate Worker rollback, index-generation rollback and data restore.
      Never roll back purge history with code. Retain observed RPO/RTO, exact target isolation and
      cleanup results; a backup file is not a restore test.
- [ ] Run T5 negatives and normative T6: 5/20/50 read agents, 5 interactive sessions, 10 queued ingest/
      projection jobs, 2 long Workflows. Record p50/p95/p99, contention/conflicts, Queue lag/DLQ,
      index throughput, actual cost and spend-stop/overload behavior. Do not relax thresholds to pass.

### #97 — Promoted Rust kernel (ER-00/01/02/03 and each family; ER-24/27)

Use LANGUAGE_RUNTIME_CONTRACT §10 phases: M5 Wasm + differential shadow, M6 authority promotion,
M7 removal of superseded TypeScript. These are separate acceptance decisions, not renamed milestones.

- [ ] On the complete Worker, verify promoted family/ABI/build identity and exact parity fixtures,
      including initial owner tokens introduced by #89. No permanent second TS decision authority.
- [ ] Measure real startup, compressed Worker (<=4 MiB), first-party heap target (<=32 MiB), PWA initial
      JS (<=600 KiB gzip) and startup (<=400 ms), plus operation p50/p95 CPU against the retained TS
      baseline. These are repository launch targets, not claims about vendor plan limits.
- [ ] Exercise per-family rollback with current schemas/purge/ownership and complete product loops.
      Local parity alone cannot supply the real deployment observation or performance receipt.

## Receipt and stop contract

Each owning PR must retain: exact code/build/config and data generations; test ID and input digest;
observed vs expected result; timestamps; redacted immutable receipt reference/digest; bounds/cost;
cleanup state and rollback target. Store sensitive observations only in the approved private evidence
location, with a non-secret reference in the PR. No raw JWT, source text, prompts, email addresses or
keys in CI output. A digest alone does not prove an unobserved effect.

Use `tests/integration/gate-state.ts` as the shared state family (`NOT_EXECUTED`, `RUNNING`, `PASS`,
`FAIL`, `BLOCKED`). Its current minimum PASS predicate is not a complete identity/freshness verifier;
add the missing validators/tests before producing release evidence. Absence of credentials is
NOT_EXECUTED; a policy/code prerequisite is BLOCKED; a performed failed test is FAIL. An uncertain
write/call remains unresolved, and no automatic retry with a new intent is authorized. Stop on drift,
secret exposure, incomplete erasure, exceeded budget or ambiguous canonical state. Cleanup must name
only the disposable resources owned by this trial; never delete by broad prefix/account discovery.

Update the relevant PR checklist with observed evidence and remaining failures. Do not mark a topic
complete merely because this handoff exists. #96 consolidates the release evidence only after all
required topic code and real gates are independently satisfied.
