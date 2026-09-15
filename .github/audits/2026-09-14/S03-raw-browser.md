# S03 — Restore the real document-import browser scenario

Audited baseline: `a2aca1277b0edbbed04de66e0d44e383e1b815ef`. References: F20, #98. Diagnostics from #194 are useful, but no separate approval is required to start. This assignment is not an implemented fix.

## 1. Problem

CI 34838617436 fails in `runRawFileUploadOwnerScenario`, called from `owner-e2e.mjs:6037`. The helper expects `File saved`, whereas the UI now runs upload → processing → admission with different states. This mismatch is established; it must not be called the only cause of the failure without reproducing the original assertion.

## 2. Required change

Restore one complete scenario: select a file → add the document → see the persisted source → reload → reopen the same data without duplicates. Align D1/R2 snapshots with actual automatic processing, rather than the old captured-only UI phase.

## 3. Documentation and exact search anchors

[Execution contract, sections 3–5](https://github.com/UnknownAlienHuman/eliot-research/blob/a2aca1277b0edbbed04de66e0d44e383e1b815ef/docs/implementation/launch-prs/execution-contract.md).

```sh
git grep -n -F 'D1/R2/runtime, crypto, transactions' -- docs/implementation/launch-prs/execution-contract.md
git grep -n -F 'runRawFileUploadOwnerScenario' -- tests/integration/browser
git grep -n -F 'rawFileReceiptCopy' -- apps/eliotr-pwa/src
```

## 4. Implementation approach

Work in `tests/integration/browser/raw-file-browser.mjs`, its tests, and the directly affected section of `owner-e2e.mjs`. Obtain the original assertion first. Capture the baseline before the action; after completion, read actual capture/admission/revision/outbox state. Assert stable state and identifiers, not an intermediate phrase. Use the existing Worker/browser harness. External conversion may be controlled in the test, but application HTTP and storage must remain real. Fix a separately demonstrated application defect only with a reproducing regression test.

## 5. Acceptance criteria

- [ ] The owner-browser scenario passes on Linux and Windows; demonstrate the original failure before the correction.
- [ ] Import and reload preserve one logical operation and the expected revision count; no foreign source appears.
- [ ] A controlled admission failure is not presented as a successful import.
- [ ] Preserve negative assertions, cleanup, and actual D1/R2 readback; no skipped tests or arbitrary timeout increases.
- [ ] Record implementation SHA, commands, and exit codes. List remaining independent CI failures separately.
