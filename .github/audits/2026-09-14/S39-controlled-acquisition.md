# S39 — Capture and admit discovered URLs before using them as evidence

Baseline: `a2aca127`; ER-05/14/16/29/37. Input: #227; branch integration: #229.

## 1. Problem

DEEP/web_discovery requires controlled acquisition, not citations assembled from search snippets. Raw/normalized admission and provider ports already exist; connect them to ACQUIRE_AND_CAPTURE.

## 2. Required change

Connect candidate → authorized provider capture → immutable R2 bytes/metadata → existing normalized qualification/admission → new manifest revision. Start with an authorized public HTML page and a changed revision of that page. corpus_only does not execute this branch.

## 3. Documentation and exact search anchors

[Architecture, sections 7.9 and 19.3](https://github.com/UnknownAlienHuman/eliot-research/blob/a2aca1277b0edbbed04de66e0d44e383e1b815ef/docs/architecture/ELIOT_RESEARCH.md).

```sh
git grep -n -F 'A newly mentioned URL or identifier is an untrusted' -- docs/architecture/ELIOT_RESEARCH.md
git grep -n -F 'uncaptured web result used as evidence' -- docs/architecture/ELIOT_RESEARCH.md
```

## 4. Implementation approach

Reuse acquisition/admission contracts, R2 capture, immutable import, and outbox. Do not create a crawler/index service. Select provider/route/disclosure from approved protocol and AllowedReferenceManifest, not source instructions. Validate destinations before each fetch and redirect; reject loopback/private/link-local/credential-bearing targets and unverified redirects.

A changed content hash creates a new SourceRevision without modifying the previous one. Retain source URL, timestamps, quality, metadata, and provenance. Authentication pages, empty/truncated payloads, and partial results are not admitted evidence. Expensive preprocessing uses existing checkpoint/attempt/budget mechanisms; UNKNOWN does not permit blind retry. New sources after EvidenceFreeze require explicit reopen, never silent scope expansion. Native page/region claims require qualified coordinate maps.

## 5. Acceptance criteria

- [ ] Snippets and uncaptured URLs never enter synthesis as evidence; actual capture→admission→exact citation succeeds.
- [ ] Redirect/private-target/injection/foreign-namespace/partial-provider cases fail before canonical writes.
- [ ] Duplicate/lost responses do not create duplicate SourceRevisions; changed content retains both versions.
- [ ] corpus_only makes zero acquisition network calls.
- [ ] Record HTTP/controlled-provider/D1/R2 chain tests and exact SHA; native provider qualification is separate.
