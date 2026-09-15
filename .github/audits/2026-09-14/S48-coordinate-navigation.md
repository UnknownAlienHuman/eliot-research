# S48 — Resolve DocumentMap, parent, and neighbor navigation to exact source locations

Baseline: `a2aca127`; ER-06/07/31/39. Normalized maps and the table-cell adapter already exist. Native page/region/code mapping and the full source-span navigation path need completion. Reuse navigation-expand-service and the Evidence resolver.

## 1. Problem

A section preview is navigation, not proof of a native coordinate. Ordinary Markdown cannot establish page/line/region positions without a qualified transformation map.

## 2. Required change

Complete qualified map adapters and source → section → parent/neighbor → exact open/verify. Every supported native anchor maps independently to the recorded source/normalized region. Unsupported precision returns a typed limitation and, where separately verified and authorized, an exact normalized span.

## 3. Documentation and exact search anchors

[Architecture, sections 6.7 and 19.4](https://github.com/UnknownAlienHuman/eliot-research/blob/a2aca1277b0edbbed04de66e0d44e383e1b815ef/docs/architecture/ELIOT_RESEARCH.md).

```sh
git grep -n -F 'resolves the native/normalized anchor through the recorded coordinate map' -- docs/architecture/ELIOT_RESEARCH.md
```

## 4. Implementation approach

Use qualified maps imported through existing bundle contracts. Native processing stays in the external producer, not an embedded PDF/OCR engine. Validate source revision, map identity, offsets, length, digest, UTF-8 versus codepoint units, and table/line/page parent identities before and after R2 reads. Parent expansion cannot cross authorization boundaries; missing neighbors are not invented.

Maps are immutable per source/parser generation. A new source head cannot rebind an old citation. Evidence Rail uses a resolved handle, not DOM positions or preview text. Add missing adapters one anchor type at a time within current packages; retain one common map/reader contract. A corrupt map is not permission to accept unverified bytes through a fallback path.

## 5. Acceptance criteria

- [ ] Russian/emoji/CRLF/nested-table/code/page fixtures reproduce exact bytes and native anchors wherever qualified maps exist.
- [ ] Missing/corrupt/foreign/stale maps never fabricate precision; independently valid authorized normalized access remains available where supported.
- [ ] Unauthorized neighbors, mid-read purge/revocation, and source-head changes cannot substitute evidence.
- [ ] Library→Lens→section→citation works through actual HTTP/D1/R2/browser tests.
- [ ] Record exact SHA/results and separate native-producer qualification evidence.
