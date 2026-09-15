# S47 — Qualify PDF/Office/text ingestion with explicit extraction fidelity

Baseline: `a2aca127`; ER-05/14/29/37. Reuse cloudflare-raw-ingest, cloudflare-markdown, raw-normalized-admission, and SourceAdmissionDecision. #195 fixes a browser regression, not every format/quality path.

## 1. Problem

Successful capture or toMarkdown conversion does not establish a usable admitted source. Large, damaged, and structured documents need a correct result or an explicit limitation, not silently truncated evidence.

## 2. Required change

Complete missing transitions: capture → conversion candidate → quality qualification → normalized bundle → admitted revision → projection outbox. Reuse already normalized bundles without sending them through a model again. Cover declared PDF/DOCX/HTML/TXT/Markdown/CSV/JSON and image inputs at the conversion precision actually available.

## 3. Documentation and exact search anchors

[Architecture, sections 19.1/19.3 and Slice 1](https://github.com/UnknownAlienHuman/eliot-research/blob/a2aca1277b0edbbed04de66e0d44e383e1b815ef/docs/architecture/ELIOT_RESEARCH.md).

```sh
git grep -n -F 'uncaptured web result used as evidence' -- docs/architecture/ELIOT_RESEARCH.md
git grep -n -F 'SourceAdmissionDecision' -- docs/architecture/ELIOT_RESEARCH.md apps/eliotr-core/src
```

## 4. Implementation approach

Retain byte length/hash, format/parser generation, text/structure coverage, and explicit omissions. Empty/login/truncated/corrupt/unsupported parser output is not promoted as a successful complete conversion. A qualified degraded result must retain its permitted precision and limitations rather than claiming unavailable structure.

Existing raw 16 MiB and materialized-conversion 8 MiB bounds are different. Explain the supported path before upload; larger preprocessing uses an approved external normalized-bundle producer, not whole-file Worker buffering or an embedded Python/OCR engine. Preserve immutable originals. Markdown conversion does not create native page coordinates without a map. Commit SourceRevision/admission/outbox through the existing guarded path; reconcile UNKNOWN against the original ID. Normalization retains source taint, ownership, and residency.

## 5. Acceptance criteria

- [ ] Representative valid and explicitly degraded format fixtures exercise the actual Worker/D1/R2 path. Rejected admission leaves no partial canonical source/outbox.
- [ ] Replay/lost ACK/restart yields one intended revision; changed bytes conflict or create an explicit new revision.
- [ ] Long inputs are not silently truncated and normalized bundles incur no repeated model processing.
- [ ] Claimed native precision does not exceed qualified coordinate maps.
- [ ] Record exact SHA/results and distinguish code/fixture acceptance from actual extraction-quality receipts.
