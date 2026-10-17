# Start here

The current task is to finish and simplify the owner product. Begin with
[backend-entrypoints.md](implementation/backend-entrypoints.md), choose one bounded outcome, then read
[AGENTS.md](../AGENTS.md) and the exact source/contracts for that outcome.
The router names the large implementations to consolidate or retire, their current callers and the
source-size objective. A pass-through cleanup alone does not resolve the measured 283,671-line footprint.

## Current decisions, in order

1. Current owner direction and [#377](https://github.com/UnknownAlienHuman/eliot-research/issues/377):
   five working product paths; the former 44-PR queue is archived. S52's custom index/generation/target/
   promotion/rollback layer is canceled. Rust migration does not block the product.
2. [ADR-0019](adr/0019-compact-refactoring.md): compact modules, retirement boundaries and simple agent work.
3. [ADR-0018](adr/0018-owner-single-function-first-profile.md): `OWNER_SINGLE` reads and ordinary answers.
4. [ADR-0016](adr/0016-react-cloudflare-owner-ui.md) /
   [ADR-0017](adr/0017-owner-web-browser-runtime-and-tooling.md): React/Vite and browser cutover.
5. [Product architecture](architecture/ELIOT_RESEARCH.md) and
   [language contract](architecture/LANGUAGE_RUNTIME_CONTRACT.md): the named capability's detailed rules.

Astro is rejected as the target. The existing PWA remains the served compatibility path until the
integrated React/Worker cutover. Do not infer that changing a document or a fixture build switched it.

The [October 17 source reconciliation](../.github/audits/2026-10-17/README.md) distinguishes current defects
from fixed/overstated audit findings. Audits and donor snapshots are evidence, not another work queue.

## One manager, one checkout

Use one manager checkout/worktree from current main. The manager assigns each leaf exact files and one
observable outcome; independent leaves may work in parallel. Shared roots, manifests, route registries,
barrels and migrations are serialized by the manager. Leaves create no branches or worktrees.

An assignment needs the outcome, files, relevant contract, dependency if any, and how the assembled result
will be accepted. This belongs in the task/PR; no JSON claim, claim-only commit, ancestry gate, new registry,
ER-49 prerequisite or per-leaf owner approval is required. Old packet files remain useful source maps.
Optional historical claim tools do not decide whether new implementation may proceed.

A missing prerequisite blocks only its consumer. Continue independent work and fix routine integration
within the authorized scope. Do not restart a completed review because main gained an unrelated commit.

## Code and verification

During implementation:

- TypeScript: compile the affected project/reference graph and lint the changed source files.
- Rust: compile and run minimal Clippy for the affected crate; no broad test campaign now.
- SQL: use the existing depth-100 compiler for changed schema/queries, without creating another analyzer.
- Documentation: check links, consistency and `git diff --check`.

Tests, browser journeys and live acceptance follow assembled functionality. Keep existing CI behavior;
do not claim deferred checks passed. `pnpm check:affected` currently invokes the full repository suite:
it is not the scoped command for this edit loop.

Before publication, refresh the remote head, review the exact diff and preserve concurrent changes.
Publish the coherent result through authenticated Git or GitHub Git Data API. A local patch or unattached
blob is not delivered work. Follow [branch-discipline.md](implementation/branch-discipline.md); do not
delete historical work by age, count or closed-PR status.

## Read only what the task needs

| Work | Relevant source |
|---|---|
| Current tasks, donor choices, concrete blockers | [backend-entrypoints.md](implementation/backend-entrypoints.md) |
| Actual recorded implementation/live evidence | [backend-delivery-plan.md](implementation/backend-delivery-plan.md), [implementation-status.json](implementation/implementation-status.json) |
| Current versus historical gaps | [gap-register.md](implementation/gap-register.md), [contract conflicts](implementation/backend-contract-conflicts.md) |
| UI components and integration | [Material playbook](agent-work/frontend-material-agent-playbook.md), [execution map](agent-work/frontend-owner-execution-map.md) |
| UI final review/cutover | [manager runbook](agent-work/frontend-autonomous-manager-runbook.md), ADR-0016/0017 |
| Product semantics | Named sections of [ELIOT_RESEARCH.md](architecture/ELIOT_RESEARCH.md) |
| Tools/platform operations | [toolchain.md](implementation/toolchain.md), [Cloudflare runbook](implementation/cloudflare-runbook.md) |
| Eventual release acceptance | [production-readiness-plan.md](implementation/production-readiness-plan.md), selected-profile section first |

Old S01–S99, Launch and October 8 donor plans are available through #377 and Git history when a named
function needs them. They are not mandatory reading or prerequisites for every task.

## Acceptance and publication

The source phase can finish with implementation plus scoped compilation/lint while tests remain pending.
Final product acceptance still checks the implemented owner paths, citations/omissions, replay/cancellation,
integrated UI and actual platform behavior. Do not equate Workflow completion with verified research.

UI U1-D and U2-X are internal manager reviews. FINAL-UI is the owner's review of the complete interface;
deployment/cutover/final UI implementation merge stay separate. Preserve the single Vite/Worker artifact,
inbox recovery and service-worker retirement/rollback behavior. Do not request repeated permission for
routine continuation already authorized by the owner.
