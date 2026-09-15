# S54 — Publish accepted artifacts without upgrading unsupported claims

Baseline: `a2aca127`; ER-10/11/12/13/24. Use #245's COW path and existing Wiki publisher. Saved drafts and manual Wiki publication already exist; accepted REPORT semantics require completion.

## 1. Problem

A Publish button, completed model audit, or owner edit does not by itself make material statements SOURCE_SUPPORTED. Publication needs a real currentness/support barrier and correct D0–D3 authorization.

## 2. Required change

Connect current freeze, section verification, claim support, disclosure, and dependency checks to the existing accepted-artifact head commit. Apply existing Wiki/Draft Inbox rules: D0 deterministic; D1 only with explicit project AutoPromotionPolicy, exact handles, no conflict, and an independent verifier; D2 requires verifier plus explicit authorized owner/policy committer; D3 requires named authority. Do not turn D2/D3 into automatic promotion paths.

## 3. Documentation and exact search anchors

[Architecture, sections 9.3, 9.5–9.6, and 19.6](https://github.com/UnknownAlienHuman/eliot-research/blob/a2aca1277b0edbbed04de66e0d44e383e1b815ef/docs/architecture/ELIOT_RESEARCH.md).

```sh
git grep -n -F '## 9.6. Draft Inbox without owner bottleneck' -- docs/architecture/ELIOT_RESEARCH.md
```

## 4. Implementation approach

Reuse artifact/Wiki ports and D1 head/CAS/outbox, with exact immutable R2 readback before head settlement. Accepted factual claims need exact supporting evidence. Inference, hypothesis, contested/unresolved statements, and recommendations retain their own labels instead of being upgraded to facts. An inherited audit cannot validate new owner-edited statements.

Recheck policy, purge, freeze, and expected head within guarded settlement, not only earlier in the UI. Rejected publication preserves the draft and explicit reasons. Eligible D1 auto-promotion uses the same publisher, not bypass SQL or cron. Naming the author as an independent verifier does not establish independence. Add no unrelated financial or policy subsystem.

## 5. Acceptance criteria

- [ ] Accepted citations resolve exactly; cropped qualifications/negation, stitched quotes, absent numbers, stale freeze, revoked grants, and purge races fail the publication fixtures.
- [ ] D0/D1 positive cases pass; missing policy/verifier fails; D2/D3 automatic promotion is denied.
- [ ] Concurrent publishers have one winner; lost response/readback does not produce duplicate heads.
- [ ] A manually published hypothesis remains a hypothesis, not a fabricated supported fact.
- [ ] Test actual API/D1/R2 publication and subsequent readers; record exact SHA/results rather than relying solely on fixture counts.
