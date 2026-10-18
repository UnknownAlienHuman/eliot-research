# Backend contract reconciliation

**Current decision check: 2026-10-17, source `4e53d5e2`.** The owner decisions in
[#377](https://github.com/UnknownAlienHuman/eliot-research/issues/377), ADR-0018 and
[ADR-0019](../adr/0019-compact-refactoring.md) resolve the scope of the old conflict list.
The [current router](backend-entrypoints.md) owns implementation order. No blanket owner-decision wait
remains for the managed-search versus custom-index choice.

| Former item | Current disposition | Implementation implication |
|---|---|---|
| C1: LEX-first versus managed hybrid | **Decision resolved for the selected service.** #377 selects Cloudflare AI Search or provider search and cancels the bespoke index overlay. | Use the managed/provider path; preserve exact source evidence. Align retained historical assertions through [#379](https://github.com/UnknownAlienHuman/eliot-research/issues/379) after source assembly. Do not restore a mandatory second relevance engine to make old tests pass. |
| C2: READ_AND_EXTRACT model call cardinality | **Deferred deep-research detail.** It is not a dependency of E0/E1's one-call answer. | Reuse deterministic context preparation. If an explicit deep task needs model-assisted extraction, read [the original contract](read-extract-proposal-cutover.md) and provide that task's actual model/budget inputs. |
| C3: selected conversion request | **Concrete input/wiring gap for the affected conversion path.** | Select documented converter output/byte/token/timeout bounds when wiring that path. Existing source ingestion and other independent paths continue. See [conversion note](workflow-conversion-admission-cutover.md). |
| C4: target-wide required-set generation promotion | **Canceled for this service by #377.** | Do not implement S52 manifests/target assignment/generation registry/promotion/rollback from the old [fence note](managed-generation-promotion-fence.md). Preserve existing canonical source/project delivery and exact evidence. Inspect real deployed ledger/callers before retiring old code/data. |
| C5: immutable branch-query budgets | **Deferred to explicit E2/E3 branch work.** | When a branch is selected, pass its actual candidate/scan/evidence/byte limits. Do not invent defaults or block ordinary owner answers. [Original budget note](branch-query-budget-selection.md). |

The old October 9 analysis is preserved in
[Git history](https://github.com/UnknownAlienHuman/eliot-research/blob/4e53d5e2296e7f4ed3ed29cef2f049891c5d20c0/docs/implementation/backend-contract-conflicts.md).
It describes its baseline and is not evidence that the current owner decision is still pending.

Current cross-layer work is concrete: C03 HTTP/R2/checkpoint bounds and C05 report freshness, plus
selected-profile route/capability alignment. The [source audit](../../.github/audits/2026-10-17/README.md)
links the affected writers/readers. The manager resolves one bounded representation or endpoint at a
time with the existing owners; no new permission round or generic contract registry is required.
