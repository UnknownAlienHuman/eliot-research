# policy

Four independent policy axes, evaluated in a fixed order and never collapsed into one permission flag:

```text
storage policy                where original and normalized bytes may live
inference disclosure policy   which model routes may see which classes of content
client disclosure policy      which client may receive which projection
retention and license policy  how long content is kept and what may be republished
```

Permission to view in the owner app never implies permission to disclose to an external client or an
external model. Enforcement order runs from principal authentication through scope resolution, purge
ledger application, read permission, source policy, client disclosure, inference disclosure,
retrieval, post-retrieval recheck and output minimization.
