# Recheck: review bundle and integration contracts

**Date:** 2026-10-23. **PR baseline:** `742d0ec8e46fbce813e1400cb31ac41c31b14586`.
**Legacy baseline:** `7c034569b908d3b03a8b821b7c537477a24b10f7`.
This is evidence for corrections in the four canonical documents, not a new specification or runtime acceptance.

## The unpublished bundle is withdrawn as an apply mechanism

The supplied `eliot-full-review-pass.zip` has SHA-256
`09fc5930d7fe950522e3997fecfd9cd884e73149b6671e6caf52dfe3564c63c0`, matching its advertised bytes.
Its claim to apply to `742d0ec` does not hold. Invoking its transformation functions without writing, against exact
Git-blob-verified baseline documents, produced these failures:

| Script / transformation | Reproduced error |
|---|---|
| `apply_sdk_access_docs.py` / Architecture | `anti-bloat: expected one anchor, found 0` |
| `apply_sdk_access_docs.py` / Map | `stage 2: expected one anchor, found 0` |
| `apply_full_review_docs.py` / Implementation | `cutover inventory: expected one anchor, found 0` |
| `apply_full_review_docs.py` / Map | `stage 1: expected one anchor, found 0` |

The scripts contain stale pre-extraction-review anchors. Python syntax validity did not establish applicability.
The SDK script declares a baseline but does not check repository/head/clean state. The full script executes the first
writing stage before validating the second; a later failure could leave partial changes. The ZIP also includes Python
bytecode caches. None of these scripts was applied to the remote branch. Corrections are normal tracked Markdown edits;
do not ship another replacement script or treat the old proposed register as published evidence.

GitHub write access was verified in this session by an unattached `create_blob` operation; permissions reported push/admin.
A prior session's restricted tool exposure must not be generalized into a permanent repository limitation.

## Corrected findings

### SDK evidence and type generation

The reviewed release/tag set is a **candidate**, not an installed compatible application. The existing lockfile belongs
to the legacy workspace. No new dependency install, generated replacement declarations or TypeScript build was performed.
The [current TypeScript guide](https://developers.cloudflare.com/workers/languages/typescript/) explicitly says
`wrangler types --check` compares recorded configuration/runtime headers, not the generated declaration body.
Implementation now requires generation, inspection and compilation, without upgrading the donor workspace merely to
make its version numbers match prose. `agents/models/ai-sdk` remains a version-sensitive experimental surface.

### Access topology: retain one real boundary

The [Workers Access documentation](https://developers.cloudflare.com/workers/configuration/cloudflare-access/) says
Worker-level Access rejects WebSocket upgrades, while hostname-based applications are the alternative. It also says the
Static Assets router does not forward `ctx.access` to the user Worker. The selected two-host/same-Worker topology therefore
keeps cached-JWKS assertion validation at ingress, distinct audiences and browser Origin checks. It does not add internal
signatures or a custom issuer. Actual domains, policies, client identities and deployment behavior remain unverified.

### MCP transport is not tool readiness

The [client API](https://developers.cloudflare.com/agents/model-context-protocol/apis/client-api/) separates registration,
transport connection and capability discovery. Manager-level setup needs `discoverIfConnected` and a checked `ready`
state before tools are exposed. `waitForConnections` waits across the manager; returning from it is not proof that a
selected server succeeded. No-tool chat must not wait for unrelated reconnects.
The prior bundle's blanket rejection of legacy wire requests was not backed by required-client handshakes. Keep the SDK's
stateless compatibility where real clients need it, without restoring old product machinery or a custom protocol layer.

### Context and persistence are different operations

At [AI SDK `ai@7.0.150`](https://github.com/vercel/ai/blob/ai@7.0.150/packages/ai/src/generate-text/prune-messages.ts),
`pruneMessages` removes reasoning/tool/message parts. It has no token-limit parameter or tokenizer. The old phrase
“token-aware pruneMessages” was misleading; actual rendered-budget enforcement follows structural pruning.
The [chat lifecycle](https://developers.cloudflare.com/agents/communication-channels/chat/chat-agents/) places
`onChatResponse` after persistence and makes the custom persistence sanitizer synchronous after built-in sanitation.
Large-body retention therefore needs an awaited host collection path before reduced message persistence, not an assumed
async hook. This path still needs implementation evidence. A React continuation setting is not a server authorization
or spending boundary; every paid dispatch must check the server-owned attempt allowance.

### Useful research outputs were under-specified

The legacy [research contract](https://github.com/UnknownAlienHuman/eliot-research/blob/7c034569b908d3b03a8b821b7c537477a24b10f7/packages/contracts/src/research.ts)
names hypothesis review, fact checking and project-versus-literature audit. Its
[earlier disposition](https://github.com/UnknownAlienHuman/eliot-research/blob/7c034569b908d3b03a8b821b7c537477a24b10f7/.github/audits/2026-10-08/FINAL-PR-DISPOSITION-MATRIX.md)
keeps these as profiles, not standalone engines. The replacement's maintenance-only `run_audit` did not make their
required output explicit. They are restored as profiles of shared research; targeted section revision uses the ordinary
page writer and preserves unrelated sections. This preserves product intent, not a claim that a legacy enum was working code.

### Assembled table items need exact segment mapping

The prior design combined a single canonical range with repeated-header/column projections. Such an assembled item may
not be contiguous in source bytes. This is a design inconsistency, not an observed deployed failure. The block map now
requires exact copied-segment mappings for assembled items; synthetic separators cannot mint source offsets. Contiguous
row groups remain preferred, and unindexable oversized cells/fences remain readable with declared partial coverage.
Freshness also now has a single representation: a revision default plus resolved mode on each `page_input` dependency.

### Migration must preserve restrictions and classify real storage

The inspected legacy [ResearchSession](https://github.com/UnknownAlienHuman/eliot-research/blob/7c034569b908d3b03a8b821b7c537477a24b10f7/apps/eliotr-core/src/research-session.ts)
extends `Agent` and projects Workflow/D1 status; it is not the target `AIChatAgent` transcript. Import cannot assume that
new chat inventory/APIs exist in old storage. Classify each actual source cohort and extract retained history.
Retiring grant/proof tables must preserve effective permissions, revocations and unresolved external effects. Unknown
actors do not become owners. A reserved same-checksum target import can resume after interruption; unrelated nonempty
state conflicts. Historical approvals cannot execute on import. Filename `0168` is a chain endpoint, not a file count.
No live rows, objects, chat inventory or writer state were queried; no migration or deletion occurred.

### UI reads must remain reads

The legacy [ProjectOverview effect](https://github.com/UnknownAlienHuman/eliot-research/blob/7c034569b908d3b03a8b821b7c537477a24b10f7/apps/eliotr-web/src/app/ProjectOverview.tsx)
calls [ensureProjectGuideOnOpen](https://github.com/UnknownAlienHuman/eliot-research/blob/7c034569b908d3b03a8b821b7c537477a24b10f7/apps/eliotr-web/src/query/projectGuide.ts),
which invokes `api.ensure` when the guide is missing. That confirms admission is reachable on navigation; it does not
measure an actual provider bill. The target now explicitly separates read-only project open from guide generation,
keeps URL/project identity and three scope modes, loads catalogues lazily and persists drafts on the server. Remaining
UI journeys, accessibility and two-tab behavior have not been executed.

## Verification boundary

Six existing local document snapshots were verified against their exact upstream Git blob IDs before editing:

| File | Baseline blob |
|---|---|
| Architecture | `c5cf8f9f682f0246273916a45004c784e12cc2ba` |
| Implementation | `cc18f1a975db6142ba2c0bdaf0b07589547f3602` |
| Map | `74b5c25616ae57eaf346c4841a8b47e9bcc2819a` |
| Donors | `baa307f284701113e28267efcc9639bfbf85331f` |
| Review register | `e8416190f68c879d42cc959844ea66a8d95c2649` |
| Audit index | `9a540b21682553760eefbe8af4d45e8033783045` |

The local snapshot is a bounded documentation checkout, not a full cloned application. This pass rechecked all four
canonical documents and the supplied bundle, with selected legacy and upstream paths. It did not reread every source
file or donor repository, install/build the replacement, run product tests, deploy, call a model, query production data,
rehearse migration or establish performance/quality. The existing extraction/OCR/citation requirements are retained.
Remaining work is tracked honestly in the single [review register](../REVIEW-REGISTER.md).
