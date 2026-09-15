# S07 — Accept historical reports after a source revision update

Baseline: `a2aca127`; finding F03. A correction already exists in `e5b5613`; do not implement a second historical reader. The recorded stop checkpoint still described Worker `git-66a0e20`, without live acceptance of that correction. This is historical evidence, not a fresh observation of the deployment.

## 1. Problem

A source update retained both LIVE revisions, but scope invalidation caused HTTP 410 for old Wiki/Research results. Main now includes a historical-read path that checks source-head advancement. Verify the complete path, not merely the presence of its helper.

## 2. Required change

Add this regression: source v1 → saved report/Wiki → source v2 → reopen the original text and citation, marked as using previous revisions. Genuine revocation or purge must still deny access.

## 3. Documentation and exact search anchors

[Architecture, sections 7 and 9.2](https://github.com/UnknownAlienHuman/eliot-research/blob/a2aca1277b0edbbed04de66e0d44e383e1b815ef/docs/architecture/ELIOT_RESEARCH.md).

[Recorded stop checkpoint](https://github.com/UnknownAlienHuman/eliot-research/blob/a2aca1277b0edbbed04de66e0d44e383e1b815ef/docs/implementation/live-document-project-acceptance-2026-09-14.md).

```sh
git grep -n -F '### Stop checkpoint requested by the owner' -- docs/implementation/live-document-project-acceptance-2026-09-14.md
git grep -n -F '## 9.2. Copy-on-write section tree' -- docs/architecture/ELIOT_RESEARCH.md
```

## 4. Implementation approach

Reuse `owner-historical-scope.ts`, `research-artifact-reauthorization-http.ts`, `wiki-proposal-reauthorization.ts`, and `source-revision-freshness.ts`. Exercise actual API and D1/R2 storage, including nested sections/citations and activity. Correct only demonstrated remaining gaps. Do not reset historical invalidation flags/grants. Reopening a report must not rewrite its text to match the new source head.

## 5. Acceptance criteria

- [ ] The historical body and citation retain v1 hashes; v2 remains separately accessible.
- [ ] UI/API accurately report previous-revision use and do not substitute new citations for old ones.
- [ ] Reading after a source update creates no additional run or model call.
- [ ] REVOKED, purged, foreign, and corrupted revisions are denied.
- [ ] Record local acceptance separately from a subsequent authorized live check. Do not label the fix live-accepted before that check; attach exact SHAs and results.
