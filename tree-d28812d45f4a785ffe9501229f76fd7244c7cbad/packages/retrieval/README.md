# retrieval

Retrieval lanes and query products over managed indexes plus a narrow safety projection.

Lanes: identifier, exact, lexical, semantic, literal, source card, atlas, evidence atom, argument,
wiki, artifact, structure, code, web capture, exhaustive and verify.

Two rules dominate the design:

- a managed relevance engine finds relevant material; it does not prove completeness and is not an
  evidence store;
- every material result resolves to an evidence handle against a pinned revision, and only a complete
  frozen scope permits a scoped absence claim.

Reranking reorders candidates within a supplied window. It never judges coverage and never removes a
section from an exhaustive scan.
