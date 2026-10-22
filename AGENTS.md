# Rules for working on Eliot Research

These rules apply to every contributor, human or AI. They exist because the previous codebase drowned in
generated machinery: 44 apps and packages, 226 tables, 713 triggers, nine handler versions and custom "gates" —
for a product that holds 15 sources. Do not repeat that.

## Read before you write

1. Read [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) in full (it is short) and the section of
   [docs/IMPLEMENTATION.md](docs/IMPLEMENTATION.md) for your task. Then open the real files you will change.
2. This file, ARCHITECTURE.md and IMPLEMENTATION.md are the only instructions in the repository. The legacy
   code (git tag `legacy-final`; still in the tree until Phase 0 removes it) is history: do not modify it, read
   a legacy file only when IMPLEMENTATION.md names it (donors §12, data import §11), and never copy legacy patterns.
3. If the docs do not cover what you need, or the docs and the code disagree, **stop and ask the owner**.
   Do not invent a mechanism, and do not "fix" the architecture silently.

## Build the minimum that works

4. Implement exactly the task and the documented behaviour. No speculative options, settings, flags,
   extension points, versions, fallbacks or "future-proof" generality.
5. Use the platform and libraries directly: D1, R2, AI Search, Workflows, Agents SDK, AI SDK, Hono, zod.
   Do not wrap them in adapters, ports, repositories, registries, factories or managers.
6. One way to do each thing. Before writing a helper, search for an existing one. An abstraction is allowed
   only when it removes duplication that already exists in three places.
7. Replace, never accumulate. No `v2` files, compatibility code, dual paths, dead code, commented-out code or
   TODOs without an issue link. When you change a design, update all callers and delete the old code.
8. Fix the root cause. If a workaround is unavoidable, mark it `// WORKAROUND(#issue): why` and open the issue.
   Never catch and ignore an error, never return fake success, never retry in a loop to hide a failure.
9. SQL holds tables, indexes, foreign keys and CHECK constraints. **No triggers, no views, no JSON logic in SQL.**
   Product rules live in TypeScript service functions.
10. Security is exactly ARCHITECTURE.md §8. Do not add checks, hashes, signatures, receipts, tokens or
    re-validation layers. If you think something is missing, ask.
11. Use the vocabulary of ARCHITECTURE.md §3. Do not use these words in identifiers or introduce them as concepts:
    `Authority`, `Receipt`, `Witness`, `Fence`, `Proof`, `Envelope`, `Epoch`, `Generation`, `Admission`,
    `Qualification`, `Ledger`, `Registry`, `Orchestrator`, `Manager`, `Factory`, `Adapter`, `Facade`,
    `Projection`, `Obligation`, `Cohort`, `Packet`. ESLint `id-match` rejects identifiers containing them.
12. Keep files readable: split a file above ~400 lines by responsibility; keep functions short and named for
    what they do. Readability matters more than line counts; never minify or compress code to look small.
13. New runtime dependency: one sentence of justification in the PR. Prefer what is already in IMPLEMENTATION.md §1.

## Prove it works

14. Run the app and walk the acceptance journey of your phase (IMPLEMENTATION.md §10). Type-checks and tests
    alone do not prove a feature works.
15. Tests exercise behaviour through public functions or HTTP. No tests of source text, AST shape, file layout
    or private internals; no test-only code paths in production code.
16. `pnpm check` must pass. Report the commands you actually ran and their result. Never claim a check, review
    or measurement that did not happen.

## Process without bureaucracy

17. One PR = one capability, as small as possible. The PR description has three short parts: what changed
    for the user, how you verified it, what is not done. Nothing else.
18. No status files, progress diaries, audit documents, checklists, claim files, work-packet IDs, gates,
    custom check scripts or approval queues in the repository. Git history and PR descriptions are the record.
19. Update ARCHITECTURE.md or IMPLEMENTATION.md in the same PR when a documented decision really changes —
    edit the relevant section, never add an "override" or "addendum" document. Architecture changes need the
    owner's agreement first.
20. Work on one branch per task. When splitting work between agents, give each agent one outcome and a
    disjoint set of files; one agent integrates shared files (`api.ts`, `mcp.ts`, `0001_init.sql`, `wrangler.jsonc`).
21. After two failed approaches to the same problem, stop. Report what you tried, the cause as far as you know
    and the options, then wait for the owner.
22. Do not deploy, change Cloudflare resources, credentials or production data unless the task says so.
