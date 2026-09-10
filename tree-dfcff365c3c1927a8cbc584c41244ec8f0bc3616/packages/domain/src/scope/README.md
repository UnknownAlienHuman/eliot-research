# Deterministic scope resolution

This directory evaluates the canonical `@eliotr/contracts` scope algebra over immutable atom
resolutions. It does not create a second wire schema and does not read D1, R2, indexes or models.

The result is only a draft for `ScopeSnapshot`; the application layer must still bind the current
purge-ledger revision, disclosure closure, client fence, expiry and final digest before retrieval.

Overlapping revisions with different owner generations or policy closures fail closed for every set
operator, including `INTERSECT` and `EXCEPT`.
