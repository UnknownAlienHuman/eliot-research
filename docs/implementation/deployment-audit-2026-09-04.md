# Deployment readiness audit — 2026-09-04

Baseline: `main@f40b30e94c78c772a68b69545104acb869846639`.

**Not ready for a complete local-to-Cloudflare product trial.** The repository contains substantial
executable authority code, but several essential user paths are deliberately unavailable. Missing
credentials are not the only remaining blocker. No live Cloudflare or Google gate was executed here.

## Confirmed blockers

| Area | Actual state | Required next change |
|---|---|---|
| Worker composition | `composition-root.ts` disables 14 semantic/federation operations. Active slices are HEALTH, ACCESS, CATALOG, INGEST and EVIDENCE. | Wire persisted scopes and navigation, then bounded retrieval; compose federation only with its authority ports. |
| Investigations | `research-workflow.ts` is a pending step; `research-session.ts` returns 503/501. | Governed checkpoint execution, budgets/cancellation, durable session replay and reconnect. Never replace pending with a fabricated success. |
| Wiki and artifacts | Proposal/publication, artifact compilation, trace and change products are not composed. | Immutable revisions/head CAS, resolved citations and purge-dependent invalidation. |
| Owner interface | PWA is a shell rather than a complete investigation/evidence/research loop. | Implement working API-backed screens, typed errors, progress and reconnect, with browser tests. |
| Windows checkout | `check-boundaries.mjs` and `check-budgets.mjs` derive filesystem paths with `URL.pathname`. | Use `fileURLToPath`; regress paths with spaces/non-ASCII characters and Windows CI. |
| Local bootstrap | `cf:dev` is not an end-to-end bootstrap: PWA build and both local D1 migration streams must be prepared separately. Remote provider bindings/authentication also need explicit setup. | A documented, tested startup path with no production auth bypass and no claim of a fully offline provider environment. |
| Rust authority | M1 verification foundation exists; mandatory M2–M7 migration/promotion is unfinished. | Follow the language contract; do not introduce permanent duplicate TS/Rust authority. |
| Google and recovery | Drive OAuth/cursor/tamper qualification, backup/restore, erasure round trips and workload/quality gates are incomplete. | Finish the required launch profile in `production-readiness-plan.md`. |

## Release defects addressed by this packet

Previously `deploy-cloudflare.mjs` accepted any successful HTTP status at smoke endpoints, including a
login page, SPA fallback or an old application generation. It also dry-ran only the account-neutral
config before applying remote migrations, retained unspecified dashboard variables, and could leave an
old successful receipt in place after a failed redeploy.

The deployment path now verifies generated identity and Access settings, dry-runs the actual generated
config before remote migrations, checks config drift between steps, and verifies bounded JSON health
and capability responses against the expected generation. It rejects secret-bearing requests to an
alternative smoke origin, redirects, invalid/oversized responses and stalled streams. Failed attempts
cannot publish a new successful receipt or leave the old one at the current receipt path.

This is deployment tooling, **not implementation of the missing research product**. Worker inventory
readback still does not attest every remote binding or exact uploaded version. Without an Access cookie,
HTTP smoke remains `NOT_EXECUTED`. No implementation contour was promoted to `LIVE_QUALIFIED`.

## Verification and continuation

The existing dependency-free contract, package-boundary, SQL authority, implementation-status and Rust
vector/boundary scripts passed on the baseline. The new deployment verifier and orchestration tests
exercise negative inputs and failure ordering without provider credentials. Full dependency-based tests,
builds and Rust verification are required in the PR CI for the exact submitted head.

Continue in small packets: Windows/local startup correctness; persisted scopes and Corpus Lens;
retrieval/query; federation composition; governed investigation/session execution; Wiki/artifacts and
PWA loops. The normative Rust migration and live release gates remain mandatory rather than being
silently removed to make a deployment look complete.
