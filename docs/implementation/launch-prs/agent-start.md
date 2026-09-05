# Local agent dispatch after the Launch 01 checkpoint

The owner requested merging the tested #89 checkpoint; it landed as `5d7ea2a`. This does not complete
Launch 01. Its unchecked L2/L4/L6 work is retained in **#98**. Code completion and remote qualification
remain distinct. Start from current main, not the old planning baseline `92118fa`.

## Start now: at most three independent local agents

These are eligible, **unclaimed** tasks, not running agents. Before writing, each agent posts its one
checkpoint, current base SHA and exact owned-path claim in the existing PR. Resolve overlapping claims
before coding. One task/worktree/branch per agent; reuse each existing theme branch after incorporating
current main. Do not create a competing variant branch or force-reset someone else's work.

| Existing PR | First bounded task | Scope and integration boundary |
|---|---|---|
| **#90 Retrieval** | Audit existing locator decoding, then implement one missing local D1 exact/lexical lane with its actual projection input and negative tests. | ER-06/07/16/39. Inspect `packages/retrieval/src/lanes.ts`, `packages/cloudflare-ai/src/ai-search-managed-read.ts`, `packages/platform-cloudflare/src/ai-search.ts`, existing projection delivery and evidence ports. No PWA/import edits in parallel with #98; shared Worker composition and migrations require the integrator. |
| **#95 Google** | G1: verify the currently selected transport and its bounded experiment contract. Then one missing adapter/reconciliation checkpoint within that selected path, with recorded failure tests. | ER-18/19/20/36. `GOOGLE_EXTERNAL_TRANSPORT=gemini-mcp` is the current profile, not permission to activate a second Drive/OAuth pipeline. Do not independently implement an unused alternative just because `cursor.ts`/`reconciler.ts` are only interfaces. Document the supported active path and expiry before its next change. No source grants, owner impersonation or remote account calls. |
| **#97 Rust** | Audit/reuse existing M2 shadow primitives and add parity for one uncovered identity family, starting with the new ER-44 initial namespace-owner token. | ER-00/01/02/03/44. Existing code is in `crates/eliotr-canonical/src/{canonical_json,sha256,generation,stable_id,residency_key}.rs` and `crates/eliotr-test-vectors`. Do not rewrite these or promote a family before real TS/native/Wasm differential acceptance. Shared runtime/ABI integration belongs to ER-24. |

If a candidate task needs a shared file already claimed elsewhere, narrow it to independent tests or
wait for the integrator; do not invent a parallel implementation to avoid the collision. The integrator
serializes exports, package manifests/lockfiles, schemas, migrations, composition, CI and status records.
The integrator must run the combined main regressions after merges, not infer compatibility from three
independently green branches.

### #90 first-task acceptance

Reuse the existing strict managed locator decoders and negatives before deciding anything is missing.
Prove one admitted normalized source reaches the existing outbox/projection path and yields a bounded,
parameterized local D1 lane result. With local cron absent and remote AI disabled, explicitly invoke the
existing dispatcher/executor; never seed the final index and call that import-to-query coverage.
Reject stale generation/out-of-scope/purged candidates. Distinguish unavailable index, incomplete index
and a valid empty result. Locator previews are not exact evidence and no top-k result proves absence.
The full #90 result/trace/HTTP/evidence-viewer checkpoints follow sequentially after this boundary.

### #95 first-task acceptance

Read the active profile and ER-36/18/19/20 contracts, including experiment expiry. Verify current official
provider API/CLI behavior when it affects code; record exact versions and scope. Choose one active
transport; an expired experiment or a missing authority adapter is an explicit block, not permission to
fall back to a second service. The first implementation must consume only frozen candidate observations
and reject identity/hash/generation drift, lost acknowledgement and historical tampering as applicable.
`eliotr_catalog` is intentionally withheld until service-scoped read grants and post-read currentness
are implemented: never label a service principal `owner_pwa` to make the old path work. Coordinate its
Worker wiring with ER-24 rather than editing the same composition root as #90.

### #97 existing code is not full M2 completion

The current canonical-body implementation accepts null/bool/string/array/object and **safe integers**;
floats and exponent syntax are outside that family. Its UTF-16 object-key ordering, limits and typed
failures already have fixtures. Existing SHA-256/stable-ID/residency helpers also have shadow vectors.
First determine each product family's admitted inputs and exact authoritative bytes. Do not broaden the
Rust parser or change identities to conceal a mismatch. In particular, use the ER-44 namespace-owner
preimage specification and actual initializer/reference function, not two copied golden implementations.

Add current valid/invalid and max+1 vectors, including Unicode/prototype-shaped keys where that family
allows them, and run identical inputs through TS/native/Wasm. Keep unsupported product families and
M3–M7 promotion open. No promoted runtime authority, competing TS cache or ABI change merely because
one helper passes parity. Run every pinned Rust gate, applicable deep checks and the existing Worker gates.

## Subsequent dependency waves

- **#98 Library remainder:** known-ID reload recovery and read-only exact-folder discovery are implemented.
  Remaining work is revision/readiness/project views, failure UI and the complete clean browser/storage loop.
  Claim one of these before handing it to another UI agent. Do not reopen #89 as a competing queue.
- **#91 structural Lens** follows #90 exact opening. **#92 governed research** follows #90; #91 is needed
  only for protocols actually using structural navigation. They must not independently change shared UI.
- **#93 federation** and **#94 publication/Wiki** consume #90 and #92. Pin an independent peer contract
  client for federation; exact citation/current-authority publication tests are mandatory for Wiki.
- **#96 recovery/release:** bounded local receipt/backup-format/probe work may be claimed separately,
  but final erase/restore/rollback/dependency closure consumes #89–#95, #98 and promoted #97 families.
  Do not add this as a fourth concurrent shared-runtime task by default.

## Before reporting a checkpoint complete

Read `AGENTS.md`, the current owning packet, `implementation-status.json`, `gap-register.md`, the theme
plan and adjacent contracts. Run frozen install, `pnpm check:affected`, strict Workers fixture typecheck,
local Linux/Windows smoke, applicable browser tests, PWA/Worker builds and exact-head CI. Never replace
missing functionality with disabled controls or mock success and mark the theme complete. Retain open
follow-ups explicitly. Test-only code receives no production authority and no live qualification label.

**Cloudflare execution is NOT enabled by this dispatch.** All mandatory code, combined user loops,
Rust promotion, target approval, isolation and the existing launch gate must pass first. Agents can
implement probe runners and missing-input/failure handling locally. Account-only actions and exact
receipt requirements remain in [cloudflare-handoff.md](cloudflare-handoff.md). No raw Wrangler bypass,
partial development deployment, paid provider retries without authority, or secrets in PR comments.
