# S19 — Preserve the question and operation ID during temporary disconnection

Baseline: `a2aca127`; finding F17. This is not an offline store for private documents.

## 1. Problem

In `main.ts`, offline, health loss, failed refresh, and generation changes trigger broad clearPrivateEvidence behavior. Transport failures, actual revocation, and resetting the user's work are conflated.

## 2. Required change

Distinguish transient disconnection from actual authorization loss. Preserve the user's draft and reference to the running operation in the current tab. On reconnect, reauthorize reads and continue observing the same run instead of starting Research again.

## 3. Documentation and exact search anchors

[Architecture, section 7](https://github.com/UnknownAlienHuman/eliot-research/blob/a2aca1277b0edbbed04de66e0d44e383e1b815ef/docs/architecture/ELIOT_RESEARCH.md); [execution contract, section 5](https://github.com/UnknownAlienHuman/eliot-research/blob/a2aca1277b0edbbed04de66e0d44e383e1b815ef/docs/implementation/launch-prs/execution-contract.md).

```sh
git grep -n -F 'The Investigation survives' -- docs/architecture/ELIOT_RESEARCH.md
git grep -n -F 'clearPrivateEvidence' -- apps/eliotr-pwa/src/main.ts
```

## 4. Implementation approach

Separate presentation intent from authorized response data in existing panel lifecycle handlers. Hide protected source/citation content according to the existing privacy policy when authorization cannot be checked; do not introduce an offline cache. Keep drafts in tab memory without implicit localStorage/IndexedDB persistence. Clear private state on logout/revocation and discard late responses from old requests. Reconnect reads status using the original operation ID; it does not POST a new run.

## 5. Acceptance criteria

- [ ] Network toggling and HTTP 503 preserve the question and link to the current run.
- [ ] Reconnect starts no additional paid run or duplicate upload.
- [ ] Logout/401/revocation and foreign late responses cannot restore private content.
- [ ] No implicit disk persistence of sources or drafts; existing privacy tests remain valid.
- [ ] Add a short browser regression in the existing harness and record exact SHA/results.
