# Source PR readiness — 2026-10-08

Baseline reviewed: `main` = `3e6c25660c1ae515760e19d5f9e6b8a735795c4c`.

This file classifies actual source PRs. `mergeable=true` means GitHub can currently form a merge; it is not compiler/native/quality qualification.

## Status vocabulary

```text
READY_AFTER_SCOPED_CHECK
  based on current main, bounded change is semantically isolated; required compiler/lint/tests still pending

READY_AFTER_REBASE
  source change is isolated, but branch is behind current main; reconcile/cherry-pick before checks

ABSORB_IN_OWNER_PR
  correct change should be carried into a larger owning implementation to avoid conflicts/duplicate churn

BLOCKED_BY_OWN_FIX
  known defect remains inside the PR's changed boundary

SUPERSEDED
  do not integrate because another PR/path replaces it
```

## Matrix

| PR | Current relationship to main | Files | Status | Integration decision |
|---|---|---:|---|---|
| #320 scoped AI Search prefilter | diverged: +1 / -4; GitHub mergeable; main's four commits do not touch its eight files | 8 | `READY_AFTER_REBASE` | Reconcile onto current main, run scoped TS/ESLint/Vitest/workerd. Land before #242 or absorb unchanged into #242 integrator. Does not solve large scopes/G3 layout. |
| #321 bounded stream cleanup | diverged: +1 / -2; GitHub mergeable; intervening main commits do not touch its two files | 2 | `READY_AFTER_REBASE` | Reconcile and run package checks. Land as the common primitive before consolidating leaf-local reader copies. Alone it does not remove duplicated readers. |
| #322 lane-order predicate | exact current-main base; +1 / -0 | 1 | `READY_AFTER_SCOPED_CHECK` | Small isolated guard fix. Add interleaved-order tests and integrate before planner work in #242. |
| #323 compound fusion identity | exact current-main base; +1 / -0 | 1 | `ABSORB_IN_OWNER_PR` or land first | Semantically correct one-line identity fix. #242 also owns `fusion.ts` for duplicate-vote D19; either merge #323 first or preserve this exact tuple-key change in #242. Do not lose it in a rewrite. |
| #328 Golden unknown adjudication | exact current-main base; +3 / -0 | 2 | `BLOCKED_BY_OWN_FIX` | Add bounded runtime decoder/cardinality for observed unknowns before merge. Expected-case-set completeness remains #285, not this PR. Then run testkit checks. |

## #320 details

Changed files:

```text
packages/platform-cloudflare/src/ai-search-scope-filter.ts
packages/platform-cloudflare/src/index.ts
packages/cloudflare-projection/src/ai-search-managed-read.ts
packages/cloudflare-search-probe/src/functional-probe.ts
related focused tests
```

Intervening main commits modify D1 tooling, delivery plan and unrelated tests, not these files. Rebase risk is low, but implementation identity and AI Search request shape must be retested against #324 and current installed SDK.

Required sequence:

```text
#324 decoder compatibility
→ #320 bounded prefilter
→ #242 one managed hybrid path / larger-scope strategy
```

Do not expand #320 into paid fan-out or hierarchical reindex.

## #321 details

The patch correctly stops waiting for a cancellation promise after the bounded-reader result is already known and cancels unused bodies rejected by Content-Length preflight.

It does not cover the known duplicated readers in:

```text
packages/cloudflare-ai/src/provider-config-rest-response.ts
packages/cloudflare-ai/src/custom-provider-rest-response.ts
packages/cloudflare-workflows/src/... readWorkflowObject path
content-store / locateLines cleanup paths
```

After #321, one owner must migrate leaf readers to the common bounded primitive while preserving domain error/effect classification. Do not build a universal permissive JSON decoder.

## #322 details

All current default plans already pass; the patch fixes future/custom-plan validation. It is compatible with Cloudflare ownership because it governs Eliot's lane ordering policy rather than rebuilding retrieval.

Required tests:

```text
IDENT → SEM → EXACT → false
EXACT → SEM → LEX → false
SEM → IDENT → SEM → false
current seven defaults unchanged
```

## #323 details

The private key `${source_revision_ref}:${canonical_section_id}` is ambiguous because both fields may contain `:`. The serialized tuple fixes identity without new persisted format.

R02/#242 additionally must make repeated occurrences of the same canonical section inside one physical ranked list idempotent. These are two separate defects:

```text
#323: different pairs collide
D19/#242: same pair votes repeatedly inside one list
```

## #328 details

The PR adds useful exact unknown adjudication and retained failures. Before integration, `observed.unknowns` must be treated as runtime input:

- missing/non-array → typed malformed-container failure;
- cardinality above the declared maximum → typed oversized-container failure without unbounded iteration;
- valid entries remain exact strings;
- `evaluateGoldenRun` must not spread malformed input;
- retain the adversarial producer case where `passed=true` cannot override a hard failure.

The following remains deliberately outside #328:

```text
ExpectedCaseManifest
one-to-one expected/result IDs
no empty/duplicate/foreign/missing run
Golden v2 products/receipts/holdout
```

That work stays in #285.

## Integration graph

```text
#321 (common bounded reader)
#322 (planner guard)
#323 (fusion tuple identity)
#324 decoder task + rebased #320
→ #242 implementation, preserving #322/#323

#328 own decoder fix
→ deterministic subset may merge
→ #285 completes expected-set and Golden v2
```

## Verification boundary

No source branch was merged, rebased, force-pushed or deployed during this review. Status is based on current GitHub mergeability, commit ancestry, per-file compare and previous bounded reproductions. Repository-pinned compilers, scoped lint, Vitest/workerd and native Cloudflare checks remain `PENDING` unless each PR explicitly records otherwise.
