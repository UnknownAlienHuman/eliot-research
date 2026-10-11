# S90: actual local Research startup observation, 2026-10-11

Source `264d7cf083cb73a72caa4e4e6d46795b4d7bafd5`. This is a bounded
diagnostic observation; PR #282 and full S90 acceptance remain open.

One actual run at 08:44:34.564–08:44:39.579 UTC used the newly produced
integrated Worker and its matching static assets. The controller process
PID75764 exited0 with no signal or timeout. No previous build, upload or
native routing suite was replayed.

The profile used freshly migrated local Core/Search databases, an ephemeral
locally signed Access JWT verified through the real loopback JWKS path, and
denied non-JWKS Worker egress. It seeded no project, model configuration,
Research run or Workflow, and fulfilled no synthetic owner HTTP response.
Browser interception continued real same-origin GET requests with the local
Access header; that interception disabled HTTP cache. Chromium used a fresh
context. No service-worker controller or registration was observed.

The acceptance boundary required the visible, noninert Research interface,
hidden privacy guard, settled genuine empty history, blocked configuration,
and completed successful real GETs for:

- `/api/v1/system/health`
- `/api/v1/system/session`
- `/api/v1/research/projects`
- `/api/v1/system/research-configuration`
- `/api/v1/research/runs`

All five returned200. The run table remained empty. All11 captured requests
finished before the boundary; browser page/console and observer error counts
were zero. Every observed static response matched its produced artifact bytes.

Two distinct JS resources loaded before that boundary:

- `assets/index-CfkGSTQZ.js`:3780 raw bytes.
- `assets/bootstrap-h50wEz-f.js`:799550 raw bytes.

Their deduplicated total is803330 raw bytes and **223550 bytes gzip level9**,
using the published web-budget compression recipe. This selected membership
is below the existing600KiB ceiling. Observer default-compression diagnostics
and encoded wire bodies are separate measurements. CSS is separate.
`assets/client-DD1Jkd23.js` was not observed; this does not classify it as
permanently lazy or prove a complete future-load graph.

The current three Worker modules are byte-identical to the retained053 payload;
root readback confirmed its original upload-order raw7972541/gzip1580051 metric
without a new upload. Runtime module order is separately entry-first.

The independent original harness review found an API-envelope bug. Its report
remains REJECTED; root preserved the original source and fixed the exact
`data` read plus strict response-role handling. The corrected execution was
root-admitted. A separate independent R2/result approval is **not claimed**:
the existing Step agent became unavailable before finishing its delta review.

Actual observation SHA256:
`4abe83be2e856dba5d90f324f4472d432bb8857b2319e7883878e926d330d183`.

Context, browser and runtime disposal were awaited; descendant process absence
was not independently proven. This profile does not accept configured research,
providers, scientific work, module-evaluation/initiator edges, every route,
Worker execution coverage, live deployment or release. The three budget
consumers still require coherent startup-membership integration; the static
closure alone demonstrably omits the loaded bootstrap resource. Goal ACTIVE.
