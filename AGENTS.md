# Eliot Research implementation rules

Start at [docs/START-HERE.md](docs/START-HERE.md), then the bounded task in
[backend-entrypoints.md](docs/implementation/backend-entrypoints.md). Read the contracts and nested
instructions for the files you actually change.

## Current decisions

- [ADR-0019](docs/adr/0019-compact-refactoring.md): compact refactoring and current agent procedure.
- [ADR-0018](docs/adr/0018-owner-single-function-first-profile.md): selected `OWNER_SINGLE` service profile.
- [ADR-0016](docs/adr/0016-react-cloudflare-owner-ui.md) and
  [ADR-0017](docs/adr/0017-owner-web-browser-runtime-and-tooling.md): React/Vite and browser cutover.
- [ELIOT_RESEARCH.md](docs/architecture/ELIOT_RESEARCH.md): product/evidence contracts, with the applicability
  table at its start.
- [LANGUAGE_RUNTIME_CONTRACT.md](docs/architecture/LANGUAGE_RUNTIME_CONTRACT.md): language and ABI ownership.
- [Owner decision #377](https://github.com/UnknownAlienHuman/eliot-research/issues/377): the 44 former draft
  PRs are archived requirements, not the current queue. S52 custom search-index/generation/target/promotion
  machinery is canceled. Rust ports and historical audit programs do not block the owner product.

Current owner instructions and accepted profile decisions supersede contradictory older packet, runbook
and audit prose. Resolve the affected contract; continue independent work. Do not revive an archived
program because an old document calls it mandatory.

## Product and state boundaries

1. One deployable Worker (`apps/eliotr-core`) plus static React owner-web assets. Packages are libraries.
   Astro/PWA is served compatibility until the documented cutover, never a new product direction.
2. D1 Core and R2 hold canonical records/bytes. Search services and existing D1 Search are projections.
   Use Cloudflare AI Search or provider search; do not create another index or generation registry.
3. Owner lists and draft display use bounded summary/content reads under the ingress owner context.
   They do not reopen evidence or repeat per-item grants. Exact evidence verification happens when a
   citation is opened. Optional external-client profiles keep their own boundary.
4. EvidenceHandles resolve against an admitted exact revision, representation and digest, with applicable
   source/project/purge checks. A provider locator or model quote is not an EvidenceHandle.
5. One mutable owner per source namespace. Preserve `source.owner-cutover.v1` and residency/retention
   distinctions; equal bytes alone do not merge distinct storage lifecycles.
6. No model, HTTP or R2 calls inside D1 transactions. Use existing mutation/outbox/attempt records and
   atomic expected-state checks. Queue delivers work; it does not own the result.
7. Mutations and paid work retain idempotency, cancellation and spend bounds. Lost ACK reconciles the
   original attempt; it never implies permission to repeat an effect or mint a new identity.
8. Validate local request/claim/cardinality/byte limits before paid or storage effects. An unavailable read
   is unknown, not absence or a matching digest.
9. Strict/versioned decoding remains for mutations and evidence. Owner read views tolerate additive fields
   while validating known fields. No extra `CompletionDisposition`; transport and inquiry outcomes differ.
10. Worker hosts no native binaries, child processes, local filesystem, embedded indexes, OCR/PDF engines,
    large provider SDK collections, LangChain/LlamaIndex, Prisma or second agent framework.
11. External tools/models supply candidates through existing admission/task interfaces. Do not reproduce
    Eliot Memory OS or Eliot Swarm Controller here. Google Drive Exchange stays unselected under
    `gemini-mcp`; backup/export/restore execution is deferred, not an excuse to discard retention data.

## Language and dependency ownership

TypeScript owns Cloudflare routing/bindings, I/O, Workflows, browser composition and deployment integration.
Rust owns promoted pure canonicalization, identity, invariant and disposition decisions. Pure Rust receives
explicit bytes/state and has no clock/randomness/network/filesystem/env/Cloudflare effects. SQL owns schema,
constraints and atomic state changes. Do not move transactional concurrency protection into a non-atomic
preflight.

TypeScript uses a versioned byte ABI for promoted Rust operations and cannot strengthen their result.
Until promotion, the existing TS decision remains active. Promote one operation with its Worker caller,
then remove the old decision after assembled parity acceptance. Do not scaffold 17 crates, port every
family before the first runtime call, or maintain permanent TS/Rust/SQL duplicate decision engines.

Dependencies follow responsibilities: contracts and pure decisions below application services; platform
adapters implement their ports; Worker composes; owner-api-client supplies transport/decoders; React
consumes that client and UI components; UI has no network or backend authority. Keep imports and manifests
consistent when moving code. Do not split a capability or move tests to satisfy source-size counters.

## Owner web

Use the existing React/Vite app, `@eliotr/ui`, Query/Router integration and one `owner-api-client`.
No second cache, router, client decoder or design system. Read the
[Material UI playbook](docs/agent-work/frontend-material-agent-playbook.md) for rendered UI work and
the [execution map](docs/agent-work/frontend-owner-execution-map.md) for the relevant feature behavior.

- Strict same-origin owner API; no Cloudflare binding or credential in the browser.
- Preserve the same owner's draft/read cache across deployment changes under ADR-0018. Clear private
  data on sign-out or principal change. Retry reads; never blindly auto-retry mutations.
- Source/model output is untrusted. Keep native semantics and the existing rendering/CSP boundaries.
- Progress/reconnect reads the same run. A transport event cannot create a run or invent completion.
- React registers no service worker. Cutover includes the integrated Vite/Worker artifact, standalone
  inbox recovery, permanent inert `/sw.js`, old-tab recovery and retirement-safe rollback (ADR-0017).
- U1-D/U2-X are internal quality reviews; no repeated owner continuation prompts. The owner reviews the
  complete integrated UI before its final implementation merge/deploy/cutover.
- Normal development uses isolated bindings. A local build or fixture is not production acceptance.

## How agents work

One manager, one checkout/worktree. Each leaf gets one bounded result and exact files; parallel leaves
have disjoint files. The manager serializes manifests, barrels, routes, migrations and other shared files.
Leaves create no branches/worktrees or replacement frameworks. Use current main as the baseline and
preserve concurrent changes.

Existing ER packets locate code/contracts. They are not permanent path locks over a newly authorized
refactor. No new JSON claims, claim-only commits, ancestry validation or ER-49 acceptance is required.
Old claims/checker remain optional historical audit; the existing product CI is separate.

Implement the selected function first. During this code phase run scoped TypeScript compilation/ESLint;
for Rust, scoped compilation and minimal Clippy; for SQL, the existing affected schema/query depth check.
Tests and broad/native/browser/live acceptance follow assembled functionality. Do not add or run a test
campaign as a prerequisite to coding. Do not mark skipped checks PASS or treat compilation as live proof.

Record the result, relevant checks and remaining acceptance in the PR. Update implementation status when
runtime behavior/state changes; a docs-only refactor does not promote a sentinel. One unresolved case
blocks that case, not every independent task. Reuse accepted unchanged evidence.

Publish without rewriting shared history; refresh main before committing the PR result. The branch
[discipline](docs/implementation/branch-discipline.md) governs integration and cleanup. Count/age/closed PR
alone never authorizes deleting a branch or worktree. No deployment or data deletion follows from a
documentation change.
