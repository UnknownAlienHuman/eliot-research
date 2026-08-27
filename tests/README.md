# tests

| Directory | Contents |
|---|---|
| `golden-corpus/` | Versioned real-document corpus for retrieval and nuance evaluation: exact match, phrase, literal, semantic, multi-project, exhaustive scan, plus modality, conditions, authority, chronology, dissent and negative results. |
| `fixtures/` | Recorded deterministic fixtures for parsers, evidence handles, promotion, federation payloads and failure injection. |

Test ladder:

```text
T0  contract, schema and unit
T1  recorded deterministic fixtures
T2  retrieval golden corpus
T3  semantic nuance golden corpus
T4  vertical integration through the real platform
T5  failure, security and erasure injection
T6  live workload profile
```

Any change to a model, prompt, parser, retrieval policy or embedding generation runs T2 and T3 plus
the relevant T4 and T5 fixtures before promotion. Silent replacement of a generation is prohibited.
