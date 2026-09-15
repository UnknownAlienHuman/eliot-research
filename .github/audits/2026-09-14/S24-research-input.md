# S24 — Accept ordinary multiline Research questions

Baseline: `a2aca127`; finding F08. Scope: the input contract, not expansion of the entire corpus/context system. The newline rules below are an explicit implementation clarification, not a claim about existing behavior.

## 1. Problem

`checkQuery` rejects questions exceeding 1024 UTF-8 bytes and rejects all control characters, including newlines. Ordinary multi-paragraph Research instructions therefore fail. The current function returns accepted text unchanged; the correction must not silently introduce normalization into request identity.

## 2. Required change

Allow multiline text and normal question formatting. Replace the independent arbitrary 1024-byte ceiling with the applicable existing HTTP and model-input envelopes. Never silently truncate input.

Preserve the exact accepted query string. Permit LF, CRLF, and horizontal tab; reject NUL, unpaired surrogates, other prohibited control characters, and isolated CR. LF and CRLF remain different request bytes: changing them under an existing idempotency key is a changed-input conflict, not silent normalization. Keep already valid short requests compatible.

## 3. Documentation and exact search anchors

[Architecture, sections 7.2, 7.12, and 1.4](https://github.com/UnknownAlienHuman/eliot-research/blob/a2aca1277b0edbbed04de66e0d44e383e1b815ef/docs/architecture/ELIOT_RESEARCH.md); [actual parser](https://github.com/UnknownAlienHuman/eliot-research/blob/a2aca1277b0edbbed04de66e0d44e383e1b815ef/apps/eliotr-core/src/research-session.ts).

```sh
git grep -n -F '## 7.2. InquiryProtocolProfile' -- docs/architecture/ELIOT_RESEARCH.md
git grep -n -F 'checkQuery' -- apps/eliotr-core/src/research-session.ts
```

## 4. Implementation approach

Align server parsing, PWA input, request identity, and model preparation. Count UTF-8 bytes rather than substituting JavaScript string length. Validate well-formed Unicode before encoding so lone surrogates cannot silently become replacement characters. Preserve whitespace and text content; do not trim or rewrite literal queries. Check the complete serialized request against its HTTP envelope and the prepared prompt against the selected model's existing budget before paid dispatch. Name the actual violated envelope in the error. Do not invent another character-count cap, raise Evidence Grade because a prompt is long, or change S99's separate scope contract.

## 5. Acceptance criteria

- [ ] Multiline English and Russian questions with quotations/lists reach model preparation intact.
- [ ] Same exact input replays; LF-to-CRLF changes under the same key conflict. Tabs and accepted line endings are preserved.
- [ ] Malformed Unicode, NUL, prohibited controls, isolated CR, and real envelope overflow fail before paid effects.
- [ ] PWA/server agree, no silent truncation occurs, and max/max+1 tests exercise the documented applicable envelopes.
- [ ] Existing valid short-query digests/tests remain compatible. Record exact implementation SHA and results.
