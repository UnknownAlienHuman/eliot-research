# Research execution and retirement

Updated 2026-10-17. [Current architecture](../architecture/ELIOT_RESEARCH.md) and
[implementation plan](backend-entrypoints.md) govern new work. This replaces the old checkpoint diary;
it does not claim its described implementations or tests were executed again.

## One execution owner

Core composes the existing `cloudflare-workflows` and research modules. One native ResearchWorkflow
owns a run. D1/R2 hold the request/result and actual effect state; ResearchSession only projects progress
and connections. Queue messages accelerate persisted work; they are not another canonical job record.
No second executor, mandatory event journal or generation registry is needed.

The earlier source has an 18-stage list and multiple exploratory handler versions. That is a source fact,
not the target design. Ordinary E0/E1 admits one attempt, prepares once, streams one synthesis and saves
answer/citations in the 4–5-step direction. E2/E3 is explicit and shares those primitives.

Native Workflow durability/retries do not make an arbitrary external paid effect exactly-once.
Use the original attempt and provider reconciliation where available. After an uncertain dispatch,
read/recover that attempt or report unknown; do not silently launch a replacement call. Cancellation
prevents new work. Keep compact checkpoints and reference larger stored inputs/results by their existing locator.

## Read history without keeping every executor

For one old handler family:

1. Stop producing new runs in that format; switch admission and current callers together.
2. Inspect its actual running attempts and stored results. Old fixture coverage is not a live consumer.
3. Drain/settle running attempts without replaying paid effects. Keep saved reports/citations through the
   current stored-result reader or one-time conversion; reading a report never runs its producing graph.
4. Delete replaced handler factories, dispatch branches, codecs, compatibility exports, fixtures and diary text.

Do not relabel a live old attempt as a new one. A genuinely needed temporary adapter names the actual
consumer and leaves with its migration. Unknown production data stops only that destructive step;
independent source simplification continues. Unselected prototypes need no perpetual reader/resume promise.
Internal refactoring with unchanged data does not require a new protocol generation.

## Diagnostics and acceptance

Return useful safe failure codes and original failure phase, not raw provider/source content or credentials.
An execution failure does not erase a saved draft. Execution authority expiry is not automatically loss of
owner permission to read historical results. Native completion alone does not mean a verified research answer.

Compile/lint during implementation. After product assembly, check the retained run/result/citation,
cancellation and uncertain-effect paths on the actual build. No new signed lifecycle receipts, qualification
renewal programme or all-historical-version replay suite is required.

The old implementation notes and dated check results remain in
[Git history](https://github.com/UnknownAlienHuman/eliot-research/blob/774e4f89b6266759161a10815840662455832395/docs/implementation/workflow-checkpoints.md).
Native references: [Workflow events](https://developers.cloudflare.com/workflows/build/events-and-parameters/)
and [retries](https://developers.cloudflare.com/workflows/build/sleeping-and-retrying/) (checked 2026-10-17).
