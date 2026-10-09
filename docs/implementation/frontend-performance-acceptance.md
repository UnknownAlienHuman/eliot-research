# Owner-web performance acceptance

**Owner:** ER-47 with ER-00 delegation for root budgets/CI
**Status:** measurement contract; no benchmark executed by the documentation PR
**Applies to:** React owner workspace, `@eliotr/ui`, owner client/query adapters and the canonical Vite build

The goal is not a synthetic Lighthouse score. The goal is to keep question entry, source selection, report
reading and evidence inspection responsive while preserving exact state and bounded resource behavior.

Numbers that have not been measured in the exact repository environment are not presented as established
baselines. U1 creates the first accepted measurement receipt. Existing release authority remains:

```text
initial owner-web JavaScript <= 600 KiB gzip
```

Any tighter bundle, render or interaction threshold becomes normative only after U1 records the exact device,
browser, fixture and build tuple.

## 1. Measurement principles

1. Measure the production candidate build, not only Storybook/dev mode.
2. Pin browser revision, OS/container image, CPU/network shaping, viewport, locale, font and fixture.
3. Run multiple repetitions and retain median plus spread; do not report the best run.
4. Separate network/backend time, JavaScript/main-thread work, React render/commit and paint/layout.
5. Compare identical scenario and data shape before/after.
6. Record absent/unsupported metrics as `NOT_MEASURED`, never zero.
7. A profiler changes timing. Use a special profiling build for React attribution and an ordinary production
   build for user-facing timings.
8. Performance traces contain opaque fixture identities only—no source text, prompt, evidence excerpt,
   credential or provider payload.

## 2. Reference scenarios

The active slice runs only applicable scenarios, but U6 runs the full set:

| ID | Scenario | Load-bearing behavior |
|---|---|---|
| P1 | cold owner shell | route, tokens, fonts, navigation, no feature data |
| P2 | 100-source project | selection, filtering, pagination, pane scrolling |
| P3 | measured large-source case | determine whether pagination remains enough or virtualization is justified |
| P4 | question typing while progress streams | input responsiveness and update batching |
| P5 | 40-section report | first useful section without eager reading/rendering of the rest |
| P6 | long report + citation/evidence | claim highlight, Context open, long excerpt/table/code scroll |
| P7 | pane resize/collapse | geometry update without network/storage effects or content re-render storm |
| P8 | light/dark/high-contrast change | token swap without layout instability or protected-data refetch |
| P9 | logout/revoke/generation change | fast mask/clear with no old-data flash |
| P10 | Back/Forward bfcache attempt | protected state remains hidden until fresh verification |

Fixtures state exact counts, string lengths and section/source identities. “Large” without numbers is not a
reproducible benchmark.

## 3. Build and transfer budgets

The Vite receipt records:

```text
initial eager JavaScript raw/brotli/gzip
route and shared chunks
CSS raw/brotli/gzip
font files and preload behavior
icons/images
source maps excluded from user transfer
Worker bundle/modules separately
```

Rules:

- Existing 600 KiB gzip initial-JS ceiling is hard; U1 also proposes a lower target after the first exact
  candidate measurement.
- Storybook, Playwright, MCP adapters, React profiling build and fixture generators are absent from production.
- Studio editor, Agents SDK, chart/graph and code-highlighting dependencies are lazy and absent from first
  load unless the first route actually requires them.
- A dependency is rejected when its measured value is lower than the product value it duplicates.
- A source-file move or chunk renaming is not a size improvement.
- The receipt distinguishes eagerly reachable code from lazy chunks and browser cache reuse.
- Font subset/license/fallback metrics are recorded; no external font request.

## 4. Loading and layout stability

On production-like staging, measure Core Web Vitals as directional user targets:

```text
LCP good threshold: <= 2.5 s
INP good threshold: <= 200 ms
CLS good threshold: <= 0.1
```

These field thresholds do not turn one lab run into population evidence. Lab acceptance additionally records:

- time to visible shell;
- time to first actionable question/source control;
- route-code and data-request waterfalls;
- layout shifts caused by fonts, panes, loading states and evidence opening;
- long tasks / long animation frames at or above the platform’s 50 ms observation threshold.

Skeletons reserve stable geometry. Status text, streaming progress and evidence details do not move permanent
navigation or headers. Loading must not fabricate content merely to improve a paint metric.

References:

- <https://web.dev/articles/defining-core-web-vitals-thresholds>
- <https://developer.chrome.com/docs/web-platform/long-animation-frames>

## 5. React render and commit acceptance

Use React DevTools/Performance tracks for interactive diagnosis and a bounded `<Profiler>` build for
repeatable attribution. Record `actualDuration`, `baseDuration`, commit count and triggering interaction for
named subtrees only:

```text
AppShell
SourcesPane
ResearchComposer
PublicExecutionTimeline
ResearchReport
EvidenceInspector
```

Do not wrap every primitive permanently. Profiling adds overhead and is a measurement build only.

Failure patterns:

- typing one character commits unrelated Sources/Studio/Connections trees;
- one progress event re-renders all report sections or evidence content;
- selecting one source reconstructs navigation and shell geometry;
- opening one citation reparses the whole report/Markdown;
- pane resize writes server/query state or rerenders document/report bodies each pointer event;
- theme change triggers network requests or protected-state reauthorization;
- memoization is added blindly instead of correcting unstable ownership/props.

Optimization follows a trace. Do not add `memo`, `useMemo`, `useCallback`, global stores or worker threads
without a reproduced cost and a retained before/after scenario.

Reference: <https://react.dev/reference/react/Profiler>

## 6. Streaming and progress updates

The UI renders public execution state, not raw token-by-token hidden reasoning.

- Parse/validate stream or event input once at the client boundary.
- Coalesce high-frequency display updates to an animation-frame or measured bounded interval.
- Preserve every canonical server stage/receipt; coalescing presentation must not drop authority state.
- Keep question input, navigation and Stop/Recover controls responsive while updates arrive.
- Do not append unbounded DOM nodes or retain every transient token/progress frame.
- Large report sections arrive/read by exact section identity; first section can display before the rest.
- A stream disconnect remains explicit and recoverable; UI smoothness never invents completion.

P4 acceptance records event input rate, visible update rate, React commits, long frames and typing interaction
latency. The chosen batching interval is derived from the result, not copied from a generic chat tutorial.

## 7. Sources and virtualization

Default sequence:

1. bounded server pagination;
2. ordinary semantic list markup;
3. measure P2/P3;
4. introduce virtualization only if ordinary rendering fails the accepted baseline.

Virtualization is not an automatic optimization. If introduced, verify keyboard navigation, focus, selection,
`aria-posinset`/`aria-setsize`, screen-reader traversal, item height changes, restoration, filtering and
reduced-motion behavior. The virtualizer is lazy and wrapped by a product pattern.

The list never loads the whole authorized corpus merely to make client filtering fast.

## 8. Report, Markdown and evidence

- A 40-section report initially materializes only report metadata and the first useful section.
- Closed sections do not parse/render their full Markdown bodies.
- One exact section/citation read is in flight per identity; viewport and click cannot duplicate it.
- Markdown parsing cost is attributed separately from React rendering.
- Opening evidence does not reparse unchanged report sections.
- Long tables/code use named local horizontal scroll, not a whole-page width expansion.
- Full export verifies all sections/citations through bounded client/server operations; it is not optimized by
  skipping invisible sections.

P5/P6 receipts include network read count, bytes, parsed section count, DOM-node count, React commits, long
frames and memory snapshots before/after close/navigation.

## 9. Pane geometry and motion

- Resize applies only geometry state and is coalesced to rendering cadence.
- Persistent pane preference writes at drag end or another bounded settled point, never each pointer event.
- Resize performs no owner API request, Query invalidation or source/report parsing.
- Hidden/collapsed panes stop expensive visual work but do not silently change project/source scope.
- No spring/overshoot on resize; reduced-motion removes nonessential transitions.
- A third-party pane implementation is rejected when it needs broad CSP weakening or produces unstable main-
  thread work under P6/P7.

## 10. Memory and lifecycle

The browser matrix measures heap/DOM growth across repeated:

```text
open report → citation → close → switch project → logout → sign in/reload
```

After bounded settling/GC observation where supported:

- old report/evidence Query entries are removed on authority/lifecycle changes;
- aborted readers/listeners/observers/realtime clients are released;
- DOM/node/listener counts do not grow monotonically per cycle;
- pagehide/bfcache handling leaves no protected React/Query view available before revalidation;
- object URLs/workers/timers are disposed by owner components.

A memory snapshot is diagnostic evidence, not a universal browser guarantee. Reproduced monotonic growth is a
blocker even when the final heap number is below an arbitrary ceiling.

## 11. Regression policy

U1 establishes checked-in `performance-baseline.json` and scenario receipts after the exact tuple is pinned.
Each metric has:

```text
absolute product/release limit when one exists
accepted baseline and variance
allowed regression band
owner/reason for changes
measurement environment
```

Rules:

- hard release limits cannot be waived by a faster unrelated metric;
- a regression outside the band blocks unless the same PR contains reviewed evidence and an explicit new
  baseline;
- no aggregate score allows bundle bloat to compensate for input lag or vice versa;
- flaky/noisy metrics are diagnostic until their variance is controlled;
- failed measurement is `NOT_MEASURED`, not PASS;
- baseline auto-update is prohibited.

## 12. Evidence artifacts

Per applicable scenario retain:

- exact commit/lock/build/output-config digest;
- dependency/browser/reference-environment tuple;
- bundle manifest and compressed measures;
- Playwright/browser trace;
- React profiling receipt where used;
- long-task/animation-frame and layout-shift observations;
- scenario data/counts;
- console/network/CSP failures;
- before/after comparison and variance;
- privacy redaction statement;
- unsupported/deferred gates.

## 13. U1/U6 exits

### U1

- exact stack builds and profiles in the safe local/test environment;
- initial JS/CSS/font values measured;
- P1/P2/P4/P7 fixture scenarios produce repeatable receipts;
- no per-progress-event whole-app render storm;
- no pane-resize server/query effects;
- first baseline/variance file reviewed;
- thresholds not yet measured remain explicit.

### U6

- all P1–P10 applicable scenarios run on the exact attested build;
- existing 600 KiB initial-JS gate and established scenario bands pass;
- production-like Core Web Vitals and browser traces are retained without claims of field population data;
- 40-section lazy report and citation/evidence remain responsive;
- lifecycle/bfcache/revoke clearing shows no protected-data flash;
- no reproduced monotonic leak;
- strongest safe Preview/staging layer is identified for every result.

## 14. Non-goals

- No “100 Lighthouse” requirement.
- No premature virtualizer, web worker, memoization or global state library.
- No generic benchmark disconnected from Eliot flows.
- No production profiling instrumentation shipped permanently.
- No hidden reduction of verification, evidence or accessibility work to improve numbers.
- No invented speedup or field percentile from local traces.

## Continuous owner authorization amendment — 2026-10-09

The owner has explicitly authorized one manager to execute F1-F4 continuously through U5-X. U1-R live
NotebookLM study is mandatory. U1-D and U2-X are internal quality gates, not owner stop points. Any earlier
sentence requiring owner approval at U1-D or an owner walkthrough at U2-X is superseded. The first required UI
review is the finished integrated interface after U5-X. Final merge, deployment, account mutation, cutover and
legacy removal remain separately authorized.
