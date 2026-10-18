# Frontend verification reference

Root [working rules](../../AGENTS.md), [the delivery map](../agent-work/frontend-owner-execution-map.md)
and [cutover contract](frontend-platform-migration.md) govern selected behavior and timing.
ER-49 claim/ancestry tools and the harness history command are removed; their old sources remain in Git.
This reference is not another scheduler, approval registry or prerequisite to write code.

## Fixtures and controls

Use the existing UI tokens/primitives and native HTML semantics. Avoid duplicate component/style systems,
feature-specific shared abstractions and arbitrary remote registry code. Source lint does not prove browser
CSP behavior. After assembly check the actual rendered controls, focus/keyboard, safe Markdown and requests.

Fixtures cover relevant states: useful, loading/empty/error, denied/stale/degraded, long RU/EN, narrow
layouts, themes and reduced motion. They contain no private data and make no owner/provider/analytics or
font-CDN calls. Storybook does not load the Worker plugin. Scenarios describe product state, not fixed DOM
shape. Remove obsolete feature assertions with removed code rather than preserve the old UI for a green run.

Keep source/evidence/answer distinctions visible. The server issues exact source references; a model quote
or ID is not authority. Reconnect does not dispatch another run. The cutover contract owns pagehide/private
state and same-owner deployment renewal; tests must not confuse deployment change alone with principal loss.

## Existing commands

`packages/ui/package.json` exposes browser, accessibility, visual, CSP, props, design and receipt commands
through `scripts/ui-owner/verify.mjs`, plus the existing Storybook runner. There is no `check:history`.
The frontend product and optional visual CI jobs are retained by the claim-tool removal; no claim mechanics
or Git ancestry result stands in for product checks. No new verification framework is introduced.

For local integrated checks use `CLOUDFLARE_ENV=test`, `remoteBindings:false` and the existing binding
preflight. Local Explorer checks only its explicit local fixture identities and never discovers/mutates
production resources. Preview, staging or provider checks use their separately authorized environment.

Record actual build/source/environment, executed commands, failures and unrun native/staging/live checks.
Keep screenshots and diagnostic output private-data-free; no prompts, credentials, cookies or provider
payloads. Existing visual baselines require review, never automatic acceptance. A screenshot, source-shape
checker or isolated story is not evidence that the whole product works.

## Final review

Compile/lint during implementation; applicable product/browser checks follow assembly. Review visual direction
using existing Material references only when changing it, not at every agent start. An independent no-hint
journey is useful when available; its absence is reported, not turned into an implementation deadlock.
The owner reviews the complete integrated interface, including real source/report/citation and agent task
journeys and prepared cutover/rollback. Do not require approval receipts for each internal edit or report
unrun checks as successful. Production deploy/data changes remain distinct authorized actions.
